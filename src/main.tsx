import { App } from "./App";
import { STATUS_CATALOG } from "./i18n/catalog";
import { boot } from "./i18n/boot";
import { CrashedPage } from "./public/Layout";
import { preloadModern } from "./public/modern/lazy";
import { expectedTemplateAt } from "./public/templates";
import "./index.css";
import "./public.css";

void boot("root", <App />, {
	catalog: STATUS_CATALOG,
	fallback: (_error, crashes, retry) => <CrashedPage crashes={crashes} retry={retry} />,
	// A page in the modern template shows in it from the start, its loading screen included.
	prepare: async () => {
		if (expectedTemplateAt(window.location.pathname) === "modern") await preloadModern();
	},
});
