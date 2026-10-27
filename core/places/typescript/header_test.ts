// header.ts' site: the one given; none given, outside a run the call's own, in a run none
import { assertEquals } from "@std/assert"
import type { ChangeHeader } from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import { createChangeHeader } from "./header.ts"

const given = { file: "program.js", line: 12 }

Deno.test("header: outside a run, the call's own site; a site given, that one", () => {
	const s = createScheduler()
	const host = s.createRootScope({ actor: "host" })
	const [own, told] = s.runWithScope(host, () => [
		createChangeHeader(s), // the call's line
		createChangeHeader(s, undefined, undefined, undefined, given),
	])
	const text = Deno.readTextFileSync(new URL(import.meta.url)).split("\n")
	const line = text.findIndex((l) => l.endsWith("// the call's line")) + 1
	assertEquals(own.external?.map((x) => [x.file, x.line]), [[import.meta.url, line]])
	assertEquals(told.external, [given])
})

Deno.test("header: in a run, no capture: none, each write; a site given, that one", () => {
	const s = createScheduler()
	const host = s.createRootScope({ actor: "host" })
	const made: ChangeHeader[] = []
	s.runWithScope(host, () =>
		s.createComputer(() => {
			made.push(createChangeHeader(s), createChangeHeader(s))
			made.push(createChangeHeader(s, undefined, undefined, undefined, given))
			return 1
		}, () => {}))
	s.pulse()
	assertEquals(made.map((h) => h.external), [undefined, undefined, [given]])
})

Deno.test("header: whole trace, from not on the stack: falls back to the call's own site", () => {
	const s = createScheduler()
	const host = s.createRootScope({ actor: "host" })
	const h = s.runWithScope(
		host,
		() =>
			createChangeHeader(s, undefined, undefined, function notOnTheStack() {}, undefined, true), // the fallback's line
	)
	const text = Deno.readTextFileSync(new URL(import.meta.url)).split("\n")
	const line = text.findIndex((l) => l.endsWith("// the fallback's line")) + 1
	assertEquals(h.external?.map((x) => [x.file, x.line]), [[import.meta.url, line]])
})
