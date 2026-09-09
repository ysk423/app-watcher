import type { AppConfig } from '../config';
import { getGeminiCallCount, incrementGeminiCallCount } from '../db/system';
import type { Env } from '../types';

/**
 * Gemini API クライアント。
 *
 * 実装ポイント(仕様 10.2 の「課金防止」):
 *  * 呼び出し前に D1 の日次カウンタを見て、上限を超えていたら API を叩かずに QuotaError を投げる
 *  * 429 / RESOURCE_EXHAUSTED も QuotaError として扱い、呼び出し側で「失敗」ではなく
 *    「スキップ(後で再実行可能)」として記録する。有料枠へ自動的に移行する処理は一切持たない
 */

/** 無料枠・レート制限に達した状態。分析は延期し、収集は止めない */
export class GeminiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiQuotaError';
  }
}

/** API キー未設定・応答不正などの通常エラー */
export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 30_000;

export interface GenerateOptions {
  systemInstruction?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export async function generateText(
  env: Env,
  config: AppConfig,
  prompt: string,
  options: GenerateOptions = {}
): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new GeminiError('GEMINI_API_KEY が設定されていません(wrangler secret put で登録してください)');
  }

  // 自前の上限に達していたら API を呼ばない
  const used = await getGeminiCallCount(env.DB);
  if (used >= config.geminiDailyLimit) {
    throw new GeminiQuotaError(
      `本日の Gemini 呼び出し上限(${config.geminiDailyLimit} 回)に達したため実行をスキップしました`
    );
  }
  await incrementGeminiCallCount(env.DB);

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxOutputTokens ?? 1200,
    },
  };
  if (options.systemInstruction) {
    body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
  }

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT_BASE}/${encodeURIComponent(config.geminiModel)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API キーは URL ではなくヘッダで渡す(ログに残さないため)
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GeminiError(`Gemini API への接続に失敗しました: ${(e as Error).message}`);
  }

  if (response.status === 429) {
    throw new GeminiQuotaError('Gemini API のレート制限に達しました(無料枠超過の可能性があります)');
  }

  const raw = await response.text();
  if (!response.ok) {
    const message = extractErrorMessage(raw) ?? `HTTP ${response.status}`;
    // 無料枠の枯渇はメッセージで判別し、課金に移行せずスキップ扱いにする
    if (/quota|RESOURCE_EXHAUSTED|rate limit/i.test(message)) {
      throw new GeminiQuotaError(`Gemini API の利用枠に達しました: ${message}`);
    }
    throw new GeminiError(`Gemini API がエラーを返しました: ${message}`);
  }

  const text = extractText(raw);
  if (!text) throw new GeminiError('Gemini API の応答に本文が含まれていませんでした');
  return text;
}

function extractText(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function extractErrorMessage(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { error?: { message?: string; status?: string } };
    return data.error?.message ?? data.error?.status ?? null;
  } catch {
    return raw.slice(0, 200);
  }
}
