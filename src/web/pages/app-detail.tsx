import type { FC } from 'hono/jsx';
import { COUNTRIES, countryLabel } from '../../config';
import type {
  AiAnalysis,
  AppCountryRow,
  AppSnapshot,
  Country,
  DiffEntry,
  JobLog,
  MonitoredApp,
  ReviewRow,
} from '../../types';
import { formatJst } from '../../util/time';
import { StatusBadge } from '../layout';

export interface AppDetailData {
  app: MonitoredApp;
  /** いま表示している国 */
  country: Country;
  /** 国別の最新値(国切り替えタブの表示に使う) */
  countries: Map<Country, AppCountryRow>;
  latest: AppSnapshot | null;
  diffs: DiffEntry[];
  previousDate: string | null;
  snapshots: AppSnapshot[];
  whatsNew: { collected_date: string; version: string | null; recent_changes: string | null }[];
  reviews: ReviewRow[];
  reviewTotal: number;
  analyses: AiAnalysis[];
  errorJobs: JobLog[];
  reviewRetentionDays: number;
}

/** アプリ詳細(仕様 12.2 / 27.3) */
export const AppDetailPage: FC<{ data: AppDetailData }> = ({ data }) => {
  const { app, latest, country, countries } = data;
  const pkg = encodeURIComponent(app.package_name);
  const currentRow = countries.get(country);
  const screenshots: string[] = app.screenshot_urls ? safeParseArray(app.screenshot_urls) : [];

  return (
    <>
      <div class="panel">
        <div style="display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap;">
          {app.icon_url ? (
            <img src={app.icon_url} alt="" width="64" height="64" style="border-radius:14px" />
          ) : null}
          <div style="flex:1; min-width:240px;">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <strong>{app.title ?? app.package_name}</strong>
              <StatusBadge status={app.status} unavailable={app.unavailable} hasError={app.last_error != null} />
            </div>
            <div class="muted small">{app.package_name}</div>
            <div class="small">{app.developer ?? '-'}</div>
            <div class="small">
              <a href={`https://play.google.com/store/apps/details?id=${pkg}`} target="_blank" rel="noreferrer">
                Google Play で開く
              </a>
            </div>
          </div>
        </div>

        {app.unavailable ? (
          <div class="notice error" style="margin-top:12px">
            ⚠ 取得できません / 最終取得成功: {formatJst(app.last_success_at)}
            <div class="small muted">Google Play から取得できない状態です。過去データは保持されます。</div>
          </div>
        ) : null}

        <div class="actions">
          <form class="inline" method="post" action={`/apps/${pkg}/collect`}>
            <button class="primary" type="submit">今すぐ取得</button>
          </form>
          <form class="inline" method="post" action={`/apps/${pkg}/analyze`}>
            <button type="submit">AI 分析を実行</button>
          </form>
          {app.status === 'active' ? (
            <form class="inline" method="post" action={`/apps/${pkg}/pause`}>
              <button type="submit">監視を停止</button>
            </form>
          ) : (
            <form class="inline" method="post" action={`/apps/${pkg}/resume`}>
              <button type="submit">監視を再開</button>
            </form>
          )}
          <a class="button" href={`/apps/${pkg}/delete`}>永久削除</a>
        </div>
      </div>

      {/* 国の切り替え。評価・レビュー・説明文は国ごとに別の値なので画面も国単位で見せる(仕様 5.5) */}
      <div class="panel country-tabs">
        <div class="tabs">
          {COUNTRIES.map((c) => {
            const row = countries.get(c.country);
            const isCurrent = c.country === country;
            return (
              <a
                class={isCurrent ? 'tab current' : 'tab'}
                href={`/apps/${pkg}?country=${c.country}`}
                aria-current={isCurrent ? 'page' : undefined}
              >
                <span class="tab-label">{c.label}</span>
                <span class="tab-score">
                  {row?.latest_score != null ? row.latest_score.toFixed(2) : '-'}
                </span>
                {row?.unavailable ? <span class="tab-note">取得不可</span> : null}
              </a>
            );
          })}
        </div>
        <p class="muted small">
          評価とレビューは国ごとに集計された値です。評価件数とインストール数は全世界共通です。
        </p>
        {currentRow?.last_error ? (
          <div class="notice error small">
            {countryLabel(country)}の最終エラー: {currentRow.last_error}
          </div>
        ) : null}
      </div>

      <h2>前回取得との差分（{countryLabel(country)}）</h2>
      <div class="panel">
        {data.diffs.length === 0 ? (
          <p class="muted">
            {data.previousDate ? '前回取得から変更はありません。' : '比較できる過去データがまだありません。'}
          </p>
        ) : (
          <>
            <p class="muted small">比較対象: {data.previousDate} → {latest?.collected_date}</p>
            <dl class="kv diff">
              {data.diffs.map((d) => (
                <>
                  <dt>{d.label}</dt>
                  <dd>
                    {d.changedOnly ? (
                      <span class="badge warn">変更あり</span>
                    ) : (
                      <>
                        <span class="from">{d.before}</span> → <span class="to">{d.after}</span>
                      </>
                    )}
                  </dd>
                </>
              ))}
            </dl>
          </>
        )}
      </div>

      <h2>現在の情報（{countryLabel(country)}）</h2>
      <div class="panel">
        {latest == null ? (
          <p class="muted">まだ取得されていません。「今すぐ取得」を実行してください。</p>
        ) : (
          <dl class="kv">
            <dt>取得日</dt>
            <dd>{latest.collected_date}</dd>
            <dt>バージョン</dt>
            <dd>
              {latest.version ?? '-'}
              {latest.version_source === 'reviews' ? (
                <span class="small muted"> ※Play 非公開のためレビュー申告値から推定</span>
              ) : null}
            </dd>
            <dt>評価</dt>
            <dd>{latest.score != null ? latest.score.toFixed(2) : '-'}</dd>
            <dt>評価件数</dt>
            <dd>{latest.ratings != null ? latest.ratings.toLocaleString('ja-JP') : '-'}</dd>
            <dt>インストール数</dt>
            <dd>{latest.installs ?? '-'}</dd>
            <dt>更新日</dt>
            <dd>{latest.play_updated_at ? latest.play_updated_at.slice(0, 10) : '-'}</dd>
            <dt>価格</dt>
            <dd>{latest.is_free ? '無料' : (latest.price_text ?? '-')}</dd>
            <dt>アプリ内購入</dt>
            <dd>{latest.iap_range ?? (latest.offers_iap ? 'あり' : 'なし')}</dd>
            <dt>Android 要件</dt>
            <dd>
              {latest.android_version ?? (
                <span class="muted">Google Play 非公開</span>
              )}
            </dd>
            <dt>カテゴリ</dt>
            <dd>{latest.category ?? '-'}</dd>
            <dt>コンテンツレーティング</dt>
            <dd>{latest.content_rating ?? '-'}</dd>
            <dt>広告</dt>
            <dd>{latest.ad_supported ? 'あり' : latest.ad_supported === 0 ? 'なし' : '-'}</dd>
          </dl>
        )}
        {app.summary ? <p class="small" style="margin-top:12px">{app.summary}</p> : null}
        {screenshots.length > 0 ? (
          <div style="display:flex; gap:8px; overflow-x:auto; margin-top:12px">
            {screenshots.slice(0, 8).map((url) => (
              <img src={url} alt="" height="150" loading="lazy" style="border-radius:6px" />
            ))}
          </div>
        ) : null}
      </div>

      <h2>スナップショット履歴（{countryLabel(country)}）</h2>
      <div class="panel table-wrap">
        {data.snapshots.length === 0 ? (
          <p class="muted">履歴はまだありません。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>日付</th>
                <th>バージョン</th>
                <th>評価</th>
                <th>評価件数</th>
                <th>インストール数</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {data.snapshots.map((s) => (
                <tr>
                  <td class="small">{s.collected_date}</td>
                  <td>{s.version ?? '-'}</td>
                  <td>{s.score != null ? s.score.toFixed(2) : '-'}</td>
                  <td>{s.ratings != null ? s.ratings.toLocaleString('ja-JP') : '-'}</td>
                  <td class="small">{s.installs ?? '-'}</td>
                  <td>{s.unavailable ? <span class="badge danger">取得失敗</span> : <span class="badge ok">OK</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>What's New の履歴（{countryLabel(country)}）</h2>
      <div class="panel">
        {data.whatsNew.length === 0 ? (
          <p class="muted">記録がありません。</p>
        ) : (
          data.whatsNew.map((w) => (
            <div class="review">
              <div class="small muted">
                {w.collected_date} 時点 / バージョン {w.version ?? '-'}
              </div>
              <pre class="analysis">{w.recent_changes}</pre>
            </div>
          ))
        )}
      </div>

      <h2>AI 分析履歴</h2>
      <div class="panel">
        {data.analyses.length === 0 ? (
          <p class="muted">まだ分析結果がありません。</p>
        ) : (
          data.analyses.map((a) => (
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

      <h2>レビュー（{countryLabel(country)}）</h2>
      <div class="panel">
        <p class="muted small">
          保存件数 {data.reviewTotal.toLocaleString('ja-JP')} 件(直近 {data.reviewRetentionDays} 日分のみ保持)
        </p>
        {data.reviews.length === 0 ? (
          <p class="muted">レビューはまだ取得されていません。</p>
        ) : (
          data.reviews.map((r) => (
            <div class="review">
              <div class="small muted">
                ★{r.score ?? '-'} / {formatJst(r.review_date)} / {r.author ?? '匿名'}
                {r.app_version ? ` / v${r.app_version}` : ''}
              </div>
              <div>{r.text ?? ''}</div>
              {r.reply_text ? (
                <div class="small muted" style="margin-top:6px; padding-left:12px; border-left:2px solid var(--border)">
                  返信({formatJst(r.reply_date)}): {r.reply_text}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <h2>取得エラー履歴</h2>
      <div class="panel">
        {data.errorJobs.length === 0 ? (
          <p class="muted">エラーはありません。</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>発生日時</th>
                  <th>種別</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                {data.errorJobs.map((j) => (
                  <tr>
                    <td class="small">{formatJst(j.started_at)}</td>
                    <td class="small">{j.kind}</td>
                    <td class="small">{j.message ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};

function safeParseArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
