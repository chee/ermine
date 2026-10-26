// hints: a run's facts (what the program could see: its own errors, sends still waiting, memos and
// effects not done, what it showed, the values it wrote) turned into plain instructions in its
// design's words. never from a check's wanted values. one or two sentences each.
//
//   hints(run, design, source?) → string[]
//
// run: run.ts' facts (a load error, unhandled rejections, each trial's Facts from lib/trial.ts).
// source: the program's file (its url as in a stack, its text): a hint names the line it is about
import type { Facts, Seen } from "./trial.ts"

export type RunFacts = {
	// the program's file didn't load: why
	load?: Seen
	// promises the program let reject with nobody waiting
	rejected: Seen[]
	// throws from code nobody called (a timer, a listener)
	uncaught?: Seen[]
	trials: Facts[]
}
// a program's file; a try of several files: the main one, the others beside it (named)
export type Source = { url: string; text: string; name?: string; others?: Source[] }

// one design's words: what a hint tells the program to write
type Words = {
	// how the program gets its words (import: from the module "ermine", L)
	from: "api" | "e" | "me" | "globals" | "import"
	// every word on the sheet
	words: string[]
	// the first line of a program
	head: string
	open: (p: string, v: string) => string
	read: (x: string) => string
	set: (x: string, v: string) => string
	// change part of the value
	draft: (x: string) => string
	// a number node, one more
	bump: (x: string) => string
	memo: string
	effect: string
	method: string
	memoOf: (name: string) => string
	effectOf: (name: string) => string
	methodOf: (p: string) => string
	send: (p: string) => string
	// send/call gives a promise
	promise: boolean
	// what a node's handle has
	handle: string
	// a name in the program's own node, as this design writes it; none: no way to
	own?: (name: string) => string
	// "x has no value yet", as a check in a memo (it waits otherwise); none: a read gives undefined
	pending?: (x: string) => string
	// the names the program was given beside the design's words (a task's save)
	given?: string[]
	// the design's letter
	key?: string
}

const call = (word: string) => ({
	memoOf: (n: string) => `${word}("${n}", () => …)`,
})

const A: Words = {
	from: "api",
	words: [
		"open",
		"read",
		"peep",
		"reads",
		"list",
		"edit",
		"memo",
		"effect",
		"method",
		"send",
		"status",
		"why",
		"teardown",
		"PENDING",
		"show",
	],
	head:
		"export default function (api) { const { open, read, edit, memo, effect, method, show } = api; … }",
	open: (p, v) => `open("${p}", ${v})`,
	read: (x) => `read(${x})`,
	set: (x, v) => `edit(${x}, () => ${v})`,
	draft: (x) => `edit(${x}, (d) => { d.key = … })`,
	bump: (x) => `edit(${x}, (n) => n + 1)`,
	memo: "memo",
	effect: "effect",
	method: "method",
	...call("memo"),
	effectOf: (n) => `effect("${n}", () => read(x), (value) => show(…))`,
	methodOf: (p) => `method("${p}", (arg) => …)`,
	send: (p) => `send("${p}", …)`,
	promise: false,
	handle: "a node is passed to the words: read(x), edit(x, change)",
	own: (n) => `"${n}"`,
	pending: (x) => `status(${x}).state === "pending"`,
}

// B: a handle is a function
const B: Words = {
	...A,
	words: [
		"open",
		"reads",
		"list",
		"memo",
		"effect",
		"method",
		"send",
		"status",
		"why",
		"teardown",
		"PENDING",
		"show",
	],
	head: "export default function (api) { const { open, memo, effect, method, show } = api; … }",
	read: (x) => `${x}()`,
	set: (x, v) => `${x}(${v})`,
	draft: (x) => `${x}((d) => { d.key = … })`,
	bump: (x) => `${x}((n) => n + 1)`,
	effectOf: (n) => `effect("${n}", () => x(), (value) => show(…))`,
	handle: "a handle is a function: x() reads, x(v) replaces, x(recipe) edits, x.peep()",
}

const C: Words = {
	...B,
	words: [
		"usePath",
		"useMemo",
		"useEffect",
		"reads",
		"list",
		"method",
		"send",
		"status",
		"why",
		"teardown",
		"PENDING",
		"show",
	],
	head:
		"export default function (api) { const { usePath, useMemo, useEffect, method, show } = api; … }",
	open: (p, v) => `const [x, patchX] = usePath("${p}", ${v})`,
	set: (_x, v) => `patchX(${v})`,
	draft: () => `patchX((d) => { d.key = … })`,
	bump: () => `patchX((n) => n + 1)`,
	memo: "useMemo",
	effect: "useEffect",
	...call("useMemo"),
	effectOf: (n) => `useEffect("${n}", () => x(), (value) => show(…))`,
	handle: "usePath gives [x, patchX]: x() reads, x.peep(), patchX(v) writes",
}

const D: Words = {
	...A,
	words: ["open", "memo", "effect", "method", "send", "teardown", "PENDING", "show"],
	head: "export default function (api) { const { open, memo, effect, method, show } = api; … }",
	read: (x) => `${x}.read()`,
	set: (x, v) => `${x}.set(${v})`,
	draft: (x) => `${x}.edit((d) => { d.key = … })`,
	bump: (x) => `${x}.edit((n) => n + 1)`,
	effectOf: (n) => `effect("${n}", () => x.read(), (value) => show(…))`,
	handle:
		"a handle has .read(), .peep(), .set(v), .edit(change), .reads(), .list(), .info(), .why(), .status()",
	pending: (x) => `${x}.status().state === "pending"`,
}

const E: Words = {
	from: "e",
	words: [
		"node",
		"byId",
		"at",
		"path",
		"id",
		"read",
		"peep",
		"reads",
		"list",
		"attributes",
		"write",
		"edit",
		"patch",
		"remove",
		"move",
		"place",
		"unplace",
		"memo",
		"effect",
		"handler",
		"call",
		"status",
		"teardown",
		"why",
		"show",
	],
	head: "export default function (e) { … }",
	open: (p, v) => `e.node("${p}", ${v})`,
	read: (x) => `e.read(${x})`,
	set: (x, v) => `e.write(${x}, ${v})`,
	draft: (x) => `e.edit(${x}, (d) => { d.key = … })`,
	bump: (x) => `e.edit(${x}, (n) => n + 1)`,
	memo: "e.memo",
	effect: "e.effect",
	method: "e.handler",
	memoOf: (n) => `e.memo("${n}", (e) => …)`,
	effectOf: (n) => `e.effect("${n}", (e) => e.read(x), (e, now) => e.show(…))`,
	methodOf: (p) => `e.handler("${p}", (e, arg) => …)`,
	send: (p) => `await e.call("${p}", …)`,
	promise: true,
	handle: "a handle has nothing on it: e.read(x), e.write(x, v)",
	own: (n) => `"~/${n}"`,
	pending: (x) => `e.status(${x}).state === "pending"`,
}

const F: Words = {
	from: "me",
	words: [
		"node",
		"make",
		"byId",
		"info",
		"read",
		"peek",
		"values",
		"children",
		"attributes",
		"write",
		"writeAt",
		"edit",
		"remove",
		"move",
		"place",
		"compute",
		"effect",
		"answer",
		"send",
		"status",
		"ready",
		"cleanup",
		"why",
		"show",
	],
	head: "export default function (me) { … }",
	open: (p, v) => `me.make("${p}", ${v})`,
	read: (x) => `me.read(${x})`,
	set: (x, v) => `me.write(${x}, ${v})`,
	draft: (x) => `me.edit(${x}, (d) => { d.key = … })`,
	bump: (x) => `me.write(${x}, me.read(${x}) + 1)`,
	memo: "me.compute",
	effect: "me.effect",
	method: "me.answer",
	memoOf: (n) => `me.compute("${n}", (me) => …)`,
	effectOf: (n) => `me.effect("${n}", (me) => me.read(x), (now, before, me) => me.show(…))`,
	methodOf: (p) => `me.answer("${p}", (me, arg) => …)`,
	send: (p) => `await me.send(me.node("${p}"), …)`,
	promise: true,
	handle: "a handle has nothing on it: me.read(x), me.write(x, v)",
	own: (n) => `"~/${n}"`,
	pending: (x) => `me.status(${x}).state === "pending"`,
}

const G: Words = {
	from: "globals",
	words: ["node", "derived", "on", "onStop", "show"],
	head: 'export default function () { const x = node("x", 0); … }',
	open: (p, v) => `node("${p}", ${v})`,
	read: (x) => `${x}.get()`,
	set: (x, v) => `${x}.set(${v})`,
	draft: (x) => `${x}.set((old) => ({ ...old, key: … }))`,
	bump: (x) => `${x}.set((n) => n + 1)`,
	memo: "derived",
	effect: "x.watch",
	method: "on",
	memoOf: (n) => `derived("${n}", () => …)`,
	effectOf: () => `x.watch((value) => show(…))`,
	methodOf: (p) => `on("${p}", (arg) => …)`,
	send: (p) => `await node("${p}").call(…)`,
	promise: true,
	handle: "a handle has .get(), .set(v), .watch(fn), .call(…)",
	pending: undefined,
}

const G2: Words = {
	...G,
	draft: (x) => `${x}.update((d) => { d.key = … })`,
	bump: (x) => `${x}.set(${x}.get() + 1)`,
	handle: "a handle has .get(), .set(v), .update(draft => …), .watch(fn), .call(…)",
}
const G3: Words = {
	...G2,
	draft: (x) => `${x}.produce((d) => { d.key = … })`,
	handle: "a handle has .get(), .set(v), .produce(draft => …), .watch(fn), .call(…)",
}

const H: Words = {
	...B,
	from: "globals",
	words: [
		"open",
		"list",
		"send",
		"teardown",
		"PENDING",
		"memo",
		"effect",
		"method",
		"status",
		"why",
		"reads",
		"show",
	],
	head: 'export default function () { const x = open("./x", 0); … }',
}
const I: Words = {
	...H,
	words: [
		"open",
		"list",
		"send",
		"teardown",
		"PENDING",
		"createMemo",
		"createEffect",
		"createMethod",
		"getStatus",
		"getWhy",
		"getReads",
		"show",
	],
	memo: "createMemo",
	effect: "createEffect",
	method: "createMethod",
	...call("createMemo"),
	effectOf: (n) => `createEffect("${n}", () => x(), (value) => show(…))`,
	methodOf: (p) => `createMethod("${p}", (arg) => …)`,
	pending: (x) => `getStatus(${x}).state === "pending"`,
}
const J: Words = {
	...H,
	words: ["open", "memo", "effect", "method", "send", "show"],
	handle: "a handle is a function: x() reads, x(v) replaces, x(recipe) edits",
	pending: undefined,
}
const K: Words = {
	from: "globals",
	words: [
		"createSignal",
		"createMemo",
		"createEffect",
		"createStore",
		"isPending",
		"latest",
		"untrack",
		"flush",
		"onCleanup",
		"action",
		"refresh",
		"createMethod",
		"send",
		"show",
	],
	head: 'export default function () { const [x, setX] = createSignal(0, { name: "./x" }); … }',
	open: (p, v) => `const [x, setX] = createSignal(${v}, { name: "${p}" })`,
	read: (x) => `${x}()`,
	set: (_x, v) => `setX(${v})`,
	draft: () => `setStore((d) => { d.key = … })`,
	bump: () => `setX((n) => n + 1)`,
	memo: "createMemo",
	effect: "createEffect",
	method: "createMethod",
	memoOf: (n) => `createMemo(() => …, { name: "${n}" })`,
	effectOf: () => `createEffect(() => x(), (value) => show(…))`,
	methodOf: (p) => `createMethod("${p}", (arg) => …)`,
	send: (p) => `send("${p}", …)`,
	promise: false,
	handle: "createSignal gives [x, setX]: x() reads, setX(v) writes",
	own: (n) => `"${n}"`,
	pending: (x) => `isPending(() => ${x}())`,
}

// L: A's words, imported from "ermine"; the task's functions are the program function's argument
const L: Words = {
	...A,
	from: "import",
	words: [...A.words, "here"],
	head:
		'import { open, read, edit, memo, effect, method, show } from "ermine"; export default function () { … }',
}

const table: Record<string, Words> = {
	a: A,
	b: B,
	c: C,
	d: D,
	e: E,
	f: F,
	g: G,
	g2: G2,
	g3: G3,
	h: H,
	i: I,
	j: J,
	k: K,
	l: L,
}
const names: Record<string, string> = {
	words: "a",
	call: "b",
	hooks: "c",
	methods: "d",
	"explicit-e": "e",
	me: "f",
	invented: "g",
	update: "g2",
	produce: "g3",
	"call-global": "h",
	"call-verbs": "i",
	smallest: "j",
	solid: "k",
	imported: "l",
}

// what a word from another design (or none) is for: this design's word for that
const kinds: Record<string, "open" | "memo" | "effect" | "method" | "send" | "read" | "write"> = {
	open: "open",
	node: "open",
	make: "open",
	usePath: "open",
	useState: "open",
	createSignal: "open",
	signal: "open",
	createStore: "open",
	memo: "memo",
	useMemo: "memo",
	createMemo: "memo",
	derived: "memo",
	compute: "memo",
	computed: "memo",
	effect: "effect",
	useEffect: "effect",
	createEffect: "effect",
	watch: "effect",
	subscribe: "effect",
	method: "method",
	createMethod: "method",
	on: "method",
	handler: "method",
	answer: "method",
	handle: "method",
	send: "send",
	call: "send",
	request: "send",
	read: "read",
	get: "read",
	peep: "read",
	peek: "read",
	edit: "write",
	set: "write",
	write: "write",
	update: "write",
	produce: "write",
	patch: "write",
	setState: "write",
}
// the sheets' example names: a program using one copied an example
const EXAMPLES = new Set([
	"lamp",
	"patchLamp",
	"setLamp",
	"bright",
	"level",
	"setLevel",
	"label",
	"time",
	"draw",
	"health",
])

// the sheets' example fields (the lamp's): a node holding only one of them copied an example
const EXAMPLE_KEYS = new Set(["level", "on"])

const wordFor = (w: Words, kind: string): string => {
	switch (kind) {
		case "open":
			return w.open("./x", "start")
		case "memo":
			return w.memoOf("name")
		case "effect":
			return w.effectOf("name")
		case "method":
			return w.methodOf("./on/x")
		case "send":
			return w.send("/path")
		case "read":
			return w.read("x")
		default:
			return `${w.set("x", "v")} or ${w.draft("x")}`
	}
}

// "a" or "an" before a word
const an = (word: string) => /^[aeio]/i.test(word) ? `an ${word}` : `a ${word}`
const prefix = (w: Words) => w.from === "e" ? "e." : w.from === "me" ? "me." : ""
const has = (w: Words, word: string) => w.words.includes(word)

// a path in a process's working folder (/work, the second process's /work2) or its own node
// (/code/trial, /code/trial2): what is under it, and whose (the second process's, a task starting
// the program twice)
const IN_WORK = /^\/work(2)?\/(.+)$/
const IN_OWN = /^\/code\/trial(2)?\/(.+)$/
const second = (m: RegExpExecArray) => m[1] ? " (the second process's)" : ""
// a handler path of the program's own (in a working folder or its own node)
const ours = (p: string) => IN_WORK.test(p) || p.startsWith("/code/")

// a path as the program would write it
function shown(w: Words, at: string): string {
	// places names only the name for a clash in its folder
	if (at !== "" && !at.includes("/")) return `"${at}"`
	const p = "/" + at.replace(/^\/+/, "")
	if (p === "/work") return "the working folder"
	const wk = IN_WORK.exec(p)
	if (wk) return `./${wk[2]}${second(wk)}`
	const own = IN_OWN.exec(p)
	if (own) {
		const n = own[2]
		return w.own
			? `${w.own(n)} (in the program's own node)${second(own)}`
			: `"${n}" in the program's own node${second(own)}`
	}
	return p
}

// a path as the program would write it in code: "./x", a bare "x" (E, F: "~/x"), "/x"
function pathText(w: Words, at: string): string {
	const p = "/" + at.replace(/^\/+/, "")
	const wk = IN_WORK.exec(p)
	if (wk) return `./${wk[2]}`
	const own = IN_OWN.exec(p)
	if (own && w.own) return w.own(own[2]).slice(1, -1)
	return p
}

// where an error is in the program: its line and the word called there
type Where = { line: number; text: string; word?: string; file?: string }

// the program's line and column in an error: its first frame in the program's file (a load
// error's message names it too), or what run.ts kept of it
export function programAt(s: Seen, url: string): { line: number; column: number } | undefined {
	if (s.line !== undefined) return { line: s.line, column: s.column ?? 1 }
	const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const m = new RegExp(`${esc}:(\\d+):(\\d+)`).exec(`${s.message}\n${s.stack ?? ""}`)
	return m === null ? undefined : { line: Number(m[1]), column: Number(m[2]) }
}

function locate(src: Source | undefined, s: Seen): Where | undefined {
	if (src === undefined) return undefined
	// the file whose frame comes first in the error (the deepest call: counter.jsx's before
	// main.jsx's, when main rendered the component); what run.ts kept (s.line) is the main file's
	const text = `${s.message}\n${s.stack ?? ""}`
	const first = (src.others ?? []).map((o) => ({ o, i: text.indexOf(`${o.url}:`) }))
		.filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0]
	const mine = text.indexOf(`${src.url}:`)
	if (first !== undefined && (s.line === undefined && (mine < 0 || first.i < mine))) {
		const at = locate({ ...first.o, others: [] }, s)
		if (at !== undefined) return { ...at, file: first.o.name }
	}
	const p = programAt(s, src.url)
	if (p === undefined) return undefined
	const t = src.text.split("\n")[p.line - 1]
	if (t === undefined) return undefined
	const word = /^[A-Za-z_$][\w$]*/.exec(t.slice(p.column - 1))?.[0]
	return { line: p.line, text: t.trim(), word }
}

const cut = (t: string, n = 60) => t.length > n ? t.slice(0, n - 1) + "…" : t
const at = (wh: Where | undefined) =>
	wh
		? `${wh.file ? `${wh.file} ` : ""}line ${wh.line} (\`${
			cut(wh.text.replaceAll("`", "'"))
		}\`): `
		: ""
const inParens = (msg: string) => /\(([^)]*)\)/.exec(msg)?.[1]
const json = (v: unknown) => {
	try {
		return v === undefined ? "undefined" : JSON.stringify(v)
	} catch {
		return String(v)
	}
}

// the other lines in the source holding "name" as a string
function linesNaming(src: Source | undefined, name: string, not?: number): number[] {
	if (src === undefined) return []
	const out: number[] = []
	src.text.split("\n").forEach((t, i) => {
		const named = ["", "./", "~/"].some((p) =>
			t.includes(`"${p}${name}"`) || t.includes(`'${p}${name}'`)
		)
		if (i + 1 !== not && named) out.push(i + 1)
	})
	return out
}

// which of the design's computing words wrote that line
function computing(w: Words, wh: Where | undefined): string | undefined {
	if (wh === undefined) return undefined
	for (const word of [w.memo, w.effect, w.method]) {
		const bare = word.replace(/^(e|me)?\./, "")
		if (new RegExp(`\\b${bare.replace(".", "\\.")}\\s*\\(`).test(wh.text)) return word
	}
	return undefined
}

// one error the program could see, as an instruction; none: nothing to say
function errorHint(w: Words, s: Seen, src: Source | undefined, where: string): string | undefined {
	const wh = locate(src, s)
	const code = s.code ?? s.name
	const msg = s.message
	const p = inParens(msg)
	const pre = prefix(w)

	// ermine's own codes, and the adapters' names for them
	if (code === "already-there" || code === "Taken") {
		const name = (p ?? "").split("/").at(-1) || "x"
		const word = computing(w, wh) ?? (wh?.word ? `${pre}${wh.word}` : undefined)
		const others = linesNaming(src, name, wh?.line)
		const before = others.length ? ` (line ${others.join(", ")} already uses "${name}")` : ""
		const like = word === w.effect
			? w.effectOf(`${name}Effect`)
			: word === w.method
			? w.methodOf(`${name}2`)
			: w.memoOf(`${name}Value`)
		return `${at(wh)}a node is already at ${shown(w, p ?? "")}${before}, so the ${
			word ?? "new node"
		} can't be made there: give it another name, like \`${like}\`.`
	}
	if (code === "nothing-there" || code === "Missing") {
		if (p && /(^|\/)work\/work\//.test(p)) {
			return `${at(wh)}the path went into the working folder twice (${
				shown(w, p)
			}): inside it, write "./${p.split("/").at(-1)}", not "./work/…".`
		}
		const word = computing(w, wh)
		if (word !== undefined && p) {
			const up = p.split("/").slice(0, -1).join("/")
			return `${at(wh)}the folder ${shown(w, up)} isn't there, so the ${word} at ${
				shown(w, p)
			} can't be made in it: give it a name with no folder, or make the folder first.`
		}
		if (w.from === "me" && /me\.make it first/.test(msg)) {
			return `${at(wh)}nothing is at that node yet, so ${
				msg.split(":")[0]
			} can't change it: make it first with \`${
				w.open("./x", "start")
			}\` (me.node only names a path).`
		}
		if (
			/^(update|produce)\b/.test(wh?.word ?? "") ||
			(w.key === "g2" || w.key === "g3") && /draft/.test(msg)
		) {
			return `${at(wh)}nothing is at ${
				shown(w, p ?? "")
			} yet, so there is no draft to change: make it with \`${
				w.open("./x", "start")
			}\` or \`x.set(v)\` first.`
		}
		return `${at(wh)}nothing is at ${shown(w, p ?? "that path")} yet, so ${
			wh?.word ? `\`${wh.word}\`` : "the write"
		} can't change it: make it first with \`${w.open(p ? pathText(w, p) : "./x", "start")}\`.`
	}
	if (code === "not-a-method" || code === "NotAMethod") {
		return `${at(wh)}${
			shown(w, p ?? "that path")
		} holds a value, not a handler, so a send can't call it: send only where a handler is (\`${
			w.methodOf("./on/x")
		}\`), and read a value with \`${w.read("x")}\`.`
	}
	if (code === "not-a-name") {
		return `${at(wh)}"${
			p ?? ""
		}" can't be a name in a path: a name is never empty, ".", ".." or "/" (look for "//" or a path ending in "/").`
	}
	if (code === "not-a-patch") {
		if (w.key === "e") {
			return `${
				at(wh)
			}the write isn't a patch: \`e.write(x, value)\` replaces the whole value; one part is \`e.write(x, ["key"], value)\` (the path a list, never a string), and a value is never undefined.`
		}
		if (w.key === "a" || w.key === "d") {
			return `${
				at(wh)
			}the change isn't a list of patches: a patch is \`{ path: ["key"], value }\` (the path a list, the value not undefined); or pass a recipe, \`${
				w.draft("x")
			}\`.`
		}
		return `${
			at(wh)
		}the value written was undefined, and a node can't be given undefined: write a value (null for "nothing"), like \`${
			w.set("x", "null")
		}\`.`
	}
	if (code === "no-key") {
		return `${
			at(wh)
		}a change went through a key that isn't there (or the node holds nothing yet): write the whole value first with \`${
			w.set("x", "value")
		}\`, or check the key.`
	}
	if (code === "wrong-kind") {
		return `${
			at(wh)
		}a change doesn't fit the value there: a number key into a map, a word key into a list, or a list change on something that isn't a list.`
	}
	if (code === "range") return `${at(wh)}a list change reaches past the end of the list.`
	if (code === "into-itself") return `${at(wh)}a node can't be moved into itself.`
	if (code === "closed") {
		return `${
			at(wh)
		}a word was used after the program stopped (a timer or promise ran late): don't leave timers running, or clear them in \`${
			has(w, "teardown") ? "teardown" : has(w, "onCleanup") ? "onCleanup" : `${pre}cleanup`
		}\`.`
	}
	if (code === "disposed" || code === "unscoped") {
		return `${
			at(wh)
		}a word was used where nothing of the program is running (after it ended, or from a stray timer): make nodes, memos and handlers in the program's function.`
	}
	if (/ refused: /.test(msg)) return `${at(wh)}ermine refused it: ${msg}.`

	// the adapters' codes
	switch (code) {
		case "NothingOpen":
			return `${at(wh)}${
				wh?.word ? `\`${wh.word}\`` : "a word"
			} ran with nothing open: the words find the program only while ermine runs its code (its function, a memo, effect, handler, teardown or component), not at a module's top level, from a timer or listener, or after an await; call it before the await, or keep the place with \`const back = here()\` and write \`back(() => …)\` after.`
		case "NoModule":
			return `${
				at(wh)
			}the program imports its words from "ermine": this design has no module to import; ${
				takes(w)
			}.`
		case "Gone":
			return `${
				at(wh)
			}what \`here()\` kept is gone (the call ended, or the run was replaced): keep it in the program's function to use it later.`
		case "NotInApi": {
			if (/after an await/.test(msg)) {
				return `${at(wh)}in ${
					an(w.memo)
				}, every read has to come before the first await (reads after it aren't tracked): read first, then await.`
			}
			if (/caller/.test(msg)) {
				return `${
					at(wh)
				}a program can't see who sent: pass what the handler needs as an argument.`
			}
			if (/createSignal\(fn\)/.test(msg)) {
				return `${
					at(wh)
				}createSignal takes a value, not a function: for a value worked out from others, use \`createMemo(() => …, { name })\`.`
			}
			if (/createStore\(fn\)/.test(msg)) {
				return `${
					at(wh)
				}createStore takes a value, not a function: for a value worked out from others, use \`createMemo(() => …, { name })\`.`
			}
			if (/refresh/.test(msg)) {
				return `${
					at(wh)
				}a memo can't be asked to run again: it runs again by itself when what it read changes, so write the node it reads.`
			}
			if (/error arm/.test(msg)) {
				return `${
					at(wh)
				}createEffect takes (compute, apply) here, with no \`{ error }\`: check for errors in compute.`
			}
			return `${at(wh)}this design can't do that (${msg}): do it another way.`
		}
		case "NotAValue":
			if (w.key === "g2" || w.key === "g3") {
				const d = w.key === "g2" ? "update" : "produce"
				return `${
					at(wh)
				}set takes the whole value, not a function: to change part of it, use \`x.${d}((d) => { … })\`, or write \`x.set(x.get() + 1)\`.`
			}
			if (/can't be sent/.test(msg)) {
				return `${at(wh)}a function can't be sent as an argument: send plain values.`
			}
			if (wh !== undefined && /<\w/.test(wh.text) && /\{/.test(wh.text)) {
				return `${
					at(wh)
				}a node's handle went into the JSX, not its value: put the value in the braces, \`{${
					w.read(bracedName(w, src))
				}}\`, or the value ${w.effect} gives your function.`
			}
			return `${at(wh)}a node's handle was used as its value: read the value with \`${
				w.read("x")
			}\` and write it with \`${w.set("x", "v")}\`.`
		case "NotANode":
			if (/string is a path/.test(msg)) {
				return `${
					at(wh)
				}a string is a path, not a node: pass a handle, \`me.node("./x")\` or the one \`me.make\` gave.`
			}
			return `${at(wh)}that isn't a node (${msg.split(": ").at(-1)}): pass the handle \`${
				w.open("./x", "start").replace(/^const .* = /, "")
			}\` gave${w.from === "e" ? ", or a path string" : ""}.`
		case "BadRecipe":
			if (/sync/.test(msg)) {
				return `${at(wh)}a recipe can't be async: await first, then call \`${
					w.draft("x")
				}\` with what you got.`
			}
			if (/returns nothing/.test(msg)) {
				return `${
					at(wh)
				}me.edit's recipe changes the draft and returns nothing: for a new whole value (a number, say), use \`me.write(x, value)\`.`
			}
			return `${at(wh)}that word takes a function changing a draft, \`${
				w.draft("x")
			}\`; to replace the value, \`${w.set("x", "v")}\`.`
		case "BadPatch":
			return `${
				at(wh)
			}e.patch takes \`[{ op: "replace", at: ["key"], value }]\` or \`[{ op: "remove", at: [0] }]\`.`
		case "BadPath":
			return `${at(wh)}a path is a string, like "./count".`
		case "OutsideRoot":
			return `${at(wh)}the path climbs above the root: too many "..".`
		case "NotHere": {
			const word = msg.split(" in a")[0].replace(/^node\(path, start\)$/, "node")
			const kind = msg.split(" in a ").at(-1)?.replace(/ e$/, "") ?? ""
			if (word === "node") {
				return `${at(wh)}inside ${
					an(w.memo)
				}'s function, ${pre}node(path) can't make a node: make it in the program, with its start value.`
			}
			if (["memo", "effect", "handler", "compute", "answer"].includes(word)) {
				return `${
					at(wh)
				}${pre}${word} can only be made in the program's own function, not in a ${kind}: move it to the top level of the program.`
			}
			return `${at(wh)}${pre}${word} can't be used in a ${
				kind === "compute" || kind === "run"
					? `${w.memo}'s or ${w.effect}'s first function`
					: kind
			} (it only reads): write in ${
				w.key === "e"
					? "the effect's act, `(e, now) => …`,"
					: "the effect's act, `(now, before, me) => …`,"
			} or in a handler.`
		}
		case "Ended":
			if (/sender's me/.test(msg)) {
				return `${
					at(wh)
				}the me that sent ended before the answer came: send from the setup or a handler, and await it there.`
			}
			if (/call|act/.test(msg)) {
				return `${at(wh)}the ${/call/.test(msg) ? "handler" : "act"}'s ${
					pre.slice(0, -1)
				} ended when it returned, and was used later (after an await or in a .then): make it async and await inside it, so it lasts till the work is done.`
			}
			return `${at(wh)}that ${
				pre.slice(0, -1)
			} is over (${msg}): use the one the function you are in was given.`
		case "WrongE":
		case "WrongMe": {
			const me = w.key === "e" ? "e" : "me"
			return `${
				at(wh)
			}the outer \`${me}\` was used inside another function: use the \`${me}\` that function is given, named \`${me}\` so it shadows the outer one (\`(${me}) => ${me}.read(x)\`).`
		}
		case "Pending":
			return `${at(wh)}${w.read("x")} of a node with no value yet throws Pending outside ${
				an(w.memo)
			}: read it inside ${an(w.memo)} or ${
				an(w.effect)
			}'s first function (it waits there), or check \`e.status(x)\` first.`
		case "NotReady":
			return `${
				at(wh)
			}that node has no value yet: \`await me.ready(x)\` first, or read it inside a me.compute or me.effect.`
		case "Looping":
		case "looping":
			return `${at(wh)}it loops: something writes what it reads, again and again; ${
				an(w.memo)
			} only reads, and ${an(w.effect)}'s act shouldn't write what its first function reads.`
		case "Computed":
			return `${
				at(wh)
			}that node is a me.compute's: it holds the result; write the nodes it reads instead.`
		case "Failed":
			return `${at(wh)}the handler it sent to threw: ${msg}.`
		case "StoreWrite":
			return `${
				at(wh)
			}a store can't be assigned to: change it with its setter, \`setStore((d) => { d.key = … })\`.`
		case "BadSetter":
			return `${
				at(wh)
			}setStore takes a function of the draft: \`setStore((d) => { d.items.push(x) })\`; a whole new value: \`setStore(() => value)\`.`
		case "PENDING":
			return where === "send"
				? `${
					at(wh)
				}the handler stopped on PENDING: it sent to a path with no handler, or read ${
					an(w.memo)
				} with no value yet; a handler doesn't wait for those, so send or read only what is there${
					w.promise ? `, or await \`${w.send("…")}\`` : ""
				}.`
				: undefined
	}

	// JavaScript's own
	if (s.name === "SyntaxError" || /SyntaxError/.test(msg)) {
		if (/reserved word/.test(msg)) {
			if (wh && /\byield\b/.test(wh.text)) {
				return `${at(wh)}\`yield\` works only inside \`function* () { … }\`${
					w.key === "k" ? " (as in `action(function* () { … })`)" : ""
				}.`
			}
			return `${
				at(wh)
			}\`await\` is used in a function that isn't async: put \`async\` before that function (\`async () => { … }\`, \`async function\`)${
				w.promise
					? ""
					: `; ${
						w.send("…").split("(")[0]
					} gives the handler's reply itself, so a sync handler needs no await`
			}.`
		}
		if (/does not provide an export/.test(msg)) return `${at(wh)}${exportHint(w, msg)}`
		if (/has already been declared/.test(msg)) {
			const name = /Identifier '([^']+)'/.exec(msg)?.[1] ?? "it"
			return `${at(wh)}\`${name}\` is declared twice: ${
				has(w, name) ? `it is already one of the design's words; don't declare it again, ` : ""
			}give one of them another name.`
		}
		return `${at(wh)}the file doesn't parse (${cut(msg.split("\n")[0], 80)}): fix that line.`
	}
	if (
		/Module not found|not a dependency|not in import map|package not found|does not exist/.test(
			msg,
		)
	) {
		const spec = /"([^"]+)"/.exec(msg)?.[1] ?? /'([^']+)'/.exec(msg)?.[1] ?? "a module"
		const file = spec.replace(/^file:\/\/.*\//, "./")
		if (file.startsWith("./") || file.startsWith("../")) {
			return `the program imports ${file}, which isn't there: a try's files sit side by side (main.jsx, counter.jsx), so import \`./counter.jsx\`, the name exactly.`
		}
		if (spec === "ermine" && w.from !== "import") {
			return `the program imports "ermine": this design has no module to import; ${takes(w)}.`
		}
		return `the program imports ${file}, which isn't there: ${
			w.from === "import" ? `import only from "ermine" and your own files` : "no imports"
		}; ${takes(w)}.`
	}
	if (/default export is not a function/.test(msg)) {
		return `the file has no default export function: write \`${w.head}\`.`
	}
	if (s.name === "ReferenceError" || /is not defined/.test(msg)) {
		const name = /(\S+) is not defined/.exec(msg)?.[1] ?? "it"
		return `${at(wh)}${undefinedHint(w, name)}`
	}
	if (s.name === "TypeError" || /TypeError/.test(msg)) return typeHint(w, msg, wh)
	if (s.name === "RangeError" && /call stack/.test(msg)) {
		return `${
			at(wh)
		}something calls itself without end: a handler that sends to its own path, or ${
			an(w.effect)
		} whose act writes what it reads.`
	}
	if (where === "send" && msg) return `${at(wh)}the handler threw: ${cut(msg, 80)}.`
	return undefined
}

// an import of a name its module doesn't export: ermine's (a word L hasn't), another file's
function exportHint(w: Words, msg: string): string {
	const name = /export named '([^']+)'/.exec(msg)?.[1] ?? /export named "([^"]+)"/.exec(msg)?.[1]
	const from = /from ['"]?([^'" ]+)['"]?$/m.exec(msg)?.[1] ?? ""
	if (/designs\/l\/ermine\.ts/.test(msg) || from === "ermine") {
		const kind = name ? kinds[name] : undefined
		return `"ermine" has no word \`${name ?? "that"}\`${
			kind ? `; for that, write \`${wordFor(w, kind)}\`` : ""
		}: its words are ${w.words.filter((x) => x !== "show").join(", ")}, show.`
	}
	if (w.from !== "import" && !/\.(jsx|tsx?)/.test(msg)) {
		return `the program imports a module: no imports here; ${takes(w)}.`
	}
	return `a file imports \`${
		name ?? "a name"
	}\`, which the file it names doesn't export: write \`export function ${
		name ?? "Counter"
	}(props) { … }\` there, the name exactly.`
}

function takes(w: Words): string {
	if (w.from === "api") return `take the words from api: \`${w.head}\``
	if (w.from === "e") return "every word is on e: `export default function (e) { e.node(…) }`"
	if (w.from === "me") return "every word is on me: `export default function (me) { me.make(…) }`"
	if (w.from === "import") return `import the words from "ermine": \`${w.head}\``
	return `the words are globals, there already: \`${w.head}\``
}

function undefinedHint(w: Words, name: string): string {
	const pre = prefix(w)
	if (name === "api" && w.from === "import") {
		return `\`api\` is not defined: there is none here; import the words from "ermine", \`${w.head}\`.`
	}
	if (name === "api") {
		return w.from === "globals"
			? `\`api\` is not defined: the words are globals here, use them as they are (or name the function's argument api).`
			: `\`api\` is not defined: it is the function's argument, \`${w.head}\`.`
	}
	if (name === "e" || name === "me") {
		return w.from === name
			? `\`${name}\` is not defined there: it is each function's first argument, \`(${name}) => …\`.`
			: `\`${name}\` is not defined: this design has none; ${takes(w)}.`
	}
	if (w.given?.includes(name)) {
		if (w.from === "import") {
			return `\`${name}\` is not defined: it is given to the program's function, \`export default function ({ ${name} }) { … }\` (pass it down to a component that needs it).`
		}
		if (w.from === "api") {
			return `\`${name}\` is not defined: it is given in api, \`const { ${name} } = api\`.`
		}
		if (w.from !== "globals") {
			return `\`${name}\` is not defined: it is on ${w.from}, \`${pre}${name}(…)\`.`
		}
	}
	if (has(w, name)) {
		if (w.from === "import") {
			return `\`${name}\` is not defined: import it, \`import { ${name} } from "ermine"\`, in each file that uses it.`
		}
		if (w.from === "api") {
			return `\`${name}\` is not defined: take it from api, \`const { ${name} } = api\`.`
		}
		if (w.from !== "globals") {
			return `\`${name}\` is not defined: it is on ${w.from}, \`${pre}${name}(…)\`.`
		}
	}
	const kind = kinds[name]
	if (kind !== undefined) {
		return `\`${name}\` is not defined: there is no \`${name}\` in this design; for that, write \`${
			wordFor(w, kind)
		}\`.`
	}
	if (EXAMPLES.has(name)) {
		return `\`${name}\` is not defined: it is a name from the sheet's examples, not one of yours; declare your own node (\`${
			w.open("./x", "start")
		}\`) and use its name.`
	}
	return `\`${name}\` is used but never declared: declare it first (\`const ${name} = …\`), or check the spelling.`
}

function typeHint(w: Words, msg: string, wh: Where | undefined): string {
	// an effect given one function: the adapter or ermine trips on the missing act
	const effectWord = w.effect.replace(/^(e|me)?\./, "")
	const onEffect = wh !== undefined && new RegExp(`\\b${effectWord}\\s*\\(`).test(wh.text)
	if (/\bact is not a function|code\.act/.test(msg) || onEffect && /reading 'error'/.test(msg)) {
		return `${
			at(wh)
		}${w.effect} takes two functions: the first reads what to watch, the second gets its value and does the showing, \`${
			w.effectOf("name")
		}\`.`
	}
	const notFn = /([\w$.()[\]'"]+) is not a function/.exec(msg)?.[1]
	if (notFn !== undefined) {
		const parts = notFn.split(".")
		const last = parts.at(-1)!
		if (last === "then" || last === "catch") {
			return w.promise
				? `${at(wh)}that isn't a promise: only \`${w.send("…")}\` gives one.`
				: `${at(wh)}${
					w.send("…").split("(")[0]
				} gives the handler's reply itself, not a promise: use it directly, \`const reply = ${
					w.send("/path")
				}\`.`
		}
		if (
			parts.length > 1 &&
			/^(d|draft\w*|prev\w*|old\w*|current\w*|list|items|todos)$/.test(parts[0])
		) {
			return `${
				at(wh)
			}\`${notFn}\` isn't there: the value there isn't a list (or a map) yet; start the node as one, \`${
				w.open("./x", "[]")
			}\`.`
		}
		if (parts.length > 1) {
			const kind = kinds[last]
			return `${at(wh)}\`${notFn}\` isn't there: ${w.handle}${
				kind ? `; for that, write \`${wordFor(w, kind)}\`` : ""
			}.`
		}
		const kind = kinds[last]
		if (kind !== undefined && !has(w, last)) {
			return `${at(wh)}\`${last}\` isn't a word of this design: for that, write \`${
				wordFor(w, kind)
			}\`.`
		}
		return `${at(wh)}\`${last}\` isn't a function there: ${w.handle}.`
	}
	const prim = /Cannot create property '([^']+)' on (\w+) '([^']*)'/.exec(msg)
	if (prim) {
		return `${at(wh)}the recipe's draft is a ${prim[2]} (${prim[3]}), so \`.${
			prim[1]
		} = …\` can't work: a node holds its value directly; give the new value instead, like \`${
			prim[2] === "number" ? w.bump("x") : w.set("x", "v")
		}\`.`
	}
	const bare = /Cannot destructure property '([^']+)' of '([^']+)' as it is (undefined|null)/
		.exec(msg)
	if (bare) {
		const [, name, of] = bare
		return `${at(wh)}\`${of}\` is ${bare[3]} where you take \`${name}\` out of it${
			/^(api|e|me|props)$/.test(of) || w.from === "api"
				? `: a component gets only the props it is given; pass it down, \`<Counter ${
					w.from === "api" ? "api={api}" : `${w.from}={${w.from}}`
				} name="a" />\`, and take it from the props, \`function Counter({ ${
					w.from === "api" ? "api" : w.from
				}, name })\``
				: ""
		}.`
	}
	const unset = /Cannot set properties of (undefined|null) \(setting '([^']+)'\)/.exec(msg)
	if (unset) {
		return `${at(wh)}the value was ${unset[1]} where you set \`.${
			unset[2]
		}\`: the node holds nothing yet; make it with a start value (\`${
			w.open("./x", "{}")
		}\`), or replace the whole value, \`${w.set("x", "{ … }")}\`.`
	}
	const unread = /Cannot read properties of (undefined|null) \(reading '([^']+)'\)/.exec(msg)
	if (unread) {
		return `${at(wh)}something was ${unread[1]} where you read \`.${
			unread[2]
		}\`: a node not there yet (or ${
			an(w.memo)
		} with no value yet) reads as undefined; check for that, or give the node a start value.`
	}
	const iter = /(\S+) is not iterable/.exec(msg)
	if (iter) {
		return `${at(wh)}\`${
			iter[1]
		}\` isn't a list there: a node not there yet reads as undefined; start it as a list, \`${
			w.open("./x", "[]")
		}\`.`
	}
	return `${at(wh)}${cut(msg, 100)}.`
}

// the name a program put in a JSX element's braces, \`{count}\`: the first one in its source
function bracedName(w: Words, src: Source | undefined): string {
	for (const t of src?.text.split("\n") ?? []) {
		if (!/<\w/.test(t)) continue
		for (const m of t.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
			if (!has(w, m[1]) && !["e", "me", "api"].includes(m[1])) return m[1]
		}
	}
	return "x"
}

// a JSX element shown with a node's handle in it: [object Object] (A, D, G's handles), a
// function's source (B, C, H–K's, a function), [node /path] (F's); E's throws as it renders
function jsxHint(w: Words, line: string, src: Source | undefined): string | undefined {
	const object = /\[object \w+\]|\[node \/[^\]]*\]/.test(line)
	const fn = /=>|\bfunction\b|\[native code\]/.test(line)
	if (!object && !fn) return undefined
	const x = bracedName(w, src)
	return `you showed "${cut(line, 40)}": ${
		fn ? "a function (a node's handle)" : "a node's handle"
	} went into the JSX (\`{${x}}\`), not its value: put the value in the braces, \`{${
		w.read(x)
	}}\`, or the value ${w.effect} gives your function.`
}

// a line shown, read for what went wrong in it
function shownHint(w: Words, line: string): string | undefined {
	if (/\[object Object\]/.test(line)) {
		return `you showed "${
			cut(line, 40)
		}": an object went into the text; show one of its fields, or JSON.stringify it.`
	}
	if (/\bNaN\b/.test(line)) {
		return `you showed "${
			cut(line, 40)
		}": a sum on something not a number (undefined, or an object like { value: 2 }).`
	}
	if (/\bundefined\b/.test(line)) {
		return `you showed "${
			cut(line, 40)
		}": the value was undefined: a node not there yet, a field the value doesn't have, or ${
			an(w.memo)
		} with no value yet.`
	}
	if (/\bnull\b/.test(line)) {
		return `you showed "${cut(line, 40)}": the value was null${
			w.key === "e"
				? ": `e.node(path)` with no start makes the node holding null, so it is there (done) with nothing in it; read it and check for null"
				: ": the node is there holding null; check for null before showing it"
		}.`
	}
	return undefined
}

export function hints(run: RunFacts, design: string, source?: Source): string[] {
	const base = table[design] ?? table[names[design] ?? ""]
	if (base === undefined) return []
	const key = table[design] ? design : names[design]
	const given = [...new Set(run.trials.flatMap((t) => t.given ?? []))]
	const w: Words = { ...base, key, given }
	const out: string[] = []
	const inner = new Set<string>()
	const add = (h: string | undefined) => {
		if (h !== undefined && !out.includes(h)) out.push(h)
	}
	// JSX in a .ts or .js file: deno parses it only in a .jsx (or .tsx) file
	if (
		run.load && source && /\.(ts|js)$/.test(source.url) &&
		/<[A-Za-z][^>]*>[^<]*<\/|<[A-Za-z][^>]*\/>/.test(source.text)
	) {
		add(
			"the program has JSX in a .ts file, and JSX parses only in a .jsx file: name the file .jsx (the harness gives `h`; no import for it).",
		)
	}
	if (run.load) add(errorHint(w, run.load, source, "load"))
	for (const t of run.trials) {
		if (t.setup?.error) add(errorHint(w, t.setup.error, source, "setup"))
		for (const e of t.errors) add(errorHint(w, e.error, source, e.at.split(" ")[0]))
		for (const c of t.computers) {
			const hidden = c.path.split("/").at(-1)!.startsWith(".")
			const name = hidden ? `your ${w.effect}` : shown(w, c.path)
			if (c.error) {
				const h = errorHint(w, c.error, source, "run")
				const what = hidden
					? name
					: c.phase === "act"
					? `the act of the ${w.effect} at ${name}`
					: `${name}`
				// one error seen by several memos and effects (one read another): said once
				if (h !== undefined && inner.has(h)) continue
				if (h !== undefined) inner.add(h)
				add(h ? `${what} failed: ${h}` : `${what} failed: ${cut(c.error.message, 80)}.`)
				continue
			}
			if (c.state === "looping") {
				add(errorHint(w, { name: "Looping", message: "looping" }, source, "run"))
				continue
			}
			// the adapters' hidden waits are said by the waits below
			if (hidden && /\.wait-\d+$/.test(c.path)) continue
			if (hidden && /\.watch-\d+$/.test(c.path)) {
				for (const r of c.reads ?? []) {
					add(
						`your watch on ${shown(w, r)} hasn't been called: nothing is at ${
							shown(w, r)
						} yet.`,
					)
				}
				continue
			}
			for (const why of c.waiting ?? []) {
				if (why.startsWith("send ")) {
					add(`${name} is waiting on its send to ${why.slice(5)}: nothing answers there yet.`)
				} else if (why.startsWith("node ")) {
					// someone else's node (not the program's own memo): how to give a value meanwhile
					const at = why.slice(5)
					const theirs = !ours(at) && at.startsWith("/") && w.pending !== undefined
					add(
						`${name} is waiting on ${shown(w, at)}, which has no value yet${
							theirs
								? `; to give a value meanwhile, check \`${
									w.pending!("x")
								}\` before reading it (x the node at ${at})`
								: ""
						}.`,
					)
				} else if (why === "a promise") {
					add(`${name} is waiting on its async function, which hasn't finished.`)
				}
			}
		}
		// a setup runs once (chee 10-25: "setup is untracked, runs once. like solid."): one that
		// sent to nothing, or read a memo with no value yet, stays pending and is never run again
		const setupWaits = t.setup?.state === "pending" ? t.setup.waiting ?? [] : []
		const inSetup = `a setup is never run again, so send in ${an(w.memo)} or ${
			an(w.effect)
		}, which runs again once a handler is there: \`${
			w.effectOf("name").replace(/\(\) => (read\(x\)|x\(\)|x\.read\(\))/, "() => send(…)")
				.replace("(value) => show(…)", "(reply) => …")
		}\``
		for (const x of t.waits) {
			const last = x.send.split("/").at(-1) ?? ""
			const fn = w.given?.includes(last)
			const own = IN_OWN.test(x.send)
			const setup = setupWaits.includes(`send ${x.send}`)
			add(
				`your send to ${shown(w, x.send)} is still waiting: nothing answers there yet${
					fn
						? `; \`${last}\` is a function you were given: call it, \`await ${
							prefix(w)
						}${last}(…)\`, rather than sending.`
						: own
						? `; a bare name is in the program's own node: for the working folder write "./…", for the root "/…".`
						: setup && !w.promise
						? `, and the setup sent it: ${inSetup}.`
						: w.promise || setup
						? "."
						: `; a send with no handler throws PENDING, and a try/catch around it swallowed that: let PENDING through, and send in ${
							an(w.memo)
						} or ${an(w.effect)}, which runs again once a handler is there.`
				}`,
			)
		}
		for (const c of t.calls ?? []) {
			if (!ours(c.handler)) continue
			if (c.error) {
				const h = errorHint(w, c.error, source, "send")
				add(h ?? `the handler at ${shown(w, c.handler)} threw: ${cut(c.error.message, 80)}.`)
			} else if (c.end === "done" && c.writes === 0 && !c.async) {
				add(
					`your handler at ${
						shown(w, c.handler)
					} ran but wrote nothing: a recipe that only reassigns its argument (\`d += 1\`, \`d = v\`) changes nothing; give the new value, like \`${
						w.bump("x")
					}\` or \`${w.set("x", "v")}\`.`,
				)
			}
		}
		if ((t.shownPromises ?? 0) > 0) {
			add(
				`you showed a promise (it shows as "{}")${
					w.promise
						? `: \`${
							w.send("…")
						}\` gives one; await it in an async function, \`const reply = ${
							w.send("/path")
						}\`, then show the reply`
						: ": await it in an async function first, then show what it gave"
				}.`,
			)
		}
		for (const p of t.promises ?? []) {
			add(
				`${
					shown(w, p)
				} holds a promise: a node can't hold one; await it in an async function, then write what it gave.`,
			)
		}
		if (t.setup?.state === "pending") {
			for (const why of t.setup.waiting ?? []) {
				if (why.startsWith("node ")) {
					add(
						`the setup is waiting on ${
							shown(w, why.slice(5))
						}, which has no value yet, and a setup is never run again: read it in ${
							an(w.memo)
						} or ${an(w.effect)}, which runs again once it is there.`,
					)
				} else if (why === "PENDING" && !w.promise) {
					add(
						`the setup stopped on PENDING (it read ${
							an(w.memo)
						} with no value yet, or sent to nothing), and a setup is never run again: do that in ${
							an(w.memo)
						} or ${an(w.effect)}, which runs again once it is there.`,
					)
				} else if (why === "a promise") {
					add(
						`the program's function returned a promise that hasn't settled: what it awaits never came.`,
					)
				}
			}
		}
		for (const p of t.unanswered) {
			if (t.handlers.includes(p)) {
				add(
					`a send to ${
						shown(w, p)
					} found no handler at the time: it is made later (after an await, or in ${
						an(w.memo)
					}, ${w.effect} or handler); make handlers in the program's function, first, before anything that waits.`,
				)
				continue
			}
			const mine = t.handlers.filter(ours)
			add(
				`a send to ${shown(w, p)} found no handler there${
					mine.length
						? `; your handlers are at ${mine.map((h) => shown(w, h)).join(", ")}`
						: `; make one with \`${w.methodOf(pathText(w, p))}\``
				}.`,
			)
		}
		for (const h of t.handlers) {
			if (ours(h) || !t.wrote?.includes(h)) continue
			add(
				`your program put a handler at ${h}, outside its own folders, over what was there: that path is someone else's; send to it, and put your own handlers under "./".`,
			)
		}
		for (const p of t.wrote ?? []) {
			const name = p.split("/").at(-1) ?? ""
			if (name === "lamp" || name === "level") {
				add(
					`your program wrote ${
						shown(w, p)
					}: "${name}" is the sheet's example, not this task's; use the names the task gives.`,
				)
			}
		}
		for (const s of t.shapes) {
			const own = s.path.split("/").at(-1)
			if (s.key !== "value" && s.key !== own && !EXAMPLE_KEYS.has(s.key)) continue
			const v = json(s.value)
			add(
				`${
					shown(w, s.path)
				} holds { ${s.key}: ${v} }: a node holds its value directly; write ${v}, not { ${s.key}: ${v} }.`,
			)
		}
		for (const line of t.shown) {
			const jsx = t.shownJsx?.includes(line) ? jsxHint(w, line, source) : undefined
			add(jsx ?? shownHint(w, line))
		}
	}
	for (const r of run.rejected) {
		const h = errorHint(w, r, source, "rejection")
		add(h ? `a promise rejected with nobody awaiting it: ${h}` : undefined)
	}
	for (const u of run.uncaught ?? []) {
		const h = errorHint(w, u, source, "uncaught")
		add(h ? `code nobody called (a timer, a listener) threw: ${h}` : undefined)
	}
	// what went wrong first, what the program showed last
	const rank = (h: string) =>
		h.startsWith("you showed") ? 2 : h.startsWith("your program wrote") ? 1 : 0
	return out.map((h, i) => [rank(h), i, h] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
		.map(([, , h]) => h)
}
