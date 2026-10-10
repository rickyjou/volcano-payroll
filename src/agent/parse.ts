// Deterministic readers for the values a decider should not guess: amounts, dates,
// months, earning codes and export formats. Everything is UTC date math on ISO strings.
import { addDays, dayOfWeek, fromUtc, toUtc, type ISODate } from '../lib/dates';
import type { EntryCode } from '../lib/types';

export interface Amount { hours?: number; days?: number }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?';

const monthIndex = (word: string): number => MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().slice(0, 3)));
const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): ISODate | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  try {
    toUtc(iso);
    return iso;
  } catch {
    return null;
  }
}

/** A month and day without a year: this year's, or last year's when that would be over
 *  half a year ahead ("dec 30" said in January means the one just gone). */
function nearestDate(today: ISODate, m: number, d: number): ISODate | null {
  const year = Number(today.slice(0, 4));
  const date = validDate(year, m, d);
  return date && date > addDays(today, 183) ? validDate(year - 1, m, d) : date;
}

/** Removes date-like phrases so their numbers are not read as amounts. */
function withoutDates(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b${MONTH_RE}\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?${MONTH_RE}\\b`, 'gi'), ' ')
    .replace(/\b\d{1,2}(st|nd|rd|th)\b/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ');
}

// Phrasings an amount must not be guessed from: minutes, clock times and time ranges.
const MINUTES_RE = /\b\d+\s*(m|mins?|minutes?)\b/;
const CLOCK_RE = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}(:\d{2})?\s*(-|–|to|until|till)\s*\d{1,2}(:\d{2})?\b/;

/** "8", "7.5h", "8:30", "8 hours", "half day", "a full day", "1 day" → hours or days.
 *  Null when the message is ambiguous (minutes, a time range, several amounts). */
export function parseAmount(text: string): Amount | null {
  const t = withoutDates(text.toLowerCase());
  if (MINUTES_RE.test(t) || CLOCK_RE.test(t)) return null;
  if (/\b(half|1\/2|½)[\s-]*(a\s+)?day\b|\b0?\.5\s*days?\b/.test(t)) return { days: 0.5 };
  if (/\b(full|whole|one|a|1)\s+day\b|\b1(\.0)?\s*days?\b/.test(t)) return { days: 1 };
  const hm = /\b(\d{1,2}):([0-5]\d)\b/.exec(t);
  if (hm) return { hours: Number(hm[1]) + Number(hm[2]) / 60 };
  const n = /(?:^|[^\d.])(\d{1,2}(?:\.\d{1,2})?)(?!\d|\.\d)\s*(?:h\b|hr\b|hrs\b|hours?\b)?/.exec(t);
  if (!n) return null;
  if ((t.match(/(?:^|[^\d.])\d{1,2}(?:\.\d{1,2})?(?![\d.])/g) ?? []).length > 1) return null;
  const hours = Number(n[1]);
  return hours > 0 ? { hours } : null;
}

const DAY_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b${MONTH_RE}\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?${MONTH_RE}\\b`, 'gi'),
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g,
  /\b\d{1,2}(st|nd|rd|th)\b/g,
  /\bday before yesterday\b/g,
  /\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b|\byesterday\b/g,
  new RegExp(`\\b${WEEKDAY_RE}\\b`, 'gi'),
];

/** How many separate days the message names ("yesterday and 6 today" names two). */
function dayMentions(t: string): number {
  let rest = t;
  let n = 0;
  for (const re of DAY_PATTERNS) {
    rest = rest.replace(re, () => {
      n += 1;
      return ' ';
    });
  }
  return n;
}

/** "today", "yesterday", "friday", "last friday", "the 12th", "oct 3", "3 october", "2026-10-03", "10/3".
 *  Null when the message names several days or a future weekday ("next friday"). */
export function parseDay(text: string, today: ISODate): ISODate | null {
  const t = text.toLowerCase();
  if (dayMentions(t) > 1) return null;
  if (new RegExp(`\\b(next|coming|this coming)\\s+${WEEKDAY_RE}\\b`, 'i').test(t)) return null;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(t)) return today;
  if (/\bday before yesterday\b/.test(t)) return addDays(today, -2);
  if (/\byesterday\b/.test(t)) return addDays(today, -1);

  const md = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i').exec(t)
    ?? new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i').exec(t);
  if (md) {
    const [word, day] = /\d/.test(md[1]) ? [md[2], Number(md[1])] : [md[1], Number(md[2])];
    return nearestDate(today, monthIndex(word) + 1, day);
  }
  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t);
  if (slash) return nearestDate(today, Number(slash[1]), Number(slash[2]));
  const nth = /\b(?:the\s+)?(\d{1,2})(st|nd|rd|th)\b/.exec(t);
  if (nth) return validDate(Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(nth[1]));

  const wd = new RegExp(`\\b(last\\s+)?${WEEKDAY_RE}\\b`, 'i').exec(t);
  if (wd) {
    const target = WEEKDAYS.findIndex((w) => w.startsWith(wd[2].slice(0, 3)));
    let back = (dayOfWeek(today) - target + 7) % 7;
    if (wd[1] && back === 0) back = 7;
    return addDays(today, -back);
  }
  return null;
}

/** "this month", "next month", "last month", "november", "nov 2026", "2026-11" → "YYYY-MM". */
export function parseMonth(text: string, today: ISODate): string | null {
  const t = text.toLowerCase();
  const ym = /\b(\d{4})-(0[1-9]|1[0-2])\b/.exec(t);
  if (ym) return `${ym[1]}-${ym[2]}`;
  const first = toUtc(`${today.slice(0, 7)}-01`);
  const shift = (n: number) => {
    const d = new Date(first);
    d.setUTCMonth(d.getUTCMonth() + n);
    return fromUtc(d.getTime()).slice(0, 7);
  };
  if (/\bthis month\b|\bcurrent month\b/.test(t)) return today.slice(0, 7);
  if (/\bnext month\b/.test(t)) return shift(1);
  if (/\blast month\b|\bprevious month\b/.test(t)) return shift(-1);
  const m = new RegExp(`\\b${MONTH_RE}\\b(?:\\s+(\\d{4}))?`, 'i').exec(t);
  if (!m) return null;
  // "may" is usually the verb; only read it as the month when the phrasing says so.
  if (m[1].toLowerCase() === 'may' && !m[2] && !/\b(in|for|of|open|lock|close|reopen)\s+may\b/.test(t)) return null;
  return `${m[2] ?? today.slice(0, 4)}-${pad(monthIndex(m[1]) + 1)}`;
}

/** Earning code named in the message; REG when none is. */
export function parseCode(text: string): EntryCode {
  const t = text.toLowerCase();
  if (/\bsick\b|\bill\b|\bunwell\b/.test(t)) return 'SICK';
  if (/\bholiday\b/.test(t)) return 'HOL';
  if (/\bpto\b|\bvacation\b|\btime off\b|\bday off\b|\bleave\b/.test(t)) return 'PTO';
  return 'REG';
}

/** True when the message adds to existing time rather than setting it. */
export const isAdditive = (text: string): boolean =>
  /\b(more|another|extra|additional|add|plus)\b/i.test(text)
  && !/\b(instead|replace|change it to|make it)\b/i.test(text)
  && !/\b(not|no|don'?t|without)\s+(any\s+)?(more|extra|additional|add)\b/i.test(text);

/** The note or reason in "return hal's: tuesday is missing", "void it because rates were wrong",
 *  "send dee's back, she forgot friday". After a comma it must be two words or more, so
 *  "…, please" is not read as a note. */
export function parseNote(text: string): string | null {
  const t = text.trim();
  const tidy = (s: string) => {
    const v = s.trim().replace(/[\s.!]+$/, '');
    return v.length >= 2 ? v[0].toUpperCase() + v.slice(1) : null;
  };
  const colon = t.indexOf(':');
  if (colon >= 0 && !/^\/\//.test(t.slice(colon + 1))) return tidy(t.slice(colon + 1));
  const because = /\bbecause\s+.+$/i.exec(t);
  if (because) return tidy(because[0]);
  const comma = t.indexOf(',');
  if (comma < 0) return null;
  const rest = t.slice(comma + 1).trim();
  if (rest.split(/\s+/).length < 2 || /^(please|thanks|thank you|now|asap)\b/i.test(rest)) return null;
  return tidy(rest);
}

/** The first web address in the message, without trailing punctuation. */
export function parseUrl(text: string): string | null {
  return /\bhttps?:\/\/[^\s<>"']+/i.exec(text)?.[0].replace(/[.,;:!?)]+$/, '') ?? null;
}

/** A name for a new record: "an API key called Gusto sync", "a key for ADP". */
export function parseLabel(text: string): string | null {
  const m = /\b(?:called|named)\s+(.+)$/i.exec(text) ?? /\bfor\s+(?:the\s+|our\s+)?(.+)$/i.exec(text);
  const v = m?.[1].trim().replace(/^["“']|["”'.!]+$/g, '').trim();
  return v && v.length <= 60 ? v : null;
}

/** Export format named in the message (preset keys from src/lib/exporters/presets.ts). */
export function parseFormat(text: string): string | null {
  const t = text.toLowerCase();
  if (/\bgusto\b/.test(t)) return 'gusto';
  if (/\badp\b/.test(t)) return 'adp_wfn';
  if (/\bquickbooks\b|\bqbo\b/.test(t)) return 'qbo_payroll';
  if (/\bpaychex\b/.test(t)) return 'paychex_flex';
  if (/\bjson\b/.test(t)) return 'generic_json';
  if (/\bcsv\b|\bspreadsheet\b|\bexcel\b/.test(t)) return 'generic_csv';
  return null;
}
