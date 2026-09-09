import { isoNow, jstDate } from '../util/time';

/** 実行状態(最終収集時刻など)の保存。仕様 16 のダッシュボード表示に使う */
export async function getStatus(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM system_status WHERE key = ?')
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setStatus(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_status (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, isoNow())
    .run();
}

/** Web UI から変更できる設定(仕様 27.5)。未設定なら環境変数側の既定値を使う */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, isoNow())
    .run();
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

/**
 * D1 のストレージ使用量(概算)を取得する(仕様 18)。
 * 実装ポイント: D1 はクエリ結果の meta.size_after にデータベースの現在サイズ(バイト)を返すので、
 * 追加の API を叩かずに軽量なクエリ 1 回で使用量を知ることができる。
 */
export async function getDatabaseSizeBytes(db: D1Database): Promise<number | null> {
  try {
    const result = await db.prepare('SELECT 1').all();
    const size = (result.meta as { size_after?: number } | undefined)?.size_after;
    return typeof size === 'number' ? size : null;
  } catch {
    return null;
  }
}

/**
 * 排他ロック(仕様 14.3 / 17.4)。
 *
 * 実装ポイント: Durable Objects(有料)を使わず、system_status の主キー一意制約と
 * INSERT OR IGNORE だけで「同一アプリの収集が二重に走らない」ことを保証する。
 * Worker が異常終了してロックが残った場合に備え、ttl を過ぎたロックは奪い取れるようにする(仕様 17.3)。
 */
export async function acquireLock(db: D1Database, key: string, ttlMinutes: number): Promise<boolean> {
  const now = isoNow();
  const lockKey = `lock:${key}`;

  const inserted = await db
    .prepare("INSERT OR IGNORE INTO system_status (key, value, updated_at) VALUES (?, 'locked', ?)")
    .bind(lockKey, now)
    .run();
  if ((inserted.meta.changes ?? 0) === 1) return true;

  // 既存ロックが古ければ奪い取る
  const threshold = new Date(Date.now() - ttlMinutes * 60 * 1000).toISOString();
  const takeover = await db
    .prepare("UPDATE system_status SET updated_at = ? WHERE key = ? AND updated_at < ?")
    .bind(now, lockKey, threshold)
    .run();
  return (takeover.meta.changes ?? 0) === 1;
}

export async function releaseLock(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM system_status WHERE key = ?').bind(`lock:${key}`).run();
}

/**
 * Gemini の 1 日あたり呼び出し回数を数える(仕様 10.2 の課金・レート制限対策)。
 * 上限に達したら呼び出し自体を行わずスキップする。
 */
export async function incrementGeminiCallCount(db: D1Database, date: string = jstDate()): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO system_status (key, value, updated_at) VALUES (?, '1', ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at
       RETURNING value`
    )
    .bind(geminiCounterKey(date), isoNow())
    .first<{ value: string }>();
  return Number(row?.value ?? '0');
}

export async function getGeminiCallCount(db: D1Database, date: string = jstDate()): Promise<number> {
  const value = await getStatus(db, geminiCounterKey(date));
  return Number(value ?? '0');
}

function geminiCounterKey(date: string): string {
  return `gemini_calls:${date}`;
}

/** 古い日別カウンタを掃除する */
export async function pruneOldCounters(db: D1Database, keepDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await db
    .prepare("DELETE FROM system_status WHERE key LIKE 'gemini_calls:%' AND substr(key, 14) < ?")
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
