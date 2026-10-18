// lens' host: the world (@ermine/slaygrounds/world) and one process, lens, running program.ts. extend
// hands over the outside, bundled apart by vite (the frame's import map only has @ermine/*): a
// CodeMirror, and automerge (patchwork's docs). the File System Access API the program reaches for
// itself: it is the page's
import { createWorld } from "@ermine/slaygrounds/world"
import { render } from "ermine-h"

const cm = await import(
	new URL("examples/piece-lens/cm.js", parent.__base ?? parent.location.origin + "/").href
)

const world = createWorld({
	render,
	processes: [{ name: "lens" }],
	extend: () => ({
		// a CodeMirror; its changes and the ones it is given are in UTF-16 units
		editor: () => cm.createTextEditor(),
		// automerge, once: open(url) and create(name) give a doc; online, onstatus
		automerge: () => cm.automerge(),
	}),
})

export const reload = world.reload
