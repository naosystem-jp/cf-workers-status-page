/**
 * Response times for status pages (`components[].latency`).
 *
 * The Monitor DO sums them into 15-minute buckets (count, total and a histogram) from the result
 * rows it reads anyway when a page reads its history (`getTimeline`), so publishing them costs
 * no extra row read and no extra Durable Object request. The page keeps the buckets with its
 * cached days (a cache that can be rebuilt from the results) and turns them into series of
 * 24 hours, 7 days and 30 days. Nothing is aggregated or stored when a check runs.
 *
 * Only scheduled checks that got a response count: re-checks come in bursts after failures and
 * would weigh bad minutes more, and checks that timed out or failed to connect have no response
 * time. Buckets start at multiples of their length since the epoch, so every 15-minute bucket
 * falls in one 2-hour and one 6-hour bucket, and in one local day of any time zone (all offsets
 * in use are whole quarters of an hour).
 */
import type { LatencySeries } from "../shared/public-api";

/** Length of the buckets the Monitor DO returns and pages keep. */
export const LATENCY_BUCKET_MS = 15 * 60_000;

/** The series a page publishes: bucket length and number of buckets. */
export const LATENCY_RANGES = {
	day: { bucketMs: LATENCY_BUCKET_MS, count: 96 },
	week: { bucketMs: 2 * 3_600_000, count: 84 },
	month: { bucketMs: 6 * 3_600_000, count: 120 },
} as const;

/** The 95th percentile, as published. */
const PERCENTILE = 0.95;

/**
 * Histogram bins grow by this ratio, so a value read back from its bin (the bin's geometric
 * middle) is within about 5% of what was measured, at any scale: 100 ms ± 5 ms, 3 s ± 150 ms.
 * Measured response times fall in a few dozen bins at most (60 seconds is bin 115).
 */
const BIN_RATIO = 1.1;
const LOG_RATIO = Math.log(BIN_RATIO);

export function latencyBin(ms: number): number {
	return Math.max(0, Math.round(Math.log1p(Math.max(0, ms)) / LOG_RATIO));
}

/** The response time a bin stands for. */
export function binValue(bin: number): number {
	return Math.expm1(bin * LOG_RATIO);
}

export interface LatencyBucket {
	/** A multiple of {@link LATENCY_BUCKET_MS}. */
	readonly from: number;
	readonly count: number;
	readonly sumMs: number;
	/** The histogram as `[bin, count]` pairs, flattened, by bin. */
	readonly bins: readonly number[];
}

/** When the published series begin: the start of the 30-day series' first bucket. Older data is not kept. */
export function latencySince(now: number): number {
	const { bucketMs, count } = LATENCY_RANGES.month;
	return Math.floor(now / bucketMs) * bucketMs - (count - 1) * bucketMs;
}

/** Response times (`[checked at, milliseconds]`) summed into 15-minute buckets, oldest first. */
export function aggregateLatency(samples: Iterable<readonly [at: number, ms: number]>): LatencyBucket[] {
	const buckets = new Map<number, { count: number; sumMs: number; bins: Map<number, number> }>();
	for (const [at, ms] of samples) {
		const from = Math.floor(at / LATENCY_BUCKET_MS) * LATENCY_BUCKET_MS;
		let bucket = buckets.get(from);
		if (bucket === undefined) {
			bucket = { count: 0, sumMs: 0, bins: new Map() };
			buckets.set(from, bucket);
		}
		bucket.count++;
		bucket.sumMs += ms;
		const bin = latencyBin(ms);
		bucket.bins.set(bin, (bucket.bins.get(bin) ?? 0) + 1);
	}
	return [...buckets.entries()]
		.sort(([a], [b]) => a - b)
		.map(([from, bucket]) => ({ from, count: bucket.count, sumMs: bucket.sumMs, bins: flatten(bucket.bins) }));
}

function flatten(bins: ReadonlyMap<number, number>): number[] {
	return [...bins.entries()].sort(([a], [b]) => a - b).flat();
}

/**
 * Buckets of the same time (the monitors of one component) summed into one, oldest first.
 */
export function mergeLatency(lists: Iterable<readonly LatencyBucket[]>): LatencyBucket[] {
	const merged = new Map<number, { count: number; sumMs: number; bins: Map<number, number> }>();
	for (const list of lists) {
		for (const bucket of list) {
			let into = merged.get(bucket.from);
			if (into === undefined) {
				into = { count: 0, sumMs: 0, bins: new Map() };
				merged.set(bucket.from, into);
			}
			into.count += bucket.count;
			into.sumMs += bucket.sumMs;
			for (let index = 0; index + 1 < bucket.bins.length; index += 2) {
				const bin = bucket.bins[index] as number;
				into.bins.set(bin, (into.bins.get(bin) ?? 0) + (bucket.bins[index + 1] as number));
			}
		}
	}
	return [...merged.entries()]
		.sort(([a], [b]) => a - b)
		.map(([from, bucket]) => ({ from, count: bucket.count, sumMs: bucket.sumMs, bins: flatten(bucket.bins) }));
}

/**
 * A series of `count` buckets of `bucketMs`, the last one containing `now` (so far), from
 * 15-minute buckets.
 */
export function latencySeries(buckets: readonly LatencyBucket[], now: number, bucketMs: number, count: number): LatencySeries {
	const last = Math.floor(now / bucketMs) * bucketMs;
	const from = last - (count - 1) * bucketMs;
	const sums = Array.from({ length: count }, () => 0);
	const counts = Array.from({ length: count }, () => 0);
	const histogram = new Map<number, number>();
	let total = 0;
	let sum = 0;
	for (const bucket of buckets) {
		if (bucket.from < from || bucket.from >= last + bucketMs || bucket.count === 0) continue;
		const index = Math.floor((bucket.from - from) / bucketMs);
		sums[index] = (sums[index] as number) + bucket.sumMs;
		counts[index] = (counts[index] as number) + bucket.count;
		total += bucket.count;
		sum += bucket.sumMs;
		for (let position = 0; position + 1 < bucket.bins.length; position += 2) {
			const bin = bucket.bins[position] as number;
			histogram.set(bin, (histogram.get(bin) ?? 0) + (bucket.bins[position + 1] as number));
		}
	}
	return {
		from,
		bucketMs,
		values: counts.map((n, index) => (n > 0 ? Math.round((sums[index] as number) / n) : null)),
		averageMs: total > 0 ? Math.round(sum / total) : null,
		p95Ms: percentile(histogram, total, PERCENTILE),
	};
}

/** The nearest-rank percentile `q` of a histogram of `total` values. */
export function percentile(histogram: ReadonlyMap<number, number>, total: number, q: number): number | null {
	if (total <= 0) return null;
	const rank = Math.max(1, Math.ceil(q * total));
	let seen = 0;
	for (const bin of [...histogram.keys()].sort((a, b) => a - b)) {
		seen += histogram.get(bin) as number;
		if (seen >= rank) return Math.round(binValue(bin));
	}
	return null;
}

// ---------------------------------------------------------------------------
// Packed form, kept in memory by status pages
// ---------------------------------------------------------------------------

/**
 * Buckets packed into one typed array, as the page keeps a day's segments: per bucket `from`,
 * `count`, `sumMs`, the number of bins, then `[bin, count]` pairs.
 */
export type PackedLatency = Float64Array;

export const NO_LATENCY: PackedLatency = new Float64Array();

export function packLatency(buckets: readonly LatencyBucket[]): PackedLatency {
	const size = buckets.reduce((total, bucket) => total + 4 + bucket.bins.length, 0);
	const packed = new Float64Array(size);
	let at = 0;
	for (const bucket of buckets) {
		packed[at++] = bucket.from;
		packed[at++] = bucket.count;
		packed[at++] = bucket.sumMs;
		packed[at++] = bucket.bins.length / 2;
		packed.set(bucket.bins, at);
		at += bucket.bins.length;
	}
	return packed;
}

export function unpackLatency(packed: PackedLatency): LatencyBucket[] {
	const buckets: LatencyBucket[] = [];
	let at = 0;
	while (at + 3 < packed.length) {
		const pairs = packed[at + 3] as number;
		buckets.push({
			from: packed[at] as number,
			count: packed[at + 1] as number,
			sumMs: packed[at + 2] as number,
			bins: Array.from(packed.subarray(at + 4, at + 4 + 2 * pairs)),
		});
		at += 4 + 2 * pairs;
	}
	return buckets;
}

/** `a` followed by `b`: buckets of consecutive stretches of time. */
export function concatLatency(a: PackedLatency, b: PackedLatency): PackedLatency {
	if (b.length === 0) return a;
	if (a.length === 0) return b;
	const joined = new Float64Array(a.length + b.length);
	joined.set(a);
	joined.set(b, a.length);
	return joined;
}

type StoredBucket = [from: number, count: number, sumMs: number, bins: number[]];

/** As stored in a page's SQLite (`monitor_days.latency`). */
export function encodeLatency(packed: PackedLatency): string {
	return JSON.stringify(unpackLatency(packed).map((bucket): StoredBucket => [bucket.from, bucket.count, bucket.sumMs, [...bucket.bins]]));
}

export function decodeLatency(text: string): PackedLatency {
	try {
		const stored = JSON.parse(text) as StoredBucket[];
		return packLatency(stored.map(([from, count, sumMs, bins]) => ({ from, count, sumMs, bins })));
	} catch {
		return NO_LATENCY;
	}
}
