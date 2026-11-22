/**
 * The admin API's vocabulary and limits, without Zod: shared/admin-api.ts builds its schemas
 * from these and re-exports them, and the admin UI imports them from here so that its bundle
 * does not carry the schemas (the Worker validates every request).
 */
import { FRAME_LIMITS, type NotificationEvent } from "@naosystem/cf-workers-status-page-core";

export { FRAME_LIMITS, NOTIFICATION_EVENTS, type NotificationEvent } from "@naosystem/cf-workers-status-page-core";

/** 調査中 → 原因特定 → 経過観察 → 解決. Any order is allowed; `resolved` closes the incident. */
export const INCIDENT_STAGES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentStage = (typeof INCIDENT_STAGES)[number];

/**
 * Impact of an incident on a component. While the incident is open, the page shows the
 * worse of this and the component's monitored state. `none` lists the component as
 * affected without changing its state, for example while monitoring a fix.
 */
export const IMPACTS = ["none", "degraded", "down"] as const;
export type Impact = (typeof IMPACTS)[number];

export const LIMITS = {
	title: 200,
	body: 20_000,
	components: 100,
	appearanceTitle: FRAME_LIMITS.title,
	appearanceDescription: FRAME_LIMITS.description,
	url: 2_000,
	/** Largest page size of a list. */
	pageSize: 100,
	targetName: 100,
	targetMonitors: 500,
	targetComponents: 500,
	/** Largest image an administrator can upload (a logo or a favicon), in bytes. */
	imageBytes: 512 * 1024,
} as const;

/**
 * Images an administrator can upload, by media type, and the extension each is stored with.
 * Raster formats only: an SVG can carry scripts, and the images are served from the status
 * page's own origin. Two names for ICO, as browsers report either.
 */
export const IMAGE_TYPES = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
} as const;
export type ImageExtension = (typeof IMAGE_TYPES)[keyof typeof IMAGE_TYPES];

/** The media type an image is served with, by its extension. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<ImageExtension, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	ico: "image/x-icon",
};

/**
 * An uploaded image's ID: 128 random bits (hex) and its extension. A new one for every upload,
 * even of the same file, so that an ID is never reused: what it serves never changes, and an
 * image that is being deleted can never be uploaded again under its ID (worker/uploads.ts).
 */
export const IMAGE_ID = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp|ico)$/;

/** Where an uploaded image is served: the public API's image route (worker/public/routes.ts). */
export function imagePath(pageId: string, imageId: string): string {
	return `/api/pages/${encodeURIComponent(pageId)}/images/${imageId}`;
}

/** Light and dark: each colour of a page is set for both, or left to the template's. */
export const COLOR_SCHEMES = ["light", "dark"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/**
 * The colours of a page an administrator can set: the page's background, the header bar (the
 * modern template; its text turns dark on a light colour), and links and focus outlines.
 */
export const COLOR_ROLES = ["background", "header", "accent"] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

/** A colour as `#rrggbb`, lower case. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** One colour scheme's colours (`#rrggbb`); `null` for the template's. */
export type ThemeColors = { readonly [Role in ColorRole]: string | null };

/** A page's colours, per colour scheme. */
export type AppearanceColors = { readonly [Scheme in ColorScheme]: ThemeColors };

/** The template's colours throughout: what a page has until an administrator sets one. */
export const NO_COLORS: AppearanceColors = {
	light: { background: null, header: null, accent: null },
	dark: { background: null, header: null, accent: null },
};

/** How far in the future an incident's `startedAt` may be, for clocks that run a little fast. It is then stored as now. */
export const START_TIME_TOLERANCE_MS = 60_000;

/** Events a target receives when it does not say: `down` and recovery; administrators' targets also `unknown`. */
export const DEFAULT_TARGET_EVENTS: readonly NotificationEvent[] = ["down", "recovered"];
