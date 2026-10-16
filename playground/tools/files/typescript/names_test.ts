import { assert, assertEquals, assertNotEquals } from "@std/assert"
import * as names from "./names.ts"
import { PASS } from "./names.ts"
import type { Form } from "./types.ts"

const bytes = (...b: number[]) => new Uint8Array(b)
const ascii = (s: string) => new TextEncoder().encode(s)
const utf8 = (s: string) => new TextEncoder().encode(s).length

/** The file a slot's name gives a value of the form, as the layout makes it. */
function file(name: string, form: Form, head?: Uint8Array): [file: string, stem: string] {
	const { stem, ext } = names.split(name, form, head, PASS)
	const written = names.write(stem, PASS)
	return [written + "." + ext, written]
}

Deno.test("a name has an extension: a dot not first, then 1 to 8 ASCII letters and digits", () => {
	assertEquals(names.extension("clock"), undefined)
	assertEquals(names.extension("README.md"), "md")
	assertEquals(names.extension("data.raw.float32"), "float32")
	assertEquals(names.extension(".bashrc"), undefined)
	assertEquals(names.extension("a."), undefined)
	assertEquals(names.extension("x.12345678"), "12345678")
	assertEquals(names.extension("x.123456789"), undefined)
	assertEquals(names.extension("x.tar-gz"), undefined)
	assertEquals(names.extension("x.é"), undefined)
	assertEquals(names.extension("café.txt"), "txt")
	assertEquals(names.extension("a.b/c"), undefined)
})

Deno.test(".text is only cbor's and .k only kind k's; a string or bytes may have any other", () => {
	assert(names.fits("text", "cbor"))
	assert(!names.fits("json", "cbor"))
	assert(!names.fits("txt", "cbor"))
	assert(names.fits("float32", "float32"))
	assert(!names.fits("float64", "float32"))
	assert(!names.fits("raw", "float32"))
	for (const form of ["txt", "bin"] as const) {
		assert(names.fits("md", form))
		assert(names.fits("txt", form))
		assert(names.fits("bin", form))
		assert(!names.fits("text", form))
		assert(!names.fits("float32", form))
		assert(!names.fits("int8", form))
		// no uint8 kind: an extension like any other
		assert(names.fits("uint8", form))
		// not a kind, though every object has one
		assert(names.fits("toString", form))
	}
	// extensions are compared as written
	assert(!names.fits("DIAG", "cbor"))
	assert(names.fits("DIAG", "txt"))
})

Deno.test("the paper's names: clock, README.md, data.raw, x.text", () => {
	assertEquals(names.split("clock", "txt"), { stem: "clock", ext: "txt", added: true })
	assertEquals(file("clock", "txt"), ["clock.txt", "clock"])
	assertEquals(names.split("README.md", "txt"), { stem: "README", ext: "md", added: false })
	assertEquals(file("README.md", "txt"), ["README.md", "README"])
	assertEquals(names.split("data.raw", "float32"), {
		stem: "data.raw",
		ext: "float32",
		added: true,
	})
	assertEquals(file("data.raw", "float32"), ["data.raw.float32", "data.raw"])
	assertEquals(names.split("x.text", "cbor"), { stem: "x", ext: "text", added: false })
	assertEquals(file("x.text", "cbor"), ["x.text", "x"])
	// the example store
	assertEquals(file("apps", "cbor"), ["apps.text", "apps"])
	assertEquals(file("Notes", "cbor"), ["Notes.text", "Notes"])
	// a string in a slot named for diag keeps it in its stem
	assertEquals(file("clock.text", "txt"), ["clock.text.txt", "clock.text"])
	// bytes named for a kind are bytes still
	assertEquals(file("data.float32", "bin"), ["data.float32.bin", "data.float32"])
	// a cbor value named for a string's extension
	assertEquals(file("apps.json", "cbor"), ["apps.json.text", "apps.json"])
})

Deno.test("bytes take their extension by how they start, or .bin", () => {
	const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
	assertEquals(names.sniff(png), "png")
	assertEquals(names.sniff(bytes(0xff, 0xd8, 0xff, 0xe0)), "jpg")
	assertEquals(names.sniff(ascii("GIF87a....")), "gif")
	assertEquals(names.sniff(ascii("GIF89a")), "gif")
	assertEquals(names.sniff(ascii("%PDF-1.7")), "pdf")
	assertEquals(names.sniff(ascii("RIFF\x10\0\0\0WEBPVP8 ")), "webp")
	assertEquals(names.sniff(ascii("RIFF\x10\0\0\0WAVEfmt ")), "bin")
	assertEquals(names.sniff(ascii("GIF88a")), "bin")
	assertEquals(names.sniff(png.slice(0, 7)), "bin")
	assertEquals(names.sniff(bytes(0xff, 0xd8)), "bin")
	assertEquals(names.sniff(bytes()), "bin")
	assertEquals(names.sniff(bytes(1, 2, 3)), "bin")
	assert(names.HEAD >= 12)

	assertEquals(names.suffix("txt"), "txt")
	assertEquals(names.suffix("bin"), "bin")
	assertEquals(names.suffix("bin", png), "png")
	assertEquals(names.suffix("cbor"), "text")
	assertEquals(names.suffix("float32"), "float32")
	assertEquals(names.suffix("int64"), "int64")

	// d2 in the example: docs/2.png
	assertEquals(file("d2", "bin", png), ["d2.png", "d2"])
	assertEquals(file("photo", "bin", bytes(9, 9)), ["photo.bin", "photo"])
	// a name's own extension wins over the sniffed one
	assertEquals(file("photo.jpg", "bin", png), ["photo.jpg", "photo"])
})

Deno.test("a union's member takes its slot's extension if it may, and its own otherwise", () => {
	// README.md holding a string and a map has 1.md and 2.text
	const ext = (form: Form) => names.split("README.md", form).ext
	assertEquals(names.member(1) + "." + ext("txt"), "1.md")
	assertEquals(names.member(2) + "." + ext("cbor"), "2.text")
	// docs holding a string and PNG bytes has 1.txt and 2.png
	const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
	assertEquals(names.member(1) + "." + names.split("docs", "txt").ext, "1.txt")
	assertEquals(names.member(2) + "." + names.split("docs", "bin", png).ext, "2.png")
})

Deno.test("a slot's name is written: / as :, : as a full-width colon, NUL as U+FFFD, empty as untitled", () => {
	assertEquals(names.write("a/b", PASS), "a:b")
	assertEquals(names.write("a:b", PASS), "a\uFF1Ab")
	assertEquals(names.write("a\0b", PASS), "a\uFFFDb")
	assertEquals(names.write("", PASS), "untitled")
	assertEquals(names.write("/:/\0", PASS), ":\uFF1A:\uFFFD")
	// the rest as it is
	for (const name of ["Notes", "café", "README", "2 cat", ".hidden", "doc.FINAL", "untitled"]) {
		assertEquals(names.write(name, PASS), name)
	}
	assertEquals(file("a/b", "txt"), ["a:b.txt", "a:b"])
	assertEquals(file("a/b.md", "txt"), ["a:b.md", "a:b"])
	assertEquals(file("", "txt"), ["untitled.txt", "untitled"])
	assertEquals(file("", "cbor"), ["untitled.text", "untitled"])
})

Deno.test("a name the program passes over takes _ at both ends", () => {
	const cases: [string, string][] = [
		[".DS_Store", "_.DS_Store_"],
		[".localized", "_.localized_"],
		["._x", "_._x_"],
		["Icon\r", "_Icon\r_"],
		["notes~", "_notes~_"],
		["x.swp", "_x.swp_"],
		["#x#", "_#x#_"],
		["##", "_##_"],
		["4913", "_4913_"],
	]
	for (const [name, stem] of cases) {
		assertEquals(names.write(name, PASS), stem, JSON.stringify(name))
		assert(!names.passes(stem, PASS))
	}
	// near misses are left alone
	for (const name of ["Icon", "49130", "#x", "x#", "#", "_._x", "notes~.txt", "DS_Store"]) {
		assertEquals(names.write(name, PASS), name, JSON.stringify(name))
	}
	// the check is on the name as written
	assertEquals(names.write("#a/b#", PASS), "_#a:b#_")
	// a host's own names
	assertEquals(names.write("build", ["build", "*.o"]), "_build_")
	assertEquals(names.write("main.o", ["build", "*.o"]), "_main.o_")
	assertEquals(names.write(".DS_Store", ["build"]), ".DS_Store")
	// nothing on disk is passed over: not its file, nor its folder
	assertEquals(file(".DS_Store", "txt"), ["_.DS_Store_.txt", "_.DS_Store_"])
	assertEquals(file("4913.txt", "txt"), ["_4913_.txt", "_4913_"])
	assertEquals(file("x.swp", "txt"), ["_x.swp_.txt", "_x.swp_"])
	assertEquals(names.split("x.swp", "txt"), { stem: "x", ext: "swp", added: false })
})

Deno.test("names passed over match whole, * any run", () => {
	assert(names.passes(".DS_Store", PASS))
	assert(names.passes("._anything", PASS))
	assert(names.passes("._", PASS))
	assert(names.passes("Icon\r", PASS))
	assert(names.passes("~", PASS))
	assert(names.passes(".swp", PASS))
	assert(names.passes("#autosave#", PASS))
	assert(!names.passes(".DS_Store2", PASS))
	assert(!names.passes("x.DS_Store", PASS))
	assert(!names.passes("Icon", PASS))
	assert(!names.passes("x.swp2", PASS))
	assert(!names.passes("#", PASS))
	assert(!names.passes("anything", []))
	assert(names.passes("abc", ["*"]))
	assert(names.passes("", ["*"]))
	assert(names.passes("a-b-c", ["a*b*c"]))
	assert(names.passes("abc", ["a*b*c"]))
	assert(!names.passes("acb", ["a*b*c"]))
	assert(!names.passes("ab", ["a*b*b"]))
	assert(names.passes("abbb", ["a*b*b"]))
	assert(names.passes("a.b.c", ["*.*"]))
})

Deno.test("a stem over 255 bytes with its extension is cut, leaving room for five .FINALs", () => {
	const room = (ext: string) => 255 - (ext ? 1 + ext.length : 0) - 5 * ".FINAL".length
	// 251 + ".txt" is 255: as it is
	const fits = "a".repeat(251)
	assertEquals(names.cut(fits, "txt"), fits)
	// one more is cut
	assertEquals(names.cut("a".repeat(252), "txt"), "a".repeat(room("txt")))
	assertEquals(names.cut("b".repeat(300), "float32"), "b".repeat(room("float32")))
	// a folder alone
	assertEquals(names.cut("c".repeat(255), ""), "c".repeat(255))
	assertEquals(names.cut("c".repeat(256), ""), "c".repeat(room("")))
	// between scalar values, never inside one
	const cut = names.cut("é".repeat(200), "txt")
	assertEquals(cut, "é".repeat(Math.floor(room("txt") / 2)))
	const emoji = names.cut("x" + "😀".repeat(100), "md")
	assert(emoji.isWellFormed())
	assertEquals(utf8(emoji), 1 + 4 * Math.floor((room("md") - 1) / 4))
	// and five .FINALs still fit
	for (const stem of [cut, emoji]) {
		assert(utf8(stem + ".FINAL".repeat(5) + ".txt") <= 255)
	}
})

Deno.test("a stem the same as another takes .FINAL again and again", () => {
	const taken = new Set(["doc", "doc.FINAL"])
	assertEquals(names.free("memo", (s) => taken.has(s)), "memo")
	assertEquals(names.free("doc", (s) => taken.has(s)), "doc.FINAL.FINAL")
	assertEquals(names.free("doc", (s) => s === "doc"), "doc.FINAL")
	// doc.docx, doc.FINAL.docx, doc.FINAL.FINAL.docx
	const folder = new Set<string>()
	const files = [1, 2, 3].map(() => {
		const stem = names.free("doc", (s) => folder.has(names.key(s)))
		folder.add(names.key(stem))
		return stem + ".docx"
	})
	assertEquals(files, ["doc.docx", "doc.FINAL.docx", "doc.FINAL.FINAL.docx"])
	// as .ermine in the store's folder
	const ermine = (s: string) => names.key(s) === names.key(".ermine")
	assertEquals(names.free(".ermine", ermine), ".ermine.FINAL")
	assertEquals(names.free(".Ermine", ermine), ".Ermine.FINAL")
	// . and .. are in every folder
	assertEquals(names.free(".", () => false), "..FINAL")
	assertEquals(names.free("..", () => false), "...FINAL")
	// doc/ cannot be laid beside another node's Doc.txt
	const stems = new Set([names.key("Doc")])
	assertEquals(names.free("doc", (s) => stems.has(names.key(s))), "doc.FINAL")
})

Deno.test("stems are the same after full case folding and NFD", () => {
	const same: string[][] = [
		["doc", "Doc", "DOC"],
		["café", "cafe\u0301", "CAFÉ", "CAFE\u0301"],
		["straße", "STRASSE", "strasse", "STRAẞE"],
		["ﬁle", "file", "FILE"],
		["ΟΔΟΣ", "οδος", "οδοσ", "οδος"],
		["\u212A", "k", "K"], // Kelvin
		["\u212B", "å", "a\u030A", "Å"], // Ångström
		["µ", "μ", "Μ"], // micro
		["ſ", "s", "S"], // long s
		["İ", "i\u0307"],
		["ᾳ", "ΑΙ", "αι", "ᾼ"],
		["Ꭰ", "ꭰ"], // Cherokee folds to upper case
	]
	for (const group of same) {
		for (const s of group) assertEquals(names.key(s), names.key(group[0]), `${s} ${group[0]}`)
	}
	const different: [string, string][] = [
		["a", "b"],
		["e", "é"],
		["ı", "i"], // dotless i has no folding
		["ı", "I"],
		["doc", "doc "],
		["1", "١"],
	]
	for (const [a, b] of different) assertNotEquals(names.key(a), names.key(b), `${a} ${b}`)
})

Deno.test("a name a person gives is read back one way", () => {
	assertEquals(names.read("a:b"), "a/b")
	assertEquals(names.read("a\uFF1Ab"), "a:b")
	assertEquals(names.read(":\uFF1A:"), "/:/")
	// anything else as itself, untitled, .FINAL and _ included
	for (const name of ["untitled", "doc.FINAL", "_.DS_Store_", "\uFFFD", "café", "2 cat", ""]) {
		assertEquals(names.read(name), name)
	}
	// so what the store writes reads back, but for NUL, the empty name and those passed over
	for (const name of ["a/b", "a:b", "x/y:z", "Notes", "README.md"]) {
		assertEquals(names.read(names.write(name, PASS)), name)
	}
	assertEquals(names.read(names.write("", PASS)), "untitled")
	assertEquals(names.read(names.write("\0", PASS)), "\uFFFD")
	assertEquals(names.read(names.write(".DS_Store", PASS)), "_.DS_Store_")
})

Deno.test("a union's members are numbered, keeping a person's words", () => {
	assertEquals(names.member(1), "1")
	assertEquals(names.member(2, " cat"), "2 cat")
	assertEquals(names.number("1"), [1, ""])
	assertEquals(names.number("2 cat"), [2, " cat"])
	assertEquals(names.number("10-dogs"), [10, "-dogs"])
	assertEquals(names.number("3cat"), [3, "cat"])
	assertEquals(names.number("cat"), undefined)
	assertEquals(names.number(" 2"), undefined)
	assertEquals(names.number(""), undefined)
	assertEquals(names.number("٢"), undefined)
	// numbered again: 2 cat.png becomes 1 cat.png when the first goes
	const [, words] = names.number("2 cat")!
	assertEquals(names.member(1, words), "1 cat")
	for (const stem of ["1", "2 cat", "12 a b", "3.FINAL"]) {
		const [n, w] = names.number(stem)!
		assertEquals(names.member(n, w), stem)
	}
})

Deno.test("a new file's name gives its slot, less a .text or .kind, which gives its form", () => {
	assertEquals(names.take("x.text"), { slot: "x", form: "cbor" })
	assertEquals(names.take("data.float32"), { slot: "data", form: "float32" })
	assertEquals(names.take("data.raw.int8"), { slot: "data.raw", form: "int8" })
	assertEquals(names.take("data.raw.uint8"), { slot: "data.raw.uint8" })
	assertEquals(names.take("notes.txt"), { slot: "notes.txt" })
	assertEquals(names.take("README"), { slot: "README" })
	assertEquals(names.take("photo.png"), { slot: "photo.png" })
	assertEquals(names.take("a:b.md"), { slot: "a/b.md" })
	assertEquals(names.take("a\uFF1Ab.text"), { slot: "a:b", form: "cbor" })
	assertEquals(names.take(".text"), { slot: ".text" })
	assertEquals(names.take("x.DIAG"), { slot: "x.DIAG" })
	assertEquals(names.take("untitled.txt"), { slot: "untitled.txt" })
	// laid out again, it keeps its name
	for (const name of ["x.text", "data.float32", "notes.txt", "README.md"]) {
		const { slot, form } = names.take(name)
		assertEquals(file(slot, form ?? "txt")[0], name)
	}
})

Deno.test("a renamed entry gives its slot", () => {
	// clock.txt to time.txt is the slot time
	assertEquals(names.renamed("time.txt", "txt", false), "time")
	// doc.FINAL.docx, the slot doc.docx, to memo.docx is memo.docx
	assertEquals(names.renamed("memo.docx", undefined, false), "memo.docx")
	// README/ to DOCS/ is the slot DOCS.md
	assertEquals(names.renamed("DOCS", "md", true), "DOCS.md")
	assertEquals(names.renamed("DOCS", undefined, true), "DOCS")
	// clock.txt to clock.text is the slot clock.text, still a string, laid as clock.text.txt
	assertEquals(names.renamed("clock.text", "txt", false), "clock.text")
	assertEquals(file("clock.text", "txt")[0], "clock.text.txt")
	// apps.text to apps.json is the slot apps.json
	assertEquals(names.renamed("apps.json", "text", false), "apps.json")
	// read back
	assertEquals(names.renamed("a:b.txt", "txt", false), "a/b")
	assertEquals(names.renamed("a:b", "md", true), "a/b.md")
	// a name that is only the extension keeps it
	assertEquals(names.renamed(".txt", "txt", false), ".txt")
})

Deno.test("an id in a link is percent-encoded, . as %2E", () => {
	assertEquals(names.percent("x9"), "x9")
	assertEquals(names.percent("a.b"), "a%2Eb")
	assertEquals(names.percent("."), "%2E")
	assertEquals(names.percent(".."), "%2E%2E")
	assertEquals(names.percent("a/b"), "a%2Fb")
	assertEquals(names.percent("50%"), "50%25")
	assertEquals(names.percent("a b"), "a%20b")
	assertEquals(names.percent("café"), "caf%C3%A9")
	for (const id of ["x9", "a.b", ".", "..", "a/b", "50%", "a b", "café", "😀", ":", "\0"]) {
		assertEquals(names.unpercent(names.percent(id)), id)
	}
	// a link a person makes by hand
	assertEquals(names.unpercent("x9"), "x9")
	assertEquals(names.unpercent("a.b"), "a.b")
	assertEquals(names.unpercent("%zz"), "%zz")
	assertEquals(names.unpercent("100%"), "100%")
})

/** mulberry32 */
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const POOL = [
	..."aAzZ09._-~#* ",
	"/",
	":",
	"\0",
	"\uFF1A",
	"\r",
	"é",
	"e\u0301",
	"ß",
	"ẞ",
	"Σ",
	"ς",
	"😀",
	"中",
	".txt",
	".text",
	".float32",
	".swp",
	".DS_Store",
	"Icon",
	"4913",
]

Deno.test("random names, a few dozen seeds", () => {
	const forms: Form[] = ["txt", "bin", "cbor", "float32", "int8"]
	for (let seed = 1; seed <= 40; seed++) {
		const r = random(seed)
		const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
		for (let i = 0; i < 50; i++) {
			let name = ""
			const n = Math.floor(r() * (r() < 0.1 ? 120 : 6))
			for (let j = 0; j < n; j++) name += pick(POOL)
			const form = pick(forms)
			const where = `seed ${seed}: ${JSON.stringify(name)} ${form}`

			// the file and folder are names a volume takes and the program sees
			const { stem, ext, added } = names.split(name, form, undefined, PASS)
			assertEquals(added ? stem : stem + "." + ext, name, where)
			assert(names.fits(ext, form), where)
			const written = names.write(stem, PASS)
			assert(written !== "" && !/[/\0]/.test(written), where)
			assert(!names.passes(written, PASS), where)
			assert(!names.passes(written + "." + ext, PASS), where)
			const cut = names.cut(written, ext)
			assert(written.startsWith(cut) && cut.isWellFormed(), where)
			if (cut !== written) assert(utf8(cut + ".FINAL".repeat(5) + "." + ext) <= 255, where)
			else assert(utf8(cut + "." + ext) <= 255, where)
			const free = names.free(cut, (s) => s === cut)
			assertEquals(free, cut + ".FINAL", where)

			// what the store writes reads back, unless it had to change it
			if (
				!/[\0\uFF1A]/.test(name) && name !== "" && !names.passes(names.write(name, []), PASS)
			) {
				assertEquals(names.read(names.write(name, PASS)), name, where)
			}

			// the key is a key
			const k = names.key(name)
			assertEquals(names.key(k), k, where)
			assertEquals(names.key(name.normalize("NFC")), k, where)
			assertEquals(names.key(name.toUpperCase()), k, where)

			// an id goes into a link and back
			const segment = names.percent(name)
			assert(!/[/.]/.test(segment), where)
			assertEquals(names.unpercent(segment), name, where)

			// a member's words survive renumbering
			const words = name.replace(/^[0-9]+/, "")
			if (!/^[0-9]/.test(words)) {
				assertEquals(names.number(names.member(i + 1, words)), [i + 1, words])
			}
		}
	}
})
