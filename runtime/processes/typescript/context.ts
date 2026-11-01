// The process context: where and as whom a thing is done. Its host makes it; programs never see it.
// A write with nothing open throws nothing-open for a process.
import type { Patch } from "@ermine/changeable/apply"
import type { Id, Path } from "@ermine/places"
import type { Target as Asked } from "@ermine/protect"
import type { Scope } from "@ermine/reactivity"
import type { Key } from "@ermine/graph/table"
import type { Process } from "./start.ts"

export type At = Id | { readonly id: Id; readonly path?: Path }

export type ProcessContext = {
	readonly scope: Scope
	readonly folder: Path
	readonly at: Path
	readonly args: readonly string[]
	readonly process?: Process
	resolve: (p: string | Path) => Path
	within: <T>(f: () => T) => T
	write: (part: Key, at: At, patches: readonly Patch[]) => void
	remove: (part: Key, at: At) => void
	ask: (op: string, ...targets: Asked[]) => void
	queuePulse: () => void
}
