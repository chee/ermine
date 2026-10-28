// marks (marks-2026-10-27; marks are frames since 10-28: scope and frame): what the conformance
// scenarios can't say on the line protocol: the
// stand-in for navigator.userActivation is defined before @ermine/system loads (event_fixture.ts)
import { userActivation } from "./event_fixture.ts"
import { assert, assertEquals, assertThrows } from "@std/assert"
import { no, type Policy, yes } from "@ermine/core/protect"
import {
	addTeardown,
	createAction,
	createEffect,
	createMemo,
	createWriter,
	ensureNode,
	executeAction,
	explain,
	patch,
	read,
	start,
} from "@ermine/system"
import { createErmine, ErmineError } from "./ermine.ts"
import { hints } from "./hints.ts"
import { manual } from "./manual_fixture.ts"

const programAt = (e: { within: <T>(f: () => T) => T }, at: string) =>
	e.within(() => read(at)) as () => unknown

// a process whose setup is f, started at at
function started(f: () => unknown, features = [manual], may?: Policy) {
	const e = createErmine({ features, ...may && { may } })
	e.within(() => ensureNode("/code/p", f))
	const s = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in s))
	return { e, s }
}

Deno.test("marks: a writer is not data: JSON, a string, a template throw; a copy of its shape does nothing", () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const { e } = started(() => void (withWriter = createWriter()))
	assertThrows(() => JSON.stringify({ withWriter }), ErmineError, "not-a-value")
	assertThrows(() => `${withWriter as never}`, ErmineError, "not-a-value")
	// a function that merely looks like one is a plain function: it has no power of its own
	e.within(() => ensureNode("/k", 0))
	const copy = (f: () => unknown) => f()
	assertThrows(
		() => copy(() => patch("/k", [{ path: [], value: 1 }])),
		ErmineError,
		"nothing-open",
	)
	// the real one runs with nothing open
	withWriter!(() => patch("/k", [{ path: [], value: 2 }]))
	assertEquals(e.within(() => read("/k")), 2)
	e.close()
})

Deno.test("marks: a writer called after the ermine closed: closed", () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const { e } = started(() => void (withWriter = createWriter()))
	e.close()
	assertThrows(() => withWriter!(() => 1), ErmineError, "closed")
})

Deno.test("marks: createWriter in an action, the writer's changes carry the call's mark: explain says the action, getCaller who called", () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const e = createErmine({ features: [manual] })
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("/k", 0)
			createAction("on/go", () => void (withWriter = createWriter()))
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	e.within(() => executeAction("/code/p/on/go"))
	withWriter!(() => patch("/k", [{ path: [], value: 1 }]))
	const why = e.within(() => explain("/k"))
	assertEquals(why?.writer?.kind, "method")
	assertEquals((why?.writer as { path?: string[] }).path, ["code", "p", "on", "go"])
	e.close()
})

Deno.test("marks: each write through a writer has its own line, not createWriter's (sites are core)", () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const { e } = started(() => {
		ensureNode("/a", 0)
		ensureNode("/b", 0)
		withWriter = createWriter()
	})
	const here = () => Number(new Error().stack!.split("\n")[2].match(/:(\d+):\d+\)?$/)![1])
	let lines: number[] = []
	withWriter!(() => {
		lines = [here() + 1, here() + 2]
		patch("/a", [{ path: [], value: 1 }])
		patch("/b", [{ path: [], value: 1 }])
	})
	const at = (k: string) => e.within(() => explain(k))?.change?.site
	assertEquals([at("/a")?.line, at("/b")?.line], lines)
	assert(at("/a")?.file.endsWith("marks_test.ts"))
	e.close()
})

Deno.test("marks: a write through a writer in a timer has the program's own line as its site", async () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const { e } = started(() => {
		ensureNode("/t", 0)
		withWriter = createWriter()
	})
	let line = 0
	await new Promise<void>((done) =>
		setTimeout(() => {
			withWriter!(() => {
				line = new Error().stack!.split("\n")[1].match(/:(\d+):\d+\)?$/)!.map(Number)[1] + 1
				patch("/t", [{ path: [], value: 1 }])
			})
			done()
		}, 5)
	)
	const site = e.within(() => explain("/t"))?.change?.site
	assert(site?.file.endsWith("marks_test.ts"))
	assertEquals(site?.line, line)
	e.close()
})

Deno.test("marks: an action called from an act makes things for its own parent; the act itself makes nothing", () => {
	const e = createErmine({ features: [manual] })
	e.within(() =>
		ensureNode("/code/p", () => {
			ensureNode("/k", 0)
			createAction("on/make", () => void createMemo("made", () => 1))
			createEffect("e", () => read("/k"), () => {
				executeAction("on/make")
				assertThrows(() => createMemo("inner", () => 2), ErmineError, "in-act")
				assertThrows(() => addTeardown(() => {}), ErmineError, "return a cleanup")
			})
		})
	)
	const s = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in s))
	e.scheduler.pulse()
	assertEquals(e.within(() => read("/code/p/made")), 1)
	assertEquals(s.status()?.state, "done")
	e.close()
})

Deno.test("marks: with hints, the errors say where to make it instead", () => {
	const caught: unknown[] = []
	const { e } = started(() => {
		ensureNode("/k", 0)
		createEffect("e", () => read("/k"), () => {
			try {
				createMemo("x", () => 1)
			} catch (x) {
				caught.push(x)
			}
			try {
				addTeardown(() => {})
			} catch (x) {
				caught.push(x)
			}
			return 5 as never
		})
	}, [manual, hints])
	e.scheduler.pulse()
	const [memo, teardown] = caught as { message: string }[]
	assert(/hint: .*make the memo in setup, an action/.test(memo.message), memo.message)
	assert(/hint: .*return the cleanup from the act/.test(teardown.message), teardown.message)
	e.close()
})

Deno.test("marks: navigator.userActivation or its getter replaced after load gains a program nothing", () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const { e } = started(() => {
		ensureNode("/k", 0)
		withWriter = createWriter()
	})
	const changed = () => e.within(() => explain("/k"))?.change?.userActivated
	// a person just interacted
	userActivation.active = true
	withWriter!(() => patch("/k", [{ path: [], value: 1 }]))
	assertEquals(changed(), true)
	// nobody did; a program replaces navigator.userActivation and the getter after the module loaded
	userActivation.active = false
	const nav = globalThis.navigator
	const had = Object.getOwnPropertyDescriptor(nav, "userActivation")
	const proto = (globalThis as unknown as { UserActivation: { prototype: object } }).UserActivation
		.prototype
	const hadGetter = Object.getOwnPropertyDescriptor(proto, "isActive")
	Object.defineProperty(nav, "userActivation", { value: { isActive: true }, configurable: true })
	Object.defineProperty(proto, "isActive", { get: () => true, configurable: true })
	try {
		withWriter!(() => patch("/k", [{ path: [], value: 2 }]))
		assertEquals(changed(), undefined)
	} finally {
		Object.defineProperty(nav, "userActivation", had!)
		Object.defineProperty(proto, "isActive", hadGetter!)
		e.close()
	}
})

Deno.test("marks: start asks as the starter for the stop() too: whoever calls it, the policy sees the starter", () => {
	const whos: unknown[] = []
	let blocked = false
	const may: Policy = (ask) => {
		if (ask.op !== "place" || ask.target.path?.[0] !== "work") return yes
		whos.push((ask.who as { metadata?: { node?: unknown } })?.metadata?.node)
		return blocked ? no("denied") : yes
	}
	let stopIt: (() => void) | undefined
	let starter: unknown
	const e = createErmine({ features: [manual], may })
	e.within(() => ensureNode("/code/child", () => {}))
	e.within(() => ensureNode("/work", 0))
	e.within(() =>
		ensureNode("/code/p", () => {
			const out = start(programAt(e, "/code/child"), "/work/c")
			assert(!("refused" in out))
			stopIt = out.stop
		})
	)
	const p = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in p))
	starter = p.process.id
	assertEquals(whos.splice(0), [starter])
	// a stop() from the host (nothing open) is asked as p, not as the host
	blocked = true
	assertThrows(() => stopIt!(), Error, "refused")
	assertEquals(whos.splice(0), [starter])
	assertEquals(e.within(() => read("/work/c")) === undefined, true)
	blocked = false
	stopIt!()
	assertEquals(whos.splice(0), [starter])
	e.close()
})

Deno.test("marks: a writer made inside a writer while user-activated does not keep userActivated", () => {
	let outer: ReturnType<typeof createWriter> | undefined
	let inner: ReturnType<typeof createWriter> | undefined
	const { e } = started(() => {
		ensureNode("/k", 0)
		outer = createWriter()
	})
	userActivation.active = true
	try {
		outer!(() => void (inner = createWriter()))
	} finally {
		userActivation.active = false
	}
	inner!(() => patch("/k", [{ path: [], value: 5 }]))
	assertEquals(e.within(() => explain("/k"))?.change?.userActivated, undefined)
	e.close()
})

Deno.test("marks: a writer an action returned is hidden in the call record: explain shows a marker, never the function", () => {
	const e = createErmine({ features: [manual] })
	e.within(() => {
		ensureNode("/shared", 0)
		ensureNode("/code/p", () =>
			createAction("on/give", (x: unknown) => {
				patch("/shared", [{ path: [], value: 1 }])
				return { w: createWriter(), x }
			}))
	})
	e.start(programAt(e, "/code/p"), "/code/p")
	e.within(() => executeAction("/code/p/on/give", e.within(() => createWriter())))
	const call = (e.within(() => explain("/shared"))?.writer as {
		call?: { returned?: unknown; args: unknown[] }
	})
		.call
	assertEquals((call?.returned as { w: unknown }).w, "[writer]")
	assertEquals(call?.args, ["[writer]"])
	e.close()
})

Deno.test("marks: a generator action's record stays open to its end: a write after a yield explains as the call, in its writes", async () => {
	const e = createErmine({ features: [manual] })
	e.within(() => {
		ensureNode("/a", 0)
		ensureNode("/b", 0)
		ensureNode("/code/p", () =>
			createAction("on/go", function* () {
				patch("/a", [{ path: [], value: 1 }])
				yield Promise.resolve()
				patch("/b", [{ path: [], value: 1 }])
			}))
	})
	e.start(programAt(e, "/code/p"), "/code/p")
	await (e.within(() => executeAction("/code/p/on/go")) as Promise<unknown>)
	for (const k of ["/a", "/b"]) {
		const w = e.within(() => explain(k))?.writer as { kind: string; call?: { writes: unknown[] } }
		assertEquals(w.kind, "method")
		assertEquals(w.call?.writes.length, 2)
	}
	e.close()
})

Deno.test("marks: a write through a writer made in an action explains as the call, though the closed record does not list it", () => {
	let withWriter: ReturnType<typeof createWriter> | undefined
	const e = createErmine({ features: [manual] })
	e.within(() => {
		ensureNode("/k", 0)
		ensureNode("/code/p", () => createAction("on/go", () => void (withWriter = createWriter())))
	})
	e.start(programAt(e, "/code/p"), "/code/p")
	e.within(() => executeAction("/code/p/on/go"))
	withWriter!(() => patch("/k", [{ path: [], value: 1 }]))
	const w = e.within(() => explain("/k"))?.writer as { kind: string; call?: { writes: unknown[] } }
	assertEquals(w.kind, "method")
	assertEquals(w.call?.writes, [])
	e.close()
})

Deno.test("marks: a generator action whose process stops mid-yield is returned (finally runs) and its promise rejects gone", async () => {
	const log: string[] = []
	let open!: () => void
	const gate = new Promise<void>((r) => (open = r))
	const e = createErmine({ features: [manual] })
	e.within(() => {
		ensureNode("/k", 0)
		ensureNode("/code/p", () =>
			createAction("on/go", function* () {
				try {
					yield gate
					patch("/k", [{ path: [], value: 1 }])
					log.push("wrote after stop")
				} finally {
					log.push("finally")
					try {
						patch("/k", [{ path: [], value: 2 }])
					} catch (x) {
						log.push((x as ErmineError).code)
					}
				}
			}))
	})
	const p = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in p))
	const out = e.within(() => executeAction("/code/p/on/go")) as Promise<unknown>
	const settled = out.then(() => "resolved", (x) => (x as ErmineError).code)
	p.stop("bye")
	open()
	assertEquals(await settled, "gone")
	assertEquals(log, ["finally", "nothing-open"])
	assertEquals(e.within(() => read("/k")), 0)
	e.close()
})

Deno.test("marks: start taken gives a program only where (refused, at), never whose it is", () => {
	let out: unknown
	const e = createErmine({ features: [manual] })
	e.within(() => ensureNode("/code/child", () => {}))
	e.within(() =>
		ensureNode("/code/p", () => {
			start(programAt(e, "/code/child"), "/work/c")
			out = start(programAt(e, "/code/child"), "/work/c")
		})
	)
	e.start(programAt(e, "/code/p"), "/code/p")
	assertEquals(out, { refused: "taken", at: ["work", "c"] })
	e.close()
})

Deno.test("marks: a program started by a program stops when the ermine closes", () => {
	const told: string[] = []
	const e = createErmine({ features: [manual] })
	e.within(() => ensureNode("/code/child", () => addTeardown((why) => told.push(why))))
	e.within(() => ensureNode("/code/p", () => void start(programAt(e, "/code/child"), "/work/c")))
	e.start(programAt(e, "/code/p"), "/code/p")
	e.close()
	assertEquals(told, ["ended"])
})

Deno.test("marks: addTeardown in an action throws not-here, with a hint; in setup it is told as ever", () => {
	const told: unknown[] = []
	const e = createErmine({ features: [manual, hints] })
	e.within(() =>
		ensureNode("/code/p", () => {
			addTeardown((why) => told.push(why))
			createAction("/act", () => addTeardown(() => told.push("action")))
			createAction("/gen", function* () {
				yield 1
				addTeardown(() => told.push("gen"))
			})
		})
	)
	const s = e.start(programAt(e, "/code/p"), "/code/p")
	assert(!("refused" in s))
	const msg = (f: () => unknown) => {
		try {
			f()
		} catch (x) {
			return (x as Error).message
		}
		return ""
	}
	const m = msg(() => e.within(() => executeAction("/act")))
	assert(/not-here/.test(m) && /addTeardown in an action/.test(m), m)
	assert(/hint: .*add it in setup/.test(m), m)
	s.stop("bye")
	assertEquals(told, ["bye"])
	e.close()
})

Deno.test("marks: createAction given an async function* throws not-a-function, saying to use a function*", () => {
	const e = createErmine({ features: [manual] })
	assertThrows(
		() => e.within(() => createAction("/a", async function* () {})),
		ErmineError,
		"use a function* that yields promises",
	)
	e.close()
})
