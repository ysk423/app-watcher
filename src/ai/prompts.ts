import { getApp, listApps } from '../db/apps';
import { listRecentReviewsForAi, reviewSummary } from '../db/reviews';
import {
  computeDiff,
  getLastTwoSnapshots,
  getPeriodEndpoints,
  getSnapshots,
  type PeriodEndpoint,
} from '../db/snapshots';
import { COUNTRIES } from '../config';
import type { Country } from '../types';
import { isoDaysAgo, jstDate } from '../util/time';

/**
 * Gemini へ渡すコンテキストの組み立て。
 *
 * 実装ポイント(仕様 10.4 / 11.2):
 *  * DB 全体を送らない。対象アプリ・期間・差分だけを抽出し、件数と本文長に必ず上限をかける
 *  * レビュー本文は 300 文字で切り、件数も上限を設ける
 */

// 国ごとに添付する件数。国数を掛けた分だけコンテキストが増えるので控えめにする
const MAX_REVIEWS_PER_COUNTRY = 10;
const MAX_REVIEWS_FOR_QA = 15;
const MAX_APPS_IN_QA_CONTEXT = 100;
const ANALYSIS_HISTORY_DAYS = 7;
const QA_PERIOD_DAYS = 90;

export const SYSTEM_INSTRUCTION =
  'あなたは Google Play のアプリ動向を分析するアシスタントです。' +
  '与えられたデータのみを根拠に、日本語で簡潔に回答してください。' +
  'データに無いことは推測せず「データがありません」と述べてください。';

/** アプリ 1 件の日次分析プロンプト(仕様 10.3) */
export async function buildAppAnalysisPrompt(
  db: D1Database,
  packageName: string
): Promise<string | null> {
  const app = await getApp(db, packageName);
  if (!app) return null;

  const lines: string[] = [];
  lines.push(`# 対象アプリ`);
  lines.push(`- アプリ名: ${app.title ?? '不明'}`);
  lines.push(`- パッケージ名: ${app.package_name}`);
  lines.push(`- デベロッパー: ${app.developer ?? '不明'}`);
  lines.push(`- カテゴリ: ${app.category ?? '不明'}`);

  // 実装ポイント: 国ごとに分析を走らせると Gemini の呼び出し回数が国の数だけ増えて
  // 無料枠に触れるため、全対象国のデータを 1 つのプロンプトにまとめて 1 回で分析する(仕様 10.2)
  let hasAnyData = false;

  for (const locale of COUNTRIES) {
    const [snapshots, lastTwo, recent7, recent30, reviews] = await Promise.all([
      getSnapshots(db, packageName, locale.country, ANALYSIS_HISTORY_DAYS + 1),
      getLastTwoSnapshots(db, packageName, locale.country),
      reviewSummary(db, packageName, locale.country, isoDaysAgo(7)),
      reviewSummary(db, packageName, locale.country, isoDaysAgo(30)),
      listRecentReviewsForAi(db, packageName, locale.country, isoDaysAgo(7), MAX_REVIEWS_PER_COUNTRY),
    ]);

    lines.push(`\n# ${locale.label}`);

    if (!lastTwo.current) {
      lines.push('- この国のデータはまだありません');
      continue;
    }
    hasAnyData = true;

    lines.push(`\n## 最新の状態(${lastTwo.current.collected_date})`);
    lines.push(`- バージョン: ${lastTwo.current.version ?? '不明'}`);
    lines.push(`- 評価: ${formatScore(lastTwo.current.score)}`);
    lines.push(`- 評価件数: ${formatCount(lastTwo.current.ratings)}(全世界共通)`);
    lines.push(`- レビュー件数: ${formatCount(lastTwo.current.reviews_count)}(この国のみ)`);
    lines.push(`- インストール数: ${lastTwo.current.installs ?? '不明'}(全世界共通)`);
    if (lastTwo.current.recent_changes) {
      lines.push(`- What's New: ${truncate(lastTwo.current.recent_changes, 400)}`);
    }

    const diffs = computeDiff(lastTwo.current, lastTwo.previous);
    lines.push(`\n## 前回取得との差分`);
    if (diffs.length === 0) {
      lines.push('- 変更なし');
    } else {
      for (const d of diffs) {
        lines.push(d.changedOnly ? `- ${d.label}: 変更あり` : `- ${d.label}: ${d.before} → ${d.after}`);
      }
    }

    lines.push(`\n## 直近 ${ANALYSIS_HISTORY_DAYS} 日の推移`);
    for (const s of snapshots.filter((s) => s.unavailable === 0).reverse()) {
      lines.push(
        `- ${s.collected_date}: 評価 ${formatScore(s.score)} / 評価件数 ${formatCount(s.ratings)} / バージョン ${s.version ?? '-'}`
      );
    }

    lines.push(`\n## レビュー集計`);
    lines.push(`- 直近 7 日: ${recent7.count} 件 / 平均 ${formatScore(recent7.avgScore)}`);
    lines.push(`- 直近 30 日: ${recent30.count} 件 / 平均 ${formatScore(recent30.avgScore)}`);

    if (reviews.length > 0) {
      lines.push(`\n## 直近のレビュー(最大 ${MAX_REVIEWS_PER_COUNTRY} 件)`);
      for (const r of reviews) {
        lines.push(`- [★${r.score ?? '-'} ${r.review_date.slice(0, 10)}] ${truncate(r.text ?? '', 300)}`);
      }
    }
  }

  if (!hasAnyData) return null; // どの国にもデータが無いなら分析しない

  lines.push(
    `\n# 依頼\n上記データだけを根拠に、次の観点で 500 字程度にまとめてください。\n` +
      `1. 直近で何が起きたか(更新・評価・レビューの変化)\n` +
      `2. ユーザーの評判・レビュー傾向\n` +
      `3. 国ごとの違い(評価やレビュー傾向に差があれば、その内容と考えられる理由)\n` +
      `4. 注意すべき変化があればその指摘\n` +
      `評価は国別に集計された値です。評価件数とインストール数は全世界共通の値なので国間で比較しないでください。`
  );

  return lines.join('\n');
}

/** 全アプリ横断の比較・トレンド分析プロンプト(仕様 10.3 のアプリ間比較) */
export async function buildGlobalAnalysisPrompt(db: D1Database): Promise<string | null> {
  const apps = await listApps(db, 'active');
  if (apps.length === 0) return null;

  const endpoints = await getPeriodEndpoints(db, jstDate(new Date(Date.now() - 7 * 86400000)));
  const grouped = groupEndpoints(endpoints);
  const titleByPackage = new Map(apps.map((a) => [a.package_name, a.title ?? a.package_name]));

  const lines: string[] = [];
  lines.push(`# 監視中アプリの直近 7 日の変化(${apps.length} 件)`);

  let hasRow = false;
  // 国ごとに節を分ける。評価は国別集計なので国をまたいで比較できない
  for (const locale of COUNTRIES) {
    const rows: string[] = [];
    for (const app of apps) {
      const pair = grouped.get(endpointKey(app.package_name, locale.country));
      if (!pair?.latest) continue;
      const { latest, oldest } = pair;
      const scoreDelta = delta(oldest?.score ?? null, latest.score);
      const ratingsDelta = delta(oldest?.ratings ?? null, latest.ratings);
      const versionChanged =
        oldest && oldest.version !== latest.version ? `${oldest.version} → ${latest.version}` : 'なし';
      rows.push(
        `- ${titleByPackage.get(app.package_name)}: 評価 ${formatScore(latest.score)}(${scoreDelta})` +
          ` / 評価件数 ${formatCount(latest.ratings)}(${ratingsDelta}) / バージョン変更 ${versionChanged}`
      );
    }
    if (rows.length === 0) continue;
    hasRow = true;
    lines.push(`\n## ${locale.label}`);
    lines.push(...rows);
  }
  if (!hasRow) return null;

  lines.push(
    `\n# 依頼\n上記データだけを根拠に、次を 500 字程度でまとめてください。\n` +
      `1. 全体のトレンド\n` +
      `2. 評価が伸びた/落ちたアプリとその特徴\n` +
      `3. 国による評価の違いが目立つアプリ\n` +
      `4. 目立つ動きのあるアプリ\n` +
      `評価は国別に集計された値です。評価件数は全世界共通なので国間で比較しないでください。`
  );

  return lines.join('\n');
}

/** Web UI の自然言語 Q&A 用プロンプト(仕様 11) */
export async function buildQaPrompt(db: D1Database, question: string): Promise<string> {
  const apps = (await listApps(db)).slice(0, MAX_APPS_IN_QA_CONTEXT);
  const endpoints = await getPeriodEndpoints(db, jstDate(new Date(Date.now() - QA_PERIOD_DAYS * 86400000)));
  const grouped = groupEndpoints(endpoints);

  const lines: string[] = [];
  lines.push(`# 監視中アプリ一覧と直近 ${QA_PERIOD_DAYS} 日の変化`);
  lines.push(`評価は国別に集計された値です。評価件数とインストール数は全世界共通です。`);

  for (const app of apps) {
    lines.push(`- ${app.title ?? app.package_name}(${app.package_name}) 状態:${app.status}`);
    for (const locale of COUNTRIES) {
      const pair = grouped.get(endpointKey(app.package_name, locale.country));
      const latest = pair?.latest;
      const oldest = pair?.oldest;
      if (!latest) {
        lines.push(`  - ${locale.label}: データなし`);
        continue;
      }
      lines.push(
        `  - ${locale.label}: 評価 ${formatScore(latest.score)}(${delta(oldest?.score ?? null, latest.score)})` +
          ` 評価件数 ${formatCount(latest.ratings)}(${delta(oldest?.ratings ?? null, latest.ratings)})` +
          ` バージョン ${latest.version ?? '-'}`
      );
    }
  }

  // 質問文に登場するアプリだけレビュー本文を追加する(全件送らないため。仕様 11.2)
  const mentioned = apps
    .filter((a) => {
      const title = a.title ?? '';
      return question.includes(a.package_name) || (title.length >= 2 && question.includes(title));
    })
    .slice(0, 2);

  for (const app of mentioned) {
    for (const locale of COUNTRIES) {
      const reviews = await listRecentReviewsForAi(
        db,
        app.package_name,
        locale.country,
        isoDaysAgo(30),
        MAX_REVIEWS_PER_COUNTRY
      );
      if (reviews.length === 0) continue;
      lines.push(
        `\n# ${app.title ?? app.package_name} の直近レビュー / ${locale.label}(最大 ${MAX_REVIEWS_PER_COUNTRY} 件)`
      );
      for (const r of reviews) {
        lines.push(`- [★${r.score ?? '-'} ${r.review_date.slice(0, 10)}] ${truncate(r.text ?? '', 300)}`);
      }
    }
  }

  lines.push(`\n# 質問\n${truncate(question, 500)}`);
  lines.push(`\n上記データのみを根拠に、日本語で簡潔に回答してください。`);

  return lines.join('\n');
}

/** `package_name|country` をキーにして、期間の最新と最古をまとめる */
function groupEndpoints(
  rows: PeriodEndpoint[]
): Map<string, { latest: PeriodEndpoint | null; oldest: PeriodEndpoint | null }> {
  const map = new Map<string, { latest: PeriodEndpoint | null; oldest: PeriodEndpoint | null }>();
  for (const row of rows) {
    const key = endpointKey(row.package_name, row.country);
    const entry = map.get(key) ?? { latest: null, oldest: null };
    if (row.is_latest === 1) entry.latest = row;
    else entry.oldest = row;
    map.set(key, entry);
  }
  return map;
}

function endpointKey(packageName: string, country: Country): string {
  return `${packageName}|${country}`;
}

function delta(before: number | null, after: number | null): string {
  if (before == null || after == null) return '変化不明';
  const diff = after - before;
  if (diff === 0) return '±0';
  const formatted = Math.abs(diff) < 1 ? diff.toFixed(2) : Math.round(diff).toLocaleString('ja-JP');
  return diff > 0 ? `+${formatted}` : formatted;
}

function formatScore(score: number | null): string {
  return typeof score === 'number' ? score.toFixed(2) : '-';
}

function formatCount(count: number | null): string {
  return typeof count === 'number' ? count.toLocaleString('ja-JP') : '-';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
