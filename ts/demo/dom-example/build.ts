// Builds the example into dist/main.js with deno bundle. Serve this directory
// and open index.html.

const here = new URL(".", import.meta.url).pathname;
const { code, stderr } = await new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--quiet",
    "--platform",
    "browser",
    "--sourcemap=linked",
    "-o",
    `${here}dist/main.js`,
    `${here}main.tsx`,
  ],
  cwd: `${here}../..`,
  stderr: "piped",
}).output();
if (code !== 0) {
  console.error(new TextDecoder().decode(stderr));
  Deno.exit(1);
}
console.log("dist/main.js", (await Deno.stat(`${here}dist/main.js`)).size, "bytes");
