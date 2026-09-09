# Google Play App Watcher

Google Play 上のアプリを毎日 1 回自動で追跡し、変化を記録して Gemini で分析する個人用ツール。
Cloudflare Workers + D1 の無料枠内で動くことを前提に作ってあります。

- 監視対象は最大 100 アプリ
- アプリ詳細（バージョン・評価・評価件数・インストール数・What's New など）とレビューを日次で収集
- 前日との差分、レビュー傾向の AI 分析、アプリ横断の比較分析、AI への Q&A
- 画面は Basic 認証で保護

---

## 必要なもの

| | |
|---|---|
| Node.js | 20 以上 |
| Cloudflare アカウント | 無料プランで可（Workers / D1 / Cron Triggers） |
| Gemini API キー | 任意。未設定でもデータ収集は動き、AI 分析だけがスキップされます |

---

## セットアップ（ローカル）

```bash
npm install

# ローカル用のシークレットを用意する
cp .dev.vars.example .dev.vars
#   BASIC_AUTH_USER / BASIC_AUTH_PASS を好きな値に
#   GEMINI_API_KEY は空のままでも起動します

# ローカル D1 にスキーマを適用
npm run migrate:local

# 開発サーバー起動（http://127.0.0.1:8787）
npm run dev
```

Cron の遷移をローカルで試す場合は `--test-scheduled` を付けて起動し、
`/__scheduled` を叩くと `scheduled()` ハンドラが 1 回発火します。

```bash
npx wrangler dev --port 8787 --test-scheduled
# 別のシェルから
node -e "fetch('http://127.0.0.1:8787/__scheduled?cron=*/10+*+*+*+*').then(r=>r.text()).then(console.log)"
```

ローカル DB を作り直したいときは `.wrangler/state` を削除してから
`npm run migrate:local` をやり直します（マイグレーションを書き換えた場合は必須）。
削除する前に開発サーバーを止めてください。起動中は SQLite ファイルがロックされています。

---

## デプロイ

**運用中の環境は GitHub と連携済みで、`main` への push で自動デプロイされます。**
Cloudflare Workers Builds がリポジトリを監視し、`npx wrangler deploy` を実行します。

```
git push  →  GitHub  →  Cloudflare Workers Builds  →  本番反映
```

手元から直接デプロイすることもできます（緊急時や、コミットせずに試したいとき）。

```bash
npm run deploy
```

ビルドの状況は Cloudflare ダッシュボードの Workers → app-watcher → 設定 → ビルド、
実行時のログは `npm run tail` で追えます。

### 初回セットアップ（新しい環境に立ち上げる場合）

```bash
# 1. D1 を作成し、出力された database_id を wrangler.jsonc の
#    d1_databases[0].database_id に貼る（初期値は PLACEHOLDER_RUN_WRANGLER_D1_CREATE）
npx wrangler d1 create app-watcher

# 2. リモート DB にスキーマを適用
npm run migrate:remote

# 3. シークレットを登録
npx wrangler secret put BASIC_AUTH_USER
npx wrangler secret put BASIC_AUTH_PASS
npx wrangler secret put GEMINI_API_KEY   # AI 分析を使う場合のみ

# 4. 初回デプロイ
npm run deploy
```

> **シークレットは必ず `wrangler secret put` で登録してください。**
> Cloudflare ダッシュボードから「通常の環境変数（Text）」として追加すると、
> `wrangler deploy` 実行時に `wrangler.jsonc` の `vars` で上書きされて消えます。

Git 連携を設定する場合は、ダッシュボードの Workers → app-watcher → 設定 → ビルド →
「Git リポジトリ」の接続から行います。ビルドコマンドは空、デプロイコマンドは `npx wrangler deploy` です。

独自サブドメインを使う場合は Cloudflare ダッシュボードの
Workers → 該当 Worker → Settings → Domains & Routes から Custom Domain を割り当てます。
`wrangler.jsonc` に routes の記述例をコメントで置いてあります。

---

## 動作の仕組み

Cron Trigger は **10 分おきに 1 本だけ**登録し、発火のたびに状態を見て
「次にやるべき 1 種類」だけを実行します（無料プランの Cron 本数制限に収めるため）。

```
tick → 開始時刻を過ぎていて当日キューが無い       → 収集キューを積む
     → 収集キューに残りがある                     → N 件だけ収集
     → 当日の収集が全部終わっていて分析キューが無い → 分析キューを積む（+ 全体分析 1 件）
     → 分析キューに残りがある                     → N 件だけ分析
     → やることが無い                             → 1 日 1 回のメンテナンス
```

1 日 1 回の収集という要件を保ちつつ、失敗した分がその日のうちに自動でリトライされます
（キューの試行は 3 回まで）。1 tick あたりの件数は設定画面から変更できます。

### 設定の優先順位

`D1 の settings テーブル` ＞ `wrangler.jsonc の vars` ＞ ソース内の既定値

画面から変更できるのは settings テーブルに入る項目だけです。
`MAX_APPS` など vars 側の項目を変えるには `wrangler.jsonc` を編集して再デプロイします。

`1 日あたりの Gemini 呼び出し上限` に **0** を指定すると、AI 分析を完全に止めて
データ収集だけを続けられます。上限に達した場合は API を呼ばずに `skipped` として記録され、
収集は影響を受けません。

---

## 既知の制約

**Google Play は詳細ページでのバージョンと Android 要件の公開を廃止しています。**
YouTube / LINE / Adobe Acrobat で確認した限り、埋め込み JSON のどこにも含まれていません。

- **バージョン**: 取得できない場合、収集済みレビューの申告バージョンのうち最も新しいものを採用します。
  出所は `app_snapshots.version_source`（`play` / `reviews`）に記録され、
  画面には「※Play 非公開のためレビュー申告値から推定」と表示されます。
- **Android 要件**: 取得手段がないため常に空です。画面には「Google Play 非公開」と表示されます。

Google Play 側の HTML 構造が変われば収集は壊れます。その場合は
`src/collector/parse-utils.ts` と `play-detail.ts` の抽出パスを直してください。

---

## ディレクトリ構成

```
/
├── wrangler.jsonc            # D1 バインディング・Cron・vars
├── migrations/
│   └── 0001_init.sql         # 全テーブル定義
└── src/
    ├── index.ts              # fetch + scheduled エントリ
    ├── config.ts             # 設定解決（settings 表 > vars > 既定値）
    ├── types.ts
    ├── util/                 # 日時（JST）・ハッシュ
    ├── collector/            # Google Play の取得と解析
    ├── db/                   # テーブルごとのクエリ
    ├── ai/                   # Gemini 呼び出しとプロンプト
    ├── jobs/                 # 収集・分析・メンテナンス・スケジューラ
    └── web/                  # hono/jsx による画面
```

---

## バックアップ

D1 の Time Travel（ポイントインタイムリストア）を第一の手段とします。
Worker からは実行できないのでローカルから叩きます。

```bash
npx wrangler d1 time-travel info app-watcher
npx wrangler d1 time-travel restore app-watcher --timestamp=<ISO8601>

# 手動エクスポート（任意）
npx wrangler d1 export app-watcher --remote --output=backup.sql
```
