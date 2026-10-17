// The reference presence (presence.ts) on the line protocol: one JSON request per line in, one
// answer per line out, in order (conformance/typescript/harness.ts). State lasts for the process:
// two devices, "a" and "b", joined by the in-memory channel (channel.ts), and one clock they share,
// which only { op: "now" } moves: time is the scenario's, never the wall clock. Another
// implementation joins by speaking this (HARNESS). An anchor is any string; a value plain JSON.
//
// time
// { op: "now", t }                           → {}   the clock, in ms (starts at 0)
// the devices (dev: "a" | "b"; "a" is the pair's first channel, "b" its second)
// { op: "connect", dev, name, topic, anchor?, patches? } → {}   presence's connect, the connection kept by name
// { op: "stop", name }                       → {}
// { op: "announce", name }                   → {}
// { op: "set", dev, anchor, who, value, ttl }  → {}   setPresence
// { op: "edit", dev, anchor, who, patches, ttl } → { ok }   editPresence
// { op: "renew", dev, anchor, who, ttl }     → { ok }
// { op: "clear", dev, anchor, who }          → {}
// { op: "sweep", dev, at? }                  → { swept: [{ anchor, who }] }   at: ms, default now
// { op: "pulse", dev }                       → {}   the device's scheduler pulsed
// { op: "ensure", dev, anchor }              → {}
// reads, outside any run (told to no one)
// { op: "presence", dev, anchor }            → { rows: [{ who, value, until }] }   readPresence
// { op: "row", dev, anchor, who }            → { row? }   readRow: { who, value, until }
// { op: "table", dev, anchor }               → { value? }   the entry's value as the table has it
// { op: "sent" }                             → { sent: [{ from, topic, message }] }   every message
//    the channels carried, in order, its bytes decoded as JSON
// { op: "sizes" }                            → { sizes: [n] }   the bytes of each message the channels carried
//    (the JSON text, compact, keys in the order ttl, then value or patches, then n)
// computes, made with the device's scope open, rerun as the reads they track change
// { op: "watch", dev, name, f }              → {}   f: { presence: anchor } | { row: [anchor, who] }
//    (a row gone: null); the run counted, the result (compared as JSON) kept
// { op: "state", name }                      → { runs, value }
// the anchor in the tree (watching a path needs a node mounted there)
// { op: "mount", dev, name, id }             → {}   the children entry "R" has id under name
// { op: "watchPath", dev, name, path }       → {}   places' watchPath on the part "presence", the
//    patches it is told counted
// { op: "told", name }                       → { patches }
// saving
// { op: "save", dev, save }                  → {}   whether the device keeps presence in a save
// { op: "keep", dev?, part, save? }          → { keep }   keep: the device's, or { save } given
import createEntry from "@ermine/node/entry"
import { place } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { createPair } from "./channel.ts"
import { type Device, device } from "./world.ts"
import {
	clear,
	connect,
	editPresence,
	ensure,
	keep,
	PART,
	readPresence,
	readRow,
	renew,
	setPresence,
	sweep,
} from "./presence.ts"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"

type Json = unknown

const clock = { t: 0 }
const devices: Record<string, Device> = { a: device("a", clock), b: device("b", clock) }
const pair = createPair("a", "b")
const channels = { a: pair.a, b: pair.b }
const connections = new Map<string, { stop: () => void; announce: () => void }>()
const watched = new Map<string, { runs: number; value: Json }>()
const told = new Map<string, { patches: number }>()
const dec = new TextDecoder()

const dev = (r: Request): Device => {
	const d = devices[r.dev]
	if (d === undefined) throw new Error(`no device ${r.dev}`)
	return d
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function answer(r: Request): Json {
	switch (r.op) {
		case "now":
			clock.t = r.t
			return {}
		case "connect":
			connections.set(
				r.name,
				connect(dev(r), channels[r.dev as "a" | "b"], {
					topic: r.topic,
					anchor: r.anchor,
					patches: r.patches,
				}),
			)
			return {}
		case "stop":
			connections.get(r.name)!.stop()
			return {}
		case "announce":
			connections.get(r.name)!.announce()
			return {}
		case "set":
			setPresence(dev(r), r.anchor, r.who, r.value, r.ttl)
			return {}
		case "edit":
			return { ok: editPresence(dev(r), r.anchor, r.who, r.patches, r.ttl) }
		case "sizes":
			return { sizes: pair.sent.map((m) => m.bytes.length) }
		case "renew":
			return { ok: renew(dev(r), r.anchor, r.who, r.ttl) }
		case "clear":
			clear(dev(r), r.anchor, r.who)
			return {}
		case "sweep":
			return { swept: sweep(dev(r), r.at) }
		case "pulse":
			dev(r).scheduler.pulse()
			return {}
		case "ensure":
			ensure(dev(r), r.anchor)
			return {}
		case "presence":
			return { rows: readPresence(dev(r), r.anchor) }
		case "row": {
			const row = readRow(dev(r), r.anchor, r.who)
			return row === undefined ? {} : { row }
		}
		case "table": {
			const v = dev(r).table.get(PART, r.anchor)?.value
			return v === undefined ? {} : { value: v }
		}
		case "sent":
			return {
				sent: pair.sent.map((m) => ({
					from: m.from,
					topic: m.topic,
					message: JSON.parse(dec.decode(m.bytes)),
				})),
			}
		case "watch": {
			const d = dev(r), w = { runs: 0, value: null as Json }
			const f = r.f.presence !== undefined
				? () => readPresence(d, r.f.presence)
				: () => readRow(d, r.f.row[0], r.f.row[1]) ?? null
			d.scheduler.runWithScope(
				d.scope,
				() =>
					d.scheduler.createComputer(
						() => (w.runs++, f()),
						(v) => void (w.value = v),
						same,
					),
			)
			watched.set(r.name, w)
			return {}
		}
		case "state": {
			const w = watched.get(r.name)
			if (w === undefined) throw new Error(`no watch ${r.name}`)
			return { runs: w.runs, value: w.value }
		}
		case "mount": {
			const d = dev(r)
			d.scheduler.runWithScope(d.scope, () => {
				const kids = createEntry<Record<string, unknown>>({}, createChangeHeader(d.scheduler))
				d.table.add("children", "R", kids)
				place(kids, r.name, r.id, createChangeHeader(d.scheduler))
				d.places.commit([kids])
			})
			return {}
		}
		case "watchPath": {
			const t = { patches: 0 }
			dev(r).places.watchPath(r.path, (f) => void (t.patches += f.patches.length), {
				part: PART,
			})
			told.set(r.name, t)
			return {}
		}
		case "told":
			return { patches: told.get(r.name)!.patches }
		case "save":
			dev(r).save = r.save
			return {}
		case "keep":
			return { keep: keep(r.dev === undefined ? { save: r.save } : dev(r), r.part) }
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) await serve((r) => answer(r) as Record<string, unknown>)
