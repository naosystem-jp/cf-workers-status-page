import * as z from "zod";
import type { AuthProvider } from "./auth";
import { type Duration, durationSchema } from "./duration";
import { LOCATION_HINTS, type LocationHint } from "./location";
import { type MonitorDefinition, RESERVED_MONITOR_KEYS } from "./monitor";
import type { NotifierKind } from "./notifier";
import {
	FRAME_LIMITS,
	type FooterConfig,
	footerSchema,
	type HeaderConfig,
	headerSchema,
	type LocalizedText,
	localizedTextSchema,
	type ResolvedFrame,
} from "./frame";
import { DEFAULT_PAGE_TEMPLATE, PAGE_TEMPLATES, type PageTemplate } from "./page-templates";
import type { CheckProvider } from "./provider";
import { missingCapabilities, type RunnerDeclaration } from "./runner";
import { secretNames } from "./secret";

// ---------------------------------------------------------------------------
// Input: what users write in status.config.ts
// ---------------------------------------------------------------------------

export interface StatusConfig {
	/** IANA time zone that decides where each day starts for daily uptime. Default: `"UTC"`. */
	timezone?: string;
	/** Default location for monitors; each monitor can override it. When omitted, Cloudflare chooses. */
	location?: LocationHint;
	/**
	 * How long check results are kept: at least `"1d"`, and at least 10 times every monitor's
	 * `interval`. Default: forever. Shortening it deletes older results, gradually, and they
	 * cannot be recovered.
	 */
	retention?: Duration;
	/**
	 * Authentication for the admin UI and admin API.
	 * When omitted, both reject every request.
	 */
	auth?: AuthProvider;
	/** Notifier kinds offered in the admin UI. Targets and their secrets are not configured here. */
	notifiers?: readonly NotifierKind[];
	/**
	 * Language of notifications and of the text of automatic incidents, as a BCP 47 tag
	 * such as `"ja"`. Default: `"en"`. A language without a translation falls back to English.
	 */
	locale?: string;
	/**
	 * Where this deployment is reachable, such as `"https://status.example.com"`, for links in
	 * notifications (the admin UI's "create an incident" form). Without it, notifications
	 * have no links.
	 */
	baseUrl?: string;
	/** Notification settings that are not per target (targets are managed in the admin UI). */
	notifications?: NotificationsConfig;
	/** Monitors, each created by a provider factory such as `http({ … })`. */
	monitors?: readonly MonitorDefinition[];
	/** Public status pages. */
	pages?: readonly PageConfig[];
	/** The public API that status pages read. */
	publicApi?: PublicApiConfig;
	/**
	 * Host names (with the port, if not the default) on which the admin UI and admin API answer,
	 * such as `["status.example.com"]`, or `"baseUrl"` for the host of `baseUrl`. Requests for
	 * them on any other host name (a `*.workers.dev` URL without Cloudflare Access, say) get the
	 * same 403 as a failed sign-in. Default: any host name.
	 */
	adminHosts?: "baseUrl" | readonly string[];
}

export interface NotificationsConfig {
	/**
	 * How often the every-minute Cron looks for monitors whose results stopped arriving
	 * (`unknown`) to notify administrators. Whole minutes from `"1m"` (the default) to
	 * `"1h"`. A longer interval delays those notifications but saves Durable Object requests,
	 * which the Free plan limits per day.
	 */
	unknownCheckInterval?: Duration;
}

/** Placeholders the texts of automatic incidents may use. */
export const INCIDENT_TEMPLATE_PLACEHOLDERS = ["components", "monitor", "time"] as const;

/**
 * Texts of automatic incidents (`incidents.auto`), replacing the translated defaults.
 * They may use `{components}` (the affected components' names), `{monitor}` (the monitor's
 * name) and `{time}` (when it happened, in `timezone`).
 */
export interface IncidentTemplates {
	/** Title of a new incident. */
	title?: string;
	/** First update of a new incident (stage "investigating"). */
	investigating?: string;
	/** Update added to an unresolved incident of the same component. */
	update?: string;
	/** Update that resolves an automatic incident on recovery. */
	resolved?: string;
	/** Update that resolves an automatic incident when its monitor leaves the configuration while down. */
	stopped?: string;
	/** Update that reopens an automatic incident resolved less than `reopenWithin` ago. */
	reopened?: string;
	/** Update when a monitor goes from `down` to `degraded`: the incident stays open. */
	partial?: string;
}

/** Where public API responses are kept for 30 seconds. */
export type PublicApiCache = "durable-object" | "workers-cache";

export interface PublicApiConfig {
	/**
	 * Where responses are kept for 30 seconds. Default: `"durable-object"`.
	 *
	 * - `"durable-object"`: in the memory of each page's Durable Object. One Worker request and
	 *   one Durable Object request per API call; an administrator's change shows at once
	 *   everywhere. A page's object takes about 1,000 requests per second at most.
	 * - `"workers-cache"`: in Cloudflare's Workers Cache, in front of the Worker, near visitors.
	 *   Scales without limit, but every API call is billed as two Worker requests, and
	 *   purging after a change is rate-limited (a refused purge expires within 30 seconds).
	 */
	cache?: PublicApiCache;
	/**
	 * Web pages on other sites whose scripts may read the public API (CORS): `"*"` for any,
	 * or exact origins such as `"https://www.example.com"`. Default: none. Never applies to the
	 * admin API.
	 */
	allowedOrigins?: "*" | readonly string[];
}

export interface PageConfig {
	/** Unique identifier, with the same rules as monitor IDs. */
	id: string;
	/**
	 * How the page looks: `"default"`, or `"modern"` (a dark header over one card, with
	 * component groups, response times and a light/dark switch). Default: `"default"`. Both show
	 * the same data from the same public API.
	 */
	template?: PageTemplate;
	/**
	 * Where visitors report a problem, linked from the page's header ("Report a problem"): an
	 * `https:` or `http:` URL, or `mailto:`. Shown by the `"modern"` template. Default: none.
	 */
	reportUrl?: string;
	/**
	 * The heading and the browser tab's title: a text, or texts by language
	 * (`{ en: "Example Status", ja: "Example ステータス" }`). Default: the page's ID. The admin
	 * UI can replace it.
	 */
	title?: LocalizedText;
	/** A line under the heading, as `title`. The admin UI can replace or clear it. */
	description?: LocalizedText;
	/**
	 * An image shown instead of the title text: an `https:` URL. An image uploaded in the admin UI
	 * is shown instead; the admin UI can also replace or clear this URL.
	 */
	logoUrl?: string;
	/**
	 * Where the heading links to, such as the organisation's website (`https:` or `http:`).
	 * Default: the status page itself. The admin UI can replace or clear it.
	 */
	websiteUrl?: string;
	/** The header's navigation: links, and menus of links. The admin UI can replace it as a whole. */
	header?: HeaderConfig;
	/**
	 * Columns of links, a line of links and a line of text (a copyright notice, say), above the
	 * time zone and the language. The admin UI can replace it as a whole.
	 */
	footer?: FooterConfig;
	incidents?: {
		/** Publish an "investigating" incident automatically when `down` is confirmed. Default: `false`. */
		auto?: boolean;
		/** Texts of automatic incidents, replacing the translated defaults. */
		templates?: IncidentTemplates;
		/**
		 * A component confirmed `down` again within this long after automation resolved its
		 * incident reopens that incident (with an update) instead of publishing a new one, so
		 * that a flapping service does not fill the page with incidents. Never an incident an
		 * administrator edited. `"0m"` turns it off. Default: `"30m"`; at most `"1d"`.
		 */
		reopenWithin?: Duration;
	};
	/**
	 * What the page lists, in order: components, and groups of components. Monitors that are in
	 * no component are not public.
	 */
	components?: readonly (ComponentConfig | ComponentGroupConfig)[];
}

export interface ComponentConfig {
	/**
	 * Identifier, unique within the page, with the same rules as monitor IDs. Incidents and
	 * maintenance refer to components by ID, so keep it when renaming the component.
	 */
	id: string;
	/** Display name. Optional only for a component with exactly one monitor, whose name is used. */
	name?: string;
	/** The component shows the worst state of these monitors. Without monitors, only incidents set its state. */
	monitors?: readonly string[];
	/**
	 * Publish the response times of its monitors: averages over the last 24 hours, 7 days and
	 * 30 days, with the 95th percentile. Needs at least one monitor. Shown by the `"modern"`
	 * template. Default: `false`.
	 */
	latency?: boolean;
}

/**
 * Components shown together under one name, folded by default (the `"modern"` template; the
 * `"default"` template lists the components one by one). Display only: incidents and
 * maintenance still affect components, and the group shows the worst of its components.
 */
export interface ComponentGroupConfig {
	/** Identifier, with the same rules as component IDs, unique among the page's components and groups. */
	id: string;
	name: string;
	/** At least one; groups do not nest. */
	components: readonly ComponentConfig[];
}

/** Gives `status.config.ts` type checking and completion. Validation happens when the Worker loads it. */
export function defineConfig(config: StatusConfig): StatusConfig {
	return config;
}

/**
 * Shorthand for a component made of a single monitor. Its ID is the monitor ID and its
 * name is the monitor's name unless `name` is given.
 */
export function component(monitorId: string, options: { name?: string; latency?: boolean } = {}): ComponentConfig {
	return { id: monitorId, ...options, monitors: [monitorId] };
}

// ---------------------------------------------------------------------------
// Output: the validated configuration with defaults applied
// ---------------------------------------------------------------------------

export interface ResolvedConfirmation {
	readonly failureThreshold: number;
	readonly successThreshold: number;
	readonly recheckIntervalMs: number;
}

export interface ResolvedMonitor {
	readonly id: string;
	readonly name: string;
	readonly provider: CheckProvider;
	/**
	 * Provider options after validation and defaults. May contain `secret()` references;
	 * run checks with `runCheck`, which resolves them.
	 */
	readonly options: unknown;
	/** Names of the secrets the options reference. */
	readonly secrets: readonly string[];
	readonly intervalMs: number;
	readonly timeoutMs: number;
	readonly location: LocationHint | undefined;
	readonly confirmation: ResolvedConfirmation;
	/** IDs of the runners that check this monitor. Results are kept per monitor × runner. */
	readonly runners: readonly string[];
}

export interface ResolvedComponent {
	readonly id: string;
	readonly name: string;
	readonly monitors: readonly string[];
	/** Whether its monitors' response times are public. */
	readonly latency: boolean;
}

export interface ResolvedGroup {
	readonly id: string;
	readonly name: string;
	/** IDs of its components, in order; they are next to each other in the page's `components`. */
	readonly components: readonly string[];
}

export interface ResolvedPage {
	readonly id: string;
	readonly template: PageTemplate;
	/** `null` when not configured. */
	readonly reportUrl: string | null;
	/** Heading, header and footer as status.config.ts sets them; the admin UI's changes apply over them. */
	readonly frame: ResolvedFrame;
	readonly incidents: {
		readonly auto: boolean;
		readonly templates: Readonly<IncidentTemplates>;
		/** 0: never reopen. */
		readonly reopenWithinMs: number;
	};
	/** Every component, those of groups included, in the order of the page. */
	readonly components: readonly ResolvedComponent[];
	readonly groups: readonly ResolvedGroup[];
}

export interface ResolvedPublicApi {
	readonly cache: PublicApiCache;
	/** `"*"`, or the exact origins allowed (empty: CORS is off). */
	readonly allowedOrigins: "*" | readonly string[];
}

export interface ResolvedConfig {
	readonly timezone: string;
	/** `null` keeps results forever. */
	readonly retentionMs: number | null;
	/** `undefined`: no auth provider, so the admin UI and admin API reject every request. */
	readonly auth: AuthProvider | undefined;
	readonly notifiers: readonly NotifierKind[];
	/** Canonical BCP 47 tag. */
	readonly locale: string;
	/** Without a trailing slash; `null` when not configured. */
	readonly baseUrl: string | null;
	readonly notifications: { readonly unknownCheckIntervalMs: number };
	readonly monitors: readonly ResolvedMonitor[];
	readonly pages: readonly ResolvedPage[];
	readonly publicApi: ResolvedPublicApi;
	/** Lowercase hosts (`host[:port]`) the admin UI and API answer on; `null` for any. */
	readonly adminHosts: readonly string[] | null;
}

export interface ConfigIssue {
	/** Where the problem is, such as `monitors[0] ("api").url`. Empty for the configuration as a whole. */
	readonly path: string;
	readonly message: string;
}

/** Thrown by {@link resolveConfig} with every problem found, not just the first. */
export class ConfigError extends Error {
	override readonly name = "ConfigError";
	readonly issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		const lines = issues.map((issue) =>
			issue.path === "" ? `  - ${issue.message}` : `  - ${issue.path}: ${issue.message}`,
		);
		super(["Invalid status.config.ts:", ...lines].join("\n"));
		this.issues = issues;
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DAY_MS = 86_400_000;
const DEFAULT_TIMEOUT: Duration = "10s";
/** `retention` must cover at least this many intervals of every monitor. */
const MIN_INTERVALS_RETAINED = 10;

const idSchema = z
	.string()
	.regex(
		ID_PATTERN,
		'must be 1-64 characters of lowercase letters, digits, "-" or "_", starting with a letter or digit',
	);

function positiveDuration(): z.ZodType<number, Duration> {
	return durationSchema().refine((ms) => ms > 0, "must be longer than 0");
}

const UNITS: readonly [string, number][] = [
	["d", DAY_MS],
	["h", 3_600_000],
	["m", 60_000],
	["s", 1_000],
];

/** Milliseconds back to the largest exact unit, for messages: 90000 -> "90s". */
function formatDuration(ms: number): string {
	const unit = UNITS.find(([, size]) => ms % size === 0);
	return unit ? `${ms / unit[1]}${unit[0]}` : `${ms}ms`;
}

const timezoneSchema = z.string().transform((value, ctx) => {
	try {
		// Also normalizes the spelling, e.g. "asia/tokyo" -> "Asia/Tokyo".
		return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		ctx.addIssue(`unknown time zone "${value}"; use an IANA name such as "Asia/Tokyo"`);
		return z.NEVER;
	}
});

const confirmationSchema = z.strictObject({
	failureThreshold: z.int().min(1).default(2),
	successThreshold: z.int().min(1).default(1),
	recheckInterval: positiveDuration().prefault("15s"),
});

const monitorSettingsSchema = z.strictObject({
	id: idSchema,
	name: z.string().min(1).optional(),
	interval: positiveDuration(),
	timeout: positiveDuration().prefault(DEFAULT_TIMEOUT),
	location: z.enum(LOCATION_HINTS).optional(),
	confirmation: confirmationSchema.prefault({}),
});

const componentSchema = z.strictObject({
	id: idSchema,
	name: z.string().min(1).optional(),
	monitors: z.array(z.string()).default([]),
	latency: z.boolean().default(false),
});

const groupSchema = z.strictObject({
	id: idSchema,
	name: z.string().trim().min(1),
	// Validated one by one, as the page's components.
	components: z.array(z.unknown()).min(1, "must list at least one component"),
});

/** An entry of `components` that is a group (it has `components` of its own). */
function isGroupEntry(value: unknown): boolean {
	return isObject(value) && "components" in value;
}

const reportUrlSchema = z
	.string()
	.max(2_000)
	.transform((value, ctx) => {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			ctx.addIssue('must be a URL such as "https://example.com/support" or "mailto:support@example.com"');
			return z.NEVER;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:") {
			ctx.addIssue("must be an https, http or mailto URL");
			return z.NEVER;
		}
		if (url.username !== "" || url.password !== "") {
			ctx.addIssue("must not contain credentials");
			return z.NEVER;
		}
		return url.href;
	});

/** `https:`, or also `http:` with `http`; never with credentials. */
function webUrlSchema({ http }: { readonly http: boolean }) {
	return z
		.string()
		.trim()
		.max(2_000)
		.transform((value, ctx) => {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				ctx.addIssue('must be a URL such as "https://example.com/"');
				return z.NEVER;
			}
			if (url.protocol !== "https:" && !(http && url.protocol === "http:")) {
				ctx.addIssue(http ? "must be an https or http URL" : "must be an https URL (the page's Content-Security-Policy loads https images only)");
				return z.NEVER;
			}
			if (url.username !== "" || url.password !== "") {
				ctx.addIssue("must not contain credentials");
				return z.NEVER;
			}
			return url.href;
		});
}

const PLACEHOLDER = /\{([^{}]*)\}/g;
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(INCIDENT_TEMPLATE_PLACEHOLDERS);

function templateSchema(maxLength: number) {
	return z
		.string()
		.trim()
		.min(1)
		.max(maxLength)
		.superRefine((text, ctx) => {
			for (const match of text.matchAll(PLACEHOLDER)) {
				if (!KNOWN_PLACEHOLDERS.has(match[1] as string)) {
					ctx.addIssue(
						`unknown placeholder ${match[0]}; use ${INCIDENT_TEMPLATE_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
					);
				}
			}
		});
}

const templatesSchema = z.strictObject({
	title: templateSchema(200).optional(),
	investigating: templateSchema(2_000).optional(),
	update: templateSchema(2_000).optional(),
	resolved: templateSchema(2_000).optional(),
	stopped: templateSchema(2_000).optional(),
	reopened: templateSchema(2_000).optional(),
	partial: templateSchema(2_000).optional(),
});

const DEFAULT_REOPEN_WITHIN: Duration = "30m";

const pageSchema = z.strictObject({
	id: idSchema,
	template: z.enum(PAGE_TEMPLATES).default(DEFAULT_PAGE_TEMPLATE),
	reportUrl: reportUrlSchema.optional(),
	title: localizedTextSchema(FRAME_LIMITS.title).optional(),
	description: localizedTextSchema(FRAME_LIMITS.description).optional(),
	logoUrl: webUrlSchema({ http: false }).optional(),
	websiteUrl: webUrlSchema({ http: true }).optional(),
	header: headerSchema.prefault({}),
	footer: footerSchema.prefault({}),
	incidents: z
		.strictObject({
			auto: z.boolean().default(false),
			templates: templatesSchema.default({}),
			reopenWithin: durationSchema()
				.refine((ms) => ms <= DAY_MS, "must be at most 1d")
				.prefault(DEFAULT_REOPEN_WITHIN),
		})
		.prefault({}),
	// Components are validated one by one, so that one bad entry does not hide the others.
	components: z.array(z.unknown()).default([]),
});

/** An origin as browsers send it in `Origin`: scheme, host and port if not the default, lowercase. */
const originSchema = z.string().refine((value) => {
	try {
		const url = new URL(value);
		return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
	} catch {
		return false;
	}
}, 'must be an origin such as "https://www.example.com": lowercase, with no path, query or trailing slash, and no default port');

const publicApiSchema = z
	.strictObject({
		cache: z.enum(["durable-object", "workers-cache"]).default("durable-object"),
		allowedOrigins: z
			.union([
				z.literal("*"),
				z.array(originSchema).superRefine((origins, ctx) => {
					origins.forEach((origin, index) => {
						if (origins.indexOf(origin) !== index) {
							ctx.addIssue({ code: "custom", message: `"${origin}" is listed twice`, path: [index] });
						}
					});
				}),
			])
			.default([]),
	})
	.prefault({});

const localeSchema = z.string().transform((value, ctx) => {
	try {
		const [canonical] = Intl.getCanonicalLocales(value);
		if (canonical !== undefined) return canonical;
	} catch {
		// Reported below.
	}
	ctx.addIssue(`"${value}" is not a language tag; use one such as "en" or "ja"`);
	return z.NEVER;
});

const baseUrlSchema = z.string().transform((value, ctx) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		ctx.addIssue('must be a URL such as "https://status.example.com"');
		return z.NEVER;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") ctx.addIssue("must be an http or https URL");
	if (url.username !== "" || url.password !== "") ctx.addIssue("must not contain credentials");
	if (url.search !== "" || url.hash !== "") ctx.addIssue("must not have a query or fragment");
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
});

const MINUTE_MS = 60_000;

/** A host as `URL.host` gives it: lowercase name (or bracketed IPv6) and a port if not the default. */
const hostSchema = z.string().refine((value) => {
	try {
		const url = new URL(`https://${value}`);
		return url.host === value && url.pathname === "/" && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}, 'must be a host name such as "status.example.com" (lowercase, with a port only if it is not 443), without a scheme or path');

const adminHostsSchema = z.union([
	z.literal("baseUrl"),
	z
		.array(hostSchema)
		.min(1, 'must list at least one host name, or be "baseUrl"')
		.superRefine((hosts, ctx) => {
			hosts.forEach((host, index) => {
				if (hosts.indexOf(host) !== index) ctx.addIssue({ code: "custom", message: `"${host}" is listed twice`, path: [index] });
			});
		}),
]);

const notificationsSchema = z
	.strictObject({
		unknownCheckInterval: durationSchema()
			.refine((ms) => ms % MINUTE_MS === 0 && ms >= MINUTE_MS && ms <= 60 * MINUTE_MS, {
				message: 'must be whole minutes from "1m" to "1h" (the Cron runs every minute)',
			})
			.prefault("1m"),
	})
	.prefault({});

const authSchema = z.custom<AuthProvider>(
	(value) =>
		isObject(value) && typeof value["type"] === "string" && typeof value["authenticate"] === "function",
	"must be an auth provider (an object with `type` and `authenticate()`)",
);

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
	"timezone",
	"location",
	"retention",
	"auth",
	"notifiers",
	"locale",
	"baseUrl",
	"notifications",
	"monitors",
	"pages",
	"publicApi",
	"adminHosts",
] satisfies (keyof StatusConfig)[]);

const RESERVED_SETTING_KEYS: ReadonlySet<string> = new Set(RESERVED_MONITOR_KEYS);

/** `value` without its `undefined` properties, so that resolved objects compare equal to what was written. */
function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isSchema(value: unknown): boolean {
	return isObject(value) && typeof value["safeParse"] === "function";
}

function isNotifierKind(value: unknown): value is NotifierKind {
	return (
		isObject(value) &&
		typeof value["type"] === "string" &&
		isSchema(value["options"]) &&
		Array.isArray(value["secretOptions"]) &&
		typeof value["send"] === "function"
	);
}

function isMonitorDefinition(value: unknown): value is MonitorDefinition {
	if (!isObject(value)) return false;
	const provider = value["provider"];
	return (
		isObject(provider) &&
		typeof provider["type"] === "string" &&
		typeof provider["check"] === "function" &&
		Array.isArray(provider["requires"]) &&
		isSchema(provider["options"]) &&
		isObject(value["settings"]) &&
		isObject(value["options"])
	);
}

interface IssueLike {
	readonly path: readonly PropertyKey[];
	readonly message: string;
}

function joinPath(base: string, segments: readonly PropertyKey[]): string {
	let path = base;
	for (const segment of segments) {
		if (typeof segment === "number") path += `[${segment}]`;
		else path += path === "" ? String(segment) : `.${String(segment)}`;
	}
	return path;
}

export interface ResolveOptions {
	/**
	 * Runners available to the hub. Every monitor is assigned to the first one for now;
	 * choosing runners per monitor arrives with external runners.
	 */
	readonly runners: readonly RunnerDeclaration[];
	/**
	 * Secrets of the hub itself, which a monitor must never reference with `secret()`: they
	 * would be sent to the monitored endpoint (such as the key that encrypts notification
	 * targets' secrets).
	 */
	readonly reservedSecrets?: readonly string[];
}

/**
 * Validates a configuration and applies defaults. Call it when the Worker loads, so that a
 * broken configuration fails the deployment instead of failing at run time.
 * @throws ConfigError listing every problem found.
 */
export function resolveConfig(config: StatusConfig, { runners, reservedSecrets = [] }: ResolveOptions): ResolvedConfig {
	const issues: ConfigIssue[] = [];
	const report = (path: string, message: string) => issues.push({ path, message });
	const collect = (base: string, found: readonly IssueLike[]) => {
		for (const issue of found) report(joinPath(base, issue.path), issue.message);
	};
	// Each part is validated on its own, so one problem does not hide the others.
	const parse = <T>(schema: z.ZodType<T, unknown>, value: unknown, path: string): T | undefined => {
		const result = schema.safeParse(value);
		if (result.success) return result.data;
		collect(path, result.error.issues);
		return undefined;
	};

	if (!isObject(config)) {
		throw new ConfigError([{ path: "", message: "must be an object passed to defineConfig()" }]);
	}
	const input: Record<string, unknown> = config;
	for (const key of Object.keys(input)) {
		if (!TOP_LEVEL_KEYS.has(key)) report("", `Unrecognized key: "${key}"`);
	}

	const timezone = parse(timezoneSchema.prefault("UTC"), input["timezone"], "timezone");
	const location = parse(z.enum(LOCATION_HINTS).optional(), input["location"], "location");
	const retention = parse(
		durationSchema()
			.refine((ms) => ms >= DAY_MS, "must be at least 1d")
			.optional(),
		input["retention"],
		"retention",
	);
	const auth = parse(authSchema.optional(), input["auth"], "auth");
	const notifierEntries = parse(z.array(z.unknown()).default([]), input["notifiers"], "notifiers") ?? [];
	const monitorEntries = parse(z.array(z.unknown()).default([]), input["monitors"], "monitors") ?? [];
	const pageEntries = parse(z.array(z.unknown()).default([]), input["pages"], "pages") ?? [];
	const publicApi = parse(publicApiSchema, input["publicApi"], "publicApi");
	const locale = parse(localeSchema.prefault("en"), input["locale"], "locale");
	const baseUrl = parse(baseUrlSchema.optional(), input["baseUrl"], "baseUrl");
	const notifications = parse(notificationsSchema, input["notifications"], "notifications");
	const adminHostsInput = parse(adminHostsSchema.optional(), input["adminHosts"], "adminHosts");
	let adminHosts: readonly string[] | null = null;
	if (adminHostsInput === "baseUrl") {
		if (baseUrl === undefined) {
			if (input["baseUrl"] === undefined) report("adminHosts", '"baseUrl" needs `baseUrl` to be set');
		} else adminHosts = [new URL(baseUrl).host];
	} else if (adminHostsInput !== undefined) adminHosts = adminHostsInput;

	const runnerIds = new Set<string>();
	for (const runner of runners) {
		if (runnerIds.has(runner.id)) report("", `duplicate runner ID "${runner.id}"`);
		runnerIds.add(runner.id);
	}
	const defaultRunner = runners[0];
	if (defaultRunner === undefined && monitorEntries.length > 0) {
		report("", "no runner is available to run monitors");
	}

	// ---- Notifiers
	const notifiers: NotifierKind[] = [];
	const firstIndexOfNotifier = new Map<string, number>();
	notifierEntries.forEach((notifier, index) => {
		const path = `notifiers[${index}]`;
		if (!isNotifierKind(notifier)) {
			report(path, "must be a notifier kind (an object with `type`, an `options` schema, `secretOptions` and `send()`)");
			return;
		}
		const first = firstIndexOfNotifier.get(notifier.type);
		if (first !== undefined) {
			report(path, `duplicate notifier type "${notifier.type}" (also used by notifiers[${first}])`);
			return;
		}
		firstIndexOfNotifier.set(notifier.type, index);
		notifiers.push(notifier);
	});

	// ---- Monitors
	const definitions = monitorEntries.filter(isMonitorDefinition);
	// IDs as written, so that a monitor with other errors does not also show up as unknown.
	const declaredMonitorIds = new Set(
		definitions.flatMap((definition) =>
			typeof definition.settings.id === "string" ? [definition.settings.id] : [],
		),
	);
	const firstIndexOfMonitor = new Map<string, number>();
	const monitors: ResolvedMonitor[] = [];

	monitorEntries.forEach((entry, index) => {
		if (!isMonitorDefinition(entry)) {
			report(`monitors[${index}]`, "must be created by a provider factory such as http({ … })");
			return;
		}
		const rawSettings: Record<string, unknown> = { ...entry.settings };
		const rawId = rawSettings["id"];
		const base =
			typeof rawId === "string" ? `monitors[${index}] ("${rawId}")` : `monitors[${index}]`;
		const { provider } = entry;

		for (const key of Object.keys(rawSettings)) {
			if (RESERVED_SETTING_KEYS.has(key)) {
				report(`${base}.${key}`, `"${key}" is reserved for a future monitor setting`);
			}
		}
		const settings = parse(
			monitorSettingsSchema,
			Object.fromEntries(Object.entries(rawSettings).filter(([key]) => !RESERVED_SETTING_KEYS.has(key))),
			base,
		);
		const options = parse(provider.options, entry.options, base);

		const assigned = defaultRunner === undefined ? [] : [defaultRunner];
		for (const runner of assigned) {
			const missing = missingCapabilities(provider.requires, runner);
			if (missing.length > 0) {
				report(
					base,
					`provider "${provider.type}" requires ${missing.map((c) => `"${c}"`).join(", ")}, ` +
						`which runner "${runner.id}" does not provide`,
				);
			}
		}

		if (settings === undefined) return;
		const { id, interval, timeout, confirmation } = settings;
		const first = firstIndexOfMonitor.get(id);
		if (first !== undefined) {
			report(`${base}.id`, `duplicate monitor ID (also used by monitors[${first}])`);
			return;
		}
		firstIndexOfMonitor.set(id, index);

		if (confirmation.recheckInterval > interval) {
			report(
				`${base}.confirmation.recheckInterval`,
				`must not be longer than interval (${formatDuration(interval)})`,
			);
		}
		if (timeout >= interval) {
			report(
				`${base}.timeout`,
				rawSettings["timeout"] === undefined
					? `the default timeout (${DEFAULT_TIMEOUT}) must be shorter than interval (${formatDuration(interval)}); set a shorter timeout`
					: `must be shorter than interval (${formatDuration(interval)})`,
			);
		}
		// Scheduling and the confirmation rule read the last few results: keep many intervals' worth.
		if (retention !== undefined && interval * MIN_INTERVALS_RETAINED > retention) {
			report(
				`${base}.interval`,
				`must be at most 1/${MIN_INTERVALS_RETAINED} of retention (${formatDuration(retention)}), so that retention keeps enough results`,
			);
		}
		for (const runner of assigned) {
			if (runner.maxTimeoutMs !== undefined && timeout > runner.maxTimeoutMs) {
				report(
					`${base}.timeout`,
					`must not be longer than ${formatDuration(runner.maxTimeoutMs)}, the limit of runner "${runner.id}"`,
				);
			}
		}
		if (options === undefined) return;
		for (const name of secretNames(options)) {
			if (reservedSecrets.includes(name)) {
				report(base, `must not use secret("${name}"): it is the hub's own secret and must never be sent to a monitored endpoint`);
			}
		}

		monitors.push({
			id,
			name: settings.name ?? id,
			provider,
			options,
			secrets: secretNames(options),
			intervalMs: interval,
			timeoutMs: timeout,
			location: settings.location ?? location,
			confirmation: {
				failureThreshold: confirmation.failureThreshold,
				successThreshold: confirmation.successThreshold,
				recheckIntervalMs: confirmation.recheckInterval,
			},
			runners: assigned.map((runner) => runner.id),
		});
	});

	// ---- Pages
	const monitorNames = new Map(monitors.map((monitor) => [monitor.id, monitor.name]));
	const firstIndexOfPage = new Map<string, number>();
	const pages: ResolvedPage[] = [];

	pageEntries.forEach((entry, pageIndex) => {
		const pageBase = `pages[${pageIndex}]`;
		const page = parse(pageSchema, entry, pageBase);
		if (page !== undefined) {
			const firstPage = firstIndexOfPage.get(page.id);
			if (firstPage === undefined) firstIndexOfPage.set(page.id, pageIndex);
			else report(`${pageBase}.id`, `duplicate page ID "${page.id}" (also used by pages[${firstPage}])`);
		}
		// Check components even when the page itself is invalid.
		const componentEntries =
			page?.components ??
			(isObject(entry) && Array.isArray(entry["components"]) ? (entry["components"] as unknown[]) : []);

		// Components and groups share one namespace of IDs: where each ID was first used.
		const firstUseOfId = new Map<string, { readonly where: string; readonly group: boolean }>();
		const components: ResolvedComponent[] = [];
		const groups: ResolvedGroup[] = [];
		const claimId = (id: string, path: string, where: string, group: boolean): boolean => {
			const first = firstUseOfId.get(id);
			if (first === undefined) {
				firstUseOfId.set(id, { where, group });
				return true;
			}
			report(
				`${path}.id`,
				!group && !first.group
					? `duplicate component ID "${id}" (also used by ${first.where})`
					: `duplicate ID "${id}" (also used by ${first.where}): components and groups need different IDs`,
			);
			return false;
		};

		const resolveComponent = (componentEntry: unknown, where: string): ResolvedComponent | undefined => {
			const base = `${pageBase}.${where}`;
			if (isGroupEntry(componentEntry)) {
				report(base, "groups cannot contain groups");
				return undefined;
			}
			const parsed = parse(componentSchema, componentEntry, base);
			if (parsed === undefined) return undefined;
			const { id, monitors: monitorIds } = parsed;

			monitorIds.forEach((monitorId, monitorIndex) => {
				if (!declaredMonitorIds.has(monitorId)) {
					report(`${base}.monitors[${monitorIndex}]`, `unknown monitor "${monitorId}"`);
				} else if (monitorIds.indexOf(monitorId) !== monitorIndex) {
					report(`${base}.monitors[${monitorIndex}]`, `monitor "${monitorId}" is listed twice`);
				}
			});
			if (parsed.latency && monitorIds.length === 0) {
				report(`${base}.latency`, "needs at least one monitor: response times come from the component's monitors");
			}

			const only = monitorIds.length === 1 ? monitorIds[0] : undefined;
			const name = parsed.name ?? (only === undefined ? undefined : (monitorNames.get(only) ?? only));
			if (name === undefined) {
				report(`${base}.name`, "is required unless the component has exactly one monitor");
			}

			if (!claimId(id, base, where, false)) return undefined;
			return { id, name: name ?? id, monitors: monitorIds, latency: parsed.latency };
		};

		componentEntries.forEach((componentEntry, componentIndex) => {
			const where = `components[${componentIndex}]`;
			if (!isGroupEntry(componentEntry)) {
				const resolved = resolveComponent(componentEntry, where);
				if (resolved !== undefined) components.push(resolved);
				return;
			}
			const base = `${pageBase}.${where}`;
			const group = parse(groupSchema, componentEntry, base);
			// Check its components even when the group itself is invalid.
			const memberEntries =
				group?.components ??
				(isObject(componentEntry) && Array.isArray(componentEntry["components"]) ? (componentEntry["components"] as unknown[]) : []);
			const claimed = group !== undefined && claimId(group.id, base, where, true);
			const members: string[] = [];
			memberEntries.forEach((memberEntry, memberIndex) => {
				const resolved = resolveComponent(memberEntry, `${where}.components[${memberIndex}]`);
				if (resolved === undefined) return;
				components.push(resolved);
				members.push(resolved.id);
			});
			if (group !== undefined && claimed && members.length > 0) {
				groups.push({ id: group.id, name: group.name, components: members });
			}
		});

		if (page !== undefined) {
			pages.push({
				id: page.id,
				template: page.template,
				reportUrl: page.reportUrl ?? null,
				frame: {
					title: page.title ?? null,
					description: page.description ?? null,
					logoUrl: page.logoUrl ?? null,
					websiteUrl: page.websiteUrl ?? null,
					header: page.header,
					footer: page.footer,
				},
				incidents: {
					auto: page.incidents.auto,
					templates: stripUndefined(page.incidents.templates),
					reopenWithinMs: page.incidents.reopenWithin,
				},
				components,
				groups,
			});
		}
	});

	if (
		issues.length > 0 ||
		timezone === undefined ||
		publicApi === undefined ||
		locale === undefined ||
		notifications === undefined
	) {
		throw new ConfigError(issues);
	}

	return {
		timezone,
		retentionMs: retention ?? null,
		auth,
		notifiers,
		locale,
		baseUrl: baseUrl ?? null,
		notifications: { unknownCheckIntervalMs: notifications.unknownCheckInterval },
		monitors,
		pages,
		publicApi: { cache: publicApi.cache, allowedOrigins: publicApi.allowedOrigins },
		adminHosts,
	};
}
