// the tippet version's page script, built: tippet.ts, the party, ermine and tippet in one file, at
// ../client/tippet.js (the party server serves it at /tippet.js). LLM generated: a prototype
//   deno task tippet-build        (in playground/ssr-live; deno task party runs it first)
const here = (path: string) => new URL(path, import.meta.url).pathname
const out = here("../client/tippet.js")
const { code } = await new Deno.Command(Deno.execPath(), {
	args: ["bundle", "--quiet", "--platform", "browser", "--minify", "-o", out, here("./tippet.ts")],
	cwd: here("."),
	stdout: "inherit",
	stderr: "inherit",
}).spawn().status
if (code !== 0) Deno.exit(code)
console.log(`client/tippet.js: ${((await Deno.stat(out)).size / 1024).toFixed(1)} KB`)
