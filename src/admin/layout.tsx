import { type ReactNode, useEffect, useRef } from "react";
import { Link, useLeaveRequest, useLocation, withQuery } from "../lib/router";
import { useAdmin, useSelectedPage } from "./context";
import { useAdminI18n } from "./messages";

/** A view's heading, focused when the view opens (so screen readers announce the new view). */
export function ViewHeader({ title, actions, children }: { readonly title: ReactNode; readonly actions?: ReactNode; readonly children?: ReactNode }) {
	const heading = useRef<HTMLHeadingElement>(null);
	const { pathname } = useLocation();
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, [pathname]);
	return (
		<header className="view-header">
			<div className="view-header__row">
				<h1 ref={heading} tabIndex={-1} className="view-header__title">
					{title}
				</h1>
				{actions !== undefined && <div className="actions">{actions}</div>}
			</div>
			{children}
		</header>
	);
}

/** Chooses the page of a per-page view (`?page=`); only shown when there are several. */
export function PagePicker() {
	const { t } = useAdminI18n();
	const { pages } = useAdmin();
	const { pageId, page, select } = useSelectedPage();
	if (pages.length < 2 && page !== undefined) return null;
	return (
		<label className="inline-field">
			<span>{t("admin.page.label")}</span>
			<select value={pageId} onChange={(event) => select(event.target.value)}>
				{page === undefined && <option value={pageId}>{t("admin.page.removed", { page: pageId })}</option>}
				{pages.map((candidate) => (
					<option key={candidate.id} value={candidate.id}>
						{candidate.id}
					</option>
				))}
			</select>
		</label>
	);
}

/** A link that keeps the selected page (`?page=`). */
export function pageLink(path: string, pageId: string, extra: Readonly<Record<string, string | undefined>> = {}): string {
	return withQuery(path, { page: pageId, ...extra });
}

export function Loading() {
	const { t } = useAdminI18n();
	return (
		<p className="muted" aria-busy="true">
			{t("ui.loading")}
		</p>
	);
}

export function BackLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
	return (
		<p className="back-link">
			<Link href={href}>← {children}</Link>
		</p>
	);
}

/** Shown when the admin UI failed to render: what happened, and ways out. */
export function CrashPanel({ error, retry }: { readonly error: unknown; readonly retry: () => void }) {
	const { t } = useAdminI18n();
	return (
		<main className="admin-main">
			<div className="alert alert--error" role="alert">
				<div>
					<p className="conflict__title">{t("admin.crash.title")}</p>
					<p>{t("admin.crash.detail")}</p>
					<p className="mono">{error instanceof Error ? error.message : String(error)}</p>
					<p className="actions">
						<button type="button" className="button button--primary" onClick={() => window.location.reload()}>
							{t("admin.action.reloadPage")}
						</button>
						<button type="button" className="button" onClick={retry}>
							{t("admin.action.retry")}
						</button>
					</p>
				</div>
			</div>
		</main>
	);
}

/**
 * Asks whether to leave a form with unsaved changes (links and back/forward within the admin
 * UI; closing the tab gets the browser's own question). Focus goes to "stay"; Escape stays.
 */
export function LeaveDialog() {
	const { t } = useAdminI18n();
	const request = useLeaveRequest();
	const stay = useRef<HTMLButtonElement>(null);
	const previous = useRef<Element | null>(null);
	useEffect(() => {
		if (request === null) return;
		previous.current = document.activeElement;
		stay.current?.focus();
		return () => {
			if (previous.current instanceof HTMLElement) previous.current.focus();
		};
	}, [request]);
	if (request === null) return null;
	return (
		<div className="modal-backdrop">
			<div
				className="modal"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="leave-title"
				aria-describedby="leave-question"
				onKeyDown={(event) => {
					if (event.key === "Escape") request.stay();
					// Keep focus within the dialog.
					if (event.key === "Tab") {
						const buttons = [...event.currentTarget.querySelectorAll("button")];
						const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
						const next = buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length];
						event.preventDefault();
						next?.focus();
					}
				}}
			>
				<h2 id="leave-title" className="panel__title">
					{t("admin.form.leaveTitle")}
				</h2>
				<p id="leave-question">{request.question}</p>
				<div className="actions">
					<button ref={stay} type="button" className="button button--primary" onClick={request.stay}>
						{t("admin.form.stay")}
					</button>
					<button type="button" className="button button--danger" onClick={request.leave}>
						{t("admin.form.leave")}
					</button>
				</div>
			</div>
		</div>
	);
}
