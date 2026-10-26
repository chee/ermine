import { assert, assertEquals } from "@std/assert"
import { createScheduler, type Scope } from "@ermine/core/scheduler"
import { createSites } from "./sites.ts"
import { INFO, make } from "./sites_fixture.ts"

const base = (f?: string) => f?.split("/").pop()

Deno.test("a computer made in a program file reports that file and line", () => {
	const scheduler = createScheduler()
	const sited = createSites(scheduler)
	const root = sited.createRootScope(INFO)
	const c = scheduler.runWithScope(root, () => sited.createComputer(() => 1, () => {})) // here
	const site = sited.siteOf(c)!
	assertEquals(base(site.file), "sites_test.ts")
	const text = Deno.readTextFileSync(new URL(import.meta.url))
	assertEquals(site.line, text.split("\n").findIndex((l) => l.endsWith("// here")) + 1)
})

Deno.test("an effect and a scope report their sites too", () => {
	const scheduler = createScheduler()
	const sited = createSites(scheduler)
	const root = sited.createRootScope(INFO)
	const e = scheduler.runWithScope(
		root,
		() => sited.createEffect(() => 1, () => {}),
	)
	assertEquals(base(sited.siteOf(e)?.file), "sites_test.ts")
	assertEquals(base(sited.siteOf(root)?.file), "sites_test.ts")
	assertEquals(typeof sited.siteOf(e)?.line, "number")
})

Deno.test("a scope in a scope gives a chain of two", () => {
	const scheduler = createScheduler()
	const sited = createSites(scheduler)
	const outer = sited.createRootScope(INFO)
	const inner = sited.createScope(INFO, outer)
	const chain = sited.sitesOf(inner)
	assertEquals(chain.length, 2)
	assertEquals(chain[0], sited.siteOf(inner))
	assertEquals(chain[1], sited.siteOf(outer))
	assert(chain[0].line > chain[1].line)
})

Deno.test("a computer made without the wrapper has none, its wrapped parent's site shows", () => {
	const scheduler = createScheduler()
	const sited = createSites(scheduler)
	const parent = sited.createRootScope(INFO)
	const c = scheduler.runWithScope(
		parent,
		() => scheduler.createComputer(() => 1, () => {}),
	)
	assertEquals(sited.siteOf(c), undefined)
	assertEquals(sited.sitesOf(c), [sited.siteOf(parent)!])
	// and a wrapped one under an unwrapped one: the chain skips the gap
	const bare = scheduler.createScope(INFO, parent)
	const leaf = sited.createScope(INFO, bare)
	assertEquals(sited.sitesOf(leaf).length, 2)
})

Deno.test("ours skips library frames", () => {
	const scheduler = createScheduler()
	const plain = createSites(scheduler)
	const root = plain.createRootScope(INFO)
	// made through a library file: without ours, the library is the site
	const viaLibrary = make(plain, root)
	assertEquals(base(plain.siteOf(viaLibrary)?.file), "sites_fixture.ts")
	// with it in ours, the caller of the library is
	const skipping = createSites(scheduler, {
		ours: [new URL("./sites_fixture.ts", import.meta.url).href],
	})
	const viaSkipped = make(skipping, root)
	assertEquals(base(skipping.siteOf(viaSkipped)?.file), "sites_test.ts")
})

Deno.test("the WeakMap lets a torn-down scope go", async () => {
	const scheduler = createScheduler()
	const sited = createSites(scheduler)
	const root = sited.createRootScope(INFO)
	let died = 0
	const registry = new FinalizationRegistry(() => died++)
	;(() => {
		const s = sited.createScope(INFO, root)
		const c = scheduler.runWithScope(s, () => sited.createComputer(() => 1, () => {}))
		sited.siteOf(c)
		registry.register(c, 1)
		registry.register(s, 2)
		scheduler.teardown(s)
	})()
	for (let i = 0; i < 50 && died < 2; i++) {
		const junk: unknown[] = []
		for (let j = 0; j < 500; j++) junk.push(new Array(1000).fill(j))
		await new Promise((r) => setTimeout(r, 5))
	}
	assertEquals(died, 2, "the scope or its computer was kept")
})
