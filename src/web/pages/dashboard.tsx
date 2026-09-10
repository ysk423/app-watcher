import type { FC } from 'hono/jsx';
import { countryLabel } from '../../config';
import type { Country } from '../../types';
import { Stat } from '../layout';
import { formatJst } from '../../util/time';

export interface DashboardData {
  activeCount: number;
  pausedCount: number;
  maxApps: number;
  lastCollectAt: string | null;
  lastAnalyzeAt: string | null;
  nextRunAt: string;
  collectErrors: number;
  analyzeErrors: number;
  storageBytes: number | null;
  storageLimitBytes: number;
  todayQueue: { pending: number; running: number; done: number; failed: number; total: number };
  geminiCalls: number;
  geminiLimit: number;
  recentChanges: {
    package_name: string;
    country: Country;
    title: string | null;
    collected_date: string;
    version: string | null;
  }[];
}

export const DashboardPage: FC<{ data: DashboardData }> = ({ data }) => {
  const usage = data.storageBytes != null ? data.storageBytes / data.storageLimitBytes : null;
  const usagePercent = usage != null ? usage * 100 : null;

  return (
    <>
      <div class="grid">
        <Stat label="監視中アプリ" value={`${data.activeCount} / ${data.maxApps}`} note={`停止中 ${data.pausedCount} 件`} />
        <Stat label="最終取得" value={formatJst(data.lastCollectAt)} />
        <Stat label="最終 AI 分析" value={formatJst(data.lastAnalyzeAt)} />
        <Stat label="次回定期実行" value={data.nextRunAt} />
        <Stat label="取得エラー(24時間)" value={String(data.collectErrors)} />
        <Stat label="AI エラー(24時間)" value={String(data.analyzeErrors)} />
      </div>

      <h2>本日の収集キュー</h2>
      <div class="panel">
        {data.todayQueue.total === 0 ? (
          <p class="muted">本日分のキューはまだ作成されていません(開始時刻を過ぎると自動で作成されます)。</p>
        ) : (
          <p>
            完了 {data.todayQueue.done} / 全 {data.todayQueue.total} 件
            <span class="muted small">
              {' '}
              (待機 {data.todayQueue.pending} ・ 実行中 {data.todayQueue.running} ・ 失敗 {data.todayQueue.failed})
            </span>
          </p>
        )}
      </div>

      <h2>リソース使用状況</h2>
      <div class="panel">
        <h3>D1 ストレージ(概算)</h3>
        {usagePercent == null ? (
          <p class="muted">使用量を取得できませんでした。</p>
        ) : (
          <>
            <div class={`bar ${usagePercent >= 95 ? 'danger' : usagePercent >= 70 ? 'warn' : ''}`}>
              <span style={`width: ${Math.min(100, usagePercent).toFixed(1)}%`}></span>
            </div>
            <p class="small">
              {formatBytes(data.storageBytes ?? 0)} / {formatBytes(data.storageLimitBytes)}(
              {usagePercent.toFixed(1)}%)
              {usagePercent >= 95 ? (
                <span class="badge danger"> 危険</span>
              ) : usagePercent >= 85 ? (
                <span class="badge danger"> 強い警告</span>
              ) : usagePercent >= 70 ? (
                <span class="badge warn"> 警告</span>
              ) : null}
            </p>
          </>
        )}

        <h3>本日の Gemini 呼び出し</h3>
        <p class="small">
          {data.geminiCalls} / {data.geminiLimit} 回
          <span class="muted"> (上限に達すると AI 分析はスキップされ、データ収集のみ継続します)</span>
        </p>
      </div>

      <h2>最近の更新・変化</h2>
      <div class="panel">
        {data.recentChanges.length === 0 ? (
          <p class="muted">バージョン変更はまだ記録されていません。</p>
        ) : (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日付</th>
                  <th>アプリ</th>
                  <th>国</th>
                  <th>バージョン</th>
                </tr>
              </thead>
              <tbody>
                {data.recentChanges.map((row) => (
                  <tr>
                    <td class="small">{row.collected_date}</td>
                    <td>
                      <a href={`/apps/${encodeURIComponent(row.package_name)}?country=${row.country}`}>
                        {row.title ?? row.package_name}
                      </a>
                    </td>
                    <td class="small">{countryLabel(row.country)}</td>
                    <td>{row.version ?? '-'}</td>
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}
