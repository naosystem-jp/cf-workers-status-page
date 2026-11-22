/**
 * A small client-side router on the History API: enough for a handful of routes, without a
 * routing library. Links are real `<a href>`s, so they open in a new tab and work without
 * JavaScript-aware handling; a plain click navigates in place.
 */
import { type AnchorHTMLAttributes, type MouseEvent, useMemo, useSyncExternalStore } from "react";

const NAVIGATE_EVENT = "cf-workers-status-page:navigate";

function snapshot(): string {
	return window.location.pathname + window.location.search;
}

// ---------------------------------------------------------------------------
// Leaving with unsaved changes
// ---------------------------------------------------------------------------

/** Returns the question to ask before leaving (unsaved changes), or `null` to let go. */
export type Blocker = () => string | null;

const blockers = new Set<Blocker>();

/** The question of the first blocker that holds the page, if any. */
function blockingQuestion(): string | null {
	for (const blocker of blockers) {
		const question = blocker();
		if (question !== null) return question;
	}
	return null;
}

/** A navigation waiting for the admin's answer (see {@link useLeaveRequest}). */
export interface LeaveRequest {
	readonly question: string;
	/** Goes where the admin wanted to go. */
	leave(): void;
	/** Stays on the page. */
	stay(): void;
}

let request: LeaveRequest | null = null;
const requestListeners = new Set<() => void>();

function setRequest(next: LeaveRequest | null): void {
	request = next;
	for (const listener of requestListeners) listener();
}

/**
 * Asks before leaving, then calls `proceed` if the admin chooses to leave: in the app's own
 * dialog when one is shown ({@link useLeaveRequest}), else with the browser's `confirm()`.
 * `true` when nothing holds the page and `proceed` was called at once.
 */
function askToLeave(proceed: () => void): boolean {
	const question = blockingQuestion();
	if (question === null) {
		proceed();
		return true;
	}
	if (requestListeners.size === 0) {
		if (window.confirm(question)) proceed();
		return false;
	}
	setRequest({
		question,
		leave: () => {
			setRequest(null);
			proceed();
		},
		stay: () => setRequest(null),
	});
	return false;
}

/** The navigation waiting for an answer, for the dialog that asks it (`null` when none). */
export function useLeaveRequest(): LeaveRequest | null {
	return useSyncExternalStore(
		(onChange) => {
			requestListeners.add(onChange);
			return () => requestListeners.delete(onChange);
		},
		() => request,
		() => null,
	);
}

/** Where the app is, as far as it knows: to go back there when leaving by "back" is cancelled. */
let shown = typeof window === "undefined" ? "" : snapshot();
let listening = false;

function onPopState(): void {
	const target = snapshot();
	if (target === shown) return;
	if (blockingQuestion() === null) {
		shown = target;
		window.dispatchEvent(new Event(NAVIGATE_EVENT));
		return;
	}
	// The browser has moved already: put the page's address back, and go on if the admin says so.
	window.history.pushState(null, "", shown);
	askToLeave(() => navigate(target, { force: true }));
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
	if (blockingQuestion() === null) return;
	// Browsers show their own wording; this only asks them to ask.
	event.preventDefault();
	event.returnValue = "";
}

/**
 * Asks before leaving the page while `blocker` returns a question: links and `navigate()`
 * within the app, the browser's back and forward buttons, and closing or reloading the tab
 * (`beforeunload`, with the browser's own wording). Returns the function that stops it.
 */
export function addBlocker(blocker: Blocker): () => void {
	blockers.add(blocker);
	if (blockers.size === 1) window.addEventListener("beforeunload", onBeforeUnload);
	return () => {
		blockers.delete(blocker);
		if (blockers.size === 0) window.removeEventListener("beforeunload", onBeforeUnload);
	};
}

function subscribe(onChange: () => void): () => void {
	if (!listening) {
		listening = true;
		shown = snapshot();
		window.addEventListener("popstate", onPopState);
	}
	window.addEventListener(NAVIGATE_EVENT, onChange);
	return () => {
		window.removeEventListener(NAVIGATE_EVENT, onChange);
	};
}

export interface Location {
	readonly pathname: string;
	readonly search: URLSearchParams;
	/** `pathname` and `search`, for keys and comparisons. */
	readonly href: string;
}

export function useLocation(): Location {
	const href = useSyncExternalStore(subscribe, snapshot, snapshot);
	return useMemo(() => {
		const url = new URL(href, "http://localhost");
		return { pathname: url.pathname, search: url.searchParams, href };
	}, [href]);
}

export interface NavigateOptions {
	/** Replaces the current history entry (for redirects and filters) instead of adding one. */
	readonly replace?: boolean;
	/** Keeps the scroll position (for filters on the same view). */
	readonly keepScroll?: boolean;
	/** Leaves without asking about unsaved changes (after saving, or deleting, them). */
	readonly force?: boolean;
}

/**
 * Goes to `to` within the app. With unsaved changes, asks first: `false` then, and the
 * navigation happens once (if) the admin chooses to leave.
 */
export function navigate(to: string, options: NavigateOptions = {}): boolean {
	if (to === snapshot()) return true;
	if (!options.force && blockingQuestion() !== null) return askToLeave(() => navigate(to, { ...options, force: true }));
	if (options.replace) window.history.replaceState(null, "", to);
	else window.history.pushState(null, "", to);
	shown = snapshot();
	window.dispatchEvent(new Event(NAVIGATE_EVENT));
	if (!options.keepScroll) window.scrollTo?.(0, 0);
	return true;
}

/** Parameters of `pattern` (`/pages/:pageId`) in `pathname`, decoded; `null` when it does not match. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
	const parts = pattern.split("/").filter((part) => part !== "");
	const segments = pathname.split("/").filter((segment) => segment !== "");
	if (parts.length !== segments.length) return null;
	const params: Record<string, string> = {};
	for (const [index, part] of parts.entries()) {
		const segment = segments[index] as string;
		if (part.startsWith(":")) {
			try {
				params[part.slice(1)] = decodeURIComponent(segment);
			} catch {
				return null;
			}
		} else if (part !== segment) {
			return null;
		}
	}
	return params;
}

/** A path with `params` as its query (`undefined` and empty values left out). */
export function withQuery(path: string, params: Readonly<Record<string, string | undefined | null>>): string {
	const query = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") query.set(name, value);
	}
	const search = query.toString();
	return search === "" ? path : `${path}?${search}`;
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
	return (
		!event.defaultPrevented &&
		event.button === 0 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		!event.altKey &&
		(event.currentTarget.target === "" || event.currentTarget.target === "_self")
	);
}

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
	readonly href: string;
}

/** A link within the app: a plain click navigates without reloading. */
export function Link({ href, onClick, ...props }: LinkProps) {
	return (
		<a
			{...props}
			href={href}
			onClick={(event) => {
				onClick?.(event);
				if (!isPlainClick(event)) return;
				event.preventDefault();
				navigate(href);
			}}
		/>
	);
}
