// Checks the package as a user gets it: packs it, installs the tarball into a copy of
// templates/starter (a user's repository), builds that project, checks the Worker and its
// Wrangler configuration, and asks Wrangler to deploy it (dry run: no account needed).
// Run `npm run build` first. Needs the npm registry for the template's other dependencies.
//
// Plain JavaScript: runs on every Node.js version in `engines` without type stripping.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = path.dirname(PACKAGE_DIR);
const TEMPLATE_DIR = path.resolve(PACKAGE_DIR, "../../templates/starter");
/** The Vite plugin's output directory of the template's Worker (its `name`, `-` as `_`). */
const WORKER_OUT_DIR = "dist/status_page";

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

/** The names of the private workspaces (packages/*), which are never published. */
function privatePackages() {
	return readdirSync(PACKAGES_DIR)
		.map((dir) => path.join(PACKAGES_DIR, dir, "package.json"))
		.filter((file) => existsSync(file))
		.map((file) => JSON.parse(readFileSync(file, "utf8")))
		.filter((manifest) => manifest.private === true)
		.map((manifest) => manifest.name);
}

function checkManifest(files) {
	const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
	const unpublished = privatePackages();
	assert(unpublished.length > 0, "no private workspaces found in packages/");
	// The private workspaces are bundled in. They are not on the registry, so a dependency on one
	// would make installing the package fail for every user.
	for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
		for (const name of Object.keys(manifest[field] ?? {})) {
			assert(!unpublished.includes(name), `${field} of the published package names ${name}`);
		}
	}
	for (const { path: file } of files) {
		assert(
			file === "package.json" || file.startsWith("dist/") || /^(README|LICENSE)/i.test(file),
			`unexpected file in the package: ${file}`,
		);
		if (file.endsWith(".js")) {
			const code = readFileSync(path.join(PACKAGE_DIR, file), "utf8");
			for (const name of unpublished) {
				assert(!code.includes(`"${name}"`) && !code.includes(`'${name}'`), `${file} imports ${name}`);
			}
		}
	}
	assert(files.some(({ path: file }) => file === "dist/admin.html"), "the package has no dist/admin.html");
	assert(files.some(({ path: file }) => file === "dist/client/index.html"), "the package has no dist/client/index.html");
	// The licenses of the third-party code in the status page's and the admin UI's bundles (React).
	const notices = readFileSync(path.join(PACKAGE_DIR, "dist/client/licenses/third-party.txt"), "utf8");
	assert(/^- react-dom \d/m.test(notices), "dist/client/licenses/third-party.txt lists React");
}

function checkBuild(project) {
	const config = JSON.parse(readFileSync(path.join(project, WORKER_OUT_DIR, "wrangler.json"), "utf8"));
	assert.deepEqual(
		config.durable_objects.bindings.map((binding) => binding.class_name).sort(),
		["Monitor", "Reconciler", "StatusPage"],
		"Durable Objects added by the plugin",
	);
	assert.deepEqual(
		config.queues.consumers.map((consumer) => consumer.queue),
		["status-page-notifications", "status-page-notifications-dlq"],
		"queue consumers derived from wrangler.jsonc's producers",
	);
	assert.equal(config.assets.not_found_handling, "single-page-application");
	assert.deepEqual(config.triggers.crons, ["* * * * *"]);

	const worker = readFileSync(path.join(project, WORKER_OUT_DIR, "index.js"), "utf8");
	assert(worker.includes("var DEV_BYPASS_ENABLED = false;"), "the admin login bypass is compiled out");
	assert(!/\bfrom\s*["']virtual:/.test(worker), "a virtual module was left unresolved");
	assert(worker.includes('"https://example.com/"'), "the template's status.config.ts is in the Worker");
	assert(worker.includes("<title>Status admin</title>"), "the admin UI's HTML is in the Worker");
	const html = readFileSync(path.join(project, "dist/client/index.html"), "utf8");
	// The template's one page names no template: the default one, written into the status page's HTML.
	assert(
		html.includes('<meta name="cf-workers-status-page:templates" content="default:default">'),
		"the status page's HTML lists the pages' templates",
	);
}

const work = mkdtempSync(path.join(tmpdir(), "cf-workers-status-page-"));
try {
	const [{ filename, files }] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], PACKAGE_DIR));
	checkManifest(files);

	const project = path.join(work, "starter");
	cpSync(TEMPLATE_DIR, project, { recursive: true });
	run("npm", ["install", "--no-audit", "--no-fund", path.join(work, filename)], project);
	run("npx", ["vite", "build"], project);
	checkBuild(project);
	run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", path.join(work, "deploy")], project);
	console.log("The package installs, builds and deploys (dry run) in a project made from templates/starter.");
} finally {
	rmSync(work, { recursive: true, force: true });
}
