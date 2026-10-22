// AUDIT (defensive, our own code): the isolation promise of ermine/boxes.
//
// Boxing something in a shared folder is a choice made on purpose; what is boxed must not see above
// that folder, but may look and place in it. So code given a
// box may read and write at or below the box's folder, and must not read or change anything above
// or beside it. Whatever was deliberately boxed in is fine.
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
import createEntry, { type Entry } from "@ermine/node/entry"
import { createScheduler } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Id, type Key } from "@ermine/table"
import { children, createPlaces } from "@ermine/places"
import { get, gets, list, lookup, members } from "@ermine/places/lib"
import { createChangeHeader } from "@ermine/places/header"
import { addProcess } from "@ermine/processes"
import { createScopeNodes } from "@ermine/processes/scopes"
import { ATTRIBUTES as A, openwith, satisfy, type Way } from "../typescript/programs.ts"
import { createPrograms } from "../typescript/start.ts"
import { type Box, box, createBox, type Host, inside, unbox } from "@ermine/boxes"

// ----- the world: R holds work (the box), tools and secret beside it -----------------------------
//   R.children = { work: W, tools: T, secret: S }
//   W.children = { fetch: F0, notes: N };  N.children = { pad: PAD }
//   values: T, S, F0, PAD, R each a marker. S is "the secret" above/beside the box.
function world() {
	const s = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const paths = createPaths<unknown>()
	const places = createPlaces({ root: "R", table, paths, scheduler: s })
	s.onTrackingEnd((key) => places.release(key))
	const host: Host = { places, table, scheduler: s }
	const scope = s.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T) => s.runWithScope(scope, f)
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
	// NOTE (in-flight): start.ts currently calls s.createScope() with no info for its process owner
	// (another agent is changing start). The live scheduler rejects missing/empty info, so this
	// transparent wrapper substitutes a single neutral owner pair ONLY when start passes nothing; the
	// real process scope's info ([["process", at]]) passes through untouched. It wraps the same
	// scheduler state, so pulses, effects and reads are unaffected. Recheck/remove once start settles
	// how it opens its owner scope; this is the only reason start can be exercised here at all.
	const sched = {
		...s,
		createScope: (info?: Iterable<unknown>, parent?: unknown) => {
			const pairs = info === undefined ? [] : [...(info as Iterable<unknown>)]
			return (s.createScope as (i: unknown, p?: unknown) => unknown)(
				pairs.length ? pairs : [["owner", "programs"]],
				parent,
			)
		},
	}
	const programs = hosted(() =>
		createPrograms({
			scheduler: sched as unknown as typeof s,
			table,
			places: { commit: places.commit },
			builds: {
				compile: () => {
					throw new Error("no compile expected")
				},
			},
			scopes,
			createProcessAPI: () => ({}),
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
Deno.test("HELD: box() and unbox() clamp inside the folder; '..' and '/' never escape", () => {
	const { places, b, hosted } = world()
	// "../../tools" resolves to a fresh "tools" under W, the host's tools untouched
	hosted(() => box(b, "../../tools", "X"))
	assertEquals(get(b.places, ["tools"]), "X")
	assertEquals(get(places, ["tools"]), "T", "box() wrote over the host's sibling")
	assertEquals(get(places, ["work", "tools"]), "X")
	// "/secret" resolves to a fresh "secret" under W, the host's secret untouched
	hosted(() => box(b, "/secret", "Y"))
	assertEquals(get(places, ["secret"]), "S", "box() wrote over the host's secret")
	assertEquals(get(b.places, ["secret"]), "Y")
	// unbox of a clamped path only removes inside
	hosted(() => unbox(b, "/../tools"))
	assertEquals(get(b.places, ["tools"]), undefined)
	assertEquals(get(places, ["tools"]), "T", "unbox() removed the host's sibling")
})

Deno.test("HELD: a nested box stays narrower and cannot climb back to the outer box", () => {
	const { host, hosted, b } = world()
	const inner = hosted(() => createBox(host, "deep", b)) // W/deep
	assertNotEquals(inner.root, "W")
	assertNotEquals(inner.root, "R")
	// the inner box does not see W's own children (above it, inside the outer box)
	assertEquals(get(inner.places, ["fetch"]), undefined)
	assertEquals(lookup(inner.places, ["fetch"], []), undefined)
	// a box made at ".." from the inner box stays at the inner root, it does not become the outer box
	const climbed = hosted(() => createBox(host, "..", inner))
	assertEquals(climbed.root, inner.root, "a nested box climbed to its parent via '..'")
})

Deno.test("HELD: createBox by {id} with a parent is refused (a box in another is only narrower)", () => {
	const { host, hosted, b } = world()
	let threw = false
	try {
		hosted(() => createBox(host, { id: "S" }, b))
	} catch {
		threw = true
	}
	assert(threw, "createBox({id}, parent) was allowed to point a nested box at an arbitrary id")
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
// C: the same shape (filesystem/places/c pl_view, pl_read/pl_walk by id; ermine/boxes/c
// bx_create_id with no containment) is in the C code and cannot be driven through the boxes harness
// (it only offers path-scoped ops). What the harness CAN show — the path-level promise — is checked
// here against the prebuilt binary; the structural C findings are in REPORT.md by inspection.
// =================================================================================================
Deno.test("C: the boxes harness keeps the path-level promise (box path reads see no sibling)", async () => {
	const bin = new URL("../c/boxes-harness", import.meta.url).pathname
	let stat: Deno.FileInfo | undefined
	try {
		stat = await Deno.stat(bin)
	} catch {
		console.warn(`skip: ${bin} not built`)
		return
	}
	if (stat === undefined) return
	const lines = [
		{ op: "kids", id: "R", value: { tools: "T", work: "W" } },
		{ op: "kids", id: "W", value: { fetch: "F0" } },
		{ op: "create", name: "b", at: "work" },
		{ op: "get", box: "b", path: ["tools"] }, // a sibling: must be nothing
		{ op: "get", box: "b", path: ["fetch"] }, // inside: F0
		{ op: "get", path: ["tools"] }, // the host: T
	]
	const cmd = new Deno.Command(bin, { stdin: "piped", stdout: "piped", stderr: "piped" })
	const child = cmd.spawn()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(lines.map((l) => JSON.stringify(l)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await child.output()
	const out = new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
	assertEquals(out[3], {}, "C box saw a sibling by path")
	assertEquals(out[4], { id: "F0" }, "C box could not read inside")
	assertEquals(out[5], { id: "T" }, "C host sanity")
})
