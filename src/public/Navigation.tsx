/**
 * The links of a page's frame, in both templates: the header's navigation (links, and
 * menus of links) and the footer's columns, line of links and line of text. They come from
 * status.config.ts, or from the admin UI, in the status response (`appearance.header`,
 * `appearance.footer`); texts are shown in the visitor's language.
 *
 * Menus are disclosures (a button with `aria-expanded` that shows a list), not ARIA menus:
 * Escape closes one and returns the focus to its button, and so does a click outside it or the
 * focus leaving it (without moving the focus). On narrow screens, a navigation of more than two
 * entries folds behind a "Menu" button of its own, by CSS (public.css, modern.css).
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { pickText } from "../../shared/i18n/core";
import type { LocalizedText, PublicAppearance, PublicFooter, PublicNavItem, PublicNavLink } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";

/** A navigation of more entries than this folds behind a button on narrow screens. */
export const NAV_FOLD_AFTER = 2;

const NO_FOOTER: PublicFooter = { columns: [], links: [], text: null };

/**
 * The texts and links of a page's frame in `locale`. A status response from a version before
 * them (kept by a cache for up to 30 seconds after a deploy) has none: no links then, and the
 * one-language title and description.
 */
export function frameTexts(appearance: PublicAppearance | undefined, locale: string) {
	const localized = appearance?.localized as PublicAppearance["localized"] | undefined;
	return {
		title: localized === undefined ? (appearance?.title ?? null) : pickText(localized.title, locale),
		description: localized === undefined ? (appearance?.description ?? null) : pickText(localized.description, locale),
		nav: (appearance?.header as PublicAppearance["header"] | undefined)?.nav ?? [],
		footer: (appearance?.footer as PublicFooter | undefined) ?? NO_FOOTER,
	};
}

function isMenu(item: PublicNavItem): item is Extract<PublicNavItem, { readonly items: unknown }> {
	return "items" in item;
}

/** Whether a link leaves this site (a full URL rather than a path): it then sends no referrer. */
function external(url: string): boolean {
	return url.startsWith("https://") || url.startsWith("http://");
}

function useText(): (text: LocalizedText) => string {
	const { locale } = useI18n();
	return (text) => pickText(text, locale) ?? "";
}

/** A link of the frame. A plain anchor even for a path on this site: it may be another app (the admin UI, say). */
export function FrameLink({ link, className }: { readonly link: PublicNavLink; readonly className?: string }) {
	const text = useText();
	return (
		<a className={className} href={link.url} rel={external(link.url) ? "noopener noreferrer" : undefined}>
			{text(link.label)}
		</a>
	);
}

/**
 * Closes an open disclosure on Escape, on a click outside `root`, and when the focus moves out
 * of it. Escape with the focus inside closes the innermost open one only, and puts the focus
 * back on its button; with the focus elsewhere (a browser that does not focus a clicked button),
 * it closes every open one.
 */
function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, button: RefObject<HTMLButtonElement | null>) {
	useEffect(() => {
		const element = root.current;
		if (!open || element === null) return;
		const outside = (target: EventTarget | null) => !(target instanceof Node) || !element.contains(target);
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			// Handled: the disclosures around this one leave it.
			event.preventDefault();
			close();
			button.current?.focus();
		};
		const onDocumentKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && outside(document.activeElement)) close();
		};
		const onPointer = (event: PointerEvent) => {
			if (outside(event.target)) close();
		};
		const onFocus = (event: FocusEvent) => {
			if (outside(event.target)) close();
		};
		element.addEventListener("keydown", onKey);
		document.addEventListener("keydown", onDocumentKey);
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("focusin", onFocus);
		return () => {
			element.removeEventListener("keydown", onKey);
			document.removeEventListener("keydown", onDocumentKey);
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("focusin", onFocus);
		};
	}, [open, close, root, button]);
}

function Chevron() {
	return (
		<svg className="site-nav__chevron" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

function NavMenu({ label, items }: { readonly label: LocalizedText; readonly items: readonly PublicNavLink[] }) {
	const text = useText();
	const id = useId();
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	useDismiss(open, close, root, button);
	return (
		<div className="site-nav__menu" ref={root}>
			<button ref={button} type="button" className="site-nav__button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
				{text(label)}
				<Chevron />
			</button>
			<ul id={id} className="site-nav__items" hidden={!open}>
				{items.map((link, index) => (
					<li key={index}>
						<FrameLink link={link} className="site-nav__item" />
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The header's navigation: its links and menus, then `after` (the modern template's report
 * link, which keeps its own place at the end). Nothing without either.
 */
export function SiteNav({ nav, after }: { readonly nav: readonly PublicNavItem[]; readonly after?: ReactNode }) {
	const { t } = useI18n();
	const id = useId();
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	const root = useRef<HTMLElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	useDismiss(open, close, root, button);
	if (nav.length === 0 && after === undefined) return null;
	const folds = nav.length > NAV_FOLD_AFTER;
	return (
		<nav ref={root} className={folds ? "site-nav site-nav--folds" : "site-nav"} aria-label={t("public.nav.label")}>
			{folds && (
				<button ref={button} type="button" className="site-nav__toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
					{t("public.nav.menu")}
					<Chevron />
				</button>
			)}
			<ul id={id} className={open ? "site-nav__list site-nav__list--open" : "site-nav__list"}>
				{nav.map((item, index) => (
					<li key={index}>{isMenu(item) ? <NavMenu label={item.label} items={item.items} /> : <FrameLink link={item} className="site-nav__link" />}</li>
				))}
				{after !== undefined && <li>{after}</li>}
			</ul>
		</nav>
	);
}

/** The footer's columns of links, line of links and line of text; nothing when it has none. */
export function FooterLinks({ footer }: { readonly footer: PublicFooter }) {
	const text = useText();
	if (footer.columns.length === 0 && footer.links.length === 0 && footer.text === null) return null;
	const footerText = footer.text === null ? "" : text(footer.text);
	return (
		<div className="site-footer">
			{footer.columns.length > 0 && (
				<div className="site-footer__columns">
					{footer.columns.map((column, index) => (
						<section key={index} className="site-footer__column">
							<h2 className="site-footer__title">{text(column.title)}</h2>
							<ul className="site-footer__list">
								{column.links.map((link, linkIndex) => (
									<li key={linkIndex}>
										<FrameLink link={link} />
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
			{footer.links.length > 0 && (
				<ul className="site-footer__links">
					{footer.links.map((link, index) => (
						<li key={index}>
							<FrameLink link={link} />
						</li>
					))}
				</ul>
			)}
			{footerText !== "" && <p className="site-footer__text">{footerText}</p>}
		</div>
	);
}
