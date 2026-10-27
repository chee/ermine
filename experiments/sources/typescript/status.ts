// what a mirror, a link or a history is doing, in the graph, so anyone tracking it sees it (a demo
// card reads it as any value). two kinds of thing:
//   - a state: what it is doing now, a code and its words (STATES, below: the one list). a mirror
//     and a link are processes (ermine/processes' start) at a path under /system, each giving a
//     computer whose value is its state: the value is written as the process node's value, and
//     the process's status (ermine.computer.status) is that computer's, PENDING only until its
//     first run
//   - a record: what it has, counted or listed (the file, the node mirrored, values not written,
//     names known, refusals, facts skipped): attributes on its node, ermine.sources.*
//
//   const p = startShown(graph, at, { attributes }, (shown) => { ...; return stop })
//   shown.state("in-step")                 // the computer runs again, its value the new state
//   shown.record({ [UNWRITTEN]: 1 })       // only what changed is written
//   readState(places, p.id); readRecord(places, p.id)   // the reads told (in a run: tracked)
//
// the history has no state that changes (it records until stopped), so it is no process: its
// record (SKIPPED) is on a scope's node of its own (openRecord), which goes with that scope
//
// every write: the node's scope open (its info, then the scopes above it: the actor is theirs),
// its site the call into record, or the computer's run. nothing here is synced or saved by itself:
// a history records it only when its host's rule says so (world.ts leaves these nodes, and the
// process rows, out: they are this device's, now)
import createEntry, { type Entry } from "@ermine/core/node/entry"
import update from "@ermine/core/node/update"
import type { Patch } from "@ermine/core/changeable/apply"
import type { Box } from "@ermine/boxes"
import type { Places } from "@ermine/core/places"
import { createChangeHeader, NODE } from "@ermine/core/places/header"
import { upsert } from "@ermine/core/places/upsert"
import type { Options, Process, Processes } from "@ermine/processes/start"
import type { ScopeNodes } from "@ermine/processes/scopes"
import type { Info, Scheduler, Scope } from "@ermine/core/scheduler"
import type { Id, Table, Tables } from "@ermine/core/table"
import { same } from "./write.ts"

// every state's code and its words: a program branches on the code, a person reads the words.
// what differs each time (an error's message) is the state's why
export const STATES = {
	// a mirror's
	"opening": "opening",
	"in-step": "in step",
	"changed-not-written": "the file changed since I last looked: not written; read in",
	"changed-while-failing": "the file changed while I couldn't write; read in",
	"cant-write": "can't write",
	"cant-encode": "can't write the value in the file's form",
	"cant-read": "can't read the file",
	"cant-decode": "the file doesn't decode",
	"cant-decode-not-written": "the file doesn't decode: not written",
	"gone": "the file is gone",
	"gone-not-written": "the file is gone: not written",
	// a link's (and "in-step")
	"not-synced": "not synced yet",
	"syncing": "syncing",
	"behind": "behind: more to send",
	"cant-sync": "can't sync",
} as const

export type Code = keyof typeof STATES

export type State = { readonly code: Code; readonly words: string; readonly why?: string }

export const stateOf = (code: Code, why?: string): State =>
	why === undefined ? { code, words: STATES[code] } : { code, words: STATES[code], why }

// the records, as attributes
// the file mirrored, by the name its access gives
export const FILE = "ermine.sources.file"
// the node whose value is mirrored
export const MIRRORS = "ermine.sources.mirrors"
// how many of the graph's values a mirror did not write, to keep what the file held
export const UNWRITTEN = "ermine.sources.unwritten"
// how many names each side of a link is known to hold: { a, b }
export const KNOWN = "ermine.sources.known"
// every write a link's holders refused: [{ name, node, why }]
export const REFUSED = "ermine.sources.refused"
// how many facts a history could not name
export const SKIPPED = "ermine.sources.skipped"

// a graph things are shown in: where a record is written
export type Graph = {
	scheduler: Pick<Scheduler, "runWithScope" | "getCurrentScope" | "getRun">
	table: Pick<Table, "get" | "add">
	places: Pick<Places, "commit">
}

// the fields written into a node's attributes with scope open, each only when not as it is there;
// undefined: taken out
export function createRecord(graph: Graph, id: Id, scope: Scope) {
	const { scheduler, table, places } = graph
	return function record(fields: Readonly<Record<string, unknown>>) {
		if (scope.state !== "alive") return
		scheduler.runWithScope(scope, () => {
			const there = table.get("attributes", id) as Entry<unknown> | undefined
			const v = there?.value as Record<string, unknown> | undefined
			const changed = Object.entries(fields).filter(([k, x]) =>
				x === undefined ? v !== undefined && Object.hasOwn(v, k) : !same(v?.[k], x)
			)
			if (changed.length === 0) return
			const header = createChangeHeader(scheduler, undefined, undefined, record)
			if (there === undefined) {
				const made = Object.fromEntries(changed.filter(([, x]) => x !== undefined))
				table.add("attributes", id, createEntry(made, header) as Entry<Tables["attributes"]>)
				return
			}
			const patches: Patch[] = changed.map(([k, x]) =>
				x === undefined ? { path: [k] } : { path: [k], value: x }
			)
			update(there, patches, header)
			places.commit([there])
		})
	}
}

// where a process is started: the graph, its processes, and the scope its scope goes under (the
// device's: its info says the actor)
export type Running = {
	scheduler: Scheduler
	table: Table
	places: Places
	processes: Pick<Processes, "start" | "stop">
	scope: Scope
}

export type Shown = {
	readonly process: Process
	// the state now: the computer marked, a pulse run
	state(code: Code, why?: string): void
	// what the state is now
	now(): State
	record(fields: Readonly<Record<string, unknown>>): void
}

export type Refused = { readonly refused: "taken"; readonly at: readonly string[] }

// a process at at, under graph.scope, its node's attributes given; body given what it shows,
// returning its stop. the computer of its state is made and given before body, its first state
// "opening"; a pulse after start runs it, and its first run takes PENDING off. the path taken (a
// process at, above or under it): refused, nothing made, body not called
export function startShown(
	graph: Running,
	at: readonly string[],
	attributes: Readonly<Record<string, unknown>>,
	body: (shown: Shown) => () => void,
): Process | Refused {
	const { scheduler: s, table, places, processes } = graph
	const options: Options = { attributes, under: graph.scope }
	let shown: Shown | undefined
	const box: Box = { root: places.root, places }
	const p = processes.start(box, [...at], options, (inside) => {
		const key = {}
		let current = stateOf("opening")
		const write = (v: State) =>
			places.commit(upsert(table, "value", inside.id, [], v, createChangeHeader(s)))
		const c = s.createComputer(
			() => {
				s.track(key)
				return current
			},
			write,
			same,
		)
		inside.give(c)
		shown = {
			process: inside,
			state(code, why) {
				if (inside.scope.state !== "alive") return
				current = stateOf(code, why)
				s.mark([key])
				s.pulse()
			},
			now: () => current,
			record: createRecord(graph, inside.id, inside.scope),
		}
		return body(shown)
	})
	if ("refused" in p) return p
	s.pulse()
	return p
}

// a node of its own, not a process: a scope's (processes' scopes.ts) under the one given, its
// entries going with that scope. close: the scope torn down
export function openRecord(
	graph: Graph & {
		scheduler: Pick<Scheduler, "createScope" | "teardown">
		scopes: Pick<ScopeNodes, "give">
	},
	under: Scope,
	info: Info,
) {
	const id = `scope:${crypto.randomUUID()}`
	const scope = graph.scheduler.createScope({ ...info, [NODE]: id }, under)
	graph.scopes.give(scope, id)
	return {
		id,
		record: createRecord(graph, id, scope),
		close() {
			if (scope.state === "alive") graph.scheduler.teardown(scope)
		},
	}
}

// a process's state, the read told: its node's value. none: undefined
export const readState = (places: Pick<Places, "readValue">, id: Id): State | undefined =>
	places.readValue("value", id) as State | undefined

// a node's records (its attributes), the read told. none: {}
export function readRecord(
	places: Pick<Places, "readValue">,
	id: Id,
): Record<string, unknown> {
	const v = places.readValue("attributes", id)
	return typeof v === "object" && v !== null ? v as Record<string, unknown> : {}
}
