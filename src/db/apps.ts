import type { AppStatus, MonitoredApp, PlayAppDetail } from '../types';
import { isoNow } from '../util/time';

export async function listApps(db: D1Database, status?: AppStatus): Promise<MonitoredApp[]> {
  const stmt = status
    ? db.prepare('SELECT * FROM monitored_apps WHERE status = ? ORDER BY title IS NULL, title, package_name').bind(status)
    : db.prepare('SELECT * FROM monitored_apps ORDER BY status, title IS NULL, title, package_name');
  const { results } = await stmt.all<MonitoredApp>();
  return results ?? [];
}

export async function getApp(db: D1Database, packageName: string): Promise<MonitoredApp | null> {
  return db
    .prepare('SELECT * FROM monitored_apps WHERE package_name = ?')
    .bind(packageName)
    .first<MonitoredApp>();
}

export async function countByStatus(db: D1Database): Promise<{ active: number; paused: number }> {
  const { results } = await db
    .prepare('SELECT status, COUNT(*) AS count FROM monitored_apps GROUP BY status')
    .all<{ status: AppStatus; count: number }>();
  const counts = { active: 0, paused: 0 };
  for (const row of results ?? []) {
    if (row.status === 'active') counts.active = row.count;
    if (row.status === 'paused') counts.paused = row.count;
  }
  return counts;
}

/** 監視対象として登録する。既に存在する場合は false を返す */
export async function insertApp(db: D1Database, packageName: string): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO monitored_apps (package_name, status, added_at) VALUES (?, ?, ?)')
    .bind(packageName, 'active', isoNow())
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 収集した最新情報でアプリ行を更新する。
 * 実装ポイント: 説明文・スクリーンショット URL のような重い項目は日次スナップショットに積まず、
 * ここで「最新値のみ」を上書きしていくことで D1 のストレージ増加を抑える(仕様 8 / 18)。
 */
export async function updateAppFromDetail(
  db: D1Database,
  detail: PlayAppDetail,
  collectedDate: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE monitored_apps SET
         title = ?, developer = ?, developer_id = ?, icon_url = ?, header_image_url = ?,
         category = ?, summary = ?, description = ?, screenshot_urls = ?,
         developer_email = ?, developer_website = ?, privacy_policy = ?, released = ?,
         latest_collected_date = ?, latest_version = ?, latest_score = ?, latest_ratings = ?,
         latest_reviews_count = ?, latest_installs = ?, latest_play_updated_at = ?,
         unavailable = 0, last_success_at = ?, last_error = NULL, last_error_at = NULL
       WHERE package_name = ?`
    )
    .bind(
      detail.title,
      detail.developer,
      detail.developerId,
      detail.iconUrl,
      detail.headerImageUrl,
      detail.category,
      detail.summary,
      detail.description,
      detail.screenshotUrls.length > 0 ? JSON.stringify(detail.screenshotUrls) : null,
      detail.developerEmail,
      detail.developerWebsite,
      detail.privacyPolicy,
      detail.released,
      collectedDate,
      detail.version,
      detail.score,
      detail.ratings,
      detail.reviewsCount,
      detail.installs,
      detail.playUpdatedAt,
      isoNow(),
      detail.packageName
    )
    .run();
}

/** 取得失敗を記録する。過去データは絶対に消さない(仕様 5.4) */
export async function markAppError(
  db: D1Database,
  packageName: string,
  message: string,
  unavailable: boolean
): Promise<void> {
  await db
    .prepare(
      'UPDATE monitored_apps SET last_error = ?, last_error_at = ?, unavailable = ? WHERE package_name = ?'
    )
    .bind(message.slice(0, 500), isoNow(), unavailable ? 1 : 0, packageName)
    .run();
}

export async function setAppStatus(db: D1Database, packageName: string, status: AppStatus): Promise<void> {
  await db
    .prepare('UPDATE monitored_apps SET status = ? WHERE package_name = ?')
    .bind(status, packageName)
    .run();
}

export async function setLastAnalyzed(db: D1Database, packageName: string): Promise<void> {
  await db
    .prepare('UPDATE monitored_apps SET last_analyzed_at = ? WHERE package_name = ?')
    .bind(isoNow(), packageName)
    .run();
}

/**
 * 永久削除(仕様 13.2)。関連テーブルもまとめて消す。
 * 実装ポイント: D1 の batch は 1 トランザクションとして扱われるため、途中で失敗しても中途半端に残らない(仕様 9.2)。
 */
export async function deleteAppCompletely(db: D1Database, packageName: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM app_snapshots WHERE package_name = ?').bind(packageName),
    db.prepare('DELETE FROM reviews WHERE package_name = ?').bind(packageName),
    db.prepare('DELETE FROM ai_analyses WHERE package_name = ?').bind(packageName),
    db.prepare('DELETE FROM collection_queue WHERE package_name = ?').bind(packageName),
    db.prepare('DELETE FROM collection_jobs WHERE package_name = ?').bind(packageName),
    db.prepare('DELETE FROM monitored_apps WHERE package_name = ?').bind(packageName),
  ]);
}
