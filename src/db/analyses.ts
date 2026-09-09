import type { AiAnalysis } from '../types';
import { isoNow, jstDate } from '../util/time';

export interface SaveAnalysisInput {
  runDate?: string;
  scope: 'app' | 'global';
  packageName: string | null;
  analysisType: string;
  status: 'done' | 'failed' | 'skipped';
  model: string | null;
  content: string | null;
  error: string | null;
}

/**
 * AI 分析結果を保存する。
 * 実装ポイント: 無料枠超過などで実施できなかった場合も status='skipped' として行を残し、
 * 「未実施・保留」であることを後から確認・再実行できるようにする(仕様 10.2 / 23.2)。
 */
export async function saveAnalysis(db: D1Database, input: SaveAnalysisInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_analyses (run_date, scope, package_name, analysis_type, status, model, content, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.runDate ?? jstDate(),
      input.scope,
      input.packageName,
      input.analysisType,
      input.status,
      input.model,
      input.content,
      input.error ? input.error.slice(0, 500) : null,
      isoNow()
    )
    .run();
}

export async function listAnalysesForApp(
  db: D1Database,
  packageName: string,
  limit: number
): Promise<AiAnalysis[]> {
  const { results } = await db
    .prepare('SELECT * FROM ai_analyses WHERE package_name = ? ORDER BY created_at DESC LIMIT ?')
    .bind(packageName, limit)
    .all<AiAnalysis>();
  return results ?? [];
}

export async function listGlobalAnalyses(db: D1Database, limit: number): Promise<AiAnalysis[]> {
  const { results } = await db
    .prepare("SELECT * FROM ai_analyses WHERE scope = 'global' ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<AiAnalysis>();
  return results ?? [];
}

export async function getLatestAnalysisAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT created_at FROM ai_analyses WHERE status = 'done' ORDER BY created_at DESC LIMIT 1")
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

export async function countFailedAnalysesSince(db: D1Database, sinceIso: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM ai_analyses WHERE status <> 'done' AND created_at >= ?")
    .bind(sinceIso)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/** 古い分析結果を間引く(仕様 20 の「無制限に増やさない」に対応) */
export async function pruneOldAnalyses(db: D1Database, keepPerApp: number): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM ai_analyses WHERE id NOT IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(package_name, '__global__') ORDER BY created_at DESC
           ) AS rn FROM ai_analyses
         ) WHERE rn <= ?
       )`
    )
    .bind(keepPerApp)
    .run();
  return result.meta.changes ?? 0;
}
