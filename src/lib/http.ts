/** Reading the public API: JSON with the server's clock, and errors as {@link HttpError}. */

export class HttpError extends Error {
	/** HTTP status; `0` when the request did not complete (offline, blocked). */
	readonly status: number;
	/** The API's error code (`not_found`, …), when it sent one. */
	readonly code: string | null;

	constructor(status: number, code: string | null, message: string) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.code = code;
	}
}

export interface Fetched<T> {
	readonly body: T;
	/** The server's clock when this response was sent: its `Date` plus its `Age` (time in a cache); `null` without a `Date`. */
	readonly serverDate: number | null;
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<Fetched<T>> {
	let response: Response;
	try {
		// `no-cache`: never a copy the browser kept without asking the server (polling wants what is current).
		response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-cache", signal });
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new HttpError(0, null, error instanceof Error ? error.message : String(error));
	}
	if (!response.ok) {
		let code: string | null = null;
		let message = `HTTP ${response.status}`;
		try {
			const body = (await response.json()) as { error?: unknown; message?: unknown };
			if (typeof body.error === "string") code = body.error;
			if (typeof body.message === "string") message = body.message;
		} catch {
			// Not JSON (a proxy's error page): the status says enough.
		}
		throw new HttpError(response.status, code, message);
	}
	const date = Date.parse(response.headers.get("Date") ?? "");
	// A shared cache (Workers Cache) may answer with a copy: `Age` says how long it kept it.
	const age = Number(response.headers.get("Age") ?? "0");
	return {
		body: (await response.json()) as T,
		serverDate: Number.isNaN(date) ? null : date + (Number.isFinite(age) && age > 0 ? age * 1000 : 0),
	};
}

/** Whether retrying cannot help: the resource does not exist. */
export function isNotFound(error: unknown): boolean {
	return error instanceof HttpError && error.status === 404;
}
