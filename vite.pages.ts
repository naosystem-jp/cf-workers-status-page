/**
 * Build-time part of the status page's loading screens: writes which
 * template each page uses into the status page's HTML (index.html), so that a page shows its
 * loading screen in its own template before the public API answers, instead of in the default
 * template, then in its own (src/public/templates.ts). The format is in the core package
 * (page-templates.ts).
 *
 * The templates are in status.config.ts, which this reads with Vite's module runner, under the
 * dev server (again after it changes) and in a build. A configuration that cannot be read
 * leaves the HTML as it is, with a warning: pages then wait for the API, as without this, and
 * the Worker reports what is wrong with the configuration when it loads it.
 *
 * The package's Vite plugin (packages/cf-workers-status-page/src/vite.ts) does the same for
 * the prebuilt status page it serves.
 */
import path from "node:path";
import { type Logger, type Plugin, runnerImport } from "vite";
import type { StatusConfig } from "./packages/core/src/config.ts";
// By path, not by the package's name: Vite bundles relative imports of its configuration, but
// loads packages as they are, and Node.js cannot load the core package's TypeScript sources.
import { type PageTemplateEntry, pageTemplatesOf, withPageTemplates } from "./packages/core/src/page-templates.ts";

export interface LoadedPageTemplates {
	/** `null` when the configuration could not be read, or a page is not valid. */
	readonly entries: PageTemplateEntry[] | null;
	/** The files the configuration was read from, to read it again when one changes. */
	readonly files: readonly string[];
}

/** Reads each page's template from the configuration file (an absolute path). */
export async function loadPageTemplates(configFile: string, logger: Logger): Promise<LoadedPageTemplates> {
	try {
		const { module, dependencies } = await runnerImport<{ default?: StatusConfig }>(configFile, { logLevel: "silent" });
		const entries = module.default === undefined ? null : pageTemplatesOf(module.default);
		if (entries === null) logger.warn(`${path.basename(configFile)}: its pages could not be read; status pages load in the default template.`);
		return { entries, files: [configFile, ...dependencies] };
	} catch (error) {
		logger.warn(
			`${path.basename(configFile)} could not be read for the status page's HTML; status pages load in the default template. ${error instanceof Error ? error.message : String(error)}`,
		);
		return { entries: null, files: [configFile] };
	}
}

export interface PageTemplatesOptions {
	/** The configuration file, relative to the project root. Default `status.config.ts`. */
	readonly config?: string;
}

/** Writes the pages' templates into index.html (not into the admin UI's HTML). */
export function pageTemplates(options: PageTemplatesOptions = {}): Plugin {
	let root = process.cwd();
	let configFile = "";
	let logger: Logger;
	/** Read once per build; under the dev server, again after one of its files changed. */
	let loaded: Promise<LoadedPageTemplates> | null = null;
	const load = () => (loaded ??= loadPageTemplates(configFile, logger));
	return {
		name: "cf-workers-status-page:page-templates",

		configResolved(config) {
			root = config.root;
			configFile = path.resolve(root, options.config ?? "status.config.ts");
			logger = config.logger;
		},

		configureServer(server) {
			server.watcher.on("all", (_event, file) => {
				if (loaded === null) return;
				const current = loaded;
				void current.then(({ files }) => {
					if (loaded === current && files.includes(path.resolve(file))) loaded = null;
				});
			});
		},

		transformIndexHtml: {
			order: "post",
			async handler(html, context) {
				// `path` is "/index.html" in a build and under Vite's own HTML middleware; the
				// Cloudflare plugin's dev server passes the file's absolute path instead.
				const index = path.join(root, "index.html");
				if (context.path !== "/index.html" && path.resolve(context.path) !== index) return html;
				const { entries } = await load();
				return entries === null ? html : withPageTemplates(html, entries);
			},
		},
	};
}
