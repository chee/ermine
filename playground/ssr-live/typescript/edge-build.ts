// the edge function, built: edge.ts, the party, ermine and Netlify Blobs in one file, with the
// page's script and look in it, at ../edge/netlify/edge-functions/live.js. LLM generated: a
// prototype
//   deno task edge-build          (in playground/ssr-live), then from ../edge: netlify deploy
const here = (path: string) => new URL(path, import.meta.url).pathname
const client = await Deno.readTextFile(here("../client/live-edge.js"))
const entry = await Deno.makeTempFile({ suffix: ".ts" })
// kept on Netlify Blobs: strong consistency, in frankfurt (as relay's store), opened per request
// (a store kept across requests has a stale token)
await Deno.writeTextFile(
	entry,
	`import { getStore } from "npm:@netlify/blobs@11.1.6"
import { createEdge, type Kept } from "${here("./edge.ts")}"
import { fonts, style } from "${here("./party-style.ts")}"
const blobs = (): Kept => {
	const s = getStore({ name: "ssr-live-party", consistency: "strong", region: "eu-central-1" })
	return {
		get: (key) => s.get(key, { type: "json", consistency: "strong" }),
		add: async (key, value) => (await s.setJSON(key, value, { onlyIfNew: true })).modified,
		put: async (key, value) => void await s.setJSON(key, value),
		list: async (prefix) => (await s.list({ prefix })).blobs.map((b) => b.key),
	}
}
const edge = createEdge({ kept: blobs, client: ${JSON.stringify(client)}, style, head: fonts })
export default (request: Request) => edge.fetch(request)
`,
)
const out = here("../edge/netlify/edge-functions/live.js")
try {
	const { code } = await new Deno.Command(Deno.execPath(), {
		args: ["bundle", "--quiet", "--platform", "deno", "--format", "esm", "-o", out, entry],
		cwd: here("."),
		stdout: "inherit",
		stderr: "inherit",
	}).spawn().status
	if (code !== 0) Deno.exit(code)
} finally {
	await Deno.remove(entry)
}
console.log(
	`edge/netlify/edge-functions/live.js: ${((await Deno.stat(out)).size / 1024).toFixed(1)} KB`,
)
