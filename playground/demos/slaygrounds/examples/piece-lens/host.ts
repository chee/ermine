// lens' host: the world (@ermine/slaygrounds/world) and one process, lens, running program.ts. extend
// hands over the outside, bundled apart by vite (the frame's import map only has @ermine/*): a
// CodeMirror. what the person types is the host's to tell: an editor's listener has nothing open to
// write in, so the host runs the process's on/typed with each change (executeAction, as the host)
import { createWorld } from "@ermine/slaygrounds/world"
import { executeAction } from "@ermine/system"
import { render } from "ermine-h"

const cm = await import(
	new URL("examples/piece-lens/cm.js", parent.__base ?? parent.location.origin + "/").href
)

const world = createWorld({
	render,
	processes: [{ name: "lens" }],
	extend: ({ at }) => ({
		// a CodeMirror; its changes and the ones it is given are in UTF-16 units. its typing runs
		// the process's on/typed
		editor: () => {
			const editor = cm.createTextEditor()
			editor.onedit = (changes: unknown, before: string) => {
				try {
					world.ermine.within(() =>
						executeAction(`/${at.join("/")}/on/typed`, changes, before)
					)
				} catch { /* the process is not up (replaced): nothing to tell */ }
			}
			return editor
		},
	}),
})

export const reload = world.reload
