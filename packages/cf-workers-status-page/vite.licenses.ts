/**
 * Writes the licenses of the third-party code a build puts in its bundles, next to them: MIT and
 * the other licenses of these packages ask for their notice with every copy, and the status page
 * serves its bundles to every visitor.
 *
 * What counts is what the bundler took, read from each chunk's modules: the packages from
 * node_modules (their code, or their styles), and the helpers Vite and Rolldown add as virtual
 * modules. A dependency that joins a bundle is listed without anyone having to remember it, and
 * one that leaves is no longer listed.
 *
 * Used by the repository's build (vite.config.ts) and by the package's (vite.client.ts,
 * vite.lib.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/** LICENSE, LICENSE.md, LICENCE.txt, COPYING, NOTICE and the like, at a package's root. */
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-][\w.-]*)?$/i;
/** Vite's LICENSE.md goes on with the licenses of Vite's own dependencies: none is in our bundles. */
const BUNDLED_DEPENDENCIES = /^# Licenses of bundled dependencies\s*$/m;
/** Virtual modules that bring a package's code: `\0vite/preload-helper.js`, `\0rolldown/runtime.js`. */
const HELPER_PACKAGES = ["vite", "rolldown"] as const;

export interface ThirdPartyLicensesOptions {
	/** Where to write the list, relative to the build's output directory. */
	readonly fileName: string;
	/** Whose bundles these are, for the heading: "the status page and the admin UI". */
	readonly subject: string;
	/** A note after the introduction. */
	readonly note?: string;
	/** Only these environments of the build: the client, not a Worker that is never handed out. */
	readonly environments?: readonly string[];
}

interface PackageNotice {
	readonly name: string;
	readonly version: string;
	readonly license: string;
	readonly homepage: string | undefined;
	readonly texts: readonly string[];
}

/** The directory of the package a module belongs to, when it comes from node_modules. */
export function packageDirOf(id: string): string | undefined {
	const file = id.split("?")[0]!.replaceAll("\\", "/");
	const at = file.lastIndexOf("/node_modules/");
	if (at === -1) return undefined;
	const parts = file.slice(at + "/node_modules/".length).split("/");
	const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
	return `${file.slice(0, at)}/node_modules/${name}`;
}

function readNotice(dir: string): PackageNotice {
	const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
		name: string;
		version: string;
		license?: string | { type?: string };
		homepage?: string;
	};
	const files = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	if (files.length === 0) {
		throw new Error(`${manifest.name} ${manifest.version} is in a bundle but has no license file (${dir})`);
	}
	return {
		name: manifest.name,
		version: manifest.version,
		license: typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "see below"),
		homepage: manifest.homepage,
		texts: files.map((file) => readFileSync(path.join(dir, file), "utf8").split(BUNDLED_DEPENDENCIES)[0]!.trim()),
	};
}

function render(options: ThirdPartyLicensesOptions, notices: readonly PackageNotice[]): string {
	const heading = `Third-party software in ${options.subject}`;
	const rule = "-".repeat(100);
	const lines = [
		heading,
		"=".repeat(heading.length),
		"",
		"These bundles include code from the packages below, put in by the build.",
		"cf-workers-status-page itself is under the MIT license; each of these packages is under its",
		"own license, copied with it.",
		...(options.note === undefined ? [] : ["", options.note]),
		"",
		...notices.map((notice) => `- ${notice.name} ${notice.version} (${notice.license})`),
	];
	for (const notice of notices) {
		lines.push("", rule, `${notice.name} ${notice.version} (${notice.license})`);
		if (notice.homepage !== undefined) lines.push(notice.homepage);
		for (const text of notice.texts) lines.push("", text);
	}
	return `${lines.join("\n")}\n`;
}

/** The status page's and the admin UI's, served at /licenses/third-party.txt next to fonts.txt. */
export const CLIENT_LICENSES: ThirdPartyLicensesOptions = {
	fileName: "licenses/third-party.txt",
	subject: "the status page and the admin UI (their scripts and styles)",
	note: "The fonts of the modern template are also described in fonts.txt, next to this file.",
	environments: ["client"],
};

export function thirdPartyLicenses(options: ThirdPartyLicensesOptions): Plugin {
	let root = process.cwd();
	return {
		name: "cf-workers-status-page:third-party-licenses",
		apply: "build",
		applyToEnvironment: (environment) =>
			options.environments === undefined || options.environments.includes(environment.name),
		configResolved(config) {
			root = config.root;
		},
		generateBundle(_outputOptions, bundle) {
			const require = createRequire(path.join(root, "package.json"));
			const vite = path.dirname(require.resolve("vite/package.json"));
			const helpers: Record<(typeof HELPER_PACKAGES)[number], string> = {
				vite,
				rolldown: path.dirname(createRequire(path.join(vite, "package.json")).resolve("rolldown/package.json")),
			};
			const dirs = new Set<string>();
			for (const item of Object.values(bundle)) {
				if (item.type !== "chunk") continue;
				for (const id of item.moduleIds) {
					if (id.startsWith("\0")) {
						const helper = HELPER_PACKAGES.find((name) => id.startsWith(`\0${name}/`));
						if (helper !== undefined) dirs.add(helpers[helper]);
						else if (!id.startsWith("\0virtual:")) {
							throw new Error(`Unknown virtual module in a bundle: ${JSON.stringify(id)}; which package's code is it?`);
						}
						continue;
					}
					const dir = packageDirOf(id);
					if (dir !== undefined) dirs.add(dir);
				}
			}
			if (dirs.size === 0) return;
			const notices = new Map<string, PackageNotice>();
			for (const dir of dirs) {
				const notice = readNotice(dir);
				notices.set(`${notice.name}@${notice.version}`, notice);
			}
			const sorted = [...notices.values()].sort((a, b) =>
				a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
			);
			this.emitFile({ type: "asset", fileName: options.fileName, source: render(options, sorted) });
		},
	};
}
