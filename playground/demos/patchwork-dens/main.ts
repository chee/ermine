/// <reference lib="dom" />
// patchwork on dens (playground/patchwork-dens): the page den, the example tools installed, a
// folder of a counter, a note and a second counter in the stack tool at /apps/patchwork/frame, and
// the selected doc (./selected) in its own view at /apps/patchwork/main, on the den's second surface,
// started again at each selection. beside them, the den's processes, as they run
import { createBox } from "@ermine/boxes"
import type { Id } from "@ermine/places"
import { KIND } from "@ermine/dens"
import { definePatchworkView, type Element, startView } from "@ermine/patchwork-dens"
import { createHost, createPageDen } from "@ermine/patchwork-dens/boot"
import { createDoc, installTools, providers, writer } from "@ermine/patchwork-dens/examples"
import { idOf, urlOf } from "@ermine/patchwork-dens/handle"

definePatchworkView()
const h = createHost()
const { scheduler: s, table, places, hosted } = h
const el = (sel: string) => document.querySelector(sel) as unknown as Element
const page = hosted(() => createPageDen({ ...h, id: "tab", root: el("#root") }))
const side = hosted(() => page.den.offer("surfaces", "main", { [KIND]: "dom" }, el("#main")))
if ("refused" in side) throw new Error(side.refused)
const write = writer(h)
const top = hosted(() => createBox({ places, table, scheduler: s }, []))
const { code, modules } = await installTools(write, top)
const { selected, storage } = providers(write)
const docs = (name: string, id: Id) => (write.place(top, ["docs", name], id), id)
const one = docs("one", await createDoc(write, code["counter.js"], "counter"))
const two = docs("two", await createDoc(write, code["counter.js"], "counter"))
const note = docs(
	"note",
	write.node({ title: "a note", text: "hello" }, { "ermine.type": "public.json" }),
)
const folder = docs(
	"folder",
	write.node({
		title: "docs",
		docs: [
			{ name: "a counter", url: urlOf(one) },
			{ name: "a note", url: urlOf(note) },
			{ name: "another counter", url: urlOf(two) },
		],
	}, { "ermine.type": "patchwork.folder" }),
)
const host = { places, table, scheduler: s }
const provide = { modules, selected, storage }
hosted(() =>
	startView(page.den, {
		host,
		folder: "/apps/patchwork/frame",
		doc: folder,
		surface: page.surface!.id,
		provide,
	})
)

// the main view: the selected doc's, made again as ./selected changes
let main: ReturnType<typeof startView> | undefined
hosted(() =>
	s.createEffect(() => places.readValue("value", selected), (urls) => {
		if (main && !("refused" in main)) page.den.stop(main.process)
		const doc = idOf(Array.isArray(urls) ? urls[0] : undefined)
		if (doc === undefined) return
		main = startView(page.den, {
			host,
			folder: "/apps/patchwork/main",
			doc,
			surface: side.id,
			provide,
		})
	})
)
s.pulse()

// the processes, as the den has them
const tree = document.querySelector("#tree")!
setInterval(() => {
	tree.textContent = page.den.processes().map((p) => {
		const a = table.get("attributes", p.id)?.value as Record<string, unknown> | undefined
		const program = (a?.["ermine.process.program"] as { at?: string[] } | undefined)?.at?.join("/")
		return `${String(p.id).slice(0, 13)}  /${p.at.join("/")}  ${program}  ${
			JSON.stringify(a?.["ermine.process.args"])
		}`
	}).join("\n")
}, 250)
