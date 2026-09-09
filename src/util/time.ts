/**
 * 日時ユーティリティ。
 * 実装ポイント: Workers のランタイムは常に UTC で動くため、
 * 「その日の収集が済んだか」の判定に使う日付は必ず JST に変換してから求める(仕様 5.1)。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 現在時刻(UTC)を ISO8601 で返す。DB に入れる時刻は常にこれを使う */
export function isoNow(): string {
  return new Date().toISOString();
}

/** JST に平行移動した Date(getUTC* 系で JST の値を読むためのもの) */
function toJst(date: Date): Date {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

/** JST での YYYY-MM-DD */
export function jstDate(date: Date = new Date()): string {
  return toJst(date).toISOString().slice(0, 10);
}

/** JST での HH:MM */
export function jstTime(date: Date = new Date()): string {
  return toJst(date).toISOString().slice(11, 16);
}

/** JST での "YYYY-MM-DD HH:MM" 表示。null はそのまま "-" にする */
export function formatJst(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const j = toJst(d);
  return `${j.toISOString().slice(0, 10)} ${j.toISOString().slice(11, 16)}`;
}

/** n 日前の時刻(UTC ISO)。保持期間の判定に使う */
export function isoDaysAgo(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** "HH:MM" 形式の時刻を分に変換する。パースできない場合は既定値を返す */
export function parseHhMm(value: string | undefined, fallbackMinutes: number): number {
  if (!value) return fallbackMinutes;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallbackMinutes;
  return h * 60 + min;
}

/** JST の 0 時からの経過分 */
export function jstMinutesOfDay(date: Date = new Date()): number {
  const j = toJst(date);
  return j.getUTCHours() * 60 + j.getUTCMinutes();
}

/**
 * 次回の日次収集開始時刻(JST 表示)を求める。
 * すでに本日の開始時刻を過ぎていれば翌日の同時刻を返す。
 */
export function nextRunAtJst(startMinutes: number, now: Date = new Date()): string {
  const base = toJst(now);
  const nowMinutes = base.getUTCHours() * 60 + base.getUTCMinutes();
  const target = new Date(base);
  if (nowMinutes >= startMinutes) target.setUTCDate(target.getUTCDate() + 1);
  const hh = String(Math.floor(startMinutes / 60)).padStart(2, '0');
  const mm = String(startMinutes % 60).padStart(2, '0');
  return `${target.toISOString().slice(0, 10)} ${hh}:${mm}`;
}

/** Unix 秒 → ISO8601。Google Play のタイムスタンプ変換用 */
export function unixSecondsToIso(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}
