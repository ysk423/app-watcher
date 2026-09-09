# 設計書 — Google Play App Watcher

現状の実装に基づく設計ドキュメント。機能仕様は [spec.md](./spec.md) を参照。

最終更新: 2026-09-09（Cloudflare へデプロイ済み）

---

## 1. 設計の前提

**すべて無料枠で運用しきる**ことを最上位の制約に置いている。この制約が以下の設計判断すべての根拠になっている。

| 制約 | 由来 | 設計への影響 |
|---|---|---|
| Worker あたりの Cron Trigger 本数が限られる | Workers 無料プラン | Cron を 1 本に集約し、tick 内で状態遷移を判断する |
| リクエストあたりの CPU 時間・サブリクエスト数に上限 | Workers 無料プラン | 1 tick で数件だけ処理し、複数アプリの並列取得はしない |
| D1 のストレージが 1 データベースあたり 500 MB | D1 無料プラン | 一覧表示用の値を非正規化、重い項目はハッシュのみ保存、レビューは 90 日で削除 |
| D1 の読み取り行数に上限 | D1 無料プラン | 一覧画面でスナップショット全体を走査しない |
| Durable Objects が使えない | 有料機能 | 排他制御を D1 のテーブルで代替 |
| Gemini API に無料枠の上限 | Google AI Studio | 呼び出し前に自前カウンタで判定し、超過時は API を叩かない |

---

## 2. 全体構成

```
                 ┌─────────────────────────────────┐
  Cron Trigger   │  Cloudflare Worker              │
  (*/10 * * * *) │                                 │
       ─────────►│  scheduled() ──► runScheduledTick
                 │                       │         │
  ブラウザ        │                       ▼         │
       ─────────►│  fetch() ──► hono router        │
                 │      ↑                │         │
                 │  Basic 認証           │         │
                 └───────────────────────┼─────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
              Google Play         Gemini API                 D1
          （詳細 HTML /        （分析・Q&A）            （全データ）
            batchexecute）
```

エントリポイントは `src/index.ts` の 1 ファイルで、`fetch`（Web UI）と `scheduled`（定期処理）の 2 つのハンドラを持つ。

`scheduled` は `ctx.waitUntil()` で包み、tick 内の例外が Cron 自体を落とさないようにしている。失敗はキューの `attempts` と実行履歴に残り、次の発火で再試行される。

---

## 3. ディレクトリ構成と責務

```
src/
├── index.ts              エントリ（fetch + scheduled）
├── config.ts             設定解決・定数
├── types.ts              型定義
├── util/
│   ├── time.ts           JST 変換・日付ユーティリティ
│   └── hash.ts           変更検知用ハッシュ
├── collector/            ── Google Play からの取得層
│   ├── parse-utils.ts    AF_initDataCallback 抽出・括弧対応スキャン・フォールバック
│   ├── play-detail.ts    アプリ詳細の取得と解析
│   └── play-reviews.ts   batchexecute によるレビュー取得
├── db/                   ── データアクセス層（テーブルごと）
│   ├── apps.ts           monitored_apps
│   ├── snapshots.ts      app_snapshots・差分計算
│   ├── reviews.ts        reviews・集計
│   ├── analyses.ts       ai_analyses
│   ├── queue.ts          collection_queue
│   ├── jobs.ts           collection_jobs
│   └── system.ts         system_status・settings・排他制御
├── ai/                   ── Gemini 連携層
│   ├── gemini.ts         API 呼び出し・エラー分類・呼び出し回数管理
│   └── prompts.ts        コンテキスト組み立て
├── jobs/                 ── ジョブ層
│   ├── collect.ts        アプリ 1 件の収集
│   ├── analyze.ts        AI 分析 1 件
│   ├── maintenance.ts    保持期間超過データの削除
│   └── scheduler.ts      tick の状態遷移
└── web/                  ── プレゼンテーション層
    ├── layout.tsx        共通レイアウト・CSS
    ├── router.tsx        ルーティング・Basic 認証・入力検証
    └── pages/            各画面
```

**層の依存方向**は `web / jobs → ai / db / collector → util` の一方向。`db` 層が `collector` を呼ぶことはない。

`collector` を独立した層にしているのは、Google Play 側の HTML 構造変更で壊れる可能性が最も高い部分だからで、修理範囲をここに閉じ込める意図がある。

---

## 4. データモデル

### 4.1 テーブル一覧

| テーブル | 役割 | 増え方 |
|---|---|---|
| `monitored_apps` | 監視対象アプリ。最新の重い項目もここに持つ | アプリ数（最大 100） |
| `app_snapshots` | 日次スナップショット。履歴の正 | アプリ数 × 日数（削除しない） |
| `reviews` | レビュー本文 | 直近 90 日分のみ |
| `ai_analyses` | AI 分析結果 | アプリごと直近 30 件 |
| `collection_queue` | 日次処理を分割するキュー | 保持期間経過後に削除 |
| `collection_jobs` | 実行履歴（ログ相当） | 直近 30 日分のみ |
| `system_status` | 実行状態の KV・排他ロック | 固定 |
| `settings` | Web UI から変更可能な設定 | 固定（7 キー） |

### 4.2 非正規化の判断

`monitored_apps` に `latest_version` / `latest_score` / `latest_ratings` などの列を重複して持たせている。

一覧画面で毎回 `app_snapshots` を走査すると D1 の読み取り行数を大量に消費するため、**表示に使う最新値だけを非正規化**した。履歴の正はあくまで `app_snapshots` 側にあり、`monitored_apps` の値は収集のたびに上書きされるキャッシュとして扱う。

### 4.3 重い項目の扱い

説明文とスクリーンショット URL は、スナップショットに本文を持たせず**ハッシュだけ**を保存する（`description_hash` / `screenshots_hash`）。

- 「変わったかどうか」は判定できる
- 行サイズが日数分だけ膨らむことはない
- 最新の本文は `monitored_apps` 側にある

画像バイナリは一切保存せず URL のみ。

### 4.4 冪等性

`app_snapshots` に `UNIQUE(package_name, collected_date)` を張り、同じ日に何度収集しても行が増えないようにしている（upsert）。手動の「今すぐ取得」を何度押しても履歴は汚れない。

`collection_queue` は `UNIQUE(run_date, kind, package_name)` で同じタスクの二重投入を防ぐ。

> **注意**: SQLite の UNIQUE 制約は NULL を互いに区別するため、全体分析（`package_name IS NULL`）はこの制約では重複を防げない。代わりに、キュー投入前に `queueExistsForDate()` でその日のキューの有無を確認することで担保している。

---

## 5. スケジューリング設計

### 5.1 単一 Cron による状態遷移

要件では「時間帯ごとに複数の Cron を登録」する想定だったが、**10 分おきの単一 tick に集約**した。無料プランは Worker あたりの Cron 本数に制限があるためである。

tick が発火するたびに現在の状態を見て、**次にやるべき 1 種類だけ**を実行する。

```
tick
 │
 ├─ 開始時刻を過ぎている & 当日の収集キューが無い
 │     → 収集キューを積んで終了
 │
 ├─ 収集キューに pending がある
 │     → collectBatchSize 件だけ収集して終了
 │
 ├─ 当日の収集が全て終了 & 当日の分析キューが無い
 │     → 分析キューを積む（+ 全体分析 1 件）して終了
 │
 ├─ 分析キューに pending がある
 │     → analyzeBatchSize 件だけ分析して終了
 │
 └─ やることが無い
       → 1 日 1 回のメンテナンスを実行
```

この方式の利点:

- 1 日 1 回の収集という要件を満たしつつ、**失敗分が当日中に自動リトライされる**
- 1 tick あたりの処理量が小さいので CPU 時間の上限に触れにくい
- 状態は D1 にあるので、tick が飛んでも次の発火で続きから再開できる

100 アプリを `collectBatchSize=2` で処理する場合、10 分 × 50 回 = 約 8 時間 20 分かかる。開始時刻 03:00 なら 11:20 頃に収集が終わる計算になる。

### 5.2 キューの再試行

- 取得のたびに `attempts` をインクリメント
- `MAX_QUEUE_ATTEMPTS = 3` に達したら `failed` として、その日はもう試行しない
- `status='running'` のまま `STALE_LOCK_MINUTES = 10` 分放置されたタスクはロックを解放して再取得可能にする（tick が途中で落ちた場合の回収）

再試行しないケースもある。存在しないアプリ（404）のように**リトライしても結果が変わらない失敗**は `retryable: false` を返し、即座に打ち切る。

### 5.3 排他制御

Durable Objects が有料のため、`system_status` テーブルの主キー制約と `INSERT OR IGNORE` で排他ロックを実装している。

```
acquireLock(key)  →  INSERT OR IGNORE で行を作れたら取得成功
releaseLock(key)  →  行を削除
```

古いロックは経過時間で無効化するため、ロックを持ったまま Worker が落ちてもデッドロックしない。

---

## 6. Google Play からの取得

### 6.1 2 つの異なる経路

| 対象 | 経路 | 実装 |
|---|---|---|
| アプリ詳細 | 詳細ページの HTML に埋め込まれた `AF_initDataCallback` の JSON | `play-detail.ts` |
| レビュー | Play 内部の `batchexecute` RPC エンドポイント | `play-reviews.ts` |

レビューは詳細ページの HTML に含まれていないため、まったく別の経路になる。この 2 つを分離しているので、**レビュー取得が壊れても詳細取得は成功扱いのまま**にできる（`collect.ts` 側で try/catch を分けている）。

### 6.2 パースの保守性

`AF_initDataCallback` の JSON は添字だけの巨大な入れ子配列で、Google 側の変更で位置がずれる。そのため各項目を**候補パスの配列**として持ち、先に取れたものを採用する設計にしている。

```typescript
const PATHS = {
  title: [[1, 2, 0, 0]],
  installs: [[1, 2, 13, 0]],
  // ...
};
```

さらに、主要項目は `ld+json` と `meta` タグからのフォールバックも用意している。

括弧の対応を数えながらスキャンする `sliceBalanced()` で JSON 部分を切り出しており、正規表現による雑な抽出には依存していない。

### 6.3 バージョン取得の代替手段

**Google Play は詳細ページからバージョンと Android 要件の公開を廃止している。** YouTube / LINE / Adobe Acrobat の 3 アプリで確認したが、埋め込み JSON のどこにも存在しない。

バージョンは差分表示の要なので、取得できない場合の代替を実装した。

```
detail.version が取れない
  → 取得済みレビューの申告バージョン（app_version）のうち最も新しいものを採用
  → version_source = 'reviews' として出所を記録
  → UI で「※Play 非公開のためレビュー申告値から推定」と明示
```

`android_version` は代替手段が無いため常に null で、UI では「Google Play 非公開」と表示する。

この設計により、**データの出所が常に追跡可能**になっている。推定値が正確でない可能性を UI で隠さない。

---

## 7. AI 連携設計

### 7.1 コンテキストの制限

DB 全体を送らず、対象・期間・差分だけを抽出して**件数と本文長に必ず上限をかける**。

| 用途 | 制限 |
|---|---|
| アプリ分析のレビュー | 15 件 |
| Q&A のレビュー | 15 件 |
| Q&A のアプリ一覧 | 100 件 |
| 分析対象期間 | 直近 7 日 |
| Q&A の期間 | 直近 90 日 |
| レビュー本文 | 300 文字で切る |
| 質問文 | 500 文字で切る |

Q&A では、**質問文にアプリ名かパッケージ名が登場するアプリだけ**（最大 2 件）レビュー本文を添付する。全アプリのレビューを送ると簡単にコンテキスト上限に達するためである。

この設計上、アプリ名を含まない質問（「評価が最も低いアプリは？」など）ではレビューに基づく回答は返らない。これは意図した挙動である。

### 7.2 エラーの二分類

Gemini のエラーを 2 種類に分けている。この区別が挙動を決める。

| クラス | 意味 | 扱い |
|---|---|---|
| `GeminiQuotaError` | 無料枠・レート制限に到達 | `status='skipped'`。その日は自動再試行しない |
| `GeminiError` | キー不正・応答不正など | `status='failed'`。通常のリトライ対象 |

429 レスポンス、および `quota` / `RESOURCE_EXHAUSTED` / `rate limit` を含むエラーメッセージを `GeminiQuotaError` に分類する。

**いずれの場合もデータ収集は止まらない。** 分析と収集は独立したジョブとして設計されている。

### 7.3 呼び出し前の自主規制

API を叩く前に D1 の日次カウンタを確認し、上限に達していれば**リクエストを送らずに**スキップする。無料枠を超えて課金に移行することを防ぐ設計である。

上限に **0** を指定すると AI 分析を完全に停止し、データ収集だけを継続できる。

> この 0 は当初動作しなかった。設定値のパース関数が `n > 0` 判定で、0 を「未設定」とみなして既定値 180 にフォールバックさせていたためである。`toNonNegativeInt` / `asNonNegativeInt` を追加して修正済み。

---

## 8. 設定の解決

優先順位は以下の通り。

```
D1 の settings テーブル  >  wrangler.jsonc の vars  >  ソース内の既定値
```

- **settings**: Web UI から変更する項目（Gemini モデル・呼び出し上限・開始時刻・バッチサイズ・保持期間）
- **vars**: 再デプロイを伴う項目（`MAX_APPS`・`REVIEWS_PER_FETCH`・ストレージ上限）
- **secrets**: 秘密情報のみ（`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` / `GEMINI_API_KEY`）

秘密情報がコードにもリポジトリにも入らないよう、`.dev.vars` は `.gitignore` で除外している。

> **運用上の注意**: settings が vars より優先されるため、`wrangler.jsonc` の値を変えても settings に値が残っていると反映されない。モデル名を切り替えたときにこれが問題になった。切り替え時は `DELETE FROM settings WHERE key='...'` が必要になる場合がある。

---

## 9. 障害設計

### 9.1 失敗しても壊さない

| 原則 | 実装 |
|---|---|
| 取得失敗時に既存データを削除しない | エラー時は `last_error` を記録するだけ |
| 取得できないアプリを自動削除しない | `unavailable` フラグを立てて「取得できません」と表示 |
| 分析の失敗が収集に波及しない | 独立したジョブ・独立したキュー |
| レビュー取得の失敗が詳細取得に波及しない | try/catch を分離 |
| tick の例外が Cron を落とさない | `ctx.waitUntil()` + catch |
| スナップショットは削除対象にしない | メンテナンスの対象外 |

### 9.2 縮退運転

Gemini が使えない状態（キー未設定・枠超過・API 障害）でも、**データ収集は完全に動作し続ける**。AI 分析は付加価値であって、収集の前提条件ではない。

---

## 10. Web UI

- **hono/jsx による SSR**。クライアント側 JavaScript は使わない
- CSS は `layout.tsx` にインラインで持ち、外部リクエストを発生させない
- Basic 認証を全ルートに適用（`app.use('*', ...)`）
- 認証情報が未設定の場合は 500 を返して機能させない（**未設定のまま公開されることを防ぐ**）
- 破壊的操作（永久削除）は確認画面を挟む

---

## 11. デプロイ構成

| 項目 | 値 |
|---|---|
| Worker 名 | `app-watcher` |
| URL | https://app-watcher.ysk-ino-123.workers.dev |
| D1 データベース | `app-watcher`（APAC リージョン） |
| Cron | `*/10 * * * *` |
| 互換性日付 | 2026-09-01 |

シークレット 3 つは `wrangler secret put` で登録する。

> **重要**: Cloudflare ダッシュボードから「通常の環境変数（Text）」として追加した値は、`wrangler deploy` 実行時に `wrangler.jsonc` の `vars` で上書きされて**消える**。必ず Secret 種別で登録すること。デプロイ時に実際にこの問題が発生した。

---

## 12. 今後の変更が必要になりうる箇所

| 箇所 | 想定される変更 |
|---|---|
| `collector/` | Google Play の HTML 構造変更。最も壊れやすい |
| `ai/gemini.ts` | Gemini のモデル世代交代（`gemini-2.5-flash-lite` は既に提供終了） |
| `jobs/scheduler.ts` | アプリ数が増えた場合のバッチサイズ調整 |
| `config.ts` | 無料枠の仕様変更 |
