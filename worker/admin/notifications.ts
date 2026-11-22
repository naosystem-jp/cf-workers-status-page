/**
 * `/api/admin/notifications/*`: notifier kinds, notification targets, failed deliveries and
 * re-encryption of secrets.
 *
 * Secret options are write-only: they are accepted on create and edit, encrypted before they
 * are stored, and never returned or logged; responses say only whether each one is set.
 * Saving a target with secret options needs the `NOTIFICATION_KEYS` secret (503
 * `encryption_key_missing` without it).
 */
import type { NotifierKind } from "@naosystem/cf-workers-status-page-core";
import * as z from "zod";
import {
	type ApiIssue,
	type ComponentRef,
	createNotificationTargetSchema,
	DEFAULT_TARGET_EVENTS,
	LIMITS,
	type NotificationEvent,
	type NotifierKindInfo,
	type NotifierKindsResponse,
	patchNotificationTargetSchema,
	type ReEncryptResult,
	type TestNotificationResult,
} from "../../shared/admin-api";
import { config, findMonitor, findPage } from "../config";
import {
	decodeDeliveryCursor,
	deleteTarget,
	getTarget,
	insertTarget,
	listDeliveries,
	listTargets,
	replaceSecrets,
	type TargetChanges,
	type TargetFields,
	updateTarget,
} from "../db/notifications";
import { describeFailure, sendWithTimeout } from "../notifications/consumer";
import { EncryptionKeyError, encryptSecret, keyRing } from "../notifications/crypto";
import { renderTest } from "../notifications/render";
import {
	decryptOptions,
	destinationOption,
	destinationOrigin,
	destinationProblem,
	publicTarget,
	readSecrets,
	secretsUpToDate,
	secretValues,
	splitOptions,
} from "../notifications/targets";
import type { AdminContext } from "./context";
import { apiError, editConflict, json, noContent, notFound, readBody, toIssues, validate, validationFailed } from "./http";

function kindNamed(type: string): NotifierKind | undefined {
	return config.notifiers.find((kind) => kind.type === type);
}

const schemas = new Map<string, Record<string, unknown>>();

/** The kind's options as JSON Schema (what an administrator enters), secret ones marked `writeOnly`. */
export function optionsJsonSchema(kind: NotifierKind): Record<string, unknown> {
	const cached = schemas.get(kind.type);
	if (cached !== undefined) return cached;
	const schema = z.toJSONSchema(kind.options, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
	const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
	for (const key of kind.secretOptions) {
		const property = properties?.[key];
		if (properties !== undefined && property !== undefined) properties[key] = { ...property, writeOnly: true };
	}
	schemas.set(kind.type, schema);
	return schema;
}

function encryptionUnavailable(error: EncryptionKeyError): Response {
	return apiError(503, "encryption_key_missing", `${error.message}. Secret options cannot be saved until it is set.`);
}

/** Issues for monitors and components that status.config.ts does not have. */
function selectionIssues(monitors: readonly string[] | undefined, components: readonly ComponentRef[] | undefined): ApiIssue[] {
	const issues: ApiIssue[] = [];
	monitors?.forEach((id, index) => {
		if (findMonitor(id) === undefined) {
			issues.push({ path: ["monitors", index], message: `No monitor "${id}" in status.config.ts`, code: "unknown_monitor", params: { monitor: id } });
		}
	});
	components?.forEach((ref, index) => {
		const page = findPage(ref.pageId);
		if (page === undefined) {
			issues.push({
				path: ["components", index, "pageId"],
				message: `No page "${ref.pageId}" in status.config.ts`,
				code: "unknown_page",
				params: { page: ref.pageId },
			});
		} else if (!page.components.some((component) => component.id === ref.componentId)) {
			issues.push({
				path: ["components", index, "componentId"],
				message: `Page "${ref.pageId}" has no component "${ref.componentId}"`,
				code: "unknown_component",
				params: { page: ref.pageId, component: ref.componentId },
			});
		}
	});
	return issues;
}

/** Validates options against the kind, and that its destination is a public host; issues are located under `options`. */
function validateOptions(kind: NotifierKind, options: Record<string, unknown>): ApiIssue[] {
	const result = kind.options.safeParse(options);
	const issues = result.success ? [] : toIssues(result.error).map((issue) => ({ ...issue, path: ["options", ...issue.path] }));
	const problem = destinationProblem(kind, options);
	const destination = destinationOption({ options, secrets: {} }, kind);
	if (problem !== null && destination !== undefined) {
		issues.push({ path: ["options", destination], message: problem, code: "destination_not_public" });
	}
	return issues;
}

/**
 * Issues for a change of destination: when an edit moves a target to another origin (or
 * its current destination cannot be read), every other secret option it has must be entered
 * again or cleared (`null`), so that no secret it holds is sent to the new destination.
 */
function destinationChangeIssues(
	kind: NotifierKind,
	existing: { readonly options: Readonly<Record<string, unknown>>; readonly secrets: Readonly<Record<string, string>> },
	readable: Readonly<Record<string, unknown>>,
	unreadable: readonly string[],
	changes: Readonly<Record<string, unknown>>,
): ApiIssue[] {
	const destination = destinationOption(existing, kind);
	if (destination === undefined || !Object.hasOwn(changes, destination)) return [];
	const before = unreadable.includes(destination) ? undefined : destinationOrigin(readable[destination]);
	const after = destinationOrigin(changes[destination]);
	if (before !== undefined && before === after) return [];
	const stored = [...kind.secretOptions, ...Object.keys(existing.secrets)].filter(
		(key, index, keys) => keys.indexOf(key) === index && Object.hasOwn(existing.secrets, key),
	);
	return stored
		.filter((key) => key !== destination && !Object.hasOwn(changes, key))
		.map((key) => ({
			path: ["options", key],
			message: `The destination changed: enter "${key}" again, or set it to null to remove it. Secrets are never sent to a new destination.`,
			code: "secret_reentry_required",
			params: { option: key, destination },
		}));
}

function unknownIssue(admin: boolean, events: readonly NotificationEvent[]): ApiIssue[] {
	return !admin && events.includes("unknown")
		? [{ path: ["events"], message: "Only administrators' targets receive unknown", code: "unknown_needs_admin" }]
		: [];
}

/** `GET notifications/kinds`: the kinds registered in status.config.ts, and whether secrets can be encrypted. */
export async function kinds(admin: AdminContext): Promise<Response> {
	let encryption: NotifierKindsResponse["encryption"];
	try {
		const ring = await keyRing(admin.env);
		encryption = { configured: true, currentKeyId: ring.currentId, error: null };
	} catch (error) {
		if (!(error instanceof EncryptionKeyError)) throw error;
		encryption = { configured: false, currentKeyId: null, error: error.message };
	}
	const body: NotifierKindsResponse = {
		kinds: config.notifiers.map(
			(kind): NotifierKindInfo => ({
				type: kind.type,
				name: kind.name,
				secretOptions: kind.secretOptions,
				optionsSchema: optionsJsonSchema(kind),
				messages: kind.messages ?? {},
			}),
		),
		encryption,
	};
	return json(body);
}

/** `GET notifications/targets`: every target, by name. */
export async function list(admin: AdminContext): Promise<Response> {
	const targets = await listTargets(admin.env.DB);
	return json({ items: targets.map((target) => publicTarget(target, kindNamed(target.kind))), nextCursor: null });
}

export async function get(admin: AdminContext): Promise<Response> {
	const target = await getTarget(admin.env.DB, admin.params["id"] ?? "");
	return target === null ? notFound("notification target") : json(publicTarget(target, kindNamed(target.kind)));
}

export async function create(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, createNotificationTargetSchema);
	if (!body.ok) return body.response;
	const input = body.value;
	const kind = kindNamed(input.kind);
	if (kind === undefined) {
		return validationFailed([
			{ path: ["kind"], message: `No notifier kind "${input.kind}" in status.config.ts`, code: "unknown_kind", params: { kind: input.kind } },
		]);
	}
	const issues = [...validateOptions(kind, input.options), ...selectionIssues(input.monitors, input.components)];
	if (issues.length > 0) return validationFailed(issues);
	const id = crypto.randomUUID();
	let split: Awaited<ReturnType<typeof splitOptions>>;
	try {
		split = await splitOptions(admin.env, id, kind, input.options);
	} catch (error) {
		if (error instanceof EncryptionKeyError) return encryptionUnavailable(error);
		throw error;
	}
	const fields: TargetFields = {
		name: input.name,
		...split,
		admin: input.admin,
		enabled: input.enabled,
		events: input.events ?? (input.admin ? [...DEFAULT_TARGET_EVENTS, "unknown"] : DEFAULT_TARGET_EVENTS),
		allMonitors: input.allMonitors,
		monitors: input.monitors,
		components: input.components,
	};
	const target = await insertTarget(admin.env.DB, id, kind.type, fields, admin.actor);
	return json(publicTarget(target, kind), 201);
}

export async function patch(admin: AdminContext): Promise<Response> {
	const body = await readBody(admin.request, patchNotificationTargetSchema);
	if (!body.ok) return body.response;
	const { version, ...changes } = body.value;
	const existing = await getTarget(admin.env.DB, admin.params["id"] ?? "");
	if (existing === null) return notFound("notification target");
	const current = () => publicTarget(existing, kindNamed(existing.kind));
	if (existing.version !== version) return editConflict(current());

	// Written only when the options change (then all secrets are encrypted with the current key):
	// writing back what was read could undo a re-encryption that ran meanwhile.
	let options: TargetChanges["options"];
	let secrets: TargetChanges["secrets"];
	const issues: ApiIssue[] = [];
	if (changes.options !== undefined) {
		const kind = kindNamed(existing.kind);
		if (kind === undefined) {
			return validationFailed([
				{
					path: ["options"],
					message: `Notifier kind "${existing.kind}" is no longer in status.config.ts`,
					code: "kind_removed",
					params: { kind: existing.kind },
				},
			]);
		}
		try {
			const readable =
				Object.keys(existing.secrets).length === 0
					? { options: { ...existing.options }, errors: new Map() }
					: await readSecrets(await keyRing(admin.env), existing, kind);
			const unreadable = [...readable.errors.keys()];
			const merged = { ...readable.options };
			for (const key of unreadable) {
				// Undecryptable (its key was removed, or it belongs to another destination): it must be entered again.
				if (!Object.hasOwn(changes.options, key)) delete merged[key];
			}
			for (const [key, value] of Object.entries(changes.options)) {
				if (value === null) delete merged[key];
				else merged[key] = value;
			}
			issues.push(...destinationChangeIssues(kind, existing, readable.options, unreadable, changes.options));
			issues.push(...validateOptions(kind, merged));
			if (issues.length === 0) ({ options, secrets } = await splitOptions(admin.env, existing.id, kind, merged));
		} catch (error) {
			if (error instanceof EncryptionKeyError) return encryptionUnavailable(error);
			throw error;
		}
	}
	const fields: TargetChanges = {
		name: changes.name ?? existing.name,
		options,
		secrets,
		admin: changes.admin ?? existing.admin,
		enabled: changes.enabled ?? existing.enabled,
		events: changes.events ?? existing.events,
		allMonitors: changes.allMonitors ?? existing.allMonitors,
		monitors: changes.monitors ?? existing.monitors,
		components: changes.components ?? existing.components,
	};
	issues.push(...unknownIssue(fields.admin, fields.events), ...selectionIssues(changes.monitors, changes.components));
	if (issues.length > 0) return validationFailed(issues);
	const result = await updateTarget(admin.env.DB, existing.id, version, fields, admin.actor);
	switch (result.status) {
		case "not-found":
			return notFound("notification target");
		case "conflict":
			return editConflict(publicTarget(result.current, kindNamed(result.current.kind)));
		case "updated":
			return json(publicTarget(result.value, kindNamed(result.value.kind)));
	}
}

export async function remove(admin: AdminContext): Promise<Response> {
	return (await deleteTarget(admin.env.DB, admin.params["id"] ?? "")) ? noContent() : notFound("notification target");
}

/** `POST notifications/targets/:id/test`: sends a test notification now, and says whether it worked. */
export async function test(admin: AdminContext): Promise<Response> {
	const target = await getTarget(admin.env.DB, admin.params["id"] ?? "");
	if (target === null) return notFound("notification target");
	const kind = kindNamed(target.kind);
	if (kind === undefined) {
		return apiError(409, "kind_not_registered", `Notifier kind "${target.kind}" is no longer in status.config.ts`);
	}
	let secrets: string[] = [];
	let result: TestNotificationResult;
	try {
		const options = await decryptOptions(admin.env, target, kind);
		secrets = secretValues(target, options);
		const parsed = kind.options.safeParse(options);
		if (!parsed.success) {
			result = { ok: false, error: "The target's options are no longer valid; edit the target" };
		} else if (destinationProblem(kind, options) !== null) {
			result = { ok: false, error: "The target's destination is not a public host; edit the target" };
		} else {
			await sendWithTimeout(kind, renderTest(target.name, Date.now(), config.locale, config.timezone), parsed.data);
			result = { ok: true, error: null };
		}
	} catch (error) {
		result = { ok: false, error: describeFailure(error, secrets).message };
	}
	return json(result);
}

const deliveryQuerySchema = z.object({
	status: z.enum(["failed", "retrying", "sending", "sent"]).default("failed"),
	limit: z.coerce.number().int().min(1).max(LIMITS.pageSize).default(50),
	cursor: z
		.string()
		.transform((value, ctx) => {
			const cursor = decodeDeliveryCursor(value);
			if (cursor === undefined) {
				ctx.addIssue({ code: "custom", message: "Not a cursor from a previous page" });
				return z.NEVER;
			}
			return cursor;
		})
		.optional(),
});

/** `GET notifications/deliveries?status=failed`: deliveries by status (default: failed), latest change first. */
export async function deliveries(admin: AdminContext): Promise<Response> {
	const query = validate(deliveryQuerySchema, Object.fromEntries(admin.url.searchParams));
	if (!query.ok) return query.response;
	const { status, limit, cursor } = query.value;
	return json(await listDeliveries(admin.env.DB, { status, limit, after: cursor }));
}

/**
 * `POST notifications/re-encrypt`: encrypts every target's secrets with the current key (the
 * first in `NOTIFICATION_KEYS`), for rotating keys (see worker/notifications/crypto.ts), and
 * binds secrets stored before destinations were bound to their target's destination.
 */
export async function reEncrypt(admin: AdminContext): Promise<Response> {
	let ring: Awaited<ReturnType<typeof keyRing>>;
	try {
		ring = await keyRing(admin.env);
	} catch (error) {
		if (error instanceof EncryptionKeyError) return encryptionUnavailable(error);
		throw error;
	}
	const result: { -readonly [K in keyof ReEncryptResult]: ReEncryptResult[K] } & { failed: ReEncryptResult["failed"][number][] } = {
		currentKeyId: ring.currentId,
		reEncrypted: 0,
		unchanged: 0,
		failed: [],
	};
	for (const target of await listTargets(admin.env.DB)) {
		const kind = kindNamed(target.kind);
		// Up to date: the current key, and bound to the destination (values from before are not).
		if (secretsUpToDate(ring, target, kind)) {
			result.unchanged++;
			continue;
		}
		try {
			const { options, errors } = await readSecrets(ring, target, kind);
			const [failure] = errors.values();
			if (failure !== undefined) throw failure;
			const destination = destinationOption(target, kind);
			const origin = destination === undefined ? undefined : destinationOrigin(options[destination]);
			const secrets: Record<string, string> = {};
			for (const key of Object.keys(target.secrets)) {
				secrets[key] = await encryptSecret(ring, target.id, key, JSON.stringify(options[key]), key === destination ? undefined : origin);
			}
			if (await replaceSecrets(admin.env.DB, target.id, target.secrets, secrets)) result.reEncrypted++;
			// Otherwise it was saved meanwhile, which encrypted it with the current key.
			else result.unchanged++;
		} catch (error) {
			result.failed.push({ id: target.id, name: target.name, error: error instanceof Error ? error.message : String(error) });
		}
	}
	console.log(`Re-encrypted the secrets of ${result.reEncrypted} notification targets with key "${ring.currentId}"`);
	return json(result satisfies ReEncryptResult);
}
