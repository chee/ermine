// "ermine", the module design L's programs import their words from: `import { open, read } from
// "ermine"`, in any file (run.ts maps the specifier here, lib/importmap.ts). the words are made
// once, for the whole realm; none belongs to a process. each, as it is called, works out its
// process from the scope open now: the registry maps a process's scope to its real words (the
// adapter's, designs/l/adapter.ts), and a word walks up from the scope open, through its parents,
// to the first one registered. that is how Solid's createSignal, a plain import, finds its owner
// through getOwner().
//   open   a setup (its scope under the process's), a memo's or effect's run or act (a computer
//          under the scope that made it), a handler's call (a scope under the one that placed it),
//          a teardown, a component (lib/jsx.ts: a scope under the one open): all reach the process
//   none   a module's top level, a timer, a listener, a promise's then, after an await: nothing
//          is open, and the word throws NothingOpen
// here() is L's one word beyond A's: the scope open now, kept, to run code in it later
// (`const back = here(); await x; back(() => edit(…))`), as Solid's getOwner and runWithOwner.
// the scope gone (a call that ended, a run replaced): it throws Gone
import type { Scheduler, Scope } from "@ermine/core/scheduler"
export { PENDING } from "@ermine/core/scheduler"
import { TrialError } from "../../lib/contexts.ts"

type Words = Record<string, (...args: never[]) => unknown>

// a process's scope → its words; and every scheduler a process was registered on (one per trial)
const processes = new WeakMap<Scope, Words>()
const schedulers = new Set<Scheduler>()

export function register(s: Scheduler, scope: Scope, words: Words) {
	schedulers.add(s)
	processes.set(scope, words)
}

// the scope open now and the process it is in; none: NothingOpen, naming the word
function find(word: string): { s: Scheduler; scope: Scope; words: Words } {
	// no process ever registered: the design running isn't L
	if (schedulers.size === 0) {
		throw new TrialError(
			"NoModule",
			`"ermine" has words only for design L: ${word} was imported by a program of another design`,
		)
	}
	let opened = false
	for (const s of schedulers) {
		const scope = s.getCurrentScope()
		if (scope === undefined) continue
		opened = true
		for (let o: Scope | undefined = scope; o !== undefined; o = o.parent) {
			const words = processes.get(o)
			if (words !== undefined) return { s, scope, words }
		}
	}
	throw new TrialError(
		"NothingOpen",
		opened
			? `nothing is open here: ${word} was called in a scope that is no process's`
			: `nothing is open here: ${word} was called while ermine was running none of the program's code (a module's top level, a timer, a listener, or after an await)`,
	)
}

const word = (name: string) => (...args: never[]) => {
	const { words } = find(name)
	return words[name](...args)
}

export const open = word("open")
export const read = word("read")
export const peep = word("peep")
export const reads = word("reads")
export const list = word("list")
export const edit = word("edit")
export const memo = word("memo")
export const effect = word("effect")
export const method = word("method")
export const send = word("send")
export const status = word("status")
export const why = word("why")
export const teardown = word("teardown")
export const show = word("show")

// the scope open now, kept: back(f) runs f in it (its words find the same process, its writes are
// its: a call's while the call goes on)
export function here() {
	const { s, scope } = find("here")
	return <T>(f: () => T): T => {
		if (scope.state !== "alive") {
			throw new TrialError(
				"Gone",
				"what here() kept is gone (a call that ended, a run replaced): keep it where it lasts as long as you need it, as in the program's function",
			)
		}
		return s.runWithScope(scope, f)
	}
}
