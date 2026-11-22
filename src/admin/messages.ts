/**
 * The admin UI's messages: its own (shared/i18n/admin/) on top of the status page's (states,
 * stages, impacts …), loaded together for the language shown.
 */
import adminEn from "../../shared/i18n/admin/en";
import type { AdminMessageKey, AdminTranslation, MessageKey, Translate } from "../../shared/i18n/core";
import { type Catalog, loadersByLocale, loadWith, STATUS_CATALOG } from "../i18n/catalog";
import { type I18n, useCatalog } from "../i18n/I18nProvider";

export type AdminKey = MessageKey | AdminMessageKey;
export type AdminTranslate = Translate<AdminKey>;

const ADMIN_LOADERS = loadersByLocale(
	import.meta.glob<AdminTranslation>(["../../shared/i18n/admin/*.ts", "!../../shared/i18n/admin/en.ts"], { import: "default" }),
);

export const ADMIN_CATALOG: Catalog<AdminKey> = {
	reference: { ...STATUS_CATALOG.reference, ...adminEn },
	load: async (tag) => {
		const [status, admin] = await Promise.all([STATUS_CATALOG.load(tag), loadWith(ADMIN_LOADERS, tag)]);
		return { ...status, ...admin };
	},
};

/** Translations for the admin UI (under the admin catalog's provider). */
export function useAdminI18n(): I18n<AdminKey> {
	return useCatalog(ADMIN_CATALOG);
}
