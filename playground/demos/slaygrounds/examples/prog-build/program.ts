import {
	createAction,
	createEffect,
	createMemo,
	ensureNode,
	list,
	patch,
	read,
} from "@ermine/system"
import { host } from "@ermine/slaygrounds/tools"
import { bind, h, handler } from "ermine-h"
import type { Extra } from "./host.ts"

// program.ts has two things. files is the disk: each entry is a node in the graph at its path,
// code its value, the rest its attributes. a reload writes only the entries that changed since the
// last one, so edit fib.c and only its chain rebuilds. each short name is written as the attribute
// @ermine/programs reads (its ATTRIBUTES):
//
//   type: "public.c-source"      what a node is: a UTI, its node in /ermine/types
//   loaders: true                a folder whose children are loaders, in its place
//   takes: [...]                 a loader: the types it takes (and all conforming to them)
//   gives: "..."                 a compiler: what it makes. none: a runner, running it
//
// started, a program is run by the chains satisfy finds from its folder up. the page's own
// loaders (js, wasm, and cc: clang on this machine) and the keys (print, secret) are not files:
// they are live, so the host makes them (host.ts). a process runs in a folder of its own, its box:
// a key it is given is a node placed there (keys/print), and it sees nothing else. a program that
// uses another has that one's exports placed at /uses/<name>. a program is given nothing: it
// imports @ermine/system
//
// shell is the view of all this, a process like any other: it reads the graph and asks for
// everything by running the host's actions. edit a file and watch the build log: a comment
// change in fib.c is compiled (a miss), comes out the same bytes (a cutoff), and nothing after it
// runs again; change it back and it is a hit
export const files = {
	"loaders": { loaders: true },
	"c/fib.c": {
		type: "public.c-source",
		code: `// fib.c: compiled by cc (only under /c), run as wasm. a function not static is
// exported; one declared and not defined is an import, linked only if a key of that name is
// in its box: print is
void print(int n);

int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

int main(void) {
	for (int i = 0; i < 10; i++) print(fib(i));
	return 0;
}
`,
	},
	"c/sandbox/escape.c": {
		type: "public.c-source",
		code: `// escape.c: asks for secret. its box holds print: secret is not, so this does not
// link. started again from /c/vault, a folder that holds keys/secret too, it does
int secret(void);
void print(int n);

int main(void) {
	print(secret());
	return 0;
}
`,
	},
	"apps/table.js": {
		type: "com.netscape.javascript-source",
		code: `// table.js: hot. /uses/fib is a placement in its box: fib's exports. when fib.c runs
// again this is started again, on the new ones. it is given nothing: it imports what it uses
import { ensureNode, patch, read } from "@ermine/system"
export default () => {
	const { fib } = read("/uses/fib")
	const rows = []
	for (let n = 10; n < 15; n++) rows.push("fib(" + n + ") = " + fib(n))
	patch(ensureNode("shown", []), [{ path: [], value: rows }])
	return rows.length + " rows"
}
`,
	},
	"apps/chart.js": {
		type: "com.netscape.javascript-source",
		code: `// chart.js: pinned, so it keeps the run it has. edit fib.c and it says it runs with a
// fib it would not get next time, until you pick up
import { ensureNode, patch, read } from "@ermine/system"
export default () => {
	const { fib } = read("/uses/fib")
	const bars = []
	for (let n = 1; n < 9; n++) bars.push(n + " " + "▮".repeat(fib(n)))
	patch(ensureNode("shown", []), [{ path: [], value: bars }])
}
`,
	},
	"apps/sneaky.js": {
		type: "com.netscape.javascript-source",
		code: `// sneaky.js: reaches for what it was not handed. javascript here shares the iframe's
// globals, so for javascript the box is a convention: it is given a folder, it can reach more.
// the fetch is a promise a memo returns: it is pending while it is out, and shown is a memo of it
import { createMemo, list, PENDING, read } from "@ermine/system"
export default () => {
	const keys = list("/keys")
	const lines = ["handed: " + keys.join(", ")]
	lines.push("/keys/secret: " + (keys.includes("secret") ? "handed" : "not handed (not in my box)"))
	lines.push("globalThis.ermine: " + (globalThis.ermine ? "REACHED: the store, every key" : "no"))
	createMemo("fetched", () =>
		fetch(new URL("compile", parent.__base ?? parent.location.origin + "/"), {
			method: "POST",
			body: "int f(void) { return 1; }",
		}).then((r) => r.status)
	)
	createMemo("shown", () => {
		try {
			return [...lines, "fetch('/compile'): REACHED, the server answered " + read("fetched")]
		} catch (e) {
			if (e === PENDING) return lines
			throw e
		}
	})
	return "reached past its folder"
}
`,
	},
	"notes.txt": {
		type: "public.plain-text",
		code: "nothing on the way up takes plain text, so this never builds: edit it and " +
			"nothing rebuilds",
	},
}

// ---- the shell ----
const sameJSON = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const short = (x: unknown) => (typeof x === "string" ? x.slice(0, 6) : "none")
const nick = (uti: string) => (typeof uti === "string" ? uti.split(".").pop() : "?")

export function shell() {
	const { plan, programs, write } = host<Extra>()
	// the picked program: a ./ node, so a reload keeps it
	const selected = ensureNode("./selected", "/c/fib.c")
	createAction("on/select", (path: string) => patch(selected, [{ path: [], value: path }]))

	// what the view shows, as nodes inside the shell: each a memo, each bound below
	createMemo("programs", () => ({
		list: programs(),
		selected: read(selected),
		running: ((read("/state/procs") ?? []) as { path: string }[]).map((p) => p.path),
	}), { equal: sameJSON })
	createMemo("plan", () => plan(read(selected) as string), { equal: sameJSON })
	createMemo("cache", () => list("/cache").length)

	// the code: a textarea the shell drives itself. it follows the picked node's value, but not
	// while it is being typed in (a binding would put back an older value over the newest keys);
	// what is typed is written a moment after the last key, by the host (a timer has nothing open)
	let code: HTMLTextAreaElement | undefined
	const typed = () => write(code!.dataset.path!, code!.value)
	createEffect("editor", () => {
		const path = read(selected) as string
		return { path, code: read(path) }
	}, (v) => {
		if (code && (document.activeElement !== code || code.dataset.path !== v.path)) {
			code.value = (v.code as string) ?? ""
			code.dataset.path = v.path
		}
	}, { equal: sameJSON })

	return h(
		"div",
		{ class: "shell" },
		h("style", null, CSS),
		h("div", { class: "card bar" }, bind("programs", programsView)),
		h(
			"div",
			{ class: "two" },
			h("div", { class: "card" }, bind("plan", walkView)),
			h("div", { class: "card" }, bind("plan", chainView)),
		),
		h(
			"div",
			{ class: "card" },
			h(
				"h3",
				null,
				"code ",
				h("span", { class: "path mono" }, bind("selected")),
				h(
					"small",
					null,
					" the node's value: an edit here writes it (program.ts is not changed)",
				),
			),
			h("textarea", {
				spellcheck: false,
				rows: 8,
				onInput: typed,
				ref: (el: any) => (code = el),
			}),
		),
		h("div", { class: "card" }, bind("/state/log", buildView), bind("cache", cacheView)),
		h("div", { class: "card" }, bind("/state/procs", procsView)),
	)
}

// ---- the views: what each node holds, drawn ----
const e = (tag: string, cls = "", ...kids: unknown[]) =>
	h(tag, cls ? { class: cls } : null, ...kids)
const pressed = (text: string, cls: string, path: string, args: unknown[] = []) =>
	h("button", { class: cls, onClick: handler(path, args) }, text)

function programsView(v: any) {
	const count = new Map<string, number>()
	for (const x of v.list) count.set(x.name, (count.get(x.name) ?? 0) + 1)
	return [
		e("b", "", "programs"),
		v.list.map((x: any) => {
			const label = count.get(x.name)! > 1 ? x.path.split("/").slice(-2).join("/") : x.name
			const running = v.running.includes(x.path)
			return h(
				"span",
				{ class: "pick", key: x.path },
				h(
					"button",
					{
						class: "tag" + (x.path === v.selected ? " on" : ""),
						title: `${x.path}: ${x.type}`,
						onClick: handler("on/select", [x.path]),
					},
					label,
				),
				running ? h("span", { class: "dot", title: "running" }, "●") : h(
					"button",
					{ class: "play", title: "start it", onClick: handler("/ctl/on/start", [x.path]) },
					"▶",
				),
			)
		}),
	]
}

// a reason satisfy gave, plainly
const fits = (why: string | null) => why !== null && !/^(wrong|unknown)-type/.test(why)

function walkView(v: any) {
	const chip = (o: any) =>
		h(
			"span",
			{
				class: `chip loader${o.step ? " used" : ""}${o.runs.length ? " handed" : ""}${
					!o.step && !o.runs.length && fits(o.why) ? " near" : ""
				}`,
				title: o.path + (o.why ? ` · not taken: ${o.why}` : ""),
			},
			o.step ? e("span", "n", String(o.step)) : "",
			e("b", "", o.name),
			` ${o.takes.join("+")} → ${o.gives ?? "runnable"}`,
			o.runs.length
				? ` · runs ${o.runs.join(", ")}`
				: !o.step && o.why
				? e("span", "whynot", ` · ${o.why}`)
				: "",
		)
	return [
		e("h3", "", "the way up", e("small", "", `from ${v.program} to the root, nearest first`)),
		v.missing ? e("p", "bad", v.missing) : [
			v.walk.map((level: any) =>
				e(
					"div",
					"level",
					e("span", "path mono", level.at),
					e(
						"div",
						"offers",
						level.seen.length ? level.seen.map(chip) : e("span", "why", "no loader here"),
					),
				)
			),
			e(
				"div",
				"why",
				"satisfy's candidates: a member that takes types is a loader; a folder with loaders " +
					"offers its children in its place; never down. each one not taken says why. keys " +
					"are not found here: they are placed in a process's folder",
			),
		],
	]
}

// what runs a step: its own chain, down to the page
const runBy = (x: any): string =>
	x.by.length === 0
		? "the page"
		: x.by.map((y: any) => y.name).join(" → ") + " ← " + runBy(x.by.at(-1))

function chainView(v: any) {
	const head = e(
		"h3",
		"",
		"the chain",
		e("small", "", `${v.file ?? ""} is ${v.type ?? "untyped"}`),
	)
	if (v.missing) return head
	const own = (v.why ?? []).filter((w: any) => w.own)
	return [
		head,
		!v.steps ? e("div", "err", "✗ no chain: " + v.whyNot) : e(
			"ol",
			"steps",
			e(
				"li",
				"",
				e("span"),
				e(
					"span",
					"",
					e("span", "tag", nick(v.type)),
					" ",
					e("span", "path mono", v.program),
					e("span", "why", ` code ${short(v.code)}`),
				),
			),
			v.steps.map((x: any, i: number) => [
				e(
					"li",
					"step",
					e("span", "n big", String(i + 1)),
					e(
						"span",
						"",
						e("b", "", x.name),
						" ",
						e("span", "path mono", x.path),
						e(
							"span",
							"why",
							` ${x.gives ? "compiler" : "runner"} · run by ${runBy(x)} · ${
								x.host ? "identity" : "code"
							} ${short(x.hash)}`,
						),
					),
				),
				e(
					"li",
					"",
					e("span", "down", "↓"),
					e("span", "", e("span", "tag", x.gives ? nick(x.gives) : "runnable")),
				),
			]),
		),
		v.chains.length > 1
			? e(
				"div",
				"why",
				"also: ",
				v.chains.slice(1).map((c: string[]) => c.map((p) => p.split("/").pop()).join(" → "))
					.join("; "),
			)
			: null,
		own.length
			? e(
				"div",
				"given",
				"not taken ",
				own.map((w: any) =>
					e("span", "chip", e("b", "", w.name), ` ${w.why}${w.missing ? " " + w.missing : ""}`)
				),
			)
			: null,
		e(
			"div",
			"why",
			"every chain from what it is to a runner the page has, nearest first; the first runs. a " +
				"process is given a folder, and sees what is placed in it",
		),
	]
}

function procsView(list: any[] | undefined) {
	const head = e(
		"h3",
		"",
		"processes",
		e("small", "", "hot ones pick up a new build; a pinned one keeps its run"),
	)
	const one = (p: any) => {
		const state = p.run
			? `run ${p.run} · ${p.chain.join(" · ")}`
			: p.waiting
			? `waiting for ${p.waiting.join(", ")}`
			: p.why
			? "no chain"
			: p.building
			? "building…"
			: "waiting"
		return h(
			"div",
			{ class: "proc", key: p.name },
			e("span", "tag", p.name),
			e(
				"div",
				"",
				e(
					"div",
					"head",
					e("span", "path mono", p.path),
					" ",
					h(
						"button",
						{
							class: "tag " + (p.pinned ? "on" : "run"),
							title: p.pinned
								? "keeps its run: click to pick up changes"
								: "picks up changes: click to pin",
							onClick: handler("/ctl/on/pin", [p.name]),
						},
						p.pinned ? "pinned" : "hot",
					),
					" ",
					e("span", "mono small", state),
				),
				p.out.length ? e("div", "out mono", "prints " + p.out.join(" ")) : null,
				p.shown ? e("pre", "out", Array.isArray(p.shown) ? p.shown.join("\n") : p.shown) : null,
				p.error ? e("div", "err", `✗ ${p.error}${p.missing ? "\n→ " + p.missing : ""}`) : null,
				!p.run && p.why ? e("div", "err", "✗ no chain: " + p.why) : null,
				p.failed && !p.stale.length ? e("div", "err", "✗ build: " + p.failed) : null,
				p.stale.length
					? e(
						"div",
						"stale",
						e(
							"div",
							"",
							e("b", "", "running code it wouldn't next time"),
							e("ul", "", p.stale.map((w: string) => e("li", "", w))),
						),
						// nothing new to pick up while the next build is out or fails
						p.failed || p.building ? "" : pressed("pick up", "", "/ctl/on/pickup", [p.name]),
					)
					: null,
				p.name === "escape" && p.error
					? pressed("start escape.c again, from /c/vault", "small", "/ctl/on/vault")
					: null,
				e(
					"div",
					"why",
					`box ${p.box} · keys ${p.granted.join(", ") || "none"}${
						p.uses.length ? " · uses " + p.uses.join(", ") : ""
					}${p.value ? " · value: " + p.value : ""}`,
				),
			),
			pressed("■", "stop", "/ctl/on/stop", [p.name]),
		)
	}
	return [head, (list ?? []).map(one)]
}

function buildView(log: any) {
	const t = log
	const said = (x: any) =>
		x.kind === "miss"
			? `${x.program}: ${short(x.from)} → ${short(x.to)}, compiled and kept`
			: x.kind === "hit"
			? `${x.program}: ${short(x.from)} was compiled before: read back`
			: x.kind === "cutoff"
			? `${x.program}: the same bytes as before: nothing after it runs again`
			: `${x.program}: ${String(x.error).split("\n")[0]}`
	return [
		e(
			"h3",
			"",
			"build",
			e(
				"small",
				"",
				`each compile cached by the hash of the compiler's identity and its input · ${t.misses} misses · ${t.hits} hits · ${t.cutoffs} cutoffs · ${t.failed} failed`,
			),
		),
		e(
			"div",
			"log mono",
			t.recent.length
				? t.recent.slice(0, 8).map((x: any) => [
					e("span", "time", x.time),
					e("span", "k " + x.kind, x.kind),
					e("span", "", x.step),
					e("span", "said", said(x)),
					e("span", "ms", x.ms !== undefined ? x.ms + "ms" : ""),
				])
				: e("span", "why", "nothing built yet"),
		),
	]
}

// the cache folder: one node per compile, named by its hash
const cacheView = (n: number | undefined) =>
	e(
		"div",
		"why",
		`/cache holds ${n ?? 0} ${n === 1 ? "entry" : "entries"}, each at its hash: a hash there ` +
			"is never compiled again",
	)

// the look: lemon page, black 1px lines, white cards with a soft pink glow, cherry, mint,
// f-blue, Jost, skewed lemon tags, 2px buttons that lift
const CSS = `
@import url("https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&display=swap");
body { background: #ffff88; margin: 6px; font: 13px Jost, system-ui, sans-serif; color: #000 }
.shell { display: flex; flex-direction: column; gap: 6px }
.card { background: #fff; border: 1px solid #000; border-radius: 0.5em; box-shadow: 0 0 10px 2px #66003322; padding: 5px 8px 7px; min-width: 0 }
.card h3 { margin: 0 0 4px; font-size: 12px; font-weight: 600; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap }
.card h3 small, .why { font-weight: 400; color: #555; font-size: 11px }
.two { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 6px }
@media (max-width: 600px) { .two { grid-template-columns: minmax(0, 1fr) } }
.bar { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 5px 8px }
.pick { display: inline-flex; gap: 2px; align-items: center }
.dot { color: #40dcba; font-size: 10px; padding: 0 4px }
.tag { display: inline-block; transform: skewX(-10deg); background: #ffff88; border: 1px solid #000; border-radius: 0; padding: 0 6px; font-size: 11px; line-height: 16px; white-space: nowrap; box-shadow: none }
button.tag:hover { transform: skewX(-10deg) translateY(-1px); box-shadow: 1px 1px 0 #000 }
.tag.on { background: #ff2284; color: #fff }
.tag.run { background: #40dcba }
button { font: inherit; font-size: 12px; padding: 0 8px; border-radius: 2px }
button.play, button.stop { padding: 0 5px; font-size: 10px; line-height: 15px }
button.small { font-size: 11px; margin-top: 3px }
.mono, pre, textarea, code { font-family: Monaco, ui-monospace, Menlo, monospace; font-size: 11px }
.small { font-size: 10px }
.path { color: #2269ff }
.level { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 4px; padding: 3px 0; border-top: 1px dashed #000 }
.level:first-of-type { border-top: 0 }
.offers { display: flex; flex-wrap: wrap; gap: 3px }
.chip { display: inline-block; border: 1px solid #000; border-radius: 2px; padding: 0 5px; font-size: 11px; line-height: 17px; background: #fff; white-space: nowrap }
.chip.handed { background: #40dcba }
.chip.used { background: #ff2284; color: #fff }
.chip.near { border: 1px dashed #ff2284; color: #ff2284 }
.chip .whynot { color: #555 }
.chip b { font-weight: 600 }
.n { display: inline-grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; background: #fff; color: #ff2284; border: 1px solid #ff2284; font-size: 9px; font-weight: 600; margin-right: 4px }
.n.big { background: #ff2284; color: #fff; border-color: #000 }
.steps { margin: 2px 0 4px; padding: 0; list-style: none }
.steps li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 4px; align-items: center; min-height: 18px }
.down { text-align: center; color: #ff2284 }
.given { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; font-size: 11px }
.bad { color: #ff2284 }
.err { background: #000; color: #fff; padding: 3px 6px; border-radius: 2px; white-space: pre-wrap; margin: 3px 0 0; font-family: Monaco, ui-monospace, Menlo, monospace; font-size: 11px }
.stale { background: #ffd9ea; border: 1px solid #ff2284; border-radius: 2px; padding: 3px 6px; margin-top: 3px; display: flex; gap: 8px; align-items: start; justify-content: space-between }
.stale ul { margin: 2px 0 0; padding-left: 16px; font-size: 11px }
.proc { display: grid; grid-template-columns: 82px minmax(0, 1fr) auto; gap: 2px 6px; padding: 4px 0; border-top: 1px solid #000; align-items: start }
.proc:first-of-type { border-top: 0 }
.proc > .tag { justify-self: start }
.head { display: flex; flex-wrap: wrap; gap: 4px; align-items: center }
.out { margin: 3px 0 0; padding: 2px 6px; background: #ffffc2; border-left: 2px solid #40dcba; white-space: pre; overflow-x: auto; font-family: Monaco, ui-monospace, Menlo, monospace; font-size: 11px }
textarea { width: 100%; box-sizing: border-box; border: 1px solid #000; border-radius: 2px; padding: 4px 6px; resize: vertical; background: #ffffc2; tab-size: 4; display: block }
.log { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr) auto; gap: 1px 8px; align-items: center }
.log .said { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.k { transform: skewX(-10deg); border: 1px solid #000; padding: 0 5px; line-height: 15px; text-align: center }
.k.hit { background: #40dcba } .k.miss { background: #ff2284; color: #fff } .k.failed { background: #000; color: #fff } .k.cutoff { background: #d4e4ff }
.time, .ms { color: #555 }
`
