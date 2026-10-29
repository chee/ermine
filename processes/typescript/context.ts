// the process context: where and as whom a thing is done. a scope, a folder (the one it is in), a
// path, its args, and a process or none (the host's: process 0). the layer under the api:
// every function is made from one; features reach it (onWrite is given it); programs never do.
// its host makes it (system's context.ts)
//
// resolve(p)            a bare name: inside at (the process's own node); ./: in folder, beside
//                       at; ../: above folder; /: the root. a path going above "/": nothing-there
// within(f)             f with this context's scope open (explicit: for host and feature code)
// write(part, at, patches)  one write at a node (its id, or { id, path }), asked "edit" on it
//                       (by its path when given, so a policy by path decides): through onWrite, a
//                       header (the open scope's, else this context's; its frame the one open),
//                       committed, a pulse asked for
// remove(part, at)      the entry at a node's part taken out (not a value written undefined: no
//                       entry there after), asked "edit" as write is. for now: revisit once tx
//                       lands [chee 10-25: "note to revisit it after tx lands"]
// ask(op, ...targets)   protect (the host's may; none: all allowed): a no throws a Refusal
// queuePulse()          one pulse soon, however many ask
// a write with nothing open: a process's throws nothing-open; the host's falls back to its own scope
import type { Patch } from "@ermine/changeable/apply"
import type { Id, Path } from "@ermine/places"
import type { Target as Asked } from "@ermine/protect"
import type { Scope } from "@ermine/reactivity"
import type { Key } from "@ermine/graph/table"
import type { Process } from "./start.ts"

// what a write is aimed at: a node's id, and the path it was reached by when there is one
export type At = Id | { readonly id: Id; readonly path?: Path }

export type ProcessContext = {
	readonly scope: Scope
	readonly folder: Path
	// the host's: []
	readonly at: Path
	readonly args: readonly string[]
	// the host's: none
	readonly process?: Process
	resolve: (p: string | Path) => Path
	within: <T>(f: () => T) => T
	write: (part: Key, at: At, patches: readonly Patch[]) => void
	remove: (part: Key, at: At) => void
	ask: (op: string, ...targets: Asked[]) => void
	queuePulse: () => void
}
