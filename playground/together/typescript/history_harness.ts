// history_harness: history.ts, replay.ts and snapshot.ts on the line protocol (harness.ts), for
// the history, replay and snapshot suites. one history per process; commits by label (conventions:
// playground/together/conformance/README.md). the check: key patches alone pass (lists.ts); else
// patches apply at the base (replay), a merge to its rule's merge; rules known: run's
// (rules_harness.ts's alone), a merge by any other held, and what goes on a held one touching its
// path (lists.ts, marks). a commit given to hold waits []. a rule that keeps (keeping) merges twice:
// from scratch, and by one holding its work for the process, which must give the same, byte for
// byte
//
// { op: "make", name, ...fields }   → {}            made and labelled, not added
// { op: "add", name, ...fields }    → { added }     made (no fields: the labelled one), added
// { op: "add", bytes }              → { added }     hex bytes as they are
//    added: "taken" | "held" | "passed" | { waiting: [commit…] } | { refused: code }
// { op: "hold", commits }           → {}            the check answers "wait" for these until the
//                                                   next hold
// { op: "again" }                   → {}            history.again
// { op: "heads" }                   → { heads }     agreed order
// { op: "all" }                     → { all }       in the order taken
// { op: "waiting" }                 → { waiting }   [{ name, waiting: [commit…] }], as arrived
// { op: "refused" }                 → { refused }   [{ name, refused: code }], refusal order
// { op: "held" }                    → { held }      [{ name, rule }], in the order taken
// { op: "name", commit }            → { name }      hex
// { op: "replay", commit }          → { tables } | {}   {}: not taken
// { op: "merge", heads, rule? }     → { tables }    default the first rule known
// { op: "since", heads }            → { from, commits }   from [commit…] or []; causal order
// { op: "keep", commits, tables }   → {}            these tables as the commits' merge
// { op: "keep", commit, tables }    → {}            a snapshot at it, replay starts from it
// { op: "hint", commit, tables }    → { kept }      kept only when a replay to it matches
// { op: "snapshot", tables }        → { snapshot }  packed, hex
// { op: "tables", snapshot } | { op: "tables", value } → { tables }  value canonically encoded
// lists (lists.ts, of every commit taken; the lists suite):
// { op: "items", table?, path? }    → { items }     [{ commit, value? | gone?, inside?, at? }] at
//                                                   [table, ...path]; table default "value"
// { op: "open" }                    → { open }      [{ path, items }], path [table, ...keys]
// { op: "value" }                   → { tables }    the first items composed, { [table]: value }
// commit in an answer: its label, else hex name. tables: { [table]: { value, change } }, JSON form.
// refused: { error: code } (PackError, CommitError)
import * as cbor from "@ermine/encoding/cbor"
import { CommitError } from "@ermine/formats/commit"
import { PackError } from "@ermine/formats/pack"
import { revive, toJson } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { hex, refusal, unhex } from "../../encoding/typescript/commit_harness.ts"
import { createCommits, tablesJson } from "./harnesses.ts"
import { type Added, createHistory, since } from "./history.ts"
import { applies, createLists, createMarks, type Item } from "./lists.ts"
import { matches, type Merge, type Merges, plain, replay, type Tables, written } from "./replay.ts"
import { rules } from "./rules_harness.ts"
import { snapshot, tablesOf } from "./snapshot.ts"

const commits = createCommits()
const kept = new Map<string, Uint8Array>()
// several commits' merge kept, by their names sorted and spaced
const keyOf = (names: readonly Uint8Array[]) => names.map(hex).sort().join(" ")
const several = (names: readonly Uint8Array[]) => {
	const b = kept.get(keyOf(names))
	return b === undefined ? undefined : tablesOf(b)
}
const snapshots = (name: Uint8Array) => {
	const b = kept.get(hex(name))
	return b === undefined ? undefined : tablesOf(b)
}
// the rules known (run's), and each keeping one's kept merge
let merges: Merges = {}
const keeping = new Map<string, Merge>()
const merged = (heads: Uint8Array[], rule: string) => {
	const get = (ns: readonly Uint8Array[]) =>
		ns.length === 1 ? plain(history, ns[0], snapshots) : several(ns)
	const ks = heads.map((n) => history.get(n)!)
	const out = merges[rule](history, ks, get)
	const walked = keeping.get(rule)
	if (walked !== undefined) {
		const a = snapshot(out), b = snapshot(walked(history, ks, get))
		if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
			throw new Error(`${rule}'s kept merge merged otherwise`)
		}
	}
	return out
}
// what the check cannot judge yet, by name
let waits = new Set<string>()
const history = createHistory((k, commit) => {
	if (waits.has(hex(k.name))) return "wait"
	if (commit.merge !== undefined && merges[commit.merge] === undefined) return marks.hold(k)
	if (marks.on(commit)) return marks.hold(k)
	const tables = commit.merge !== undefined
		? merged(commit.parents, commit.merge)
		: k.base === undefined
		? {}
		: replay(history, k.base, snapshots, merges) ?? {}
	// key patches alone: never refused by what is there
	if (
		commit.patches.every((p) =>
			p.range === undefined && p.move === undefined &&
			p.path.every((k) => typeof k === "string")
		)
	) return true
	try {
		applies(tables[commit.table]?.value, commit.patches)
		return true
	} catch {
		return false
	}
})

// the paths held commits mark, and what goes on them
const marks = createMarks(history)

const tablesFrom = (x: unknown) => revive(x) as Tables

// the lists of every commit taken, now
function listsNow() {
	const lists = createLists(history, (k) => written(history, k.name, snapshots, merges) ?? {})
	for (const k of history.all()) lists.add(k)
	return lists
}
const itemJson = (i: Item) => ({
	commit: commits.label(i.write.kept.name),
	...i.gone ? { gone: true } : { value: toJson(i.value) },
	...i.inside && { inside: true },
	...i.at && { at: i.at },
})

const added = (a: Added): unknown =>
	typeof a === "object" && "waiting" in a ? { waiting: a.waiting.map(commits.label) } : a

async function answer(r: Request): Promise<Answer> {
	try {
		switch (r.op) {
			case "make":
				await commits.make(r)
				return {}
			case "add": {
				if (r.bytes !== undefined) return { added: added(history.add(unhex(r.bytes))) }
				const m = await commits.make(r)
				return { added: added(history.add(m.bytes)) }
			}
			case "hold":
				waits = new Set((r.commits as string[]).map((c) => hex(commits.name(c))))
				return {}
			case "again":
				history.again()
				return {}
			case "heads":
				return { heads: history.heads().map((k) => commits.label(k.name)) }
			case "all":
				return { all: history.all().map((k) => commits.label(k.name)) }
			case "waiting":
				return {
					waiting: history.waiting().map((w) => ({
						name: commits.label(w.name),
						waiting: w.waiting.map(commits.label),
					})),
				}
			case "refused":
				return {
					refused: history.refused().map((w) => ({
						name: commits.label(w.name),
						refused: w.refused,
					})),
				}
			case "held":
				return {
					held: history.all().filter((k) => k.held !== undefined).map((k) => ({
						name: commits.label(k.name),
						rule: k.held,
					})),
				}
			case "name":
				return { name: hex(commits.name(r.commit)) }
			case "replay": {
				const t = replay(history, commits.name(r.commit), snapshots, merges)
				return t === undefined ? {} : { tables: tablesJson(t) }
			}
			case "merge": {
				const heads = (r.heads as string[]).map(commits.name)
				for (const h of heads) if (!history.get(h)) throw new Error(`not taken: ${h}`)
				return { tables: tablesJson(merged(heads, r.rule ?? Object.keys(merges)[0])) }
			}
			case "since": {
				const heads = (r.heads as string[]).map((h) => history.get(commits.name(h))!)
				const { from, commits: cs } = since(
					history,
					heads,
					(f) =>
						(f.length === 1
							? plain(history, f[0].name, snapshots)
							: several(f.map((k) => k.name))) !== undefined,
				)
				return {
					from: from.map((k) => commits.label(k.name)),
					commits: cs.map((k) => commits.label(k.name)),
				}
			}
			case "keep":
				if (r.commits !== undefined) {
					kept.set(keyOf(r.commits.map(commits.name)), snapshot(tablesFrom(r.tables)))
				} else kept.set(hex(commits.name(r.commit)), snapshot(tablesFrom(r.tables)))
				return {}
			case "hint": {
				const name = commits.name(r.commit), bytes = snapshot(tablesFrom(r.tables))
				const ok = matches(history, name, bytes, snapshots, merges)
				if (ok) kept.set(hex(name), bytes)
				return { kept: ok }
			}
			case "snapshot":
				return { snapshot: hex(snapshot(tablesFrom(r.tables))) }
			case "items":
				return {
					items: listsNow().items([r.table ?? "value", ...r.path ?? []]).map(itemJson),
				}
			case "open":
				return {
					open: listsNow().open().map((o) => ({ path: o.path, items: o.items.map(itemJson) })),
				}
			case "value":
				return {
					tables: Object.fromEntries(
						Object.entries(listsNow().compose()).map(([t, e]) => [t, toJson(e.value)]),
					),
				}
			case "tables": {
				const bytes = r.value !== undefined
					? cbor.encode(revive(r.value) as cbor.Value)
					: unhex(r.snapshot)
				return { tables: tablesJson(tablesOf(bytes)) }
			}
		}
	} catch (e) {
		if (e instanceof PackError) return { error: e.code }
		if (e instanceof CommitError) return refusal(e)
		throw e
	}
	throw new Error(`unknown op ${r.op}`)
}

// the harness, knowing these rules (the first: a merge's default)
export async function run(known: Merges) {
	merges = known
	for (const [name, rule] of Object.entries(known)) {
		if (rule.keeping) keeping.set(name, rule.keeping())
	}
	await serve(answer)
}

if (import.meta.main) await run(rules)
