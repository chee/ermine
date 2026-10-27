// hints: errors that say what to do. the base stays mechanical: its codes and their text as they
// are; this library turns a code, plus what the erring program could see, into one or two
// sentences in @ermine/system's functions. a feature the host adds [chee 10-27: "hints and trace,
// user imports and includes them as features"; before: on by default]; a dev tool, an inspector,
// or another api's shape calls it as well.
//
//   import { hints } from "@ermine/system/hints"
//   createErmine({ features: [hints] })
//
//   hints            the feature: each error ermine throws given its advice (onError), and a
//                    status that will not end on its own a hint field (onStatus)
//   hint(e, seen?)   advice for e, a thrown error or PENDING; none: nothing to say
//   bare(e)          e's message without the advice ermine added
//   attach(e, fn)    the advice on e: a hint field, and after the code's text in its message
//
// the picks are mine (an agent's, 10-26), by ermine's principles, for tippi to check:
// 1. a hint is made from what the error already carries (its code, the path in its text, a
//    refusal's op and the path it was asked by, a feature's name) and what the program is shown
//    (its getStatus, the function it called): nothing read for it, so a hint never tells a
//    process more than it could see, and reading nothing it tracks nothing
// 2. paths shown from "/", the root, as the program writes them; a refusal's
//    grant and ids never shown
// 3. the advice goes on the error itself (share, don't copy): a hint field, not enumerable (so a
//    print shows it once), and the message gets "\nhint: …" after the code's own text, so a plain
//    console print shows it. code, class and identity unchanged; the first hint stays (the
//    innermost function's, as the program that called it sees it)
// 4. only ermine's own errors are hinted (PlacesError, ErmineError, SendError, Refusal,
//    SchedulerError, FeatureError); a program's own throw passes as it is
// 5. PENDING is one symbol, the base's colourless async: nothing attaches to it. its advice is
//    hint(PENDING, seen) for whoever catches it, and, by default, a hint field on the status where
//    ermine shows a pending that will never end on its own: a process whose setup threw it
//    (setup runs once). a looping status gets one too (its error is ermine's own)
// 6. hints: false gives the bare base: no field, the message as the code's text
import { PlacesError } from "@ermine/core/places"
import { Refusal } from "@ermine/core/places/guard"
import { PENDING, SchedulerError } from "@ermine/core/scheduler"
import { ErmineError, type Feature, FeatureError } from "./features.ts"
import type { Status, Waiting } from "./system.ts"

// what the erring program could see, beside the error: the function it called, the status of
// what it read (getStatus's, as it sees it), whether it was its setup
export type Seen = {
	readonly fn?: string
	readonly status?: Status
	readonly setup?: boolean
}

const SEP = "\nhint: "

// a path from the root, as the program writes it
const slash = (at: string | readonly string[]) => "/" + (typeof at === "string" ? at : at.join("/"))
const folderOf = (at: string) => slash(at.split("/").slice(0, -1).join("/"))
const lastOf = (at: string) => at.split("/").at(-1) ?? at
const fnOr = (seen: Seen | undefined, or: string) => seen?.fn ?? or

// what a pending one waits on, in a sentence's words
function waits(w: Waiting): string {
	if (w === "a promise") return "a promise it gave hasn't settled yet"
	if (w === "PENDING") return "it gave PENDING itself"
	if ("send" in w) {
		return w.send === null
			? "executeAction's action isn't there yet"
			: `executeAction("${slash(w.send)}") has no action there yet`
	}
	if ("code" in w) return `its code isn't at ${slash(w.code)} yet`
	return w.node === null
		? "a node it reads isn't there yet"
		: `nothing is at ${slash(w.node)} yet, or it has no value yet`
}
const waiting = (st: Status | undefined) =>
	(st?.waiting ?? []).map(waits).join("; ") || "what it read isn't there yet"

function pending(seen: Seen | undefined): string {
	if (seen?.setup) {
		return `the setup stopped on PENDING (${waiting(seen.status)}): a setup runs once and ` +
			`never again, so this process stays pending even after that comes. do it in a ` +
			`createEffect, or read it in a createMemo: they run again when it arrives.`
	}
	const what = seen?.status === undefined ? "what it read isn't there yet" : waiting(seen.status)
	return `${
		fnOr(seen, "read")
	} threw PENDING, not undefined (${what}): in a createMemo or createEffect that's ` +
		`fine, it runs again when it arrives. to show "loading", check hasNode(x) (a node not there) ` +
		`or getStatus(x)?.state === "pending" (a memo with no value yet) first, or read it in ` +
		`peep(() => read(x)), which gives undefined.`
}

function nothingThere(at: string | undefined, seen: Seen | undefined): string {
	const fn = fnOr(seen, "it")
	if (at === undefined) {
		return `the node that handle names isn't reachable now (unplaced): get it again by its ` +
			`path, getNode("/…").`
	}
	if (at === "..") return `the path climbs above "/" (too many ".."): "/" is as high as it goes.`
	if (at === "a node with no place") {
		return `pipe needs a node reached by a path: give it the path, or the node getNode or ` +
			`ensureNode gave.`
	}
	if (at === "not a change this ermine shows") {
		return `explain takes a path, a node, or a change it was shown (readAll's from.change, ` +
			`a pipe's write's change), never an object made by hand.`
	}
	const p = slash(at)
	switch (seen?.fn) {
		case "createMemo":
		case "createEffect":
			return `the folder ${
				folderOf(at)
			} isn't there, so ${fn} can't make ${p} in it: make the ` +
				`folder first, ensureNode("${folderOf(at)}"), or give it a name with no folder.`
		case "patch":
		case "patchAttributes":
		case "patchChildren":
		case "remove":
			return `nothing is at ${p} yet, so ${fn} can't change it: make it first, ` +
				`ensureNode("${p}", value), then ${fn} it.`
		case "place":
			return `nothing is at ${p}: place(path, node) needs the node there, and path's folder ` +
				`(ensureNode makes either).`
		case "rename":
			return `nothing is at ${p}: rename(from, to) needs a name at from, and to's folder there.`
		case "unplace":
			return `nothing is named ${p}, so unplace has nothing to take out: list("${
				folderOf(at)
			}") shows the names there.`
	}
	return `nothing is at ${p}: make it first, ensureNode("${p}", value).`
}

function alreadyThere(at: string | undefined, seen: Seen | undefined): string {
	const fn = fnOr(seen, "it")
	if (at === "/") return `"/" is always there: name a node under it, like ensureNode("/x").`
	switch (seen?.fn) {
		case "createMemo":
		case "createEffect":
			return `a ${fn.slice(6).toLowerCase()} named ${
				slash(at ?? "")
			} was already made by this same setup or run: give each one its own name (like "${
				lastOf(at ?? "x")
			}2"), or make it once.`
		case "place":
		case "patchChildren":
		case "rename":
			return `the name "${at}" is taken in that folder: unplace it first, or choose another name.`
	}
	return `"${at}" is already there: choose another name, or unplace what is there first.`
}

function ermineError(e: ErmineError, seen: Seen | undefined): string | undefined {
	const fn = fnOr(seen, "it")
	switch (e.code) {
		case "nothing-open":
			return `nothing of the program is running here, so ${fn} can't find it: call it before ` +
				`the await, or put what comes later (an await, a timer, a listener) in a promise a ` +
				`createMemo returns; its value comes when it settles, and a createEffect acts on it.`
		case "two-copies":
			return `the program imports one copy of @ermine/system and the host made its ermine with ` +
				`another: import it once (one import map entry), so both share it.`
		case "not-a-handle":
			return `that isn't a node: pass a path ("./x"), or the node getNode, ensureNode, ` +
				`createMemo … gave; an object shaped like one isn't one.`
		case "not-a-value":
			return `a node was used as its value (in JSON, a string, a sum): read(node) gives its value.`
		case "not-patches":
			return fn === "patchChildren"
				? `patchChildren takes one name a patch: [{ path: ["name"], value: node }] places node ` +
					`there, [{ path: ["name"] }] takes the name out.`
				: `${fn} takes a list of patches: [{ path: [], value }] the whole value, ` +
					`[{ path: ["key"], value }] one key in it.`
		case "not-a-function":
			return /pipe takes/.test(e.message)
				? `pipe(from, fn) tells fn each write at from; pipe(from, to) mirrors it, ` +
					`pipe(from, to, there) transforms it, pipe(from, to, there, back) translates both ` +
					`ways: there and back are functions given the write, giving patches.`
				: `ermine.start takes the program's function itself: start(program, "/path"), not ` +
					`its path or its module.`
		case "looping":
			return `this pipe was told by pipes' writes, as they landed, too deep (a pipe writing ` +
				`where another pipe hears, round again): it is told no more. give one of them ` +
				`{ timing: "pulse" } (the default), so each hop waits a pulse.`
		case "not-yet":
			return `that is made after the features are set up: use it in a hook, not in setup.`
		case "in-act":
			return fn === "addTeardown"
				? `an effect's act makes nothing: return the cleanup from the act instead, ` +
					`createEffect(name, () => …, (v) => { …; return () => cleanup() }): it runs before the ` +
					`next act and when the effect goes.`
				: `an effect's act makes nothing: it only does the side effect. make the ${
					fn.replace(/^create/, "").toLowerCase()
				} in setup, an action, or a createMemo (an owner that is run), and have the effect ` +
					`read it.`
		case "bad-cleanup":
			return `an act returns a function (its cleanup, run before the next act and when the ` +
				`effect goes) or nothing: a returned value isn't used, so don't return it.`
		case "not-here":
			return `${fn} is for setup, an action, or a writer (createWriter): a memo reruns, and an ` +
				`effect's act makes nothing, so what it made would be made again or lost. do it in ` +
				`setup, or in an action the memo or effect calls.`
		case "gone":
			return `the writer was made by a setup or action whose process (or owner) has ended: ` +
				`createWriter again where it still runs, or stop whatever kept the writer (a timer, a listener) ` +
				`in addTeardown.`
		case "already-inside":
			return `a writer is for code that runs with nothing open (a timer, a listener, ` +
				`after an await). inside a run, an action or setup, do what it holds directly.`
		case "closed":
			return `this ermine is closed (close() ran) and something went on: stop timers and ` +
				`listeners in addTeardown.`
		case "setup-only":
			return `a feature adds its hooks and slots in its setup only, as createErmine makes it.`
		case "feature-twice":
			return `two features have one name: give createErmine each feature once.`
		case "needs-loop":
			return `these features need each other in a loop: one of them has to go without the other.`
		case "missing-feature":
			return `a feature needs another that createErmine wasn't given: add it to features.`
	}
	return undefined
}

function refusal(e: Refusal): string {
	const by = e as Refusal & { feature?: string; hook?: string }
	const t = e.ask.target
	const name = t.part === "children" && typeof t.field?.[0] === "string" ? t.field[0] : undefined
	const p = t.path === undefined
		? undefined
		: name === undefined
		? slash(t.path)
		: slash([...t.path, name])
	const what = p === undefined ? "a node it holds" : p
	const whose = by.feature === undefined
		? "the host's policy (createErmine's may)"
		: `the feature "${by.feature}" (its ${by.hook})`
	switch (e.ask.op) {
		case "move":
			return `rename can't move ${what} into itself (to a path under it): choose a path outside it.`
		case "read":
			return `${whose} refused reading ${what}: read only what it lets this process read, ` +
				`or ask the host for read there; readEntries and hasNode pass over what is refused.`
		case "edit":
			return `${whose} refused editing ${what}: write a node of its own (a bare name is ` +
				`inside the process's node), or ask the host for edit there.`
		case "place":
			return `${whose} refused placing at ${what}: a name needs place on the folder, and read ` +
				`and edit of the node placed (execute too, for an action); place in a folder of its own.`
		case "execute":
			return `${whose} refused running the action at ${what}: ask the host for execute there.`
		case "remove":
			return `${whose} refused removing ${what}: a process unplaces its own names instead.`
	}
	return `${whose} refused ${e.ask.op} of ${what}.`
}

// advice for e, as the program that erred could see it; none: nothing to say
export function hint(e: unknown, seen?: Seen): string | undefined {
	if (e === PENDING) return pending(seen)
	if (e instanceof PlacesError) {
		switch (e.code) {
			case "nothing-there":
				return nothingThere(e.at, seen)
			case "already-there":
				return alreadyThere(e.at, seen)
			case "not-a-name":
				return e.at === undefined
					? `an empty path names no node: give it a name, like "./x".`
					: `"${e.at}" can't be a name: a name is never empty, ".", ".." or "/" (look for ` +
						`"//", or a path ending in "/").`
		}
	}
	if (e instanceof ErmineError) return ermineError(e, seen)
	if (e instanceof Error && e.name === "SendError" && "at" in e) {
		const at = String(e.at)
		const p = at === "a node it was handed" ? "that node" : slash(at)
		return `${p} holds a value, not an action, so executeAction can't run it: make one there ` +
			`with createAction("${
				p === "that node" ? "./x" : p
			}", (…) => …), or read a value with read(…).`
	}
	if (e instanceof Refusal) return refusal(e)
	if (e instanceof SchedulerError) {
		switch (e.code) {
			case "disposed":
				return `what this ran in has ended (the process stopped, or its run or call is over): ` +
					`clear timers and listeners in addTeardown.`
			case "unscoped":
				return `nothing is open here: call it from a setup, a memo, an effect or an action.`
			case "empty":
				return `a scope's info needs at least one key.`
		}
	}
	if (e instanceof FeatureError) {
		return `the feature "${e.feature}" failed in its ${e.hook}, not the program's own code: ` +
			`what it threw is the error's cause.`
	}
	return undefined
}

// e's message without the advice attach added
export function bare(e: unknown): string {
	if (!(e instanceof Error)) return String(e)
	const h = (e as { hint?: unknown }).hint
	return typeof h === "string" && e.message.endsWith(SEP + h)
		? e.message.slice(0, -(SEP + h).length)
		: e.message
}

// e with the advice for it, an object of ermine's not hinted already: its hint field, and its
// message the code's text then the advice. e itself, always
export function attach<E>(e: E, seen?: Seen): E {
	if (!(e instanceof Error) || Object.hasOwn(e, "hint")) return e
	const h = hint(e, seen)
	if (h === undefined || !Object.isExtensible(e)) return e
	Object.defineProperty(e, "hint", { value: h, configurable: true, writable: true })
	e.message += SEP + h
	return e
}

// a status with its advice, where ermine shows one (pick 5): a process whose setup threw
// PENDING (computer: false, and not waiting on a promise it gave), a looping one
export function hintStatus(st: Status, computer: boolean): Status {
	if (st.state === "looping") {
		return {
			...st,
			hint: `it loops: what it writes is what it reads, again and again. a createMemo only ` +
				`reads; an effect's act shouldn't write what its first function reads.`,
		}
	}
	if (st.state !== "pending" || computer) return st
	if (st.waiting?.length === 1 && st.waiting[0] === "a promise") return st
	return { ...st, hint: pending({ status: st, setup: true }) }
}

export const hints: Feature = {
	name: "hints",
	setup(f) {
		f.onError((e, fn, next) => attach(next(e, fn), fn === undefined ? {} : { fn }))
		f.onStatus((x, st, next) => hintStatus(next(x, st), x.computer))
	},
}
