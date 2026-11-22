import {
	type LocationHint,
	type ResolvedMonitor,
	type ResolvedPage,
	resolveConfig,
} from "@naosystem/cf-workers-status-page-core";
import userConfig from "../status.config";
import { KEYS_SECRET } from "./notifications/crypto";
import { RUNNERS } from "./runners";

/** The Worker's own secrets: no `secret()` in status.config.ts may name them (they would leave the Worker). */
export const RESERVED_SECRETS: readonly string[] = [KEYS_SECRET];

/**
 * The validated configuration. Resolved when the Worker module loads, so an invalid
 * status.config.ts fails `wrangler deploy`, `npm run dev` and the tests.
 */
export const config = resolveConfig(userConfig, { runners: RUNNERS, reservedSecrets: RESERVED_SECRETS });

const monitorsById: ReadonlyMap<string, ResolvedMonitor> = new Map(
	config.monitors.map((monitor) => [monitor.id, monitor]),
);

/** The configured monitor with this ID, if any. */
export function findMonitor(id: string): ResolvedMonitor | undefined {
	return monitorsById.get(id);
}

const pagesById: ReadonlyMap<string, ResolvedPage> = new Map(config.pages.map((page) => [page.id, page]));

/** The page with this ID in status.config.ts, if any. */
export function findPage(id: string): ResolvedPage | undefined {
	return pagesById.get(id);
}

/** The monitors a page shows through its components, each once, in the order the components list them. */
export function pageMonitors(page: ResolvedPage): ResolvedMonitor[] {
	const ids = new Set(page.components.flatMap((component) => component.monitors));
	return [...ids].flatMap((id) => {
		const monitor = monitorsById.get(id);
		return monitor === undefined ? [] : [monitor];
	});
}

// Core keeps its own copy of the Durable Object location hints so that it does not
// depend on Cloudflare runtime types. Fail type-checking when the two lists diverge
// (for example after `npm run cf-typegen` picks up a new hint).
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies Equals<LocationHint, DurableObjectLocationHint>;
