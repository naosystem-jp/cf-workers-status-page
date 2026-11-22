import { useEffect, useRef, useState } from "react";
import type { ListPage } from "../../shared/admin-api";

export interface PagedList<T> {
	readonly items: readonly T[];
	readonly loading: boolean;
	readonly error: unknown;
	/** Whether older items remain. */
	readonly more: boolean;
	loadMore(): void;
	reload(): void;
	/** Replaces an item in place (after a change made from the list). */
	replace(item: T, same: (a: T, b: T) => boolean): void;
}

interface State<T> {
	/** The key the items belong to (items of an earlier key are never shown). */
	readonly key: string;
	readonly items: readonly T[];
	readonly cursor: string | null;
	readonly loading: boolean;
	readonly error: unknown;
}

/**
 * A cursor-paginated list (`{ items, nextCursor }`, README "Admin API"): the first page when
 * `key` changes, more on request.
 */
export function usePagedList<T>(key: string, load: (cursor: string | null, signal?: AbortSignal) => Promise<ListPage<T>>): PagedList<T> {
	const [state, setState] = useState<State<T>>({ key, items: [], cursor: null, loading: true, error: null });
	const [generation, setGeneration] = useState(0);
	const latest = useRef(load);
	latest.current = load;
	const latestState = useRef(state);
	latestState.current = state;
	/** Counts loads of the first page, so that a "load more" started before one is dropped. */
	const epoch = useRef(0);

	useEffect(() => {
		const controller = new AbortController();
		const mine = ++epoch.current;
		setState({ key, items: [], cursor: null, loading: true, error: null });
		latest
			.current(null, controller.signal)
			.then((page) => {
				if (epoch.current === mine) setState({ key, items: page.items, cursor: page.nextCursor, loading: false, error: null });
			})
			.catch((error: unknown) => {
				if (epoch.current === mine && !controller.signal.aborted) setState({ key, items: [], cursor: null, loading: false, error });
			});
		return () => controller.abort();
	}, [key, generation]);

	function loadMore() {
		const { cursor, loading } = latestState.current;
		if (cursor === null || loading) return;
		const mine = epoch.current;
		setState((previous) => ({ ...previous, loading: true, error: null }));
		latest
			.current(cursor)
			.then((page) => {
				if (epoch.current !== mine) return;
				setState((previous) => ({ ...previous, items: [...previous.items, ...page.items], cursor: page.nextCursor, loading: false, error: null }));
			})
			.catch((error: unknown) => {
				if (epoch.current === mine) setState((previous) => ({ ...previous, loading: false, error }));
			});
	}

	const current = state.key === key;
	return {
		items: current ? state.items : [],
		loading: current ? state.loading : true,
		error: current ? state.error : null,
		more: current && state.cursor !== null,
		loadMore,
		reload: () => setGeneration((value) => value + 1),
		replace: (item, same) =>
			setState((previous) => ({ ...previous, items: previous.items.map((existing) => (same(existing, item) ? item : existing)) })),
	};
}
