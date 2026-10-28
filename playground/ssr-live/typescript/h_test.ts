// the server's ermine-h and live's updates, without http. LLM generated: a prototype's checks
import { assert, assertEquals } from "@std/assert"
import { createErmine, ensureNode, executeAction } from "@ermine/system"
import { element, fire, html, type Update } from "./h.ts"
import { said } from "./live.ts"
import { demo } from "./demo.tsx"

// the id of the handler for action at, the first in the page
function handlerOf(page: string, at: string): string {
	const from = page.indexOf(`="${at}" data-ermine-handler:`)
	const id = page.slice(from).split('"')[3]
	assert(from >= 0 && id !== undefined, `no handler for ${at}`)
	return id
}

const typed = (text: string) => ({ target: { elements: { text: { value: text } } } })
const settled = () => new Promise((r) => setTimeout(r, 0))

function visitor() {
	const ermine = createErmine({
		host: {
			setup: () => {
				ensureNode("/shared")
				ensureNode("/shared/clicks", 0)
			},
		},
	})
	const into = element("main")
	const told: Update[] = []
	// deno-lint-ignore prefer-const
	let context: ReturnType<typeof ermine.getProcessContext>
	const started = ermine.start(
		demo({
			into,
			options: {
				name: "/visitors/a",
				call: (action, ...args) => context!.within(() => executeAction(action, ...args)),
				tell: (u) => context && told.push(u),
			},
		}),
		"/visitors/a",
	)
	if ("refused" in started) throw new Error(started.refused)
	context = ermine.getProcessContext(started.process)
	const click = async (at: string, event: unknown = {}) => {
		fire(into, handlerOf(html(into), at), event)
		await settled()
	}
	return { ermine, into, click, take: () => said(told.splice(0)) }
}

Deno.test("the first html has every binding's value and node", () => {
	const { ermine, into } = visitor()
	const page = html(into)
	assert(page.includes(`data-ermine-process="/visitors/a"`))
	assert(
		page.includes(`data-ermine-binding="view/0 view/1" class data-ermine-bind:text="count">0<`),
	)
	assert(page.includes(`data-ermine-binding="view/2">0</span>`))
	ermine.close()
})

Deno.test("a click: its bindings' new values, each once", async () => {
	const { ermine, click, take } = visitor()
	await click("on/inc")
	assertEquals(take(), [["view/1", "text", "1"], ["view/2", "text", "1"]])
	await click("on/dec")
	await click("on/dec")
	assertEquals(take(), [
		["view/0", "className", "below"],
		["view/1", "text", "-1"],
		["view/2", "text", "3"],
	])
	ermine.close()
})

Deno.test("a list's new kids are sent whole, and nothing inside them apart", async () => {
	const { ermine, click, take } = visitor()
	await click("on/add", typed("apple"))
	await click("on/add", typed("pear"))
	const sent = take()
	assertEquals(sent.map(([b, prop]) => [b, prop]), [["view/3", "children"]])
	const kids = sent[0][2] as string
	assert(kids.indexOf("apple") < kids.indexOf("pear") && kids.includes(`"view/3/1">pear<`))
	ermine.close()
})

Deno.test("a handler id from before a re-render calls nothing", async () => {
	const { ermine, into, click, take } = visitor()
	await click("on/add", typed("apple"))
	const old = handlerOf(html(into), "on/remove")
	await click("on/add", typed("pear"))
	take()
	assertEquals(fire(into, old, {}), false)
	ermine.close()
})
