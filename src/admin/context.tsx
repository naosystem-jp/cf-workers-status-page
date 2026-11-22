import { createContext, type ReactNode, useContext } from "react";
import type { AdminMe, AdminPage } from "../../shared/admin-api";
import { navigate, useLocation, withQuery } from "../lib/router";

export interface AdminData {
	readonly me: AdminMe;
	/** Pages and components of status.config.ts. */
	readonly pages: readonly AdminPage[];
	/** Whether images can be uploaded (the Worker has its R2 bucket). */
	readonly uploads: boolean;
}

const AdminContext = createContext<AdminData | null>(null);

export function AdminProvider({ value, children }: { readonly value: AdminData; readonly children: ReactNode }) {
	return <AdminContext value={value}>{children}</AdminContext>;
}

export function useAdmin(): AdminData {
	const value = useContext(AdminContext);
	if (value === null) throw new Error("useAdmin() outside <AdminProvider>");
	return value;
}

/**
 * The page a per-page view shows (incidents, maintenance, appearance): `?page=` in the URL,
 * so that links and reloads keep it; the first page by default. `page` is `undefined` when
 * the URL names a page that status.config.ts no longer has (its incidents can still be listed).
 */
export function useSelectedPage(): { readonly pageId: string; readonly page: AdminPage | undefined; select(pageId: string): void } {
	const { pages } = useAdmin();
	const location = useLocation();
	const pageId = location.search.get("page") ?? pages[0]?.id ?? "";
	return {
		pageId,
		page: pages.find((page) => page.id === pageId),
		select: (id) => {
			const params = Object.fromEntries(location.search);
			navigate(withQuery(location.pathname, { ...params, page: id }), { replace: true, keepScroll: true });
		},
	};
}
