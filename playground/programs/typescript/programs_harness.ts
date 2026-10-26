// programs (programs.ts, @ermine/types) on the line protocol: one JSON request per line in, one
// answer per line out, in order. one world per process: a scheduler, table, paths and the host's
// places (root "R", children alone), told the table's events and every write (a box's places is a
// view of it). boxes by name; a folder a box made is answered as "box:<name>" anywhere. ids are
// strings, a path a list of names. the host writes with its scope open, info {"actor":"test"}.
// a PlacesError answers { error: code }
//
// the world:
// { op: "root", name }                      → {}   a scope with no parent
// { op: "kids", id, value }                 → {}   the children entry, replaced (a table event)
// { op: "attrs", id, value }                → {}   the attributes entry, replaced (a table event)
// { op: "value", id, value }                → {}   the value entry, replaced (a table event)
// { op: "host", id }                        → {}   the value entry: a live host runner, never saved
// { op: "upsert", part, id, path, value }   → {}   places' upsert at path: a patch, telling only
//    the reads it touches
// { op: "types", list? }                    → {}   installTypes at R, the list given ([{ name,
//    conformsTo?, fileNameExtension?, mimeType? }]; none: the excerpt and EXTRA); a new node's id
//    its path joined by "/" ("ermine/types/public.text")
// { op: "create", name, folder?, at? }      → {}   createBox at the folder id, or at the address
//    at from R (made if missing)
// { op: "box", box, path, node }            → {}   box (it commits itself)
// { op: "unbox", box, path }                → {}
// programs:
// { op: "program", box?, program, from }    → satisfy's answer   in the box named (none: the
//    host's places), outside any run: program a path string, from a path
// { op: "open", box?, file, from }          → openwith's answer   the same; file an id or { id,
//    at } (typed by its name when it has no ermine.type)
// { op: "type", box?, node }                → { type }   typeOf of node ({ id, at }); null: none
// { op: "type", box?, folder }              → { types }   each member of the folder (a path from
//    the box's root) by name: its typeOf there, { "a.c": "public.c-source", "b": null }
// { op: "watch", name, scope, box?, program? | file? | node? | folder?, from? } → {}   a compute
//    in scope calling satisfy, openwith or typeOf each run, as those ops; results compared as JSON
// answers: the generator taken whole, every whynot in why, in order. satisfy's: { program,
// chains, why }, or the search's own whynot as a refusal: { refused: "nothing-there", path, at
// (its from) }, { refused: "no-type", program }, { refused: "no-chain", program, why }.
// openwith's: { ways, why }, or { refused: "no-type", id }
// { op: "pulse" }                           → {}
// { op: "state", name, only? }              → { runs, value }   run count; last result (null:
//    none), as program and open answer; only: just the fields named (a refusal whole)
import createEntry, { type Entry } from "@ermine/core/node/entry"
import { type Computer, createScheduler, type Scope } from "@ermine/core/scheduler"
import { createPaths } from "@ermine/core/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/core/table"
import { createPlaces, PlacesError } from "@ermine/core/places"
import { createChangeHeader } from "@ermine/core/places/header"
import { upsert } from "@ermine/core/places/upsert"
import { type Address, type Box, box, createBox, unbox } from "@ermine/boxes"
import { type Request, serve } from "../../../conformance/typescript/harness.ts"
import { openwith, type Refusal, satisfy, type Way, type Why } from "./programs.ts"
import { installTypes, typeOf } from "@ermine/types"
import { level } from "@ermine/core/places"
import { members } from "@ermine/core/places/lib"
import { keyorder } from "@ermine/core/util/keyorder"

type Json = unknown

const s = createScheduler()
const table = createTable((part, id) => places.onTableChange(part as Key, id))
const paths = createPaths<unknown>()
const places = createPlaces({ root: "R", table, paths, scheduler: s })
s.onTrackingEnd((key) => places.release(key))
const host = s.createRootScope({ actor: "test" })
const hosted = <T>(f: () => T) => s.runWithScope(host, f)
const header = () => createChangeHeader(s)
const commit = (changed: Entry<unknown>[]) => places.commit(changed)

const scopes = new Map<string, Scope>()
const watched = new Map<string, { runs: number; value: Json }>()
const named = new Map<string, Box>()
const names = new Map<Id, string>()

const json = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// a folder a box made: a uuid
const FRESH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// an answer as JSON, every folder a box made as "box:<name>"
function plain(x: unknown): Json {
	return JSON.parse(
		JSON.stringify(
			x ?? null,
			(_, v) => typeof v === "string" && names.has(v) ? `box:${names.get(v)}` : v,
		),
	)
}

function boxOf(name: unknown): Box {
	const b = named.get(name as string)
	if (b === undefined) throw new Error(`no box ${name}`)
	return b
}

// satisfy or openwith in the box named (none: the host's places), taken whole: the answer as it
// was before they were generators
function look(r: Request): Json {
	const p = r.box === undefined ? places : boxOf(r.box).places
	if (r.node !== undefined) return { type: typeOf(p, r.node) ?? null }
	if (r.folder !== undefined) {
		const here = members(p, r.folder).filter((m) => m.id !== level)
		here.sort((a, b) => keyorder(a.name, b.name))
		return {
			types: Object.fromEntries(
				here.map((m) => [m.name, typeOf(p, { id: m.id, at: [...r.folder, m.name] }) ?? null]),
			),
		}
	}
	const why: Why[] = []
	let refusal: Refusal | undefined
	const onwhynot = (w: Why | Refusal) => "for" in w ? why.push(w) : refusal = w
	const ways: Way[] = r.file === undefined
		? [...satisfy(p, r.program, r.from, { onwhynot })]
		: [...openwith(p, r.file, r.from, { onwhynot })]
	if (r.file !== undefined) {
		const id = typeof r.file === "object" ? r.file.id : r.file
		return plain(refusal ? { refused: "no-type", id } : { ways, why })
	}
	if (refusal === undefined) {
		return plain({ program: ways[0].program, chains: ways.map((w) => w.chain), why })
	}
	if (refusal.why === "nothing-there") {
		return plain({ refused: refusal.why, path: refusal.path, at: refusal.from })
	}
	const program = { id: refusal.id, at: refusal.at }
	return plain(
		refusal.why === "no-type"
			? { refused: refusal.why, program }
			: { refused: refusal.why, program, why },
	)
}

function answer(r: Request): Json {
	switch (r.op) {
		case "root":
			scopes.set(r.name, s.createRootScope(r.info))
			return {}
		case "kids":
			hosted(() => table.sub("children", r.id, createEntry(r.value, header())))
			return {}
		case "attrs":
			hosted(() => table.sub("attributes", r.id, createEntry(r.value, header())))
			return {}
		case "value":
			hosted(() => table.sub("value", r.id, createEntry(r.value, header())))
			return {}
		case "host":
			hosted(() => table.sub("value", r.id, createEntry(() => {}, header())))
			return {}
		case "upsert":
			hosted(() => commit(upsert(table, r.part, r.id, r.path, r.value, header())))
			return {}
		case "types":
			hosted(() =>
				commit(installTypes(table, "R", header(), r.list ?? undefined, (p) => p.join("/")))
			)
			return {}
		case "create": {
			const at = r.folder !== undefined ? { id: r.folder } : r.at as Address
			const b = hosted(() => createBox({ places, table, scheduler: s }, at))
			named.set(r.name, b)
			if (FRESH.test(String(b.root))) names.set(b.root, r.name)
			return {}
		}
		case "box":
			hosted(() => box(boxOf(r.box), r.path, r.node))
			return {}
		case "unbox":
			hosted(() => unbox(boxOf(r.box), r.path))
			return {}
		case "program":
			return look({ ...r, file: undefined })
		case "open":
		case "type":
			return look(r)
		case "watch": {
			const o = scopes.get(r.scope)
			if (o === undefined) throw new Error(`no scope ${r.scope}`)
			const w = { runs: 0, value: null as Json }
			const c: Computer = s.runWithScope(o, () =>
				s.createComputer(
					() => (w.runs++, look(r)),
					(v) => void (w.value = v),
					json,
				))
			scopes.set(r.name, c)
			watched.set(r.name, w)
			return {}
		}
		case "pulse":
			s.pulse()
			return {}
		case "state": {
			const w = watched.get(r.name)
			if (w === undefined) throw new Error(`no compute ${r.name}`)
			const v = w.value as Record<string, unknown> | null
			if (r.only === undefined || v === null || "refused" in v) return { runs: w.runs, value: v }
			return {
				runs: w.runs,
				value: Object.fromEntries((r.only as string[]).map((k) => [k, v[k]])),
			}
		}
	}
	throw new Error(`unknown op ${r.op}`)
}

if (import.meta.main) {
	await serve((r) => {
		try {
			return answer(r) as Record<string, unknown>
		} catch (e) {
			if (e instanceof PlacesError) return { error: e.code }
			throw e
		}
	})
}
