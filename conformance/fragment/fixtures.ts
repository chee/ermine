// Writes the fragment scenarios to newcore/sync/conformance/fragment/NN-short-name.json.
//   deno run --allow-read --allow-write --allow-run conformance/fragment/fixtures.ts
// Expected answers come from the oracle (oracle/: Subduction's own build_fragment_store and
// fragment from sedimentree_core 0.14.2, built here with cargo), never from fragment.ts. Each
// scenario also carries an answer reasoned by hand from commit.rs; the two must agree or nothing
// is written.
// A scenario: {title, names, request, expect}. names maps each id to the letter it is drawn with
// below (for reading only); request is a harness request (harness.ts), expect its answer.
// Commits are drawn as name(depth); a ← b: a is b's parent.
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import { assertEquals } from "@std/assert"
import { type Answer, ask, type Commit, type Fragment, idOf, make, type Request } from "./oracle.ts"

const out = new URL("../suites-aside/sync/subduction/conformance/fragment/", import.meta.url)

// a commit's id: BLAKE3 of its name, cut to its depth
const ids = new Map<string, string>()
const names = new Map<string, string>()
function id(name: string, depth: number): string {
	const known = ids.get(`${name}:${depth}`)
	if (known) return known
	const x = idOf(blake3(new TextEncoder().encode(`${name}:${depth}`)), depth)
	ids.set(`${name}:${depth}`, x)
	names.set(x, name)
	return x
}
const sorted = (xs: string[]) => [...xs].sort()

// a DAG: "name:depth:parent,parent" each
type Dag = { commits: Commit[]; id: (name: string) => string }
function dag(...spec: string[]): Dag {
	const depth = new Map<string, number>()
	for (const s of spec) {
		const [n, d] = s.split(":")
		depth.set(n, Number(d))
	}
	const at = (n: string) => {
		if (!depth.has(n)) throw new Error(`no depth for ${n}`)
		return id(n, depth.get(n)!)
	}
	const commits: Commit[] = []
	for (const s of spec) {
		const [n, , p = ""] = s.split(":")
		if (s.split(":").length < 3) continue // drawn only: not here
		commits.push({ id: at(n), parents: sorted(p ? p.split(",").map(at) : []) })
	}
	return { commits, id: at }
}

// a fragment, by names
const F = (g: Dag, head: string, members: string, boundary = "", checkpoints = ""): Fragment => {
	const l = (s: string) => sorted(s ? s.split(" ").map(g.id) : [])
	return {
		head: g.id(head),
		members: l(members),
		boundary: l(boundary),
		checkpoints: l(checkpoints),
	}
}
const bare = ({ members, boundary, checkpoints }: Fragment) => ({ members, boundary, checkpoints })

type Fixture = { name: string; title: string; request: Request; hand: Answer }
const all: Fixture[] = []
const build = (
	name: string,
	title: string,
	g: Dag,
	heads: string,
	hand: Fragment[],
	known: Fragment[] = [],
) =>
	all.push({
		name,
		title,
		request: { op: "build", commits: g.commits, heads: heads.split(" ").map(g.id), known },
		hand: { fragments: [...hand].sort((a, b) => a.head < b.head ? -1 : 1) },
	})
const walk = (
	name: string,
	title: string,
	g: Dag,
	head: string,
	hand: Fragment | "missing" | "depth-zero",
	known: Fragment[] = [],
) =>
	all.push({
		name,
		title,
		request: { op: "walk", commits: g.commits, head: g.id(head), known },
		hand: typeof hand === "string" ? { error: hand } : bare(hand),
	})

// ---- a line

{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:0:c")
	build(
		"line-one-deep",
		"a(0) ← b(1) ← c(0) ← d(0): one fragment b {a b}; c, d stay loose",
		g,
		"d",
		[
			F(g, "b", "a b"),
		],
	)
	walk("walk-line", "walk from b: members b and a, no boundary", g, "b", F(g, "b", "a b"))
}
{
	const g = dag("a0:0:", "b0:0:a0", "c0:0:b0")
	build("line-all-loose", "every commit depth 0: no fragments", g, "c0", [])
}

// ---- nested depths

{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:2:c", "e:0:d", "f:1:e", "g:0:f")
	build(
		"nested",
		"a(0) ← b(1) ← c(0) ← d(2) ← e(0) ← f(1) ← g(0): f {e f} bounded by d; d {a b c d}, b its checkpoint",
		g,
		"g",
		[F(g, "f", "e f", "d"), F(g, "d", "a b c d", "", "b")],
	)
	walk(
		"walk-deeper-boundary",
		"walk from f: d, deeper, is the boundary",
		g,
		"f",
		F(g, "f", "e f", "d"),
	)
}
{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:1:c", "e:0:d", "f:2:e", "g:0:f")
	build(
		"nested-two-checkpoints",
		"a(0) ← b(1) ← c(0) ← d(1) ← e(0) ← f(2) ← g(0): one fragment f, checkpoints b and d",
		g,
		"g",
		[F(g, "f", "a b c d e f", "", "b d")],
	)
}
{
	const g = dag("a:1:", "b:2:a", "c:0:b", "d:3:c", "e:0:d")
	build(
		"nested-three",
		"a(1) ← b(2) ← c(0) ← d(3): d takes in all; checkpoints a and b",
		g,
		"e",
		[F(g, "d", "a b c d", "", "a b")],
	)
}

// ---- same depth as the head: a boundary

{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:1:c", "e:0:d")
	build(
		"same-depth-boundary",
		"a(0) ← b(1) ← c(0) ← d(1) ← e(0): b is d's boundary; two fragments",
		g,
		"e",
		[F(g, "d", "c d", "b"), F(g, "b", "a b")],
	)
	walk(
		"walk-same-depth",
		"walk from d: b, the same depth, is the boundary",
		g,
		"d",
		F(g, "d", "c d", "b"),
	)
}
{
	const g = dag("a:0:", "b:2:a", "c:0:b", "d:3:c", "e:0:d", "f:2:e")
	build(
		"deeper-than-head",
		"a(0) ← b(2) ← c(0) ← d(3) ← e(0) ← f(2): f bounded by d (deeper); d takes in b as a checkpoint",
		g,
		"f",
		[F(g, "f", "e f", "d"), F(g, "d", "a b c d", "", "b")],
	)
}

// ---- merges

{
	const g = dag("a:0:", "b:0:a", "c:0:a", "d:1:b,c", "e:0:d")
	build("merge-diamond", "a ← b, c ← d(1): d {a b c d}", g, "e", [F(g, "d", "a b c d")])
}
{
	const g = dag("a:2:", "x:0:a", "b:0:x", "c:0:x", "d:1:b,c", "e:0:d")
	build(
		"merge-deeper-below",
		"a(2) ← x ← b, c ← d(1): d {b c d x} bounded by a; a {a}",
		g,
		"e",
		[F(g, "d", "b c d x", "a"), F(g, "a", "a")],
	)
}
{
	const g = dag("a:0:", "b:1:a", "c:1:a")
	build(
		"merge-siblings-share",
		"a(0) ← b(1), a ← c(1), heads b and c: both hold a (neither reached from the other)",
		g,
		"b c",
		[F(g, "b", "a b"), F(g, "c", "a c")],
	)
}
{
	const g = dag("r:0:", "x:1:r", "y:1:r", "m:2:x,y", "n:0:m")
	build(
		"merge-deep",
		"r ← x(1), r ← y(1), x, y ← m(2): m {m r x y}, checkpoints x and y",
		g,
		"n",
		[F(g, "m", "m r x y", "", "x y")],
	)
}

// ---- a commit not here

{
	const g = dag("a:0", "b:1:a", "c:0:b", "d:1:c", "e:0:d")
	walk("missing-walk", "walk from b: its parent a is not here", g, "b", "missing")
	build(
		"missing-skips-head",
		"a not here: no fragment for b; d {c d} still built",
		g,
		"e",
		[F(g, "d", "c d", "b")],
	)
}
{
	const g = dag("b:1", "c:0:b", "d:1:c", "x:0:", "y:2:x", "z:0:y")
	walk("missing-boundary", "walk from d: the boundary b is not here", g, "d", "missing")
	build(
		"missing-goes-on",
		"heads d (its boundary b not here) and z: d skipped, y still built",
		g,
		"d z",
		[F(g, "y", "x y")],
	)
}
{
	const g = dag("h:1", "q:0", "a:0:", "b:1:a")
	walk("missing-head", "walk from h, not here", g, "h", "missing")
	build("missing-heads", "heads h(1) and q(0) not here, b here: only b", g, "h q b", [
		F(g, "b", "a b"),
	])
}

// ---- depth-0 heads

{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:0:c", "e:0:c")
	walk("depth-zero-walk", "walk from d(0): refused", g, "d", "depth-zero")
	build(
		"depth-zero-heads",
		"heads d(0) and e(0), both on c(0) on b(1): walked past to b",
		g,
		"d e",
		[F(g, "b", "a b")],
	)
}
{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:1:c")
	build("heads-twice", "the same head given twice: built once", g, "d d", [
		F(g, "d", "c d", "b"),
		F(g, "b", "a b"),
	])
}

// ---- fragments here already

{
	const g = dag("a:0:", "b:1:a", "c:0:b", "d:1:c", "e:0:d")
	build(
		"known-reused",
		"b's fragment here already: only d is new",
		g,
		"e",
		[F(g, "d", "c d", "b")],
		[F(g, "b", "a b")],
	)
	build(
		"known-walked-past",
		"d's fragment here already: passed through to b, which is new",
		g,
		"e",
		[F(g, "b", "a b")],
		[F(g, "d", "c d", "b")],
	)
	build(
		"known-all",
		"both here already: nothing new",
		g,
		"e",
		[],
		[F(g, "d", "c d", "b"), F(g, "b", "a b")],
	)
}
{
	const g = dag("c:0:", "b:1:c", "d:1:b,c")
	walk(
		"known-strips-walk",
		"c ← b(1), b, c ← d(1); b's fragment {b c} here: d loses c",
		g,
		"d",
		F(g, "d", "d", "b"),
		[F(g, "b", "b c")],
	)
	walk(
		"known-recorded-members",
		"the same, b's fragment recorded as {b}: d keeps c",
		g,
		"d",
		F(g, "d", "c d", "b"),
		[F(g, "b", "b")],
	)
	walk(
		"unknown-keeps-walk",
		"the same, no fragment here: d keeps c",
		g,
		"d",
		F(g, "d", "c d", "b"),
	)
	build(
		"build-strips-inline",
		"the same built from d: b {b c}, d {d}",
		g,
		"d",
		[F(g, "d", "d", "b"), F(g, "b", "b c")],
	)
}
{
	const g = dag("r:0:", "x:1:r", "b:2:x", "h:2:x,b")
	walk(
		"known-strips-checkpoint",
		"r ← x(1) ← b(2), x, b ← h(2); b's fragment {b r x}: x leaves h's members and checkpoints",
		g,
		"h",
		F(g, "h", "h", "b"),
		[F(g, "b", "b r x", "", "x")],
	)
	walk(
		"checkpoint-kept",
		"the same, no fragment here: x a checkpoint of h",
		g,
		"h",
		F(g, "h", "h r x", "b", "x"),
	)
}
{
	// a fragment taken in whose head is not here: its members are the blob's
	const g = dag("a:0", "k:1", "z:2:", "e:0:k")
	build(
		"known-head-not-here",
		"e(0) on k, not here but its fragment is (boundary z): passed through k to z",
		g,
		"e",
		[F(g, "z", "z")],
		[F(g, "k", "a k", "z")],
	)
}

// ---- the post-pass

{
	const g = dag("c:0:", "f_deep:2:c", "other:0:c", "f_mid:1:f_deep", "f_shallow:1:f_mid,other")
	build(
		"post-pass",
		"Subduction's members_disjoint_from_transitive_ancestor_members: f_shallow reaches c, f_deep's member, through other; c leaves f_shallow",
		g,
		"f_shallow",
		[
			F(g, "f_shallow", "f_shallow other", "f_mid"),
			F(g, "f_mid", "f_mid", "f_deep"),
			F(g, "f_deep", "c f_deep"),
		],
	)
	walk(
		"post-pass-not-in-walk",
		"the same walk alone: c stays (the post-pass is the build's)",
		g,
		"f_shallow",
		F(g, "f_shallow", "c f_shallow other", "f_mid"),
	)
	build(
		"post-pass-known",
		"the same, f_mid and f_deep here already: f_shallow still loses c",
		g,
		"f_shallow",
		[F(g, "f_shallow", "f_shallow other", "f_mid")],
		[F(g, "f_mid", "f_mid", "f_deep"), F(g, "f_deep", "c f_deep")],
	)
}
{
	const g = dag(
		"root:0:",
		"d_left:2:root",
		"d_right:2:root",
		"m_left:0:d_left",
		"m_right:0:d_right",
		"mid_left:1:m_left",
		"mid_right:1:m_right",
		"top:1:mid_left,mid_right",
		"head:0:top",
	)
	build(
		"post-pass-lanes",
		"Subduction's complex concurrent DAG: two lanes from root; d_left and d_right both hold root (siblings)",
		g,
		"head",
		[
			F(g, "top", "top", "mid_left mid_right"),
			F(g, "mid_left", "m_left mid_left", "d_left"),
			F(g, "mid_right", "m_right mid_right", "d_right"),
			F(g, "d_left", "d_left root"),
			F(g, "d_right", "d_right root"),
		],
	)
}

// ---- whoever made the commits

{
	// mine: m*, theirs (taken in): t*, from one root
	const g = dag("r:0:", "m1:0:r", "m2:1:m1", "m3:0:m2", "t1:0:r", "t2:1:t1", "t3:2:t2", "t4:0:t3")
	build(
		"any-device",
		"my commits m* and ones taken in t*, both heads: fragments for both",
		g,
		"m3 t4",
		[F(g, "m2", "m1 m2 r"), F(g, "t3", "r t1 t2 t3", "", "t2")],
	)
	build(
		"any-device-merged",
		"the same after mine merges theirs (x(0) on m3 and t4): the same fragments",
		dag(
			"r:0:",
			"m1:0:r",
			"m2:1:m1",
			"m3:0:m2",
			"t1:0:r",
			"t2:1:t1",
			"t3:2:t2",
			"t4:0:t3",
			"x:0:m3,t4",
		),
		"x",
		[F(g, "m2", "m1 m2 r"), F(g, "t3", "r t1 t2 t3", "", "t2")],
	)
}

// ---- write

await make()
const answers = await ask(all.map((f) => f.request))
let bad = 0
all.forEach((f, i) => {
	try {
		assertEquals(answers[i], f.hand)
	} catch (e) {
		bad++
		console.error(`${f.name}: the oracle and the hand answer differ\n${(e as Error).message}`)
	}
})
if (bad) Deno.exit(1)

for (const e of Deno.readDirSync(out)) {
	if (e.name.endsWith(".json")) Deno.removeSync(new URL(e.name, out))
}
all.forEach((f, i) => {
	const used = new Set<string>([
		...f.request.commits.flatMap((c) => [c.id, ...c.parents]),
		...(f.request.op === "build" ? f.request.heads : [f.request.head]),
		...f.request.known.flatMap((k) => [k.head, ...k.members, ...k.boundary, ...k.checkpoints]),
	])
	const named = Object.fromEntries(sorted([...used]).map((x) => [x, names.get(x)]))
	const scenario = { title: f.title, names: named, request: f.request, expect: answers[i] }
	const file = `${String(i + 1).padStart(2, "0")}-${f.name}.json`
	Deno.writeTextFileSync(new URL(file, out), JSON.stringify(scenario, null, "\t") + "\n")
})
console.log(`${all.length} scenarios`)
