// Builds d2 into dist/: ermine on its own (dist/ermine.js), the page
// (dist/d2.js) with ermine left out and found through the page's import map,
// and the share bundle (dist/share.js), which may fail without failing the
// build. ermine is apart so that capture() takes frames in d2.js as outside
// ermine: a site from the host then points into d2.js.

const here = new URL(".", import.meta.url).pathname;

async function bundle(entry: string, out: string, external: string[]): Promise<boolean> {
  const args = [
    "bundle",
    "--quiet",
    "--platform",
    "browser",
    "--keep-names",
    "--sourcemap=linked",
    ...external.flatMap((e) => ["--external", e]),
    "-o",
    `${here}dist/${out}`,
    `${here}src/${entry}`,
  ];
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: `${here}../..`,
    stderr: "piped",
  }).output();
  if (code !== 0) {
    console.error(`d2: ${out} did not build\n${new TextDecoder().decode(stderr)}`);
    return false;
  }
  return true;
}

/**
 * share.js loads Subduction's wasm from "../subduction.wasm", next to it as
 * the page sees it: served at /d2/subduction.wasm, from dist/.
 */
async function wasm(): Promise<boolean> {
  try {
    const { stdout } = await new Deno.Command(Deno.execPath(), { args: ["info", "--json"] })
      .output();
    const cache = JSON.parse(new TextDecoder().decode(stdout)).npmCache as string;
    const from = `${cache}/registry.npmjs.org/@automerge/subduction/0.23.0/dist/subduction.wasm`;
    await Deno.copyFile(from, `${here}dist/subduction.wasm`);
    return true;
  } catch {
    return false;
  }
}

/** Builds every output; true if the page's two bundles built. */
export async function build(): Promise<boolean> {
  await Deno.mkdir(`${here}dist`, { recursive: true });
  const ermine = await bundle("ermine.ts", "ermine.js", []);
  const page = await bundle("main.tsx", "d2.js", ["d2/ermine"]);
  const share = await bundle("share.ts", "share.js", ["d2/ermine"]);
  if (share && !(await wasm())) {
    console.warn("d2: subduction.wasm was not found; the share button will fail");
  }
  if (!share) {
    console.warn("d2: share.js did not build; the share button will hide");
    await Deno.remove(`${here}dist/share.js`).catch(() => {});
  }
  return ermine && page;
}

if (import.meta.main) {
  const ok = await build();
  for await (const f of Deno.readDir(`${here}dist`)) {
    const { size } = await Deno.stat(`${here}dist/${f.name}`);
    console.log(`dist/${f.name}`, size, "bytes");
  }
  if (!ok) Deno.exit(1);
}
