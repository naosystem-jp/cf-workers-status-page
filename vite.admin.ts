/**
 * Build-time parts of the admin UI and its authentication.
 *
 * 1. The local-development bypass of admin authentication is a compile-time constant,
 *    `__ADMIN_DEV_BYPASS__`, decided by Vite's command: it can be `true` only under the dev
 *    server (`vite`, `npm run dev`), never in a build, whatever the mode, `NODE_ENV` or
 *    environment variables say. See worker/admin/auth.ts.
 *
 * 2. The admin UI is its own HTML entry (`src/admin/index.html`), separate from the public
 *    SPA. In a build, its HTML goes into the Worker bundle instead of the static assets, so
 *    the only way to get it is through the Worker, after authentication: a static file could
 *    be reached without the Worker by spelling its path differently (the asset router matches
 *    `run_worker_first` against the raw path, but looks files up by the decoded path, so
 *    `/%61dmin/` is not `/admin/*`). Its scripts and styles are ordinary public files under
 *    `/assets/`. Under the dev server, the Worker fetches the HTML from Vite instead, which
 *    applies the dev transforms (HMR, React refresh).
 */
import { loadEnv, type Plugin } from "vite";

/** The admin UI's HTML entry, relative to the project root. */
export const ADMIN_HTML = "src/admin/index.html";

/** Module the Worker imports the admin HTML from: the HTML in a build, `null` under the dev server. */
const ADMIN_HTML_MODULE = "virtual:cf-workers-status-page/admin-html";
const RESOLVED_ADMIN_HTML_MODULE = `\0${ADMIN_HTML_MODULE}`;

/**
 * Where the client build leaves the admin HTML for the Worker build. Process-wide: Vite
 * resolves the configuration, and so creates this plugin, once per environment in a build.
 */
const BUILT_ADMIN_HTML = Symbol.for("cf-workers-status-page:admin-html");
const shared = globalThis as { [BUILT_ADMIN_HTML]?: string };

/** The variable that opts in to the bypass, from `.env.development.local` or the shell. */
export const DEV_BYPASS_VARIABLE = "ADMIN_DEV_BYPASS";

/**
 * Whether to compile the bypass in: only for the dev server, and only when the developer
 * opted in with `ADMIN_DEV_BYPASS=1`.
 */
export function adminDevBypassEnabled(command: "serve" | "build", env: Readonly<Record<string, string | undefined>>): boolean {
	return command === "serve" && env[DEV_BYPASS_VARIABLE] === "1";
}

export interface AdminUiOptions {
	/** `false` never compiles the bypass in, even under the dev server (for the tests). */
	readonly devBypass?: false;
}

export function adminUi(options: AdminUiOptions = {}): Plugin {
	let command: "serve" | "build" = "build";
	return {
		name: "cf-workers-status-page:admin-ui",

		config(config, env) {
			command = env.command;
			const variables = loadEnv(env.mode, config.envDir || config.root || process.cwd(), DEV_BYPASS_VARIABLE);
			const devBypass = options.devBypass !== false && adminDevBypassEnabled(env.command, variables);
			return {
				define: { __ADMIN_DEV_BYPASS__: JSON.stringify(devBypass) },
				environments: {
					client: { build: { rolldownOptions: { input: { index: "index.html", admin: ADMIN_HTML } } } },
				},
			};
		},

		// The Worker embeds the admin HTML, so the client is built first (the Cloudflare plugin
		// builds the Worker first by default, and skips environments that are already built).
		buildApp: {
			order: "pre",
			async handler(builder) {
				const client = builder.environments["client"];
				if (client === undefined || client.isBuilt) return;
				delete shared[BUILT_ADMIN_HTML];
				await builder.build(client);
			},
		},

		generateBundle: {
			// After Vite's HTML plugin has emitted the HTML.
			order: "post",
			handler(_options, bundle) {
				if (this.environment.name !== "client") return;
				const output = bundle[ADMIN_HTML];
				if (output?.type !== "asset") this.error(`The client build has no ${ADMIN_HTML}`);
				shared[BUILT_ADMIN_HTML] =
					typeof output.source === "string" ? output.source : new TextDecoder().decode(output.source);
				// Not a static asset: only the Worker serves it.
				delete bundle[ADMIN_HTML];
			},
		},

		resolveId(id) {
			return id === ADMIN_HTML_MODULE ? RESOLVED_ADMIN_HTML_MODULE : undefined;
		},

		load(id) {
			if (id !== RESOLVED_ADMIN_HTML_MODULE) return undefined;
			if (command === "serve") return "export default null;";
			const html = shared[BUILT_ADMIN_HTML];
			if (html === undefined) this.error("The admin UI's HTML is not built yet: build the client environment first");
			return `export default ${JSON.stringify(html)};`;
		},
	};
}
