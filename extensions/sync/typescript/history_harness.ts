// a node's history (history.ts), its replay (replay.ts) and snapshots (snapshot.ts) on the line
// protocol (conformance/typescript/harness.ts): the history, replay and snapshot suites. state lasts
// for the process: one history, the commits made by label, the snapshots kept. another
// implementation joins by speaking this (HARNESS). conventions, and a commit by label:
// extensions/sync/conformance/README.md
//
// the history's check is the integration's: a commit is taken in when its patches apply to its
// table at its base (replay), kept snapshots used; a merge commit's, to its rule's merge of its
// parents. the rules known: "eg-walker" (egwalker.ts); a merge by any other is refused "merge". a
// commit held (hold) the check cannot judge yet: it waits on the check, waiting []
//
// { op: "make", name, ...fields }       → {}                a commit made and labelled, not added
// { op: "add", name, ...fields }        → { added }         made (when no fields: the one made
//                                                             under the label), then added
// { op: "add", bytes }                  → { added }         bytes (hex) added as they are
//     added: "taken" | "passed" | { waiting: [commit…] } | { refused: code }
// { op: "hold", commits }              → {}                the check cannot judge these yet: it
//                                                             answers "wait" for each, until held
//                                                             no more (the next hold's list)
// { op: "again" }                       → {}                the commits waiting on the check judged
//                                                             again (history.again)
// { op: "heads" }                       → { heads }         in the agreed order
// { op: "all" }                         → { all }           every commit taken in, in the order taken
// { op: "waiting" }                     → { waiting }       [{ name, waiting: [commit…] }], in the
//                                                            order they came
// { op: "refused" }                     → { refused }       [{ name, refused: code }], in the order
//                                                            refused
// { op: "name", commit }                → { name }          its name, hex
// { op: "replay", commit }              → { tables } | {}   the node's tables at it; none: not taken
// { op: "merge", heads, rule? }         → { tables }        heads (commits taken) merged by the rule,
//                                                            default "eg-walker"
// { op: "since", heads }                → { from, commits } history.ts's since, from one commit had
//                                                            without merging or several kept: from
//                                                            [commit…] or [] (none); commits in
//                                                            causal order
// { op: "keep", commits, tables }       → {}                these tables as several commits' merge
//                                                            (by "eg-walker"), which a merge and
//                                                            since start from
// { op: "keep", commit, tables }        → {}                a snapshot of these tables at it, which
//                                                            replay starts from (as one made here)
// { op: "hint", commit, tables }        → { kept }          a snapshot of these tables at it from
//                                                            elsewhere: kept (as keep) only when a
//                                                            replay to it gives the same (matches)
// { op: "snapshot", tables }            → { snapshot }      the tables packed, hex
// { op: "tables", snapshot } | { op: "tables", value }      → { tables }   read back; value: its
//                                                            JSON form encoded canonically first
// a commit in an answer: its label, else its name as hex. tables: { [table]: { value, change } },
// values in their JSON form. refused: { error: code } (PackError's, CommitError's)
import apply from "@ermine/op/apply"
import * as cbor from "@ermine/encoding/cbor"
import { CommitError } from "@ermine/encoding/commit"
import { PackError } from "@ermine/encoding/pack"
import { revive } from "../../../conformance/typescript/form.ts"
import { type Answer, type Request, serve } from "../../../conformance/typescript/harness.ts"
import { hex, refusal, unhex } from "../../../ermine/encoding/typescript/commit_harness.ts"
import { createCommits, tablesJson } from "./harnesses.ts"
import { egwalker } from "./egwalker.ts"
import { type Added, createHistory, since } from "./history.ts"
import { matches, type Merges, plain, replay, type Tables } from "./replay.ts"
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
const merges: Merges = { "eg-walker": egwalker }
// eg-walker's merges made twice: from scratch, and by its walker kept for the process (walker.ts),
// which must give the same, byte for byte
const walked = egwalker.keeping!()
const merged = (heads: Uint8Array[], rule: string) => {
	const get = (ns: readonly Uint8Array[]) =>
		ns.length === 1
			? plain(history, ns[0], snapshots)
			: rule === "eg-walker"
			? several(ns)
			: undefined
	const ks = heads.map((n) => history.get(n)!)
	const out = merges[rule](history, ks, get)
	if (rule === "eg-walker") {
		const a = snapshot(out), b = snapshot(walked(history, ks, get))
		if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
			throw new Error("eg-walker's walker merged otherwise")
		}
	}
	return out
}
// what the check cannot judge yet, by name
let held = new Set<string>()
const history = createHistory((k, commit) => {
	if (held.has(hex(k.name))) return "wait"
	if (commit.merge !== undefined && merges[commit.merge] === undefined) return "merge"
	const tables = commit.merge !== undefined
		? merged(commit.parents, commit.merge)
		: k.base === undefined
		? {}
		: replay(history, k.base, snapshots, merges) ?? {}
	try {
		apply(tables[commit.table]?.value, commit.patches, { cow: false })
		return true
	} catch {
		return false
	}
})

const tablesFrom = (x: unknown) => revive(x) as Tables

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
				held = new Set((r.commits as string[]).map((c) => hex(commits.name(c))))
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
			case "name":
				return { name: hex(commits.name(r.commit)) }
			case "replay": {
				const t = replay(history, commits.name(r.commit), snapshots, merges)
				return t === undefined ? {} : { tables: tablesJson(t) }
			}
			case "merge": {
				const heads = (r.heads as string[]).map(commits.name)
				for (const h of heads) if (!history.get(h)) throw new Error(`not taken: ${h}`)
				return { tables: tablesJson(merged(heads, r.rule ?? "eg-walker")) }
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

if (import.meta.main) await serve(answer)
