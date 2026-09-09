import type { FC } from 'hono/jsx';
import type { MonitoredApp } from '../../types';
import { formatJst } from '../../util/time';
import { StatusBadge } from '../layout';

/**
 * アプリ一覧(仕様 12.1 / 27.2)。
 * 実装ポイント: 表示に使う最新値は monitored_apps に非正規化済みなので、
 * この画面はスナップショットを 1 行も読まずに描画できる(D1 の読み取り行数対策)。
 */
export const AppListPage: FC<{ apps: MonitoredApp[]; activeCount: number; maxApps: number }> = ({
  apps,
  activeCount,
  maxApps,
}) => (
  <>
    <p class="muted small">
      監視中 {activeCount} / {maxApps} 件
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
              <th>評価</th>
              <th>レビュー件数</th>
              <th>更新日</th>
              <th>最終取得</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr>
                <td>{app.icon_url ? <img class="icon" src={app.icon_url} alt="" loading="lazy" /> : null}</td>
                <td>
                  <a href={`/apps/${encodeURIComponent(app.package_name)}`}>{app.title ?? app.package_name}</a>
                  <div class="muted small">{app.package_name}</div>
                </td>
                <td>{app.latest_version ?? '-'}</td>
                <td>{app.latest_score != null ? app.latest_score.toFixed(2) : '-'}</td>
                <td>{app.latest_ratings != null ? app.latest_ratings.toLocaleString('ja-JP') : '-'}</td>
                <td class="small">
                  {app.latest_play_updated_at ? app.latest_play_updated_at.slice(0, 10) : '-'}
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
            ))}
          </tbody>
        </table>
      </div>
    )}
  </>
);
