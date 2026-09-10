-- Google Play App Watcher 初期スキーマ
--
-- 実装ポイント:
--  * データの粒度は「アプリ × 国 × 日」。
--    Google Play は評価を国別に集計しており、実測では YouTube が
--    日本 3.24 / 米国 3.84、LINE が 日本 3.40 / 米国 3.08 と差が出る。
--    レビュー・コンテンツレーティング・通貨・説明文も国によって変わる。
--    一方 評価件数(ratings)とインストール数は全世界共通の値が返る。
--  * 日次スナップショットは差分表示に必要なスカラー値だけを持たせて行サイズを抑える(仕様 6.2 / 18)
--  * 説明文・スクリーンショット等の重い項目は monitored_apps に最新値のみ保持し、
--    スナップショット側にはハッシュだけを入れて「変化したかどうか」を判定できるようにする
--  * 画像バイナリは保存せず URL のみ(仕様 8)

-- 監視対象アプリ。国によらない共通情報だけを持つ
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
  -- 'active' = 監視中 / 'paused' = 監視停止(仕様 13.1)
  status            TEXT NOT NULL DEFAULT 'active',
  -- 全対象国で取得できなくなった状態。自動削除はしない(仕様 13.3)
  unavailable       INTEGER NOT NULL DEFAULT 0,
  added_at          TEXT NOT NULL,
  last_success_at   TEXT,
  last_error_at     TEXT,
  last_error        TEXT,
  last_analyzed_at  TEXT
);

CREATE INDEX idx_apps_status ON monitored_apps(status);

-- 国ごとの最新値。
-- 実装ポイント: 一覧画面のために毎回スナップショット全体を走査すると D1 の読み取り行数を
-- 大量に消費するため、表示に使う最新値だけをここに非正規化して持つ(履歴の正は app_snapshots 側)。
-- monitored_apps に latest_score_us のような列を足す形は、国を増やすたびに
-- スキーマ変更が必要になるため採らなかった。仕様 24 / 18
CREATE TABLE app_countries (
  package_name           TEXT NOT NULL,
  country                TEXT NOT NULL,          -- 'JP' | 'US'
  latest_collected_date  TEXT,
  latest_version         TEXT,
  latest_score           REAL,
  latest_ratings         INTEGER,
  latest_reviews_count   INTEGER,
  latest_installs        TEXT,
  latest_play_updated_at TEXT,
  -- 国別に取得可否が変わることがあるため、状態も国ごとに持つ
  unavailable            INTEGER NOT NULL DEFAULT 0,
  last_success_at        TEXT,
  last_error_at          TEXT,
  last_error             TEXT,
  PRIMARY KEY (package_name, country)
);

CREATE INDEX idx_countries_pkg ON app_countries(package_name);

-- 日次スナップショット(仕様 6)
CREATE TABLE app_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name      TEXT NOT NULL,
  country           TEXT NOT NULL,
  collected_date    TEXT NOT NULL,             -- JST の YYYY-MM-DD
  collected_at      TEXT NOT NULL,             -- ISO8601 (UTC)
  title             TEXT,
  developer         TEXT,
  icon_url          TEXT,
  category          TEXT,
  score             REAL,                      -- 国別に集計された評価
  ratings           INTEGER,                   -- 全世界共通
  reviews_count     INTEGER,                   -- 国別
  installs          TEXT,                      -- 全世界共通
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
  -- 同一日・同一国の再実行を冪等にする(仕様 9.2 / 17.2)
  UNIQUE(package_name, country, collected_date)
);

CREATE INDEX idx_snapshots_pkg_date ON app_snapshots(package_name, country, collected_date DESC);

-- レビュー。直近 90 日のみ保持する(仕様 7)
CREATE TABLE reviews (
  review_id     TEXT PRIMARY KEY,              -- Google Play 側のレビュー ID で一意性を確保(仕様 7.3)
  package_name  TEXT NOT NULL,
  country       TEXT NOT NULL,                 -- どの国のレビュー一覧で取得したか
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

CREATE INDEX idx_reviews_pkg_country_date ON reviews(package_name, country, review_date DESC);
CREATE INDEX idx_reviews_date ON reviews(review_date);

-- AI 分析結果(仕様 10)。
-- 実装ポイント: 分析は全対象国のデータをまとめて 1 回で行うため国別に分けない。
-- 国ごとに分析すると Gemini の呼び出し回数が国の数だけ増えて無料枠に触れる(仕様 10.2)。
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

-- 日次処理を複数回の Cron 発火に分割するためのキュー(仕様 5.1 / 9.1)。
-- 実装ポイント: タスクは国別に分けない。1 アプリ分のタスクの中で全対象国をまとめて取得する。
-- 国別に分けるとロック取得と実行履歴が国の数だけ増え、
-- サブリクエスト上限(無料プランは 50/実行)に対して不利になる。
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
