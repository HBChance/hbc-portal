import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
}

function laNow() {
  // Convert "now" to a Date object aligned to America/Los_Angeles by formatting then re-parsing.
  // This is good enough for schedule math without adding libs.
  const s = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  return new Date(s);
}

// Build a LA-local Date for a specific day with hour/min.
function laDateAt(base: Date, hour: number, minute: number) {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Tue 09:30-11:00, Thu 18:00-19:30 (America/Los_Angeles)
function getSessionForNow() {
  const now = laNow();
  const day = now.getDay(); // 0 Sun ... 2 Tue ... 4 Thu

  // Session definitions
  const sessions = [
    { dow: 2, startH: 9, startM: 30, endH: 11, endM: 0 },   // Tue
    { dow: 4, startH: 18, startM: 0, endH: 19, endM: 30 },  // Thu
  ];

  // Find "this week's" occurrences and also next week's, then pick the nearest valid one.
  const candidates: Array<{ start: Date; end: Date }> = [];

  for (const s of sessions) {
    for (const weekOffsetDays of [0, 7]) {
      const base = new Date(now);
      base.setDate(base.getDate() + weekOffsetDays);

      // Move base to the target day of week
      const delta = (s.dow - base.getDay() + 7) % 7;
      base.setDate(base.getDate() + delta);

      const start = laDateAt(base, s.startH, s.startM);
      const end = laDateAt(base, s.endH, s.endM);

      candidates.push({ start, end });
    }
  }

  // Allow check-in window: 60 min before start to 90 min after start
  const OPEN_BEFORE_MIN = 60;
  const CLOSE_AFTER_MIN = 90;

  // 1) Prefer an "active" session window if now is within open/close window
  for (const c of candidates) {
    const opensAt = new Date(c.start.getTime() - OPEN_BEFORE_MIN * 60 * 1000);
    const closesAt = new Date(c.start.getTime() + CLOSE_AFTER_MIN * 60 * 1000);
    if (now >= opensAt && now <= closesAt) {
      return { start: c.start, end: c.end, opensAt, closesAt, mode: "active" as const };
    }
  }

  // 2) Otherwise, pick the next upcoming session (by start time)
  const upcoming = candidates
    .filter((c) => c.start.getTime() > now.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];

  if (!upcoming) return null;

  const opensAt = new Date(upcoming.start.getTime() - OPEN_BEFORE_MIN * 60 * 1000);
  const closesAt = new Date(upcoming.start.getTime() + CLOSE_AFTER_MIN * 60 * 1000);

  return { start: upcoming.start, end: upcoming.end, opensAt, closesAt, mode: "next" as const };
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const expected = process.env.CHECKIN_TOKEN;

  if (!expected) return json(false, { error: "Server misconfigured" }, 500);

  if (!token) {
    return json(false, { error: "MISSING_TOKEN", message: "Missing session QR token." }, 400);
  }
  if (token !== expected) {
    return json(false, { error: "INVALID_TOKEN", message: "Invalid session QR token." }, 400);
  }

  const s = getSessionForNow();
  if (!s) {
    return json(true, {
      hasSession: false,
      message: "No configured sessions found.",
      timeZone: "America/Los_Angeles",
    });
  }

  return json(true, {
    hasSession: true,
    mode: s.mode,
    timeZone: "America/Los_Angeles",
    sessionStart: s.start.toISOString(),
    sessionEnd: s.end.toISOString(),
    opensAt: s.opensAt.toISOString(),
    closesAt: s.closesAt.toISOString(),
  });
}