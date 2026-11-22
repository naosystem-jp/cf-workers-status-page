/**
 * Request schemas and response types of the admin API (`/api/admin/*`), shared by the
 * Worker and the admin UI. The UI can validate forms with the same Zod schemas before
 * sending; the Worker validates again, and also checks what only it knows (that pages and
 * components exist in status.config.ts).
 *
 * Conventions:
 * - Times are epoch milliseconds (integers), as everywhere else in the hub.
 * - Objects are strict: unknown keys are rejected, so a misspelt field is an error.
 * - Text is trimmed.
 * - Edits are optimistic: an incident, a maintenance and a page's
 *   appearance have a `version`, which an edit sends back as it was when the editor started.
 *   When someone else saved in between, the edit is refused with 409 `edit_conflict` and the
 *   current state ({@link EditConflict}). Posting a timeline update never conflicts.
 */
import type { CheckState, LocationHint, PageTemplate, SchedulePeriod, StateRecord } from "@naosystem/cf-workers-status-page-core";
import * as z from "zod";
import {
	type AppearanceColors,
	type ColorRole,
	type ColorScheme,
	HEX_COLOR,
	IMAGE_ID,
	IMPACTS,
	INCIDENT_STAGES,
	type IncidentStage,
	LIMITS,
	NOTIFICATION_EVENTS,
	type NotificationEvent,
} from "./vocabulary";

// The vocabulary and limits live in a module without Zod, for the admin UI (see vocabulary.ts).
export {
	type AppearanceColors,
	COLOR_ROLES,
	COLOR_SCHEMES,
	type ColorRole,
	type ColorScheme,
	DEFAULT_TARGET_EVENTS,
	HEX_COLOR,
	IMAGE_CONTENT_TYPES,
	IMAGE_ID,
	IMAGE_TYPES,
	type ImageExtension,
	imagePath,
	IMPACTS,
	type Impact,
	INCIDENT_STAGES,
	type IncidentStage,
	LIMITS,
	NO_COLORS,
	NOTIFICATION_EVENTS,
	type NotificationEvent,
	START_TIME_TOLERANCE_MS,
	type ThemeColors,
} from "./vocabulary";

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** Epoch milliseconds, within the range of `Date`. */
export const timestampSchema = z.int().min(0).max(8_640_000_000_000_000);

/** A refinement's message, with a code the admin UI translates (see {@link ApiIssue}). */
const NOTHING_TO_CHANGE = { message: "Nothing to change", params: { code: "nothing_to_change" } };

/** The `version` an edit started from (see the module documentation). */
const versionSchema = z.int().min(0);

const idSchema = z.string().min(1).max(64);
const titleSchema = z.string().trim().min(1).max(LIMITS.title);
const bodySchema = z.string().trim().min(1).max(LIMITS.body);

function uniqueBy<T>(key: (item: T) => string) {
	return (items: readonly T[], ctx: z.core.$RefinementCtx<T[]>) => {
		const seen = new Set<string>();
		items.forEach((item, index) => {
			const value = key(item);
			if (seen.has(value)) {
				ctx.addIssue({ code: "custom", message: `"${value}" is listed twice`, path: [index], params: { code: "duplicate", value } });
			}
			seen.add(value);
		});
	};
}

export const affectedComponentSchema = z.strictObject({
	/** A component ID of the incident's page. */
	id: idSchema,
	impact: z.enum(IMPACTS),
});
export type AffectedComponent = z.infer<typeof affectedComponentSchema>;

const affectedComponentsSchema = z
	.array(affectedComponentSchema)
	.max(LIMITS.components)
	.superRefine(uniqueBy((component: AffectedComponent) => component.id));

export const createIncidentSchema = z.strictObject({
	pageId: idSchema,
	title: titleSchema,
	/**
	 * When the incident began, if earlier than now: the outage started at 10:00 and the
	 * incident is written at 10:20. Not in the future. Default: now.
	 */
	startedAt: timestampSchema.optional(),
	/** Stage of the first update. */
	stage: z.enum(INCIDENT_STAGES).default("investigating"),
	/** Message of the first update. */
	body: bodySchema,
	components: affectedComponentsSchema.default([]),
});
export type CreateIncident = z.input<typeof createIncidentSchema>;

/** Changes the incident itself. The stage changes only by posting an update. */
export const patchIncidentSchema = z
	.strictObject({
		/** The incident's `version` when the editor started. */
		version: versionSchema,
		title: titleSchema.optional(),
		/** Replaces the affected components. */
		components: affectedComponentsSchema.optional(),
	})
	.refine((value) => value.title !== undefined || value.components !== undefined, NOTHING_TO_CHANGE);
export type PatchIncident = z.input<typeof patchIncidentSchema>;

/**
 * A timeline entry. Posting a stage other than `resolved` to a resolved incident reopens it.
 * Never conflicts, unless it sends `version`; with `components`, it counts as a change to them
 * (the `version` goes up).
 */
export const postIncidentUpdateSchema = z.strictObject({
	stage: z.enum(INCIDENT_STAGES),
	body: bodySchema,
	/** Also replaces the affected components, in the same change. */
	components: affectedComponentsSchema.optional(),
	/**
	 * Optional, with `components`: the incident's `version` the components were read at. When
	 * someone changed the incident since, nothing is posted (409 `edit_conflict`), so that an
	 * update cannot silently undo their change of the components.
	 */
	version: versionSchema.optional(),
});
export type PostIncidentUpdate = z.input<typeof postIncidentUpdateSchema>;

/** Shorthand for posting a `resolved` update. */
export const resolveIncidentSchema = z.strictObject({ body: bodySchema });
export type ResolveIncident = z.input<typeof resolveIncidentSchema>;

const maintenanceComponentsSchema = z
	.array(idSchema)
	.min(1)
	.max(LIMITS.components)
	.superRefine(uniqueBy((id: string) => id));

const maintenanceFields = {
	title: titleSchema,
	body: z.string().trim().max(LIMITS.body),
	startsAt: timestampSchema,
	endsAt: timestampSchema,
	/** Component IDs of the page under maintenance. */
	components: maintenanceComponentsSchema,
};

function endsAfterStart(value: { startsAt?: number | undefined; endsAt?: number | undefined }, ctx: z.core.$RefinementCtx) {
	if (value.startsAt !== undefined && value.endsAt !== undefined && value.endsAt <= value.startsAt) {
		ctx.addIssue({ code: "custom", message: "Must be later than startsAt", path: ["endsAt"], params: { code: "ends_before_start" } });
	}
}

export const createMaintenanceSchema = z
	.strictObject({
		pageId: idSchema,
		...maintenanceFields,
		body: maintenanceFields.body.default(""),
	})
	.superRefine(endsAfterStart);
export type CreateMaintenance = z.input<typeof createMaintenanceSchema>;

/** Changes some fields. The merged result must still end after it starts. */
export const patchMaintenanceSchema = z
	.strictObject({
		/** The maintenance's `version` when the editor started. */
		version: versionSchema,
		title: maintenanceFields.title.optional(),
		body: maintenanceFields.body.optional(),
		startsAt: maintenanceFields.startsAt.optional(),
		endsAt: maintenanceFields.endsAt.optional(),
		components: maintenanceFields.components.optional(),
	})
	.refine(
		(value) => Object.entries(value).some(([key, field]) => key !== "version" && field !== undefined),
		NOTHING_TO_CHANGE,
	)
	.superRefine(endsAfterStart);
export type PatchMaintenance = z.input<typeof patchMaintenanceSchema>;

const httpUrlSchema = z.httpUrl().max(LIMITS.url);
/**
 * An image the public page loads from another site: https only, so that it is never mixed
 * content and the page's Content-Security-Policy can allow https images only.
 */
const httpsUrlSchema = httpUrlSchema.refine((value) => value.startsWith("https://"), {
	message: "must be an https URL",
	params: { code: "https_required" },
});

/** An image uploaded with `POST /api/admin/pages/:pageId/images` ({@link UploadedImage}`.id`). */
const imageIdSchema = z.string().regex(IMAGE_ID);

/** `#rrggbb`, in either case; stored in lower case. */
const hexColorSchema = z
	.string()
	.trim()
	.toLowerCase()
	.refine((value) => HEX_COLOR.test(value), { message: "must be a colour as #rrggbb", params: { code: "hex_color" } });

/** One colour scheme's colours; `null` keeps the template's. */
const themeColorsSchema = z.strictObject({
	background: hexColorSchema.nullable(),
	header: hexColorSchema.nullable(),
	accent: hexColorSchema.nullable(),
} satisfies Record<ColorRole, unknown>);

/** The page's colours in light and in dark mode, each set separately (see `COLOR_ROLES`). */
export const appearanceColorsSchema = z.strictObject({
	light: themeColorsSchema,
	dark: themeColorsSchema,
} satisfies Record<ColorScheme, unknown>);

/**
 * Replaces the page's appearance. `null` falls back to the default. The fields added after the
 * first four (`logoImage`, `faviconImage`, `colors`) may be left out: they then keep their
 * current values, so that clients written before them keep working.
 */
export const pageAppearanceSchema = z.strictObject({
	/** The appearance's `version` when the editor started; `0` while the page uses the defaults. */
	version: versionSchema,
	/** Heading and document title. Default: the page ID. */
	title: z.string().trim().min(1).max(LIMITS.appearanceTitle).nullable(),
	/** A line under the heading. */
	description: z.string().trim().min(1).max(LIMITS.appearanceDescription).nullable(),
	/** Image shown instead of the title text (https). An uploaded `logoImage` takes its place. */
	logoUrl: httpsUrlSchema.nullable(),
	/** Where the heading links to, such as the organisation's website (http or https). */
	websiteUrl: httpUrlSchema.nullable(),
	/** An uploaded image shown instead of the title text, before `logoUrl`. */
	logoImage: imageIdSchema.nullable().optional(),
	/** An uploaded image for the browser tab and bookmarks. */
	faviconImage: imageIdSchema.nullable().optional(),
	/** `null` for the template's colours throughout. */
	colors: appearanceColorsSchema.nullable().optional(),
});
export type PageAppearanceInput = z.input<typeof pageAppearanceSchema>;
export type AppearanceColorsInput = z.input<typeof appearanceColorsSchema>;

// ---------------------------------------------------------------------------
// Notification targets
// ---------------------------------------------------------------------------

/** A component of a page, as a target's selection names it. */
export const componentRefSchema = z.strictObject({ pageId: idSchema, componentId: idSchema });
export type ComponentRef = z.infer<typeof componentRefSchema>;

const targetNameSchema = z.string().trim().min(1).max(LIMITS.targetName);
const targetEventsSchema = z
	.array(z.enum(NOTIFICATION_EVENTS))
	.max(NOTIFICATION_EVENTS.length)
	.superRefine(uniqueBy((event: string) => event));
const targetMonitorsSchema = z
	.array(idSchema)
	.max(LIMITS.targetMonitors)
	.superRefine(uniqueBy((id: string) => id));
const targetComponentsSchema = z
	.array(componentRefSchema)
	.max(LIMITS.targetComponents)
	.superRefine(uniqueBy((ref: ComponentRef) => `${ref.pageId}/${ref.componentId}`));
/**
 * A target's options as an object, validated by the Worker against the kind's schema (see
 * `GET /api/admin/notifications/kinds`). Secret options may be sent but are never returned.
 */
const targetOptionsSchema = z.record(z.string(), z.unknown());

function unknownNeedsAdmin(value: { admin?: boolean | undefined; events?: readonly string[] | undefined }, ctx: z.core.$RefinementCtx) {
	if (value.admin === false && value.events?.includes("unknown")) {
		ctx.addIssue({
			code: "custom",
			message: "Only administrators' targets receive unknown",
			path: ["events"],
			params: { code: "unknown_needs_admin" },
		});
	}
}

/**
 * A new target. Which monitors it covers: every monitor with `allMonitors` (the default),
 * otherwise those listed in `monitors` and those shown by the listed `components`.
 */
export const createNotificationTargetSchema = z
	.strictObject({
		name: targetNameSchema,
		/** A notifier kind registered in status.config.ts, such as `slack`. Cannot change later. */
		kind: idSchema,
		options: targetOptionsSchema,
		/** An administrators' target: it receives `unknown` and links to the admin UI. */
		admin: z.boolean().default(false),
		enabled: z.boolean().default(true),
		/** Default: {@link DEFAULT_TARGET_EVENTS}, plus `unknown` for an administrators' target. */
		events: targetEventsSchema.optional(),
		allMonitors: z.boolean().default(true),
		monitors: targetMonitorsSchema.default([]),
		components: targetComponentsSchema.default([]),
	})
	.superRefine(unknownNeedsAdmin);
export type CreateNotificationTarget = z.input<typeof createNotificationTargetSchema>;

/**
 * Changes a target. `options` holds only the options to change: others, secret ones included,
 * keep their value; `null` removes an optional one. The kind never changes.
 */
export const patchNotificationTargetSchema = z
	.strictObject({
		/** The target's `version` when the editor started. */
		version: versionSchema,
		name: targetNameSchema.optional(),
		options: targetOptionsSchema.optional(),
		admin: z.boolean().optional(),
		enabled: z.boolean().optional(),
		events: targetEventsSchema.optional(),
		allMonitors: z.boolean().optional(),
		monitors: targetMonitorsSchema.optional(),
		components: targetComponentsSchema.optional(),
	})
	.refine(
		(value) => Object.entries(value).some(([key, field]) => key !== "version" && field !== undefined),
		NOTHING_TO_CHANGE,
	);
export type PatchNotificationTarget = z.input<typeof patchNotificationTargetSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface IncidentUpdate {
	readonly id: string;
	readonly stage: IncidentStage;
	readonly body: string;
	readonly createdAt: number;
	/** Who posted it; `null` for automation. */
	readonly author: string | null;
	readonly automated: boolean;
}

export interface Incident {
	readonly id: string;
	readonly pageId: string;
	readonly title: string;
	/** Stage of the latest update. */
	readonly stage: IncidentStage;
	readonly components: readonly AffectedComponent[];
	/** When the incident began: history and uptime use this. At or before `createdAt`. */
	readonly startedAt: number;
	/** When it was written. */
	readonly createdAt: number;
	readonly updatedAt: number;
	/** `null` while open. */
	readonly resolvedAt: number | null;
	/** Who created it; `null` when automation did (`incidents.auto`). */
	readonly createdBy: string | null;
	readonly updatedBy: string | null;
	readonly autoCreated: boolean;
	/** Last change by an administrator. Automation never resolves an incident with one. */
	readonly humanEditedAt: number | null;
	/** Send it back with an edit (see the module documentation). */
	readonly version: number;
}

export interface IncidentWithUpdates extends Incident {
	/** Oldest first. */
	readonly updates: readonly IncidentUpdate[];
}

export interface Maintenance {
	readonly id: string;
	readonly pageId: string;
	readonly title: string;
	readonly body: string;
	readonly components: readonly string[];
	readonly startsAt: number;
	readonly endsAt: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: string | null;
	readonly updatedBy: string | null;
	/** Send it back with an edit. */
	readonly version: number;
}

export interface PageAppearance {
	readonly pageId: string;
	readonly title: string | null;
	readonly description: string | null;
	readonly logoUrl: string | null;
	readonly websiteUrl: string | null;
	/** The uploaded logo's ID, or `null`; shown instead of `logoUrl`. */
	readonly logoImage: string | null;
	/** The uploaded favicon's ID, or `null`. */
	readonly faviconImage: string | null;
	/** Every scheme and role, `null` where the template's colour applies. */
	readonly colors: AppearanceColors;
	/** `null` while the page uses the defaults. */
	readonly updatedAt: number | null;
	readonly updatedBy: string | null;
	/** Send it back with an edit; `0` while the page uses the defaults. */
	readonly version: number;
}

/** A page of a list, latest first. Pass `nextCursor` as `cursor` for the next page. */
export interface ListPage<T> {
	readonly items: readonly T[];
	readonly nextCursor: string | null;
}

/** A validation problem, located like Zod locates it, for showing next to a form field. */
export interface ApiIssue {
	readonly path: readonly (string | number)[];
	/** In English. */
	readonly message: string;
	/**
	 * What the problem is, for a client to say in its own language (with `params`): Zod's codes
	 * for its own checks (`too_small`, `too_big`, `invalid_format`, `invalid_value`,
	 * `invalid_type`, `unrecognized_keys`), and the API's (`duplicate`, `nothing_to_change`,
	 * `ends_before_start`, `start_in_future`, `unknown_needs_admin`, `unknown_page`, `page_removed`,
	 * `unknown_component`, `unknown_monitor`, `unknown_kind`, `kind_removed`). Absent when the
	 * message is particular (a notifier kind's own check, say): show the message.
	 */
	readonly code?: string;
	readonly params?: Readonly<Record<string, string | number>>;
}

/** The body of every error response. */
export interface ApiError {
	/** Machine-readable, such as `validation_failed` or `not_found`. */
	readonly error: string;
	/** In English. */
	readonly message: string;
	readonly issues?: readonly ApiIssue[];
	/**
	 * Why, for some errors, machine-readable: for `purge_refused`, `configured` (the monitor is in
	 * status.config.ts), `running` (it still runs) or `deploying` (a deploy is in progress).
	 */
	readonly reason?: string;
}

/** 409 `edit_conflict`: someone else saved first. `current` is what they saved. */
export interface EditConflict<T> extends ApiError {
	readonly error: "edit_conflict";
	readonly current: T;
}

/** A notifier kind registered in status.config.ts, for the admin UI's target form. */
export interface NotifierKindInfo {
	readonly type: string;
	readonly name: string;
	/** Options that are encrypted and never returned. Also marked `writeOnly` in `optionsSchema`. */
	readonly secretOptions: readonly string[];
	/** The options as JSON Schema (draft 2020-12), for what an administrator enters. */
	readonly optionsSchema: Record<string, unknown>;
	/**
	 * Texts for the form by language (`{}` when the kind has none): `"$kind"` its name,
	 * `"<option>.title"` and `"<option>.description"` (see `NotifierKind.messages` in core).
	 */
	readonly messages: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface NotifierKindsResponse {
	readonly kinds: readonly NotifierKindInfo[];
	/**
	 * Whether the encryption key for secret options is set (the `NOTIFICATION_KEYS` Worker
	 * secret), and the ID of the key that encrypts new values. Without it, targets with secret
	 * options cannot be saved.
	 */
	readonly encryption: { readonly configured: boolean; readonly currentKeyId: string | null; readonly error: string | null };
}

export interface NotificationTarget {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	/** Options that are not secret. */
	readonly options: Readonly<Record<string, unknown>>;
	/** For each secret option of the kind, whether it has a value. Values are never returned. */
	readonly secrets: Readonly<Record<string, boolean>>;
	readonly admin: boolean;
	readonly enabled: boolean;
	readonly events: readonly NotificationEvent[];
	readonly allMonitors: boolean;
	readonly monitors: readonly string[];
	readonly components: readonly ComponentRef[];
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: string | null;
	readonly updatedBy: string | null;
	/** Send it back with an edit. */
	readonly version: number;
}

/** Status of a notification to one target: being sent, sent, waiting for a retry, or given up. */
export type DeliveryStatus = "sending" | "sent" | "retrying" | "failed";

/** One notification to one target: the admin UI lists those that failed. */
export interface NotificationDelivery {
	readonly notificationId: string;
	readonly targetId: string;
	/** `null` when the target was deleted since. */
	readonly targetName: string | null;
	readonly event: NotificationEvent;
	readonly monitorId: string | null;
	/** When the event happened. */
	readonly occurredAt: number;
	readonly status: DeliveryStatus;
	readonly attempts: number;
	/** The last error, with secret options removed. */
	readonly lastError: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** The outcome of `POST /api/admin/notifications/targets/:id/test`. */
export interface TestNotificationResult {
	readonly ok: boolean;
	/** Why it failed, with secret options removed. */
	readonly error: string | null;
}

/** The outcome of `POST /api/admin/notifications/re-encrypt`. */
export interface ReEncryptResult {
	/** The key every secret option is now encrypted with. */
	readonly currentKeyId: string;
	readonly reEncrypted: number;
	readonly unchanged: number;
	/** Targets whose secrets could not be decrypted (their key is no longer in `NOTIFICATION_KEYS`). */
	readonly failed: readonly { readonly id: string; readonly name: string; readonly error: string }[];
}

/** `GET /api/admin/me`: the signed-in administrator. */
export interface AdminMe {
	readonly identity: { readonly id: string; readonly email?: string };
	/** How changes are attributed (`createdBy`, `updatedBy`). */
	readonly author: string | null;
}

/** A component of a page in status.config.ts. */
export interface AdminComponent {
	readonly id: string;
	readonly name: string;
	/** IDs of the monitors that set its state; empty for a component that only incidents set. */
	readonly monitors: readonly string[];
}

/** A page in status.config.ts, for the admin UI's forms. */
export interface AdminPage {
	readonly id: string;
	/** How the page is shown (status.config.ts): the admin UI previews its colours in it. */
	readonly template: PageTemplate;
	readonly incidents: {
		readonly auto: boolean;
		readonly templates: Readonly<Record<string, string | undefined>>;
		/** `incidents.reopenWithin`: how long after automation resolved an incident a new `down` reopens it; 0 for never. */
		readonly reopenWithinMs: number;
	};
	readonly components: readonly AdminComponent[];
}

/** `GET /api/admin/pages` */
export interface AdminPagesResponse {
	readonly pages: readonly AdminPage[];
	/** Whether images can be uploaded: the Worker has its R2 bucket (`UPLOADS`). */
	readonly uploads: boolean;
}

/** `POST /api/admin/pages/:pageId/images`: an image stored for the page, to name in its appearance. */
export interface UploadedImage {
	/** Random, and new for every upload (uploading the same file again gives another ID), with the extension. */
	readonly id: string;
	/** Where the public page loads it from (a path on this site). */
	readonly url: string;
	readonly contentType: string;
	readonly size: number;
}

/** A monitor's latest check of any outcome. */
export interface AdminLastCheck {
	readonly at: number;
	readonly runner: string;
	/** `null` when the check produced no result (a missing secret, a runner failure). */
	readonly state: CheckState | null;
	readonly latencyMs: number | null;
	readonly message: string | null;
}

/** What a monitor's Durable Object reports about itself (worker/monitor.ts `MonitorSnapshot`). */
export interface AdminMonitorSnapshot {
	readonly monitorId: string;
	readonly configured: boolean;
	readonly startedAt: number | null;
	readonly period: SchedulePeriod | null;
	/** The latest state record: the confirmed state, `unconfirmed`, or `stopped`. */
	readonly current: StateRecord | null;
	readonly recentSince: number | null;
	readonly lastCheck: AdminLastCheck | null;
	readonly lastResultAt: number | null;
}

/** A monitor as `GET /api/admin/monitors` lists it: configured, or removed with its data kept. */
export interface AdminMonitor {
	readonly id: string;
	/** Whether this version's status.config.ts has it. */
	readonly configured: boolean;
	/** Its settings in status.config.ts; `null` when it is not configured. */
	readonly config: {
		readonly name: string;
		readonly type: string;
		readonly intervalMs: number;
		readonly timeoutMs: number;
		readonly location: LocationHint | null;
	} | null;
	/** Components that show it, per page. */
	readonly components: readonly ComponentRef[];
	/** The registry's entry; `null` until the monitor first started. A `removed` monitor's data stays until purged. */
	readonly registry: {
		readonly id: string;
		readonly status: "active" | "removed";
		readonly location: LocationHint | null;
		readonly firstSeenAt: number;
		readonly statusChangedAt: number;
	} | null;
	/** Its current state from its Durable Object; `null` when that could not be read (see `snapshotError`). */
	readonly snapshot: AdminMonitorSnapshot | null;
	readonly snapshotError: string | null;
}

/** `GET /api/admin/monitors` */
export interface AdminMonitorsResponse {
	readonly monitors: readonly AdminMonitor[];
}
