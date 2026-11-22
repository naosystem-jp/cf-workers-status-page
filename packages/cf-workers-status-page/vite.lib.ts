/**
 * Builds the package's JavaScript: the configuration API that status.config.ts imports, the
 * Worker, and the Vite plugin. One build, so that the configuration API and the Worker share
 * one copy of each module (chunks/). The private workspaces (packages/*, named
 * @naosystem/cf-workers-status-page-*) are bundled in and never become dependencies of the
 * published package: they are not on the registry.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { ADMIN_HTML_MODULE, CONFIG_MODULE } from "./src/modules.ts";

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(PACKAGE_DIR, "../..");
const WORKER_CONFIG = path.join(REPO_DIR, "worker/config.ts");

/** The Worker's imports that the user's build provides, as the package's virtual modules. */
function userModules(): Plugin {
	return {
		name: "cf-workers-status-page:user-modules",
		enforce: "pre",
		resolveId(source, importer) {
			if (source === ADMIN_HTML_MODULE) return { id: ADMIN_HTML_MODULE, external: true };
			if (source === "../status.config" && importer?.split("?")[0] === WORKER_CONFIG) {
				return { id: CONFIG_MODULE, external: true };
			}
			return null;
		},
	};
}

export default defineConfig({
	root: PACKAGE_DIR,
	publicDir: false,
	plugins: [userModules()],
	build: {
		outDir: "dist",
		// The client build (vite.client.ts) runs after this one and writes into dist/client.
		emptyOutDir: true,
		target: "es2023",
		minify: false,
		sourcemap: true,
		lib: {
			entry: {
				index: "src/index.ts",
				"provider-http": "src/provider-http.ts",
				"notifier-slack": "src/notifier-slack.ts",
				"notifier-discord": "src/notifier-discord.ts",
				"notifier-webhook": "src/notifier-webhook.ts",
				"auth-cloudflare-access": "src/auth-cloudflare-access.ts",
				worker: path.join(REPO_DIR, "worker/index.ts"),
				vite: "src/vite.ts",
			},
			formats: ["es"],
		},
		rolldownOptions: {
			external: [/^cloudflare:/, /^node:/, "zod", /^zod\//, "vite", "@cloudflare/vite-plugin", /^virtual:cf-workers-status-page\//],
			output: {
				entryFileNames: "[name].js",
				chunkFileNames: "chunks/[name]-[hash].js",
			},
		},
	},
});
