import type { JobLog } from '../types';
import { isoDaysAgo, isoNow } from '../util/time';

/**
 * 実行履歴。Workers はファイルシステムを持たないため、これが実質の運用ログになる(仕様 20)。
 * 行数が無制限に増えないよう pruneOldJobs で定期的に間引く。
 */
export interface LogJobInput {
  kind: 'collect' | 'analyze' | 'maintenance' | 'qa';
  trigger: 'cron' | 'manual';
  packageName?: string | null;
  status: 'success' | 'error' | 'skipped';
  message?: string | null;
  startedAt: string;
}

export async function logJob(db: D1Database, input: LogJobInput): Promise<void> {
  const finishedAt = isoNow();
  const duration = new Date(finishedAt).getTime() - new Date(input.startedAt).getTime();
  await db
    .prepare(
      `INSERT INTO collection_jobs (started_at, finished_at, kind, trigger, package_name, status, message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.startedAt,
      finishedAt,
      input.kind,
      input.trigger,
      input.packageName ?? null,
      input.status,
      input.message ? input.message.slice(0, 500) : null,
      Number.isFinite(duration) ? duration : null
    )
    .run();
}

export async function listJobs(db: D1Database, limit: number): Promise<JobLog[]> {
  const { results } = await db
    .prepare('SELECT * FROM collection_jobs ORDER BY started_at DESC LIMIT ?')
    .bind(limit)
    .all<JobLog>();
  return results ?? [];
}

export async function listJobsForApp(
  db: D1Database,
  packageName: string,
  limit: number
): Promise<JobLog[]> {
  const { results } = await db
    .prepare('SELECT * FROM collection_jobs WHERE package_name = ? ORDER BY started_at DESC LIMIT ?')
    .bind(packageName, limit)
    .all<JobLog>();
  return results ?? [];
}

export async function listErrorJobsForApp(
  db: D1Database,
  packageName: string,
  limit: number
): Promise<JobLog[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM collection_jobs WHERE package_name = ? AND status = 'error' ORDER BY started_at DESC LIMIT ?"
    )
    .bind(packageName, limit)
    .all<JobLog>();
  return results ?? [];
}

export async function getLastSuccessAt(db: D1Database, kind: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT finished_at FROM collection_jobs WHERE kind = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1"
    )
    .bind(kind)
    .first<{ finished_at: string | null }>();
  return row?.finished_at ?? null;
}

export async function countErrorsSince(
  db: D1Database,
  kind: string,
  sinceIso: string
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM collection_jobs WHERE kind = ? AND status = 'error' AND started_at >= ?"
    )
    .bind(kind, sinceIso)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function pruneOldJobs(db: D1Database, retentionDays: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM collection_jobs WHERE started_at < ?')
    .bind(isoDaysAgo(retentionDays))
    .run();
  return result.meta.changes ?? 0;
}
