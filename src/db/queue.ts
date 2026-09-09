import type { QueueItem, QueueKind } from '../types';
import { isoNow } from '../util/time';

/**
 * 日次処理を複数回の Cron 発火に分割するためのキュー(仕様 5.1)。
 *
 * 実装ポイント:
 *  * 取り出しは「SELECT で候補を見てから、status='pending' 条件付きの UPDATE で奪う」方式。
 *    UPDATE の changes が 1 のときだけ処理権を得たとみなすので、
 *    Durable Objects を使わずに二重実行を防げる(仕様 14.3 / 17.4)。
 *  * running のまま Worker が落ちても、一定時間経過したロックは pending に戻して再実行する(仕様 17.3)。
 */

/** 当日分のタスクをまとめて積む。既にあるものは UNIQUE 制約で無視される */
export async function seedQueue(
  db: D1Database,
  runDate: string,
  kind: QueueKind,
  packageNames: string[]
): Promise<number> {
  if (packageNames.length === 0) return 0;
  const now = isoNow();
  const statements = packageNames.map((pkg) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO collection_queue (run_date, kind, package_name, status, updated_at)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .bind(runDate, kind, pkg, now)
  );
  const results = await db.batch(statements);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

/** 全体分析など、アプリに紐づかないタスクを 1 件積む */
export async function enqueueGlobal(db: D1Database, runDate: string, kind: QueueKind): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO collection_queue (run_date, kind, package_name, status, updated_at)
       VALUES (?, ?, NULL, 'pending', ?)`
    )
    .bind(runDate, kind, isoNow())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 指定日のキューが既に作られているか */
export async function queueExistsForDate(
  db: D1Database,
  runDate: string,
  kind: QueueKind
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS found FROM collection_queue WHERE run_date = ? AND kind = ? LIMIT 1')
    .bind(runDate, kind)
    .first<{ found: number }>();
  return row != null;
}

/** タイムアウトしたロックを解放する */
export async function releaseStaleLocks(db: D1Database, staleMinutes: number): Promise<number> {
  const threshold = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `UPDATE collection_queue SET status = 'pending', updated_at = ?
       WHERE status = 'running' AND (locked_at IS NULL OR locked_at < ?)`
    )
    .bind(isoNow(), threshold)
    .run();
  return result.meta.changes ?? 0;
}

/** 処理対象を limit 件だけ排他的に確保する */
export async function claimItems(
  db: D1Database,
  kind: QueueKind,
  limit: number,
  staleMinutes: number
): Promise<QueueItem[]> {
  await releaseStaleLocks(db, staleMinutes);

  const { results } = await db
    .prepare("SELECT * FROM collection_queue WHERE kind = ? AND status = 'pending' ORDER BY id LIMIT ?")
    .bind(kind, limit)
    .all<QueueItem>();

  const claimed: QueueItem[] = [];
  for (const item of results ?? []) {
    const now = isoNow();
    const result = await db
      .prepare(
        `UPDATE collection_queue SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .bind(now, now, item.id)
      .run();
    // changes が 1 のときだけこの実行がタスクを獲得した
    if ((result.meta.changes ?? 0) === 1) {
      claimed.push({ ...item, status: 'running', attempts: item.attempts + 1, locked_at: now });
    }
  }
  return claimed;
}

/**
 * タスクの完了処理。
 * 失敗時は試行回数が上限未満なら pending に戻し、以降の tick で自動リトライする(仕様 5.4)。
 */
export async function finishItem(
  db: D1Database,
  item: QueueItem,
  ok: boolean,
  error: string | null,
  maxAttempts: number
): Promise<void> {
  const status = ok ? 'done' : item.attempts >= maxAttempts ? 'failed' : 'pending';
  await db
    .prepare(
      'UPDATE collection_queue SET status = ?, updated_at = ?, last_error = ?, locked_at = NULL WHERE id = ?'
    )
    .bind(status, isoNow(), error ? error.slice(0, 500) : null, item.id)
    .run();
}

export async function countQueue(
  db: D1Database,
  kind: QueueKind,
  runDate: string
): Promise<{ pending: number; running: number; done: number; failed: number; total: number }> {
  const { results } = await db
    .prepare(
      'SELECT status, COUNT(*) AS count FROM collection_queue WHERE kind = ? AND run_date = ? GROUP BY status'
    )
    .bind(kind, runDate)
    .all<{ status: string; count: number }>();

  const counts = { pending: 0, running: 0, done: 0, failed: 0, total: 0 };
  for (const row of results ?? []) {
    if (row.status in counts) counts[row.status as keyof typeof counts] = row.count;
    counts.total += row.count;
  }
  return counts;
}

/** 未処理(pending/running)が残っているか。種別全体で見る */
export async function hasUnfinished(db: D1Database, kind: QueueKind): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS found FROM collection_queue WHERE kind = ? AND status IN ('pending','running') LIMIT 1"
    )
    .bind(kind)
    .first<{ found: number }>();
  return row != null;
}

/** 古いキュー行を削除する(実行履歴と同様に無制限に増やさない。仕様 20) */
export async function pruneOldQueue(db: D1Database, keepDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await db
    .prepare("DELETE FROM collection_queue WHERE run_date < ? AND status IN ('done','failed')")
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
