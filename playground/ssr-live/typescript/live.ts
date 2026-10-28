// ermine live: a page kept as the server's view of it. LLM generated: a prototype. each visitor
// is a process of its own (folder/<uuid>), its view rendered on the server (./h.ts); the first
// load is the html, then a stream of what its bindings show, and the page's events come back as
// posts, each called as the visitor's process
//   GET  /           a new visitor: its process started, its page
//   GET  /live?p=…   its updates, as server-sent events: data: [[binding, prop, value], …]
//   POST /event      { p, h, t, value?, checked?, key?, form?, tv?, at? }: the handler h, called
//   GET  /live.js    the page's script (client/live.js), and /<name> for each of options.scripts
// a visitor whose stream is gone for linger ms is stopped; a page it had is told 410 and reloads.
// options.away, back and gone are told as a visitor's stream drops, comes back, and it is stopped
import { type Ermine, executeAction } from "@ermine/system"
import { type Element, element, fire, html, inner, type Options, render, type Update } from "./h.ts"

export { render }
// what a program is given: where to render, and the options to render with
export type Page = { readonly into: Element; readonly options: Options }
export type Program = (page: Page) => () => unknown

type Visitor = {
	readonly path: string
	readonly into: Element
	readonly stop: () => void
	// told and not yet sent; a flush asked for
	told: Update[]
	asked: boolean
	// the stream open now (none: what is told waits for the next)
	stream?: ReadableStreamDefaultController<Uint8Array>
	leaving?: ReturnType<typeof setTimeout>
}

// what a page posts: its process, the handler, the event's type, and what the element says
type Said = {
	readonly p: string
	readonly h: string
	readonly t: string
	readonly value?: string
	readonly checked?: boolean
	readonly key?: string
	readonly form?: Record<string, string>
	// the element clicked inside the handler's (e.target), when it is another: its value
	readonly tv?: string
	// a click: where, inside the handler's element, and that element's size: [x, y, width, height]
	readonly at?: readonly number[]
}

export type LiveOptions = {
	// the page's script
	readonly client: string
	readonly folder?: string
	readonly title?: string
	readonly style?: string
	// more of the page's head (a fonts link)
	readonly head?: string
	readonly linger?: number
	// more of the page's scripts, by name (served at /<name>, loaded after live.js)
	readonly scripts?: Readonly<Record<string, string>>
	// a visitor's stream dropped, came back; the visitor stopped. each told its process's path
	readonly away?: (path: string) => void
	readonly back?: (path: string) => void
	readonly gone?: (path: string) => void
}

export type Live = {
	readonly fetch: (request: Request) => Response | Promise<Response>
	readonly visitors: () => number
	readonly close: () => void
}

const encoder = new TextEncoder()
// a visitor with no stream open this long is stopped
const LINGER = 30_000
// what a request is told
const DONE = 204
const MISSING = 404
const GONE = 410
const BROKE = 500

export function createLive(ermine: Ermine, program: Program, options: LiveOptions): Live {
	const { client, folder = "/visitors", title = "ermine live", style = "", linger = LINGER } =
		options
	const scripts = options.scripts ?? {}
	const visitors = new Map<string, Visitor>()

	function visit(): Visitor | Response {
		const path = `${folder}/${crypto.randomUUID()}`
		const into = element("main")
		// nothing is told till the page is out: the first render is in its html
		// deno-lint-ignore prefer-const
		let v: Visitor | undefined
		// the process's context, to call its actions as it (an event has nothing open)
		// deno-lint-ignore prefer-const
		let context: ReturnType<Ermine["getProcessContext"]>
		const page: Options = {
			name: path,
			call: (action, ...args) => context!.within(() => executeAction(action, ...args)),
			tell: (update) => v && tell(v, update),
		}
		const started = ermine.start(program({ into, options: page }), path)
		if ("refused" in started) {
			return new Response(`refused: ${started.refused}`, { status: BROKE })
		}
		const status = started.status()
		if (status?.state === "failed") {
			started.stop()
			return new Response(String(status.error), { status: BROKE })
		}
		context = ermine.getProcessContext(started.process)
		v = { path, into, stop: () => started.stop(), told: [], asked: false }
		visitors.set(path, v)
		away(v)
		return v
	}

	// the visitor goes once no stream is open for linger
	function away(v: Visitor) {
		clearTimeout(v.leaving)
		v.leaving = setTimeout(() => {
			visitors.delete(v.path)
			v.stop()
			options.gone?.(v.path)
		}, linger)
	}

	function tell(v: Visitor, update: Update) {
		v.told.push(update)
		if (v.asked) return
		v.asked = true
		// after the pulse: every act told, so a binding's new kids are written out whole
		queueMicrotask(() => flush(v))
	}

	function flush(v: Visitor) {
		v.asked = false
		if (v.stream === undefined || v.told.length === 0) return
		const sent = said(v.told)
		v.told = []
		v.stream.enqueue(encoder.encode(`data: ${JSON.stringify(sent)}\n\n`))
	}

	function stream(v: Visitor): Response {
		clearTimeout(v.leaving)
		if (v.stream) v.stream.close()
		else options.back?.(v.path)
		let mine: ReadableStreamDefaultController<Uint8Array>
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				mine = v.stream = c
				// a comment: the page knows it is open
				c.enqueue(encoder.encode(": live\n\n"))
				flush(v)
			},
			cancel() {
				if (v.stream !== mine) return
				v.stream = undefined
				away(v)
				options.away?.(v.path)
			},
		})
		return new Response(body, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
		})
	}

	async function event(request: Request): Promise<Response> {
		const e = await request.json() as Said
		const v = visitors.get(e.p)
		if (v === undefined) return new Response(null, { status: GONE })
		try {
			// no such handler: an id from before a re-render, told nothing
			return new Response(null, { status: fire(v.into, e.h, standIn(e)) ? DONE : MISSING })
		} catch (error) {
			return new Response(String(error), { status: BROKE })
		}
	}

	const document = (v: Visitor) =>
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
		`<meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>${title}</title>${options.head ?? ""}<style>${style}</style></head>` +
		`<body>${html(v.into)}<script src="/live.js" defer></script>` +
		Object.keys(scripts).map((name) => `<script src="/${name}" defer></script>`).join("") +
		`</body></html>`

	return {
		fetch(request) {
			const url = new URL(request.url)
			const get = request.method === "GET"
			if (get && url.pathname === "/") {
				const v = visit()
				if (v instanceof Response) return v
				return new Response(document(v), {
					headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
				})
			}
			if (get && url.pathname === "/live") {
				const v = visitors.get(url.searchParams.get("p") ?? "")
				return v ? stream(v) : new Response(null, { status: GONE })
			}
			if (request.method === "POST" && url.pathname === "/event") return event(request)
			if (get && url.pathname === "/live.js") {
				return new Response(client, { headers: { "content-type": "text/javascript" } })
			}
			const script = get ? scripts[url.pathname.slice(1)] : undefined
			if (script !== undefined) {
				return new Response(script, { headers: { "content-type": "text/javascript" } })
			}
			return new Response("not found", { status: MISSING })
		},
		visitors: () => visitors.size,
		close() {
			for (const v of visitors.values()) {
				clearTimeout(v.leaving)
				v.stream?.close()
				v.stop()
			}
			visitors.clear()
		},
	}
}

// what is sent of what was told: a binding whose kids are new is sent whole, as html written now
// (what the bindings inside it showed since is in it), and nothing told inside it is; of the rest,
// each binding's prop once, its last
export function said(told: readonly Update[]): Update[] {
	const whole = told.filter(([, prop]) => prop === "children").map(([b]) => b)
	const last = new Map<string, Update>()
	for (const u of told) {
		const [b, prop, value] = u
		if (whole.some((w) => b.startsWith(w + "/"))) continue
		const k = `${b} ${prop}`
		last.delete(k)
		last.set(k, prop === "children" ? [b, prop, inner(value as Element)] : u)
	}
	return [...last.values()]
}

// the page's event as a handler's args function sees it: its type and key; currentTarget the
// handler's element (its value, checked, a form's named elements' values, its size); target the
// element clicked inside it (its value), or the same; offsetX and offsetY inside the handler's
// element (the page's own are inside target)
function standIn(e: Said) {
	const elements = Object.fromEntries(
		Object.entries(e.form ?? {}).map(([name, value]) => [name, { name, value }]),
	)
	const [offsetX, offsetY, clientWidth, clientHeight] = e.at ?? []
	const current = { value: e.value, checked: e.checked, elements, clientWidth, clientHeight }
	return {
		type: e.t,
		key: e.key,
		target: e.tv === undefined ? current : { value: e.tv },
		currentTarget: current,
		offsetX,
		offsetY,
		isTrusted: true,
		preventDefault() {},
		stopPropagation() {},
	}
}
