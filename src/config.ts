import { getSetting } from './db/system';
import type { Env } from './types';
import { parseHhMm } from './util/time';

/**
 * 設定値の解決。
 * 実装ポイント: 優先順位は「D1 の settings テーブル > wrangler の vars > コード内の既定値」。
 * Web UI から変えたい項目(Gemini モデル等)は settings に入れ、
 * 秘密情報は必ず secrets 側に置く(仕様 25 / 10.1)。
 */

export interface AppConfig {
  geminiModel: string;
  maxApps: number;
  collectStartMinutes: number;
  collectBatchSize: number;
  analyzeBatchSize: number;
  reviewsPerFetch: number;
  reviewRetentionDays: number;
  logRetentionDays: number;
  geminiDailyLimit: number;
  d1StorageLimitBytes: number;
}

/** キューの再試行上限。これを超えたタスクはその日は failed のままにする */
export const MAX_QUEUE_ATTEMPTS = 3;

/** running のまま放置されたタスクを回収するまでの時間(分)。仕様 17.3 */
export const STALE_LOCK_MINUTES = 10;

/** AI 分析結果をアプリごとに何件残すか */
export const KEEP_ANALYSES_PER_APP = 30;

const DEFAULTS = {
  geminiModel: 'gemini-3.5-flash-lite',
  maxApps: 100,
  collectStartMinutes: 3 * 60,
  collectBatchSize: 2,
  analyzeBatchSize: 2,
  reviewsPerFetch: 50,
  reviewRetentionDays: 90,
  logRetentionDays: 30,
  geminiDailyLimit: 180,
  d1StorageLimitBytes: 5 * 1024 * 1024 * 1024,
};

/** Web UI から変更可能な設定キー */
export const SETTING_KEYS = {
  geminiModel: 'gemini_model',
  collectStartJst: 'collect_start_jst',
  collectBatchSize: 'collect_batch_size',
  analyzeBatchSize: 'analyze_batch_size',
  reviewRetentionDays: 'review_retention_days',
  logRetentionDays: 'log_retention_days',
  geminiDailyLimit: 'gemini_daily_limit',
} as const;

export async function loadConfig(env: Env): Promise<AppConfig> {
  const [
    geminiModel,
    collectStartJst,
    collectBatchSize,
    analyzeBatchSize,
    reviewRetentionDays,
    logRetentionDays,
    geminiDailyLimit,
  ] = await Promise.all([
    getSetting(env.DB, SETTING_KEYS.geminiModel),
    getSetting(env.DB, SETTING_KEYS.collectStartJst),
    getSetting(env.DB, SETTING_KEYS.collectBatchSize),
    getSetting(env.DB, SETTING_KEYS.analyzeBatchSize),
    getSetting(env.DB, SETTING_KEYS.reviewRetentionDays),
    getSetting(env.DB, SETTING_KEYS.logRetentionDays),
    getSetting(env.DB, SETTING_KEYS.geminiDailyLimit),
  ]);

  return {
    geminiModel: geminiModel ?? env.GEMINI_MODEL ?? DEFAULTS.geminiModel,
    maxApps: toPositiveInt(env.MAX_APPS, DEFAULTS.maxApps),
    collectStartMinutes: parseHhMm(
      collectStartJst ?? env.COLLECT_START_JST,
      DEFAULTS.collectStartMinutes
    ),
    collectBatchSize: toPositiveInt(collectBatchSize ?? env.COLLECT_BATCH_SIZE, DEFAULTS.collectBatchSize),
    analyzeBatchSize: toPositiveInt(analyzeBatchSize ?? env.ANALYZE_BATCH_SIZE, DEFAULTS.analyzeBatchSize),
    reviewsPerFetch: toPositiveInt(env.REVIEWS_PER_FETCH, DEFAULTS.reviewsPerFetch),
    reviewRetentionDays: toPositiveInt(
      reviewRetentionDays ?? env.REVIEW_RETENTION_DAYS,
      DEFAULTS.reviewRetentionDays
    ),
    logRetentionDays: toPositiveInt(logRetentionDays ?? env.LOG_RETENTION_DAYS, DEFAULTS.logRetentionDays),
    // 0 は「AI 分析を停止」を意味する有効値なので toNonNegativeInt を使う
    geminiDailyLimit: toNonNegativeInt(
      geminiDailyLimit ?? env.GEMINI_DAILY_LIMIT,
      DEFAULTS.geminiDailyLimit
    ),
    d1StorageLimitBytes: toPositiveInt(env.D1_STORAGE_LIMIT_BYTES, DEFAULTS.d1StorageLimitBytes),
  };
}

function toPositiveInt(value: string | undefined | null, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// 0 を「AI 分析を止める」という有効な設定として受け付けるための版。
// toPositiveInt だと 0 が既定値へフォールバックしてしまい、上限チェックが素通りする
function toNonNegativeInt(value: string | undefined | null, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
