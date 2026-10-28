/// <reference lib="dom" />
// the tippet version's page script: the html the server rendered, taken over by an ermine of the
// page's own. LLM generated: a prototype. the page ties its ermine to the server's room (tie.ts:
// the server's /shared by its id, over a websocket), waits till it holds every step its html was
// rendered from, then starts the visitor's process itself (the party, as the server ran it),
// hydrating the html (@ermine/render/dom) instead of making it again. from then on a click is an
// action called here, its writes are steps sent to the room, and the steps of every other page (and
// of the server's clocks) land here as they come. the beat is the page's own clock; life is sent,
// never kept (the tie's ephemeral paths), and the page waits for it as it is now too
//   <script type="module" src="/tippet.js" data-room data-root data-have data-process>
//   console: how long each part took, and how many nodes hydrating made (none: all were taken over)
import { createErmine, executeAction, pulse } from "@ermine/system"
import { createRenderer } from "@ermine/render"
import { dom } from "@ermine/render/dom"
import { socket } from "@ermine/tippet/carriers/websocket"
import { createTie, OTHER_ROOM } from "./tie.ts"
import { beatClock, EPHEMERAL, LOCAL, party } from "./party.tsx"

// a link lost (not refused) is made again after this long
const AGAIN_MS = 1000
const began = performance.now()
const times: Record<string, number> = {}
const mark = (name: string) => times[name] = Math.round(performance.now() - began)

const me = document.querySelector<HTMLScriptElement>("script[data-root]")!
const { room = "/tippet", root, process: path = "" } = me.dataset
const have = JSON.parse(me.dataset.have ?? "{}") as Record<string, number>
const into = document.querySelector("main")!

const ermine = createErmine()
const tie = await createTie(ermine, { at: "/shared", id: root, local: LOCAL, ephemeral: EPHEMERAL })

// the room, linked again when the link is lost; another room's (the server started again): a new page
function link() {
	const url = new URL(room, location.href)
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
	url.search = new URLSearchParams({ r: root!, p: path.split("/").pop()! }).toString()
	const ws = new WebSocket(url)
	ws.addEventListener("open", () => times.linked ?? mark("linked"))
	ws.addEventListener("close", (e) => {
		if (e.code === OTHER_ROOM) location.reload()
		else setTimeout(link, AGAIN_MS)
	})
	tie.link(socket(ws))
}
link()

// every step the html was rendered from, held (and landed), and the ephemeral writes as they are
await Promise.all([
	new Promise<void>((done) => {
		const holds = () => Object.entries(have).every(([d, n]) => tie.log.count(d) >= n)
		if (holds()) return done()
		const off = tie.log.on(() => holds() && (off(), done()))
	}),
	tie.started,
])
mark("caught up")

// the visitor, as the server ran it: its html hydrated, the nodes made doing it listed
const made: string[] = []
const { hydrate } = createRenderer({
	...dom,
	element: (tag) => (made.push(`<${tag}>`), dom.element(tag)),
	text: (s) => (made.push(JSON.stringify(s)), dom.text(s)),
})
// a form's submit is the page's: it goes nowhere
into.addEventListener("submit", (e) => e.preventDefault())
ermine.start(beatClock, "/clocks/beat")
// deno-lint-ignore prefer-const
let context: ReturnType<typeof ermine.getProcessContext>
const started = ermine.start(
	party({
		into,
		options: {
			name: path,
			call: (action, ...args) => context!.within(() => executeAction(action, ...args)),
		},
		render: hydrate,
	}),
	path,
)
if ("refused" in started) throw new Error(`refused: ${started.refused}`)
context = ermine.getProcessContext(started.process)
ermine.within(() => pulse())
mark("hydrated")
console.info(
	"tippet:",
	times,
	`made ${made.length} nodes hydrating`,
	made,
	"steps held:",
	tie.log.have(),
)
