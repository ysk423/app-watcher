import { AppNotFoundError, fetchAppDetail } from '../collector/play-detail';
import { fetchReviews } from '../collector/play-reviews';
import { STALE_LOCK_MINUTES, type AppConfig } from '../config';
import { markAppError, updateAppFromDetail } from '../db/apps';
import { logJob } from '../db/jobs';
import { saveReviews } from '../db/reviews';
import { upsertSnapshot, upsertUnavailableSnapshot } from '../db/snapshots';
import { acquireLock, releaseLock, setStatus } from '../db/system';
import type { Env, PlayReview } from '../types';
import { isoNow, jstDate } from '../util/time';

export interface JobResult {
  ok: boolean;
  /** false のときはその日の再試行を行わない(存在しないアプリなど) */
  retryable: boolean;
  message: string;
}

/**
 * アプリ 1 件を収集する(仕様 5)。
 *
 * 実装ポイント:
 *  * 1 アプリ分の処理だけで完結させ、複数アプリの並列取得は行わない(CPU 時間・サブリクエスト上限のため。仕様 24)
 *  * 詳細取得が成功すればレビュー取得が失敗しても全体は成功扱いにする(仕様 23)
 *  * 取得失敗時に既存データを削除しない(仕様 5.4)
 */
export async function collectApp(
  env: Env,
  config: AppConfig,
  packageName: string,
  trigger: 'cron' | 'manual'
): Promise<JobResult> {
  const startedAt = isoNow();
  const runDate = jstDate();

  // 同一アプリの収集が同時に走らないようにする(仕様 14.3)
  const lockKey = `collect:${packageName}`;
  if (!(await acquireLock(env.DB, lockKey, STALE_LOCK_MINUTES))) {
    return { ok: true, retryable: false, message: 'すでに収集中のためスキップしました' };
  }

  try {
    const detail = await fetchAppDetail(packageName);

    // レビュー取得は詳細取得と別経路なので、失敗しても収集自体は成功として扱う
    let reviews: PlayReview[] = [];
    let reviewMessage = '';
    try {
      reviews = await fetchReviews(packageName, config.reviewsPerFetch);
      reviewMessage = `レビュー ${reviews.length} 件を取得`;
    } catch (e) {
      reviewMessage = `レビュー取得のみ失敗: ${(e as Error).message}`;
    }

    // Play がバージョンを公開していない場合はレビューの申告バージョンで補完する
    if (!detail.version) {
      const inferred = inferVersionFromReviews(reviews);
      if (inferred) {
        detail.version = inferred;
        detail.versionSource = 'reviews';
      }
    }

    await updateAppFromDetail(env.DB, detail, runDate);
    await upsertSnapshot(env.DB, detail, runDate);

    if (reviews.length > 0) {
      const saved = await saveReviews(env.DB, packageName, reviews, config.reviewRetentionDays);
      reviewMessage = `レビュー ${saved} 件を追加(取得 ${reviews.length} 件)`;
    }

    const score = detail.score != null ? detail.score.toFixed(2) : '-';
    const message = `バージョン ${detail.version ?? '-'} / 評価 ${score} / ${reviewMessage}`;
    await logJob(env.DB, {
      kind: 'collect',
      trigger,
      packageName,
      status: 'success',
      message,
      startedAt,
    });
    await setStatus(env.DB, 'last_collect_at', isoNow());

    return { ok: true, retryable: true, message };
  } catch (e) {
    const error = e as Error;
    const notFound = error instanceof AppNotFoundError;

    // Google Play から消えていても自動削除はせず、状態だけ記録する(仕様 13.3)
    await markAppError(env.DB, packageName, error.message, notFound);
    if (notFound) await upsertUnavailableSnapshot(env.DB, packageName, runDate);

    await logJob(env.DB, {
      kind: 'collect',
      trigger,
      packageName,
      status: 'error',
      message: error.message,
      startedAt,
    });

    return { ok: false, retryable: !notFound, message: error.message };
  } finally {
    await releaseLock(env.DB, lockKey);
  }
}

/**
 * レビューの申告バージョンから現行バージョンを推定する。
 * 実装ポイント: 1 件だけ見ると古い端末からの投稿を拾ってしまうため、
 * 新着レビューの中で最も新しいバージョン番号を採用する。
 */
export function inferVersionFromReviews(reviews: PlayReview[]): string | null {
  let best: string | null = null;
  for (const review of reviews) {
    const version = review.appVersion;
    if (!version || !/^\d+(\.\d+)*$/.test(version)) continue;
    if (best == null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** ドット区切りの数値バージョンを比較する(a > b なら正の値) */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
