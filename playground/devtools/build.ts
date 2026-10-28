// Builds the ermine devtools extension into dist/chrome, dist/firefox and
// dist/safari: one manifest each, the same pages. The panel is Solid 2.0, its
// JSX compiled by babel-preset-solid and bundled by esbuild.
//
//   deno task build     builds
//   deno task install   builds, then installs what can be installed from here

import * as esbuild from "esbuild";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import typescript from "@babel/preset-typescript";

const here = new URL(".", import.meta.url).pathname;
const out = `${here}dist`;
const version = "0.1.0";

const base = {
	manifest_version: 3,
	name: "ermine devtools",
	short_name: "ermine",
	version,
	description:
		"See an ermine graph a page shows you: its tree, what each process reads and who reads it, the changes and who made them, and what the scheduler did.",
	devtools_page: "devtools.html",
	icons: {
		16: "icon-16.png",
		32: "icon-32.png",
		48: "icon-48.png",
		128: "icon-128.png",
	},
};

const manifests: { [browser: string]: object } = {
	chrome: { ...base, minimum_chrome_version: "111" },
	firefox: {
		...base,
		browser_specific_settings: {
			gecko: {
				id: "ermine@chee.party",
				strict_min_version: "140.0",
				data_collection_permissions: { required: ["none"] },
			},
		},
	},
	// Safari lets devtools.inspectedWindow.eval run only on a page the extension asked for in
	// host_permissions and the person allowed (Safari asks, or Settings › Websites). Chrome and
	// Firefox eval without it, so only Safari asks.
	safari: { ...base, host_permissions: ["<all_urls>"] },
};

const solidPlugin: esbuild.Plugin = {
	name: "solid",
	setup(build) {
		build.onLoad({ filter: /\.tsx$/ }, async (args) => {
			// the finder is @ermine's jsx (@ermine/jsx-runtime), not Solid's: esbuild's own, by its
			// @jsxImportSource
			if (args.path.startsWith(`${here}src/finder/`)) return undefined;
			const source = await Deno.readTextFile(args.path);
			const result = await transformAsync(source, {
				filename: args.path,
				presets: [[solid, { generate: "dom" }], [typescript, {
					onlyRemoveTypeImports: false,
				}]],
			});
			return { contents: result!.code!, loader: "js" };
		});
	},
};

// the finder (src/finder, copied from ermine-mac) is on @ermine/system, from the ermine checkout
// as ermine-mac's build-next.ts takes it (ERMINE=<repo> to say another), and drawn with
// @ermine/render from there too. its page side leaves places.ts out (its install writes to storage)
const repo = Deno.env.get("ERMINE") ??
	Deno.env.get("HOME") + "/soft/chee/ermine/";
const ermineImports: Record<string, string> = {};
{
	const root = JSON.parse(await Deno.readTextFile(repo + "deno.json")) as { workspace: string[] };
	for (const member of root.workspace) {
		let config;
		try {
			config = JSON.parse(await Deno.readTextFile(`${repo}${member}/deno.json`));
		} catch {
			continue;
		}
		const { name, exports } = config as { name?: string; exports?: Record<string, string> };
		if (!name || !exports) continue;
		for (const [key, source] of Object.entries(exports)) {
			const file = new URL(source, `file://${repo}${member.replace(/^\.\//, "")}/`).pathname;
			ermineImports[key === "." ? name : `${name}/${key.slice(2)}`] = file;
		}
	}
}
const erminePlugin = (pageSide: boolean): esbuild.Plugin => ({
	name: "ermine",
	setup(build) {
		build.onResolve({ filter: /^@ermine\// }, (args) => {
			const file = ermineImports[args.path];
			return file ? { path: file } : undefined;
		});
		if (pageSide) {
			// the finder's own places.ts (core's places.ts is @ermine/system's, kept)
			build.onResolve(
				{ filter: /\/places\.ts$/ },
				(args) =>
					args.importer.startsWith(`${here}src/finder/`)
						? { path: "places", namespace: "none" }
						: undefined,
			);
			build.onLoad({ filter: /.*/, namespace: "none" }, () => ({
				contents: "export const SHOWING = []; export const shows = () => false;",
				loader: "js",
			}));
		}
		// createErmine asks import.meta.resolve where two of its modules are (sites skips their frames):
		// in one bundle every frame is this file (build-next.ts does the same)
		build.onLoad({ filter: /\.ts$/ }, async (args) => {
			if (!args.path.startsWith(repo)) return undefined;
			const source = await Deno.readTextFile(args.path);
			if (!source.includes("import.meta.resolve(")) return undefined;
			return {
				contents: source.replace(
					/import\.meta\.resolve\("@ermine\/(core\/scheduler|processes\/start)"\)/g,
					"__ermineFinderURL",
				),
				loader: "ts",
			};
		});
	},
});

await Deno.remove(out, { recursive: true }).catch(() => {});
const bundle = `${out}/bundle`;
const common = {
	outdir: bundle,
	bundle: true,
	format: "iife" as const,
	target: ["chrome111", "firefox140", "safari16"],
	conditions: ["browser"],
	logLevel: "warning" as const,
} satisfies esbuild.BuildOptions;
await esbuild.build({
	...common,
	entryPoints: {
		panel: `${here}src/panel.tsx`,
		devtools: `${here}src/devtools.ts`,
	},
	plugins: [solidPlugin],
});
await esbuild.build({
	...common,
	entryPoints: { finder: `${here}src/finder/host.ts` },
	// the bundle's own address, for import.meta.url: what the scheduler and processes call their file
	banner: { js: "var __ermineFinderURL = document.currentScript?.src ?? location.href;" },
	define: { "import.meta.url": "__ermineFinderURL" },
	jsx: "automatic",
	jsxImportSource: "@ermine",
	keepNames: true,
	plugins: [solidPlugin, erminePlugin(false)],
});
await esbuild.build({
	...common,
	entryPoints: { pagegraph: `${here}src/finder/pagegraph.ts` },
	define: { "import.meta.url": '""' },
	plugins: [erminePlugin(true)],
});
await esbuild.stop();

for (const [browser, manifest] of Object.entries(manifests)) {
	const dir = `${out}/${browser}`;
	await Deno.mkdir(dir, { recursive: true });
	await Deno.writeTextFile(
		`${dir}/manifest.json`,
		JSON.stringify(manifest, null, 2) + "\n",
	);
	for await (const f of Deno.readDir(`${here}static`)) {
		await Deno.copyFile(`${here}static/${f.name}`, `${dir}/${f.name}`);
	}
	for (const f of ["panel.js", "devtools.js", "finder.js", "pagegraph.js"]) {
		await Deno.copyFile(`${bundle}/${f}`, `${dir}/${f}`);
	}
	await Deno.copyFile(`${here}src/page.js`, `${dir}/page.js`);
	console.log(`${dir}`);
}
await Deno.remove(bundle, { recursive: true });

// a zip for Firefox's about:debugging and for signing
const xpi = `${out}/ermine-devtools-${version}.xpi`;
await run("zip", ["-qr", xpi, "."], `${out}/firefox`);
console.log(xpi);

if (Deno.args[0] === "install") await install();

async function run(cmd: string, args: string[], cwd = here): Promise<boolean> {
	try {
		const { code } = await new Deno.Command(cmd, { args, cwd }).spawn().status;
		return code === 0;
	} catch {
		return false;
	}
}

async function install() {
	// Safari: a web extension ships inside an app, which only Xcode builds
	const safari = `${out}/safari-app`;
	const converted = await run("xcrun", [
		"safari-web-extension-converter",
		`${out}/safari`,
		"--project-location",
		safari,
		"--app-name",
		"ermine devtools",
		"--bundle-identifier",
		"party.chee.ermine.devtools",
		"--macos-only",
		"--no-open",
		"--no-prompt",
		"--force",
		"--copy-resources",
	]);
	if (converted) {
		const built = await run("xcodebuild", [
			"-project",
			`${safari}/ermine devtools/ermine devtools.xcodeproj`,
			"-scheme",
			"ermine devtools",
			"-configuration",
			"Debug",
			"-derivedDataPath",
			`${safari}/build`,
			"CODE_SIGN_IDENTITY=-",
			"build",
		]);
		if (built) {
			await run("open", [
				`${safari}/build/Build/Products/Debug/ermine devtools.app`,
			]);
			console.log(
				"safari: opened the app; enable it in Safari › Settings › Extensions (Develop › Allow Unsigned Extensions first)",
			);
		}
	} else {
		console.log(
			"safari: needs Xcode (xcode-select -s /Applications/Xcode.app) to build the app",
		);
	}
}
