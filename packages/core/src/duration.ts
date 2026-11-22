import * as z from "zod";

/** Units accepted in a {@link Duration}. */
export type DurationUnit = "ms" | "s" | "m" | "h" | "d";

/**
 * A length of time written as a non-negative integer followed by a unit,
 * for example `"500ms"`, `"15s"`, `"1m"`, `"12h"` or `"180d"`.
 * Compound forms such as `"1h30m"` and fractions such as `"1.5h"` are not accepted.
 */
export type Duration = `${number}${DurationUnit}`;

const UNIT_MS: Record<DurationUnit, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const FORMAT_HINT =
	'expected an integer followed by ms, s, m, h or d (for example "15s", "1m" or "180d")';

/**
 * Converts a duration string to milliseconds.
 * @throws RangeError if the string is not a valid {@link Duration}.
 */
export function parseDuration(value: string): number {
	const match = DURATION_PATTERN.exec(value);
	const amount = match?.[1];
	const unit = match?.[2] as DurationUnit | undefined;
	if (amount === undefined || unit === undefined) {
		throw new RangeError(`Invalid duration "${value}": ${FORMAT_HINT}`);
	}
	const ms = Number(amount) * UNIT_MS[unit];
	if (!Number.isSafeInteger(ms)) {
		throw new RangeError(`Invalid duration "${value}": too large`);
	}
	return ms;
}

/**
 * Zod schema that accepts a {@link Duration} string and outputs milliseconds.
 * Use `.prefault("10s")` (not `.default()`) to give a default written as a duration string.
 */
export function durationSchema(): z.ZodType<number, Duration> {
	return z.string().transform((value, ctx) => {
		try {
			return parseDuration(value);
		} catch (error) {
			ctx.addIssue((error as Error).message);
			return z.NEVER;
		}
	}) as z.ZodType<number, Duration>;
}
