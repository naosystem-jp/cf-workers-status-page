import { type ReactNode, Suspense, useEffect } from "react";
import type { PublicAppearance } from "../../shared/public-api";
import { Icon } from "../components/Icon";
import { LanguageSelect, useI18n } from "../i18n/I18nProvider";
import { Link } from "../lib/router";
import { useBrandAppearance } from "./brand";
import { ModernLoadingView, ModernUnavailableView } from "./modern/lazy";
import { FooterLinks, frameTexts, SiteNav } from "./Navigation";
import { expectedTemplate } from "./templates";

/**
 * The page's title in `locale` (status.config.ts's or an administrator's), else the page's
 * ID (the documented default, shared/admin-api.ts).
 */
export function pageTitle(appearance: PublicAppearance | undefined, pageId: string | null, fallback: string, locale: string): string {
	return frameTexts(appearance, locale).title ?? pageId ?? fallback;
}

/** Sets the tab's title; `null` leaves it to another component. */
export function useDocumentTitle(title: string | null): void {
	useEffect(() => {
		if (title !== null) document.title = title;
	}, [title]);
}

/** What surrounds every view of a page (its status, history, incidents): header and footer. */
export interface PageFrame {
	/** `undefined` when the page's status could not be read (an incident shows without it). */
	readonly appearance: PublicAppearance | undefined;
	readonly title: string;
	/** The status page's own address, where the title links without a website. */
	readonly home: string;
	/** Where visitors report a problem (the modern template's header). */
	readonly reportUrl: string | null;
}

/** A page's frame in the default template, around one of its views (`children`). */
export function DefaultFrame({ frame, children }: { readonly frame: PageFrame; readonly children: ReactNode }) {
	const { t } = useI18n();
	return (
		<div className="page">
			<a className="skip-link" href="#main">
				{t("ui.skipToContent")}
			</a>
			<PageHeader appearance={frame.appearance} title={frame.title} home={frame.home} />
			<main id="main" tabIndex={-1}>
				{children}
			</main>
			<PageFooter appearance={frame.appearance} />
		</div>
	);
}

/** A view of a page (in its frame) before what it shows arrived. */
export function ViewLoading() {
	const { t } = useI18n();
	return (
		<div className="loading" aria-busy="true">
			<p>{t("ui.loading")}</p>
		</div>
	);
}

/** A view of a page (in its frame) whose first request failed. */
export function ViewUnavailable({ reason, onRetry }: UnavailableProps) {
	const { t } = useI18n();
	return (
		<div className="unavailable">
			<h2>{t("public.unavailable.title")}</h2>
			<p role="alert">{t("public.unavailable.detail", { reason })}</p>
			<p>
				<button type="button" className="button" onClick={onRetry}>
					<Icon name="refresh" />
					{t("public.freshness.retryNow")}
				</button>
			</p>
		</div>
	);
}

/** A view of a page (in its frame) showing something that does not exist, such as an incident. */
export function ViewNotFound({ message, back }: { readonly message: string; readonly back: string }) {
	const { t } = useI18n();
	return (
		<div className="not-found">
			<h2>{t("public.notFound.title")}</h2>
			<p>{message}</p>
			<p>
				<Link href={back}>← {t("public.incident.back")}</Link>
			</p>
		</div>
	);
}

export interface PageHeaderProps {
	readonly appearance: PublicAppearance | undefined;
	readonly title: string;
	/** The status page's own address, where the heading links without a website. */
	readonly home: string;
}

/**
 * Logo or title, the header's navigation, and description. The
 * heading links to the organisation's website when one is set ("where the heading links to",
 * shared/admin-api.ts), else to the status page itself. Also applies the page's colours and
 * favicon (brand.ts).
 */
export function PageHeader({ appearance, title, home }: PageHeaderProps) {
	const { t, locale } = useI18n();
	useBrandAppearance(appearance);
	const { description, nav } = frameTexts(appearance, locale);
	const brand = appearance?.logoUrl ? (
		<img className="page-header__logo" src={appearance.logoUrl} alt={title} referrerPolicy="no-referrer" />
	) : (
		<span className="page-header__title">{title}</span>
	);
	return (
		<header className="page-header">
			<div className="page-header__top">
				<h1 className="page-header__heading">
					{appearance?.websiteUrl ? (
						<a className="page-header__home" href={appearance.websiteUrl} rel="noopener noreferrer">
							{brand}
							<Icon name="external" className="page-header__external" />
							<span className="visually-hidden"> ({t("public.header.website")})</span>
						</a>
					) : (
						<Link href={home} className="page-header__home">
							{brand}
						</Link>
					)}
				</h1>
				<SiteNav nav={nav} />
			</div>
			{description && <p className="page-header__description">{description}</p>}
		</header>
	);
}

/** The time zone and the language, under the page's own links and text when `appearance` has them. */
export function PageFooter({ appearance, children }: { readonly appearance?: PublicAppearance | undefined; readonly children?: ReactNode }) {
	const { t, f, locale } = useI18n();
	return (
		<footer className="page-footer">
			<FooterLinks footer={frameTexts(appearance, locale).footer} />
			{children}
			<p>{t("public.footer.timeZone", { timeZone: f.timeZone })}</p>
			<LanguageSelect className="language" />
		</footer>
	);
}

/** A page of the site that does not exist (or a status page that is not configured). */
export function NotFound({ what }: { readonly what: "page" | "incident" | "path" }) {
	const { t } = useI18n();
	useDocumentTitle(t("public.notFound.title"));
	return (
		<div className="page">
			<main id="main" className="not-found">
				<h1>{t("public.notFound.title")}</h1>
				<p>{t(`public.notFound.${what}`)}</p>
				<p>
					<Link href="/">{t("public.notFound.home")}</Link>
				</p>
			</main>
			<PageFooter />
		</div>
	);
}

/** Before anything arrived. */
export function Loading() {
	const { t } = useI18n();
	return (
		<div className="page">
			<main id="main" className="loading" aria-busy="true">
				<p>{t("ui.loading")}</p>
			</main>
		</div>
	);
}

/**
 * Before the page `pageId` (`null`: the site's root page) has its status: in the template its
 * HTML names (src/public/templates.ts), else in the default one.
 */
export function PageLoading({ pageId }: { readonly pageId: string | null }) {
	if (expectedTemplate(pageId) !== "modern") return <Loading />;
	return (
		<Suspense fallback={<Loading />}>
			<ModernLoadingView />
		</Suspense>
	);
}

export interface UnavailableProps {
	readonly reason: string;
	readonly onRetry: () => void;
}

/** The first request of the page `pageId` failed: as {@link Unavailable}, in the page's template (see {@link PageLoading}). */
export function PageUnavailable({ pageId, ...props }: UnavailableProps & { readonly pageId: string | null }) {
	if (expectedTemplate(pageId) !== "modern") return <Unavailable {...props} />;
	return (
		<Suspense fallback={<Loading />}>
			<ModernUnavailableView {...props} />
		</Suspense>
	);
}

/** The first request failed: nothing to show, and nothing old to show either. */
export function Unavailable({ reason, onRetry }: UnavailableProps) {
	const { t } = useI18n();
	return (
		<div className="page">
			<main id="main" className="unavailable">
				<h1>{t("public.unavailable.title")}</h1>
				<p role="alert">{t("public.unavailable.detail", { reason })}</p>
				<p>
					<button type="button" className="button" onClick={onRetry}>
						<Icon name="refresh" />
						{t("public.freshness.retryNow")}
					</button>
				</p>
			</main>
			<PageFooter />
		</div>
	);
}

/** After the first failure, render again this long after; after more, reload the page (a deploy may have fixed it). */
export const CRASH_RETRY_MS = 30_000;
export const CRASH_RELOAD_MS = 60_000;

/**
 * Shown when the status page failed to render: as "unavailable" (nothing is known), with a
 * retry, and it keeps trying by itself, as polling would: it renders again after 30 seconds,
 * and after a second failure reloads the page every minute, which also picks up a newer
 * version of the page after a deploy (an open page meeting data it does not know, say).
 */
export function CrashedPage({ crashes, retry }: { readonly crashes: number; readonly retry: () => void }) {
	const { t } = useI18n();
	useEffect(() => {
		const again = crashes > 1 ? () => window.location.reload() : retry;
		const timer = setTimeout(again, crashes > 1 ? CRASH_RELOAD_MS : CRASH_RETRY_MS);
		return () => clearTimeout(timer);
	}, [crashes, retry]);
	const onRetry = () => {
		if (crashes > 1) window.location.reload();
		else retry();
	};
	return <Unavailable reason={t("public.error.unknown")} onRetry={onRetry} />;
}
