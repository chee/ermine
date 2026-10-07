// Builds the demo into dist/: the page, its style, one browser module, and
// the host's modules a program imports, "demo" and "ermine" (host/). Links
// are built apart, as link/subduction.js and the wasm it loads,
// subduction.wasm, so the page runs without them until a share or a mount
// needs them (World's Linker).

const here = new URL(".", import.meta.url).pathname;
const dist = `${here}dist`;

/** Bundles one entry for the browser. */
async function bundle(entry: string, out: string): Promise<boolean> {
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--quiet",
      "--platform",
      "browser",
      "--config",
      `${here}../../deno.json`,
      "-o",
      out,
      entry,
    ],
    stderr: "piped",
  }).output();
  if (code !== 0) console.error(new TextDecoder().decode(stderr));
  return code === 0;
}

/** The Subduction wasm, from Deno's npm cache: the bundle loads it from ../subduction.wasm. */
async function wasm(): Promise<string | undefined> {
  const { stdout } = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output();
  const cache = JSON.parse(new TextDecoder().decode(stdout)).npmCache as string | undefined;
  const path = `${cache}/registry.npmjs.org/@automerge/subduction/0.23.0/dist/subduction.wasm`;
  try {
    await Deno.stat(path);
    return path;
  } catch {
    return undefined;
  }
}

export async function build(): Promise<boolean> {
  await Deno.mkdir(`${dist}/link`, { recursive: true });
  if (!await bundle(`${here}src/main.tsx`, `${dist}/app.js`)) return false;
  if (!await bundle(`${here}../../src/link/subduction.ts`, `${dist}/link/subduction.js`)) {
    return false;
  }
  const w = await wasm();
  if (w) await Deno.copyFile(w, `${dist}/subduction.wasm`);
  else console.warn("no subduction.wasm in Deno's npm cache: shares and mounts will not connect");
  await Deno.copyFile(`${here}index.html`, `${dist}/index.html`);
  await Deno.copyFile(`${here}style.css`, `${dist}/style.css`);
  await Deno.mkdir(`${dist}/host`, { recursive: true });
  for (const f of ["demo.js", "ermine.js"]) {
    await Deno.copyFile(`${here}host/${f}`, `${dist}/host/${f}`);
  }
  return true;
}

if (import.meta.main) {
  if (!await build()) Deno.exit(1);
  console.log(`built ${dist}`);
}
