import type { PlayReview, ReviewRow } from '../types';
import { isoDaysAgo, isoNow } from '../util/time';

/**
 * レビューを保存する。
 * 実装ポイント: review_id を主キーにして INSERT OR IGNORE するので、
 * 同じレビューを何度取得しても重複行が増えない(仕様 7.3)。
 */
export async function saveReviews(
  db: D1Database,
  packageName: string,
  reviews: PlayReview[],
  retentionDays: number
): Promise<number> {
  if (reviews.length === 0) return 0;

  const cutoff = isoDaysAgo(retentionDays);
  const fetchedAt = isoNow();
  // 保持期間より古いレビューは最初から入れない(入れてもすぐ削除対象になるため)
  const target = reviews.filter((r) => r.reviewDate >= cutoff);
  if (target.length === 0) return 0;

  const statements = target.map((r) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO reviews
           (review_id, package_name, author, score, text, thumbs_up, app_version, review_date, reply_text, reply_date, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        r.reviewId,
        packageName,
        r.author,
        r.score,
        r.text,
        r.thumbsUp,
        r.appVersion,
        r.reviewDate,
        r.replyText,
        r.replyDate,
        fetchedAt
      )
  );

  const results = await db.batch(statements);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

export async function listReviews(
  db: D1Database,
  packageName: string,
  limit: number
): Promise<ReviewRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM reviews WHERE package_name = ? ORDER BY review_date DESC LIMIT ?')
    .bind(packageName, limit)
    .all<ReviewRow>();
  return results ?? [];
}

/** AI へ渡す用の軽量なレビュー抽出(件数と本文長を絞る。仕様 10.4) */
export async function listRecentReviewsForAi(
  db: D1Database,
  packageName: string,
  sinceIso: string,
  limit: number
): Promise<{ score: number | null; text: string | null; review_date: string; app_version: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT score, substr(COALESCE(text, ''), 1, 300) AS text, review_date, app_version
       FROM reviews
       WHERE package_name = ? AND review_date >= ? AND text IS NOT NULL AND text <> ''
       ORDER BY review_date DESC LIMIT ?`
    )
    .bind(packageName, sinceIso, limit)
    .all<{ score: number | null; text: string | null; review_date: string; app_version: string | null }>();
  return results ?? [];
}

export async function reviewSummary(
  db: D1Database,
  packageName: string,
  sinceIso: string
): Promise<{ count: number; avgScore: number | null }> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS count, AVG(score) AS avg_score FROM reviews WHERE package_name = ? AND review_date >= ?'
    )
    .bind(packageName, sinceIso)
    .first<{ count: number; avg_score: number | null }>();
  return { count: row?.count ?? 0, avgScore: row?.avg_score ?? null };
}

export async function countReviews(db: D1Database, packageName: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM reviews WHERE package_name = ?')
    .bind(packageName)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** 保持期間を超えたレビューを削除する(仕様 7.2)。集計値・AI 分析結果は消さない */
export async function pruneOldReviews(db: D1Database, retentionDays: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM reviews WHERE review_date < ?')
    .bind(isoDaysAgo(retentionDays))
    .run();
  return result.meta.changes ?? 0;
}
