// the imported words' registry (found.ts): which schedulers to look in, and which scope finds which
// words. module state, never on a global, and not in the package's exports: only createErmine
// registers (ermine.ts). one copy through the import map is what makes the words find their
// processes (module identity); a second copy of found.ts still shares this file
import type { Scheduler, Scope } from "@ermine/core/scheduler"
import type { API } from "./words.ts"
import { ErmineError } from "./features.ts"

// each scheduler, and how many ermines registered it
const schedulers = new Map<Scheduler, number>()
// a scope words are found by → those words
const scopes = new WeakMap<Scope, API>()

// a scope found to its words, from here on (kept while the scope is)
export function registerScope(scope: Scope, words: API) {
	scopes.set(scope, words)
}

// s looked in, from here on (an ermine made); gives its letting go (the ermine closed)
export function registerScheduler(s: Scheduler): () => void {
	schedulers.set(s, (schedulers.get(s) ?? 0) + 1)
	let gone = false
	return () => {
		if (gone) return
		gone = true
		const n = (schedulers.get(s) ?? 1) - 1
		if (n <= 0) schedulers.delete(s)
		else schedulers.set(s, n)
	}
}

// the words scope (or one above it) is found by; none: undefined
function wordsAt(scope: Scope | undefined): API | undefined {
	for (let o = scope; o !== undefined; o = o.parent) {
		const words = scopes.get(o)
		if (words !== undefined) return words
	}
	return undefined
}

// each ermine's way to a handle's maker (its words, and its scope opened): a handle used with
// nothing open (a DOM listener, a timer) acts as its maker, as a Solid setter writes its signal from
// anywhere [chee 10-25: "yes, i think that's rigjt?"]
type Maker = { readonly words: API; readonly within: <T>(f: () => T) => T }
const makers = new Set<(x: unknown) => Maker | undefined>()
export function registerMakers(look: (x: unknown) => Maker | undefined): () => void {
	makers.add(look)
	return () => void makers.delete(look)
}
// each maker's words, every call made with its scope opened (one set per maker)
const opened = new WeakMap<API, API>()
function openedFor(m: Maker): API {
	let o = opened.get(m.words)
	if (o === undefined) {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(m.words)) {
			out[k] = typeof v === "function"
				? (...a: unknown[]) => m.within(() => (v as (...a: unknown[]) => unknown)(...a))
				: v
		}
		o = out as API
		opened.set(m.words, o)
	}
	return o
}

// the words for word on x: the scope open now's; nothing open and x a handle: its maker's, its
// scope opened; else nothing-open
export function foundFor(word: string, x: unknown): API {
	if (x !== null && typeof x === "object") {
		let open = false
		for (const s of schedulers.keys()) if (s.getCurrentScope() !== undefined) open = true
		if (!open) {
			for (const look of makers) {
				const m = look(x)
				if (m !== undefined) return openedFor(m)
			}
		}
	}
	return found(word)
}

// the words the scope open now is in; none: nothing-open, naming the word. of several schedulers,
// the first with a scope open whose walk finds some
export function found(word: string): API {
	for (const s of schedulers.keys()) {
		const words = wordsAt(s.getCurrentScope())
		if (words !== undefined) return words
	}
	throw new ErmineError(
		"nothing-open",
		`${word}: nothing is open here (a module's top level, a timer, a listener, or after an ` +
			`await): call it from a setup, a memo, an effect or an action`,
	)
}
