import type { ChangeHeader } from "@ermine/core/node/entry"
import type { Id, Path, Places } from "@ermine/core/places"
import type { Runs } from "@ermine/processes/runs"
import type { Computer, Scope } from "@ermine/core/scheduler"
import type { Sited } from "@ermine/sites"
import type { Key } from "@ermine/core/table"
import type { FileLocation } from "@ermine/core/util/stacktrace"
import type { Calls } from "../calls.ts"
import type { Asked, Errored, Reading } from "../features.ts"
import type { Handles } from "../handles.ts"
import type { Inner, Parts, Version, Why } from "../context.ts"
import type { Made } from "./made.ts"
import type { ChangeView, Held, Status, WriterAs } from "./shapes.ts"

// what every api of one ermine shares, beside the context's parts
export type Base = {
	readonly parts: Parts
	readonly sited: Pick<Sited, "createScope" | "createComputer" | "createEffect">
	readonly statuses: { give: (c: Computer, id: Id) => void }
	readonly runs: Runs
	readonly calls: Calls
	// what owners made, by node: every memo and effect (a read of a memo pending with no value
	// throws PENDING; its status is written as the context that made it; status reads its run)
	readonly made: Map<Id, Made>
	// what each reader is waiting to be there: a read of a node not there (thrown PENDING), by the
	// reader, the paths as it read them (and each once, by key). kept while what shows it does: a
	// computer's (its node) for its latest run, gone with it; a process's setup's (its node) while
	// the setup runs, then said in its status. a read anywhere else is shown nowhere: none kept
	readonly missing: Map<
		Id,
		{ readonly n?: number; readonly paths: Path[]; readonly keys: Set<string> }
	>
	// the processes whose setup is running now, by node
	readonly setting: Set<Id>
	// each method placed, by its node: the function, and the scope open when it was placed (one
	// function placed by two owners: each placement its own). gone with that scope
	readonly methods: Map<Id, { readonly fn: unknown; readonly scope: Scope }>
	// why a process is stopping (by its node), said by stop before its scope goes
	readonly whys: Map<Id, Why>
	// a running process stopped, by its node's id (ermine's start sets it): unplace's and remove's
	stop: (id: Id) => void
	// a process started by a program (start below): fn at path, its scope under the starter's owner
	// (ermine's start sets it)
	start: (
		fn: () => unknown,
		at: Path,
		options: { args?: readonly string[]; places?: Places },
		under: Scope,
	) => { process: { id: Id; at: Path; folder: Path }; stop: (why?: Why) => void } | {
		refused: "taken"
		at: Path
		held?: { process: Id; feature: string }
	}
	readonly newId: () => string
	// an error a function threw, through the onError hooks: what is thrown
	readonly errored: Errored
	// every node handle the functions gave (handles.ts)
	readonly handles: Handles
	// every writer createWriter gave, and what it runs as
	readonly writers: WeakMap<object, WriterAs>
	// each running process's context, by its node: where it runs, from the root (its row names it,
	// not a children entry, so places' namesOf has it not: seen's), and the root of the places it
	// runs in (its "/"), as the paths it recorded are from (a wait's): shown to a reader of another
	// root as none
	readonly processes: Map<Id, Inner>
	// each change's view, and each view's change (ChangeView)
	readonly views: WeakMap<ChangeHeader, ChangeView>
	readonly changes: WeakMap<ChangeView, ChangeHeader>
	// a pulse now (the pulse function's)
	readonly pulse: () => void
	// f(inner, ...a) with the entry here: a write made in it has its site at the line that called in;
	// site, a build's (site.ts): that one, nothing captured
	readonly enter: <A extends unknown[], T>(
		f: (inner: Inner, ...a: A) => T,
		inner: Inner,
		a: A,
		site?: FileLocation,
	) => T
	// the onRead hooks
	readonly shown: (x: Reading, items: readonly Version[]) => readonly Version[]
	// the onTeardown hooks around fn(why)
	readonly torn: (scope: Scope, why: Why, fn: (why: Why) => unknown) => void
	// the onStatus hooks around the base's status
	readonly statused: (x: Asked, status: Status) => Status
	// writes held back by onWrite, tracked: at (part, id); a node's status write; a stopped
	// process's row
	readonly held: {
		at: (part: Key, id: Id) => { feature: string } | undefined
		status: (id: Id) => Held | undefined
		row: (id: Id) => Held | undefined
		// a node gone: what was held at its parts holding nothing goes with it
		drop: (id: Id) => void
	}
}
