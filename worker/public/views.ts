/**
 * What the public API shows of the admin's data: incidents, maintenance and appearance
 * reduced to what visitors see. Administrator names, versions and automation flags stay
 * internal, and only components that are on the page are listed.
 */
import type { ResolvedPage } from "@naosystem/cf-workers-status-page-core";
import type { Impact, Incident, IncidentUpdate, Maintenance, PageAppearance } from "../../shared/admin-api";
import type {
	AffectedComponent,
	ComponentRef,
	PublicAppearance,
	PublicIncident,
	PublicIncidentUpdate,
	PublicIncidentWithUpdates,
	PublicMaintenance,
} from "../../shared/public-api";
import { DEFAULT_LOCALE, pickText } from "../../shared/i18n/core";
import { imagePath } from "../uploads";

const IMPACT_RANK: Readonly<Record<Impact, number>> = { none: 0, degraded: 1, down: 2 };

function componentNames(page: ResolvedPage): ReadonlyMap<string, string> {
	return new Map(page.components.map((component) => [component.id, component.name]));
}

export function publicIncident(incident: Incident, page: ResolvedPage): PublicIncident {
	const names = componentNames(page);
	const components: AffectedComponent[] = incident.components.flatMap((affected) => {
		const name = names.get(affected.id);
		return name === undefined ? [] : [{ id: affected.id, name, impact: affected.impact }];
	});
	const impact = components.reduce<Impact>(
		(highest, component) => (IMPACT_RANK[component.impact] > IMPACT_RANK[highest] ? component.impact : highest),
		"none",
	);
	return {
		id: incident.id,
		title: incident.title,
		stage: incident.stage,
		impact,
		components,
		startedAt: incident.startedAt,
		updatedAt: incident.updatedAt,
		resolvedAt: incident.resolvedAt,
	};
}

export function publicUpdate(update: IncidentUpdate): PublicIncidentUpdate {
	return { stage: update.stage, body: update.body, createdAt: update.createdAt };
}

export function publicIncidentWithUpdates(
	incident: Incident & { readonly updates: readonly IncidentUpdate[]; readonly olderUpdates?: boolean },
	page: ResolvedPage,
): PublicIncidentWithUpdates {
	return {
		...publicIncident(incident, page),
		updates: incident.updates.map(publicUpdate),
		olderUpdates: incident.olderUpdates ?? false,
	};
}

export function publicMaintenance(maintenance: Maintenance, page: ResolvedPage): PublicMaintenance {
	const names = componentNames(page);
	const components: ComponentRef[] = maintenance.components.flatMap((id) => {
		const name = names.get(id);
		return name === undefined ? [] : [{ id, name }];
	});
	return {
		id: maintenance.id,
		title: maintenance.title,
		body: maintenance.body,
		startsAt: maintenance.startsAt,
		endsAt: maintenance.endsAt,
		components,
	};
}

/** A text or URL as visitors get it: `""` (cleared by an administrator) is none. */
function shown<T extends string | object>(value: T | null): T | null {
	return value === "" ? null : value;
}

/**
 * The appearance as visitors get it: the administrators' fields over status.config.ts's,
 * each where it is not `null`; `""` clears. `uploads`: whether the Worker has its R2 bucket;
 * without it, uploaded images are left out (they could not be served), and the logo URL shows
 * instead.
 */
export function publicAppearance(appearance: PageAppearance, page: ResolvedPage, uploads: boolean): PublicAppearance {
	const image = (id: string | null) => (uploads && id !== null ? imagePath(appearance.pageId, id) : null);
	const { frame } = page;
	const title = appearance.title ?? frame.title;
	const description = shown(appearance.description ?? frame.description);
	const logoUrl = shown(appearance.logoUrl ?? frame.logoUrl);
	return {
		title: pickText(title, DEFAULT_LOCALE),
		description: pickText(description, DEFAULT_LOCALE),
		localized: { title, description },
		// https only (the page's Content-Security-Policy blocks others); one saved before that rule is left out.
		logoUrl: image(appearance.logoImage) ?? (logoUrl?.startsWith("https://") === true ? logoUrl : null),
		websiteUrl: shown(appearance.websiteUrl ?? frame.websiteUrl),
		faviconUrl: image(appearance.faviconImage),
		colors: appearance.colors,
		header: appearance.header ?? frame.header,
		footer: appearance.footer ?? frame.footer,
	};
}

/** A page's title in one language, as `PublicAppearance.title`, from the title an administrator set (`null`: none). */
export function publicTitle(adminTitle: string | null, page: ResolvedPage): string | null {
	return adminTitle ?? pickText(page.frame.title, DEFAULT_LOCALE);
}
