// the demo's server: one ermine, a process per visitor, on PORT (8787). LLM generated: a prototype
//   deno task ssr-live        (from the repo's root)
import { createErmine, ensureNode } from "@ermine/system"
import { createLive } from "./live.ts"
import { demo } from "./demo.tsx"

export const style = `
body { font: 16px/1.4 system-ui, sans-serif; margin: 0; background: #fff; color: #000 }
.page { display: flex; flex-wrap: wrap; gap: 4px; padding: 16px }
section { border: 2px solid #ffb3d9; border-radius: 8px; padding: 8px 12px; min-width: 260px }
h2 { margin: 0 0 8px; font-size: 14px; text-transform: lowercase; color: #b0006d }
button { font: inherit; min-width: 40px; min-height: 40px; border: 0; border-radius: 6px;
	background: #c8f7ff; cursor: pointer }
output { display: inline-block; min-width: 48px; text-align: center; font-size: 24px }
output.below { color: #b0006d }
input { font: inherit; min-height: 36px; padding: 0 8px }
ul { padding-left: 20px }
li { margin: 4px 0 }
li button { min-width: 32px; min-height: 32px; background: #ffe0f0 }
`

export const client = await Deno.readTextFile(new URL("../client/live.js", import.meta.url))
// the GET and POST version's (GET /?poll)
export const pollClient = await Deno.readTextFile(
	new URL("../client/live-poll.js", import.meta.url),
)

export function serve(port: number) {
	const ermine = createErmine({
		host: {
			setup: () => {
				ensureNode("/shared")
				ensureNode("/shared/clicks", 0)
			},
		},
	})
	const live = createLive(ermine, demo, { client, pollClient, style })
	const server = Deno.serve({ port, onListen: () => {} }, live.fetch)
	return { ermine, live, server }
}

// the port, when PORT says none
const PORT = 8787

if (import.meta.main) {
	const port = Number(Deno.env.get("PORT") ?? PORT)
	serve(port)
	console.log(`ermine live: http://localhost:${port}/ (GET and POST only: /?poll)`)
}
