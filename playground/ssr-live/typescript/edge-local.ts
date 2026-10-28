// the edge version, run here: kept in a Map, one Deno server, on PORT (8789). LLM generated: a
// prototype. what the edge does, and how long each request takes, without deploying
//   deno task edge       (in playground/ssr-live)
import { createEdge, memoryKept } from "./edge.ts"
import { fonts, style } from "./party-style.ts"

const client = await Deno.readTextFile(new URL("../client/live-edge.js", import.meta.url))
const kept = memoryKept()
const edge = createEdge({ kept: () => kept, client, style, head: fonts })

// the port, when PORT says none
const PORT = 8789

if (import.meta.main) {
	const port = Number(Deno.env.get("PORT") ?? PORT)
	Deno.serve({ port, onListen: () => {} }, async (request) => {
		const t0 = performance.now()
		const response = await edge.fetch(request)
		const url = new URL(request.url)
		console.log(
			`${request.method} ${url.pathname} ${response.status} ${
				(performance.now() - t0).toFixed(0)
			} ms`,
		)
		return response
	})
	console.log(`ermine party, as the edge runs it: http://localhost:${port}/`)
}
