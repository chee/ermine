// the program on the board, all of it: a store, a pond computer, and one child computer per fish
import type { Computer, Scheduler } from "@ermine/core/scheduler"

export function program(s: Scheduler, bubble: (name: string, run: number) => void) {
	// the store: key → value. a read tracks the key; a write sets it and marks it
	const store = new Map<string, unknown>([
		["names", ["goldie", "bubbles", "finn"]],
		["hungry", false],
	])
	const read = (key: string) => (s.track(key), store.get(key))
	const write = (key: string, value: unknown) => (store.set(key, value), s.mark([key]))

	// pond's children by name: how a run finds the child an earlier run made
	const fish = new Map<string, Computer>()
	const claiming = { on: true }

	// a fish: full or hungry. each run leaves a cleanup, which blows a bubble
	function child(name: string): Computer {
		return s.createComputer(
			() => {
				const me = s.getCurrentScope()!
				const run = me.info.run!
				s.registerTeardown(me, () => bubble(name, run))
				return read("hungry") ? "hungry" : "full"
			},
			(mood) => write(`mood/${name}`, mood),
			undefined,
			undefined,
			{ name },
		)
	}

	// pond's run: one child per name. an old child of that name is claimed, kept; else one is made
	function pond(): number {
		const names = read("names") as string[]
		for (const name of names) {
			const old = fish.get(name)
			if (claiming.on && old && s.claim(old)) continue
			fish.set(name, child(name))
		}
		return names.length
	}

	const root = s.createRootScope({ name: "page" })
	const info = { name: "pond" }
	const makePond = () =>
		s.runWithScope(
			root,
			() => s.createComputer(pond, (n) => write("count", n), undefined, undefined, info),
		)
	return { store, write, root, makePond, claiming }
}
