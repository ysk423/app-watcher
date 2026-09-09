import type { PlayReview } from '../types';
import { unixSecondsToIso } from '../util/time';
import { pick, pickNumber, pickString, sliceBalanced } from './parse-utils';

/**
 * レビュー取得。
 *
 * 実装ポイント: レビューはアプリ詳細ページの HTML には含まれず、
 * Google Play 内部の batchexecute エンドポイント(RPC)に問い合わせる必要がある。
 * このため詳細取得とはまったく別のロジックになっており、
 * ここが壊れても詳細取得側は成功扱いのままにできるよう呼び出し側で分離している(仕様 23)。
 */

const REVIEWS_URL =
  'https://play.google.com/_/PlayStoreUi/data/batchexecute?rpcids=UsvDTd&source-path=%2Fstore%2Fapps%2Fdetails&hl=ja&gl=JP&authuser&soc-app=121&soc-platform=1&soc-device=1&_reqid=1';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;

/** 並び順: 2 = 新着順。新しいレビューだけ取れれば十分なので固定(仕様 7.1) */
const SORT_NEWEST = 2;

export class ReviewFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewFetchError';
  }
}

export async function fetchReviews(packageName: string, count: number): Promise<PlayReview[]> {
  const inner = JSON.stringify([
    null,
    null,
    [2, SORT_NEWEST, [count, null, null], null, []],
    [packageName, 7],
  ]);
  const payload = JSON.stringify([[['UsvDTd', inner, null, 'generic']]]);

  let response: Response;
  try {
    response = await fetch(REVIEWS_URL, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      body: `f.req=${encodeURIComponent(payload)}`,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ReviewFetchError(`レビュー取得に失敗しました: ${(e as Error).message}`);
  }

  if (!response.ok) throw new ReviewFetchError(`レビュー取得で HTTP ${response.status} が返されました`);

  return parseReviewsResponse(await response.text());
}

/** batchexecute のレスポンス本文を解析する(fetch と分離してテストしやすくする) */
export function parseReviewsResponse(body: string): PlayReview[] {
  // 先頭に XSSI 対策のプレフィックスとチャンク長が付くので、最初の配列だけを取り出す
  const start = body.indexOf('[[');
  if (start < 0) return [];
  const envelopeText = sliceBalanced(body, start, '[', ']');
  if (!envelopeText) return [];

  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new ReviewFetchError('レビューのレスポンスを解析できませんでした');
  }
  if (!Array.isArray(envelope)) return [];

  // ["wrb.fr","UsvDTd","<JSON 文字列>",...] の形の要素を探す
  let inner: string | null = null;
  for (const entry of envelope) {
    if (Array.isArray(entry) && entry[0] === 'wrb.fr' && typeof entry[2] === 'string') {
      inner = entry[2];
      break;
    }
  }
  if (!inner) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    throw new ReviewFetchError('レビュー本体の JSON を解析できませんでした');
  }

  const list = pick(parsed, [0]);
  if (!Array.isArray(list)) return [];

  const reviews: PlayReview[] = [];
  for (const item of list) {
    const review = toReview(item);
    if (review) reviews.push(review);
  }
  return reviews;
}

function toReview(item: unknown): PlayReview | null {
  const reviewId = pickString(item, [0]);
  if (!reviewId) return null;

  const reviewDate = unixSecondsToIso(pickNumber(item, [5, 0]));
  if (!reviewDate) return null; // 日付が取れないものは保持期間の判定ができないので捨てる

  return {
    reviewId,
    author: pickString(item, [1, 0]),
    score: pickNumber(item, [2]),
    text: pickString(item, [4]),
    thumbsUp: pickNumber(item, [6]),
    appVersion: pickString(item, [10]),
    reviewDate,
    replyText: pickString(item, [7, 1]),
    replyDate: unixSecondsToIso(pickNumber(item, [7, 2, 0])),
  };
}
