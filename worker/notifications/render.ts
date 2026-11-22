/**
 * Notification texts and the texts of automatic incidents, from the translations
 * in `locale`, with times in `timezone` of status.config.ts. Pure functions.
 */
import type {
	Notification,
	NotificationEvent,
	NotificationLink,
	NotificationSeverity,
	ResolvedPage,
} from "@naosystem/cf-workers-status-page-core";
import {
	formatDuration,
	formatTime,
	interpolate,
	type MessageKey,
	type MessageParams,
	resolveLocale,
	type Translate,
	translator,
} from "../../shared/i18n";
import type { ComponentRef } from "../../shared/admin-api";
import type { MonitorEvent } from "./events";

export interface RenderContext {
	readonly locale: string;
	readonly timeZone: string;
	readonly monitorName: string;
	readonly links: readonly NotificationLink[];
}

const SEVERITY: Readonly<Record<NotificationEvent, NotificationSeverity>> = {
	down: "critical",
	recovered: "ok",
	degraded: "warning",
	degraded_recovered: "ok",
	unknown: "warning",
};

/** A monitor event that targets receive (not `stopped`). */
export type NotifiedEvent = MonitorEvent & { readonly event: NotificationEvent };

/** The notification of `event`, in `context.locale`. Its ID is the event's. */
export function renderEvent(event: NotifiedEvent, context: RenderContext): Notification {
	// The language the texts are in: the configured one, or English without a translation.
	const locale = resolveLocale(context.locale);
	const t = translator(locale);
	const time = (at: number) => formatTime(at, locale, context.timeZone);
	const duration = (from: number | null) => formatDuration(from === null ? 0 : event.since - from, locale);
	const params: MessageParams = {
		monitor: context.monitorName,
		time: time(event.since),
		state: t(`state.${event.state}` as MessageKey),
	};
	const lines: string[] = [];
	switch (event.event) {
		case "down":
			lines.push(t(event.afterMaintenance ? "notification.down.afterMaintenance" : "notification.down.text", params));
			break;
		case "recovered":
			// To `degraded`, it is a partial recovery.
			lines.push(
				t(event.state === "degraded" ? "notification.recovered.partial.text" : "notification.recovered.text", {
					...params,
					duration: duration(event.previousSince),
				}),
			);
			break;
		case "degraded":
			lines.push(t("notification.degraded.text", params));
			break;
		case "degraded_recovered":
			lines.push(t("notification.degraded_recovered.text", { ...params, duration: duration(event.previousSince) }));
			break;
		case "unknown": {
			const reason = event.unknown?.reason ?? "late";
			const last = time(event.unknown?.lastAt ?? event.since);
			lines.push(t(`notification.unknown.${reason}`, { ...params, last }));
			break;
		}
	}
	const title =
		event.event === "recovered" && event.state === "degraded"
			? t("notification.recovered.partial.title", params)
			: t(`notification.${event.event}.title` as MessageKey, params);
	if (event.message !== null && event.message !== "" && event.event !== "unknown") {
		lines.push(t("notification.lastCheck", { message: event.message }));
	}
	return {
		id: event.id,
		event: event.event,
		severity: event.event === "recovered" && event.state === "degraded" ? "warning" : SEVERITY[event.event],
		title,
		text: lines.join("\n"),
		occurredAt: event.since,
		monitor: { id: event.monitorId, name: context.monitorName },
		state: event.state,
		previousState: event.previousState,
		links: context.links,
		locale,
	};
}

/** A test notification for the target `targetName`, sent at `now`. */
export function renderTest(targetName: string, now: number, configured: string, timeZone: string): Notification {
	const locale = resolveLocale(configured);
	const t = translator(locale);
	return {
		id: `test:${crypto.randomUUID()}`,
		event: "test",
		severity: "info",
		title: t("notification.test.title"),
		text: t("notification.test.text", { target: targetName, time: formatTime(now, locale, timeZone) }),
		occurredAt: now,
		monitor: null,
		state: null,
		previousState: null,
		links: [],
		locale,
	};
}

/** The components of each page that show `monitorId`. */
export function monitorComponents(pages: readonly ResolvedPage[], monitorId: string): ComponentRef[] {
	return pages.flatMap((page) =>
		page.components
			.filter((component) => component.monitors.includes(monitorId))
			.map((component) => ({ pageId: page.id, componentId: component.id })),
	);
}

/**
 * "Create an incident" links to the admin UI, pre-filled with the page and the components that
 * show the monitor, for each page without `incidents.auto`. None without `baseUrl`.
 */
export function createIncidentLinks(
	pages: readonly ResolvedPage[],
	monitorId: string,
	baseUrl: string | null,
	t: Translate,
): NotificationLink[] {
	if (baseUrl === null) return [];
	return pages.flatMap((page) => {
		if (page.incidents.auto) return [];
		const components = page.components.filter((component) => component.monitors.includes(monitorId));
		if (components.length === 0) return [];
		const query = new URLSearchParams({ page: page.id, components: components.map((component) => component.id).join(",") });
		return [{ label: t("notification.link.createIncident", { page: page.id }), url: `${baseUrl}/admin/incidents/new?${query}` }];
	});
}

export interface IncidentTexts {
	readonly title: string;
	readonly investigating: string;
	readonly update: string;
	readonly resolved: string;
	readonly stopped: string;
	readonly reopened: string;
	readonly partial: string;
}

/**
 * The texts of an automatic incident on `page`: the page's templates from
 * status.config.ts, else the translations. `components` are the names of the components.
 */
export function incidentTexts(
	page: Pick<ResolvedPage, "incidents">,
	values: { readonly components: readonly string[]; readonly monitor: string; readonly at: number },
	configured: string,
	timeZone: string,
): IncidentTexts {
	const locale = resolveLocale(configured);
	const t = translator(locale);
	const params: MessageParams = {
		components: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(values.components),
		monitor: values.monitor,
		time: formatTime(values.at, locale, timeZone),
	};
	const { templates } = page.incidents;
	const text = (key: keyof IncidentTexts) => {
		const template = templates[key];
		return template === undefined ? t(`incident.auto.${key}`, params) : interpolate(template, params);
	};
	return {
		title: text("title"),
		investigating: text("investigating"),
		update: text("update"),
		resolved: text("resolved"),
		stopped: text("stopped"),
		reopened: text("reopened"),
		partial: text("partial"),
	};
}
