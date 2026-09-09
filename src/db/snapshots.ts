import type { AppSnapshot, DiffEntry, PlayAppDetail } from '../types';
import { contentHash } from '../util/hash';
import { isoNow, jstDate } from '../util/time';

/**
 * 日次スナップショットを保存する。
 * 実装ポイント: (package_name, collected_date) に UNIQUE を張ったうえで INSERT OR REPLACE するため、
 * 同じ日に何度実行しても行が増えず冪等になる(仕様 9.2 / 17.2)。
 */
export async function upsertSnapshot(
  db: D1Database,
  detail: PlayAppDetail,
  runDate: string = jstDate()
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO app_snapshots (
         package_name, collected_date, collected_at,
         title, developer, icon_url, category,
         score, ratings, reviews_count, installs, min_installs,
         version, version_source, play_updated_at, recent_changes,
         price_text, price_micros, currency, is_free, offers_iap, iap_range,
         android_version, content_rating, ad_supported,
         description_hash, screenshots_hash, unavailable
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(
      detail.packageName,
      runDate,
      isoNow(),
      detail.title,
      detail.developer,
      detail.iconUrl,
      detail.category,
      detail.score,
      detail.ratings,
      detail.reviewsCount,
      detail.installs,
      detail.minInstalls,
      detail.version,
      detail.versionSource,
      detail.playUpdatedAt,
      detail.recentChanges,
      detail.priceText,
      detail.priceMicros,
      detail.currency,
      toInt(detail.isFree),
      toInt(detail.offersIap),
      detail.iapRange,
      detail.androidVersion,
      detail.contentRating,
      toInt(detail.adSupported),
      contentHash(detail.description),
      contentHash(detail.screenshotUrls.join('\n'))
    )
    .run();
}

/** 取得できなかった日を記録する。過去のスナップショットは残したまま(仕様 5.4 / 13.3) */
export async function upsertUnavailableSnapshot(
  db: D1Database,
  packageName: string,
  runDate: string = jstDate()
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO app_snapshots (package_name, collected_date, collected_at, unavailable)
       VALUES (?, ?, ?, 1)`
    )
    .bind(packageName, runDate, isoNow())
    .run();
}

export async function getLatestSnapshot(db: D1Database, packageName: string): Promise<AppSnapshot | null> {
  return db
    .prepare(
      `SELECT * FROM app_snapshots
       WHERE package_name = ? AND unavailable = 0
       ORDER BY collected_date DESC LIMIT 1`
    )
    .bind(packageName)
    .first<AppSnapshot>();
}

export async function getSnapshots(
  db: D1Database,
  packageName: string,
  limit: number
): Promise<AppSnapshot[]> {
  const { results } = await db
    .prepare('SELECT * FROM app_snapshots WHERE package_name = ? ORDER BY collected_date DESC LIMIT ?')
    .bind(packageName, limit)
    .all<AppSnapshot>();
  return results ?? [];
}

/** 差分表示用に、有効な(取得成功した)直近 2 件を返す */
export async function getLastTwoSnapshots(
  db: D1Database,
  packageName: string
): Promise<{ current: AppSnapshot | null; previous: AppSnapshot | null }> {
  const { results } = await db
    .prepare(
      `SELECT * FROM app_snapshots
       WHERE package_name = ? AND unavailable = 0
       ORDER BY collected_date DESC LIMIT 2`
    )
    .bind(packageName)
    .all<AppSnapshot>();
  const rows = results ?? [];
  return { current: rows[0] ?? null, previous: rows[1] ?? null };
}

/** What's New の履歴(内容が変わったタイミングだけ) */
export async function getWhatsNewHistory(
  db: D1Database,
  packageName: string,
  limit: number
): Promise<{ collected_date: string; version: string | null; recent_changes: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT collected_date, version, recent_changes FROM app_snapshots
       WHERE package_name = ? AND unavailable = 0 AND recent_changes IS NOT NULL
       ORDER BY collected_date DESC LIMIT ?`
    )
    .bind(packageName, limit * 3)
    .all<{ collected_date: string; version: string | null; recent_changes: string | null }>();

  // 同じ内容が続く日は畳んで「変わった日」だけ残す
  const history: { collected_date: string; version: string | null; recent_changes: string | null }[] = [];
  let lastText: string | null = null;
  for (const row of results ?? []) {
    if (row.recent_changes !== lastText) {
      history.push(row);
      lastText = row.recent_changes;
    }
    if (history.length >= limit) break;
  }
  return history;
}

/**
 * 2 つのスナップショットを比較して変更項目を返す(仕様 6.3)。
 * 説明文・スクリーンショットはハッシュ比較なので「変更あり」とだけ表示する。
 */
export function computeDiff(current: AppSnapshot | null, previous: AppSnapshot | null): DiffEntry[] {
  if (!current || !previous) return [];
  const diffs: DiffEntry[] = [];

  const compare = (label: string, before: unknown, after: unknown, format?: (v: unknown) => string) => {
    if (before == null && after == null) return;
    if (before === after) return;
    const fmt = format ?? ((v: unknown) => (v == null ? '-' : String(v)));
    diffs.push({ label, before: fmt(before), after: fmt(after) });
  };

  compare('バージョン', previous.version, current.version);
  compare('評価', previous.score, current.score, (v) => (typeof v === 'number' ? v.toFixed(2) : '-'));
  compare('レビュー数', previous.ratings, current.ratings, formatNumber);
  compare('レビュー件数(本文あり)', previous.reviews_count, current.reviews_count, formatNumber);
  compare('インストール数', previous.installs, current.installs);
  compare('更新日', previous.play_updated_at, current.play_updated_at, (v) =>
    typeof v === 'string' ? v.slice(0, 10) : '-'
  );
  compare('価格', previous.price_text, current.price_text);
  compare('アプリ内購入', previous.iap_range, current.iap_range);
  compare('Android 要件', previous.android_version, current.android_version);
  compare('コンテンツレーティング', previous.content_rating, current.content_rating);
  compare('カテゴリ', previous.category, current.category);
  compare('アプリ名', previous.title, current.title);

  if (previous.recent_changes !== current.recent_changes) {
    diffs.push({ label: 'What\'s New', before: null, after: null, changedOnly: true });
  }
  if (previous.description_hash !== current.description_hash) {
    diffs.push({ label: '説明文', before: null, after: null, changedOnly: true });
  }
  if (previous.screenshots_hash !== current.screenshots_hash) {
    diffs.push({ label: 'スクリーンショット', before: null, after: null, changedOnly: true });
  }

  return diffs;
}

/** 指定日以降にバージョンが変わったアプリ(ダッシュボードの「最近の変化」用) */
export async function getRecentVersionChanges(
  db: D1Database,
  limit: number
): Promise<{ package_name: string; title: string | null; collected_date: string; version: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT s.package_name, a.title, s.collected_date, s.version
       FROM app_snapshots s
       JOIN monitored_apps a ON a.package_name = s.package_name
       WHERE s.unavailable = 0 AND s.version IS NOT NULL
         AND s.version <> COALESCE((
           SELECT p.version FROM app_snapshots p
           WHERE p.package_name = s.package_name AND p.unavailable = 0
             AND p.collected_date < s.collected_date
           ORDER BY p.collected_date DESC LIMIT 1
         ), s.version)
       ORDER BY s.collected_date DESC LIMIT ?`
    )
    .bind(limit)
    .all<{ package_name: string; title: string | null; collected_date: string; version: string | null }>();
  return results ?? [];
}

export interface PeriodEndpoint {
  package_name: string;
  collected_date: string;
  score: number | null;
  ratings: number | null;
  reviews_count: number | null;
  version: string | null;
  installs: string | null;
  is_latest: number;
}

/**
 * 指定日以降について、アプリごとの「最新」と「期間内で最も古い」スナップショットだけを 1 クエリで取る。
 * 実装ポイント: AI へ渡す期間比較のために全期間の行を読むと D1 の読み取り行数を無駄に使うため、
 * ウィンドウ関数で両端の 2 行だけに絞る(仕様 10.4 / 24)。
 */
export async function getPeriodEndpoints(db: D1Database, sinceDate: string): Promise<PeriodEndpoint[]> {
  const { results } = await db
    .prepare(
      `SELECT package_name, collected_date, score, ratings, reviews_count, version, installs,
              CASE WHEN rn_desc = 1 THEN 1 ELSE 0 END AS is_latest
       FROM (
         SELECT package_name, collected_date, score, ratings, reviews_count, version, installs,
                ROW_NUMBER() OVER (PARTITION BY package_name ORDER BY collected_date DESC) AS rn_desc,
                ROW_NUMBER() OVER (PARTITION BY package_name ORDER BY collected_date ASC) AS rn_asc
         FROM app_snapshots
         WHERE unavailable = 0 AND collected_date >= ?
       )
       WHERE rn_desc = 1 OR rn_asc = 1`
    )
    .bind(sinceDate)
    .all<PeriodEndpoint>();
  return results ?? [];
}

function toInt(value: boolean | null): number | null {
  if (value == null) return null;
  return value ? 1 : 0;
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString('ja-JP') : '-';
}
