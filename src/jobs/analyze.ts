import { GeminiQuotaError, generateText } from '../ai/gemini';
import { buildAppAnalysisPrompt, buildGlobalAnalysisPrompt, SYSTEM_INSTRUCTION } from '../ai/prompts';
import type { AppConfig } from '../config';
import { setLastAnalyzed } from '../db/apps';
import { saveAnalysis } from '../db/analyses';
import { logJob } from '../db/jobs';
import { setStatus } from '../db/system';
import type { Env } from '../types';
import { isoNow } from '../util/time';
import type { JobResult } from './collect';

/**
 * AI 分析(仕様 10)。
 *
 * 実装ポイント:
 *  * 収集とは独立したジョブなので、分析が失敗しても収集結果はそのまま保持される(仕様 15.2 / 23.2)
 *  * 無料枠・レート制限に達した場合は status='skipped' として記録し、その日の自動再試行は行わない。
 *    再開は Web UI からの手動実行で行う(仕様 10.2)
 */

export async function analyzeApp(
  env: Env,
  config: AppConfig,
  packageName: string,
  trigger: 'cron' | 'manual'
): Promise<JobResult> {
  const startedAt = isoNow();

  const prompt = await buildAppAnalysisPrompt(env.DB, packageName);
  if (!prompt) {
    const message = '分析に必要なデータがまだありません';
    await saveAnalysis(env.DB, {
      scope: 'app',
      packageName,
      analysisType: 'daily',
      status: 'skipped',
      model: config.geminiModel,
      content: null,
      error: message,
    });
    await logJob(env.DB, { kind: 'analyze', trigger, packageName, status: 'skipped', message, startedAt });
    return { ok: true, retryable: false, message };
  }

  return runAnalysis(env, config, {
    scope: 'app',
    packageName,
    analysisType: trigger === 'manual' ? 'manual' : 'daily',
    prompt,
    trigger,
    startedAt,
  });
}

export async function analyzeGlobal(
  env: Env,
  config: AppConfig,
  trigger: 'cron' | 'manual'
): Promise<JobResult> {
  const startedAt = isoNow();

  const prompt = await buildGlobalAnalysisPrompt(env.DB);
  if (!prompt) {
    const message = '比較分析の対象アプリがありません';
    await logJob(env.DB, { kind: 'analyze', trigger, status: 'skipped', message, startedAt });
    return { ok: true, retryable: false, message };
  }

  return runAnalysis(env, config, {
    scope: 'global',
    packageName: null,
    analysisType: 'comparison',
    prompt,
    trigger,
    startedAt,
  });
}

async function runAnalysis(
  env: Env,
  config: AppConfig,
  params: {
    scope: 'app' | 'global';
    packageName: string | null;
    analysisType: string;
    prompt: string;
    trigger: 'cron' | 'manual';
    startedAt: string;
  }
): Promise<JobResult> {
  try {
    const content = await generateText(env, config, params.prompt, {
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    await saveAnalysis(env.DB, {
      scope: params.scope,
      packageName: params.packageName,
      analysisType: params.analysisType,
      status: 'done',
      model: config.geminiModel,
      content,
      error: null,
    });
    if (params.packageName) await setLastAnalyzed(env.DB, params.packageName);
    await setStatus(env.DB, 'last_analyze_at', isoNow());

    await logJob(env.DB, {
      kind: 'analyze',
      trigger: params.trigger,
      packageName: params.packageName,
      status: 'success',
      message: `${params.scope === 'global' ? '全体比較' : 'アプリ'}分析を保存しました`,
      startedAt: params.startedAt,
    });

    return { ok: true, retryable: true, message: '分析を実行しました' };
  } catch (e) {
    const error = e as Error;
    const quota = error instanceof GeminiQuotaError;

    await saveAnalysis(env.DB, {
      scope: params.scope,
      packageName: params.packageName,
      analysisType: params.analysisType,
      // 無料枠超過は「失敗」ではなく「未実施(保留)」として残す
      status: quota ? 'skipped' : 'failed',
      model: config.geminiModel,
      content: null,
      error: error.message,
    });

    await logJob(env.DB, {
      kind: 'analyze',
      trigger: params.trigger,
      packageName: params.packageName,
      status: quota ? 'skipped' : 'error',
      message: error.message,
      startedAt: params.startedAt,
    });

    // 枠切れの場合、その日の自動再試行はしない(叩き続けても無駄なため)
    return { ok: false, retryable: !quota, message: error.message };
  }
}
