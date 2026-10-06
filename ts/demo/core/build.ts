// Builds the demo into dist/: the page, its style, and one browser module.

const here = new URL(".", import.meta.url).pathname;
const dist = `${here}dist`;

export async function build(): Promise<boolean> {
  await Deno.mkdir(dist, { recursive: true });
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--quiet",
      "--platform",
      "browser",
      "--config",
      `${here}../../deno.json`,
      "-o",
      `${dist}/app.js`,
      `${here}src/main.tsx`,
    ],
    stderr: "piped",
  }).output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    return false;
  }
  await Deno.copyFile(`${here}index.html`, `${dist}/index.html`);
  await Deno.copyFile(`${here}style.css`, `${dist}/style.css`);
  return true;
}

if (import.meta.main) {
  if (!await build()) Deno.exit(1);
  console.log(`built ${dist}`);
}
