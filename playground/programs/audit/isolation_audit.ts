// AUDIT (defensive, our own code): the isolation promise of extensions/boxes.
//
// Putting something in a box is a choice made on purpose; the box must not see above its folder,
// and sees only what is saved there and what was put in it. So code given a box may read and
// write at or below the box's folder, and must not read or change anything above or beside it.
// Whatever was deliberately put in is fine.
//
// Each test asserts the promise HOLDS, so a test FAILS while a gap is open. The file name is outside
// deno test's default pattern, so others' runs are unaffected. Run it with:
//   deno test --allow-all playground/programs/audit/isolation_audit.ts
//
// Findings and the smallest fix ideas are in ./REPORT.md; each finding names the test that shows it.
//
// A note on "a known outside id": most of the box's reads/writes are addressed by raw id, so a gap
// only bites once some id above or beside the box is known. The test suite confirms (held) that
// reading down the box never yields such an id; the gaps use the host root ("R") as a stand-in for
// an id that is guessed, leaked, or well-known (memory: the root is a device-id document). That the
// boundary rests on id-secrecy rather than structure is itself the finding.
import { assert, assertEquals, assertNotEquals } from "@std/assert"
import createEntry, { type Entry } from "@ermine/core/node/entry"
import { createScheduler } from "@ermine/core/scheduler"
import type { Id, Key } from "@ermine/core/table"
import { children } from "@ermine/core/places"
import { get, gets, list, lookup, members } from "@ermine/core/places/lib"
import { createChangeHeader } from "@ermine/core/places/header"
import { addProcess } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { ATTRIBUTES as A, openwith, satisfy, type Way } from "../typescript/programs.ts"
import { createPrograms } from "../typescript/start.ts"
import { createBox } from "@ermine/boxes"
import { createErmine } from "@ermine/system"

// ----- the world: R holds work (the box), tools and secret beside it -----------------------------
//   R.children = { work: W, tools: T, secret: S }
//   W.children = { fetch: F0, notes: N };  N.children = { pad: PAD }
//   values: T, S, F0, PAD, R each a marker. S is "the secret" above/beside the box.
function world() {
	const s = createScheduler()
	const host = createErmine({ scheduler: s, root: "R", info: { actor: "host" } })
	const { table, places } = host
	const hosted = host.within
	const header = () => createChangeHeader(s)
	const put = (part: Key, id: Id, v: unknown) =>
		hosted(() => table.sub(part, id, createEntry(v, header())))
	put("children", "R", { work: "W", tools: "T", secret: "S" })
	put("children", "W", { fetch: "F0", notes: "N" })
	put("children", "N", { pad: "PAD" })
	put("value", "R", "root-value")
	put("value", "T", "tools-value")
	put("value", "S", "SECRET-value")
	put("value", "F0", "fetch-value")
	put("value", "PAD", "pad-value")
	put("attributes", "S", { "ermine.secret": true, "ermine.type": "secret.kind" })
	const b = hosted(() => createBox(host, "work"))
	return { s, table, places, host, hosted, header, put, b }
}

const ids = (xs: { id: Id }[]) => xs.map((x) => x.id)
const outside = new Set<Id>(["R", "T", "S"])

// =================================================================================================
// HELD: reading down a box never yields an id above or beside it. This is why isolation can hold at
// all in a closed world; it is also what every id-addressed gap below leans on being true.
// =================================================================================================
Deno.test("HELD: reads down the box never surface an id above or beside it", () => {
	const { b } = world()
	assertEquals(b.root, "W")
	assertEquals(get(b.places, []), "W")
	assertEquals(ids(gets(b.places, [])), ["W"])
	// the box's folder's own members, nothing beside
	assertEquals(ids(members(b.places, [])).sort(), ["F0", "N"])
	assertEquals(ids(members(b.places, ["notes"])), ["PAD"])
	assertEquals([...list(b.places, [])].sort(), ["fetch", "notes"])
	// a sibling/parent is not reachable by name, and lookup up from within stops at the box root
	assertEquals(get(b.places, ["tools"]), undefined)
	assertEquals(get(b.places, ["secret"]), undefined)
	assertEquals(lookup(b.places, ["tools"], ["notes", "pad"]), undefined)
	assertEquals(lookup(b.places, ["secret"], ["notes", "pad"]), undefined)
	// no id that a read gave is one above/beside the box
	const seen = [
		get(b.places, []),
		...ids(gets(b.places, [])),
		...ids(members(b.places, [])),
		...ids(members(b.places, ["notes"])),
	]
	for (const id of seen) assert(!outside.has(id as Id), `a read gave an outside id: ${String(id)}`)
})

// =================================================================================================
// GAP 1 (critical): the boundary object exposes view(anyRoot). Handed a box, code can re-root the
// box's own places anywhere and read/write with no containment at all.
// =================================================================================================
Deno.test("the box's places must not re-root above/beside itself (view)", () => {
	const { b } = world()
	// view is right there on b.places; give it an ancestor id and the box is gone
	const up = b.places.view("R", [children])
	assertEquals(get(up, ["tools"]), undefined, "box.places.view reached a sibling")
	assertEquals(get(up, ["secret"]), undefined, "box.places.view reached the secret beside it")
	assertEquals(up.readValue("value", "S"), undefined, "box.places.view read the secret's value")
})

// =================================================================================================
// GAP 2 (critical): b.places' id-addressed reads (readValue, readKeys, readChange, walk-from-id)
// reach any node, not only ones at/below the box. Same cause as GAP 1.
// =================================================================================================
Deno.test("the box's places must not read a sibling/parent by raw id (readValue)", () => {
	const { b } = world()
	assertEquals(b.places.readValue("value", "S"), undefined, "read the secret beside the box")
	assertEquals(b.places.readValue("value", "T"), undefined, "read a sibling beside the box")
	assertEquals(b.places.readValue("value", "R"), undefined, "read the parent's value")
})

Deno.test("the box's places must not read a sibling's attributes by raw id (readValue)", () => {
	const { b } = world()
	assertEquals(
		b.places.readValue("attributes", "S", ["ermine.secret"]),
		undefined,
		"read the secret's attributes",
	)
})

Deno.test("the box's places must not enumerate the parent's children by raw id (readKeys)", () => {
	const { b } = world()
	// reading R's children map leaks the names (and, with get, the ids) of everything beside the box
	assertEquals(b.places.readKeys("children", "R"), [], "enumerated the parent's children")
})

Deno.test("the box's places must not read a node's change by raw id (readChange)", () => {
	const { b } = world()
	assertEquals(b.places.readChange("value", "S"), undefined, "read the secret's change header")
	assertEquals(b.places.readChange("children", "R"), undefined, "read the parent's change header")
})

Deno.test("the box's places must not walk from an id above/beside it (walk)", () => {
	const { b } = world()
	// a walk started from the parent id steps straight into the siblings
	const steps = [...b.places.walk(["tools"], "R")]
	assertEquals(steps, [], "walked from the parent id into a sibling")
})

// =================================================================================================
// GAP 3 (high): programs.start trusts a Way's ids without checking they are inside the box. A Way
// naming an outside program (or chain step) makes start read — and run — a node beside the box.
// A real Way comes from satisfy (clamped, see HELD below), but start verifies nothing itself.
// =================================================================================================
Deno.test("start must not read/run a program whose id is outside the box (crafted Way)", () => {
	const { s, table, places, b, hosted, header } = world()
	const ran: { code?: unknown } = {}
	// a host runner: records the code it is handed
	hosted(() =>
		table.sub(
			"value",
			"RUNNER",
			createEntry((code: unknown) => (ran.code = code, { stop() {} }), header()),
		)
	)
	const scopes = createScopeNodes({ scheduler: s, table })
	const programs = hosted(() =>
		createPrograms({
			scheduler: s,
			table,
			places,
			builds: {
				compile: () => {
					throw new Error("no compile expected")
				},
			},
			scopes,
		})
	)
	// a Way pointing the program at the SECRET node, run by the host runner (empty by: host-runnable)
	const way: Way = {
		program: { id: "S", at: ["secret"] },
		chain: [{ id: "RUNNER", at: ["run"], by: [] }],
	}
	hosted(() => programs.start(b, way, "/proc"))
	s.pulse()
	assertNotEquals(ran.code, "SECRET-value", "start ran a program's value from beside the box")
})

// =================================================================================================
// GAP 4 (high): openwith(places, file, from) takes the file id from the caller and reads that
// node's type/attributes with no check that it is inside the box, then yields ways to open it.
// =================================================================================================
Deno.test("openwith must not open a file whose id is outside the box", () => {
	const { s, table, b, hosted, header } = world()
	// an opener inside the box that opens secret.kind, host-runnable (value a function, no type)
	hosted(() => {
		table.sub("value", "OPENER", createEntry(() => {}, header()))
		table.sub("attributes", "OPENER", createEntry({ [A.opens]: ["secret.kind"] }, header()))
		table.sub(
			"children",
			"W",
			createEntry({ fetch: "F0", notes: "N", opener: "OPENER" }, header()),
		)
	})
	// S is beside the box; its id is handed straight to openwith
	const ways = s.runWithScope(
		s.createRootScope({ actor: "x" }),
		() => [...openwith(b.places, "S", [])],
	)
	assertEquals(ways.length, 0, "openwith produced a way to open a node beside the box")
})

// =================================================================================================
// GAP 5 (availability): a shared box where others may place loaders lets one process place many
// interchangeable loaders, so everyone's satisfy explodes (programs_bench: breadth k ~ e*k! ways).
// =================================================================================================
Deno.test("satisfy's ways must stay bounded when many interchangeable loaders share the box", () => {
	const { s, table, b, hosted, header } = world()
	const JS = "com.netscape.javascript-source"
	hosted(() => {
		const kids: Record<string, Id> = { fetch: "F0", notes: "N" }
		// a JS program to run
		table.sub("value", "PROG", createEntry("src", header()))
		table.sub("attributes", "PROG", createEntry({ [A.type]: JS }, header()))
		kids["prog"] = "PROG"
		// k loaders each taking and giving JS (compilers), plus a runner taking JS
		const K = 7
		for (let i = 0; i < K; i++) {
			const id = `L${i}`
			table.sub("value", id, createEntry(() => {}, header()))
			table.sub("attributes", id, createEntry({ [A.takes]: [JS], [A.gives]: JS }, header()))
			kids[`loader${i}`] = id
		}
		table.sub("value", "RUN", createEntry(() => {}, header()))
		table.sub("attributes", "RUN", createEntry({ [A.takes]: [JS] }, header()))
		kids["zzrun"] = "RUN"
		table.sub("children", "W", createEntry(kids, header()))
	})
	let count = 0
	const CAP = 3000
	s.runWithScope(s.createRootScope({ actor: "x" }), () => {
		for (const _ of satisfy(b.places, "prog", [])) {
			if (++count >= CAP) break
		}
	})
	assert(count < 64, `satisfy yielded ${count >= CAP ? ">=" + CAP : count} ways: factorial blowup`)
})

// =================================================================================================
// HELD: the promises the box DOES keep. These pass today; they pin the behaviour so a later change
// that breaks it shows up here too.
// =================================================================================================
Deno.test("HELD: put and take clamp inside the box; '..' and '/' never escape", () => {
	const { places, b, hosted } = world()
	// "../../tools" resolves to "tools" in the box, the host's tools untouched (and, a put being
	// the box's own, the host's work/tools is not made)
	hosted(() => b.put("../../tools", "X"))
	assertEquals(get(b.places, ["tools"]), "X")
	assertEquals(get(places, ["tools"]), "T", "put wrote over the host's sibling")
	assertEquals(get(places, ["work", "tools"]), undefined, "put was saved where the host sees it")
	// "/secret" resolves to "secret" in the box, the host's secret untouched
	hosted(() => b.put("/secret", "Y"))
	assertEquals(get(places, ["secret"]), "S", "put wrote over the host's secret")
	assertEquals(get(b.places, ["secret"]), "Y")
	// take of a clamped path only removes inside
	hosted(() => b.take("/../tools"))
	assertEquals(get(b.places, ["tools"]), undefined)
	assertEquals(get(places, ["tools"]), "T", "take removed the host's sibling")
})

// boxes do not nest: createBox takes the ermine and a path from its root (or an id, or none), so
// there is no box made inside a box to climb back out of. what nested boxes held, a box over
// "deep" narrower than the one over its parent, is the folder's own: a box over it sees what is
// below it and nothing above
Deno.test("HELD: a box over a folder below another sees only what is below it", () => {
	const { host, hosted } = world()
	const inner = hosted(() => createBox(host, "work/notes"))
	assertEquals(inner.root, "N")
	assertEquals(get(inner.places, ["fetch"]), undefined)
	assertEquals(lookup(inner.places, ["fetch"], []), undefined)
	assertEquals(get(inner.places, ["pad"]), "PAD")
	// ".." at its "/" stays at "/": the inner box does not become the outer
	assertEquals(get(inner.places, ["..", "fetch"]), undefined)
})

Deno.test("HELD: what is put in one box is not seen by the host, nor by another box over the folder", () => {
	const { host, places, hosted, b } = world()
	const other = hosted(() => createBox(host, "work"))
	hosted(() => b.put("mine", "S"))
	assertEquals(get(b.places, ["mine"]), "S")
	assertEquals(get(other.places, ["mine"]), undefined, "a put was seen by another box")
	assertEquals(get(places, ["work", "mine"]), undefined, "a put was seen by the host")
})

Deno.test("HELD: a box watch is not told of a write beside/above it", () => {
	const { s, table, places, b, hosted, header } = world()
	let inside = 0, other = 0
	const stopInside = b.places.watchPath(["fetch"], () => inside++)
	// a change beside the box: the host's tools value
	hosted(() => table.sub("value", "T", createEntry("tools-value-2", header())))
	// a new sibling under the parent R
	hosted(() =>
		table.sub(
			"children",
			"R",
			createEntry({ work: "W", tools: "T", secret: "S", more: "M" }, header()),
		)
	)
	const stopOther = places.watchPath(["tools"], () => other++) // a host watch, to prove writes happened
	hosted(() => table.sub("value", "T", createEntry("tools-value-3", header())))
	stopInside()
	stopOther()
	assertEquals(inside, 0, "a box watch was told of a change beside it")
	assert(other >= 1, "sanity: the host watch should have fired")
})

Deno.test("HELD: satisfy from a box does not reach a loader placed above/beside it", () => {
	const { s, table, b, hosted, header } = world()
	const JS = "com.netscape.javascript-source"
	hosted(() => {
		// a JS program inside the box
		table.sub("value", "PROG", createEntry("src", header()))
		table.sub("attributes", "PROG", createEntry({ [A.type]: JS }, header()))
		table.sub("children", "W", createEntry({ fetch: "F0", notes: "N", prog: "PROG" }, header()))
		// the only runner is BESIDE the box, under R (R/run), not inside it
		table.sub("value", "RUN", createEntry(() => {}, header()))
		table.sub("attributes", "RUN", createEntry({ [A.takes]: [JS] }, header()))
		table.sub(
			"children",
			"R",
			createEntry({ work: "W", tools: "T", secret: "S", run: "RUN" }, header()),
		)
	})
	const ways = s.runWithScope(
		s.createRootScope({ actor: "x" }),
		() => [...satisfy(b.places, "prog", [])],
	)
	assertEquals(ways.length, 0, "satisfy reached a runner beside the box")
})

// =================================================================================================
// HELD (process rows): a process started in the box lands in the box's own trie, and the box does
// not see a process started at the host root beside it.
// =================================================================================================
Deno.test("HELD: a box does not see a process started at the host root beside it", () => {
	const { s, table, places, hosted, header, b } = world()
	hosted(() => places.commit(addProcess(table, "R", ["tools", "clock"], "P-HOST", header())))
	// the host, rooted at R with its own process contributor, would see it; the box does not
	assertEquals(get(b.places, ["tools"]), undefined)
	assertEquals(get(b.places, ["tools", "clock"]), undefined)
})

// =================================================================================================
// C: the same shape (core/places/c pl_view, pl_read/pl_walk by id; extensions/boxes/c
// bx_create_id with no containment) is in the C code and cannot be driven through the boxes harness
// (it only offers path-scoped ops). What the harness CAN show — the path-level promise — is checked
// here against the prebuilt binary; the structural C findings are in REPORT.md by inspection.
// =================================================================================================
Deno.test("C: the boxes harness keeps the path-level promise (box path reads see no sibling)", async () => {
	const bin = new URL("../../../extensions/boxes/c/boxes-harness", import.meta.url).pathname
	let stat: Deno.FileInfo | undefined
	try {
		stat = await Deno.stat(bin)
	} catch {
		console.warn(`skip: ${bin} not built`)
		return
	}
	if (stat === undefined) return
	const lines = [
		{ op: "ermine" },
		{ op: "host", call: ["ensureNode", "/work/fetch", "F0"] },
		{ op: "host", call: ["ensureNode", "/tools", "T"] },
		{ op: "box", name: "b", at: "/work" },
		{ op: "look", in: "b", path: "/tools" }, // a sibling: must be nothing
		{ op: "look", in: "b", path: "/fetch" }, // inside: F0
		{ op: "look", path: "/tools" }, // the host: T
	]
	const cmd = new Deno.Command(bin, { stdin: "piped", stdout: "piped", stderr: "piped" })
	const child = cmd.spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	const out = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(out[4], { there: false }, "C box saw a sibling by path")
	assertEquals(out[5], { there: true, value: "F0" }, "C box could not read inside")
	assertEquals(out[6], { there: true, value: "T" }, "C host sanity")
})
