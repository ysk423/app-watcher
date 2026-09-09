/**
 * Worker 全体で使う型定義。
 * 環境変数は wrangler.jsonc の vars / secrets に対応する(仕様 25)。
 */

export interface Env {
  DB: D1Database;

  // --- secrets(wrangler secret put で登録) ---
  GEMINI_API_KEY?: string;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASS?: string;

  // --- vars ---
  GEMINI_MODEL?: string;
  MAX_APPS?: string;
  COLLECT_START_JST?: string;
  COLLECT_BATCH_SIZE?: string;
  ANALYZE_BATCH_SIZE?: string;
  REVIEWS_PER_FETCH?: string;
  REVIEW_RETENTION_DAYS?: string;
  LOG_RETENTION_DAYS?: string;
  GEMINI_DAILY_LIMIT?: string;
  D1_STORAGE_LIMIT_BYTES?: string;
}

/** Google Play から取得したアプリ情報(収集直後の生の形) */
export interface PlayAppDetail {
  packageName: string;
  title: string | null;
  developer: string | null;
  developerId: string | null;
  developerEmail: string | null;
  developerWebsite: string | null;
  privacyPolicy: string | null;
  iconUrl: string | null;
  headerImageUrl: string | null;
  screenshotUrls: string[];
  category: string | null;
  summary: string | null;
  description: string | null;
  score: number | null;
  ratings: number | null;
  reviewsCount: number | null;
  installs: string | null;
  minInstalls: number | null;
  version: string | null;
  /** version の出所。'play' = Play が公開 / 'reviews' = レビューから推定 */
  versionSource: 'play' | 'reviews' | null;
  playUpdatedAt: string | null;
  recentChanges: string | null;
  priceText: string | null;
  priceMicros: number | null;
  currency: string | null;
  isFree: boolean | null;
  offersIap: boolean | null;
  iapRange: string | null;
  androidVersion: string | null;
  contentRating: string | null;
  adSupported: boolean | null;
  released: string | null;
}

/** Google Play から取得したレビュー 1 件 */
export interface PlayReview {
  reviewId: string;
  author: string | null;
  score: number | null;
  text: string | null;
  thumbsUp: number | null;
  appVersion: string | null;
  reviewDate: string;
  replyText: string | null;
  replyDate: string | null;
}

export type AppStatus = 'active' | 'paused';

export interface MonitoredApp {
  package_name: string;
  title: string | null;
  developer: string | null;
  developer_id: string | null;
  icon_url: string | null;
  header_image_url: string | null;
  category: string | null;
  summary: string | null;
  description: string | null;
  screenshot_urls: string | null;
  developer_email: string | null;
  developer_website: string | null;
  privacy_policy: string | null;
  released: string | null;
  latest_collected_date: string | null;
  latest_version: string | null;
  latest_score: number | null;
  latest_ratings: number | null;
  latest_reviews_count: number | null;
  latest_installs: string | null;
  latest_play_updated_at: string | null;
  status: AppStatus;
  unavailable: number;
  added_at: string;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  last_analyzed_at: string | null;
}

export interface AppSnapshot {
  id: number;
  package_name: string;
  collected_date: string;
  collected_at: string;
  title: string | null;
  developer: string | null;
  icon_url: string | null;
  category: string | null;
  score: number | null;
  ratings: number | null;
  reviews_count: number | null;
  installs: string | null;
  min_installs: number | null;
  version: string | null;
  version_source: string | null;
  play_updated_at: string | null;
  recent_changes: string | null;
  price_text: string | null;
  price_micros: number | null;
  currency: string | null;
  is_free: number | null;
  offers_iap: number | null;
  iap_range: string | null;
  android_version: string | null;
  content_rating: string | null;
  ad_supported: number | null;
  description_hash: string | null;
  screenshots_hash: string | null;
  unavailable: number;
}

export interface ReviewRow {
  review_id: string;
  package_name: string;
  author: string | null;
  score: number | null;
  text: string | null;
  thumbs_up: number | null;
  app_version: string | null;
  review_date: string;
  reply_text: string | null;
  reply_date: string | null;
  fetched_at: string;
}

export interface AiAnalysis {
  id: number;
  run_date: string;
  scope: 'app' | 'global';
  package_name: string | null;
  analysis_type: string;
  status: 'done' | 'failed' | 'skipped';
  model: string | null;
  content: string | null;
  error: string | null;
  created_at: string;
}

export type QueueKind = 'collect' | 'analyze';
export type QueueStatus = 'pending' | 'running' | 'done' | 'failed';

export interface QueueItem {
  id: number;
  run_date: string;
  kind: QueueKind;
  package_name: string | null;
  status: QueueStatus;
  attempts: number;
  locked_at: string | null;
  updated_at: string;
  last_error: string | null;
}

export interface JobLog {
  id: number;
  started_at: string;
  finished_at: string | null;
  kind: string;
  trigger: string;
  package_name: string | null;
  status: string;
  message: string | null;
  duration_ms: number | null;
}

/** 差分表示 1 項目分(仕様 6.3) */
export interface DiffEntry {
  label: string;
  before: string | null;
  after: string | null;
  /** What's New / 説明文のように「変更あり」とだけ示す項目 */
  changedOnly?: boolean;
}
