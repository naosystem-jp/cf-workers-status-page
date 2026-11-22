/**
 * Builds the status page and the admin UI (src/ at the repository root) once, for the package:
 * the user's project serves these files and never builds React itself.
 *
 * - dist/client/: the static assets (the status page, scripts and styles, public/).
 * - dist/admin.html: the admin UI's HTML, which only the Worker serves, after authentication
 *   (see vite.admin.ts at the repository root): it must not be a static asset.
 */
import { mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(PACKAGE_DIR, "../..");
const OUT_DIR = path.join(PACKAGE_DIR, "dist/client");
const ADMIN_HTML = "src/admin/index.html";

/** Moves the admin UI's HTML out of the static assets. */
function adminHtmlOutOfAssets(): Plugin {
	return {
		name: "cf-workers-status-page:admin-html",
		closeBundle() {
			mkdirSync(path.join(PACKAGE_DIR, "dist"), { recursive: true });
			renameSync(path.join(OUT_DIR, ADMIN_HTML), path.join(PACKAGE_DIR, "dist/admin.html"));
			rmSync(path.join(OUT_DIR, "src"), { recursive: true, force: true });
		},
	};
}

export default defineConfig({
	root: REPO_DIR,
	plugins: [react(), adminHtmlOutOfAssets()],
	build: {
		outDir: OUT_DIR,
		emptyOutDir: true,
		rolldownOptions: {
			input: { index: path.join(REPO_DIR, "index.html"), admin: path.join(REPO_DIR, ADMIN_HTML) },
		},
	},
});
