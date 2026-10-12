// Writes the files program scenarios to newcore/files/conformance/program/NN-short-name.json.
//   deno run --allow-all conformance/program/fixtures.ts
// A scenario: {title, steps} (run.ts has the shape, harness.ts the protocol). The steps are
// written here; every expected answer and snapshot is the reference's, recorded by running the
// scenario against harness.ts, and read over by hand against FILES.tex (The files program) when
// it was written. So the suite pins program.ts as it is: a C program that differs is wrong, or
// program.ts is. A scenario that expects what the paper says and program.ts does not is marked
// in its title with "(differs from the paper)" and written to the paper's words.
// Most start from the paper's example graph (example below): ids id1 apps, id2 clock, id3 and
// id4 the two docs, in the order the host made them.
import { run, type Scenario, type Step } from "./run.ts"

const out = new URL("../../files/conformance/program/", import.meta.url)
const here = new URL(".", import.meta.url).pathname
const reference = ["deno", "run", "--quiet", "--allow-all", `${here}harness.ts`]

const bytes = (...xs: number[]) => btoa(String.fromCharCode(...xs)).replace(/=+$/, "")
const PNG = { "/": { bytes: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) } }

// ---- steps

type Item = string | [string, number]
const ask = (request: Record<string, unknown> & { op: string }): Step => ({ request })
const open = (more: Record<string, unknown> = {}) => ask({ op: "open", ...more })
const place = (path: Item[], slot: string, value?: unknown, at?: number) =>
	ask({
		op: "place",
		path,
		slot,
		...(value !== undefined ? { value } : {}),
		...(at !== undefined ? { at } : {}),
	})
const mount = (path: Item[], slot: string, to: Item[]) => ask({ op: "mount", path, slot, to })
const write = (path: Item[], value: unknown, version?: number) =>
	ask({ op: "write", path, value, ...(version !== undefined ? { version } : {}) })
const side = (path: Item[], value: unknown) => ask({ op: "side", path, value })
const remove = (path: Item[]) => ask({ op: "remove", path })
const save = () => ask({ op: "save" })
const start = () => ask({ op: "start" })
const pass = (touched?: string[]) => ask(touched ? { op: "pass", touched } : { op: "pass" })
const graph = () => ask({ op: "graph" })
const observe = (): Step => ({ observe: {} })
const edit = (what: string, more: Record<string, unknown>): Step =>
	({ edit: what, ...more }) as Step
const put = (path: string, text: string) => edit("write", { path, text })
const rm = (path: string) => edit("remove", { path })
const mv = (from: string, to: string) => edit("rename", { from, to })
const dir = (path: string) => edit("mkdir", { path })
const link = (path: string, target: string) => edit("link", { path, target })
const copy = (from: string, to: string) => edit("copy", { from, to })
const ident = (path: string, of: string) => edit("id", { path, of })

/** The paper's example (FILES.tex, An example), saved, with the program running. */
const example = (): Step[] => [
	open(),
	place([], "apps", { theme: "dark" }),
	place(["apps"], "clock", "12:00"),
	place([], "docs", "hello"),
	place([], "docs", PNG),
	mount([], "pinned", ["docs"]),
	save(),
	start(),
]

/** A pass, then the graph, then the folder and what was listed. */
const finish = (touched?: string[]): Step[] => [pass(touched), graph(), observe()]

const all: { name: string; scenario: Scenario }[] = []
const add = (name: string, title: string, ...steps: (Step | Step[])[]) =>
	all.push({ name, scenario: { title, steps: steps.flat() } })

// ---- from edits to changes

add(
	"example-laid",
	"the example, saved, with the program running: a pass finds nothing, the store's own writes make no change",
	example(),
	finish(),
)

add(
	"write-one-splice",
	"a node's file holding another value is a write, made as the computer's user",
	example(),
	put("apps/clock.txt", "12:30"),
	finish(["apps"]),
)

add(
	"write-graph-has-it",
	"a file whose value the graph already has makes nothing",
	example(),
	write(["apps", "clock"], "13:00"),
	put("apps/clock.txt", "13:00"),
	finish(["apps"]),
)

add(
	"write-reformatted-text",
	"a .text file a person reformatted, still reading as the value, is equal: left as it is",
	example(),
	put("apps.text", '{"theme":   "dark"}'),
	finish([""]),
)

add(
	"write-not-utf8",
	"a text file that is no longer UTF-8 is a snapshot of its bytes",
	example(),
	edit("write", { path: "docs/1.txt", hex: "fffe" }),
	finish(["docs"]),
)

add(
	"write-bytes",
	"a bytes file edited is a write of the new bytes",
	example(),
	edit("write", { path: "docs/2.png", hex: "89504e470d0a1a0aff" }),
	finish(["docs"]),
)

add(
	"text-unreadable",
	"a .text file that does not read is listed, and taken in once it reads",
	example(),
	put("apps.text", '{ "theme": '),
	pass([""]),
	graph(),
	observe(),
	put("apps.text", '{ "theme": "light" } /* a comment */'),
	finish([""]),
)

add(
	"typed-array-length",
	"a typed array's file whose length is not a whole number of elements is listed, and taken in once it is",
	open(),
	place([], "v", { "/": { float32: [1, 2] } }),
	save(),
	start(),
	edit("write", { path: "v.float32", hex: "0000803f00" }),
	pass([""]),
	observe(),
	edit("write", { path: "v.float32", hex: "0000803f00000040000040" + "40" }),
	finish([""]),
)

add(
	"file-removed-unplaced",
	"a node's file removed, its folder not shown: an unplacement; the graph keeps the node's value",
	example(),
	rm("apps/clock.txt"),
	finish(["apps"]),
)

add(
	"file-removed-folder-shown",
	"a node's file removed with its folder shown: a snapshot of null, the node stays placed",
	example(),
	rm("apps.text"),
	finish([""]),
)

add(
	"folder-removed-slots",
	"a node's folder removed, its file there: an unplacement of each id in its slots",
	example(),
	rm("apps"),
	finish([""]),
)

add(
	"folder-and-file-removed",
	"a node's folder and file both removed: the node unplaced, its slots kept",
	example(),
	place(["apps"], "more", "x"),
	save(),
	rm("apps"),
	rm("apps.text"),
	finish([""]),
)

add(
	"union-folder-removed",
	"a union's folder removed: each of its ids unplaced; another slot holding one is laid again",
	example(),
	rm("docs"),
	finish([""]),
)

add(
	"new-files",
	"new files are new nodes: .text and typed array files read in that form, others are their text or bytes, a person's names are kept",
	example(),
	put("README.md", "# hi"),
	put("data.text", "[1, 2.5]"),
	edit("write", { path: "v.float32", hex: "0000803f00000040" }),
	edit("write", { path: "blob", hex: "ff00ff" }),
	finish([""]),
)

add(
	"new-folders",
	"a new folder is a node whose value is null, then its contents each likewise, all the way down",
	example(),
	dir("Projects/inner"),
	put("Projects/plan.txt", "plan"),
	put("Projects/inner/deep", "deep"),
	finish([""]),
)

add(
	"new-in-union",
	"a new file in a union's folder is placed at the position its number gives, or at the end",
	example(),
	put("docs/2 cat.txt", "meow"),
	put("docs/dog.txt", "woof"),
	finish(["docs"]),
)

add(
	"new-beside-folder",
	"a new file beside a node's folder with its stem is that node's file: a snapshot",
	example(),
	place([], "box", null),
	place(["box"], "in", "x"),
	save(),
	put("box.text", '{"a": 1}'),
	finish([""]),
)

add(
	"new-folder-beside-file",
	"a new folder beside a node's file with its stem is that node's folder: its contents are taken in",
	example(),
	dir("docs/1"),
	put("docs/1/note.txt", "n"),
	finish(["docs"]),
)

add(
	"half-back",
	"an entry carrying the id of a shown node, beside that node's other half: that half back, its value compared",
	example(),
	place([], "box", null),
	place(["box"], "in", "x"),
	save(),
	put("box.text", '"top"'),
	ident("box.text", "id5"),
	finish([""]),
)

add(
	"back-from-trash",
	"an entry sent to the Trash and put back carries its id: placed again where it was, at its old position",
	example(),
	dir("@Trash"),
	mv("docs/2.png", "@Trash/2.png"),
	pass(["docs"]),
	graph(),
	mv("@Trash/2.png", "docs.png"),
	finish([""]),
)

add(
	"back-from-trash-edited",
	"a node back from the Trash comes back as the graph kept it, its value then compared with the file",
	example(),
	dir("@Trash"),
	mv("apps/clock.txt", "@Trash/clock.txt"),
	pass(["apps"]),
	edit("write", { path: "@Trash/clock.txt", text: "12:45", keep: true }),
	mv("@Trash/clock.txt", "apps/clock.txt"),
	finish(["apps"]),
)

add(
	"copy-is-new-nodes",
	"a file carrying the id of a node still at its home, not beside it, is a copy: a new node with an id of its own",
	example(),
	copy("apps/clock.txt", "apps/clock copy.txt"),
	finish(["apps"]),
)

add(
	"copy-folder",
	"a copied folder, still carrying its node's id, is a new node, its contents new nodes as well",
	example(),
	copy("apps", "apps copy"),
	finish([""]),
)

add(
	"moved-in-from-outside",
	"an entry moved in from outside the store is new nodes, unless its id makes it a node coming back",
	example(),
	dir("@Outside"),
	put("@Outside/in.txt", "from outside"),
	mv("@Outside/in.txt", "moved.txt"),
	finish([""]),
)

// ---- links

add(
	"link-made-to-file",
	"a link made to a node's file or folder in the store is a mount of its id",
	example(),
	link("fav.txt", "apps/clock.txt"),
	link("fav-folder", "apps"),
	finish([""]),
)

add(
	"link-pending",
	"a link to .ermine/id/ and an id nothing here holds is a mount of that id, pending",
	example(),
	link("Later", ".ermine/id/y7"),
	finish([""]),
)

add(
	"link-nowhere",
	"a link that leads nowhere in the store is listed, and nothing else",
	example(),
	link("lost", "/nowhere/at/all"),
	finish([""]),
)

add(
	"link-removed",
	"a link removed is an unplacement of its id from its slot; the node's file stays",
	example(),
	rm("pinned.txt"),
	finish([""]),
)

add(
	"link-either-removed",
	"either of a node's two links removed is an unplacement of its id from the link's slot; the store removes the other",
	example(),
	link("fav", "apps"),
	pass([""]),
	rm("fav.text"),
	finish([""]),
)

add(
	"link-elsewhere",
	"a link pointed somewhere else in the store: the id it led to unplaced, the one it leads to mounted",
	example(),
	rm("pinned.txt"),
	link("pinned.txt", "docs/2.png"),
	finish([""]),
)

add(
	"link-saved-through",
	"a link replaced by a file, as an editor that saves by renaming does: a write to the link's node, the link made again",
	example(),
	rm("pinned.txt"),
	put("pinned.txt", "hello, world"),
	finish([""]),
)

add(
	"link-saved-through-meets",
	"a file saved through a link that meets a newer change is a second node after the node it met, the link made again",
	example(),
	write([["docs", 0]], "hello again"),
	rm("pinned.txt"),
	put("pinned.txt", "hello, world"),
	finish([""]),
)

add(
	"link-renamed",
	"a link renamed moves its id: the slot its new name gives",
	example(),
	mv("pinned.txt", "starred.txt"),
	finish([""]),
)

add(
	"alias",
	"a Finder alias, by the host's seam, is a link to where it leads; the store replaces it with a link",
	example().map((s) =>
		s.request?.op === "open" ? open({ aliases: { "clock alias": "apps/clock.txt" } }) : s
	),
	put("clock alias", "an alias's bookmark data"),
	finish([""]),
)

// ---- meeting

add(
	"meet-paper-example",
	"the paper's example: apps/clock.txt edited to 12:30 while the graph writes 13:00 is a second node: clock/1.txt and clock/2.txt",
	example(),
	put("apps/clock.txt", "12:30"),
	write(["apps", "clock"], "13:00"),
	finish(["apps"]),
)

add(
	"meet-then-remove-one",
	"after a meeting, a person removes one member: the slot holds one id again, its file back at clock.txt",
	example(),
	put("apps/clock.txt", "12:30"),
	write(["apps", "clock"], "13:00"),
	pass(["apps"]),
	rm("apps/clock/2.txt"),
	finish(["apps/clock"]),
)

add(
	"meet-batch-laid-first",
	"the batch laid before the pass: the edit is kept on disk until the pass, then met",
	example(),
	put("apps/clock.txt", "12:30"),
	write(["apps", "clock"], "13:00"),
	save(),
	observe(),
	finish(["apps"]),
)

add(
	"meet-same-value",
	"a change that leaves the value as the file has it makes nothing: no second node",
	example(),
	put("apps/clock.txt", "13:00"),
	write(["apps", "clock"], "13:00"),
	finish(["apps"]),
)

add(
	"meet-removal-made",
	"a removal is made even if the value changed since the store last laid it: the graph keeps the node, newer value and all",
	example(),
	write(["apps", "clock"], "13:00"),
	rm("apps/clock.txt"),
	finish(["apps"]),
)

add(
	"meet-rename-made",
	"a rename is made even if the value changed since the store last laid it",
	example(),
	write(["apps", "clock"], "13:00"),
	mv("apps/clock.txt", "apps/time.txt"),
	finish(["apps"]),
)

// ---- renames

add(
	"rename-file",
	"a node's file renamed is a move: the slot its new name gives, without the extension the store added; its folder follows",
	example(),
	mv("apps.text", "tools.text"),
	finish([""]),
)

add(
	"rename-folder",
	"a node's folder renamed is a move: the slot its new name gives, and the extension its slot's name had; its file follows",
	example(),
	mv("apps", "kit"),
	finish([""]),
)

add(
	"rename-folder-extension",
	"a folder renamed keeps the extension its slot's name had after its stem: README/ to DOCS/ is the slot DOCS.md",
	open(),
	place([], "README.md", "# hello"),
	place(["README.md"], "more", "x"),
	save(),
	start(),
	mv("README", "DOCS"),
	finish([""]),
)

add(
	"rename-form-kept",
	"a rename never changes how a file reads: clock.txt to clock.text is the slot clock.text, laid as clock.text.txt",
	example(),
	mv("apps/clock.txt", "apps/clock.text"),
	finish(["apps"]),
)

add(
	"rename-across-folders",
	"a node's file moved to another folder: the move is made, the node's own folder comes beside it",
	example(),
	mv("apps/clock.txt", "clock.txt"),
	finish(["", "apps"]),
)

add(
	"rename-file-and-folder-apart",
	"a node's file and folder moved to different folders: the file decides, the store puts the folder beside it",
	example(),
	place([], "one", null),
	place(["one"], "x", "1"),
	place([], "two", null),
	place(["two"], "x", "2"),
	save(),
	mv("apps.text", "one/apps.text"),
	mv("apps", "two/apps"),
	finish(["", "one", "two"]),
)

add(
	"rename-union-folder",
	"a union's folder renamed: each of its ids moved, in order; the link to a member follows",
	example(),
	mv("docs", "papers"),
	finish([""]),
)

add(
	"rename-into-union",
	"a node with a folder moved into a union's folder: placed at the number its name gives, its folder comes too, the members numbered again",
	example(),
	mv("docs", "papers"),
	pass([""]),
	mv("apps.text", "papers/0 apps.text"),
	finish(["", "papers"]),
)

add(
	"rename-union-members",
	"a union's members renamed are placed by their numbers, then names; the store numbers them again, keeping a person's words",
	example(),
	mv("docs/2.png", "docs/0 first.png"),
	finish(["docs"]),
)

add(
	"rename-moved-out",
	"an entry moved out of the store, to the Trash included, is as if it were removed",
	example(),
	dir("@Outside"),
	mv("apps/clock.txt", "@Outside/clock.txt"),
	finish(["apps"]),
)

// ---- sides

add(
	"side-edit-writes",
	"a side's file edited writes that version of the node, not the first",
	example(),
	side(["apps", "clock"], "12:05"),
	save(),
	put("apps/clock.FINAL.txt", "12:06"),
	finish(["apps"]),
)

add(
	"side-removed",
	"a side's file removed is laid again, and listed",
	example(),
	side(["apps", "clock"], "12:05"),
	save(),
	rm("apps/clock.FINAL.txt"),
	finish(["apps"]),
)

add(
	"side-changed-since",
	"an edit to a side whose version changed since it was laid goes to the Trash, listed, the side laid again",
	example(),
	side(["apps", "clock"], "12:05"),
	save(),
	put("apps/clock.FINAL.txt", "mine"),
	write(["apps", "clock"], "theirs", 1),
	finish(["apps"]),
)

add(
	"side-renamed",
	"a side's file renamed: the store lays it again, and the renamed one goes to the Trash",
	example(),
	side(["apps", "clock"], "12:05"),
	save(),
	mv("apps/clock.FINAL.txt", "apps/other.txt"),
	finish(["apps"]),
)

add(
	"side-copied",
	"a copy of a side's file, still carrying its attributes, is a new file, and loses the side attribute",
	example(),
	side(["apps", "clock"], "12:05"),
	save(),
	copy("apps/clock.FINAL.txt", "apps/spare.txt"),
	finish(["apps"]),
)

// ---- the root's file and .ermine

add(
	"root-file-edit",
	"the root's file, .ermine/root.txt, edited is a write to the root",
	example(),
	write([], "top"),
	save(),
	put(".ermine/root.txt", "top!"),
	finish([]),
)

add(
	"root-file-meets",
	"an edit to the root's file that meets a change goes to the Trash, and is listed",
	example(),
	write([], "top"),
	save(),
	put(".ermine/root.txt", "mine"),
	write([], "theirs"),
	finish([]),
)

add(
	"root-file-removed",
	"the root's file removed is a snapshot of null",
	example(),
	write([], "top"),
	save(),
	rm(".ermine/root.txt"),
	finish([]),
)

add(
	"root-file-made",
	"a root file made where there was none is a write to the root",
	example(),
	put(".ermine/root.txt", "top"),
	finish([]),
)

add(
	"ermine-ignored",
	"anything else in .ermine is never read as an edit",
	example(),
	put(".ermine/junk.txt", "junk"),
	dir(".ermine/stuff"),
	finish([""]),
)

add(
	"names-passed-over",
	"names a host passes over are not edits: .DS_Store, names ending in ~ or .swp, names starting and ending in #",
	example(),
	put(".DS_Store", "finder"),
	put("notes.txt~", "backup"),
	put("notes.txt.swp", "swap"),
	put("#notes#", "lock"),
	finish([""]),
)

// ---- passes

add(
	"pass-touched-only",
	"a pass compares the folders touched only; the first pass with none given compares every folder",
	example(),
	put("apps/clock.txt", "12:30"),
	put("note.txt", "a note"),
	pass(["apps"]),
	graph(),
	observe(),
	finish(),
)

add(
	"pass-nothing",
	"a pass that finds no differences does not call edit",
	example(),
	pass(),
	pass(["docs"]),
)

add(
	"several-edits-one-pass",
	"each difference of a pass is on its own: one refused does not stop the others",
	open({ refuse: ["secret.txt"] }),
	place([], "apps", "a"),
	save(),
	start(),
	put("secret.txt", "s"),
	put("open.txt", "o"),
	put("apps.txt", "a!"),
	finish([""]),
)

add(
	"refused-edit",
	"an edit protect refuses is listed with its error, its entry goes to the Trash, and the store lays out the graph as it is",
	example().map((s) => s.request?.op === "open" ? open({ refuse: ["secret.txt"] }) : s),
	put("secret.txt", "s"),
	put("open.txt", "o"),
	finish([""]),
)

// ---- while nothing ran

add(
	"first-pass",
	"edits made while nothing ran: loading keeps them, the program's first pass takes them in",
	example(),
	save(),
	put("apps/clock.txt", "09:00"),
	put("new.txt", "new"),
	rm("docs/2.png"),
	open(),
	start(),
	finish(),
)

add(
	"first-pass-meets",
	"a change that reaches a file before the first pass meets the edit, so none is written over",
	example(),
	save(),
	put("apps/clock.txt", "09:00"),
	open(),
	write(["apps", "clock"], "10:00"),
	start(),
	finish(),
)

// ---- found by the suite, written to the paper's words

add(
	"meet-in-union",
	"an edit to a union's member that meets a newer change is a second node right after it: the edited file moves to the new node's place with its id, the met node's file is laid with the graph's value",
	example(),
	put("docs/1.txt", "hello, mine"),
	write([["docs", 0]], "hello again"),
	finish(["docs"]),
)

add(
	"back-from-trash-both-halves",
	"a node's file and folder put back from the Trash in one pass are the one node, back where it was",
	example(),
	dir("@Trash"),
	mv("apps.text", "@Trash/apps.text"),
	mv("apps", "@Trash/apps"),
	pass([""]),
	graph(),
	mv("@Trash/apps", "apps"),
	mv("@Trash/apps.text", "apps.text"),
	finish([""]),
)

add(
	"move-into-new-folder",
	"a node's file moved into a folder made in the same pass is a move into the new folder's node",
	example(),
	dir("box"),
	mv("apps/clock.txt", "box/clock.txt"),
	finish(["", "apps", "box"]),
)

add(
	"link-to-moved-file",
	"a link made in the same pass to a file that moved there is a mount of the moved node",
	example(),
	mv("apps/clock.txt", "clock.txt"),
	link("fav.txt", "clock.txt"),
	finish(["", "apps"]),
)

add(
	"copy-file-and-folder",
	"a node's file and folder copied together, as Duplicate of both makes, are one new node with that file and folder",
	example(),
	copy("apps", "apps copy"),
	copy("apps.text", "apps copy.text"),
	finish([""]),
)

add(
	"renamed-link-removed",
	"a node renamed: the store makes its links again, and removes its own old ones, never sending them to the Trash",
	example(),
	mount([], "zfav", ["apps"]),
	save(),
	mv("apps.text", "tools.text"),
	finish([""]),
)

add(
	"rename-keeps-home",
	"a node's file renamed in place, the node also mounted in a slot that sorts first: its home is the slot it moved to, the mount stays a link",
	example(),
	mount([], "fav", ["apps"]),
	save(),
	mv("apps.text", "tools.text"),
	finish([""]),
)

// ---- written

await Deno.mkdir(out, { recursive: true })
for await (const f of Deno.readDir(out)) {
	if (f.name.endsWith(".json")) await Deno.remove(new URL(f.name, out))
}
const pretty = (x: unknown) => JSON.stringify(x, null, "\t")
for (const [i, { name, scenario: s }] of all.entries()) {
	const got = await run(s, reference)
	const steps = s.steps.map((step, j) => ("edit" in step ? step : { ...step, expect: got[j] }))
	const file = `${String(i + 1).padStart(2, "0")}-${name}.json`
	await Deno.writeTextFile(new URL(file, out), pretty({ title: s.title, steps }) + "\n")
}
console.log(`${all.length} scenarios written`)
