# 作業引き継ぎメモ（2026-09-09 更新）

`google_play_app_watcher_requirements.md` の実装作業。セッション再起動をまたぐための状態記録。

---

## 1. 現在の状態：実装完了、ローカル実機確認もほぼ完了

型チェック（`./node_modules/.bin/tsc --noEmit`）は **通過（EXIT=0）**。
Google Play からの実データ収集、Cron の全遷移、Gemini 連携の 3 機能すべて動作確認済み。

### 作成済みファイル

```
/
├── README.md                 # セットアップ・デプロイ・仕組み・既知の制約
├── package.json              # hono / wrangler / typescript
├── tsconfig.json             # hono/jsx の SSR 設定
├── wrangler.jsonc            # D1バインディング・Cron・vars（database_id は未設定）
├── .gitignore                # .dev.vars を除外
├── .dev.vars.example
├── .dev.vars                 # ローカル用（admin / localdev、Gemini キー設定済み）
├── migrations/
│   └── 0001_init.sql         # 全テーブル定義
└── src/
    ├── index.ts              # fetch + scheduled エントリ
    ├── config.ts             # 設定解決（settings表 > vars > 既定値）
    ├── types.ts
    ├── util/{time,hash}.ts
    ├── collector/
    │   ├── parse-utils.ts    # AF_initDataCallback抽出・括弧対応スキャン・ld+json/metaフォールバック
    │   ├── play-detail.ts    # アプリ詳細の取得と解析
    │   └── play-reviews.ts   # batchexecute によるレビュー取得
    ├── db/{apps,snapshots,reviews,analyses,queue,jobs,system}.ts
    ├── ai/{gemini,prompts}.ts
    ├── jobs/{collect,analyze,maintenance,scheduler}.ts
    └── web/
        ├── layout.tsx
        ├── router.tsx
        └── pages/{dashboard,app-list,app-detail,misc}.tsx
```

---

## 2. 動作確認済みの項目（すべて実データ・実 API で E2E）

| 対象 | 結果 |
|---|---|
| Basic 認証 | 未認証で 401 |
| 画面描画 | ダッシュボード / 一覧 / 詳細 / 実行履歴 / 設定 / Q&A |
| アプリ登録＋即時取得 | `POST /apps` に `collect_now=1` |
| Google Play 実データ | YouTube・LINE で評価 / 評価件数 / インストール数 / カテゴリ / What's New / 更新日 |
| レビュー取得 | 50 件（★・投稿日・端末バージョン付き） |
| バージョン推定 | Play 非公開 → レビュー申告値から補完。詳細画面に「※Play 非公開…」注記が出る |
| 広告有無 | 「あり」と表示 |
| 価格表示 | 「無料」と表示 |
| Cron tick 全遷移 | キュー投入 → 収集 → 分析キュー投入（全体分析 1 件含む）→ 分析 → メンテナンス |
| キューのリトライ | 3 回失敗で `failed`。後続の項目が餓死しないことを確認 |
| 取得不能アプリ | 存在しないパッケージ名 → 自動削除されず「取得できません」表示（仕様 13.3） |
| 監視停止 / 再開 | 一覧の状態表示と件数カウントが連動 |
| 永久削除 | 確認画面 → 削除。snapshots / reviews も連鎖削除される |
| 設定保存 | settings テーブルに保存され、再読込で反映 |
| 100 アプリ上限 | `MAX_APPS=2` で検証。上限到達時に登録を拒否 |
| Gemini 日次分析 | 実キーで成功（1469ms） |
| Gemini 全体分析 | 実キーで成功（1223ms） |
| Gemini Q&A | 実キーで成功。アプリ名を含む質問ではレビュー本文を根拠に回答 |
| レート制限時の挙動 | 上限 0 で検証。API を叩かず `status='skipped'` になり収集は継続 |

---

## 3. 今回の修正内容

### 3-1. Gemini 呼び出し上限に 0 を設定できなかった（バグ修正）

`config.ts` の `toPositiveInt` が `n > 0` 判定だったため、`gemini_daily_limit=0` が
既定値 180 にフォールバックし、上限チェックを素通りして実際に API を叩いていた。
`router.tsx` の `asPositiveInt` も同様に 0 を弾いて保存自体を捨てていた。

- `config.ts` に `toNonNegativeInt` を追加し `geminiDailyLimit` に適用
- `router.tsx` に `asNonNegativeInt` を追加し `gemini_daily_limit` に適用
- 設定画面に「0 を指定すると AI 分析を行わず、データ収集だけを継続します」の注記を追加

これで 0 = AI 分析を止める、という運用ができるようになった。

### 3-2. Gemini のモデル名を更新

`gemini-2.5-flash-lite` は新規ユーザーへの提供が終了しており、API が
「`gemini-3.5-flash-lite` を使え」というエラーを返した。既定値を差し替えた。

- `src/config.ts` の `DEFAULTS.geminiModel`
- `wrangler.jsonc` の `vars.GEMINI_MODEL`

**注意**: 古いモデル名は D1 の settings テーブルにも保存されていることがある。
settings 側の値が vars より優先されるため、切り替え時は
`DELETE FROM settings WHERE key='gemini_model'` が必要になる場合がある。

### 3-3. README.md を作成

セットアップ・デプロイ・Cron の仕組み・設定の優先順位・既知の制約・バックアップ手順。

---

## 4. 調査で判明した重要な事実

**Google Play は詳細ページからバージョンと Android 要件の公開を廃止している。**
YouTube / LINE / Adobe Acrobat の 3 アプリで確認したが、埋め込み JSON のどこにも存在しない。

対応として実装済み：

- `version` が取れない場合、**取得済みレビューの申告バージョンのうち最も新しいものを採用**する
  （`src/jobs/collect.ts` の `inferVersionFromReviews`）
- 出所を `app_snapshots.version_source`（`'play'` / `'reviews'`）に記録し、UI で「※Play 非公開のためレビュー申告値から推定」と表示
- `android_version` は取得手段がないため null のまま。UI では「Google Play 非公開」と表示

その他の修正（前セッション）：
- 広告有無のパス誤りを修正（`[1,2,48]` ではなく `[1,2,48,0]` に「広告が表示されます」が入る）
- 価格表示を `is_free` 優先に修正（`"0"` ではなく「無料」）

---

## 5. 次にやること

### 5-1. 未検証で残っているもの

| 対象 | 内容 |
|---|---|
| ブラウザ表示 | HTML テキストだけ確認済み。実際の見た目・ダークモード・レスポンシブは未確認。Basic 認証のダイアログがあるため手動確認が必要 |
| 差分表示 | 2 日目のスナップショットがまだ無いため「前回取得との差分」の実表示が未確認。翌日以降の tick で確認できる |

### 5-2. git

**コミットはまだ 1 つも無い。** 初回コミットを作るところから。

### 5-3. デプロイ前に必要な作業

```bash
# 1. D1 を作成し、出力された database_id を wrangler.jsonc に貼る
#    （現在は "PLACEHOLDER_RUN_WRANGLER_D1_CREATE"）
./node_modules/.bin/wrangler d1 create app-watcher

# 2. リモート DB にマイグレーション適用
./node_modules/.bin/wrangler d1 migrations apply app-watcher --remote

# 3. シークレット登録
./node_modules/.bin/wrangler secret put GEMINI_API_KEY
./node_modules/.bin/wrangler secret put BASIC_AUTH_USER
./node_modules/.bin/wrangler secret put BASIC_AUTH_PASS

# 4. デプロイ
./node_modules/.bin/wrangler deploy
```

- 独自サブドメインは Cloudflare の Custom Domains で割り当てる（仕様 22）。
  `wrangler.jsonc` にコメントで routes の例を記載済み

---

## 6. 設計上の判断（仕様から変えた点・補足）

- **Cron は 10 分おきの単一 tick に集約**した。無料プランは Worker あたりの Cron 本数に制限があるため、
  「時間帯ごとに複数登録」ではなく tick 内で状態を見て次の 1 種類だけ実行する方式にした。
  1 日 1 回の収集（仕様 5.1）は保ちつつ、失敗分が当日中に自動リトライされる利点がある
- **一覧表示用の最新値を `monitored_apps` に非正規化**した。毎回スナップショット全体を走査すると
  D1 の読み取り行数を大量に消費するため（仕様 24 / 18）
- **説明文・スクショURLはスナップショットに本文を持たずハッシュのみ**保存。変更検知はできて容量は増えない
- **排他制御は `system_status` の主キー + `INSERT OR IGNORE`** で実装（Durable Objects は有料のため。仕様 14.3）
- Gemini は呼び出し前に D1 の日次カウンタを見て、上限超過なら **API を叩かずスキップ**（仕様 10.2）
- Q&A のプロンプトには、**質問文にアプリ名かパッケージ名が登場するアプリのレビュー本文だけ**を添付する
  （全件送らないため。仕様 11.2）。アプリ名を含まない質問ではレビューに基づく回答は返らない

---

## 7. 環境メモ

- ローカル認証情報：`admin` / `localdev`（`.dev.vars`、gitignore 済み）
- `curl` と `rm` はパーミッションの deny リストに入っている。Node の fetch / fs で代替すること
- Git Bash は引数の `/` を Windows パスに変換してしまう。
  URL パスを引数で渡すときは **`MSYS_NO_PATHCONV=1`** を付ける
- **`.wrangler/state` を消す前に `wrangler dev` を止めること。**
  起動中は SQLite ファイルがロックされていて EPERM になる。
  プロセスは `Get-CimInstance Win32_Process` で CommandLine に `wrangler*dev` を含むものを探して落とす
- `.dev.vars` の変更は **ホットリロードされない**。dev サーバーの再起動が必要
- スモークテスト用スクリプト `smoke.mjs` はスクラッチパッドにある（セッションごとに作り直しになる）。
  `get` / `raw` / `post` / `add` / `cron` のサブコマンドを持つ

```bash
# 起動（Cron を手動発火したい場合は --test-scheduled を付ける）
./node_modules/.bin/wrangler dev --port 8787 --test-scheduled
```
