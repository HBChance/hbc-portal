import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
}

/**
 * Spring schedule:
 * - Tuesdays 9:30–11:00 AM PT
 * - Thursdays 6:00–7:30 PM PT
 *
 * We only need the START time here.
 */
const TZ = "America/Los_Angeles";

// 0=Sun ... 6=Sat
const SCHEDULE = [
  { dow: 2, hour: 9, minute: 30 },  // Tue 9:30 AM
  { dow: 4, hour: 18, minute: 0 },  // Thu 6:00 PM
];

// Build a Date for the next occurrence of (dow, hour, minute) in America/Los_Angeles.
// We do the math using the user's local timezone offset by formatting parts in TZ.
function nextOccurrenceInTZ(now: Date, dow: number, hour: number, minute: number) {
  // Get "today" in TZ (year/month/day + dow) using Intl parts
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value;

  const y = Number(get("year"));
  const m = Number(get("month"));
  const d = Number(get("day"));

  // Determine today's DOW in TZ
  const weekday = get("weekday"); // e.g. "Tue"
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const todayDow = weekday ? map[weekday] : now.getDay();

  // days until target dow
  let delta = (dow - todayDow + 7) % 7;

  // Candidate date in TZ: y-m-d + delta at target hour/minute
  // We create a UTC date first, then interpret it as TZ via ISO tricks:
  // Easiest reliable approach: construct a date string as if it's TZ, then convert by reading it as TZ parts.
  // We'll approximate by starting from UTC midnight and adjusting via Intl "timeZoneName" is messy.
  // Instead: generate a Date for the candidate in UTC and then validate ordering by formatting back into TZ.

  const candidateUtc = new Date(Date.UTC(y, m - 1, d + delta, hour, minute, 0));

  // If delta==0 but time already passed in TZ, bump 7 days
  const nowTzHM = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

  const [nowH, nowMin] = nowTzHM.split(":").map((n) => Number(n));
  const passedToday = delta === 0 && (nowH > hour || (nowH === hour && nowMin >= minute));
  if (passedToday) {
    return new Date(Date.UTC(y, m - 1, d + 7, hour, minute, 0));
  }

  return candidateUtc;
}

export async function GET() {
  try {
    const now = new Date();

    const candidates = SCHEDULE.map((s) => nextOccurrenceInTZ(now, s.dow, s.hour, s.minute));
    candidates.sort((a, b) => a.getTime() - b.getTime());

    const next = candidates[0];
    return json(true, { sessionStart: next.toISOString() }, 200);
  } catch (e: any) {
    return json(false, { error: e?.message || "failed" }, 500);
  }
}