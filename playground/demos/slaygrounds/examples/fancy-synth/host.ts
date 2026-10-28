// synth's host: the world, and twelve processes: eleven modules of a little rack and the patch bay.
// each module is a process at /<name>, running its program with its name and first values as args
// (osc1 and osc2 are one program placed twice: osc2 gets "tune=220" "fine=7" "wave=square"). what a
// module keeps is saved at /rack/<name>; the cables are nodes at /patch
//
// the page: a rack case with two rows; each module's view goes in its row, in the order started.
// the patch bay's view goes under the case, its canvas over the whole world (the cables)
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "@ermine/render/dom"

const rack1 = ["clock", "steps", "osc1", "osc2", "lfo", "mixer"]
const rack2 = ["filter", "env", "delay", "scope", "out"]
// which program each module runs, and with what
const programs: Record<string, [string, ...string[]]> = {
	clock: ["clock"],
	steps: ["steps"],
	osc1: ["osc", "tune=110", "wave=sawtooth"],
	osc2: ["osc", "tune=220", "fine=7", "wave=square"],
	lfo: ["lfo"],
	mixer: ["mixer"],
	filter: ["filter"],
	env: ["env"],
	delay: ["delay"],
	scope: ["scope"],
	out: ["out"],
}

const world = createWorld({
	render,
	processes: [
		...[...rack1, ...rack2].map((name) => {
			const [program, ...args] = programs[name]
			return { name, export: program, args: [name, ...args] }
		}),
		{ name: "patchbay", export: "patchbay" },
	],
})

// the world gives each process a box in the page; this puts the modules' boxes in the rack
const div = (cls: string) => Object.assign(document.createElement("div"), { className: cls })
function arrange() {
	const page = document.querySelector(".world") ?? document.body.appendChild(div("world"))
	const rack = page.querySelector(".case") ?? page.appendChild(div("case"))
	const rows = [rack1, rack2].map((names, i) => {
		const row = rack.children[i] ?? rack.appendChild(div("row"))
		for (const name of names) {
			const box = document.querySelector(`[data-ermine-box="${name}"]`)
			if (box) row.appendChild(box)
		}
		return row
	})
	const bay = document.querySelector(`[data-ermine-box="patchbay"]`)
	if (bay && bay.parentElement !== page) page.appendChild(bay)
	return rows
}

export const reload = (mod: Record<string, unknown>) => {
	world.reload(mod)
	arrange()
}
