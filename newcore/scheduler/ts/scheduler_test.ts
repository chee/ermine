import { assert, assertEquals, assertThrows } from "@std/assert"
import createNode from "../../nodes/ts/node.ts"
import { rules as protectRules } from "../../protect/ts/protect.ts"
import { type Api, createScheduler, type Moment, PENDING, SchedulerError } from "./scheduler.ts"

function host(o: { id?: (t: number) => string } = {}) {
	const moments: Moment[] = []
	const s = createScheduler({ root: "root", hooks: [(m) => moments.push(m)], ...o })
	return { s, moments }
}

// a node holding value, placed in the root under name; its id
function put(s: Api, name: string, value: unknown) {
	const id = s.create(value, { id: name })
	s.insert("root", name, id)
	return id
}

// the value of what the address reaches: its versions, past a status in front
function value(s: Api, address: string[]) {
	const it = s.content(address).find((i) => i.versions)
	const vs = it?.versions ?? []
	const v = vs.find((v) => !(v.because as { why?: unknown; place?: unknown } | undefined)?.place)
	return v?.content
}
function status(s: Api, address: string[]) {
	const it = s.content(address).find((i) => i.versions)
	const v = it?.versions?.[0]
	return (v?.because as { place?: string } | undefined)?.place === "status" ? v!.content : {}
}

const code = (e: unknown) => (e instanceof SchedulerError ? e.code : (e as { code?: string }).code)

// deno-lint-ignore no-explicit-any
type Given = any

Deno.test("pids are @ and the time; a taken one is passed", () => {
	const { s } = host()
	const p = s.start({ address: [], program: () => 1 })
	assertEquals(p.id, "@1")
	const t = host()
	put(t.s, "@3", null)
	const q = t.s.start({ address: [], program: () => 1 })
	assertEquals(q.id, "@3-1")
	assertEquals(value(t.s, [q.id]), 1)
})

Deno.test("a setup runs once, untracked; its value is the process's; the hooks see it", () => {
	const { s, moments } = host()
	put(s, "a", 1)
	let calls = 0
	const p = s.start({
		address: [],
		program: ({ api }: Given) => {
			calls++
			return { a: api.content(["a"])[0].versions[0].content }
		},
	})
	assertEquals(value(s, [p.id]), { a: 1 })
	s.write(["a"], [{ path: [], value: 2 }])
	assertEquals(calls, 1)
	const kinds = moments.filter((m) => !("reads" in m)).map((m) => Object.keys(m)[0])
	assertEquals(kinds, ["due", "starts", "ends"])
	const read = moments.find((m) => "reads" in m) as { tracked: boolean; op: string }
	assertEquals([read.op, read.tracked], ["content", false])
})

Deno.test("a compute runs again when what it read changes, given by; a peep marks nothing", () => {
	const { s } = host()
	put(s, "a", 1)
	put(s, "b", 10)
	const given: number[][] = []
	const p = s.start({
		address: [],
		program: {
			compute: ({ api, peep, by }: Given) => {
				given.push(by.map((b: { time: number }) => b.time))
				const a = api.content(["a"])[0].versions[0].content
				const b = peep.content(["b"])[0].versions[0].content
				return a + b
			},
		},
	})
	assertEquals(value(s, [p.id]), 11)
	s.write(["b"], [{ path: [], value: 20 }])
	assertEquals(value(s, [p.id]), 11)
	const w = s.write(["a"], [{ path: [], value: 2 }])
	assertEquals(value(s, [p.id]), 22)
	assertEquals(given.length, 2)
	assertEquals(given[1], [w.time])
})

Deno.test("a compute reading an info or a list runs again when it changes", () => {
	const { s } = host()
	const a = put(s, "a", null)
	let runs = 0
	s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => {
				runs++
				api.info(["a"], "theme")
				return api.children(["a"], "kids").length
			},
		},
	})
	assertEquals(runs, 1)
	s.set(["a"], "theme", [{ path: [], value: "dark" }])
	assertEquals(runs, 2)
	const b = s.create(1)
	s.insert(a, "kids", b)
	assertEquals(runs, 3)
	s.insert(a, "other", b)
	assertEquals(runs, 3)
})

Deno.test("a compute only reads: its writes are refused, the run failed, the error its status", () => {
	const { s } = host()
	put(s, "a", 1)
	const p = s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => {
				api.write(["a"], [{ path: [], value: 2 }])
				return 1
			},
		},
	})
	assertEquals(value(s, ["a"]), 1)
	assertEquals((status(s, [p.id]) as { error: { code: string } }).error.code, "read-only")
})

Deno.test("pending: written in front of the value, gone when the value is current", () => {
	const { s } = host()
	const flag = put(s, "flag", false)
	const p = s.start({
		address: [],
		program: {
			compute: ({ api, pending }: Given) =>
				api.content(["flag"])[0].versions[0].content ? "ready" : pending,
		},
	})
	assert("pending" in (status(s, [p.id]) as object))
	assertEquals(value(s, [p.id]), null)
	s.write(["flag"], [{ path: [], value: true }])
	assertEquals(status(s, [p.id]), {})
	assertEquals(value(s, [p.id]), "ready")
	assert(flag)
})

Deno.test("an effect acts on a new value; cleanups before the next, newest first, and at the kill", () => {
	const { s } = host()
	put(s, "a", 1)
	const log: string[] = []
	const p = s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => api.content(["a"])[0].versions[0].content,
			effect: ({ value, previous, onCleanup }: Given) => {
				log.push(`effect ${value} ${previous}`)
				onCleanup(({ killed }: Given) => log.push(`first ${value} ${killed}`))
				onCleanup(({ killed }: Given) => log.push(`second ${value} ${killed}`))
			},
		},
	})
	s.write(["a"], [{ path: [], value: 1 }])
	s.write(["a"], [{ path: [], value: 2 }])
	s.outro(p.id)
	assertEquals(log, [
		"effect 1 undefined",
		"second 1 false",
		"first 1 false",
		"effect 2 1",
		"second 2 true",
		"first 2 true",
	])
})

Deno.test("an effect's changes say why it ran", () => {
	const { s } = host()
	put(s, "a", 1)
	const out = put(s, "out", null)
	s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => [api.content(["a"])[0].versions[0].content],
			effect: ({ api, value }: Given) => void api.write(["out"], [{ path: [], value }]),
		},
	})
	const cause = () => s.get(out)!.value[0].change.cause
	assertEquals(cause(), "a first value")
	s.write(["a"], [{ path: [], value: 2 }])
	assertEquals(cause(), "a new list")
})

Deno.test("an interface stops when its part returns; call lasts until the kill", () => {
	const { s } = host()
	let kept: Given
	const p = s.start({
		address: [],
		program: ({ api, call, self }: Given) => {
			kept = { api, call }
			const on = api.create(null, { ephemeral: true })
			api.insert(self, "on", on)
			const h = api.create(({ args }: Given) => args * 2, { ephemeral: true })
			api.insert(on, "double", h)
			return 0
		},
	})
	assertThrows(() => kept.api.look([]), SchedulerError, "stopped")
	assertEquals(kept.call([p.id, "on", "double"], 4), 8)
	s.outro(p.id)
	assertThrows(() => kept.call([p.id, "on", "double"], 4), SchedulerError)
})

Deno.test("a handler call acts as its caller, with a step naming the definer, and runs what it marked", () => {
	const { s } = host()
	put(s, "count", 0)
	const p = s.start({
		address: [],
		program: ({ api, self }: Given) => {
			const on = api.create(null, { ephemeral: true })
			api.insert(self, "on", on)
			const h = api.create(({ api }: Given) => {
				const n = api.content(["count"])[0].versions[0].content
				api.write(["count"], [{ path: [], value: n + 1 }])
			}, { ephemeral: true })
			api.insert(on, "increment", h)
			return null
		},
	})
	const doubled = s.start({
		address: [],
		program: { compute: ({ api }: Given) => api.content(["count"])[0].versions[0].content * 2 },
	})
	s.call({ address: [p.id, "on", "increment"], actor: "me", person: "chee", trusted: true })
	assertEquals(value(s, ["count"]), 1)
	assertEquals(value(s, [doubled.id]), 2)
	const actor = s.get("count")!.value[0].change.actor as Given
	assertEquals(actor.actor, "me")
	assertEquals(actor.person, "chee")
	assertEquals(actor.code[actor.code.length - 1], { process: p.id, handler: "increment" })
	assertThrows(() => s.call({ address: ["count"] }), SchedulerError, "not-a-handler")
})

Deno.test("a kill unwinds: children first, then cleanups, then the nodes it made", () => {
	const { s } = host()
	const log: string[] = []
	let made = ""
	let child = ""
	const p = s.start({
		address: [],
		program: ({ api, start, self, onCleanup }: Given) => {
			made = api.create(1, { ephemeral: true })
			api.insert(self, "made", made)
			child = start({
				address: [],
				name: "kid",
				program: ({ onCleanup }: Given) => {
					onCleanup(() => log.push("kid"))
					return 0
				},
			}).id
			onCleanup(() => log.push("parent"))
			return 0
		},
	})
	assert(s.get(made) && s.get(child))
	s.outro(p.id)
	assertEquals(log, ["kid", "parent"])
	assertEquals([s.get(made), s.get(child)], [undefined, undefined])
})

Deno.test("only a process makes or places an ephemeral node", () => {
	const { s } = host()
	assertThrows(() => s.create(1, { ephemeral: true }), SchedulerError, "not-a-process")
	let made = ""
	s.start({
		address: [],
		program: ({ api }: Given) => {
			made = api.create(1, { ephemeral: true })
			return 0
		},
	})
	assert(s.ephemeral(made))
	assertThrows(() => s.insert("root", "x", made), SchedulerError, "not-a-process")
})

Deno.test("replace runs a setup again, as replaced, its children matched by name", () => {
	const { s } = host()
	let runs = 0
	const kids: string[] = []
	const p = s.start({
		address: [],
		name: "p",
		program: ({ start }: Given) => {
			runs++
			kids.push(start({ address: [], name: "k", program: () => 1 }).id)
			return runs
		},
	})
	s.replace({ address: ["p"] })
	assertEquals(runs, 2)
	assertEquals(kids[0], kids[1])
	assertEquals(value(s, ["p"]), 2)
	assert(p)
})

Deno.test("a batch runs what its operations marked once, after the last", () => {
	const { s } = host()
	put(s, "x", 1)
	put(s, "y", 1)
	let runs = 0
	s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => {
				runs++
				return api.content(["x"])[0].versions[0].content +
					api.content(["y"])[0].versions[0].content
			},
		},
	})
	s.batch(() => {
		s.write(["x"], [{ path: [], value: 2 }])
		s.write(["y"], [{ path: [], value: 2 }])
	})
	assertEquals(runs, 2)
})

Deno.test("readers run after what they read: c read b, b read a; a and c due: a, b, c", () => {
	const { s, moments } = host()
	put(s, "src", 1)
	const order: string[] = []
	const a = s.start({
		address: [],
		name: "a",
		program: {
			compute: (
				{ api }: Given,
			) => (order.push("a"), api.content(["src"])[0].versions[0].content),
		},
	})
	const b = s.start({
		address: [],
		name: "b",
		program: {
			compute: ({ api }: Given) => (order.push("b"), value(api, ["a"]) as number + 1),
		},
	})
	put(s, "other", 0)
	const c = s.start({
		address: [],
		name: "c",
		program: {
			compute: ({ api }: Given) => (
				order.push("c"),
					(value(api, ["b"]) as number) +
					(api.content(["other"])[0].versions[0].content as number)
			),
		},
	})
	order.length = 0
	moments.length = 0
	s.batch(() => {
		s.write(["other"], [{ path: [], value: 1 }])
		s.write(["src"], [{ path: [], value: 2 }])
	})
	assertEquals(order, ["a", "b", "c"])
	assertEquals(value(s, ["c"]), 4)
	assert(c)
	assert(a && b)
})

Deno.test("a compute reading a due process's node is stopped, and runs again after it", () => {
	const { s } = host()
	put(s, "src", 1)
	const order: string[] = []
	// b started first, reading a, which is started after it: b's first run reads a due a
	s.start({
		address: [],
		name: "b",
		program: {
			compute: ({ api }: Given) => {
				order.push("b")
				const v = value(api, ["a"])
				return v === undefined ? null : (v as number) * 10
			},
		},
	})
	s.batch(() => {
		s.start({
			address: [],
			name: "a",
			program: {
				compute: (
					{ api }: Given,
				) => (order.push("a"), api.content(["src"])[0].versions[0].content),
			},
		})
	})
	order.length = 0
	s.write(["src"], [{ path: [], value: 3 }])
	assertEquals(order, ["a", "b"])
	assertEquals(value(s, ["b"]), 30)
})

Deno.test("an outro marks what looked at the node", () => {
	const { s } = host()
	const a = put(s, "a", 1)
	let runs = 0
	s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => (runs++, api.look(["a"]).filter((i: Given) => i.node).length),
		},
	})
	assertEquals(runs, 1)
	s.outro(a)
	assertEquals(runs, 2)
})

Deno.test("an async compute is pending until it settles", async () => {
	const { s } = host()
	let resolve!: (v: number) => void
	const p = s.start({
		address: [],
		program: { compute: () => new Promise<number>((r) => (resolve = r)) },
	})
	assert("pending" in (status(s, [p.id]) as object))
	resolve(5)
	await Promise.resolve()
	await Promise.resolve()
	assertEquals(value(s, [p.id]), 5)
	assertEquals(status(s, [p.id]), {})
	assert(PENDING)
	assert(code)
})

// protect

function guarded(rules: unknown[]) {
	const s = createScheduler({ root: "root", may: protectRules("rules") })
	const change = { time: 0, actor: "host" } as never
	s.intro(createNode("rules", { value: [{ content: [], change }] }))
	s.insert("root", "rules", "rules")
	s.write(["rules"], [{ path: [], value: rules }])
	return s
}

Deno.test("protect: a write the rules refuse throws refused, with protect's why; nothing changes", () => {
	const s = guarded([{ actor: "host", op: "write", node: "a", allow: false }])
	put(s, "a", 1)
	const e = assertThrows(() => s.write(["a"], [{ path: [], value: 2 }]), SchedulerError)
	assertEquals([e.code, e.why], ["refused", { code: "rule", rule: 0 }])
	assertEquals(value(s, ["a"]), 1)
})

Deno.test("protect: a step not passed gives a refused item, no node", () => {
	const s = guarded([{ op: "pass", name: "secret", allow: false }])
	put(s, "secret", 1)
	const [it] = s.look(["secret"]) as Given[]
	assertEquals([it.id, it.node, it.refused], ["secret", undefined, { code: "rule", rule: 0 }])
})

Deno.test("protect: a compute's policy reads are tracked: new rules run it again", () => {
	const s = guarded([{ op: "read", node: "a", process: "@6", allow: false }])
	put(s, "a", 1)
	const p = s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => api.content(["a"])[0].versions?.[0].content ?? "refused",
		},
	})
	assertEquals(value(s, [p.id]), "refused")
	assertEquals(p.id, "@6")
	s.write(["rules"], [{ path: [], value: [] }])
	assertEquals(value(s, [p.id]), 1)
})

Deno.test("protect: a process's write is asked as the process; refused, its run fails", () => {
	const s = guarded([{ op: "write", node: "out", process: "@6", allow: false }])
	put(s, "out", 0)
	const p = s.start({
		address: [],
		program: ({ api }: Given) => {
			api.write(["out"], [{ path: [], value: 1 }])
			return 1
		},
	})
	assertEquals(p.id, "@6")
	assertEquals(value(s, ["out"]), 0)
	assertEquals((status(s, [p.id]) as Given).error.code, "refused")
})

Deno.test("protect: start asks to place the process", () => {
	const s = guarded([{ op: "place", node: "root", allow: false }])
	assertThrows(() => s.start({ address: [], program: () => 1 }), SchedulerError, "refused")
})

// found by the audit of 10-11

const tick = async (n = 4) => {
	for (let i = 0; i < n; i++) await Promise.resolve()
}

Deno.test("audit: an async compute's effect runs once its promise settles", async () => {
	const { s } = host()
	const log: string[] = []
	let resolve!: (v: number) => void
	const p = s.start({
		address: [],
		program: {
			compute: () => new Promise<number>((r) => (resolve = r)),
			effect: ({ value }: Given) => void log.push(`effect ${value}`),
		},
	})
	resolve(5)
	await tick()
	assertEquals(value(s, [p.id]), 5)
	assertEquals(log, ["effect 5"])
})

Deno.test("audit: an async compute marked again runs its effect each time", async () => {
	const { s } = host()
	put(s, "a", 1)
	const log: string[] = []
	s.start({
		address: [],
		program: {
			compute: ({ api }: Given) => Promise.resolve(api.content(["a"])[0].versions[0].content),
			effect: ({ value }: Given) => void log.push(`effect ${value}`),
		},
	})
	await tick()
	s.write(["a"], [{ path: [], value: 2 }])
	await tick()
	assertEquals(log, ["effect 1", "effect 2"])
})

Deno.test("audit: a promise settling to pending leaves the run pending; the symbol is no value", async () => {
	const { s } = host()
	const p = s.start({ address: [], program: { compute: () => Promise.resolve(PENDING) } })
	await tick()
	assert("pending" in (status(s, [p.id]) as object))
	assert(value(s, [p.id]) !== PENDING)
})

Deno.test("audit: a program's equal that throws fails its run; the host's write and other runs go on", () => {
	const { s } = host()
	put(s, "a", 1)
	let runsQ = 0
	const p = s.start({
		address: [],
		name: "p",
		program: { compute: ({ api }: Given) => api.content(["a"])[0].versions[0].content },
		equal: () => {
			throw new Error("boom")
		},
	})
	s.start({
		address: [],
		name: "q",
		program: {
			compute: ({ api }: Given) => (runsQ++, api.content(["a"])[0].versions[0].content),
		},
	})
	s.write(["a"], [{ path: [], value: 2 }])
	assert("error" in (status(s, ["p"]) as object))
	assertEquals(runsQ, 2)
})

Deno.test("audit: a throw while an async run settles is the run's failure, not an unhandled rejection", async () => {
	// run apart: an unhandled rejection would end this whole test run
	const script = `
		const { createScheduler } = await import(${
		JSON.stringify(import.meta.resolve("./scheduler.ts"))
	})
		const s = createScheduler({ root: "root" })
		s.insert("root", "a", s.create(1, { id: "a" }))
		const p = s.start({
			address: [],
			program: { compute: ({ api }) => Promise.resolve(api.content(["a"])[0].versions[0].content) },
			equal: () => { throw new Error("boom") },
		})
		await new Promise((r) => setTimeout(r, 10))
		s.write(["a"], [{ path: [], value: 2 }])
		await new Promise((r) => setTimeout(r, 10))
		console.log(JSON.stringify(s.get(p.id).value[0].content))
	`
	const out = await new Deno.Command(Deno.execPath(), { args: ["eval", script] }).output()
	const text = new TextDecoder()
	assertEquals(text.decode(out.stderr), "")
	assertEquals(out.code, 0)
	assert(text.decode(out.stdout).includes("error"))
})

Deno.test("audit: a refused read hands out no node through look", () => {
	const s = guarded([])
	put(s, "a", "secret")
	s.insert("a", "kids", s.create(1, { id: "kid" }))
	s.write(["rules"], [{
		path: [],
		value: [{ op: "read", node: "a", allow: false }, { op: "list", node: "a", allow: false }],
	}])
	assertEquals(s.content(["a"])[0].versions, undefined)
	assertEquals((s.look(["a"])[0] as Given).node, undefined)
})

Deno.test("audit: an insert over a span asks unplace for the ids it replaces", () => {
	const s = guarded([{ op: "unplace", allow: false }])
	put(s, "a", 1)
	const b = s.create(2, { id: "b" })
	assertThrows(() => s.remove("root", "a", [0, 1]), SchedulerError, "refused")
	assertThrows(() => s.insert("root", "a", b, [0, 1]), SchedulerError, "refused")
	assertEquals(s.get("root")!.children.get("a")![0].content, ["a"])
})

Deno.test("audit: a killed process's run node is released", () => {
	const { s } = host()
	const p = s.start({ address: [], program: () => 1 })
	const run = (s.look([p.id, "run"])[0] as Given).id
	assert(s.get(run))
	s.outro(p.id)
	assertEquals(s.get(run), undefined)
	assertEquals(s.ephemeral(run), false)
})

Deno.test("audit: a start refused for a bad name makes no process", () => {
	const { s, moments } = host()
	assertThrows(
		() => s.start({ address: [], program: () => 1, name: "a/b" }),
		SchedulerError,
		"wrong-field",
	)
	assertEquals(s.get("@1"), undefined)
	assertEquals(s.ephemeral("@1"), false)
	assertEquals(s.get("root")!.children.size, 0)
	assertEquals(moments.filter((m) => "starts" in m), [])
})

Deno.test("audit: a program's call to nothing throws, as the host's does", () => {
	const { s } = host()
	const host_ = code(assertThrows(() => s.call({ address: ["nothing", "here"] })))
	let caught: unknown = "nothing thrown"
	s.start({
		address: [],
		program: ({ call }: Given) => {
			try {
				call(["nothing", "here"], 1)
			} catch (e) {
				caught = code(e)
			}
			return 0
		},
	})
	assertEquals(caught, host_)
})
