import type { CountryConfig, PlayAppDetail } from '../types';
import { unixSecondsToIso } from '../util/time';
import {
  extractLdJson,
  extractMeta,
  findInitData,
  normalizeImageUrl,
  pick,
  pickFirstNumber,
  pickFirstString,
  pickNumber,
  pickString,
} from './parse-utils';

/** Google Play 上にアプリが存在しない(404)ことを表す。監視は継続し自動削除しない(仕様 13.3) */
export class AppNotFoundError extends Error {
  constructor(packageName: string) {
    super(`Google Play にアプリが見つかりません: ${packageName}`);
    this.name = 'AppNotFoundError';
  }
}

export class PlayFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayFetchError';
  }
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15_000;

/**
 * AF_initDataCallback の添字マップ。
 * 実装ポイント: Google 側の変更で位置がずれることがあるため、
 * 各項目を「候補パスの配列」として持ち、先に取れたものを採用する(仕様 5.3 の保守性要件)。
 */
const PATHS = {
  title: [[1, 2, 0, 0]],
  description: [[1, 2, 72, 0, 1]],
  summary: [[1, 2, 73, 0, 1]],
  installs: [[1, 2, 13, 0]],
  minInstalls: [[1, 2, 13, 1]],
  score: [[1, 2, 51, 0, 1]],
  ratings: [[1, 2, 51, 2, 1]],
  reviewsCount: [[1, 2, 51, 3, 1]],
  priceMicros: [[1, 2, 57, 0, 0, 0, 0, 1, 0, 0]],
  currency: [[1, 2, 57, 0, 0, 0, 0, 1, 0, 1]],
  priceText: [[1, 2, 57, 0, 0, 0, 0, 1, 0, 2]],
  iapRange: [[1, 2, 19, 0]],
  androidVersion: [
    [1, 2, 140, 1, 1, 0, 0, 1],
    [1, 2, 140, 1, 1, 0, 0, 0],
  ],
  developer: [[1, 2, 68, 0]],
  developerId: [[1, 2, 68, 1, 4, 2]],
  developerEmail: [[1, 2, 69, 1, 0]],
  developerWebsite: [[1, 2, 69, 0, 5, 2]],
  privacyPolicy: [[1, 2, 99, 0, 5, 2]],
  category: [[1, 2, 79, 0, 0, 0]],
  icon: [[1, 2, 95, 0, 3, 2]],
  headerImage: [[1, 2, 96, 0, 3, 2]],
  contentRating: [[1, 2, 9, 0]],
  released: [[1, 2, 10, 0]],
  version: [
    [1, 2, 140, 0, 0, 0],
    [1, 2, 140, 0, 0],
  ],
  updatedSeconds: [[1, 2, 145, 0, 1, 0]],
  recentChanges: [
    [1, 2, 144, 1, 1],
    [1, 2, 144, 1, 0],
  ],
} as const;

/**
 * Google Play のアプリ詳細ページを取得して解析する。
 *
 * 実装ポイント: hl(表示言語)と gl(国)で内容が変わる。評価・レビュー件数・
 * コンテンツレーティング・通貨・説明文はいずれも国別の値になるため、
 * 呼び出し側は対象国ごとにこの関数を呼ぶ(仕様 5.5)。
 */
export async function fetchAppDetail(
  packageName: string,
  locale: CountryConfig
): Promise<PlayAppDetail> {
  const url =
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}` +
    `&hl=${encodeURIComponent(locale.hl)}&gl=${encodeURIComponent(locale.gl)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': `${locale.hl},en;q=0.8`,
        Accept: 'text/html,application/xhtml+xml',
      },
      // 1 アプリの通信失敗で全体を止めないためのタイムアウト(仕様 23.3)
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PlayFetchError(`取得に失敗しました: ${(e as Error).message}`);
  }

  if (response.status === 404) throw new AppNotFoundError(packageName);
  if (!response.ok) throw new PlayFetchError(`HTTP ${response.status} が返されました`);

  const html = await response.text();
  return parseAppDetail(packageName, html);
}

/** HTML から PlayAppDetail を組み立てる(単体テストしやすいよう fetch と分離) */
export function parseAppDetail(packageName: string, html: string): PlayAppDetail {
  // 目的のブロックはキー番号ではなく「data の形」で特定する
  const data = findInitData(html, (d) => {
    const title = pickString(d, [1, 2, 0, 0]);
    return title != null && Array.isArray(pick(d, [1, 2]));
  });

  const ld = findSoftwareApplicationLd(html);

  if (!data && !ld) {
    // どちらの経路でも読めない場合は「取得失敗」として扱い、既存データは残す(仕様 5.4)
    throw new PlayFetchError('アプリ情報を解析できませんでした(ページ構造が変わった可能性があります)');
  }

  const priceMicros = pickFirstNumber(data, PATHS.priceMicros as unknown as number[][]);
  const ldPrice = readLdPrice(ld);

  const screenshotUrls = extractScreenshots(data);
  const iapRange = pickFirstString(data, PATHS.iapRange as unknown as number[][]);

  // 実装ポイント: 現在の Google Play はほとんどのアプリでバージョンを公開していない。
  // ここで取れなければ収集側でレビューの申告バージョンから補完する(collect.ts)。
  const version =
    pickFirstString(data, PATHS.version as unknown as number[][]) ?? asString(ld?.softwareVersion);

  const title =
    pickFirstString(data, PATHS.title as unknown as number[][]) ??
    asString(ld?.name) ??
    extractMeta(html, 'og:title');

  const description =
    pickFirstString(data, PATHS.description as unknown as number[][]) ??
    asString(ld?.description) ??
    extractMeta(html, 'og:description');

  const iconUrl =
    normalizeImageUrl(pickFirstString(data, PATHS.icon as unknown as number[][])) ??
    normalizeImageUrl(asString(ld?.image)) ??
    normalizeImageUrl(extractMeta(html, 'og:image'));

  const score =
    pickFirstNumber(data, PATHS.score as unknown as number[][]) ?? readLdNumber(ld, 'ratingValue');
  const ratings =
    pickFirstNumber(data, PATHS.ratings as unknown as number[][]) ?? readLdNumber(ld, 'ratingCount');

  return {
    packageName,
    title,
    developer:
      pickFirstString(data, PATHS.developer as unknown as number[][]) ??
      asString((ld?.author as Record<string, unknown> | undefined)?.name),
    developerId: pickFirstString(data, PATHS.developerId as unknown as number[][]),
    developerEmail: pickFirstString(data, PATHS.developerEmail as unknown as number[][]),
    developerWebsite: pickFirstString(data, PATHS.developerWebsite as unknown as number[][]),
    privacyPolicy: pickFirstString(data, PATHS.privacyPolicy as unknown as number[][]),
    iconUrl,
    headerImageUrl: normalizeImageUrl(pickFirstString(data, PATHS.headerImage as unknown as number[][])),
    screenshotUrls,
    category:
      pickFirstString(data, PATHS.category as unknown as number[][]) ??
      asString(ld?.applicationCategory),
    summary: pickFirstString(data, PATHS.summary as unknown as number[][]),
    description,
    score,
    ratings,
    reviewsCount: pickFirstNumber(data, PATHS.reviewsCount as unknown as number[][]),
    installs: pickFirstString(data, PATHS.installs as unknown as number[][]),
    minInstalls: pickFirstNumber(data, PATHS.minInstalls as unknown as number[][]),
    version,
    versionSource: version ? 'play' : null,
    playUpdatedAt: unixSecondsToIso(pickFirstNumber(data, PATHS.updatedSeconds as unknown as number[][])),
    recentChanges: cleanupHtmlText(pickFirstString(data, PATHS.recentChanges as unknown as number[][])),
    priceText: pickFirstString(data, PATHS.priceText as unknown as number[][]) ?? ldPrice.text,
    priceMicros,
    currency: pickFirstString(data, PATHS.currency as unknown as number[][]) ?? ldPrice.currency,
    isFree: priceMicros != null ? priceMicros === 0 : ldPrice.isFree,
    offersIap: iapRange != null ? true : null,
    iapRange,
    androidVersion: pickFirstString(data, PATHS.androidVersion as unknown as number[][]),
    contentRating: pickFirstString(data, PATHS.contentRating as unknown as number[][]) ?? asString(ld?.contentRating),
    // 「広告が表示されます」のラベルが入っていれば広告あり。無い場合は広告なしとみなす
    adSupported: pickString(data, [1, 2, 48, 0]) != null,
    released: pickFirstString(data, PATHS.released as unknown as number[][]),
  };
}

/** スクリーンショット URL は配列の各要素から取り出す。画像自体は保存しない(仕様 8) */
function extractScreenshots(data: unknown): string[] {
  const list = pick(data, [1, 2, 78, 0]);
  if (!Array.isArray(list)) return [];
  const urls: string[] = [];
  for (const item of list) {
    const url = normalizeImageUrl(pickString(item, [3, 2]));
    if (url) urls.push(url);
  }
  return urls;
}

function findSoftwareApplicationLd(html: string): Record<string, unknown> | null {
  for (const item of extractLdJson(html)) {
    const type = item['@type'];
    if (type === 'SoftwareApplication' || type === 'MobileApplication') return item;
  }
  return null;
}

function readLdNumber(ld: Record<string, unknown> | null, key: string): number | null {
  const rating = ld?.aggregateRating as Record<string, unknown> | undefined;
  const raw = rating?.[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readLdPrice(ld: Record<string, unknown> | null): {
  text: string | null;
  currency: string | null;
  isFree: boolean | null;
} {
  const offersRaw = ld?.offers;
  const offer = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw;
  if (!offer || typeof offer !== 'object') return { text: null, currency: null, isFree: null };
  const o = offer as Record<string, unknown>;
  const price = o.price;
  const currency = asString(o.priceCurrency);
  const numeric = typeof price === 'number' ? price : typeof price === 'string' ? Number(price) : null;
  return {
    text: price != null ? String(price) : null,
    currency,
    isFree: numeric != null && Number.isFinite(numeric) ? numeric === 0 : null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What's New には <br> が含まれるので素のテキストに寄せる */
function cleanupHtmlText(value: string | null): string | null {
  if (!value) return null;
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}
