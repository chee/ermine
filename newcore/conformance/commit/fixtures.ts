// Writes the commit scenarios to newcore/sync/conformance/commit/NN-short-name.json.
//   deno run --allow-read --allow-write conformance/commit/fixtures.ts
// Each scenario one or more sessions (../apply/session.ts has the protocol). Each committed blop
// is written by hand from COMMIT.tex: parents, base, combine, lamport, patches, header. Where the
// blop is then added, the versions after are written by hand too, and checked twice: against the
// model (../apply/model.ts) and against the local change, mutate.ts on the versions before,
// reordered as COMMIT.tex's After says. commit.ts and apply.ts are never imported.
import { assertEquals } from "@std/assert"
import { Stand } from "../../encoding/ts/cbor.ts"
import { toJson } from "../pack/form.ts"
import {
	add,
	type B,
	buf,
	create,
	desc,
	first,
	form,
	hex,
	mk,
	none,
	patch,
	put,
	removal,
	scenario,
	set,
	sideStep as side,
	type Step,
	versionsStep as versions,
	type Which,
	write,
} from "../apply/model.ts"

const INFO: Which = ["info", "title"]
const DEV1 = new Uint8Array(32).fill(7)
const DEV2 = new Uint8Array(32).fill(8)
type At = { version: number } | { span: [number, number] } | { pop: number | [number, number] }
type Header = { time: number; actor: unknown; reader?: string; site?: unknown; cause?: unknown }

let seed = 0
type Commit = {
	at: At
	object?: Which
	patches?: unknown[]
	header?: Header
	roots?: string[]
	signer?: Uint8Array
}
// the blop commit should make: written by hand
type Want = {
	parents: B[]
	base?: B
	combine?: true
	lamport: number
	patches?: unknown[]
	// the site the blop carries, when the header has one
	site?: Record<string, unknown>
	// the actor and cause the blop carries, where the header's hold a live value (a marker)
	actor?: unknown
	cause?: unknown
}
// a commit step, and the blop expected (named, so it can be added after)
function commit(c: Commit, want: Want): [Step, B] {
	const nonce = Uint8Array.from({ length: 8 }, (_, i) => i === 0 ? 0xc0 : (++seed * 31 + i) & 0xff)
	const header = c.header ?? { time: 77, actor: "me" }
	const object = c.object ?? "value"
	const patches = c.patches ?? []
	const signer = c.signer ?? DEV1
	const b = mk({
		object,
		parents: want.parents,
		base: want.base,
		combine: want.combine,
		lamport: want.lamport,
		patches: want.patches ?? patches,
		actor: "actor" in want ? want.actor : header.actor,
		reader: header.reader,
		site: want.site,
		cause: "cause" in want ? want.cause : header.cause,
		signer,
		nonce,
	})
	assertEquals(b.blop.base === undefined, want.parents.length < 2, "base exactly with two parents")
	const step: Step = {
		request: {
			op: "commit",
			change: toJson({ node: "n", object, patches, header, signer: buf(signer) }) as never,
			at: c.at,
			roots: c.roots ?? [],
			random: hex(nonce),
		},
		expect: { blop: form(b) },
	}
	return [step, b]
}
const refuses = (c: Commit, code: string): Step => ({
	request: {
		op: "commit",
		change: toJson({
			node: "n",
			object: c.object ?? "value",
			patches: c.patches ?? [],
			header: { time: 77, actor: "me" },
			signer: buf(DEV1),
		}) as never,
		at: c.at,
		roots: [],
		random: "c000000000000000",
	},
	expect: { code },
})

type V = [B, unknown]
// the local change: mutate on the versions before at `at`, a span merged into one at its
// first, a pop dropping; then the new version moved before each earlier version whose head
// comes after it in the agreed order (a pop, or a change that empties: never). Checked equal to
// the versions after, written by hand
function local(object: Which, before: V[], c: Commit, made: B, after: V[]) {
	const at = c.at
	let vs: V[]
	if ("pop" in at) {
		const [from, to] = typeof at.pop === "number" ? [at.pop, at.pop + 1] : at.pop
		const kept = [...before.slice(0, from), ...before.slice(to)]
		vs = kept.length ? [[made, kept[0][1]], ...kept.slice(1)] : []
	} else {
		const [from, to] = "version" in at ? [at.version, at.version + 1] : at.span
		const content = patch(object, before[from]?.[1] ?? none, c.patches ?? [])
		const made1: V[] = content === none ? [] : [[made, content]]
		vs = [...before.slice(0, from), ...made1, ...before.slice(to)]
		if (made1.length) {
			const j = vs.findIndex(([h], k) => k < from && first(made, h))
			if (j >= 0) vs = [...vs.slice(0, j), made1[0], ...vs.slice(j, from), ...vs.slice(from + 1)]
		}
	}
	assertEquals(
		vs.map(([h, x]) => [h.name, x]),
		after.map(([h, x]) => [h.name, x]),
		"the local change, reordered, is not the versions after",
	)
}
const contents = (hs: B[], f: (h: B) => unknown): V[] => hs.map((h) => [h, f(h)])

// ---- an object with no versions
{
	const c: Commit = { at: { version: 0 }, patches: put({ v: 1 }) }
	const [s, X] = commit(c, { parents: [], lamport: 1 })
	local("value", [], c, X, [[X, { v: 1 }]])
	scenario("no-versions", "an object with no versions: parents [], lamport 1, no base", [
		create(),
		versions([], "value", []),
		s,
		add(X),
		versions([X], "value", [[X, { v: 1 }]]),
	])
}

// ---- at version 0, along a line
{
	const A = mk({ patches: put({ v: 0 }) })
	const B1 = mk({ parents: [A], patches: set(["v"], 1) })
	const c: Commit = { at: { version: 0 }, patches: set(["v"], 2) }
	const [s, X] = commit(c, { parents: [B1], lamport: 3 })
	local("value", [[B1, { v: 1 }]], c, X, [[X, { v: 2 }]])
	scenario("version-0", "at version 0: parents its head, lamport one more", [
		create(),
		add(A),
		add(B1),
		s,
		add(X),
		versions([A, B1, X], "value", [[X, { v: 2 }]]),
	])
}

// ---- at version i, no reorder
{
	const A = mk({ patches: put({ v: 0 }) })
	const B1 = mk({ parents: [A], patches: set(["v"], 1) })
	const B2 = mk({ parents: [B1], patches: set(["v"], 2) })
	const B3 = mk({ parents: [B2], patches: set(["v"], 3) })
	const C = mk({ parents: [A], patches: set(["w"], 9) })
	const all = [A, B1, B2, B3, C]
	const before: V[] = [[B3, { v: 3 }], [C, { v: 0, w: 9 }]]
	const c: Commit = { at: { version: 1 }, patches: set(["w"], 10) }
	const [s, X] = commit(c, { parents: [C], lamport: 3 })
	const after: V[] = [[B3, { v: 3 }], [X, { v: 0, w: 10 }]]
	local("value", before, c, X, after)
	scenario(
		"version-i",
		"at version 1: parents [its head], no base; the other head stays; the order kept",
		[
			create(),
			...all.map((b) => add(b)),
			versions(all, "value", before),
			s,
			add(X),
			versions([...all, X], "value", after),
		],
	)
}

// ---- at version i, reordered
{
	const A = mk({ patches: put({ who: "a" }) })
	const B1 = mk({ patches: put({ who: "b" }) })
	const [H0, H1] = desc(A, B1)
	const before = contents([H0, H1], (h) => ({ who: h === A ? "a" : "b" }))
	const c: Commit = { at: { version: 1 }, patches: set(["n"], 1) }
	const [s, X] = commit(c, { parents: [H1], lamport: 2 })
	const after: V[] = [[X, { who: H1 === A ? "a" : "b", n: 1 }], before[0]]
	local("value", before, c, X, after)
	scenario(
		"version-reorder",
		"two roots, a change at version 1: lamport 2, so after it is taken in it comes first",
		[
			create(),
			add(A),
			add(B1),
			versions([A, B1], "value", before),
			s,
			add(X),
			versions([A, B1, X], "value", after),
		],
	)
}

// ---- a head with no side is no version: indices skip it
{
	const A = mk({ patches: put({ v: 0 }) })
	const E = mk({ parents: [A], patches: removal })
	const C = mk({ parents: [A], patches: set(["v"], 1) })
	const D = mk({ parents: [A], patches: set(["v"], 2) })
	const all = [A, E, C, D]
	const [H0, H1] = desc(C, D)
	const before = contents([H0, H1], (h) => ({ v: h === C ? 1 : 2 }))
	const c: Commit = { at: { version: 1 }, patches: set(["x"], 0) }
	const [s, X] = commit(c, { parents: [H1], lamport: 3 })
	const after: V[] = [[X, { ...before[1][1] as object, x: 0 }], before[0]]
	local("value", before, c, X, after)
	scenario(
		"version-skips-emptied",
		"version i: the i-th head that has a side; an emptied head counts for nothing",
		[
			create(),
			...all.map((b) => add(b)),
			versions(all, "value", before),
			s,
			add(X),
			versions([...all, X], "value", after),
		],
	)
}

// ---- a span of two: combine
{
	const A = mk({ patches: put({ v: 0 }) })
	const B1 = mk({ parents: [A], patches: set(["b"], 1) })
	const C = mk({ parents: [A], patches: set(["c"], 2) })
	const [H0, H1] = desc(B1, C)
	const before = contents([H0, H1], (h) => h === B1 ? { v: 0, b: 1 } : { v: 0, c: 2 })
	const merged = H0 === B1 ? set(["c"], 2) : set(["b"], 1)
	const c: Commit = { at: { span: [0, 2] }, patches: merged }
	const [s, X] = commit(c, { parents: [H0, H1], base: H0, combine: true, lamport: 3 })
	const after: V[] = [[X, { v: 0, b: 1, c: 2 }]]
	local("value", before, c, X, after)
	// version order is name order reversed (equal lamport): parents sorted the other way
	assertEquals(H0.name > H1.name, true)
	scenario(
		"span-two",
		"a span of two merged: parents both heads sorted bytewise, base the span's first, combine",
		[
			create(),
			add(A),
			add(B1),
			add(C),
			versions([A, B1, C], "value", before),
			s,
			add(X),
			side(X, { v: 0, b: 1, c: 2 }),
			versions([A, B1, C, X], "value", after),
		],
	)
}

// ---- a span of all three, lamport from the highest
{
	const A = mk({ patches: put([]) })
	const B1 = mk({ parents: [A], patches: [{ path: [], range: [0, 0], value: ["b"] }] })
	const C = mk({ parents: [A], patches: [{ path: [], range: [0, 0], value: ["c"] }] })
	const D = mk({ parents: [A], patches: [{ path: [], range: [0, 0], value: ["d"] }] })
	const E1 = mk({ parents: [B1], patches: [{ path: [], range: [1, 1], value: ["e"] }] })
	const E2 = mk({ parents: [E1], patches: [{ path: [], range: [2, 2], value: ["f"] }] })
	const all = [A, B1, C, D, E1, E2]
	// E2 (lamport 4) first, then C and D (2) by name
	const [H1, H2] = desc(C, D)
	const before = contents(
		[E2, H1, H2],
		(h) => h === E2 ? ["b", "e", "f"] : h === C ? ["c"] : ["d"],
	)
	const c: Commit = {
		at: { span: [0, 3] },
		patches: [{ path: [], range: [3, 3], value: ["c", "d"] }],
	}
	const [s, X] = commit(c, { parents: [E2, C, D], base: E2, combine: true, lamport: 5 })
	const after: V[] = [[X, ["b", "e", "f", "c", "d"]]]
	local("value", before, c, X, after)
	scenario(
		"span-three",
		"a span of three: every head a parent, base the first in version order, lamport one more than the highest",
		[
			create(),
			...all.map((b) => add(b)),
			versions(all, "value", before),
			s,
			add(X),
			versions([...all, X], "value", after),
		],
	)
}

// ---- a span inside: the versions around it stay
{
	const A = mk({ patches: put(0) })
	const B1 = mk({ parents: [A], patches: put(1) })
	const B2 = mk({ parents: [B1], patches: put(2) })
	const C = mk({ parents: [A], patches: put(3) })
	const D = mk({ parents: [A], patches: put(4) })
	const all = [A, B1, B2, C, D]
	const [H1, H2] = desc(C, D)
	const before = contents([B2, H1, H2], (h) => h === B2 ? 2 : h === C ? 3 : 4)
	const c: Commit = { at: { span: [1, 3] }, patches: put(7) }
	const [s, X] = commit(c, { parents: [H1, H2], base: H1, combine: true, lamport: 3 })
	// X and B2 both lamport 3: the greater name first
	const after: V[] = first(X, B2) ? [[X, 7], [B2, 2]] : [[B2, 2], [X, 7]]
	local("value", before, c, X, after)
	scenario("span-inside", "a span [1, 3) of three: merged at 1; version 0's head stays a head", [
		create(),
		...all.map((b) => add(b)),
		versions(all, "value", before),
		s,
		add(X),
		versions([...all, X], "value", after),
	])
}

// ---- a span of one: a change at that version
{
	const A = mk({ patches: put({ v: 0 }) })
	const B1 = mk({ parents: [A], patches: set(["v"], 1) })
	const C = mk({ parents: [A], patches: set(["v"], 2) })
	const [H0, H1] = desc(B1, C)
	const before = contents([H0, H1], (h) => ({ v: h === B1 ? 1 : 2 }))
	const c: Commit = { at: { span: [1, 2] }, patches: set(["one"], true) }
	const [s, X] = commit(c, { parents: [H1], lamport: 3 })
	const after: V[] = [[X, { ...before[1][1] as object, one: true }], before[0]]
	local("value", before, c, X, after)
	scenario("span-one", "a span of one: parents [its head], no base, no combine", [
		create(),
		add(A),
		add(B1),
		add(C),
		s,
		add(X),
		versions([A, B1, C, X], "value", after),
	])
}

// ---- an empty span
{
	const A = mk({ patches: put(0) })
	const B1 = mk({ patches: put(1) })
	scenario("span-empty", "an empty span: range, no blop", [
		create(),
		add(A),
		add(B1),
		refuses({ at: { span: [1, 1] }, patches: put(2) }, "range"),
		refuses({ at: { span: [0, 0] }, patches: put(2) }, "range"),
	])
}

// three heads of lamport 2 from one root, contents by head
function three() {
	const A = mk({ patches: put("root") })
	const B1 = mk({ parents: [A], patches: put("b") })
	const C = mk({ parents: [A], patches: put("c") })
	const D = mk({ parents: [A], patches: put("d") })
	const hs = desc(B1, C, D)
	const content = (h: B) => h === B1 ? "b" : h === C ? "c" : "d"
	return { all: [A, B1, C, D], hs, before: contents(hs, content), content }
}

// ---- pop keeping one: the first kept
{
	const { all, hs, before, content } = three()
	const c: Commit = { at: { pop: [0, 2] } }
	const [s, X] = commit(c, { parents: hs, base: hs[2], lamport: 3, patches: [] })
	const after: V[] = [[X, content(hs[2])]]
	local("value", before, c, X, after)
	scenario(
		"pop-keep-last",
		"pop versions 0 and 1 of three: parents the popped and the kept, base the kept, no patches",
		[
			create(),
			...all.map((b) => add(b)),
			versions(all, "value", before),
			s,
			add(X),
			side(X, content(hs[2])),
			versions([...all, X], "value", after),
		],
	)
}

// ---- pop one: the first kept is version 0, the rest stay
{
	const { all, hs, before, content } = three()
	const c: Commit = { at: { pop: 1 } }
	const [s, X] = commit(c, { parents: [hs[0], hs[1]], base: hs[0], lamport: 3, patches: [] })
	const after: V[] = [[X, content(hs[0])], [hs[2], content(hs[2])]]
	local("value", before, c, X, after)
	scenario(
		"pop-middle",
		"pop version 1 of three: parents it and version 0's head, base version 0's; version 2 stays",
		[
			create(),
			...all.map((b) => add(b)),
			s,
			add(X),
			versions([...all, X], "value", after),
		],
	)
}

// ---- pop all: one popped
{
	const A = mk({ patches: put("a") })
	const B1 = mk({ parents: [A], patches: put("b") })
	const c: Commit = { at: { pop: 0 } }
	const [s, X] = commit(c, { parents: [B1], lamport: 3, patches: removal })
	local("value", [[B1, "b"]], c, X, [])
	scenario("pop-all-one", "pop the only version: parents [it], no base, a removal at []", [
		create(),
		add(A),
		add(B1),
		s,
		add(X),
		side(X, none),
		versions([A, B1, X], "value", []),
	])
}

// ---- pop all: two popped
{
	const A = mk({ patches: put("a") })
	const B1 = mk({ patches: put("b") })
	const [H0, H1] = desc(A, B1)
	const before = contents([H0, H1], (h) => h === A ? "a" : "b")
	const c: Commit = { at: { pop: [0, 2] } }
	const [s, X] = commit(c, { parents: [H0, H1], base: H0, lamport: 2, patches: removal })
	local("value", before, c, X, [])
	scenario("pop-all-two", "pop both versions: a removal at [], base the first popped", [
		create(),
		add(A),
		add(B1),
		s,
		add(X),
		side(X, none),
		versions([A, B1, X], "value", []),
	])
}

// ---- pop nothing
{
	const A = mk({ patches: put("a") })
	scenario("pop-nothing", "popping nothing: range, no blop", [
		create(),
		add(A),
		refuses({ at: { pop: [0, 0] } }, "range"),
		refuses({ at: { pop: [1, 1] } }, "range"),
	])
}

// ---- a change that empties: never reorders
{
	const A = mk({ patches: put({ v: 0 }) })
	const B1 = mk({ parents: [A], patches: set(["v"], 1) })
	const C = mk({ parents: [A], patches: set(["v"], 2) })
	const [H0, H1] = desc(B1, C)
	const before = contents([H0, H1], (h) => ({ v: h === B1 ? 1 : 2 }))
	const c: Commit = { at: { version: 1 }, patches: removal }
	const [s, X] = commit(c, { parents: [H1], lamport: 3 })
	const after: V[] = [before[0]]
	local("value", before, c, X, after)
	scenario(
		"version-empties",
		"a change at version 1 that empties: parents [its head]; after, that version is gone",
		[
			create(),
			add(A),
			add(B1),
			add(C),
			s,
			add(X),
			side(X, none),
			versions([A, B1, C, X], "value", after),
		],
	)
}

// ---- an emptied object: no versions, so no parents
{
	const A = mk({ patches: put("a") })
	const E = mk({ parents: [A], patches: removal })
	const c: Commit = { at: { version: 0 }, patches: put("again") }
	const [s, X] = commit(c, { parents: [], lamport: 1 })
	local("value", [], c, X, [[X, "again"]])
	scenario(
		"emptied-object",
		"an object whose only head has no side has no versions: parents [], lamport 1",
		[
			create(),
			add(A),
			add(E),
			versions([A, E], "value", []),
			s,
			add(X),
			versions([A, E, X], "value", [[X, "again"]]),
		],
	)
}

// ---- another object
{
	const V0 = mk({ patches: put("v") })
	const c: Commit = { at: { version: 0 }, object: INFO, patches: put("t") }
	const [s, X] = commit(c, { parents: [], lamport: 1 })
	const c2: Commit = { at: { version: 0 }, object: INFO, patches: put("u") }
	const [s2, Y] = commit(c2, { parents: [X], lamport: 2 })
	scenario("info", "an info object: its own chain; the value's head is not a parent", [
		create(),
		add(V0),
		s,
		add(X),
		s2,
		add(Y),
		versions([V0, X, Y], INFO, [[Y, "u"]]),
		versions([V0, X, Y], "value", [[V0, "v"]]),
	])
}

// ---- the header
{
	const header: Header = {
		time: 123456,
		actor: { who: "w", trust: 2 },
		reader: "r",
		site: { file: "https://example.org/a.ts", line: 4, column: 2, function: "go" },
		cause: { why: "save" },
	}
	const c: Commit = { at: { version: 0 }, patches: put(1), header }
	const [s, X] = commit(c, {
		parents: [],
		lamport: 1,
		site: { file: "https://example.org/a.ts", line: 4, column: 2, function: "go" },
	})
	X.time = 555
	scenario(
		"header",
		"actor, reader, cause as given; an https site kept; time never in the blop, the version's the caller's",
		[create(), s, add(X), versions([X], "value", [[X, 1]])],
	)
}

// ---- a bare header
{
	const c: Commit = { at: { version: 0 }, patches: put(1), header: { time: 1, actor: null } }
	const [s] = commit(c, { parents: [], lamport: 1 })
	scenario("header-bare", "actor null kept; no reader, site or cause: none in the blop", [
		create(),
		s,
	])
}

// ---- the site made shareable
const sited = (file: string, roots: string[], shared: string) =>
	commit({
		at: { version: 0 },
		patches: put(1),
		roots,
		header: { time: 1, actor: "me", site: { file, line: 9, column: 1 } },
	}, { parents: [], lamport: 1, site: { file: shared, line: 9, column: 1 } })[0]
const SITES: [string, string, [string, string[], string][]][] = [
	["site-under-root", "an absolute path under a root: relative to it, parts joined by /", [
		["/w/proj/src/a.ts", ["/w/proj"], "src/a.ts"],
		["/w/proj/a.ts", ["/elsewhere", "/w/proj"], "a.ts"],
	]],
	["site-nested-roots", "under nested roots: the nearest", [
		["/w/proj/src/a.ts", ["/w", "/w/proj"], "src/a.ts"],
		["/w/proj/src/a.ts", ["/w/proj", "/w"], "src/a.ts"],
		["/w/lib/b.ts", ["/w", "/w/proj"], "lib/b.ts"],
	]],
	["site-no-root", "under no root: its last part", [
		["/w/proj/src/a.ts", [], "a.ts"],
		["/w/proj/src/a.ts", ["/x"], "a.ts"],
		["/w/project/a.ts", ["/w/proj"], "a.ts"],
	]],
	["site-file-url", "a file:// URL: a local path, made the same way", [
		["file:///w/proj/src/a.ts", ["/w/proj"], "src/a.ts"],
		["file:///w/proj/src/a.ts", [], "a.ts"],
	]],
	["site-drive-letter", "a path with a drive letter: a local path, made the same way", [
		["C:\\w\\proj\\src\\a.ts", ["C:\\w\\proj"], "src/a.ts"],
		["C:\\w\\proj\\src\\a.ts", [], "a.ts"],
	]],
	["site-kept", "other files kept: https, a relative path", [
		["https://example.org/x/a.ts", ["/w"], "https://example.org/x/a.ts"],
		["src/a.ts", ["/w"], "src/a.ts"],
	]],
]
for (const [name, title, cases] of SITES) {
	scenario(name, title, [create(), ...cases.map(([f, r, s]) => sited(f, r, s))])
}

// ---- two devices
{
	const A = mk({ patches: put({ v: 0 }) })
	const c1: Commit = { at: { version: 0 }, patches: set(["one"], 1), signer: DEV1 }
	const [s1, X] = commit(c1, { parents: [A], lamport: 2 })
	const c2: Commit = { at: { version: 0 }, patches: set(["two"], 2), signer: DEV2 }
	const [s2, Y] = commit(c2, { parents: [A], lamport: 2 })
	local("value", [[A, { v: 0 }]], c1, X, [[X, { v: 0, one: 1 }]])
	local("value", [[A, { v: 0 }]], c2, Y, [[Y, { v: 0, two: 2 }]])
	const both = contents(desc(X, Y), (h) => h === X ? { v: 0, one: 1 } : { v: 0, two: 2 })
	const all = [A, X, Y]
	scenario(
		"two-devices",
		"two devices commit at once, then exchange: each takes the other's in, the same versions on both",
		[
			// device one
			create(),
			add(A),
			s1,
			add(X),
			versions([A, X], "value", [[X, { v: 0, one: 1 }]]),
			// device two: its own, then one's
			create(),
			add(A),
			s2,
			add(Y),
			add(X),
			versions(all, "value", both),
			// device one again, as it was, taking two's in
			create(),
			add(A),
			add(X),
			add(Y),
			versions(all, "value", both),
		],
	)
}

// ---- concurrent pops of different versions keep both
{
	const A = mk({ patches: put("a") })
	const B1 = mk({ parents: [A], patches: put("b") })
	const C = mk({ parents: [A], patches: put("c") })
	const [H0, H1] = desc(B1, C)
	const content = (h: B) => h === B1 ? "b" : "c"
	const before = contents([H0, H1], content)
	const c1: Commit = { at: { pop: 0 }, signer: DEV1 }
	const [s1, P] = commit(c1, { parents: [H0, H1], base: H1, lamport: 3, patches: [] })
	const c2: Commit = { at: { pop: 1 }, signer: DEV2 }
	const [s2, Q] = commit(c2, { parents: [H0, H1], base: H0, lamport: 3, patches: [] })
	local("value", before, c1, P, [[P, content(H1)]])
	local("value", before, c2, Q, [[Q, content(H0)]])
	const both = contents(desc(P, Q), (h) => h === P ? content(H1) : content(H0))
	const all = [A, B1, C, P, Q]
	scenario(
		"concurrent-pops",
		"two devices pop different versions: each chose another; after the exchange both choices show",
		[
			create(),
			add(A),
			add(B1),
			add(C),
			s1,
			add(P),
			versions([A, B1, C, P], "value", [[P, content(H1)]]),
			create(),
			add(A),
			add(B1),
			add(C),
			s2,
			add(Q),
			add(P),
			versions(all, "value", both),
			create(),
			add(A),
			add(B1),
			add(C),
			add(P),
			add(Q),
			versions(all, "value", both),
		],
	)
}

// ---- a live value in the patches: a stand-in in the blop
// {"$live": kind} is the marker the reference harness makes a live value of (harness.ts); an
// implementation with no live values skips these two (COMMIT_SKIP)
{
	const live = (kind: unknown) => ({ $live: kind })
	const c: Commit = {
		at: { version: 0 },
		patches: put({
			canvas: live("canvas"),
			shape: live({ url: "x", w: 2 }),
			bare: live(null),
			list: [1, live("in a list")],
			plain: { "$live": 1, other: 2 },
		}),
	}
	const stood = {
		canvas: new Stand("canvas"),
		shape: new Stand({ url: "x", w: 2 }),
		bare: new Stand(null),
		list: [1, new Stand("in a list")],
		plain: { "$live": 1, other: 2 },
	}
	const [s, X] = commit(c, { parents: [], lamport: 1, patches: put(stood) })
	local("value", [], { ...c, patches: put(stood) }, X, [[X, stood]])
	scenario(
		"live-stand-in",
		"a live value in the patches is written as a stand-in over the host's kind(value), null with none; it syncs as data",
		[
			create(),
			s,
			add(X),
			versions([X], "value", [[X, stood]]),
		],
	)
}

// ---- a live value as the actor or the cause
{
	const header: Header = { time: 77, actor: { $live: "device" }, cause: { why: { $live: null } } }
	const c: Commit = { at: { version: 0 }, patches: put(1), header }
	const [s, X] = commit(c, {
		parents: [],
		lamport: 1,
		actor: new Stand("device"),
		cause: { why: new Stand(null) },
	})
	local("value", [], c, X, [[X, 1]])
	scenario(
		"live-actor-cause",
		"a live value in the actor or the cause is written as a stand-in too",
		[
			create(),
			s,
			add(X),
			versions([X], "value", [[X, 1]]),
		],
	)
}

await write(new URL("../../sync/conformance/commit/", import.meta.url))
