// design L, "imported": A's words, imported from "ermine" in any file (designs/l/ermine.ts), each
// finding its process from the scope open as it is called. the adapter registers the process's
// scope with its real words; the program's function is given only what the task gives (save,
// check, title) and show.
// decisions:
//   registered: the scope open as the adapter runs (the setup's, made again when the setup runs
//     again) and its parent (the process's): what runs under either reaches the process
//   the words are A's (open, read, peep, reads, list, edit, memo, effect, method, send, status,
//     why, teardown, PENDING) with H's one change: a write to a node not there makes it. edit with
//     a recipe there: the recipe given undefined, the node made holding what it returns (nothing
//     returned: nothing made); a whole-value patch: made holding it
//   here(): the scope open, kept, to run code in later (ermine.ts). not in A: without it nothing
//     can write after an await (save, shared, after-await)
import type { Adapter } from "../../lib/trial.ts"
import { abs, missing } from "../../lib/contexts.ts"
import { register } from "./ermine.ts"
import type { NodeData as Node } from "@ermine/ermine"

type Change = ((d: unknown) => unknown) | { path: unknown[]; value?: unknown }[]

const adapter: Adapter = (api, extras, { scheduler }) => {
	const nodeOf = (x: unknown): Node => typeof x === "string" ? api.open(x) : x as Node
	const edit = (x: unknown, change: Change) => {
		const n = nodeOf(x)
		if (n.path !== undefined && missing(api, n)) {
			if (typeof change === "function") {
				const made = change(undefined)
				if (made !== undefined) api.open(abs(n.path), made)
				return
			}
			const top = Array.isArray(change) && change.length === 1 && change[0].path.length === 0
			if (top && change[0].value !== undefined) {
				return void api.open(abs(n.path), change[0].value)
			}
		}
		api.edit(n as never, change as never)
	}
	const words = {
		open: api.open,
		read: api.read,
		peep: api.peep,
		reads: api.reads,
		list: api.list,
		edit,
		memo: api.memo,
		effect: api.effect,
		method: api.method,
		send: api.send,
		status: api.status,
		why: api.explain,
		teardown: api.teardown,
		show: extras.show,
	} as Record<string, (...args: never[]) => unknown>
	const open = scheduler.getCurrentScope()
	if (open !== undefined) {
		register(scheduler, open, words)
		if (open.parent !== undefined) register(scheduler, open.parent, words)
	}
	return { ...extras }
}
export default adapter
