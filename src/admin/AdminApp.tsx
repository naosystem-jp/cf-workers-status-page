/**
 * The admin UI, a separate entry from the public status page, served by the Worker only
 * after authentication. Everything it shows comes from the admin API.
 *
 * Routes (all under `/admin`): `incidents` (also `/admin`), `incidents/new` (pre-filled from
 * `?page=&components=`, the link that notifications point to), `incidents/:id`, `maintenance`,
 * `maintenance/new`, `maintenance/:id`, `monitors`, `appearance`, `notifications`,
 * `notifications/new`, `notifications/:id`, `deliveries`. Per-page views take `?page=`.
 */
import { useEffect } from "react";
import type { AdminMe, AdminPagesResponse } from "../../shared/admin-api";
import { LanguageSelect } from "../i18n/I18nProvider";
import { useAdminI18n } from "./messages";
import { Link, matchPath, navigate, useLocation } from "../lib/router";
import { api } from "./api";
import { AdminProvider } from "./context";
import { ErrorAlert } from "./forms";
import { LeaveDialog, Loading, ViewHeader } from "./layout";
import { useLoad } from "./useLoad";
import { AppearanceView } from "./views/AppearanceView";
import { DeliveriesView } from "./views/DeliveriesView";
import { IncidentCreateView } from "./views/IncidentCreateView";
import { IncidentDetailView } from "./views/IncidentDetailView";
import { IncidentsView } from "./views/IncidentsView";
import { MaintenanceEditView, MaintenanceCreateView } from "./views/MaintenanceFormView";
import { MaintenanceView } from "./views/MaintenanceView";
import { MonitorsView } from "./views/MonitorsView";
import { TargetCreateView, TargetEditView } from "./views/TargetFormView";
import { TargetsView } from "./views/TargetsView";

const NAV = [
	{ path: "/admin/incidents", key: "admin.nav.incidents", perPage: true },
	{ path: "/admin/maintenance", key: "admin.nav.maintenance", perPage: true },
	{ path: "/admin/monitors", key: "admin.nav.monitors", perPage: false },
	{ path: "/admin/appearance", key: "admin.nav.appearance", perPage: true },
	{ path: "/admin/notifications", key: "admin.nav.notifications", perPage: false },
	{ path: "/admin/deliveries", key: "admin.nav.deliveries", perPage: false },
] as const;

export function AdminApp() {
	const { t } = useAdminI18n();
	const me = useLoad("me", (signal) => api.get<AdminMe>("/me", signal));
	const pages = useLoad("pages", (signal) => api.get<AdminPagesResponse>("/pages", signal));
	const location = useLocation();

	useEffect(() => {
		if (location.pathname === "/admin" || location.pathname === "/admin/") navigate("/admin/incidents", { replace: true });
	}, [location.pathname]);

	const error = me.error ?? pages.error;
	const ready = me.data !== undefined && pages.data !== undefined;
	const page = location.search.get("page");

	return (
		<div className="admin">
			<a className="skip-link" href="#main">
				{t("ui.skipToContent")}
			</a>
			<header className="admin-header">
				<p className="admin-header__brand">
					<Link href="/admin/incidents">{t("admin.title")}</Link>
				</p>
				<nav aria-label={t("admin.nav.label")} className="admin-nav">
					<ul>
						{NAV.map((item) => {
							const current = location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
							return (
								<li key={item.path}>
									<Link
										href={item.perPage && page !== null ? `${item.path}?page=${encodeURIComponent(page)}` : item.path}
										aria-current={current ? "page" : undefined}
									>
										{t(item.key)}
									</Link>
								</li>
							);
						})}
					</ul>
				</nav>
				<div className="admin-header__meta">
					{me.data !== undefined && (
						<span className="muted">{t("admin.signedInAs", { name: me.data.author ?? me.data.identity.id })}</span>
					)}
					<a href="/" className="muted">
						{t("admin.viewStatusPage")}
					</a>
					<LanguageSelect className="language" />
				</div>
			</header>
			<main id="main" className="admin-main" tabIndex={-1}>
				{error !== null && error !== undefined ? (
					<>
						<ViewHeader title={t("admin.title")} />
						<ErrorAlert
							error={error}
							onRetry={() => {
								me.reload();
								pages.reload();
							}}
						/>
					</>
				) : !ready ? (
					<Loading />
				) : (
					<AdminProvider value={{ me: me.data, pages: pages.data.pages, uploads: pages.data.uploads }}>
						<Route pathname={location.pathname} />
					</AdminProvider>
				)}
			</main>
			<LeaveDialog />
		</div>
	);
}

function Route({ pathname }: { readonly pathname: string }) {
	const { t } = useAdminI18n();
	const id = (pattern: string) => matchPath(pattern, pathname)?.["id"];
	switch (pathname) {
		case "/admin":
		case "/admin/":
		case "/admin/incidents":
			return <IncidentsView />;
		case "/admin/incidents/new":
			return <IncidentCreateView />;
		case "/admin/maintenance":
			return <MaintenanceView />;
		case "/admin/maintenance/new":
			return <MaintenanceCreateView />;
		case "/admin/monitors":
			return <MonitorsView />;
		case "/admin/appearance":
			return <AppearanceView />;
		case "/admin/notifications":
			return <TargetsView />;
		case "/admin/notifications/new":
			return <TargetCreateView />;
		case "/admin/deliveries":
			return <DeliveriesView />;
	}
	const incident = id("/admin/incidents/:id");
	if (incident !== undefined) return <IncidentDetailView key={incident} id={incident} />;
	const maintenance = id("/admin/maintenance/:id");
	if (maintenance !== undefined) return <MaintenanceEditView key={maintenance} id={maintenance} />;
	const target = id("/admin/notifications/:id");
	if (target !== undefined) return <TargetEditView key={target} id={target} />;
	return (
		<>
			<ViewHeader title={t("admin.notFound.title")} />
			<p>{t("admin.notFound.detail")}</p>
		</>
	);
}
