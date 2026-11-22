/**
 * Times in the admin's local time (`<input type="datetime-local">`), to and from the API's
 * epoch milliseconds. The forms say which time zone that is.
 */

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** `YYYY-MM-DDTHH:mm` in the browser's time zone, as `datetime-local` inputs take it. */
export function toLocalInput(at: number): string {
	const date = new Date(at);
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The moment a `datetime-local` value means in the browser's time zone; `null` when empty or invalid. */
export function fromLocalInput(value: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(value)) return null;
	// A date-time without an offset is local time (ECMAScript Date Time String Format).
	const at = new Date(value).getTime();
	return Number.isNaN(at) ? null : at;
}

/**
 * Whether a `datetime-local` value is a time that exists in the browser's time zone. A time
 * skipped when daylight saving time starts (02:30 when clocks jump from 02:00 to 03:00) does
 * not: `Date` would silently move it, so the forms refuse it instead.
 */
export function localTimeExists(value: string): boolean {
	const at = fromLocalInput(value);
	return at === null || toLocalInput(at) === value.slice(0, 16);
}

/** The minute `at` falls in, as a `datetime-local` value would round it. */
export function toMinute(at: number): number {
	return Math.floor(at / 60_000) * 60_000;
}
