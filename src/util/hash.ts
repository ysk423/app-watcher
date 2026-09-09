/**
 * 変更検知用の軽量ハッシュ。
 * 実装ポイント: 説明文やスクリーンショット URL 一覧は容量が大きいので日次スナップショットには本文を持たず、
 * このハッシュだけを保存して「変わったかどうか」を判定する(仕様 6.2 / 18)。
 * 暗号強度は不要なので crypto.subtle(非同期)ではなく同期の FNV-1a を使い CPU 時間を節約する。
 */
export function contentHash(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;

  // FNV-1a を 2 系統回して 64bit 相当の hex にする(衝突確率を実用上無視できる程度に下げる)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
