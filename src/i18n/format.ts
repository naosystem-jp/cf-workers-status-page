/**
 * Dates, times, numbers and durations in the viewer's language, with `Intl`. Times are
 * shown in the viewer's time zone unless a zone is given; calendar days of the 90-day history
 * are dates in the page's configured time zone (where its days start) and are formatted
 * as plain dates.
 */
import { durationText } from "../../shared/i18n/core";

export interface Formatters {
	/** The locale's tag. */
	readonly locale: string;
	/** The time zone times are shown in. */
	readonly timeZone: string;
	/** "Nov 20, 2026, 10:32 AM" */
	dateTime(at: number): string;
	/** "Nov 20, 2026, 10:32 AM GMT+9": with the zone, where it matters. */
	dateTimeWithZone(at: number): string;
	/** "10:32:15 AM" */
	time(at: number): string;
	/** "Nov 20, 2026": the day of `at` in the time zone. */
	date(at: number): string;
	/** A calendar day given as `YYYY-MM-DD`: "Nov 20, 2026" (no time zone applies). */
	day(date: string): string;
	/**
	 * A ratio as a percentage with at most two decimals, rounded down so that 99.996% never
	 * shows as 100%.
	 */
	percent(ratio: number): string;
	/** "1 hour, 5 minutes" */
	duration(ms: number): string;
	/** "90 days", "1 day": a number of days with the language's plural rules. */
	days(count: number): string;
	/** "90 days ago", "1 day ago". */
	daysAgo(count: number): string;
	/** "3 minutes ago", "in 2 hours" */
	relative(at: number, now: number): string;
	/** "API, Website and Mail" */
	list(items: readonly string[]): string;
	/** The time zone's offset at `at`, such as "GMT+09:00". */
	offset(at: number): string;
}

const cache = new Map<string, Formatters>();

/** The viewer's time zone (the browser's). */
export function viewerTimeZone(): string {
	return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatters(locale: string, timeZone: string = viewerTimeZone()): Formatters {
	const key = `${locale} ${timeZone}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone });
	const dateTimeWithZone = new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
		timeZone,
	});
	const time = new Intl.DateTimeFormat(locale, { timeStyle: "medium", timeZone });
	const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });
	const days = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "long" });
	const ago = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
	const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
	const percent = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 2 });
	const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
	const offset = new Intl.DateTimeFormat("en-US", { timeZoneName: "longOffset", timeZone });
	const result: Formatters = {
		locale,
		timeZone,
		dateTime: (at) => dateTime.format(at),
		dateTimeWithZone: (at) => dateTimeWithZone.format(at),
		time: (at) => time.format(at),
		date: (at) => date.format(at),
		day: (date) => {
			const [year, month, dayOfMonth] = date.split("-").map(Number);
			if (year === undefined || month === undefined || dayOfMonth === undefined) return date;
			return day.format(Date.UTC(year, month - 1, dayOfMonth, 12));
		},
		// Rounded down, but not below what binary floating point stores (0.57 × 10,000 is 5,699.999…).
		percent: (ratio) => percent.format(Math.floor(Math.max(0, Math.min(1, ratio)) * 10_000 + 1e-6) / 10_000),
		duration: (ms) => durationText(ms, locale),
		days: (count) => days.format(count),
		daysAgo: (count) => ago.format(-count, "day"),
		relative: (at, now) => {
			const seconds = Math.round((at - now) / 1000);
			const abs = Math.abs(seconds);
			if (abs < 60) return relative.format(seconds, "second");
			if (abs < 3_600) return relative.format(Math.round(seconds / 60), "minute");
			if (abs < 86_400) return relative.format(Math.round(seconds / 3_600), "hour");
			return relative.format(Math.round(seconds / 86_400), "day");
		},
		list: (items) => list.format(items),
		offset: (at) => offset.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "",
	};
	cache.set(key, result);
	return result;
}
