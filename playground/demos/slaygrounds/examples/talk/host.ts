// talk's host: the world (@ermine/slaygrounds/world), twelve processes from one module (each runs
// the export of its own name, saving what it keeps in /state/<name>), the page those processes' cards
// sit in. who is calling: the world's who.
// the worker is no process of the module's: boss starts it. so the host writes its program node
// (/code/worker, the world's code) as reload does for the others
import { createWorld } from "@ermine/slaygrounds/world"
import { render as h } from "ermine-h"

export type { Tools, Who } from "@ermine/slaygrounds/world"

// section 0..4: the five ways to talk, and which process sits in which
const SECTIONS: [number, ...string[]][] = [
	[0, "scribe", "reader"],
	[1, "post", "ann", "bo"],
	[2, "asker", "clerk"],
	[3, "station", "fan1", "fan2", "fan3"],
	[4, "boss"],
]
const section = new Map<string, number>()
for (const [i, ...names] of SECTIONS) for (const n of names) section.set(n, i)
section.set("crew", 4) // boss's workers run at /crew/<name>

// a card per pattern, the program's words on it; the processes' boxes go inside
const secs: HTMLElement[] = []
function page(sections: { title: string; blurb: string }[]) {
	sections.forEach((x, i) => {
		if (!secs[i]) {
			secs[i] = document.body.appendChild(document.createElement("section"))
			secs[i].innerHTML = "<header><b></b><p></p></header><div class=actors></div>"
		}
		secs[i].querySelector("b")!.textContent = x.title
		secs[i].querySelector("p")!.textContent = x.blurb
	})
}
document.head.append(Object.assign(document.createElement("style"), {
	textContent: `
body { background: #fffbd0; max-width: 980px; margin: 0 auto; padding: 14px }
[data-ermine-box] { display: contents }
section { background: #fff; border: 1px solid #000; border-radius: 2px; box-shadow: 0 4px 24px #ff228433; margin: 0 0 16px; padding: 12px 14px }
section header b { display: inline-block; background: #fff7a8; border: 1px solid #000; padding: 0 10px; transform: skew(-8deg); font-size: 15px }
section header p { margin: 8px 0 10px; font-size: 13px; color: #333; max-width: 70ch }
.actors { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start }
.actor { border: 1px solid #000; border-radius: 2px; padding: 8px 10px; min-width: 190px; background: #fff; animation: pop 300ms }
.actor .tag { display: inline-block; background: #fff7a8; border: 1px solid #000; padding: 0 8px; transform: skew(-8deg); font-weight: 600; margin-right: 6px }
.actor .role { font-size: 12px; color: #555 }
.actor p { margin: 6px 0; font-size: 13px }
.actor p.say { background: #f4fffc; border: 1px solid #40dcba; border-radius: 10px; padding: 2px 8px; min-height: 1.3em }
.actor p.get { background: #f2f6ff; border: 1px solid #2269ff; border-radius: 10px; padding: 2px 8px; min-height: 1.3em }
.actor p.hot { background: #fff0f7; border: 1px solid #ff2284; border-radius: 10px; padding: 2px 8px }
.actor button { margin: 2px 4px 2px 0; font-size: 13px }
.actor.kid { border-style: dashed }
@keyframes pop { from { transform: translateY(6px); opacity: 0 } }
`,
}))

// a process's box goes into its pattern's card (a worker's name starts with crew)
const render = (into: Element, view: unknown, process: unknown) => {
	const at = (process as { name: string }).name.split("/")[0]
	const actors = secs[section.get(at) ?? -1]?.querySelector(".actors")
	if (actors && into.parentElement !== actors) actors.append(into)
	return h(into, view as never, process as never)
}

const world = createWorld({
	render,
	processes: SECTIONS.flatMap(([, ...names]) => names).map((name) => ({
		name,
		export: name,
		folder: ["state", name],
		args: [name],
	})),
})

export function reload(mod: Record<string, any>) {
	page(mod.sections)
	world.code("worker", mod.worker)
	world.reload(mod)
}
