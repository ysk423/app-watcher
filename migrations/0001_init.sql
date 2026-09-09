-- Google Play App Watcher 初期スキーマ
-- 実装ポイント:
--  * 日次スナップショットは「差分表示に必要なスカラー値」だけを持たせて行サイズを抑える(仕様 6.2 / 18)
--  * 説明文・スクリーンショット等の重い項目は monitored_apps に最新値のみ保持し、
--    スナップショット側にはハッシュだけを入れて「変化したかどうか」を判定できるようにする
--  * 画像バイナリは保存せず URL のみ(仕様 8)

-- 監視対象アプリ。最新の重い項目(説明文・スクショURL等)もここに載せる
CREATE TABLE monitored_apps (
  package_name      TEXT PRIMARY KEY,
  title             TEXT,
  developer         TEXT,
  developer_id      TEXT,
  icon_url          TEXT,
  header_image_url  TEXT,
  category          TEXT,
  summary           TEXT,
  description       TEXT,
  screenshot_urls   TEXT,                      -- JSON 配列(URL のみ)
  developer_email   TEXT,
  developer_website TEXT,
  privacy_policy    TEXT,
  released          TEXT,
  -- 実装ポイント: 一覧画面のために毎回スナップショット全体を走査すると D1 の読み取り行数を大量に消費するため、
  -- 表示に使う最新値だけをここに非正規化して持つ(履歴の正は app_snapshots 側)。仕様 24 / 18
  latest_collected_date  TEXT,
  latest_version         TEXT,
  latest_score           REAL,
  latest_ratings         INTEGER,
  latest_reviews_count   INTEGER,
  latest_installs        TEXT,
  latest_play_updated_at TEXT,
  -- 'active' = 監視中 / 'paused' = 監視停止(仕様 13.1)
  status            TEXT NOT NULL DEFAULT 'active',
  -- Google Play から取得できなくなった状態。自動削除はしない(仕様 13.3)
  unavailable       INTEGER NOT NULL DEFAULT 0,
  added_at          TEXT NOT NULL,
  last_success_at   TEXT,
  last_error_at     TEXT,
  last_error        TEXT,
  last_analyzed_at  TEXT
);

CREATE INDEX idx_apps_status ON monitored_apps(status);

-- 日次スナップショット(仕様 6)
CREATE TABLE app_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name      TEXT NOT NULL,
  collected_date    TEXT NOT NULL,             -- JST の YYYY-MM-DD
  collected_at      TEXT NOT NULL,             -- ISO8601 (UTC)
  title             TEXT,
  developer         TEXT,
  icon_url          TEXT,
  category          TEXT,
  score             REAL,
  ratings           INTEGER,
  reviews_count     INTEGER,
  installs          TEXT,
  min_installs      INTEGER,
  version           TEXT,
  -- 実装ポイント: Google Play は詳細ページからアプリのバージョン表記を廃止しており、
  -- 多くのアプリで版数が取得できない。差分表示(仕様 6.3)の要なので、
  -- 取得できない場合は最新レビューの申告バージョンで補完し、その出所をここに記録する。
  --   'play'    = Google Play が公開している値
  --   'reviews' = レビューから推定した値
  version_source    TEXT,
  play_updated_at   TEXT,                      -- Google Play 上の「更新日」
  recent_changes    TEXT,                      -- What's New
  price_text        TEXT,
  price_micros      INTEGER,
  currency          TEXT,
  is_free           INTEGER,
  offers_iap        INTEGER,
  iap_range         TEXT,
  android_version   TEXT,
  content_rating    TEXT,
  ad_supported      INTEGER,
  -- 重い項目は本文を持たずハッシュのみ保持して変化検知に使う
  description_hash  TEXT,
  screenshots_hash  TEXT,
  -- 取得できなかった日を記録するためのフラグ
  unavailable       INTEGER NOT NULL DEFAULT 0,
  -- 同一日の再実行を冪等にする(仕様 9.2 / 17.2)
  UNIQUE(package_name, collected_date)
);

CREATE INDEX idx_snapshots_pkg_date ON app_snapshots(package_name, collected_date DESC);

-- レビュー。直近 90 日のみ保持する(仕様 7)
CREATE TABLE reviews (
  review_id     TEXT PRIMARY KEY,              -- Google Play 側のレビュー ID で一意性を確保(仕様 7.3)
  package_name  TEXT NOT NULL,
  author        TEXT,
  score         INTEGER,
  text          TEXT,
  thumbs_up     INTEGER,
  app_version   TEXT,
  review_date   TEXT NOT NULL,                 -- ISO8601 (UTC)
  reply_text    TEXT,
  reply_date    TEXT,
  fetched_at    TEXT NOT NULL
);

CREATE INDEX idx_reviews_pkg_date ON reviews(package_name, review_date DESC);
CREATE INDEX idx_reviews_date ON reviews(review_date);

-- AI 分析結果(仕様 10)
CREATE TABLE ai_analyses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date      TEXT NOT NULL,                 -- JST の YYYY-MM-DD
  scope         TEXT NOT NULL,                 -- 'app' | 'global'
  package_name  TEXT,                          -- scope='global' の場合は NULL
  analysis_type TEXT NOT NULL,                 -- 'daily' | 'comparison' | 'manual'
  -- 'done' | 'failed' | 'skipped'(無料枠超過などで未実施。仕様 10.2)
  status        TEXT NOT NULL,
  model         TEXT,
  content       TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_analyses_pkg ON ai_analyses(package_name, created_at DESC);
CREATE INDEX idx_analyses_run ON ai_analyses(run_date, scope);

-- 日次処理を複数回の Cron 発火に分割するためのキュー(仕様 5.1 / 9.1)
CREATE TABLE collection_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_date     TEXT NOT NULL,                  -- JST の YYYY-MM-DD
  kind         TEXT NOT NULL,                  -- 'collect' | 'analyze'
  package_name TEXT,                           -- 全体分析のときは NULL
  -- 'pending' | 'running' | 'done' | 'failed'
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  locked_at    TEXT,                           -- running になった時刻。古いロックは再取得可能(仕様 17.3)
  updated_at   TEXT NOT NULL,
  last_error   TEXT,
  -- 同じ日・同じ種別・同じアプリのタスクを二重に積まない(仕様 14.3 / 17.4)
  UNIQUE(run_date, kind, package_name)
);

CREATE INDEX idx_queue_pick ON collection_queue(kind, status, id);

-- 実行履歴(ログ相当)。無制限に増やさず定期的に間引く(仕様 20)
CREATE TABLE collection_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  kind         TEXT NOT NULL,                  -- 'collect' | 'analyze' | 'maintenance' | 'qa'
  trigger      TEXT NOT NULL,                  -- 'cron' | 'manual'
  package_name TEXT,
  status       TEXT NOT NULL,                  -- 'success' | 'error' | 'skipped'
  message      TEXT,
  duration_ms  INTEGER
);

CREATE INDEX idx_jobs_started ON collection_jobs(started_at DESC);
CREATE INDEX idx_jobs_pkg ON collection_jobs(package_name, started_at DESC);

-- 実行状態の保存用 KV(最終収集時刻・エラー件数など。仕様 16)
CREATE TABLE system_status (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- Web UI から変更可能な設定(Gemini モデル名など。仕様 10.1 / 27.5)
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);
