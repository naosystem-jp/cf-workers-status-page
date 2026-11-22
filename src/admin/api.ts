/**
 * The admin API client (README "Admin API"). Requests are same-origin JSON, which is what the
 * API's cross-site checks accept (worker/admin/csrf.ts): the browser sends `Sec-Fetch-Site:
 * same-origin` and its own `Origin`, and bodies are `application/json`.
 *
 * Redirects are not followed: the API never redirects, but Cloudflare Access does when the
 * sign-in has expired, to its login page on another site, which a script cannot follow. That
 * becomes the error `signed_out`, so the UI can ask to reload the page and sign in again.
 */
import type { ApiError, ApiIssue, EditConflict } from "../../shared/admin-api";

export class AdminApiError extends Error {
	/** HTTP status; `0` when there was no response (network) or Access redirected (`signed_out`). */
	readonly status: number;
	/** The API's error code (`validation_failed`, `edit_conflict`, …), or `network` / `signed_out`. */
	readonly code: string;
	/** Validation problems, located by path in the request body. */
	readonly issues: readonly ApiIssue[];
	/** The whole error body (for `edit_conflict`: `current`). */
	readonly body: unknown;

	constructor(status: number, code: string, message: string, issues: readonly ApiIssue[] = [], body: unknown = null) {
		super(message);
		this.name = "AdminApiError";
		this.status = status;
		this.code = code;
		this.issues = issues;
		this.body = body;
	}
}

/** Whether `error` is a 409 `edit_conflict` (someone else saved first), with what they saved. */
export function isEditConflict<T>(error: unknown): error is AdminApiError & { readonly body: EditConflict<T> } {
	return (
		error instanceof AdminApiError &&
		error.status === 409 &&
		error.code === "edit_conflict" &&
		typeof error.body === "object" &&
		error.body !== null &&
		"current" in error.body
	);
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The `fetch` used; tests replace it. */
export const transport: { fetch: typeof fetch } = { fetch: (input, init) => globalThis.fetch(input, init) };

/** A request body and its media type: JSON, or a file sent as it is (an upload). */
interface Body {
	readonly content: string | Blob;
	readonly contentType: string;
}

export async function adminApi<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	return send<T>(method, path, body === undefined ? undefined : { content: JSON.stringify(body), contentType: "application/json" }, signal);
}

async function send<T>(method: Method, path: string, body: Body | undefined, signal?: AbortSignal): Promise<T> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (body !== undefined) headers["Content-Type"] = body.contentType;
	let response: Response;
	try {
		response = await transport.fetch(`/api/admin${path}`, {
			method,
			headers,
			body: body?.content,
			credentials: "same-origin",
			redirect: "manual",
			cache: "no-store",
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new AdminApiError(0, "network", error instanceof Error ? error.message : String(error));
	}
	if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
		throw new AdminApiError(0, "signed_out", "The sign-in has expired");
	}
	if (response.status === 204) return undefined as T;
	let parsed: unknown = null;
	try {
		parsed = await response.json();
	} catch {
		if (response.ok) throw new AdminApiError(response.status, "invalid_response", "The response is not JSON");
	}
	if (!response.ok) {
		const error = (parsed ?? {}) as Partial<ApiError>;
		throw new AdminApiError(
			response.status,
			typeof error.error === "string" ? error.error : `http_${response.status}`,
			typeof error.message === "string" ? error.message : `HTTP ${response.status}`,
			Array.isArray(error.issues) ? error.issues : [],
			parsed,
		);
	}
	return parsed as T;
}

export const api = {
	get: <T>(path: string, signal?: AbortSignal) => adminApi<T>("GET", path, undefined, signal),
	post: <T>(path: string, body: unknown) => adminApi<T>("POST", path, body),
	put: <T>(path: string, body: unknown) => adminApi<T>("PUT", path, body),
	patch: <T>(path: string, body: unknown) => adminApi<T>("PATCH", path, body),
	delete: (path: string) => adminApi<void>("DELETE", path),
	/**
	 * Sends a file as the request body with its media type (an image upload): not JSON, which
	 * the API's cross-site checks accept for image types only (worker/admin/pages.ts).
	 */
	upload: <T>(path: string, file: Blob, contentType: string) => send<T>("POST", path, { content: file, contentType }),
};

/** `path` with a query string; empty values are left out. */
export function query(path: string, params: Readonly<Record<string, string | number | null | undefined>>): string {
	const search = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") search.set(name, String(value));
	}
	const text = search.toString();
	return text === "" ? path : `${path}?${text}`;
}

export const enc = encodeURIComponent;
