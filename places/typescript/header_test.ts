// header.ts' frame: the frame open, shared; from outside the graph (no run open, no frame up the
// chain holding locations) a frame more on top with the stack there, or the location given
import { assert, assertEquals, assertStrictEquals } from "@std/assert"
import type { Location } from "@ermine/changeable/stacktrace"
import type { ChangeHeader } from "@ermine/graph/entry"
import { createScheduler } from "@ermine/reactivity"
import { createChangeHeader, isOutside, locationsOf, nearest } from "./header.ts"

const given: Location = { file: "program.js", line: 12, external: true }

Deno.test("header: from outside, a frame of locations on top of the frame open, every line of the stack; a location given, that one", () => {
	const s = createScheduler()
	const host = s.createRootScope({ actor: "host" })
	const [own, told] = s.runWithScope(host, () => [
		createChangeHeader(s), // the call's line
		createChangeHeader(s, { build: given }),
	])
	const text = Deno.readTextFileSync(new URL(import.meta.url)).split("\n")
	const line = text.findIndex((l) => l.endsWith("// the call's line")) + 1
	assertStrictEquals(own.frame.parent, host.frame)
	const at = own.frame.info.locations!
	assert(at.every((l) => l.external))
	assert(at.some((l) => l.file === import.meta.url && l.line === line))
	// ermine's own lines too: nothing skipped
	assertEquals(at[0].file.endsWith("stacktrace.ts"), true)
	assertEquals(told.frame.info, { locations: [given] })
	assertStrictEquals(told.frame.parent, host.frame)
})

Deno.test("header: inside, the frame open itself: in a run, or under a frame holding locations; nothing captured", () => {
	const s = createScheduler()
	const host = s.createRootScope({ actor: "host" })
	const made: ChangeHeader[] = []
	let inRun = false
	s.runWithScope(host, () =>
		s.createComputer(() => {
			inRun = !isOutside(s)
			made.push(createChangeHeader(s), createChangeHeader(s, { build: given }))
			return 1
		}, () => {}))
	s.pulse()
	assertEquals(inRun, true)
	assertEquals(made.map((h) => h.frame.info.locations), [undefined, undefined])
	assertEquals(made.map((h) => h.frame.parent !== undefined), [true, true])
	// under a scope started from outside: its locations are what the change came from
	const began = s.createScope({ locations: [given] }, host)
	const h = s.runWithScope(began, () => createChangeHeader(s))
	assertStrictEquals(h.frame, began.frame)
	assertEquals(locationsOf(h.frame), [given])
})

Deno.test("header: nearest looks up the frames and stops after the first holding the node key", () => {
	const s = createScheduler()
	const top = s.createRootScope({ run: 1, why: "top" })
	const node = s.createScope({ why: "node", node: "N" }, top)
	const click = s.createScope({ event: "click" }, node)
	assertEquals(nearest(click.frame, "event"), "click")
	assertEquals(nearest(click.frame, "why"), "node")
	assertEquals(nearest(click.frame, "node"), "N")
	assertEquals(nearest(click.frame, "run"), undefined)
	assertEquals(nearest(undefined, "why"), undefined)
})
