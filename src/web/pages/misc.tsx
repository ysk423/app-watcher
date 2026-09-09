import type { FC } from 'hono/jsx';
import type { AppConfig } from '../../config';
import type { AiAnalysis, JobLog, MonitoredApp } from '../../types';
import { formatJst } from '../../util/time';

/** アプリ登録(仕様 27.4 / 14.1) */
export const NewAppPage: FC<{ activeCount: number; maxApps: number }> = ({ activeCount, maxApps }) => (
  <div class="panel">
    <form method="post" action="/apps">
      <p>
        <label for="package_name">パッケージ名</label>
        <input
          type="text"
          id="package_name"
          name="package_name"
          placeholder="com.example.app"
          required
          autocomplete="off"
        />
      </p>
      <p class="small muted">
        Google Play の URL(https://play.google.com/store/apps/details?id=<b>com.example.app</b>)の id
        部分を入力してください。
      </p>
      <p>
        <label>
          <input type="checkbox" name="collect_now" value="1" checked style="width:auto" /> 登録後すぐに取得する
        </label>
      </p>
      <button class="primary" type="submit">登録する</button>
      <span class="small muted"> 監視中 {activeCount} / {maxApps} 件</span>
    </form>
  </div>
);

/** 永久削除の確認(仕様 13.2 の確認ダイアログ相当。SSR なので確認ページとして実装) */
export const DeleteConfirmPage: FC<{ app: MonitoredApp }> = ({ app }) => (
  <div class="panel">
    <p>
      <b>{app.title ?? app.package_name}</b>({app.package_name})を永久削除します。
    </p>
    <p class="small">
      以下がすべて削除され、元に戻せません。監視を一時的に止めたいだけの場合は「監視を停止」を使ってください
      (履歴は保持されます)。
    </p>
    <ul class="small">
      <li>アプリ情報</li>
      <li>スナップショット履歴</li>
      <li>レビュー</li>
      <li>AI 分析結果</li>
      <li>取得履歴</li>
    </ul>
    <div class="actions">
      <form class="inline" method="post" action={`/apps/${encodeURIComponent(app.package_name)}/delete`}>
        <button class="danger" type="submit">永久削除する</button>
      </form>
      <a class="button" href={`/apps/${encodeURIComponent(app.package_name)}`}>キャンセル</a>
    </div>
  </div>
);

/** AI Q&A(仕様 11 / 27.6) */
export const QaPage: FC<{ question?: string; answer?: string | null; error?: string | null }> = ({
  question,
  answer,
  error,
}) => (
  <>
    <div class="panel">
      <form method="post" action="/qa">
        <p>
          <textarea name="question" placeholder="この3か月で評価が一番改善したアプリは？" required>
            {question ?? ''}
          </textarea>
        </p>
        <button class="primary" type="submit">質問する</button>
        <span class="small muted"> 監視データのうち必要な範囲だけを Gemini へ送信します</span>
      </form>
    </div>

    {error ? <div class="panel notice error">{error}</div> : null}

    {answer ? (
      <>
        <h2>回答</h2>
        <div class="panel">
          <pre class="analysis">{answer}</pre>
        </div>
      </>
    ) : null}

    <div class="panel">
      <h3>質問の例</h3>
      <ul class="small muted">
        <li>この3か月で評価が一番改善したアプリは？</li>
        <li>AアプリとBアプリで、最近のレビュー傾向はどう違う？</li>
        <li>昨日のアップデートで何が変わった？</li>
        <li>最近ユーザーから不満が増えている機能は？</li>
      </ul>
    </div>
  </>
);

/** 実行履歴(仕様 16 / 20) */
export const JobsPage: FC<{ jobs: JobLog[]; globalAnalyses: AiAnalysis[] }> = ({ jobs, globalAnalyses }) => (
  <>
    <h2>全体 AI 分析</h2>
    <div class="panel">
      {globalAnalyses.length === 0 ? (
        <p class="muted">まだ全体分析はありません。</p>
      ) : (
        globalAnalyses.map((a) => (
          <div class="review">
            <div class="small muted">
              {formatJst(a.created_at)} / {a.model ?? '-'}{' '}
              {a.status === 'done' ? (
                <span class="badge ok">完了</span>
              ) : a.status === 'skipped' ? (
                <span class="badge warn">未実施</span>
              ) : (
                <span class="badge danger">失敗</span>
              )}
            </div>
            {a.content ? <pre class="analysis">{a.content}</pre> : <div class="small">{a.error ?? '-'}</div>}
          </div>
        ))
      )}
    </div>

    <h2>実行履歴</h2>
    <div class="panel table-wrap">
      {jobs.length === 0 ? (
        <p class="muted">履歴はまだありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>種別</th>
              <th>実行元</th>
              <th>対象</th>
              <th>結果</th>
              <th>内容</th>
              <th>所要</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr>
                <td class="small">{formatJst(j.started_at)}</td>
                <td class="small">{j.kind}</td>
                <td class="small">{j.trigger}</td>
                <td class="small">
                  {j.package_name ? (
                    <a href={`/apps/${encodeURIComponent(j.package_name)}`}>{j.package_name}</a>
                  ) : (
                    '-'
                  )}
                </td>
                <td>
                  {j.status === 'success' ? (
                    <span class="badge ok">成功</span>
                  ) : j.status === 'skipped' ? (
                    <span class="badge warn">スキップ</span>
                  ) : (
                    <span class="badge danger">失敗</span>
                  )}
                </td>
                <td class="small">{j.message ?? '-'}</td>
                <td class="small">{j.duration_ms != null ? `${j.duration_ms} ms` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </>
);

/** 設定(仕様 27.5) */
export const SettingsPage: FC<{ config: AppConfig; geminiConfigured: boolean }> = ({
  config,
  geminiConfigured,
}) => (
  <>
    <div class="panel">
      <form method="post" action="/settings">
        <h3>AI</h3>
        <p>
          <label for="gemini_model">Gemini モデル名</label>
          <input type="text" id="gemini_model" name="gemini_model" value={config.geminiModel} />
        </p>
        <p>
          <label for="gemini_daily_limit">1 日あたりの Gemini 呼び出し上限</label>
          <input
            type="text"
            id="gemini_daily_limit"
            name="gemini_daily_limit"
            value={String(config.geminiDailyLimit)}
          />
        </p>
        <p class="small muted">0 を指定すると AI 分析を行わず、データ収集だけを継続します。</p>

        <h3>定期実行</h3>
        <p>
          <label for="collect_start_jst">日次収集の開始時刻(JST / HH:MM)</label>
          <input
            type="text"
            id="collect_start_jst"
            name="collect_start_jst"
            value={formatMinutes(config.collectStartMinutes)}
          />
        </p>
        <p class="small muted">
          Cron Trigger 自体は 10 分おきに発火し、この時刻を過ぎた最初の発火で当日分のキューを作成します。
          発火間隔そのものを変えたい場合は wrangler.jsonc の crons を編集してください。
        </p>
        <p>
          <label for="collect_batch_size">1 回の発火で収集する件数</label>
          <input
            type="text"
            id="collect_batch_size"
            name="collect_batch_size"
            value={String(config.collectBatchSize)}
          />
        </p>
        <p>
          <label for="analyze_batch_size">1 回の発火で分析する件数</label>
          <input
            type="text"
            id="analyze_batch_size"
            name="analyze_batch_size"
            value={String(config.analyzeBatchSize)}
          />
        </p>

        <h3>保持期間</h3>
        <p>
          <label for="review_retention_days">レビュー保持日数</label>
          <input
            type="text"
            id="review_retention_days"
            name="review_retention_days"
            value={String(config.reviewRetentionDays)}
          />
        </p>
        <p>
          <label for="log_retention_days">実行履歴の保持日数</label>
          <input
            type="text"
            id="log_retention_days"
            name="log_retention_days"
            value={String(config.logRetentionDays)}
          />
        </p>

        <button class="primary" type="submit">保存する</button>
      </form>
    </div>

    <h2>システム情報</h2>
    <div class="panel">
      <dl class="kv">
        <dt>Gemini API キー</dt>
        <dd>
          {geminiConfigured ? (
            <span class="badge ok">設定済み</span>
          ) : (
            <span class="badge danger">未設定</span>
          )}
          <span class="small muted"> wrangler secret put GEMINI_API_KEY で登録します</span>
        </dd>
        <dt>監視対象上限</dt>
        <dd>
          {config.maxApps} 件
          <span class="small muted"> (変更は wrangler.jsonc の MAX_APPS)</span>
        </dd>
        <dt>1 回の収集で取得するレビュー数</dt>
        <dd>{config.reviewsPerFetch} 件</dd>
      </dl>
    </div>

    <h2>バックアップ / 復元</h2>
    <div class="panel">
      <p class="small">
        D1 の Time Travel(ポイントインタイムリストア)を第一の手段とします(仕様 19)。Worker からは実行できないため、
        以下のコマンドをローカルから実行してください。
      </p>
      <pre class="analysis small">
{`# 復元可能な時点を確認
wrangler d1 time-travel info app-watcher

# 指定時刻へ復元(タイムスタンプは info の出力を使用)
wrangler d1 time-travel restore app-watcher --timestamp=<ISO8601>

# 手動エクスポート(任意)
wrangler d1 export app-watcher --remote --output=backup.sql`}
      </pre>
    </div>
  </>
);

function formatMinutes(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}
