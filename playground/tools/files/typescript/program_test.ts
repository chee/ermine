import { assert, assertEquals } from "@std/assert"
import { no, type Policy, yes } from "@ermine/protect"
import { createGraph } from "./graph.ts"
import { type Files, files, patches } from "./program.ts"
import { type Store, store } from "./store.ts"
import { attr, fake, type Sys, system } from "./sys.ts"
import type { Id, Listed } from "./types.ts"
import { watcher } from "./watch.ts"
import createNode from "./saved.ts"

// Every test works in a folder of its own from Deno.makeTempDir, with a home
// folder there and a fake Trash there: the real Trash and home are never used.

const text = new TextDecoder()
const utf8 = new TextEncoder()

/** The platform's calls, but a sync does nothing and the real Trash refuses. */
function quick(): Sys {
	return {
		...system(),
		sync: () => Promise.resolve(),
		trash: () => Promise.reject(new Error("a test never uses the real Trash")),
	}
}

async function within(fn: (dir: string) => Promise<void>) {
	const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "ermine-files-" }))
	try {
		await fn(dir)
	} finally {
		await Deno.remove(dir, { recursive: true })
	}
}

/** A host: a store, a graph made from what it loads, the files program and a watcher whose passes the test runs. */
async function host(dir: string, o: { may?: Policy } = {}) {
	const listed: Listed[] = []
	const t: Store = store(`${dir}/Store`, {
		sys: quick(),
		trash: fake(`${dir}/Trash`),
		files: true,
		home: `${dir}/home`,
		list: (x) => listed.push(x),
	})
	const restored = await t.read()
	const root = restored?.root ?? "r"
	const clock = { time: restored?.time ?? 0 }
	const graph = createGraph({ root, may: o.may })
	// the host's own writes: the actor "host", no policy asks it anything it is not asked in a test
	const api = graph.api("host")
	if (restored) {
		for (const n of restored.nodes) graph.intro(n)
		for (const n of restored.others) graph.intro(n)
	} else graph.intro(createNode(root, {}, { header: { time: 0 } }))
	// a change's time is the wall clock's, in whole seconds: a batch is no earlier than any
	const save = () => {
		clock.time = Math.max(clock.time, Math.floor(Date.now() / 1000))
		return t.write({ root, get: graph.get, time: clock.time, ephemeral: graph.ephemeral })
	}
	const w = watcher({ store: t, events: false, save, actor: "tester" })
	let running: Files | undefined
	const start = () => running = files({ store: t, watch: w, graph })
	const p = (path: string) => `${dir}/Store/${path}`
	return {
		t,
		graph,
		api,
		w,
		save,
		start,
		stop: () => running?.stop(),
		running: () => running,
		listed,
		root,
		p,
		read: (path: string) => text.decode(Deno.readFileSync(p(path))),
		put: (path: string, x: string) => Deno.writeTextFileSync(p(path), x),
		ids: (id: Id, slot: string) => api.ids(id, slot),
		value: (id: Id) => api.value(id),
		/** a node made and placed */
		make(holder: Id, slot: string, value?: unknown) {
			const id = api.create(value)
			api.insert(holder, slot, id)
			return id
		},
		/** a pass, the batch written, and the folder then as the layout says */
		async pass(touched?: string[]) {
			const done = await w.pass(touched)
			assertEquals(await t.differences(), [], "the folder is as the layout says")
			return done
		},
		/** what the program listed */
		shown: () => (running ? (api.value(running.listed) ?? []) : []) as Listed[],
	}
}

/** The example's graph (FILES.tex, An example), saved, with the program running. */
async function example(dir: string, o: { may?: Policy } = {}) {
	const h = await host(dir, o)
	const a = h.make(h.root, "apps", { theme: "dark" })
	const c = h.make(a, "clock", "12:00")
	const d1 = h.make(h.root, "docs", "hello")
	const d2 = h.make(
		h.root,
		"docs",
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	)
	h.api.insert(h.root, "pinned", d1)
	h.api.insert(h.root, "Notes", "x9")
	await h.save()
	h.start()
	return { ...h, a, c, d1, d2 }
}

async function exists(path: string) {
	try {
		await Deno.lstat(path)
		return true
	} catch {
		return false
	}
}

async function trashed(dir: string) {
	try {
		return (await Array.fromAsync(Deno.readDir(`${dir}/Trash`))).length
	} catch {
		return 0
	}
}

Deno.test("patches: one splice between what is alike at each end", () => {
	assertEquals(patches("12:00", "12:30"), [{ path: [], range: [3, 4], value: "3" }])
	assertEquals(patches("hé🙂x", "hé🙂yx"), [{ path: [], range: [3, 3], value: "y" }])
	assertEquals(patches(new Float32Array([1, 2, 3]), new Float32Array([1, 3])), [
		{ path: [], range: [1, 2], value: new Float32Array([]) },
	])
	assertEquals(patches({ a: 1 }, [1]), [{ path: [], value: [1] }])
	// bytes: one whole value, never spliced
	const b = new Uint8Array([1, 2, 3])
	assertEquals(patches(new Uint8Array([1, 3]), b), [{ path: [], value: b }])
})

Deno.test("the program: its listed node is ephemeral, one per store, and stopping lets it go", () =>
	within(async (dir) => {
		const h = await example(dir)
		const program = h.running()!
		assertEquals(h.graph.ephemeral(program.listed), true)
		assertEquals(h.value(program.listed), [])
		let second: unknown
		try {
			files({ store: h.t, watch: h.w, graph: h.graph })
		} catch (e) {
			second = e
		}
		assert(String(second).includes("already watched"))
		// nothing ephemeral is saved
		await h.save()
		assertEquals(await exists(h.p("files")), false)
		assertEquals(h.graph.get(program.listed) !== undefined, true)
		assertEquals(h.t.graph().nodes.has(program.listed), false)
		// stopped, another may watch it
		h.stop()
		files({ store: h.t, watch: h.w, graph: h.graph }).stop()
	}))

Deno.test("an edit to a file is a write, one splice", () =>
	within(async (dir) => {
		const h = await example(dir)
		h.put("apps/clock.txt", "12:30")
		await h.pass(["apps"])
		assertEquals(h.value(h.c), "12:30")
		const v = h.graph.get(h.c)!.value[0]
		assertEquals((v.change as { actor?: string }).actor, "tester")
		// the graph's value already the file's: nothing
		h.api.write(h.c, [{ path: [], value: "13:00" }])
		h.put("apps/clock.txt", "13:00")
		const before = h.graph.get(h.c)!.value[0]
		await h.pass(["apps"])
		assertEquals(h.graph.get(h.c)!.value[0], before)
	}))

Deno.test("the example: an edit meets a newer change and is a second node", () =>
	within(async (dir) => {
		const h = await example(dir)
		h.put("apps/clock.txt", "12:30")
		h.api.write(h.c, [{ path: [], value: "13:00" }])
		await h.pass(["apps"])
		const ids = h.ids(h.a, "clock")
		assertEquals(ids.length, 2)
		assertEquals(ids[0], h.c)
		assertEquals(h.value(ids[0]), "13:00")
		assertEquals(h.value(ids[1]), "12:30")
		assertEquals(h.read("apps/clock/1.txt"), "13:00")
		assertEquals(h.read("apps/clock/2.txt"), "12:30")
		assertEquals(await exists(h.p("apps/clock.txt")), false)
		const id = text.decode((await h.t.sys.get(h.p("apps/clock/2.txt"), attr.id))!)
		assertEquals(id, ids[1])
		// a person removes one member: one id again, its file back at clock.txt
		await Deno.remove(h.p("apps/clock/2.txt"))
		await h.pass(["apps/clock"])
		assertEquals(h.ids(h.a, "clock"), [h.c])
		assertEquals(h.read("apps/clock.txt"), "13:00")
	}))

Deno.test("the example, the batch laid first: the edit kept, then met", () =>
	within(async (dir) => {
		const h = await example(dir)
		h.put("apps/clock.txt", "12:30")
		h.api.write(h.c, [{ path: [], value: "13:00" }])
		await h.save()
		assertEquals(h.read("apps/clock.txt"), "12:30")
		await h.pass(["apps"])
		assertEquals(h.read("apps/clock/1.txt"), "13:00")
		assertEquals(h.read("apps/clock/2.txt"), "12:30")
	}))

Deno.test("a .text that does not read is listed, and taken in once it reads", () =>
	within(async (dir) => {
		const h = await example(dir)
		h.put("apps.text", '{ "theme": ')
		await h.w.pass([""])
		assertEquals(h.value(h.a), { theme: "dark" })
		assert(h.shown().some((x) => x.path === "apps.text"))
		h.put("apps.text", '{ "theme": "light" } / a comment /')
		await h.pass([""])
		assertEquals(h.value(h.a), { theme: "light" })
	}))

Deno.test("a text file no longer UTF-8 is a snapshot of its bytes", () =>
	within(async (dir) => {
		const h = await example(dir)
		Deno.writeFileSync(h.p("docs/1.txt"), new Uint8Array([0xff, 0xfe]))
		await h.pass(["docs"])
		const v = h.value(h.d1)
		assert(v instanceof Uint8Array)
		assertEquals([...v], [0xff, 0xfe])
	}))

Deno.test("a node's file removed: an unplacement, or null with its folder shown", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.remove(h.p("apps/clock.txt"))
		await h.pass(["apps"])
		assertEquals(h.ids(h.a, "clock"), [])
		assert(h.graph.get(h.c), "the graph keeps the node")
		await Deno.remove(h.p("apps.text"))
		await h.pass([""])
		// a whole value of null is no value, which the store shows as null
		assertEquals(h.value(h.a) ?? null, null)
		assertEquals(h.ids(h.root, "apps"), [h.a])
		assert(await exists(h.p("apps")))
	}))

Deno.test("a node's folder removed: its slots emptied, or with its file, the node unplaced", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.remove(h.p("apps"), { recursive: true })
		await h.pass([""])
		assertEquals(h.ids(h.a, "clock"), [])
		assertEquals(h.ids(h.root, "apps"), [h.a])
		assertEquals(h.read("apps.text").includes("dark"), true)
		const n = h.make(h.a, "more", "x")
		await h.save()
		assert(await exists(h.p("apps/more.txt")))
		await Deno.remove(h.p("apps"), { recursive: true })
		await Deno.remove(h.p("apps.text"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "apps"), [])
		assertEquals(h.ids(h.a, "more"), [n], "the node keeps its slots")
	}))

Deno.test("a union's folder removed: each of its ids unplaced", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.remove(h.p("docs"), { recursive: true })
		await h.pass([""])
		assertEquals(h.ids(h.root, "docs"), [])
		assertEquals(h.ids(h.root, "pinned"), [h.d1])
		assertEquals(h.read("pinned.txt"), "hello")
	}))

Deno.test("new files and folders are new nodes; in a union's folder, at their number", () =>
	within(async (dir) => {
		const h = await example(dir)
		h.put("README.md", "# hi")
		h.put("data.text", "[1, 2.5]")
		Deno.writeFileSync(h.p("v.float32"), new Uint8Array(new Float32Array([1, 2]).buffer))
		await Deno.mkdir(h.p("Projects/inner"), { recursive: true })
		h.put("Projects/plan.txt", "plan")
		h.put("Projects/inner/deep", "deep")
		h.put("docs/2 cat.txt", "meow")
		await h.pass(["", "docs"])
		const one = (slot: string) => h.ids(h.root, slot)[0]
		assertEquals(h.value(one("README.md")), "# hi")
		assertEquals(h.value(one("data")), [1, 2.5])
		assertEquals(h.value(one("v")), new Float32Array([1, 2]))
		const proj = one("Projects")
		assertEquals(h.value(proj), null)
		assertEquals(h.value(h.ids(proj, "plan.txt")[0]), "plan")
		const inner = h.ids(proj, "inner")[0]
		assertEquals(h.value(h.ids(inner, "deep")[0]), "deep")
		const docs = h.ids(h.root, "docs")
		assertEquals(docs.length, 3)
		assertEquals(h.value(docs[1]), "meow")
		assertEquals(h.read("docs/2 cat.txt"), "meow")
		assertEquals(h.read("docs/3.png").length > 0, true)
		// names a person wrote are kept
		assertEquals(h.read("README.md"), "# hi")
		assertEquals(h.read("Projects/inner/deep"), "deep")
		const id = text.decode((await h.t.sys.get(h.p("Projects/plan.txt"), attr.id))!)
		assertEquals(id, h.ids(proj, "plan.txt")[0])
	}))

Deno.test("a file beside a null node's folder is its file; a folder beside a node's file, its folder", () =>
	within(async (dir) => {
		const h = await example(dir)
		const n = h.make(h.root, "box", null)
		h.make(n, "in", "x")
		await h.save()
		assert(await exists(h.p("box")))
		assertEquals(await exists(h.p("box.text")), false)
		h.put("box.text", '{"a": 1}')
		await Deno.mkdir(h.p("docs/1"))
		h.put("docs/1/note.txt", "n")
		await h.pass(["", "docs"])
		assertEquals(h.value(n), { a: 1 })
		assertEquals(h.ids(h.root, "box"), [n])
		assertEquals(h.value(h.ids(h.d1, "note.txt")[0]), "n")
	}))

Deno.test("an entry back from the Trash is placed again where it was", () =>
	within(async (dir) => {
		const h = await example(dir)
		await h.t.trash("docs/2.png", "test")
		await h.pass(["docs"])
		assertEquals(h.ids(h.root, "docs"), [h.d1])
		assertEquals(h.read("docs.txt"), "hello")
		const [name] = (await Array.fromAsync(Deno.readDir(`${dir}/Trash`))).map((e) => e.name)
		await Deno.rename(`${dir}/Trash/${name}`, h.p("docs.png"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "docs"), [h.d1, h.d2])
		assert(await exists(h.p("docs/2.png")))
		// one still shown elsewhere is a copy: a new node
		await Deno.copyFile(h.p("docs/1.txt"), h.p("again.txt"))
		await h.t.sys.set(h.p("again.txt"), attr.id, utf8.encode(h.d1))
		await h.pass([""])
		assert(h.ids(h.root, "again.txt")[0] !== h.d1)
	}))

Deno.test("links: made, pending, removed, pointed elsewhere, nowhere, saved through", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.symlink("apps/clock.txt", h.p("fav.txt"))
		await Deno.symlink(".ermine/id/y7", h.p("Later"))
		await Deno.symlink("/nowhere/at/all", h.p("lost"))
		await h.w.pass([""])
		assertEquals(h.ids(h.root, "fav.txt"), [h.c])
		assertEquals(h.ids(h.root, "Later"), ["y7"])
		assert(h.shown().some((x) => x.path === "lost"))
		await Deno.remove(h.p("lost"))
		await h.pass([""])
		assertEquals(await Deno.readLink(h.p("fav.txt")), "apps/clock.txt")
		// pointed elsewhere
		await Deno.remove(h.p("fav.txt"))
		await Deno.symlink("docs/2.png", h.p("fav.txt"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "fav.txt"), [h.d2])
		// removed
		await Deno.remove(h.p("pinned.txt"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "pinned"), [])
		// a file saved through a link: a write to its node
		h.api.insert(h.root, "pinned", h.d1)
		await h.save()
		await Deno.remove(h.p("pinned.txt"))
		h.put("pinned.txt", "hello, world")
		await h.pass([""])
		assertEquals(h.value(h.d1), "hello, world")
		assertEquals(await Deno.readLink(h.p("pinned.txt")), "docs/1.txt")
		assertEquals(h.read("docs/1.txt"), "hello, world")
	}))

Deno.test("renames: a file renamed is a move, its folder follows", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.rename(h.p("apps.text"), h.p("tools.text"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "tools"), [h.a])
		assertEquals(h.ids(h.root, "apps"), [])
		assert(await exists(h.p("tools/clock.txt")), "the folder followed")
		assertEquals(await exists(h.p("apps")), false)
		// a folder renamed: the slot its new name gives; the file follows
		await Deno.rename(h.p("tools"), h.p("kit"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "kit"), [h.a])
		assert(await exists(h.p("kit.text")))
		// a rename never changes how a file reads
		await Deno.rename(h.p("kit/clock.txt"), h.p("kit/clock.text"))
		await h.pass(["kit"])
		assertEquals(h.ids(h.a, "clock.text"), [h.c])
		assertEquals(h.read("kit/clock.text.txt"), "12:00")
	}))

Deno.test("renames: moved across folders, and a union's folder renamed", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.rename(h.p("apps/clock.txt"), h.p("clock.txt"))
		await h.pass(["", "apps"])
		assertEquals(h.ids(h.root, "clock"), [h.c])
		assertEquals(h.ids(h.a, "clock"), [])
		await Deno.rename(h.p("docs"), h.p("papers"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "papers"), [h.d1, h.d2])
		assertEquals(await Deno.readLink(h.p("pinned.txt")), "papers/1.txt")
		// a node with a folder moved across: its folder comes too
		await Deno.rename(h.p("apps.text"), h.p("papers/0 apps.text"))
		await h.pass(["", "papers"])
		assertEquals(h.ids(h.root, "papers"), [h.a, h.d1, h.d2])
		assertEquals(await exists(h.p("apps")), false)
		const list = (await Array.fromAsync(Deno.readDir(h.p("papers")))).map((e) => e.name).sort()
		assertEquals(list, ["1 apps", "1 apps.text", "2.txt", "3.png"])
		assert((await Deno.lstat(h.p("papers/1 apps"))).isDirectory)
	}))

Deno.test("a union's members renamed: placed by their numbers, then names", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.rename(h.p("docs/2.png"), h.p("docs/0 first.png"))
		await h.pass(["docs"])
		assertEquals(h.ids(h.root, "docs"), [h.d2, h.d1])
		assert(await exists(h.p("docs/1 first.png")))
		assertEquals(h.read("docs/2.txt"), "hello")
	}))

Deno.test("a copy, as Duplicate makes, is new nodes with ids of their own", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.copyFile(h.p("apps/clock.txt"), h.p("apps/clock copy.txt"))
		await h.t.sys.set(h.p("apps/clock copy.txt"), attr.id, utf8.encode(h.c))
		await h.pass(["apps"])
		const [copy] = h.ids(h.a, "clock copy.txt")
		assert(copy && copy !== h.c)
		assertEquals(h.value(copy), "12:00")
		assertEquals(text.decode((await h.t.sys.get(h.p("apps/clock copy.txt"), attr.id))!), copy)
	}))

Deno.test("the root's file: a write; an edit that meets a change goes to the Trash", () =>
	within(async (dir) => {
		const h = await example(dir)
		h.api.write(h.root, [{ path: [], value: "top" }])
		await h.save()
		assertEquals(text.decode(Deno.readFileSync(`${dir}/Store/.ermine/root.txt`)), "top")
		Deno.writeTextFileSync(`${dir}/Store/.ermine/root.txt`, "top!")
		await h.pass([])
		assertEquals(h.value(h.root), "top!")
		Deno.writeTextFileSync(`${dir}/Store/.ermine/root.txt`, "mine")
		h.api.write(h.root, [{ path: [], value: "theirs" }])
		await h.pass([])
		assertEquals(h.value(h.root), "theirs")
		assertEquals(await trashed(dir), 1)
		assertEquals(text.decode(Deno.readFileSync(`${dir}/Store/.ermine/root.txt`)), "theirs")
	}))

Deno.test("an edit protect refuses is listed, sent to the Trash, and laid out again", () =>
	within(async (dir) => {
		const may: Policy = (ask) =>
			ask.op === "place" && ask.target.field?.[0] === "secret.txt" ? no("not here") : yes
		const h = await example(dir, { may })
		h.put("secret.txt", "s")
		h.put("open.txt", "o")
		await h.pass([""])
		assertEquals(h.ids(h.root, "secret.txt").length, 0)
		assertEquals(h.ids(h.root, "open.txt").length, 1)
		assertEquals(await exists(h.p("secret.txt")), false)
		assertEquals(await trashed(dir), 1)
		assert(h.shown().some((x) => x.path === "secret.txt" && x.why.includes("refused")))
	}))

Deno.test("edits made while nothing ran: the first pass takes them in", () =>
	within(async (dir) => {
		let ids: { a: Id; c: Id }
		{
			const h = await example(dir)
			ids = { a: h.a, c: h.c }
			h.w.stop()
		}
		Deno.writeTextFileSync(`${dir}/Store/apps/clock.txt`, "09:00")
		Deno.writeTextFileSync(`${dir}/Store/new.txt`, "new")
		await Deno.remove(`${dir}/Store/docs/2.png`)
		const h = await host(dir)
		assertEquals(h.t.missed.length, 3)
		h.start()
		await h.pass()
		assertEquals(h.value(ids.c), "09:00")
		assertEquals(h.value(h.ids(h.root, "new.txt")[0]), "new")
		assertEquals(h.ids(h.root, "docs").length, 1)
		assertEquals(h.read("docs.txt"), "hello")
	}))

/** Whether this machine tells a watcher of a file written (a sandbox may not). */
async function eventsWork(dir: string): Promise<boolean> {
	const probe = `${dir}/probe`
	await Deno.mkdir(probe)
	const fs = Deno.watchFs(probe)
	const timer = setTimeout(() => fs.close(), 1000)
	setTimeout(() => Deno.writeTextFileSync(`${probe}/x`, "x"), 50)
	try {
		for await (const _ of fs) return true
	} catch { /* closed */ }
	clearTimeout(timer)
	return false
}

Deno.test("the watcher: events, a quiet time, one pass", () =>
	within(async (dir) => {
		// no events here: nothing to test
		if (!(await eventsWork(dir))) return
		const h = await host(dir)
		h.make(h.root, "note", "a")
		await h.save()
		const w = watcher({
			store: h.t,
			quiet: 30,
			save: h.save,
			actor: "tester",
		})
		const program = files({ store: h.t, watch: w, graph: h.graph })
		await new Promise((r) => setTimeout(r, 100))
		h.put("note.txt", "b")
		for (let i = 0; i < 50 && h.value(h.ids(h.root, "note")[0]) !== "b"; i++) {
			await new Promise((r) => setTimeout(r, 30))
		}
		await w.idle()
		assertEquals(h.value(h.ids(h.root, "note")[0]), "b")
		program.stop()
		await w.idle()
	}))

Deno.test("a link renamed moves its id; an alias, by the host's seam, is a link", () =>
	within(async (dir) => {
		const h = await example(dir)
		await Deno.rename(h.p("pinned.txt"), h.p("starred.txt"))
		await h.pass([""])
		assertEquals(h.ids(h.root, "pinned"), [])
		assertEquals(h.ids(h.root, "starred"), [h.d1])
		assertEquals(await Deno.readLink(h.p("starred.txt")), "docs/1.txt")
		// a Finder alias: the host resolves it; the store replaces it with a link
		h.put("clock alias", "an alias's bookmark data")
		const w = watcher({
			store: h.t,
			events: false,
			save: h.save,
			actor: "tester",
			alias: (p) => (p.endsWith("/clock alias") ? h.p("apps/clock.txt") : undefined),
		})
		w.start({ edit: (d, actor) => h.running()!.edit(d, actor) })
		await w.pass([""])
		w.stop()
		assertEquals(h.ids(h.root, "clock alias"), [h.c])
		assertEquals((await Deno.lstat(h.p("clock alias.txt"))).isSymlink, true)
		assertEquals(await exists(h.p("clock alias")), false)
		assertEquals(await h.t.differences(), [])
	}))

Deno.test("random edits, a few dozen seeds: each pass leaves the folder as the layout says", async () => {
	for (let seed = 1; seed <= 24; seed++) {
		await within(async (dir) => {
			let x = seed
			const rand = (n: number) => ((x = (x * 1103515245 + 12345) % 2147483648) % n)
			const h = await example(dir)
			for (let round = 0; round < 6; round++) {
				const all: string[] = []
				const walk = (at: string) => {
					for (const e of Deno.readDirSync(h.p(at))) {
						const p = at ? `${at}/${e.name}` : e.name
						if (p === ".ermine") continue
						all.push(p)
						if (e.isDirectory) walk(p)
					}
				}
				walk("")
				const files = all.filter((p) => Deno.lstatSync(h.p(p)).isFile)
				const folders = ["", ...all.filter((p) => Deno.lstatSync(h.p(p)).isDirectory)]
				const pick = <T>(l: T[]) => l[rand(l.length)]
				const f = pick(files), d = pick(folders)
				const at = (n: string) => (d ? `${d}/${n}` : n)
				switch (rand(6)) {
					case 0:
						if (f && f.endsWith(".txt")) h.put(f, `edit ${seed}.${round}`)
						break
					case 1:
						h.put(at(`new${round}.txt`), "new")
						break
					case 2:
						if (f) Deno.removeSync(h.p(f))
						break
					case 3:
						if (f) Deno.renameSync(h.p(f), h.p(at(`moved${round}.txt`)))
						break
					case 4:
						Deno.mkdirSync(h.p(at(`dir${round}`)))
						h.put(at(`dir${round}/in.txt`), "in")
						break
					case 5:
						try {
							h.api.write(h.c, [{ path: [], value: `graph ${round}` }])
						} catch {
							// the clock is gone: nothing to write
						}
						break
				}
				await h.pass()
			}
		})
	}
})

Deno.test("an edit in a union member's folder reaches its node, though another member has that slot", () =>
	within(async (dir) => {
		const h = await example(dir)
		const one = h.make(h.d1, "more", "one")
		const two = h.make(h.d2, "more", "two")
		await h.save()
		await h.pass([""])
		h.put("docs/2/more.txt", "two!")
		await h.pass(["docs/2"])
		assertEquals(h.value(two), "two!")
		assertEquals(h.value(one), "one")
		assertEquals(h.shown(), [])
	}))

Deno.test("each change carries the path that made it as its cause, and a move's from", () =>
	within(async (dir) => {
		const h = await example(dir)
		await h.pass([""])
		const cause = (v?: { change: unknown }) =>
			((v?.change as { metadata?: [string, unknown][] }).metadata ?? []).find(([k]) =>
				k === "cause"
			)
				?.[1]
		h.put("apps/clock.txt", "12:30")
		await h.pass(["apps"])
		assertEquals(cause(h.graph.get(h.c)!.value[0]), { file: "apps/clock.txt" })
		await Deno.rename(h.p("apps/clock.txt"), h.p("apps/watch.txt"))
		await h.pass(["apps"])
		assertEquals(h.ids(h.a, "watch"), [h.c])
		assertEquals(cause(h.graph.get(h.a)!.children.get("watch")![0]), {
			file: "apps/watch.txt",
			from: "apps/clock.txt",
		})
	}))
