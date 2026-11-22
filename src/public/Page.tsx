import { type ReactNode, Suspense, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { isNotFound } from "../lib/http";
import { usePoller } from "../lib/usePoller";
import { getStatus, HISTORY_INTERVAL_MS, HISTORY_MAX_BACKOFF_MS, pagePath, STATUS_INTERVAL_MS, STATUS_MAX_BACKOFF_MS, statusUrl } from "./api";
import { describeError } from "./FreshnessNotice";
import { HistoryView } from "./HistoryView";
import { IncidentView } from "./IncidentView";
import { DefaultFrame, Loading, NotFound, type PageFrame, PageLoading, PageUnavailable, pageTitle, useDocumentTitle } from "./Layout";
import { ModernFrame } from "./modern/lazy";
import { StatusView } from "./StatusView";
import { expectedTemplate } from "./templates";

/** What a page shows: its status, its past incidents and outages, or one incident. */
export type PageView = { readonly kind: "status" } | { readonly kind: "history" } | { readonly kind: "incident"; readonly incidentId: string };

const ROOT_STATUS_URL = statusUrl(null);

/**
 * A page of the site, showing one of its views. The page's frame (the header with its
 * logo or title, and the footer) and its status, which the frame and every view need, belong
 * to the page: moving between its views (App.tsx) keeps them as they are, and only the view
 * changes. Each view reads only what it shows besides: the status view the history, stoppages,
 * past incidents (and, in the modern template, response times); the history the past
 * incidents and stoppages; an incident's view the incident. A view moved to reads its own
 * again, even what the previous view also showed.
 *
 * The status is read every 30 seconds for the status and the history (which follows the
 * unresolved incidents), and every 5 minutes for an incident, which needs only the frame.
 *
 * The site's root (`pageId` `null`) shows the first page, from `/api/status`. Once that has
 * said which page it is, the page's own paths keep reading it there: moving from the root to
 * the page's history reads nothing again.
 */
export function Page({ pageId, view }: { readonly pageId: string | null; readonly view: PageView }) {
	const { t } = useI18n();
	const [rootPageId, setRootPageId] = useState<string | null>(null);
	const url = pageId === null || pageId === rootPageId ? ROOT_STATUS_URL : statusUrl(pageId);
	const forFrameOnly = view.kind === "incident";
	const status = usePoller(url, {
		load: (signal) => getStatus(url, signal),
		intervalMs: forFrameOnly ? HISTORY_INTERVAL_MS : STATUS_INTERVAL_MS,
		maxBackoffMs: forFrameOnly ? HISTORY_MAX_BACKOFF_MS : STATUS_MAX_BACKOFF_MS,
		isFatal: isNotFound,
	});
	const body = status.data?.body;
	if (url === ROOT_STATUS_URL && body !== undefined && body.pageId !== rootPageId) setRootPageId(body.pageId);

	// When the status in hand arrived as the current view was entered (see StatusView).
	const viewKey = view.kind === "incident" ? `incident:${view.incidentId}` : view.kind;
	const [entered, setEntered] = useState({ viewKey, receivedAt: status.receivedAt });
	if (entered.viewKey !== viewKey) setEntered({ viewKey, receivedAt: status.receivedAt });

	const missing = status.fatal && isNotFound(status.error);
	// An incident still shows when its page's status cannot be read: in the template the page's
	// HTML names, with the page's ID for a title.
	const withoutStatus = body === undefined && view.kind === "incident" && pageId !== null && status.error !== null;
	// The views, and the page that does not exist, name the tab themselves (their effects run first).
	useDocumentTitle(body === undefined && !withoutStatus && !missing ? t("public.defaultTitle") : null);

	if (missing) return <NotFound what="page" />;
	/** The page shown: its ID. */
	let shown: string;
	let frame: PageFrame;
	let modern: boolean;
	if (body !== undefined) {
		shown = pageId ?? body.pageId;
		frame = { appearance: body.appearance, title: pageTitle(body.appearance, shown, t("public.defaultTitle")), home: pageId === null ? "/" : pagePath(shown), reportUrl: body.reportUrl };
		modern = body.template === "modern";
	} else if (withoutStatus && pageId !== null) {
		shown = pageId;
		frame = { appearance: undefined, title: pageTitle(undefined, pageId, t("public.defaultTitle")), home: pagePath(pageId), reportUrl: null };
		modern = expectedTemplate(pageId) === "modern";
	} else {
		return status.error === null ? (
			<PageLoading pageId={pageId} />
		) : (
			<PageUnavailable pageId={pageId} reason={describeError(status.error, t)} onRetry={status.refresh} />
		);
	}

	// Keyed by page and view: a view starts over on another page, or for another incident.
	const key = `${shown}:${viewKey}`;
	let content: ReactNode = null;
	if (view.kind === "incident") {
		content = <IncidentView key={key} pageId={shown} incidentId={view.incidentId} title={frame.title} modern={modern} />;
	} else if (body !== undefined && view.kind === "history") {
		content = <HistoryView key={key} pageId={shown} title={frame.title} modern={modern} body={body} />;
	} else if (body !== undefined) {
		const enteredWith = entered.viewKey === viewKey ? entered.receivedAt : status.receivedAt;
		content = <StatusView key={key} pageId={shown} title={frame.title} modern={modern} status={status} body={body} enteredWith={enteredWith} />;
	}
	if (!modern) return <DefaultFrame frame={frame}>{content}</DefaultFrame>;
	return (
		<Suspense fallback={<Loading />}>
			<ModernFrame frame={frame}>{content}</ModernFrame>
		</Suspense>
	);
}

const STATUS_VIEW: PageView = { kind: "status" };
const HISTORY_VIEW: PageView = { kind: "history" };

/** A page's status; `pageId` `null` is the first configured page, at the site's root. */
export function StatusPage({ pageId }: { readonly pageId: string | null }) {
	return <Page pageId={pageId} view={STATUS_VIEW} />;
}

/** A page's past incidents and outages (`/pages/:pageId/history`). */
export function HistoryPage({ pageId }: { readonly pageId: string }) {
	return <Page pageId={pageId} view={HISTORY_VIEW} />;
}

/** One incident of a page, with its timeline (`/pages/:pageId/incidents/:incidentId`). */
export function IncidentPage({ pageId, incidentId }: { readonly pageId: string; readonly incidentId: string }) {
	return <Page pageId={pageId} view={{ kind: "incident", incidentId }} />;
}
