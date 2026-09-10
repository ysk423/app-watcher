import type { FC } from 'hono/jsx';
import { COUNTRIES } from '../../config';
import type { AppWithCountries } from '../../types';
import { formatJst } from '../../util/time';
import { StatusBadge } from '../layout';

/**
 * アプリ一覧(仕様 12.1 / 27.2)。
 *
 * 実装ポイント:
 *  * 表示に使う最新値は app_countries に非正規化済みなので、
 *    この画面はスナップショットを 1 行も読まずに描画できる(D1 の読み取り行数対策)
 *  * 評価は国ごとに集計された別の値なので、国の列を分けて並べる(仕様 5.5)
 */
export const AppListPage: FC<{
  apps: AppWithCountries[];
  activeCount: number;
  maxApps: number;
}> = ({ apps, activeCount, maxApps }) => (
  <>
    <p class="muted small">
      監視中 {activeCount} / {maxApps} 件 ・ 評価は国ごとの集計値です
    </p>

    {apps.length === 0 ? (
      <div class="panel">
        <p class="muted">
          まだアプリが登録されていません。<a href="/apps/new">アプリ登録</a>から追加してください。
        </p>
      </div>
    ) : (
      <div class="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>アプリ名 / パッケージ名</th>
              <th>バージョン</th>
              {COUNTRIES.map((c) => (
                <th>{c.label}の評価</th>
              ))}
              <th>評価件数</th>
              <th>更新日</th>
              <th>最終取得</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {apps.map(({ app, countries }) => {
              // バージョン・評価件数・更新日は国によらずほぼ同じなので、取れている国の値を代表として出す
              const anyRow = COUNTRIES.map((c) => countries.get(c.country)).find(
                (r) => r?.latest_collected_date != null
              );
              return (
                <tr>
                  <td>
                    {app.icon_url ? <img class="icon" src={app.icon_url} alt="" loading="lazy" /> : null}
                  </td>
                  <td>
                    <a href={`/apps/${encodeURIComponent(app.package_name)}`}>
                      {app.title ?? app.package_name}
                    </a>
                    <div class="muted small">{app.package_name}</div>
                  </td>
                  <td>{anyRow?.latest_version ?? '-'}</td>
                  {COUNTRIES.map((c) => {
                    const row = countries.get(c.country);
                    return (
                      <td>
                        {row?.latest_score != null ? (
                          row.latest_score.toFixed(2)
                        ) : (
                          <span class="muted">-</span>
                        )}
                      </td>
                    );
                  })}
                  <td>
                    {anyRow?.latest_ratings != null
                      ? anyRow.latest_ratings.toLocaleString('ja-JP')
                      : '-'}
                  </td>
                  <td class="small">
                    {anyRow?.latest_play_updated_at ? anyRow.latest_play_updated_at.slice(0, 10) : '-'}
                  </td>
                  <td class="small">{formatJst(app.last_success_at)}</td>
                  <td>
                    <StatusBadge
                      status={app.status}
                      unavailable={app.unavailable}
                      hasError={app.last_error != null}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </>
);
