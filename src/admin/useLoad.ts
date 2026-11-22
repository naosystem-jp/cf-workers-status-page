import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
	/**
	 * What was loaded for the current `key`; `undefined` while it loads. Never what an earlier
	 * key loaded: a view that switched from page A to page B must not show (or save) A's data
	 * as B's.
	 */
	readonly data: T | undefined;
	readonly error: unknown;
	readonly loading: boolean;
	/** Loads again (after a change, or a "reload" button), keeping the data meanwhile. */
	reload(): void;
	/** Replaces the data without loading (with what a save returned). */
	setData(data: T): void;
}

interface State<T> {
	/** The key `data` and `error` belong to. */
	readonly key: string | null;
	readonly data: T | undefined;
	readonly error: unknown;
	readonly loading: boolean;
}

/** Loads `load()` when mounted and whenever `key` changes; `null` loads nothing. */
export function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
	const [state, setState] = useState<State<T>>({ key, data: undefined, error: null, loading: key !== null });
	const [generation, setGeneration] = useState(0);
	const latest = useRef(load);
	latest.current = load;

	useEffect(() => {
		if (key === null) return;
		const controller = new AbortController();
		setState((previous) => (previous.key === key ? { ...previous, loading: true, error: null } : { key, data: undefined, error: null, loading: true }));
		latest
			.current(controller.signal)
			.then((data) => {
				if (!controller.signal.aborted) setState({ key, data, error: null, loading: false });
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				setState((previous) => ({ key, data: previous.key === key ? previous.data : undefined, error, loading: false }));
			});
		return () => controller.abort();
	}, [key, generation]);

	const reload = useCallback(() => setGeneration((value) => value + 1), []);
	const setData = useCallback((data: T) => setState({ key, data, error: null, loading: false }), [key]);
	const current = state.key === key;
	return {
		data: current ? state.data : undefined,
		error: current ? state.error : null,
		loading: current ? state.loading : key !== null,
		reload,
		setData,
	};
}
