import { KEEP_ANALYSES_PER_APP, type AppConfig } from '../config';
import { pruneOldAnalyses } from '../db/analyses';
import { logJob, pruneOldJobs } from '../db/jobs';
import { pruneOldQueue } from '../db/queue';
import { pruneOldReviews } from '../db/reviews';
import { pruneOldCounters, setStatus } from '../db/system';
import type { Env } from '../types';
import { isoNow } from '../util/time';

/**
 * 保持期間を超えたデータの削除(仕様 7.2 / 20)。
 * 実装ポイント: D1 の行数・ストレージを無制限に増やさないため 1 日 1 回だけ実行する。
 * スナップショットは履歴そのものなので削除対象にしない(仕様 28 の「過去データを不用意に削除しない」)。
 */
export async function runMaintenance(env: Env, config: AppConfig): Promise<string> {
  const startedAt = isoNow();

  const reviews = await pruneOldReviews(env.DB, config.reviewRetentionDays);
  const jobs = await pruneOldJobs(env.DB, config.logRetentionDays);
  const queue = await pruneOldQueue(env.DB, config.logRetentionDays);
  const analyses = await pruneOldAnalyses(env.DB, KEEP_ANALYSES_PER_APP);
  const counters = await pruneOldCounters(env.DB, 90);

  const message =
    `レビュー ${reviews} 件 / 実行履歴 ${jobs} 件 / キュー ${queue} 件 / ` +
    `AI 分析 ${analyses} 件 / カウンタ ${counters} 件を削除しました`;

  await logJob(env.DB, { kind: 'maintenance', trigger: 'cron', status: 'success', message, startedAt });
  await setStatus(env.DB, 'last_maintenance_at', isoNow());

  return message;
}
