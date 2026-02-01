import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { CONFIG } from "./config.js";

export function tryParseDateTime(text: string, now: Date = new Date()) {
  const parsed = chrono.parseDate(text, now);
  if (!parsed) return null;

  // Interpret in configured TZ
  const dt = DateTime.fromJSDate(parsed, { zone: CONFIG.timezone });

  // If no year was provided and the date already passed this year, bump to next year.
  // chrono sometimes sets a year implicitly; we still guard:
  const nowDt = DateTime.fromJSDate(now, { zone: CONFIG.timezone });
  let corrected = dt;

  // If it's in the past by more than ~5 minutes, and month/day likely meant future, bump year.
  if (corrected < nowDt.minus({ minutes: 5 })) {
    corrected = corrected.plus({ years: 1 });
  }

  return corrected.toISO();
}
