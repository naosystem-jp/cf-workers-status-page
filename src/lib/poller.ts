/**
 * Fetches a resource again and again (the status every 30 seconds, the history and
 * stoppages every 5 minutes), framework-free so that it can be tested with a fake clock:
 *
 * - **Paused while the tab is hidden**: nothing is fetched for a page nobody looks at (each
 *   request costs Worker and Durable Object requests). When the tab shows again, the
 *   resource is fetched at once if it is due, otherwise when it falls due.
 * - **Backs off on errors**: after `n` failures in a row, waits `interval × 2^(n-1)` (at most
 *   `maxBackoffMs`), with ±10% jitter so that many viewers do not retry in step.
 * - **Stops on fatal errors** (such as 404: the page does not exist), until refreshed.
 *
 * It never forgets the last data on an error: the view decides how to show that it is old
 * (see `freshness.ts`).
 */

export interface PollerClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const realClock: PollerClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export interface PollState<T> {
	/** The latest data; kept through errors. */
	readonly data: T | undefined;
	/** When the latest data arrived, by this browser's clock; `null` before any. */
	readonly receivedAt: number | null;
	/** The latest attempt's error; `null` after a success. */
	readonly error: unknown;
	/** Failed attempts in a row. */
	readonly failures: number;
	/** Whether a request is in flight. */
	readonly loading: boolean;
	/** Whether polling stopped on a fatal error. */
	readonly fatal: boolean;
	/** When the next request is due; `null` while one is in flight or after a fatal error. */
	readonly dueAt: number | null;
	/** Whether polling waits for the tab to show again. */
	readonly paused: boolean;
}

/** How often to ask: after a success, and at most after failures (see {@link Poller.setTiming}). */
export interface PollTiming {
	/** Time between successful requests. */
	readonly intervalMs: number;
	/** Longest wait between failed attempts. */
	readonly maxBackoffMs: number;
}

export interface PollerOptions<T> extends PollTiming {
	load(signal: AbortSignal): Promise<T>;
	/** A shorter or longer wait after a particular success (such as a history still being filled in). */
	intervalAfter?(data: T): number;
	/** Errors after which polling stops (until {@link Poller.refresh}). */
	isFatal?(error: unknown): boolean;
	onChange(state: PollState<T>): void;
	readonly clock?: PollerClock;
	/** For the jitter; returns [0, 1). */
	readonly random?: () => number;
}

/** The wait after `failures` failed attempts in a row (see the module documentation). */
export function backoffDelay(failures: number, intervalMs: number, maxBackoffMs: number, random: () => number = Math.random): number {
	const base = Math.min(intervalMs * 2 ** Math.max(0, failures - 1), Math.max(maxBackoffMs, intervalMs));
	return Math.round(base * (0.9 + 0.2 * random()));
}

export const INITIAL_POLL_STATE: PollState<never> = {
	data: undefined,
	receivedAt: null,
	error: null,
	failures: 0,
	loading: false,
	fatal: false,
	dueAt: null,
	paused: false,
};

export class Poller<T> {
	private state: PollState<T> = INITIAL_POLL_STATE;
	private readonly clock: PollerClock;
	private readonly random: () => number;
	private timer: unknown = null;
	private controller: AbortController | null = null;
	private visible = true;
	private running = false;
	private readonly options: PollerOptions<T>;
	private timing: PollTiming;
	/** When the latest attempt failed (by the clock); `null` before any. */
	private failedAt: number | null = null;

	constructor(options: PollerOptions<T>) {
		this.options = options;
		this.clock = options.clock ?? realClock;
		this.random = options.random ?? Math.random;
		this.timing = { intervalMs: options.intervalMs, maxBackoffMs: options.maxBackoffMs };
	}

	get current(): PollState<T> {
		return this.state;
	}

	/** Starts polling: fetches at once if visible, otherwise as soon as the tab shows. */
	start(visible = true): void {
		this.running = true;
		this.visible = visible;
		this.schedule(this.clock.now());
	}

	stop(): void {
		this.running = false;
		this.clearTimer();
		this.controller?.abort();
		this.controller = null;
	}

	/** Fetches now (a "retry" button, the network coming back), also after a fatal error. */
	refresh(): void {
		if (!this.running || this.controller !== null) return;
		this.clearTimer();
		this.update({ fatal: false });
		void this.fetch();
	}

	/**
	 * Asks as often as `timing` says from now on (a view that needs the resource more or less
	 * often). The next request falls due by it: after the latest success (at once if that has
	 * passed), or after the latest failure, then only if sooner than already planned.
	 */
	setTiming(timing: PollTiming): void {
		this.timing = timing;
		const { data, receivedAt, failures, fatal, dueAt } = this.state;
		if (!this.running || this.controller !== null || fatal) return;
		if (failures > 0) {
			if (this.failedAt === null) return;
			const due = this.failedAt + backoffDelay(failures, timing.intervalMs, timing.maxBackoffMs, this.random);
			if (dueAt === null || due < dueAt) this.schedule(due);
			return;
		}
		if (data !== undefined && receivedAt !== null) this.schedule(receivedAt + this.intervalAfter(data));
	}

	/** The tab was hidden or shown (`document.visibilityState`). */
	setVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		if (!this.running) return;
		if (!visible) {
			this.clearTimer();
			if (this.state.dueAt !== null) this.update({ paused: true });
			return;
		}
		if (this.state.dueAt !== null) this.schedule(this.state.dueAt);
	}

	private schedule(dueAt: number): void {
		this.clearTimer();
		if (!this.running) return;
		if (!this.visible) {
			this.update({ dueAt, paused: true });
			return;
		}
		const wait = dueAt - this.clock.now();
		if (wait <= 0) {
			void this.fetch();
			return;
		}
		this.update({ dueAt, paused: false });
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			void this.fetch();
		}, wait);
	}

	private async fetch(): Promise<void> {
		const controller = new AbortController();
		this.controller = controller;
		this.update({ loading: true, dueAt: null, paused: false });
		try {
			const data = await this.options.load(controller.signal);
			if (controller.signal.aborted) return;
			this.controller = null;
			const now = this.clock.now();
			this.update({ data, receivedAt: now, error: null, failures: 0, loading: false, fatal: false });
			this.schedule(now + this.intervalAfter(data));
		} catch (error) {
			if (controller.signal.aborted) return;
			this.controller = null;
			const failures = this.state.failures + 1;
			if (this.options.isFatal?.(error)) {
				this.update({ error, failures, loading: false, fatal: true, dueAt: null });
				return;
			}
			this.update({ error, failures, loading: false });
			this.failedAt = this.clock.now();
			this.schedule(this.failedAt + backoffDelay(failures, this.timing.intervalMs, this.timing.maxBackoffMs, this.random));
		}
	}

	private intervalAfter(data: T): number {
		return this.options.intervalAfter?.(data) ?? this.timing.intervalMs;
	}

	private clearTimer(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
	}

	private update(changes: Partial<PollState<T>>): void {
		this.state = { ...this.state, ...changes };
		this.options.onChange(this.state);
	}
}
