/**
 * The Vite plugin of a deployment: `plugins: [statusPage()]` in the user's vite.config.ts.
 *
 * The user's repository holds only status.config.ts, a short wrangler.jsonc (the Worker's
 * name, its D1 database and its queues) and this plugin. The plugin
 *
 * 1. adds the Cloudflare Vite plugin, and gives it everything else the Worker needs in its
 *    Wrangler configuration (entry point, Durable Objects, queue consumers, Cron, static
 *    assets), so that a new version of the package can change these without the user
 *    editing wrangler.jsonc;
 * 2. points the Worker's `virtual:cf-workers-status-page/config` at the user's
 *    status.config.ts, which the Worker validates when it loads;
 * 3. serves the status page and admin UI from the package's prebuilt client (no React build
 *    in the user's project), and gives the Worker the admin UI's HTML, which only the Worker
 *    serves (after authentication);
 * 4. writes which template each page uses into the status page's HTML, so that a page shows
 *    its loading screen in its own template (vite.pages.ts at the repository root does the
 *    same for a build from the repository).
 */
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare, type PluginConfig } from "@cloudflare/vite-plugin";
import {
	type PageTemplateEntry,
	pageTemplatesOf,
	type StatusConfig,
	withPageTemplates,
} from "@naosystem/cf-workers-status-page-core";
import { type Logger, loadEnv, type Plugin, type PluginOption, runnerImport } from "vite";
import { ADMIN_HTML_MODULE, CONFIG_MODULE } from "./modules";

const PACKAGE_NAME = "@naosystem/cf-workers-status-page";

/** This file's directory: the package's `dist/`. (No `new URL(…, import.meta.url)`: Vite would treat it as an asset.) */
const DIST = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(DIST, "worker.js");
const CLIENT_DIR = path.join(DIST, "client");
const ADMIN_HTML = path.join(DIST, "admin.html");
const STATUS_PAGE_HTML = path.join(CLIENT_DIR, "index.html");

/** The oldest compatibility date this version is tested with; a later one in wrangler.jsonc is kept. */
export const COMPATIBILITY_DATE = "2026-11-17";

/** The queue bindings the user names in wrangler.jsonc (`queues.producers`). */
const NOTIFICATIONS = "NOTIFICATIONS";
const NOTIFICATIONS_DLQ = "NOTIFICATIONS_DLQ";

/** The variable that opts in to the admin login bypass under the dev server (see worker/admin/auth.ts). */
const DEV_BYPASS_VARIABLE = "ADMIN_DEV_BYPASS";

type WorkerConfig = Parameters<Extract<NonNullable<PluginConfig["config"]>, (...args: never[]) => unknown>>[0];

export interface StatusPageOptions {
	/** The configuration file, relative to the project root. Default `status.config.ts`. */
	readonly config?: string;
	/** Options of the Cloudflare Vite plugin, except `config`, which this plugin sets. */
	readonly cloudflare?: Omit<PluginConfig, "config">;
}

/** Everything the Worker needs besides what the user names; merged over wrangler.jsonc. */
export function workerConfig(config: WorkerConfig): Partial<WorkerConfig> {
	const producers = config.queues?.producers ?? [];
	const queueOf = (binding: string): string => {
		const producer = producers.find((p) => p.binding === binding);
		if (producer?.queue === undefined) {
			throw new Error(
				`${PACKAGE_NAME}: wrangler.jsonc must name the queue of the ${binding} binding under queues.producers`,
			);
		}
		return producer.queue;
	};
	const notifications = queueOf(NOTIFICATIONS);
	const deadLetters = queueOf(NOTIFICATIONS_DLQ);
	if (!(config.d1_databases ?? []).some((d1) => d1.binding === "DB")) {
		throw new Error(`${PACKAGE_NAME}: wrangler.jsonc must name a D1 database with the binding DB under d1_databases`);
	}
	const compatibilityDate =
		config.compatibility_date !== undefined && config.compatibility_date > COMPATIBILITY_DATE
			? config.compatibility_date
			: COMPATIBILITY_DATE;
	return {
		main: WORKER_ENTRY,
		compatibility_date: compatibilityDate,
		observability: { enabled: true },
		upload_source_maps: true,
		assets: {
			binding: "ASSETS",
			not_found_handling: "single-page-application",
			run_worker_first: ["/api/*", "/admin", "/admin/*"],
		},
		durable_objects: {
			bindings: [
				{ name: "STATUS_PAGE", class_name: "StatusPage" },
				{ name: "MONITOR", class_name: "Monitor" },
				{ name: "RECONCILER", class_name: "Reconciler" },
			],
		},
		exports: {
			PublicApi: { type: "worker", cache: { enabled: true } },
			StatusPage: { type: "durable-object", storage: "sqlite" },
			Monitor: { type: "durable-object", storage: "sqlite" },
			Reconciler: { type: "durable-object", storage: "sqlite" },
		},
		queues: {
			consumers: [
				{
					queue: notifications,
					max_batch_size: 10,
					max_batch_timeout: 2,
					max_retries: 20,
					retry_delay: 60,
					dead_letter_queue: deadLetters,
				},
				{ queue: deadLetters, max_batch_size: 10, max_batch_timeout: 5, max_retries: 100, retry_delay: 300 },
			],
		},
		version_metadata: { binding: "CF_VERSION_METADATA" },
		triggers: { crons: ["* * * * *"] },
	} as Partial<WorkerConfig>;
}

interface LoadedPageTemplates {
	/** `null` when the configuration could not be read, or a page is not valid. */
	readonly entries: PageTemplateEntry[] | null;
	/** The files the configuration was read from, to read it again when one changes. */
	readonly files: readonly string[];
}

/**
 * Each page's template, from the configuration file (an absolute path). A configuration that
 * cannot be read leaves the HTML as it is, with a warning: pages then wait for the API before
 * showing their template, and the Worker reports what is wrong when it loads the configuration.
 */
async function loadPageTemplates(configFile: string, logger: Logger): Promise<LoadedPageTemplates> {
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

/**
 * Whether the dev server should answer with the status page's HTML: a page of the status page
 * (the site's root and `/pages/…`, the paths it shows), asked for as a document. Other paths
 * are left to the Cloudflare plugin (the APIs and the admin UI go to the Worker).
 */
function isStatusPageRequest(request: IncomingMessage): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	if (!(request.headers.accept ?? "").includes("text/html")) return false;
	const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
	return pathname === "/" || pathname === "/index.html" || pathname.startsWith("/pages/");
}

export function statusPage(options: StatusPageOptions = {}): PluginOption[] {
	let root = process.cwd();
	let configFile = "";
	let logger: Logger;
	/** Read once per build; under the dev server, again after one of its files changed. */
	let templates: Promise<LoadedPageTemplates> | null = null;
	const loadTemplates = () => (templates ??= loadPageTemplates(configFile, logger));
	const statusPageHtml = async (html: string) => {
		const { entries } = await loadTemplates();
		return entries === null ? html : withPageTemplates(html, entries);
	};
	const plugin: Plugin = {
		name: "cf-workers-status-page",
		enforce: "pre",

		config(config, env) {
			root = path.resolve(config.root ?? process.cwd());
			const variables = loadEnv(env.mode, config.envDir || root, DEV_BYPASS_VARIABLE);
			// The admin login bypass is compiled in only under the dev server, and only on request.
			const devBypass = env.command === "serve" && variables[DEV_BYPASS_VARIABLE] === "1";
			return {
				// The prebuilt status page and admin UI's scripts and styles are the static assets.
				publicDir: CLIENT_DIR,
				define: { __ADMIN_DEV_BYPASS__: JSON.stringify(devBypass) },
			};
		},

		configResolved(config) {
			configFile = path.resolve(config.root, options.config ?? "status.config.ts");
			logger = config.logger;
		},

		configureServer(server) {
			server.watcher.on("all", (_event, file) => {
				if (templates === null) return;
				const current = templates;
				void current.then(({ files }) => {
					if (templates === current && files.includes(path.resolve(file))) templates = null;
				});
			});
			// The prebuilt HTML is a static file, which Vite serves as it is: give it the templates.
			server.middlewares.use((request, response, next) => {
				if (!isStatusPageRequest(request)) return next();
				readFile(STATUS_PAGE_HTML, "utf8")
					.then(statusPageHtml)
					.then((html) => {
						response.statusCode = 200;
						response.setHeader("Content-Type", "text/html; charset=utf-8");
						response.setHeader("Cache-Control", "no-store");
						response.end(request.method === "HEAD" ? undefined : html);
					}, next);
			});
		},

		// The client build copies the prebuilt HTML (publicDir): give the copy the templates.
		async writeBundle(output) {
			if (this.environment.name !== "client" || output.dir === undefined) return;
			const file = path.join(output.dir, "index.html");
			const html = await readFile(file, "utf8").catch(() => null);
			if (html === null) {
				logger.warn(`${file} was not found: status pages load in the default template.`);
				return;
			}
			await writeFile(file, await statusPageHtml(html));
		},

		configEnvironment(name) {
			// The Worker code imports this plugin's virtual modules: Vite must not pre-bundle it.
			if (name !== "client") return { optimizeDeps: { exclude: [PACKAGE_NAME] } };
			return undefined;
		},

		resolveId(id) {
			if (id === CONFIG_MODULE) return path.resolve(root, options.config ?? "status.config.ts");
			if (id === ADMIN_HTML_MODULE) return `\0${ADMIN_HTML_MODULE}`;
			return undefined;
		},

		load(id) {
			if (id !== `\0${ADMIN_HTML_MODULE}`) return undefined;
			return `export default ${JSON.stringify(readFileSync(ADMIN_HTML, "utf8"))};`;
		},
	};
	return [plugin, cloudflare({ ...options.cloudflare, config: workerConfig })];
}
