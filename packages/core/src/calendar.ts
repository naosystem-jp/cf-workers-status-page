/**
 * Days in the configured time zone, with correct boundaries on days that
 * daylight saving time makes 23 or 25 hours long (or 23.5, or that start at 01:00 because
 * midnight is skipped). Uses `Intl.DateTimeFormat` with IANA zone names.
 */
import type { TimeRange } from "./timeline";

/** A local calendar day: `[from, to)` runs from its first instant to the next day's. */
export interface CalendarDay extends TimeRange {
	/** `YYYY-MM-DD` in the time zone. */
	readonly date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let found = formatters.get(timeZone);
	if (found === undefined) {
		found = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, found);
	}
	return found;
}

interface WallClock {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

function wallClock(at: number, timeZone: string): WallClock {
	const parts: Record<string, number> = {};
	for (const part of formatter(timeZone).formatToParts(at)) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return {
		year: parts["year"] ?? 0,
		month: parts["month"] ?? 1,
		day: parts["day"] ?? 1,
		hour: parts["hour"] ?? 0,
		minute: parts["minute"] ?? 0,
		second: parts["second"] ?? 0,
	};
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

function formatDate(year: number, month: number, day: number): string {
	return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function parseDate(date: string): [number, number, number] {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (match === null) throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The date `days` after `date` (negative: before), in the proleptic Gregorian calendar. */
export function addDays(date: string, days: number): string {
	const [year, month, day] = parseDate(date);
	const shifted = new Date(Date.UTC(year, month - 1, day + days));
	return formatDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** The local date (`YYYY-MM-DD`) at instant `at` in `timeZone`. */
export function localDate(at: number, timeZone: string): string {
	const clock = wallClock(at, timeZone);
	return formatDate(clock.year, clock.month, clock.day);
}

/** Local wall-clock time minus UTC at `at`, in milliseconds (whole seconds). */
function offsetAt(at: number, timeZone: string): number {
	const seconds = Math.floor(at / 1000) * 1000;
	const clock = wallClock(seconds, timeZone);
	return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - seconds;
}

const starts = new Map<string, number>();
const MAX_MEMO = 4_096;
const HOUR_MS = 3_600_000;

/**
 * The first instant of local date `date` in `timeZone`: local midnight, or the first
 * instant after a transition that skips midnight, or the earlier of two midnights when the
 * clock goes back across it.
 */
export function startOfLocalDay(date: string, timeZone: string): number {
	const key = `${timeZone} ${date}`;
	const memo = starts.get(key);
	if (memo !== undefined) return memo;

	const [year, month, day] = parseDate(date);
	const midnightUtc = Date.UTC(year, month - 1, day);
	// Two rounds find the offset in effect at local midnight in all but the cases checked below.
	let start = midnightUtc - offsetAt(midnightUtc, timeZone);
	start = midnightUtc - offsetAt(start, timeZone);
	if (localDate(start, timeZone) !== date || localDate(start - 1, timeZone) >= date) {
		// Midnight was skipped or repeated: search for the first instant of the date. Offsets
		// are between -12 and +14 hours, so it is within 15 hours of midnight UTC.
		let low = midnightUtc - 15 * HOUR_MS;
		let high = midnightUtc + 15 * HOUR_MS;
		while (high - low > 1000) {
			const middle = low + Math.floor((high - low) / 2000) * 1000;
			if (localDate(middle, timeZone) >= date) high = middle;
			else low = middle;
		}
		start = high;
	}
	if (starts.size >= MAX_MEMO) starts.clear();
	starts.set(key, start);
	return start;
}

/** The local day of `date`. */
export function calendarDay(date: string, timeZone: string): CalendarDay {
	return { date, from: startOfLocalDay(date, timeZone), to: startOfLocalDay(addDays(date, 1), timeZone) };
}

/** The last `count` local days up to and including the one containing `now`, oldest first. */
export function recentDays(now: number, timeZone: string, count: number): CalendarDay[] {
	const today = localDate(now, timeZone);
	const days: CalendarDay[] = [];
	for (let offset = count - 1; offset >= 0; offset--) days.push(calendarDay(addDays(today, -offset), timeZone));
	return days;
}
