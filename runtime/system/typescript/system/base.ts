import type { ChangeHeader } from "@ermine/graph/entry"
import type { Id, Path, Places } from "@ermine/places"
import type { Index } from "@ermine/places/children"
import type { Runs } from "@ermine/processes/runs"
import type { Computer, Frame, Scope } from "@ermine/reactivity"
import type { Location } from "@ermine/changeable/stacktrace"
import type { Calls } from "../calls.ts"
import type { Errored, Reading } from "../features.ts"
import type { Handles } from "../handles.ts"
import type { Inner, Parts, Version, Why } from "../context.ts"
import type { Made } from "./made.ts"
import type { ChangeView, WriterAs } from "./shapes.ts"

export type Base = {
	readonly parts: Parts
	readonly locations: () => Location[] | undefined
	readonly statuses: { give: (c: Computer, id: Id) => void }
	readonly runs: Runs
	readonly calls: Calls
	readonly made: Map<Id, Made>
	// What names each node, by folder and name.
	readonly names: Index
	// Reads of nodes that are not there, per reader, shown in a computer's or a process's status.
	readonly missing: Map<
		Id,
		{ readonly n?: number; readonly paths: Path[]; readonly keys: Set<string> }
	>
	readonly setting: Set<Id>
	// Each placed method by node: the function, the scope it was placed in, and the handler's frame.
	readonly methods: Map<Id, { readonly fn: unknown; readonly scope: Scope; readonly frame: Frame }>
	readonly whys: Map<Id, Why>
	stop: (id: Id) => void
	start: (
		fn: () => unknown,
		at: Path,
		options: { args?: readonly string[]; places?: Places },
		under: Scope,
	) => { process: { id: Id; at: Path; folder: Path }; stop: (why?: Why) => void } | {
		refused: "taken"
		at: Path
	}
	readonly newId: () => string
	readonly errored: Errored
	readonly handles: Handles
	readonly writers: WeakMap<object, WriterAs>
	// Each running process's context by node: where it runs and the root of its places.
	readonly processes: Map<Id, Inner>
	readonly views: WeakMap<ChangeHeader, ChangeView>
	readonly changes: WeakMap<ChangeView, ChangeHeader>
	readonly pulse: () => void
	readonly enter: Parts["enter"]
	readonly shown: (x: Reading, items: readonly Version[]) => readonly Version[]
}
