// live's GET and POST version, through its fetch, no network. LLM generated: a prototype's checks
import { assertEquals } from "@std/assert"
import { createErmine, ensureNode } from "@ermine/system"
import { createLive } from "./live.ts"
import { demo } from "./demo.tsx"

const URL = "http://here"

async function visitor(live: ReturnType<typeof createLive>) {
	const page = await (await live.fetch(new Request(`${URL}/?poll`))).text()
	const p = page.split('data-ermine-process="')[1].split('"')[0]
	// the handler for the action at (under the visitor's process)
	const handler = (at: string) =>
		page.slice(page.indexOf(`="${p}/${at}" data-ermine-handler:`)).split('"')[3]
	const post = (h: string) =>
		live.fetch(
			new Request(`${URL}/event`, {
				method: "POST",
				body: JSON.stringify({ p, h, t: "click" }),
			}),
		)
	const missed = () => live.fetch(new Request(`${URL}/missed?p=${encodeURIComponent(p)}`))
	return { page, handler, post, missed }
}

Deno.test("a post's answer is what the page missed, its own change with it", async () => {
	const ermine = createErmine({
		host: {
			setup: () => {
				ensureNode("/shared")
				ensureNode("/shared/clicks", 0)
			},
		},
	})
	const live = createLive(ermine, demo, { client: "", pollClient: "" })
	const a = await visitor(live)
	const b = await visitor(live)
	assertEquals(a.page.includes(`src="/live-poll.js"`), true)

	const answer = await a.post(a.handler("on/inc"))
	assertEquals(await answer.json(), {
		n: 1,
		updates: [["view/1", "text", "1"], ["view/2", "text", "1"]],
	})
	// b missed the shared count: its GET has it at once
	assertEquals(await (await b.missed()).json(), { n: 1, updates: [["view/2", "text", "1"]] })

	// a GET held, then another visitor's click: it is answered with that
	const held = b.missed()
	await a.post(a.handler("on/inc"))
	// b's second answer
	const second = 2
	assertEquals(await (await held).json(), { n: second, updates: [["view/2", "text", "2"]] })
	live.close()
	ermine.close()
})
