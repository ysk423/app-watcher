import { raw } from 'hono/html';
import type { FC, PropsWithChildren } from 'hono/jsx';

/**
 * 共通レイアウト。
 * 実装ポイント: SPA / クライアントサイド JS フレームワークは使わず SSR のみで構成する(仕様 12)。
 * CSS はインライン 1 枚に収め、外部リソースへの依存をなくして表示を軽くしている。
 */

const CSS = `
:root {
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #1f2328;
  --muted: #656d76;
  --border: #d8dee4;
  --accent: #2563eb;
  --ok: #1a7f37;
  --warn: #9a6700;
  --danger: #cf222e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a;
    --panel: #1c2024;
    --text: #e6edf3;
    --muted: #9198a1;
    --border: #30363d;
    --accent: #4c8dff;
    --ok: #3fb950;
    --warn: #d29922;
    --danger: #f85149;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", Meiryo, sans-serif;
  font-size: 14px;
  line-height: 1.6;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.site {
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  padding: 12px 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
}
header.site .brand { font-weight: 700; font-size: 15px; }
header.site nav { display: flex; flex-wrap: wrap; gap: 14px; }
main { max-width: 1080px; margin: 0 auto; padding: 20px; }
h1 { font-size: 20px; margin: 0 0 16px; }
h2 { font-size: 16px; margin: 24px 0 10px; }
h3 { font-size: 14px; margin: 18px 0 8px; }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.stat .label { color: var(--muted); font-size: 12px; }
.stat .value { font-size: 20px; font-weight: 600; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: 12px; }
.table-wrap { overflow-x: auto; }
.icon { width: 32px; height: 32px; border-radius: 7px; vertical-align: middle; }
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; border: 1px solid var(--border); color: var(--muted);
}
.badge.ok { color: var(--ok); border-color: var(--ok); }
.badge.warn { color: var(--warn); border-color: var(--warn); }
.badge.danger { color: var(--danger); border-color: var(--danger); }
.muted { color: var(--muted); }
.small { font-size: 12px; }
button, .button {
  font: inherit; cursor: pointer; padding: 6px 12px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--panel); color: var(--text);
}
button:hover, .button:hover { border-color: var(--accent); text-decoration: none; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { border-color: var(--danger); color: var(--danger); }
input[type=text], input[type=search], textarea, select {
  font: inherit; width: 100%; padding: 7px 10px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
textarea { min-height: 90px; resize: vertical; }
form.inline { display: inline; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.notice { border-left: 3px solid var(--accent); padding: 8px 12px; background: var(--panel); border-radius: 0 6px 6px 0; margin-bottom: 16px; }
.notice.error { border-left-color: var(--danger); }
.diff { font-variant-numeric: tabular-nums; }
.diff .from { color: var(--muted); }
.diff .to { font-weight: 600; }
.bar { height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; }
.bar > span { display: block; height: 100%; background: var(--accent); }
.bar.warn > span { background: var(--warn); }
.bar.danger > span { background: var(--danger); }
pre.analysis { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; }
.review { border-bottom: 1px solid var(--border); padding: 10px 0; }
.review:last-child { border-bottom: none; }
dl.kv { display: grid; grid-template-columns: minmax(120px, 200px) 1fr; gap: 6px 16px; margin: 0; }
dl.kv dt { color: var(--muted); }
dl.kv dd { margin: 0; word-break: break-word; }
footer.site { color: var(--muted); font-size: 12px; text-align: center; padding: 24px 0; }
`;

export const Layout: FC<PropsWithChildren<{ title: string; message?: string | null; error?: string | null }>> = ({
  title,
  message,
  error,
  children,
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`${title} | App Watcher`}</title>
      <style>{raw(CSS)}</style>
    </head>
    <body>
      <header class="site">
        <span class="brand">Google Play App Watcher</span>
        <nav>
          <a href="/">ダッシュボード</a>
          <a href="/apps">アプリ一覧</a>
          <a href="/apps/new">アプリ登録</a>
          <a href="/qa">AI Q&amp;A</a>
          <a href="/jobs">実行履歴</a>
          <a href="/settings">設定</a>
        </nav>
      </header>
      <main>
        {message ? <div class="notice">{message}</div> : null}
        {error ? <div class="notice error">{error}</div> : null}
        <h1>{title}</h1>
        {children}
      </main>
      <footer class="site">Cloudflare Workers + D1 / 無料プラン内で運用</footer>
    </body>
  </html>
);

/** 監視状態・エラー状態のバッジ表示(仕様 12.1) */
export const StatusBadge: FC<{ status: string; unavailable?: number; hasError?: boolean }> = ({
  status,
  unavailable,
  hasError,
}) => {
  if (unavailable) return <span class="badge danger">取得できません</span>;
  if (hasError) return <span class="badge warn">エラーあり</span>;
  if (status === 'paused') return <span class="badge">停止中</span>;
  return <span class="badge ok">監視中</span>;
};

export const Stat: FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div class="stat">
    <div class="label">{label}</div>
    <div class="value">{value}</div>
    {note ? <div class="small muted">{note}</div> : null}
  </div>
);
