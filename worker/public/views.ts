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

/**
 * The appearance as visitors get it. `uploads`: whether the Worker has its R2 bucket; without
 * it, uploaded images are left out (they could not be served), and the logo URL shows instead.
 */
export function publicAppearance(appearance: PageAppearance, uploads: boolean): PublicAppearance {
	const image = (id: string | null) => (uploads && id !== null ? imagePath(appearance.pageId, id) : null);
	return {
		title: appearance.title,
		description: appearance.description,
		// https only (the page's Content-Security-Policy blocks others); one saved before that rule is left out.
		logoUrl: image(appearance.logoImage) ?? (appearance.logoUrl?.startsWith("https://") === true ? appearance.logoUrl : null),
		websiteUrl: appearance.websiteUrl,
		faviconUrl: image(appearance.faviconImage),
		colors: appearance.colors,
	};
}
