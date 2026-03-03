import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Slot = { weekday: number; hour: number; minute: number; label: string };

// Tue = 2, Thu = 4 when using Intl weekday strings; we’ll map using names below.
const SLOTS: Slot[] = [
  { weekday: 2, hour: 9, minute: 30, label: "Tuesday 9:30 AM" },   // Tue 9:30
  { weekday: 4, hour: 18, minute: 0, label: "Thursday 6:00 PM" },  // Thu 6:00 PM
];

const TZ = "America/Los_Angeles";

// Window rules (match your production intent)
const CHECKIN_OPENS_MINUTES = 60;
const CHECKIN_CLOSES_MINUTES = 150;

function json(ok: boolean, payload: any, status = 200) {
  return NextResponse.json({ ok, ...payload }, { status });
}

// Get LA-local parts for a Date
function getLaParts(d: Date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = dtf.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;

  const weekday = get("weekday")!; // e.g., "Tue"
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));

  return { weekday, year, month, day, hour, minute, second };
}

// Convert LA-local Y/M/D h:m into a real UTC Date that represents that instant.
function laLocalToUtcDate(year: number, month: number, day: number, hour: number, minute: number) {
  // Start with a naive UTC date for those components
  const guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // Figure out what LA thinks the time is at that UTC instant
  const la = getLaParts(guessUtc);

  // Compute minute delta between intended LA local time and actual LA local time of guessUtc
  const intended = Date.UTC(year, month - 1, day, hour, minute, 0);
  const actual = Date.UTC(la.year, la.month - 1, la.day, la.hour, la.minute, 0);

  const diffMs = actual - intended;

  // Adjust guess by that diff to land on the intended LA local instant
  return new Date(guessUtc.getTime() - diffMs);
}

function weekdayShortToNum(w: string) {
  // Sun=0..Sat=6
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

function formatLaLabel(iso: string) {
  const d = new Date(iso);
  const label = d.toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${label} (America/Los_Angeles)`;
}

/**
 * Returns the current active sessionStart if we're within the window
 * [start - 60m, start + 150m], otherwise returns the next upcoming sessionStart.
 */
function computeCurrentOrNextSessionStart(now = new Date()) {
  const laNow = getLaParts(now);
  const nowWeekdayNum = weekdayShortToNum(laNow.weekday);
  const nowMinutes = laNow.hour * 60 + laNow.minute;

  const candidates: Date[] = [];

  for (const slot of SLOTS) {
    let deltaDays = (slot.weekday - nowWeekdayNum + 7) % 7;

    if (deltaDays === 0) {
      const slotMinutes = slot.hour * 60 + slot.minute;

      const opensAt = slotMinutes - CHECKIN_OPENS_MINUTES;
      const closesAt = slotMinutes + CHECKIN_CLOSES_MINUTES;

      // If we're inside the session's live window, treat "today" as the correct session
      if (nowMinutes >= opensAt && nowMinutes <= closesAt) {
        deltaDays = 0;
      } else {
        // otherwise keep old behavior: if start has passed, push to next week
        if (slotMinutes <= nowMinutes) deltaDays = 7;
      }
    }

    // Build LA-local date for the candidate day
    const base = laLocalToUtcDate(laNow.year, laNow.month, laNow.day, 0, 0);
    const candidateDayUtc = new Date(base.getTime() + deltaDays * 24 * 60 * 60 * 1000);

    // Get LA-local Y/M/D for that candidate day, then set slot time
    const laCandidate = getLaParts(candidateDayUtc);

    const candidateStartUtc = laLocalToUtcDate(
      laCandidate.year,
      laCandidate.month,
      laCandidate.day,
      slot.hour,
      slot.minute
    );

    candidates.push(candidateStartUtc);
  }

  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0].toISOString();
}

export async function GET() {
  try {
    const sessionStart = computeCurrentOrNextSessionStart(new Date());
    return json(true, {
      sessionStart,
      sessionLabel: formatLaLabel(sessionStart),
    });
  } catch (e: any) {
    return json(false, { error: e?.message || "Failed to compute current session" }, 500);
  }
}