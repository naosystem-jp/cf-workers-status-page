import { useEffect, useRef, useState } from "react";
import { INITIAL_POLL_STATE, type PollState, Poller, type PollerOptions } from "./poller";

export type PollOptions<T> = Omit<PollerOptions<T>, "onChange">;

export interface Polled<T> extends PollState<T> {
	/** Fetches now (a "retry" button). */
	refresh(): void;
}

function isVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Polls with a {@link Poller} while mounted, paused while the tab is hidden and fetched again
 * at once when the network comes back after errors. A new `key` (such as the URL) starts over;
 * `null` polls nothing. A new `intervalMs` or `maxBackoffMs` applies at once (see
 * {@link Poller.setTiming}).
 */
export function usePoller<T>(key: string | null, options: PollOptions<T>): Polled<T> {
	// With its key: what another key received is never returned, not even before the effect below runs.
	const [keyed, setKeyed] = useState<{ readonly key: string | null; readonly state: PollState<T> }>({ key, state: INITIAL_POLL_STATE });
	const state = keyed.key === key ? keyed.state : INITIAL_POLL_STATE;
	const latest = useRef(options);
	latest.current = options;
	const poller = useRef<Poller<T> | null>(null);

	useEffect(() => {
		setKeyed((current) => (current.key === key && current.state === INITIAL_POLL_STATE ? current : { key, state: INITIAL_POLL_STATE }));
		if (key === null) return;
		const instance = new Poller<T>({
			...latest.current,
			load: (signal) => latest.current.load(signal),
			intervalAfter: (data) => latest.current.intervalAfter?.(data) ?? latest.current.intervalMs,
			isFatal: (error) => latest.current.isFatal?.(error) ?? false,
			onChange: (next) => setKeyed({ key, state: next }),
		});
		poller.current = instance;
		const onVisibility = () => instance.setVisible(isVisible());
		const onOnline = () => {
			if (instance.current.failures > 0) instance.refresh();
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", onOnline);
		instance.start(isVisible());
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", onOnline);
			instance.stop();
			if (poller.current === instance) poller.current = null;
		};
	}, [key]);

	const { intervalMs, maxBackoffMs } = options;
	useEffect(() => {
		poller.current?.setTiming({ intervalMs, maxBackoffMs });
	}, [intervalMs, maxBackoffMs]);

	return { ...state, refresh: () => poller.current?.refresh() };
}

/** The current time, updated every `intervalMs`, for views that age (stale data, countdowns). */
export function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}
