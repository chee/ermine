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
    "See an ermine graph: its directories by address, what each read gives and why, and its changes and records.",
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
        id: "devtools@ermine.inkandswitch.com",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] },
      },
    },
  },
  safari: base,
};

const solidPlugin: esbuild.Plugin = {
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
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

await Deno.remove(out, { recursive: true }).catch(() => {});
const bundle = `${out}/bundle`;
await esbuild.build({
  entryPoints: {
    panel: `${here}src/panel.tsx`,
    devtools: `${here}src/devtools.ts`,
  },
  outdir: bundle,
  bundle: true,
  format: "iife",
  target: ["chrome111", "firefox140", "safari16"],
  conditions: ["browser"],
  plugins: [solidPlugin],
  logLevel: "warning",
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
  for (const f of ["panel.js", "devtools.js"]) {
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
    "com.inkandswitch.ermine-devtools",
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
