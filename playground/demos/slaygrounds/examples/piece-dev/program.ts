/** @jsxImportSource ermine-h */
import type { API } from "@ermine/api"
import type { Process } from "@ermine/programs/start"
import { bind, handler } from "ermine-h"

// piece-dev: processes at paths. a process runs at a path (a row in the root's process trie, never
// saved), and the places ask the processes first, then the children: while it runs, a walk to its
// path finds it, and the saved thing there is shadowed ("the ephemeral wins"). stop it, and the
// saved one is back. each little process is a program: a node in /code (typed javascript) started
// at a path with start, its value what it returns, a timer of its own writing it each second.
// two readers of /dev/clock count their runs: one walks plain (entries), one asks the host's path
// cache (cache.get), which reruns its reader only when the answer changed

type Row = { name: string; id: string; from: string; value: unknown; under: Shadow[] }
type Shadow = { id: string; from: string; value: unknown }
type Folder = { path: string; rows: Row[] }
type Count = { runs: number; id: string | undefined }
type Said = { n: number; what: string; plain: number; cached: number; refused?: string }
// what the host's extend adds (host.ts): its path cache, and a sync landing
type Host = {
	cached: (path: string[]) => string | undefined
	kept: () => unknown
	sync: () => void
}

const JS = "com.netscape.javascript-source"

// what each little process does each second: its value, from its value before
const programs: Record<string, (before: unknown) => unknown> = {
	clock: () => new Date().toLocaleTimeString("en-GB"),
	dice: () => `🎲 ${1 + Math.floor(Math.random() * 6)}`,
	timer: (before) => `${(typeof before === "string" ? parseInt(before) : -1) + 1}s`,
}

const short = (id: unknown) => {
	const s = String(id)
	return s.startsWith("proc:") ? s : s.slice(0, 6)
}

export default function program(
	{ open, read, edit, info, entries, list, memo, method, start, stop, pulse, teardown, ...host }:
		& API
		& Host,
) {
	// ---- the programs: a node each in /code, typed javascript; its setup gives the first value, a
	// timer (stopped with the process) writes the next to the process's own node ([]) ----
	for (const [name, tick] of Object.entries(programs)) {
		const code = open(`/code/${name}`, undefined)
		const run = ({ edit, teardown }: API) => {
			const timer = setInterval(() => edit([], (before: unknown) => tick(before)), 1000)
			teardown(() => clearInterval(timer))
			return tick(undefined)
		}
		if (read(code) === undefined) open(`/code/${name}`, run)
		else edit(code, [{ path: [], value: run }])
		edit(info(code), [{ path: [], value: { "ermine.type": JS } }])
	}

	// ---- the readers: a run count each, and the id they read ----
	let plainRuns = 0, cachedRuns = 0
	memo("plain", (): Count => {
		plainRuns++
		return { runs: plainRuns, id: entries("/dev/clock")[0]?.id as string | undefined }
	})
	memo("cached", (): Count => {
		cachedRuns++
		return { runs: cachedRuns, id: host.cached(["dev", "clock"]) }
	})

	// ---- the listing: every contributor's names, the one a walk takes, and what it shadows ----
	memo("listing", (): Folder[] =>
		["/dev", "/work"].map((path) => ({
			path,
			rows: list(path).flatMap((name) => {
				const [first, ...under] = entries(`${path}/${name}`)
				if (first === undefined || typeof first.id !== "string") return []
				return [{
					name,
					id: first.id,
					from: first.from,
					value: first.value,
					under: under.map((a) => ({ id: a.id as string, from: a.from, value: a.value })),
				}]
			}),
		})))

	// ---- the methods: each says what it did, and how many runs each reader made after it ----
	const n = open("n", 0)
	const kept = open("kept", null)
	const said = open("said", [] as Said[])
	// the processes started here, by path
	const running = new Map<string, Process>()
	const act = (what: string, f: () => string | void) => {
		const [p0, c0] = [plainRuns, cachedRuns]
		const refused = f() || undefined
		pulse() // the readers run now, so the counts are after this
		const [p1, c1] = [plainRuns, cachedRuns]
		edit(n, (k: number) => k + 1)
		edit(kept, () => host.kept())
		edit(said, (d: Said[]) => {
			d.unshift({ n: read(n) as number, what, plain: p1 - p0, cached: c1 - c0, refused })
			d.splice(5)
		})
	}
	method(
		"on/start",
		(path: string[], kind: string) =>
			act(`start ${kind} at /${path.join("/")}`, () => {
				const at = "/" + path.join("/")
				const p = start(`/code/${kind}`, at)
				if ("refused" in p) return p.refused
				running.set(at, p)
			}),
	)
	method("on/stop", (path: string[]) =>
		act(`stop /${path.join("/")}`, () => {
			const at = "/" + path.join("/")
			const p = running.get(at)
			if (p === undefined) return "nothing started here"
			running.delete(at)
			stop(p)
		}))
	method("on/sync", () => act("a sync puts / back as it was", () => host.sync()))

	const starter = (path: string[], kind: string, label: string, note: string) => (
		<div class="ctl">
			<button class="go" onClick={handler("on/start", [path, kind])}>▶ {label}</button>
			<button onClick={handler("on/stop", [path])} title="stop">■</button>
			<em>{note}</em>
		</div>
	)
	const reader = (target: string, title: string, call: string) => (
		<div class="reader">
			<b class="big">{bind(target, (c: Count) => c?.runs ?? 0)}</b>
			<div>
				<b>{title}</b>
				<code>{call}</code>
				<span>
					reads <code>{bind(target, (c: Count) => (c?.id ? short(c.id) : "nothing"))}</code>
				</span>
			</div>
		</div>
	)

	return (
		<div class="pd">
			<style>{css}</style>
			<h1>
				dev<span>processes at paths, the ephemeral wins</span>
			</h1>
			<p class="lede">
				a process runs at a path, as a row in the root's process trie, never saved. a walk asks
				the processes first, then the saved children: while one runs, it is what is there, and
				the saved one waits under it. stop it and the saved one is back.
			</p>
			<div class="cols">
				<section class="win finder">
					<header>
						<b class="close" />
						<span>members, every contributor's</span>
					</header>
					<div class="body">
						{bind("listing", (folders: Folder[]) =>
							(folders ?? []).map((f) => (
								<div class="folder" key={f.path}>
									<div class="fname">📁 {f.path}</div>
									<ul>
										{f.rows.map((r) => (
											<li key={r.name} class={r.from}>
												<div class="line">
													<b class="name">{r.name}</b>
													<span class={`from ${r.from}`}>
														{r.from === "process" ? "process" : "saved"}
													</span>
													<span class="val">{String(r.value)}</span>
													<code>{short(r.id)}</code>
												</div>
												{r.under.map((u) => (
													<div class="under" key={u.id}>
														<span class="from shadowed">
															{u.from === "children" ? "saved" : u.from}
														</span>
														<span class="val">{String(u.value)}</span>
														<code>{short(u.id)}</code>
														<em>shadowed</em>
													</div>
												))}
											</li>
										))}
									</ul>
								</div>
							)))}
					</div>
				</section>
				<div class="right">
					<section class="win">
						<header>
							<b class="close" />
							<span>start and stop</span>
						</header>
						<div class="body">
							{starter(
								["dev", "clock"],
								"clock",
								"clock at /dev/clock",
								"over the saved clock",
							)}
							{starter(["dev", "dice"], "dice", "dice at /dev/dice", "a new name")}
							{starter(["work", "timer"], "timer", "timer at /work/timer", "another folder")}
						</div>
					</section>
					<section class="win">
						<header>
							<b class="close" />
							<span>two readers of /dev/clock</span>
						</header>
						<div class="body">
							{reader("plain", "plain walk", "entries(path)[0].id")}
							{reader("cached", "path cache", "cache.get(path)")}
							<div class="ctl">
								<button class="cool" onClick={handler("on/sync")}>
									a sync puts / back as it was
								</button>
							</div>
							<p class="kept">
								runs: each reader's, so far. the cache keeps{" "}
								{bind("kept", (k: { entries: number; reads: number } | null) =>
									k
										? `${k.entries} entries, reading ${k.reads} keys`
										: "an entry for each path a run reads")}
							</p>
						</div>
					</section>
				</div>
			</div>
			<section class="said">
				<h2>
					what happened<em>reruns after each, plain · cached</em>
				</h2>
				<ol>
					{bind("said", (rows: Said[]) =>
						rows.length === 0
							? <li class="empty">start the clock, then let a sync land…</li>
							: rows.map((r) => (
								<li key={String(r.n)}>
									<b>#{r.n}</b>
									<span class="what">{r.what}</span>
									{r.refused
										? <span class="refused">refused: {r.refused}</span>
										: (
											<span class="deltas">
												<i class={r.plain ? "hit" : ""}>plain +{r.plain}</i>
												<i class={r.cached ? "hit" : ""}>cached +{r.cached}</i>
											</span>
										)}
								</li>
							)))}
				</ol>
			</section>
		</div>
	)
}

const css = `
.pd{font-family:Jost,system-ui,sans-serif;color:#000;background:#fffbd6;border:1px solid #000;margin:-6px;padding:12px 14px 16px;min-height:calc(100vh - 18px);box-sizing:border-box}
.pd *{box-sizing:border-box}
.pd h1{font-size:22px;margin:0 0 2px;font-weight:600}
.pd h1 span{display:inline-block;background:#ffff88;border:1px solid #000;padding:0 8px;transform:skewX(-10deg);font-size:13px;font-weight:500;vertical-align:3px;margin-left:8px}
.pd .lede{margin:0 0 12px;font-size:13.5px;line-height:1.35;max-width:640px}
.pd code{font-family:Monaco,ui-monospace,Menlo,monospace;font-size:11px}
.pd .cols{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
.pd .finder{flex:1 1 330px;min-width:300px}
.pd .right{flex:1 1 300px;min-width:280px;display:flex;flex-direction:column;gap:14px}
.pd .win{background:#fff;border:1px solid #000;box-shadow:2px 2px 0 #000}
.pd .win header{position:relative;height:20px;border-bottom:1px solid #000;display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(#fff 0 1px,#000 1px 2px) 0 4px/100% 12px no-repeat,#fff}
.pd .win header span{background:#fff;padding:0 8px;font-size:12px;font-weight:600}
.pd .win .close{position:absolute;left:8px;top:4px;width:11px;height:11px;border:1px solid #000;background:#fff}
.pd .body{padding:10px;display:flex;flex-direction:column;gap:8px;font-size:12.5px}
.pd .folder .fname{font-weight:600;margin-bottom:4px}
.pd ul{list-style:none;margin:0 0 4px;padding:0 0 0 14px;display:flex;flex-direction:column;gap:4px}
.pd li{margin:0}
.pd .line,.pd .under{display:flex;gap:8px;align-items:center;border:1px solid #000;padding:3px 7px;background:#fff}
.pd li.process .line{background:#e6fbf5;box-shadow:2px 2px 0 #40dcba}
.pd .line .name{min-width:44px}
.pd .val{flex:1;font-weight:500}
.pd li.process .val{color:#000;font-variant-numeric:tabular-nums}
.pd .from{font-size:11px;font-weight:600;border:1px solid #000;padding:0 6px;transform:skewX(-10deg);background:#ffff88}
.pd .from.process{background:#40dcba;animation:pdpulse 1s ease-in-out infinite alternate}
@keyframes pdpulse{to{background:#b9f5e6}}
.pd .under{margin:0 0 0 18px;border-style:dashed;border-top:none;opacity:.55}
.pd .under .val{text-decoration:line-through}
.pd .under em{font-style:normal;font-size:11px;color:#ff2284;font-weight:600;opacity:1}
.pd .from.shadowed{background:#fff}
.pd .ctl{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pd .ctl em{font-style:normal;font-size:11.5px;opacity:.6}
.pd button{font:inherit;font-size:12.5px;font-weight:500;background:#fff;color:#000;border:1px solid #000;border-radius:2px;padding:1px 10px;cursor:pointer;box-shadow:1px 1px 0 #000;transition:transform .08s,box-shadow .08s}
.pd button:hover{transform:translate(-1px,-1px);box-shadow:2px 2px 0 #000}
.pd button:active{transform:translate(1px,1px);box-shadow:none}
.pd button.go{background:#40dcba}
.pd button.cool{background:#2269ff;color:#fff}
.pd .reader{display:flex;gap:10px;align-items:center;border:1px solid #000;padding:6px 8px}
.pd .reader .big{font-size:30px;line-height:1;min-width:46px;text-align:center;color:#ff2284;font-variant-numeric:tabular-nums}
.pd .reader div{display:flex;flex-direction:column;gap:1px}
.pd .kept{margin:0;font-size:11.5px;opacity:.7}
.pd .said{margin-top:14px}
.pd .said h2{font-size:13px;font-weight:600;margin:0 0 6px;display:flex;gap:8px;align-items:center}
.pd .said h2 em{font-style:normal;font-weight:500;font-size:12px;background:#fff;border:1px solid #000;padding:0 6px}
.pd ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}
.pd ol li{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid #000;padding:4px 8px;font-size:12.5px;animation:pdin .35s ease-out}
.pd ol li.empty{opacity:.6;border-style:dashed;animation:none}
@keyframes pdin{from{transform:translateY(-6px);opacity:0}}
.pd ol .what{flex:1}
.pd .deltas{display:flex;gap:6px}
.pd .deltas i{font-style:normal;font-size:11.5px;border:1px solid #000;padding:0 6px;background:#fff}
.pd .deltas i.hit{background:#ff2284;color:#fff}
.pd .refused{font-size:11.5px;color:#ff2284;font-weight:600}
`
