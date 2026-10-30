// the planted bugs: each a small exact mutation of one TS source file that breaks a real rule,
// and the run that has to catch it. a plant is a finding when it survives: some rule nothing
// checks. paths from the repo root. find must match exactly once, or the plant is stale.
//   fuzz: an in-process fuzz test file (deno test), fixed seeds in the file
//   differ: a differ suite, asked of impls (default typescript,c: a disagreement is a finding;
//     typescript alone: only the per-implementation invariants and models can catch it)

export type Catcher = { fuzz: string } | { differ: string; impls?: string }
export type Plant = { name: string; file: string; find: string; replace: string; catcher: Catcher }

const T = "typescript"
const sched = `reactivity/${T}/scheduler.ts`
const fuzzSched = { fuzz: `reactivity/${T}/scheduler_fuzz_test.ts` }
const fuzzPaths = { fuzz: `reactivity/${T}/paths_fuzz_test.ts` }
const fuzzUpdate = { fuzz: `changeable/${T}/update_fuzz_test.ts` }
const fuzzApply = { fuzz: `changeable/${T}/apply_fuzz_test.ts` }
const fuzzCrow = { fuzz: `crow/${T}/crow_fuzz_test.ts` }
const fuzzEnd = { fuzz: `places/fuzz/end_to_end_fuzz_test.ts` }
const fuzzPlacesPaths = { fuzz: `places/fuzz/places_paths_fuzz_test.ts` }
const fuzzPlacesUpdate = { fuzz: `places/fuzz/places_update_fuzz_test.ts` }
const fuzzPlaces = { fuzz: `places/${T}/places_fuzz_test.ts` }

export const plants: Plant[] = [
	// scheduler
	{
		name: "scheduler: a result is never equal to the last (cutoff gone)",
		file: sched,
		find: "equal = c.last !== undefined && same(c.equal, v, c.last.value)",
		replace: "equal = false",
		catcher: fuzzSched,
	},
	{
		name: "scheduler: a dropped computer keeps its links (untrack skipped)",
		file: sched,
		find: "\t\ttracker.untrack(c.node)\n\t\tfor (const node of read) unread(node)",
		replace: "\t\tfor (const node of read) unread(node)",
		catcher: fuzzSched,
	},
	{
		name: "scheduler: a change skips the first reader of a key (skipped notify)",
		file: sched,
		find: "for (let l = node.first; l !== null; l = l.after) {\n\t\t\t\tconst c = l.from.owner",
		replace:
			"for (let l = node.first?.after ?? null; l !== null; l = l.after) {\n\t\t\t\tconst c = l.from.owner",
		catcher: fuzzSched,
	},
	{
		name: "scheduler: an effect acts although due again (stale act)",
		file: sched,
		find: "if (order.has(c)) {\n\t\t\tc.cleaned = true",
		replace: "if (false) {\n\t\t\tc.cleaned = true",
		catcher: fuzzSched,
	},
	{
		name: "scheduler: a reader ranks level with its source, not above (diamond)",
		file: `reactivity/${T}/order.ts`,
		find: "if (edge(x, q)) k = Math.max(k, rankOf(q) + 1)",
		replace: "if (edge(x, q)) k = Math.max(k, rankOf(q))",
		catcher: fuzzSched,
	},
	// tracker
	{
		name: "tracker: end keeps the reads a run did not read again",
		file: `reactivity/${T}/tracker.ts`,
		find: "\t\t\tstale = cursor.next\n\t\t\tcursor.next = null",
		replace: "\t\t\tstale = null",
		catcher: { differ: "tracker" },
	},
	{
		name: "tracker: untrack(from) leaves the links in the readers' lists",
		file: `reactivity/${T}/tracker.ts`,
		find: "for (let l = f.reads; l !== null; l = l.next) drop(l)\n\t\t\tf.reads = null",
		replace: "f.reads = null",
		catcher: { differ: "tracker" },
	},
	// paths
	{
		name: "paths: a range put marks from one element too late (off by one)",
		file: `reactivity/${T}/paths.ts`,
		find: "return q.n === b - a ? k >= a && k < b : k >= a",
		replace: "return q.n === b - a ? k >= a && k < b : k > a",
		catcher: fuzzPaths,
	},
	{
		name: "paths: a removed list element marks the next one too late",
		file: `reactivity/${T}/paths.ts`,
		find: 'typeof path[i] === "number" && path[i] > Q[i]',
		replace: 'typeof path[i] === "number" && path[i] > Q[i] + 1',
		catcher: fuzzPaths,
	},
	// table
	{
		name: "table: a different entry at a taken key is replaced, not refused",
		file: `graph/${T}/table.ts`,
		find: 'if (there !== undefined) throw new TableError("already-there", part, id)',
		replace: "if (there !== undefined) take(part, id, there)",
		catcher: { differ: "table" },
	},
	{
		name: "table: sub leaves the old entry listed under the key",
		file: `graph/${T}/table.ts`,
		find: "\t\tif (there !== undefined) take(part, id, there)\n\t\tput(part, id, node)",
		replace: "\t\tput(part, id, node)",
		catcher: { differ: "table" },
	},
	{
		name: "table: deleting an entry from every key tells no one",
		file: `graph/${T}/table.ts`,
		find: "if (event) { for (const [part, id] of keys) event(part, id) }",
		replace: "",
		catcher: { differ: "table" },
	},
	// node / update
	{
		name: "update: the stored undo is empty (dropped undo)",
		file: `changeable/${T}/update.ts`,
		find: "op: { patches: ps, undo }",
		replace: "op: { patches: ps, undo: [] }",
		catcher: fuzzUpdate,
	},
	{
		name: "update: copy on write turned off (values held change in place)",
		file: `changeable/${T}/update.ts`,
		find: "{ undo }",
		replace: "{ undo, cow: false }",
		catcher: fuzzUpdate,
	},
	{
		name: "update: the change stores all but the first patch",
		file: `changeable/${T}/update.ts`,
		find: "op: { patches: ps, undo }",
		replace: "op: { patches: ps.slice(1), undo }",
		catcher: { differ: "update", impls: T },
	},
	// op
	{
		name: "apply: the last patch's undo is dropped from the undo",
		file: `changeable/${T}/apply.ts`,
		find: "for (let j = marks.length - 1, end = undone.length;",
		replace: "for (let j = marks.length - 2, end = marks[marks.length - 1] ?? 0;",
		catcher: fuzzApply,
	},
	{
		name: "apply: a refused patch in place leaves the value changed",
		file: `changeable/${T}/apply.ts`,
		find: "\t} catch (e) {\n\t\tif (!cow) {",
		replace: "\t} catch (e) {\n\t\tif (false) {",
		catcher: fuzzApply,
	},
	{
		name: "invert: the undo comes back in the wrong order",
		file: `changeable/${T}/invert.ts`,
		find: "\treturn undo\n",
		replace: "\treturn undo.reverse()\n",
		catcher: { differ: "invert", impls: T },
	},
	{
		name: "squish: a later edit inside the earlier insert may end one short",
		file: `changeable/${T}/squish.ts`,
		find: "if (a <= c && d <= add(a, n)) {",
		replace: "if (a <= c && d < add(a, n)) {",
		catcher: { differ: "squish" },
	},
	{
		name: "squish: a removal reaching the earlier one's start no longer joins",
		file: `changeable/${T}/squish.ts`,
		find: "if (c <= a && a <= d) return { path, range: [c, add(b, sub(d, a))]",
		replace: "if (c <= a && a < d) return { path, range: [c, add(b, sub(d, a))]",
		catcher: { differ: "squish" },
	},
	{
		name: "squish: a put no longer kills the patches under it",
		file: `changeable/${T}/squish.ts`,
		find: "\t\tunder(prev.path, next.path) &&\n",
		replace: "\t\tfalse &&\n",
		catcher: { differ: "squish" },
	},
	// crow
	{
		name: "crow: letGo no longer ends the root's in-place right",
		file: `crow/${T}/crow.ts`,
		find: "letGo: (root) => void owns.delete(root),",
		replace: "letGo: () => {},",
		catcher: fuzzCrow,
	},
	{
		name: "crow: a put container is not let go of",
		file: `crow/${T}/crow.ts`,
		find: "\t\t\t\t\tletGoAll(p.value)\n",
		replace: "",
		catcher: fuzzCrow,
	},
	{
		name: "crow: what a run keeps keeps its in-place owner",
		file: `crow/${T}/crow.ts`,
		find: "\t\tout(v)\n\t\tif (isTyped(v)) return\n\t\tif (Array.isArray(v)) {",
		replace: "\t\tif (isTyped(v)) return\n\t\tif (Array.isArray(v)) {",
		catcher: fuzzCrow,
	},
	// places
	{
		name: "places: a table event tells no spot",
		file: `places/${T}/places.ts`,
		find: "say(paths.event(first(part), id))",
		replace: "say([])",
		catcher: fuzzEnd,
	},
	{
		name: "places: a landed write tells no spot (skipped notify)",
		file: `places/${T}/places.ts`,
		find: "\t\tsay(out)\n\t\ttellAll(facts)",
		replace: "\t\ttellAll(facts)",
		catcher: fuzzPlacesPaths,
	},
	{
		name: "places: a released spot is never released from paths (leak)",
		file: `places/${T}/places.ts`,
		find: "\t\tpaths.release(key)\n\t\tkey.owner = undefined",
		replace: "\t\tkey.owner = undefined",
		catcher: fuzzPlaces,
	},
	{
		name: "path: .. at the root is the root, not above it",
		file: `places/${T}/path.ts`,
		find: "else if (names.length) names.pop()",
		replace: "else if (names.length > 1) names.pop()",
		catcher: fuzzPlaces,
	},
]
