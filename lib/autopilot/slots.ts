// Posting slots in the autopilot's local time zone. A day's slots start at window_start and repeat
// every max(frequency, min_gap) minutes while <= window_end, at most daily_cap per day.

export interface SlotConfig {
  timezone: string;
  window_start: string; // "HH:MM"
  window_end: string; // "HH:MM"
  frequency_minutes: number;
  min_gap_minutes: number;
  daily_cap: number;
}

interface LocalParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, tz: string): LocalParts & { ss: number } {
  const parts = Object.fromEntries(fmt(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, hh: +parts.hour % 24, mm: +parts.minute, ss: +parts.second };
}

/** Offset of `tz` from UTC at `date`, in ms (Asia/Dhaka -> +6h). */
function tzOffsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` shows y-m-d hh:mm. */
export function zonedToUtc(p: LocalParts, tz: string): Date {
  const guess = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  // Second pass fixes the guess when a DST change lies between guess and result.
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}

export function parseHm(s: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hh = +m[1];
  const mm = +m[2];
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** Local calendar day key "YYYY-MM-DD" of `date` in `tz`. */
export function localDayKey(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** [start, end) UTC instants of the local day containing `date`. */
export function localDayBounds(date: Date, tz: string): { start: Date; end: Date } {
  const p = localParts(date, tz);
  const start = zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: 0, mm: 0 }, tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  const end = zonedToUtc({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate(), hh: 0, mm: 0 }, tz);
  return { start, end };
}

/** All slots (UTC) of the local day containing `date`. */
export function slotsForDay(date: Date, c: SlotConfig): Date[] {
  const tz = isValidTimeZone(c.timezone) ? c.timezone : "UTC";
  const ws = parseHm(c.window_start) ?? { hh: 8, mm: 0 };
  const we = parseHm(c.window_end) ?? { hh: 23, mm: 0 };
  const startMin = ws.hh * 60 + ws.mm;
  const endMin = we.hh * 60 + we.mm;
  const step = Math.max(15, c.frequency_minutes, c.min_gap_minutes);
  const p = localParts(date, tz);
  const out: Date[] = [];
  for (let m = startMin; m <= endMin && out.length < Math.max(0, c.daily_cap); m += step) {
    out.push(zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: Math.floor(m / 60), mm: m % 60 }, tz));
  }
  return out;
}

/** Slots from the local day of `from` for `days` days, ascending. */
export function upcomingSlots(from: Date, c: SlotConfig, days = 8): Date[] {
  const out: Date[] = [];
  const tz = isValidTimeZone(c.timezone) ? c.timezone : "UTC";
  const p = localParts(from, tz);
  for (let i = 0; i < days; i++) {
    const noon = zonedToUtc({ y: p.y, m: p.m, d: p.d, hh: 12, mm: 0 }, tz);
    const day = new Date(noon.getTime() + i * 86_400_000);
    out.push(...slotsForDay(day, c));
  }
  return out;
}

/** Generate a draft for slot S once now >= S - LEAD; give up on a slot GRACE after it. */
export const GENERATION_LEAD_MS = 20 * 60_000;

/**
 * The slot to generate for right now, or null. A slot is open when we're within its generation
 * window and no draft was made for it yet (`usedSlots` = ISO slot_at of existing drafts).
 */
export function openSlot(now: Date, c: SlotConfig, usedSlots: Set<string>): Date | null {
  const grace = Math.max(15, Math.min(c.frequency_minutes, 120)) * 60_000 / 2;
  for (const s of upcomingSlots(new Date(now.getTime() - 86_400_000), c, 3)) {
    const t = s.getTime();
    if (now.getTime() < t - GENERATION_LEAD_MS) break;
    if (now.getTime() > t + grace) continue;
    if (!usedSlots.has(s.toISOString())) return s;
  }
  return null;
}

/**
 * First slot >= `earliest` that keeps `min_gap_minutes` from every time in `taken` and whose local
 * day has fewer than daily_cap taken posts. Used when an approved draft is sent to the queue.
 */
export function nextFreeSlot(earliest: Date, c: SlotConfig, taken: Date[]): Date | null {
  const tz = isValidTimeZone(c.timezone) ? c.timezone : "UTC";
  const gap = Math.max(0, c.min_gap_minutes) * 60_000;
  const perDay = new Map<string, number>();
  for (const t of taken) perDay.set(localDayKey(t, tz), (perDay.get(localDayKey(t, tz)) ?? 0) + 1);
  for (const s of upcomingSlots(earliest, c, 8)) {
    if (s.getTime() < earliest.getTime()) continue;
    if ((perDay.get(localDayKey(s, tz)) ?? 0) >= c.daily_cap) continue;
    if (taken.some((t) => Math.abs(t.getTime() - s.getTime()) < gap)) continue;
    return s;
  }
  return null;
}
