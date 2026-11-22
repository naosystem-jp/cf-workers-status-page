/**
 * The colours and favicon an administrator set for a page, applied to the
 * whole document: custom properties on `<html>`, which the templates' tokens fall back from
 * (see shared/colors.ts), and a `<link rel="icon">` in `<head>`.
 *
 * Properties are set through the CSSOM (`style.setProperty`), which the page's
 * Content-Security-Policy (`style-src 'self'`, public/_headers) allows, unlike a `style`
 * attribute or a `<style>` element.
 *
 * What a page applied stays until another page's appearance arrives, rather than until its
 * view unmounts: moving between a page's views, or to another page, then never flashes the
 * template's colours while the next view loads.
 */
import { useLayoutEffect } from "react";
import { brandProperties } from "../../shared/colors";
import type { PublicAppearance } from "../../shared/public-api";

interface Applied {
	readonly key: string;
	readonly properties: readonly string[];
	readonly favicon: HTMLLinkElement | null;
}

let applied: Applied = { key: "", properties: [], favicon: null };

function keyOf(appearance: PublicAppearance): string {
	return JSON.stringify([appearance.colors, appearance.faviconUrl]);
}

/** Replaces what is applied with `appearance`'s colours and favicon. */
export function applyBrand(appearance: PublicAppearance): void {
	const key = keyOf(appearance);
	if (key === applied.key) return;
	const style = document.documentElement.style;
	for (const name of applied.properties) style.removeProperty(name);
	applied.favicon?.remove();
	const properties = brandProperties(appearance.colors);
	for (const [name, value] of Object.entries(properties)) style.setProperty(name, value);
	let favicon: HTMLLinkElement | null = null;
	if (appearance.faviconUrl !== null) {
		favicon = document.createElement("link");
		favicon.rel = "icon";
		favicon.href = appearance.faviconUrl;
		document.head.append(favicon);
	}
	applied = { key, properties: Object.keys(properties), favicon };
}

/** Applies the page's colours and favicon once its appearance is known (before paint); `undefined` keeps what is applied. */
export function useBrandAppearance(appearance: PublicAppearance | undefined): void {
	const key = appearance === undefined ? null : keyOf(appearance);
	useLayoutEffect(() => {
		if (appearance !== undefined) applyBrand(appearance);
		// Keyed by what is applied, not by the object, which every poll replaces.
	}, [key]);
}
