// IST ("Asia/Kolkata") wall-clock helpers for Next.js server/client code.
// Mirrors the `now() at time zone 'Asia/Kolkata'` pattern used throughout
// the Postgres RPCs (Phase 3) -- Vercel's server clock is UTC, so any
// "today"/"now" derived from a naive `new Date()` would be wrong by up to
// 5.5 hours without this.

const IST_TZ = "Asia/Kolkata";

export function getISTNowParts(): {
  dateStr: string; // yyyy-MM-dd
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday, matching JS Date#getDay()
} {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: weekdayNames.indexOf(get("weekday")),
  };
}
