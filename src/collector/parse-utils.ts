/**
 * Google Play ページのパース基盤。
 *
 * 実装ポイント:
 *  * Workers では Node 依存のスクレイピングライブラリが動かないため、fetch した HTML を自前で解析する(仕様 5.3)
 *  * アプリ情報はページ内の `AF_initDataCallback({key:'ds:N', ..., data:[...]})` に埋め込まれている
 *  * ds:N のキー番号は Google 側の都合で変わるので、キー決め打ちではなく
 *    「data の形が期待どおりか」で目的のブロックを探す(findInitData の predicate)
 *  * 正規表現だけでは配列の終端を正しく取れない(説明文に括弧が入るため)ので、
 *    文字列リテラルとエスケープを考慮した括弧対応スキャンで切り出す
 */

/** 括弧の対応を取りながら start 位置から 1 つの JSON 値を切り出す */
export function sliceBalanced(src: string, start: number, open: '{' | '[', close: '}' | ']'): string | null {
  if (src[start] !== open) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === '\\') {
        i++; // エスケープされた次の 1 文字は読み飛ばす
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * AF_initDataCallback ブロックを先頭から順に解析し、predicate が true を返した時点で打ち切る。
 * 実装ポイント: 全ブロックを解析すると CPU 時間(無料プラン)を無駄に消費するため、見つかり次第 return する。
 */
export function findInitData(
  html: string,
  predicate: (data: unknown, key: string) => boolean
): unknown | null {
  const marker = 'AF_initDataCallback(';
  let cursor = 0;
  while (true) {
    const idx = html.indexOf(marker, cursor);
    if (idx < 0) return null;
    const objStart = idx + marker.length;
    cursor = objStart;

    const objText = sliceBalanced(html, objStart, '{', '}');
    if (!objText) continue;
    cursor = objStart + objText.length;

    const keyMatch = /key\s*:\s*'([^']+)'/.exec(objText);
    const key = keyMatch ? keyMatch[1] : '';

    const dataIdx = objText.indexOf('data:');
    if (dataIdx < 0) continue;
    const arrStart = objText.indexOf('[', dataIdx);
    if (arrStart < 0) continue;
    const arrText = sliceBalanced(objText, arrStart, '[', ']');
    if (!arrText) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(arrText);
    } catch {
      continue; // 解析できないブロックは無視して次へ
    }
    if (predicate(parsed, key)) return parsed;
  }
}

/** 添字パスをたどって値を取り出す。途中が無ければ null(構造変更で落ちないようにするため) */
export function pick(root: unknown, path: number[]): unknown {
  let current: unknown = root;
  for (const index of path) {
    if (current == null || typeof current !== 'object') return null;
    current = (current as Record<number, unknown>)[index];
  }
  return current ?? null;
}

export function pickString(root: unknown, path: number[]): string | null {
  const v = pick(root, path);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function pickNumber(root: unknown, path: number[]): number | null {
  const v = pick(root, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function pickBoolean(root: unknown, path: number[]): boolean | null {
  const v = pick(root, path);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return null;
}

/** 複数の候補パスを順に試し、最初に取れた文字列を返す(構造変更へのフォールバック) */
export function pickFirstString(root: unknown, paths: number[][]): string | null {
  for (const path of paths) {
    const v = pickString(root, path);
    if (v != null) return v;
  }
  return null;
}

export function pickFirstNumber(root: unknown, paths: number[][]): number | null {
  for (const path of paths) {
    const v = pickNumber(root, path);
    if (v != null) return v;
  }
  return null;
}

/**
 * <script type="application/ld+json"> を取り出す。
 * 実装ポイント: schema.org 構造化データは AF_initDataCallback の添字より変化しにくいので、
 * 主要項目(名前・アイコン・評価・説明)のフォールバックとして使う。
 */
export function extractLdJson(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (item && typeof item === 'object') results.push(item);
      } else if (parsed && typeof parsed === 'object') {
        results.push(parsed);
      }
    } catch {
      // 壊れた JSON は無視する
    }
  }
  return results;
}

/** og:xxx / name=xxx の meta タグを取り出す(最後のフォールバック) */
export function extractMeta(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return decodeHtmlEntities(m[1]);
  }
  return null;
}

/** meta タグ等に含まれる基本的な HTML エンティティを戻す */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Google Play の画像 URL は末尾にサイズ指定が付く。保存時は素の URL に寄せる */
export function normalizeImageUrl(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/=[swh]\d+(-[a-z0-9]+)*$/i, '');
}
