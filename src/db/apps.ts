import { COUNTRIES, PRIMARY_COUNTRY } from '../config';
import type {
  AppCountryRow,
  AppStatus,
  AppWithCountries,
  Country,
  MonitoredApp,
  PlayAppDetail,
} from '../types';
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
/** 監視対象として登録する。既に存在する場合は false を返す */
export async function insertApp(db: D1Database, packageName: string): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO monitored_apps (package_name, status, added_at) VALUES (?, ?, ?)')
    .bind(packageName, 'active', isoNow())
    .run();
  if ((result.meta.changes ?? 0) === 0) return false;

  // 対象国の行を先に作っておく(まだ未取得なので値は NULL)
  await db.batch(
    COUNTRIES.map((c) =>
      db
        .prepare('INSERT OR IGNORE INTO app_countries (package_name, country) VALUES (?, ?)')
        .bind(packageName, c.country)
    )
  );
  return true;
}

/**
 * 収集した最新情報でアプリ行を更新する。
 * 実装ポイント: 説明文・スクリーンショット URL のような重い項目は日次スナップショットに積まず、
 * ここで「最新値のみ」を上書きしていくことで D1 のストレージ増加を抑える(仕様 8 / 18)。
 */
/**
 * 収集した最新情報でアプリ行を更新する。
 *
 * 実装ポイント:
 *  * 説明文・スクリーンショット URL のような重い項目は日次スナップショットに積まず、
 *    ここで「最新値のみ」を上書きして D1 のストレージ増加を抑える(仕様 8 / 18)
 *  * 国によって変わる値(評価・バージョン等)は app_countries 側に入れる。
 *    monitored_apps に載せるのは代表国(PRIMARY_COUNTRY)の言語で取得した共通情報だけ
 */
export async function updateAppFromDetail(
  db: D1Database,
  detail: PlayAppDetail,
  country: Country,
  collectedDate: string
): Promise<void> {
  const now = isoNow();
  const statements: D1PreparedStatement[] = [];

  // 代表国のときだけアプリ共通の項目を更新する(他国の言語で上書きしないため)
  if (country === PRIMARY_COUNTRY) {
    statements.push(
      db
        .prepare(
          `UPDATE monitored_apps SET
             title = ?, developer = ?, developer_id = ?, icon_url = ?, header_image_url = ?,
             category = ?, summary = ?, description = ?, screenshot_urls = ?,
             developer_email = ?, developer_website = ?, privacy_policy = ?, released = ?,
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
          now,
          detail.packageName
        )
    );
  } else {
    // 代表国以外でも「どこかの国で取得できた」ことは記録する
    statements.push(
      db
        .prepare(
          `UPDATE monitored_apps SET unavailable = 0, last_success_at = ?,
             last_error = NULL, last_error_at = NULL
           WHERE package_name = ?`
        )
        .bind(now, detail.packageName)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO app_countries (
           package_name, country, latest_collected_date, latest_version, latest_score,
           latest_ratings, latest_reviews_count, latest_installs, latest_play_updated_at,
           unavailable, last_success_at, last_error, last_error_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL)
         ON CONFLICT(package_name, country) DO UPDATE SET
           latest_collected_date = excluded.latest_collected_date,
           latest_version = excluded.latest_version,
           latest_score = excluded.latest_score,
           latest_ratings = excluded.latest_ratings,
           latest_reviews_count = excluded.latest_reviews_count,
           latest_installs = excluded.latest_installs,
           latest_play_updated_at = excluded.latest_play_updated_at,
           unavailable = 0,
           last_success_at = excluded.last_success_at,
           last_error = NULL,
           last_error_at = NULL`
      )
      .bind(
        detail.packageName,
        country,
        collectedDate,
        detail.version,
        detail.score,
        detail.ratings,
        detail.reviewsCount,
        detail.installs,
        detail.playUpdatedAt,
        now
      )
  );

  await db.batch(statements);
}

/** 取得失敗を記録する。過去データは絶対に消さない(仕様 5.4) */
/**
 * 取得失敗を記録する。過去データは絶対に消さない(仕様 5.4)。
 *
 * 実装ポイント: 国別に失敗を記録したうえで、monitored_apps 側の unavailable は
 * 「全対象国で取得できない」ときにだけ立てる。片方の国だけ取れない状態を
 * アプリ全体の不可用として扱わないため(仕様 13.3)。
 */
export async function markAppError(
  db: D1Database,
  packageName: string,
  country: Country,
  message: string,
  unavailable: boolean
): Promise<void> {
  const now = isoNow();
  const trimmed = message.slice(0, 500);

  await db.batch([
    db
      .prepare(
        `INSERT INTO app_countries (package_name, country, unavailable, last_error, last_error_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(package_name, country) DO UPDATE SET
           unavailable = excluded.unavailable,
           last_error = excluded.last_error,
           last_error_at = excluded.last_error_at`
      )
      .bind(packageName, country, unavailable ? 1 : 0, trimmed, now),
    db
      .prepare('UPDATE monitored_apps SET last_error = ?, last_error_at = ? WHERE package_name = ?')
      .bind(trimmed, now, packageName),
  ]);

  // 全対象国が unavailable のときだけアプリ全体を「取得できません」にする
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(unavailable) AS bad FROM app_countries WHERE package_name = ?`
    )
    .bind(packageName)
    .first<{ total: number; bad: number | null }>();

  const allUnavailable =
    row != null && row.total > 0 && (row.bad ?? 0) >= row.total && row.total >= COUNTRIES.length;

  await db
    .prepare('UPDATE monitored_apps SET unavailable = ? WHERE package_name = ?')
    .bind(allUnavailable ? 1 : 0, packageName)
    .run();
}

/** アプリ 1 件の国別最新値を取得する */
export async function getAppCountries(
  db: D1Database,
  packageName: string
): Promise<Map<Country, AppCountryRow>> {
  const { results } = await db
    .prepare('SELECT * FROM app_countries WHERE package_name = ?')
    .bind(packageName)
    .all<AppCountryRow>();
  return new Map((results ?? []).map((r) => [r.country, r]));
}

/**
 * 一覧画面用に、アプリと国別最新値をまとめて取得する。
 * 実装ポイント: アプリごとに問い合わせると N+1 になるため 2 クエリで済ませる(仕様 24)。
 */
export async function listAppsWithCountries(
  db: D1Database,
  status?: AppStatus
): Promise<AppWithCountries[]> {
  const apps = await listApps(db, status);
  if (apps.length === 0) return [];

  const { results } = await db.prepare('SELECT * FROM app_countries').all<AppCountryRow>();
  const byPackage = new Map<string, Map<Country, AppCountryRow>>();
  for (const row of results ?? []) {
    let m = byPackage.get(row.package_name);
    if (!m) {
      m = new Map();
      byPackage.set(row.package_name, m);
    }
    m.set(row.country, row);
  }

  return apps.map((app) => ({
    app,
    countries: byPackage.get(app.package_name) ?? new Map(),
  }));
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
    db.prepare('DELETE FROM app_countries WHERE package_name = ?').bind(packageName),
    db.prepare('DELETE FROM monitored_apps WHERE package_name = ?').bind(packageName),
  ]);
}
