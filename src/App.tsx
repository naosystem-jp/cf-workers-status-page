import { matchPath, useLocation } from "./lib/router";
import { NotFound } from "./public/Layout";
import { Page, type PageView } from "./public/Page";

/**
 * The public status page. Routes:
 * - `/`: the first page of status.config.ts;
 * - `/pages/:pageId`: any page (the first one too);
 * - `/pages/:pageId/incidents/:incidentId`: an incident with its whole timeline;
 * - `/pages/:pageId/history`: past incidents and detected outages.
 * `/admin` and `/api` never reach this app (the Worker answers them), and `/pages/…` cannot
 * collide with them whatever the page IDs are.
 *
 * The routes of a page are views of one {@link Page}, which stays as visitors move between
 * them: its frame and status stay, and only the view changes (Page.tsx).
 */
export function App() {
	const { pathname } = useLocation();
	const route = routeOf(pathname);
	if (route === null) return <NotFound what="path" />;
	return <Page pageId={route.pageId} view={route.view} />;
}

const STATUS_VIEW: PageView = { kind: "status" };
const HISTORY_VIEW: PageView = { kind: "history" };

function routeOf(pathname: string): { readonly pageId: string | null; readonly view: PageView } | null {
	if (pathname === "/") return { pageId: null, view: STATUS_VIEW };
	const page = matchPath("/pages/:pageId", pathname);
	if (page !== null) return { pageId: page["pageId"] as string, view: STATUS_VIEW };
	const past = matchPath("/pages/:pageId/history", pathname);
	if (past !== null) return { pageId: past["pageId"] as string, view: HISTORY_VIEW };
	const incident = matchPath("/pages/:pageId/incidents/:incidentId", pathname);
	if (incident !== null) return { pageId: incident["pageId"] as string, view: { kind: "incident", incidentId: incident["incidentId"] as string } };
	return null;
}
