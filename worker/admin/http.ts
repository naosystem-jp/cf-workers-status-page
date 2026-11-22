/** JSON responses, errors and request parsing for the admin API. */
import * as z from "zod";
import type { ApiError, ApiIssue, EditConflict } from "../../shared/admin-api";
import { isJsonRequest } from "./csrf";

/**
 * Largest request body accepted. Incident texts are limited well below this (shared/admin-api.ts).
 * A page's appearance has its own, larger limit (`FRAME_LIMITS.appearanceRequestBytes`).
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** On every admin API response: never cached, never sniffed. */
const API_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
} as const;

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: API_HEADERS });
}

export function noContent(): Response {
	return new Response(null, { status: 204, headers: API_HEADERS });
}

export function apiError(
	status: number,
	error: string,
	message: string,
	options: { readonly issues?: readonly ApiIssue[]; readonly reason?: string | undefined; readonly headers?: Record<string, string> } = {},
): Response {
	const body: ApiError = {
		error,
		message,
		...(options.issues === undefined ? {} : { issues: options.issues }),
		...(options.reason === undefined ? {} : { reason: options.reason }),
	};
	return Response.json(body, { status, headers: { ...API_HEADERS, ...options.headers } });
}

/**
 * The one response to every admin request that fails authentication, whatever its method
 * and path, so that it reveals nothing about what exists.
 */
export function forbidden(): Response {
	return apiError(403, "forbidden", "Sign in as an administrator to use the admin API");
}

export function notFound(what = "resource"): Response {
	return apiError(404, "not_found", `No such ${what}`);
}

/** 409 for an edit that started from an older version, with the current state. */
export function editConflict<T>(current: T): Response {
	const body: EditConflict<T> = {
		error: "edit_conflict",
		message: "Someone else saved a change after you started editing. Nothing was saved: review the current version and make your change again.",
		current,
	};
	return Response.json(body, { status: 409, headers: API_HEADERS });
}

export function validationFailed(issues: readonly ApiIssue[]): Response {
	return apiError(400, "validation_failed", "The request is invalid", { issues });
}

const ENGLISH = z.locales.en();

/** Values a client can put in a message. */
function scalars(values: Readonly<Record<string, unknown>>): Record<string, string | number> {
	return Object.fromEntries(
		Object.entries(values).flatMap(([name, value]) =>
			typeof value === "string" || typeof value === "number" ? [[name, value]] : typeof value === "bigint" ? [[name, Number(value)]] : [],
		),
	);
}

/**
 * A code for a client to say a Zod issue in its own language ({@link ApiIssue}): Zod's code and
 * values for its own checks, the API's for its refinements (`params.code`). None when a schema
 * wrote its own message (a notifier kind's check, say), which then stands as written.
 */
export function issueCode(issue: z.core.$ZodIssue): Pick<ApiIssue, "code" | "params"> {
	if (issue.code === "custom") {
		const params = issue.params ?? {};
		return typeof params["code"] === "string" ? { code: params["code"], params: scalars(params) } : {};
	}
	const generic = ENGLISH.localeError(issue as Parameters<typeof ENGLISH.localeError>[0]);
	if ((typeof generic === "string" ? generic : generic?.message) !== issue.message) return {};
	switch (issue.code) {
		case "too_small":
			return { code: issue.code, params: { origin: String(issue.origin), minimum: Number(issue.minimum) } };
		case "too_big":
			return { code: issue.code, params: { origin: String(issue.origin), maximum: Number(issue.maximum) } };
		case "invalid_format":
			return { code: issue.code, params: { format: issue.format } };
		case "invalid_value":
			return { code: issue.code, params: { values: issue.values.map(String).join(", ") } };
		case "invalid_type":
			return { code: issue.code, params: { expected: issue.expected } };
		case "unrecognized_keys":
			return { code: issue.code, params: { keys: issue.keys.join(", ") } };
		default:
			return { code: issue.code };
	}
}

/** Zod issues as JSON-friendly {@link ApiIssue}s, with codes for clients to translate. */
export function toIssues(error: z.ZodError): ApiIssue[] {
	return error.issues.map((issue) => ({
		path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
		message: issue.message,
		...issueCode(issue),
	}));
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response };

/**
 * Reads the body, stopping as soon as it exceeds `limit` bytes, so that a request without
 * (or with a false) Content-Length is never buffered beyond the limit. `null` when too large.
 */
export async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
	if (Number(request.headers.get("Content-Length") ?? "0") > limit) return null;
	if (request.body === null) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * Reads a JSON body and validates it with `schema`: 415 without a JSON content type, 413
 * when too large, 400 when it is not JSON or not valid.
 */
export async function readBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = MAX_BODY_BYTES): Promise<Parsed<T>> {
	if (!isJsonRequest(request)) {
		return {
			ok: false,
			response: apiError(415, "unsupported_media_type", "Send the request body as Content-Type: application/json"),
		};
	}
	const bytes = await readCapped(request, maxBytes);
	if (bytes === null) {
		return {
			ok: false,
			response: apiError(413, "payload_too_large", `The request body must be at most ${maxBytes} bytes`),
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { ok: false, response: apiError(400, "invalid_json", "The request body is not valid JSON") };
	}
	return validate(schema, value);
}

/** Validates `value` with `schema`; 400 with the Zod issues when it is invalid. */
export function validate<T>(schema: z.ZodType<T>, value: unknown, base: readonly (string | number)[] = []): Parsed<T> {
	const result = schema.safeParse(value);
	if (result.success) return { ok: true, value: result.data };
	return {
		ok: false,
		response: validationFailed(toIssues(result.error).map((issue) => ({ ...issue, path: [...base, ...issue.path] }))),
	};
}
