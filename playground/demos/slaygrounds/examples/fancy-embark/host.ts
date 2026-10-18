import { createWorld } from "@ermine/slaygrounds/world"
import { trace } from "@ermine/scheduler/trace"
import { render } from "ermine-h"

// fancy-embark's host: the world (@ermine/slaygrounds/world), one process, embark, and what only a
// host can give it (each in extend below, with what it is for):
//   lookup, peek   a request to a public api is a node at /cache/<api>/<hash of its url>. a run
//                  asks for it: there, its value; not there, the request is queued (one server at a
//                  time, each at its own polite rate) and the run ends pending. the answer lands as
//                  that node, the run had read the place, so it runs again and finds it. a failure
//                  lands too, as a node saying so: the program shows it in place, until retry (or the
//                  browser being online again) takes it out. peek never waits or throws: it says
//                  { result } | { waiting } | { error } (menus, previews)
//   retry          the failure nodes taken out, so whoever read them asks again
//   ended          told how each memo ended a run, what it read named (nodes, and /cache keys)
// the request is the host's: a browser can not set User-Agent, so each fetch says where it is from
// with its referrer (Nominatim asks for one naming the application)
// before the program runs, /cache is filled from seed.json (committed beside this file: the default
// trip's lookups) and from this browser's localStorage (what was fetched here before; answers
// only, never failures). /net is what the network did

const APIS = ["geocode", "route", "weather"]
// one queue per server, each at its own rate (their usage policies: Nominatim at most 1/s, the
// OSRM demo and FOSSGIS servers light use, Open-Meteo is generous). one request at a time each
const RATE: Record<string, number> = {
	"nominatim.openstreetmap.org": 1100,
	"router.project-osrm.org": 1000,
	"routing.openstreetmap.de": 1000,
	"api.open-meteo.com": 300,
	"historical-forecast-api.open-meteo.com": 300,
}
// the playground's own folder, worked out by the editor (/ locally, /slaygrounds/ on the site)
const BASE = (parent as unknown as { __base?: string }).__base ?? document.baseURI
const REFERRER = new URL("examples/fancy-embark/?app=ermine-slaygrounds-fancy-embark", BASE).href
const SAVE = "fancy-embark:cache:v1"

type Entry = {
	api?: string
	url?: string
	at?: string
	ms?: number
	from?: string
	result?: unknown
	error?: string
}
const queues = new Map<string, { jobs: (() => Promise<void>)[]; last: number; busy: boolean }>()
const inflight = new Set<string>() // api/key asked and not landed

function fresh() {
	return {
		requests: 0,
		hits: 0,
		misses: 0,
		failed: 0,
		landed: 0,
		waiting: {} as Record<string, number>,
		recent: [] as unknown[],
		kept: { seed: 0, saved: 0, live: 0 },
	}
}
let stats = fresh()

// what was kept: seed.json and this browser's own
function saved(): Record<string, Entry> {
	try {
		return JSON.parse(localStorage.getItem(SAVE) ?? "{}")
	} catch {
		return {}
	}
}
function save(api: string, key: string, entry: Entry) {
	try {
		const all = saved()
		all[`${api}/${key}`] = entry
		localStorage.setItem(SAVE, JSON.stringify(all))
	} catch { /* no storage, or full: only this session keeps it */ }
}
const seedFile: Record<string, Entry> = await fetch(
	new URL("examples/fancy-embark/seed.json", BASE),
)
	.then((r) => (r.ok ? r.json() : {}))
	.catch(() => ({}))

const world = createWorld({
	render,
	processes: [{ name: "embark" }],
	extend: (api) => ({
		lookup,
		peek,
		retry,
		// fn told each time a memo of this process ends a run: { name, of, run, ended, error, ms,
		// values, keys }. name and of are the last two names of the memo's place (result/<id>); values
		// the ids of the nodes it read, keys the /cache keys ("geocode/<hash>")
		ended(fn: (run: Record<string, unknown>) => void) {
			const started = new Map<unknown, number>()
			api.teardown(trace(ermine.s, (m) => {
				if ("starts" in m) started.set(m.starts, performance.now())
				if (!("ends" in m) || m.ended === "stopped") return
				const part = ermine.parts.get(m.ends)
				if (!part) return
				const at = part.entry.path
				const values: string[] = [], keys: string[] = []
				for (const k of m.reads) {
					const w = ermine.places.describe(k)
					if (!w) continue
					if (w.part === "value") values.push(String(w.id))
					else if (w.part === "children" && w.path?.length === 1) {
						const api = APIS.find((a) => String(w.id) === folders.get(a))
						if (api) keys.push(`${api}/${w.path[0]}`)
					}
				}
				const t0 = started.get(m.ends)
				fn({
					name: at[at.length - 2],
					of: at[at.length - 1],
					run: m.run,
					ended: m.ended,
					error: m.error === undefined ? undefined : said(m.error),
					ms: t0 === undefined ? undefined : +(performance.now() - t0).toFixed(1),
					values,
					keys,
				})
			}))
		},
	}),
})
const host = world.hostAPI
const folders = new Map<string, string>() // api -> the id of /cache/<api>
// the world is a global by now
declare const ermine: any

world.seed((h) => {
	h.open("/cache", "every lookup, by the hash of its url")
	for (const api of APIS) h.open(`/cache/${api}`, null)
	h.open("/net", stats)
	for (const [from, all] of [["seed", seedFile], ["saved", saved()]] as const) {
		for (const [k, entry] of Object.entries(all)) {
			const [api, key] = k.split("/")
			if (!APIS.includes(api) || entry?.error !== undefined) continue
			if (from === "saved" && h.entries(`/cache/${api}/${key}`).length) continue
			h.open(`/cache/${api}/${key}`, { ...entry, from })
			stats.kept[from]++
		}
	}
	h.edit("/net", [{ path: [], value: structuredClone(stats) }])
	for (const api of APIS) folders.set(api, String(h.entries(`/cache/${api}`)[0].id))
})

// the network's node is written after the run that asked is over (a run never writes), at most
// four times a second: a hit is told on every run that finds its answer
let telling = false
function tell(change: (n: typeof stats) => void) {
	change(stats)
	if (telling) return
	telling = true
	setTimeout(() => {
		telling = false
		host.edit("/net", [{ path: [], value: structuredClone(stats) }])
	}, 250)
}
const said = (e: unknown) => String((e as Error)?.message ?? e)

// in a run: the answer to url, from /cache/<api>; not there yet: asked, and the run is pending
function lookup(api: string, url: string) {
	const out = peek(api, url)
	if ("error" in out) throw new Error(out.error)
	if ("waiting" in out) throw host.PENDING
	return out.result
}
function peek(api: string, url: string):
	| { result: unknown; from?: string; at?: string; ms?: number }
	| { waiting: true }
	| { error: string; at?: string } {
	const key = hash(url)
	if (!APIS.includes(api)) return { error: `no api ${api}` }
	const v = host.read(`/cache/${api}/${key}`) as Entry | undefined
	if (v !== undefined) {
		tell((n) => n.hits++)
		if (v.error !== undefined) return { error: v.error, at: v.at }
		return { result: v.result, from: v.from, at: v.at, ms: v.ms }
	}
	ask(api, url, key)
	return { waiting: true }
}

function ask(api: string, url: string, key: string) {
	if (inflight.has(api + "/" + key)) return
	inflight.add(api + "/" + key)
	const server = new URL(url).host
	const q = queues.get(server) ?? { jobs: [], last: 0, busy: false }
	queues.set(server, q)
	tell((n) => (n.misses++, n.waiting[server] = (n.waiting[server] ?? 0) + 1))
	q.jobs.push(async () => {
		const t0 = performance.now()
		let entry: Entry
		try {
			if (navigator.onLine === false) throw new Error("offline: the browser has no network")
			const r = await fetch(url, {
				headers: { accept: "application/json" },
				referrer: REFERRER,
				referrerPolicy: "no-referrer-when-downgrade",
				signal: AbortSignal.timeout(15000),
			})
			if (!r.ok) throw new Error(`${server} said ${r.status} ${r.statusText}`.trim())
			const result = await r.json()
			entry = {
				api,
				url,
				at: new Date().toISOString(),
				ms: Math.round(performance.now() - t0),
				from: "live",
				result,
			}
			save(api, key, entry)
		} catch (e) {
			const why = (e as Error)?.name === "TimeoutError"
				? `${server} did not answer in 15s`
				: e instanceof TypeError
				? `could not reach ${server} (offline?)`
				: said(e)
			entry = { api, url, at: new Date().toISOString(), error: why, from: "live" }
		}
		inflight.delete(api + "/" + key)
		// an answer (or a failure) as the node at /cache/<api>/<key>: a new one, or the one there
		const at = `/cache/${api}/${key}`
		if (host.entries(at).length) host.edit(at, [{ path: [], value: entry }])
		else host.open(at, entry)
		tell((n) => {
			n.waiting[server] = Math.max(0, (n.waiting[server] ?? 1) - 1)
			if (entry.error) n.failed++
			else (n.landed++, n.kept.live++)
			n.requests++
			n.recent = [
				{ api, key, server, ms: entry.ms, error: entry.error, at: entry.at, url },
				...n.recent,
			].slice(0, 30)
		})
	})
	pump(server)
}

function pump(server: string) {
	const q = queues.get(server)!
	if (q.busy || !q.jobs.length) return
	q.busy = true
	const wait = Math.max(0, q.last + (RATE[server] ?? 1000) - performance.now())
	setTimeout(async () => {
		q.last = performance.now()
		await q.jobs.shift()!()
		q.busy = false
		pump(server)
	}, wait)
}

// failures taken out, so whoever read them asks again (all, or one api's)
function retry(api?: string) {
	for (const a of api ? [api] : APIS) {
		for (const name of host.list(`/cache/${a}`)) {
			const at = `/cache/${a}/${name}`
			if ((host.read(at) as Entry | undefined)?.error !== undefined) host.remove(at)
		}
	}
}
addEventListener("online", () => retry())

// the cache as seed.json has it: every answer, by api/key (for the console: ermine.embark.dump())
function dump() {
	const out: Record<string, unknown> = {}
	for (const api of APIS) {
		for (const name of host.list(`/cache/${api}`)) {
			const v = host.read(`/cache/${api}/${name}`) as Entry | undefined
			if (v?.result !== undefined) {
				out[`${api}/${name}`] = { api, url: v.url, at: v.at, ms: v.ms, result: v.result }
			}
		}
	}
	return JSON.stringify(out)
}
ermine.embark = { dump, retry, stats: () => stats }

// a hash of a string (53 bits, as hex): prog-build's, copied
function hash(v: string) {
	let h1 = 0xdeadbeef, h2 = 0x41c6ce57
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i)
		h1 = Math.imul(h1 ^ c, 2654435761)
		h2 = Math.imul(h2 ^ c, 1597334677)
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")
}

export const reload = world.reload
