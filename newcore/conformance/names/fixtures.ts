// Writes the names scenarios to newcore/files/conformance/names/NN-short-name.json.
//   deno run --allow-read --allow-write --allow-run --allow-env conformance/names/fixtures.ts
// A scenario is a list of requests on the line protocol (harness.ts) and the answers expected. The
// answers are the reference's (names.ts through harness.ts); the tricky ones are also given by hand
// here, and the run fails where the reference does not agree. Cases are picked for what crosses
// languages badly: case folding and normalization, bytes against code points, UTF-16 against code
// point order, percent-encoding, patterns.

const out = new URL("../../files/conformance/names/", import.meta.url)
const here = new URL(".", import.meta.url).pathname

type Req = Record<string, unknown> & { op: string }
// a request, and the answer expected where it is worked out by hand
type Case = [Req] | [Req, unknown]
const c = (req: Req, want?: unknown): Case => want === undefined ? [req] : [req, want]
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("")
const PASS = [".DS_Store", ".localized", "._*", "Icon\r", "*~", "*.swp", "#*#", "4913"]

const scenarios: { name: string; title: string; cases: Case[] }[] = []
const add = (name: string, title: string, ...cases: Case[]) =>
	scenarios.push({ name, title, cases })

const key = (stem: string, want?: unknown) => c({ op: "key", stem }, want)
const ext = (name: string, want?: unknown) => c({ op: "extension", name }, want)
const bycp = (a: string, b: string, want?: number) => c({ op: "bycodepoint", a, b }, want)
const NO = null

add(
	"extension",
	"a dot not first, then 1 to 8 ASCII letters and digits",
	ext("clock", NO),
	ext("README.md", "md"),
	ext("data.raw.float32", "float32"),
	ext(".bashrc", NO),
	ext("..a", "a"),
	ext("a.", NO),
	ext("", NO),
	ext("x.12345678", "12345678"),
	ext("x.123456789", NO),
	ext("x.tar-gz", NO),
	ext("x.é", NO),
	ext("x.ｔｘｔ", NO),
	ext("café.txt", "txt"),
	ext("a.b/c", NO),
	ext("a.TXT", "TXT"),
	ext("a.b\u0000", NO),
	ext("日本語.png", "png"),
	ext("😀.md", "md"),
	// .FINAL comes before an extension, never is one; compared as written
	ext("a.FINAL", NO),
	ext("a.FINAL.FINAL", NO),
	ext("a.FINAL.txt", "txt"),
	ext("a.final", "final"),
)

add(
	"fits",
	"cbor only .text, a kind only its own, txt and bin any other",
	c({ op: "fits", ext: "text", form: "cbor" }, true),
	c({ op: "fits", ext: "json", form: "cbor" }, false),
	c({ op: "fits", ext: "text", form: "txt" }, false),
	c({ op: "fits", ext: "text", form: "bin" }, false),
	c({ op: "fits", ext: "md", form: "txt" }, true),
	c({ op: "fits", ext: "png", form: "bin" }, true),
	c({ op: "fits", ext: "float32", form: "txt" }, false),
	c({ op: "fits", ext: "int8", form: "bin" }, false),
	// no uint8 kind (the designer, 10-12): an extension like any other
	c({ op: "fits", ext: "uint8", form: "bin" }, true),
	c({ op: "fits", ext: "int64", form: "int64" }, true),
	c({ op: "fits", ext: "float64", form: "float32" }, false),
	c({ op: "fits", ext: "raw", form: "float32" }, false),
	c({ op: "fits", ext: "Float32", form: "txt" }, true),
	c({ op: "fits", ext: "TEXT", form: "bin" }, true),
	c({ op: "fits", ext: "TEXT", form: "cbor" }, false),
)

add(
	"sniff",
	"a bin value's extension by its first bytes",
	c(
		{ op: "sniff", head: hex([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]) },
		"png",
	),
	c({ op: "sniff", head: hex([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]) }, "bin"),
	c({ op: "sniff", head: hex([0xff, 0xd8, 0xff]) }, "jpg"),
	c({ op: "sniff", head: hex([0xff, 0xd8]) }, "bin"),
	c({ op: "sniff", head: hex([...Buffer("GIF87a")]) }, "gif"),
	c({ op: "sniff", head: hex([...Buffer("GIF89a")]) }, "gif"),
	c({ op: "sniff", head: hex([...Buffer("GIF88a")]) }, "bin"),
	c({ op: "sniff", head: hex([...Buffer("%PDF-1.7")]) }, "pdf"),
	c({ op: "sniff", head: hex([...Buffer("%PDF")]) }, "bin"),
	c({ op: "sniff", head: hex([...Buffer("RIFF"), 1, 2, 3, 4, ...Buffer("WEBP")]) }, "webp"),
	c({ op: "sniff", head: hex([...Buffer("RIFF"), 1, 2, 3, 4, ...Buffer("WAVE")]) }, "bin"),
	c({ op: "sniff", head: hex([...Buffer("RIFF"), 1, 2, 3, 4, ...Buffer("WEB")]) }, "bin"),
	c({ op: "sniff", head: "" }, "bin"),
	c({ op: "sniff", head: "00" }, "bin"),
	// not at the start
	c({ op: "sniff", head: hex([0, ...Buffer("%PDF-")]) }, "bin"),
)

add(
	"suffix",
	"the extension the store adds",
	c({ op: "suffix", form: "txt" }, "txt"),
	c(
		{ op: "suffix", form: "txt", head: hex([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
		"txt",
	),
	c({ op: "suffix", form: "bin" }, "bin"),
	c({ op: "suffix", form: "bin", head: hex([0xff, 0xd8, 0xff, 0xe0]) }, "jpg"),
	c({ op: "suffix", form: "bin", head: hex([...Buffer("%PDF-")]) }, "pdf"),
	c({ op: "suffix", form: "cbor" }, "text"),
	c({ op: "suffix", form: "float32" }, "float32"),
	c({ op: "suffix", form: "int8" }, "int8"),
	c({ op: "suffix", form: "int64" }, "int64"),
)

add(
	"split",
	"a name less an extension that fits, or the whole name and the extension added",
	c({ op: "split", name: "clock", form: "txt" }, { stem: "clock", ext: "txt", added: true }),
	c({ op: "split", name: "notes.md", form: "txt" }, { stem: "notes", ext: "md", added: false }),
	c({ op: "split", name: "a.FINAL", form: "txt" }, { stem: "a.FINAL", ext: "txt", added: true }),
	c({ op: "split", name: "notes.md", form: "cbor" }, {
		stem: "notes.md",
		ext: "text",
		added: true,
	}),
	c({ op: "split", name: "notes.text", form: "cbor" }, {
		stem: "notes",
		ext: "text",
		added: false,
	}),
	c({ op: "split", name: "notes.text", form: "txt" }, {
		stem: "notes.text",
		ext: "txt",
		added: true,
	}),
	c({ op: "split", name: "a.float32", form: "float32" }, {
		stem: "a",
		ext: "float32",
		added: false,
	}),
	c({ op: "split", name: "a.float32", form: "bin" }, {
		stem: "a.float32",
		ext: "bin",
		added: true,
	}),
	c({ op: "split", name: "a.float64", form: "float32" }, {
		stem: "a.float64",
		ext: "float32",
		added: true,
	}),
	c({ op: "split", name: ".bashrc", form: "txt" }, { stem: ".bashrc", ext: "txt", added: true }),
	c({
		op: "split",
		name: "pic",
		form: "bin",
		head: hex([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	}, { stem: "pic", ext: "png", added: true }),
	c({
		op: "split",
		name: "pic.png",
		form: "bin",
		head: hex([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	}, { stem: "pic", ext: "png", added: false }),
	c({
		op: "split",
		name: "pic.jpg",
		form: "bin",
		head: hex([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	}, { stem: "pic", ext: "jpg", added: false }),
	c({ op: "split", name: "日本.txt", form: "txt" }, { stem: "日本", ext: "txt", added: false }),
	c({ op: "split", name: "a.b.c.d", form: "txt" }, { stem: "a.b.c", ext: "d", added: false }),
)

add(
	"split-pass",
	"a name that would be passed over keeps its extension in the stem",
	c({ op: "split", name: "foo.swp", form: "txt", pass: PASS }, {
		stem: "foo.swp",
		ext: "txt",
		added: true,
	}),
	c({ op: "split", name: "foo.swp", form: "txt" }, { stem: "foo", ext: "swp", added: false }),
	c({ op: "split", name: "foo.swp", form: "txt", pass: [] }, {
		stem: "foo",
		ext: "swp",
		added: false,
	}),
	c({ op: "split", name: "foo.md", form: "txt", pass: PASS }, {
		stem: "foo",
		ext: "md",
		added: false,
	}),
	c({ op: "split", name: "._x.md", form: "txt", pass: PASS }, {
		stem: "._x.md",
		ext: "txt",
		added: true,
	}),
	c({ op: "split", name: "#x#", form: "txt", pass: PASS }, {
		stem: "#x#",
		ext: "txt",
		added: true,
	}),
	c({ op: "split", name: "x~", form: "bin", pass: PASS }, { stem: "x~", ext: "bin", added: true }),
	c({ op: "split", name: ".DS_Store", form: "txt", pass: PASS }, {
		stem: ".DS_Store",
		ext: "txt",
		added: true,
	}),
	c({ op: "split", name: "4913", form: "cbor", pass: PASS }, {
		stem: "4913",
		ext: "text",
		added: true,
	}),
)

add(
	"write",
	"/ as :, : as U+FF1A, NUL as U+FFFD, empty as untitled",
	c({ op: "write", name: "a/b", pass: PASS }, "a:b"),
	c({ op: "write", name: "a:b", pass: PASS }, "a：b"),
	c({ op: "write", name: "a/b:c/d", pass: PASS }, "a:b：c:d"),
	c({ op: "write", name: "a\u0000b", pass: PASS }, "a�b"),
	c({ op: "write", name: "\u0000", pass: PASS }, "�"),
	c({ op: "write", name: "", pass: PASS }, "untitled"),
	c({ op: "write", name: "", pass: [] }, "untitled"),
	c({ op: "write", name: "plain", pass: PASS }, "plain"),
	c({ op: "write", name: "日本語/😀", pass: PASS }, "日本語:😀"),
	c({ op: "write", name: "：", pass: PASS }, "："),
	c({ op: "write", name: ".", pass: PASS }, "."),
	c({ op: "write", name: "..", pass: PASS }, ".."),
)

add(
	"write-pass",
	"a stem that would be passed over is wrapped in _",
	c({ op: "write", name: ".DS_Store", pass: PASS }, "_.DS_Store_"),
	c({ op: "write", name: ".localized", pass: PASS }, "_.localized_"),
	c({ op: "write", name: "._foo", pass: PASS }, "_._foo_"),
	c({ op: "write", name: "Icon\r", pass: PASS }, "_Icon\r_"),
	c({ op: "write", name: "Icon", pass: PASS }, "Icon"),
	c({ op: "write", name: "draft~", pass: PASS }, "_draft~_"),
	c({ op: "write", name: "foo.swp", pass: PASS }, "_foo.swp_"),
	c({ op: "write", name: "#x#", pass: PASS }, "_#x#_"),
	c({ op: "write", name: "#", pass: PASS }, "#"),
	c({ op: "write", name: "4913", pass: PASS }, "_4913_"),
	c({ op: "write", name: "49130", pass: PASS }, "49130"),
	// a slash becomes a colon before the patterns are asked
	c({ op: "write", name: "a/b~", pass: PASS }, "_a:b~_"),
	c({ op: "write", name: ".DS_Store", pass: [] }, ".DS_Store"),
	c({ op: "write", name: "x", pass: ["x"] }, "_x_"),
	c({ op: "write", name: "x", pass: ["*"] }, "_x_"),
	c({ op: "write", name: "", pass: ["*"] }, "_untitled_"),
	c({ op: "write", name: "", pass: ["untitled"] }, "_untitled_"),
)

// cut: sizes in bytes of UTF-8
const a = (n: number) => "a".repeat(n)
add(
	"cut-fits",
	"a stem and its extension under 255 bytes are left as they are",
	c({ op: "cut", stem: "", ext: "txt" }, ""),
	c({ op: "cut", stem: "clock", ext: "txt" }, "clock"),
	c({ op: "cut", stem: a(251), ext: "txt" }, a(251)),
	c({ op: "cut", stem: a(252), ext: "txt" }, a(252 - 252 + 221)),
	c({ op: "cut", stem: a(255), ext: "" }, a(255)),
	c({ op: "cut", stem: a(256), ext: "" }, a(225)),
	c({ op: "cut", stem: "é".repeat(127), ext: "" }, "é".repeat(127)),
	c({ op: "cut", stem: "é".repeat(128), ext: "" }, "é".repeat(112)),
)

add(
	"cut-ascii",
	"over 255, the stem is cut to leave room for the extension and five .FINALs",
	c({ op: "cut", stem: a(300), ext: "txt" }, a(221)),
	c({ op: "cut", stem: a(300), ext: "text" }, a(220)),
	c({ op: "cut", stem: a(300), ext: "" }, a(225)),
	c({ op: "cut", stem: a(300), ext: "float32" }, a(217)),
	c({ op: "cut", stem: a(1000), ext: "md" }, a(222)),
)

add(
	"cut-code-points",
	"a cut falls between scalar values, never inside one",
	// 2-byte: room 225 holds 112, the 113th would be 226
	c({ op: "cut", stem: "é".repeat(200), ext: "" }, "é".repeat(112)),
	// 3-byte: 75 of them are 225
	c({ op: "cut", stem: "日".repeat(100), ext: "" }, "日".repeat(75)),
	c({ op: "cut", stem: "日".repeat(100), ext: "txt" }, "日".repeat(73)),
	// 4-byte: 56 are 224, the 57th would be 228
	c({ op: "cut", stem: "😀".repeat(100), ext: "" }, "😀".repeat(56)),
	// 224 of ascii, then a 4-byte one does not fit in 1 byte left, nor the ascii after it
	c({ op: "cut", stem: a(224) + "😀" + "bbbb" + a(100), ext: "" }, a(224)),
	c({ op: "cut", stem: a(223) + "é" + a(100), ext: "" }, a(223) + "é"),
	c({ op: "cut", stem: a(224) + "é" + a(100), ext: "" }, a(224)),
	// the extension's own size counts in bytes
	c({ op: "cut", stem: a(300), ext: "日本" }, a(255 - 7 - 30)),
)

add(
	"cut-marks",
	"a cut is by scalar value: it can fall between a base and its marks",
	c({ op: "cut", stem: a(224) + "é" + a(50), ext: "" }, a(224) + "e"),
	c({ op: "cut", stem: a(223) + "é" + a(50), ext: "" }, a(223) + "e"),
	c({ op: "cut", stem: a(222) + "é" + a(50), ext: "" }, a(222) + "é"),
	// a ZWJ sequence is cut between its emoji
	c({ op: "cut", stem: a(215) + "👨‍👩‍👧" + a(50), ext: "" }, a(215) + "👨‍"),
)

add(
	"cut-odd",
	"NUL counts one byte and a lone surrogate three",
	c({ op: "cut", stem: "\u0000".repeat(300), ext: "" }, "\u0000".repeat(225)),
	c({ op: "cut", stem: "\u0000".repeat(255), ext: "" }, "\u0000".repeat(255)),
	c({ op: "cut", stem: "\ud800".repeat(100), ext: "" }, "\ud800".repeat(75)),
	c({ op: "cut", stem: "\ud800".repeat(85), ext: "" }, "\ud800".repeat(85)),
	c({ op: "cut", stem: "\ud800".repeat(84), ext: "" }, "\ud800".repeat(84)),
	c({ op: "cut", stem: "\ud800".repeat(86), ext: "" }, "\ud800".repeat(75)),
	c({ op: "cut", stem: "\udc00" + a(300), ext: "" }, "\udc00" + a(222)),
)

add(
	"free",
	"the stem with .FINAL added until it is free",
	c({ op: "free", stem: "a", taken: [] }, "a"),
	c({ op: "free", stem: "a", taken: ["a"] }, "a.FINAL"),
	c({ op: "free", stem: "a", taken: ["a", "a.FINAL"] }, "a.FINAL.FINAL"),
	c({ op: "free", stem: "a", taken: ["a.FINAL"] }, "a"),
	c({ op: "free", stem: "a", taken: ["a", "a.FINAL", "a.FINAL.FINAL"] }, "a.FINAL.FINAL.FINAL"),
	c({ op: "free", stem: ".", taken: [] }, "..FINAL"),
	c({ op: "free", stem: "..", taken: [] }, "...FINAL"),
	c({ op: "free", stem: ".", taken: ["..FINAL"] }, "..FINAL.FINAL"),
	c({ op: "free", stem: "", taken: [] }, ""),
	c({ op: "free", stem: "", taken: [""] }, ".FINAL"),
	c({ op: "free", stem: "é", taken: ["é"] }, "é"),
	c({ op: "free", stem: "日本", taken: ["日本"] }, "日本.FINAL"),
)

add(
	"read",
	"a person's name read back: : as /, U+FF1A as :",
	c({ op: "read", name: "a:b" }, "a/b"),
	c({ op: "read", name: "a：b" }, "a:b"),
	c({ op: "read", name: "a:b：c:d" }, "a/b:c/d"),
	c({ op: "read", name: "a/b" }, "a/b"),
	c({ op: "read", name: "" }, ""),
	c({ op: "read", name: "日本：語:😀" }, "日本:語/😀"),
	c({ op: "read", name: "�" }, "�"),
	c({ op: "read", name: "：：::" }, "::" + "//"),
	// write then read gives the name back, but for NUL
	c({ op: "read", name: "ａ" }, "ａ"),
)

add(
	"key-case",
	"key folds case: ASCII, accents, Greek, Cyrillic, Armenian, Georgian, Cherokee",
	key("", ""),
	key("Clock", "clock"),
	key("CLOCK", "clock"),
	key("cLoCk 2", "clock 2"),
	key("ÀÉÎÕÜ", "àéîõü"),
	key("ΑΒΓΔ", "αβγδ"),
	key("ЖИВОТ", "живот"),
	key("ԱԲԳ", "աբգ"),
	key("ᲐᲑᲒ", "აბგ"),
	key("Ა", "ა"),
	key("ა", "ა"),
	key("ꭰ"),
	key("Ꭰ"),
	key("ᎠᎡᎢ"),
	key("ǅ"),
	key("ǈ"),
	key("ǲ"),
	key("ⅷ"),
	key("Ⅷ"),
	key("Ⓐ"),
	key("ａｂｃ"),
	key("ＡＢＣ"),
	key("a-b_c.D"),
)

add(
	"key-full",
	"full case folding: ß, ẞ, ligatures, ŉ, ǰ, ΐ, final forms",
	key("ß"),
	key("ẞ"),
	key("SS"),
	key("ss"),
	key("Straße"),
	key("STRASSE"),
	key("ﬁ", "fi"),
	key("ﬃ", "ffi"),
	key("ﬆ", "st"),
	key("ŉ"),
	key("ǰ"),
	key("ΐ"),
	key("ΰ"),
	key("ᾳ"),
	key("ᾼ"),
	key("ᾈ"),
	key("ῼ"),
	key("և"),
	key("ẚ"),
	key("ẛ"),
	key("ſ", "s"),
	key("ſt"),
	key("K", "k"),
	key("Å"),
	key("Ω"),
	key("ϐ"),
	key("ϑ"),
	key("ϕ"),
	key("ϖ"),
	key("ϰ"),
	key("ϱ"),
	key("ϵ"),
	key("ᲀ"),
	key("ᲁ"),
	key("ᲈ"),
)

add(
	"key-turkish",
	"Turkish i: dotless ı stays, dotted İ folds to i and a dot above, I to i",
	key("I", "i"),
	key("i", "i"),
	key("ı", "ı"),
	key("İ", "i̇"),
	key("İ", "i̇"),
	key("i̇", "i̇"),
	key("ıI", "ıi"),
	key("Iı", "iı"),
	key("ISTANBUL", "istanbul"),
	key("İSTANBUL", "i̇stanbul"),
	key("ISPARTA", "isparta"),
	key("ısparta", "ısparta"),
	key("ıİı", "ıi̇ı"),
	key("ııı", "ııı"),
	// the pieces are folded alone, so a sigma after ı has no cased letter before it
	key("ΑΣı"),
	key("ıΣ"),
	key("ıΑΣ"),
	key("Σ"),
)

add(
	"key-sigma",
	"Σ folds to ς at the end of a word and σ elsewhere; ς, σ and Σ all compare as written",
	key("Σ"),
	key("σ"),
	key("ς"),
	key("ΑΣ"),
	key("ΑΣ "),
	key("ΑΣΑ"),
	key("ΣΑ"),
	key("ΑΣΣ"),
	key("ΑΣΣΑ"),
	key("ΟΔΥΣΣΕΥΣ", "οδυσσευς"),
	key("ΟΔΥΣΣΕΥΣ."),
	key("ΣΑΣ"),
	key("ΑΣ.Α"),
	key("ΑΣ'Α"),
	key("ΑΣ́"),
	key("ΆΣ"),
	key("Α.Σ"),
	key("Α Σ"),
	key("1Σ"),
	key("Α1Σ"),
	key("ΑΣ1"),
	key("Σ.Α"),
	key("ΑΣ·Α"),
	key("ΑΣ­Α"),
	key("ΑΣ.́Α"),
	key("ʰΣ"),
	key("ΣʰΑ"),
	key("aΣ"),
	key("aΣb"),
	key("ΑΣ𐐀"),
	key("𐐀Σ"),
	key("σ"),
	key("ΑΣς"),
	key("ΑΣσ"),
	key("ςΣ"),
	key("ᾼΣ"),
	key("ΑΣ_Α"),
)

add(
	"key-normal",
	"key is NFD: composed and decomposed compare equal, marks in canonical order",
	key("é", "é"),
	key("é", "é"),
	key("É", "é"),
	key("ǻ"),
	key("ḉ"),
	key("ệ"),
	key("ạ́", "ạ́"),
	key("ạ́", "ạ́"),
	key("ạ́́"),
	key("á̖̗̂"),
	key("à֮̀̕̕"),
	key("Å"),
	key("Å"),
	key("Ω"),
	key("ŉ"),
	key("ﬀ"),
	key("①"),
	key("㎏"),
	key("ｱ"),
	key("𝐀𝐁𝐂"),
	key("Ĳ"),
	key("ǆ"),
	key("́"),
	key("̣́"),
	key("̣́"),
	key("ẹ́́"),
	key("ᾀ"),
	key("ᾈ"),
	key("Άͅ"),
	key("ᾴ"),
	key("ﬁ́"),
	key("ŉ́"),
	key("゙゙"),
	key("が"),
	key("が"),
	key("ガ"),
	key("ｶﾞ"),
	key("ཱི"),
	key("ཱི"),
	key("ཱི"),
	key("ẛ̣"),
	key("̈́"),
	key("क़"),
	key("Ω"),
	key("Å"),
	key("⫝̸"),
	key("𝅗𝅥"),
	key("𝆹𝅥𝅮"),
	key("\u{1d15e}"),
	key("\u{2f800}"),
)

add(
	"key-hangul",
	"Hangul syllables decompose to jamo; jamo and syllables compare equal",
	key("한글", "한글"),
	key("한", "한"),
	key("가", "가"),
	key("각", "각"),
	key("힣", "힣"),
	key("각"),
	key("각"),
	key("ㅎ"),
	key("ﾎ"),
	key("ᄀ"),
	key("힣"),
	key("힤"),
	key("꯿"),
	key("꧊"),
	key("깨끗"),
	key("각"),
	key("한 글 ABC"),
	key("ᆨ가"),
)

add(
	"key-astral",
	"scalar values past U+FFFF: Deseret, Osage, Adlam, Warang Citi, math letters",
	key("𐐀", "𐐨"),
	key("𐐨", "𐐨"),
	key("𐒰"),
	key("𐓘"),
	key("𞤀", "𞤢"),
	key("𞤢"),
	key("𑢠"),
	key("𑣀"),
	key("𐲀"),
	key("𐳀"),
	key("𖹀"),
	key("𖹠"),
	key("𝐀"),
	key("𝒜"),
	key("🅐"),
	key("😀"),
	key("👨‍👩‍👧"),
	key("🇦🇧"),
	key("𠀀"),
	key("𐐀𐐁𐐂"),
	key("a𐐀b"),
	key("A𐐀B"),
	key("𞤀Σ"),
	key("Σ𞤀"),
	key("𐐀Σ𐐀"),
)

add(
	"key-lone",
	"a lone surrogate, NUL, and controls pass through",
	key("\ud800"),
	key("\udc00"),
	key("a\ud800B"),
	key("\udc00\ud800"),
	key("A\ud83d"),
	key("\ude00A"),
	key("\u0000"),
	key("A\u0000B"),
	key("\u0001\u007f\u0080\u009f"),
	key("﻿"),
	key("�"),
	key("￿"),
	key("￾"),
	key(""),
	key("‍"),
	key("A‍B"),
	key(" "),
	key("a­b"),
	key("  "),
	key("\r\n\t "),
	key("͸"),
	key("\u{10ffff}"),
	key("\u{e0001}"),
	key("\u{e0100}"),
	key("ΑΣ\ud800"),
	key("Σ\ud800Α"),
	key("\ud800Σ"),
)

add(
	"key-same",
	"names that key the same compare equal: the keys of each pair are one",
	key("Résumé.txt"),
	key("Résumé.TXT"),
	key("RÉSUMÉ.txt"),
	key("STRASSE"),
	key("Straße"),
	key("STRAẞE"),
	key("strasse"),
	key("ΣΊΣΥΦΟΣ"),
	key("σίσυφος"),
	key("σίσυφοσ"),
	key("한글"),
	key("한글"),
	key("ǅ"),
	key("ǆ"),
	key("Ǆ"),
	key("ǅ"),
	key("Ǆ"),
)

add(
	"passes",
	"a whole name matched by a pattern, * for any run",
	c({ op: "passes", name: ".DS_Store", pass: PASS }, true),
	c({ op: "passes", name: ".DS_StorE", pass: PASS }, false),
	c({ op: "passes", name: "x.DS_Store", pass: PASS }, false),
	c({ op: "passes", name: "._", pass: PASS }, true),
	c({ op: "passes", name: "._x", pass: PASS }, true),
	c({ op: "passes", name: ".", pass: PASS }, false),
	c({ op: "passes", name: "x._x", pass: PASS }, false),
	c({ op: "passes", name: "Icon\r", pass: PASS }, true),
	c({ op: "passes", name: "Icon", pass: PASS }, false),
	c({ op: "passes", name: "~", pass: PASS }, true),
	c({ op: "passes", name: "a~", pass: PASS }, true),
	c({ op: "passes", name: "~a", pass: PASS }, false),
	c({ op: "passes", name: "a.swp", pass: PASS }, true),
	c({ op: "passes", name: ".swp", pass: PASS }, true),
	c({ op: "passes", name: "swp", pass: PASS }, false),
	c({ op: "passes", name: "a.swpx", pass: PASS }, false),
	c({ op: "passes", name: "##", pass: PASS }, true),
	c({ op: "passes", name: "#", pass: PASS }, false),
	c({ op: "passes", name: "#a#", pass: PASS }, true),
	c({ op: "passes", name: "#a#b", pass: PASS }, false),
	c({ op: "passes", name: "4913", pass: PASS }, true),
	c({ op: "passes", name: "49130", pass: PASS }, false),
	c({ op: "passes", name: "", pass: PASS }, false),
	c({ op: "passes", name: "", pass: ["*"] }, true),
	c({ op: "passes", name: "", pass: [""] }, true),
	c({ op: "passes", name: "a", pass: [""] }, false),
	c({ op: "passes", name: "a", pass: [] }, false),
	c({ op: "passes", name: "日本~", pass: PASS }, true),
	c({ op: "passes", name: "😀~", pass: PASS }, true),
	c({ op: "passes", name: "é", pass: ["é"] }, false),
	c({ op: "passes", name: "É", pass: ["é"] }, false),
)

add(
	"passes-stars",
	"several stars: the parts in order, not overlapping the ends",
	c({ op: "passes", name: "abc", pass: ["a*c"] }, true),
	c({ op: "passes", name: "ac", pass: ["a*c"] }, true),
	c({ op: "passes", name: "a", pass: ["a*a"] }, false),
	c({ op: "passes", name: "aa", pass: ["a*a"] }, true),
	c({ op: "passes", name: "a", pass: ["a*"] }, true),
	c({ op: "passes", name: "a", pass: ["*a"] }, true),
	c({ op: "passes", name: "a", pass: ["**"] }, true),
	c({ op: "passes", name: "", pass: ["**"] }, true),
	c({ op: "passes", name: "xyz", pass: ["*y*"] }, true),
	c({ op: "passes", name: "xz", pass: ["*y*"] }, false),
	c({ op: "passes", name: "y", pass: ["*y*"] }, true),
	c({ op: "passes", name: "abcabc", pass: ["a*b*c"] }, true),
	c({ op: "passes", name: "acb", pass: ["a*b*c"] }, false),
	c({ op: "passes", name: "abc", pass: ["a*b*c"] }, true),
	c({ op: "passes", name: "ab", pass: ["a*b*b"] }, false),
	c({ op: "passes", name: "abb", pass: ["a*b*b"] }, true),
	c({ op: "passes", name: "aXbYb", pass: ["a*b*b"] }, true),
	// the middle part must end before the last part starts
	c({ op: "passes", name: "abcd", pass: ["a*bc*cd"] }, false),
	c({ op: "passes", name: "abcbcd", pass: ["a*bc*cd"] }, true),
	c({ op: "passes", name: "abcd", pass: ["a*b*cd"] }, true),
	c({ op: "passes", name: "abd", pass: ["a*b*bd"] }, false),
	c({ op: "passes", name: "abbd", pass: ["a*b*bd"] }, true),
	c({ op: "passes", name: "xaaay", pass: ["x*aa*aa*y"] }, false),
	c({ op: "passes", name: "xaaaay", pass: ["x*aa*aa*y"] }, true),
	c({ op: "passes", name: "xaaaaay", pass: ["x*aa*aa*y"] }, true),
	c({ op: "passes", name: "a*b", pass: ["a*b"] }, true),
	c({ op: "passes", name: "ab", pass: ["a**b"] }, true),
	c({ op: "passes", name: "日本語", pass: ["日*語"] }, true),
	c({ op: "passes", name: "日本語", pass: ["日*本*語"] }, true),
	c({ op: "passes", name: "日語", pass: ["日*本*語"] }, false),
	c({ op: "passes", name: "x😀y", pass: ["x*y"] }, true),
	c({ op: "passes", name: "a", pass: ["b", "*a"] }, true),
	c({ op: "passes", name: "a", pass: ["b", "c*"] }, false),
)

add(
	"member",
	"a union member's stem: its number, then words kept as written",
	c({ op: "member", n: 1 }, "1"),
	c({ op: "member", n: 1, words: "" }, "1"),
	c({ op: "member", n: 2, words: " second" }, "2 second"),
	c({ op: "member", n: 10, words: "x" }, "10x"),
	c({ op: "member", n: 3, words: " — ünï 日本" }, "3 — ünï 日本"),
	c({ op: "member", n: 123456789, words: "" }, "123456789"),
	c({ op: "member", n: 0, words: "a" }, "0a"),
	c({ op: "member", n: 9007199254740991, words: "" }, "9007199254740991"),
	c({ op: "member", n: 4, words: "\n\t" }, "4\n\t"),
)

add(
	"number",
	"the number a member's stem starts with and the words after it",
	c({ op: "number", stem: "1" }, [1, ""]),
	c({ op: "number", stem: "2 second" }, [2, " second"]),
	c({ op: "number", stem: "10x" }, [10, "x"]),
	c({ op: "number", stem: "007 bond" }, [7, " bond"]),
	c({ op: "number", stem: "0" }, [0, ""]),
	c({ op: "number", stem: "" }, NO),
	c({ op: "number", stem: "x1" }, NO),
	c({ op: "number", stem: " 1" }, NO),
	c({ op: "number", stem: "-1" }, NO),
	c({ op: "number", stem: "1.5" }, [1, ".5"]),
	c({ op: "number", stem: "1e3" }, [1, "e3"]),
	c({ op: "number", stem: "٣ three" }, NO),
	c({ op: "number", stem: "３" }, NO),
	c({ op: "number", stem: "12\n13" }, [12, "\n13"]),
	c({ op: "number", stem: "5 日本\n語" }, [5, " 日本\n語"]),
	c({ op: "number", stem: "9007199254740993" }),
	c({ op: "number", stem: "123456789012345678901234567890 big" }),
	c({ op: "number", stem: "1" + "0".repeat(400) }),
)

add(
	"take",
	"a new file's name: its slot read back, less a .text or .kind extension that gives its form",
	c({ op: "take", entry: "notes" }, { slot: "notes" }),
	c({ op: "take", entry: "notes.md" }, { slot: "notes.md" }),
	c({ op: "take", entry: "notes.txt" }, { slot: "notes.txt" }),
	c({ op: "take", entry: "notes.text" }, { slot: "notes", form: "cbor" }),
	c({ op: "take", entry: "notes.float32" }, { slot: "notes", form: "float32" }),
	c({ op: "take", entry: "notes.int8" }, { slot: "notes", form: "int8" }),
	// no uint8 kind: the extension stays in the slot
	c({ op: "take", entry: "notes.uint8" }, { slot: "notes.uint8" }),
	c({ op: "take", entry: "notes.int64" }, { slot: "notes", form: "int64" }),
	c({ op: "take", entry: "notes.Float32" }, { slot: "notes.Float32" }),
	c({ op: "take", entry: "notes.TEXT" }, { slot: "notes.TEXT" }),
	c({ op: "take", entry: "a:b.text" }, { slot: "a/b", form: "cbor" }),
	c({ op: "take", entry: "a：b.float64" }, { slot: "a:b", form: "float64" }),
	c({ op: "take", entry: ".text" }, { slot: ".text" }),
	c({ op: "take", entry: "a.b.float32" }, { slot: "a.b", form: "float32" }),
	c({ op: "take", entry: "日本.text" }, { slot: "日本", form: "cbor" }),
	c({ op: "take", entry: "" }, { slot: "" }),
	c({ op: "take", entry: "x.float128" }, { slot: "x.float128" }),
)

add(
	"renamed",
	"the slot a renamed entry gives",
	c({ op: "renamed", entry: "b", ext: "txt", folder: false }, "b"),
	c({ op: "renamed", entry: "b.txt", ext: "txt", folder: false }, "b"),
	c({ op: "renamed", entry: "b.md", ext: "txt", folder: false }, "b.md"),
	c({ op: "renamed", entry: "b.txt.txt", ext: "txt", folder: false }, "b.txt"),
	c({ op: "renamed", entry: "b.TXT", ext: "txt", folder: false }, "b.TXT"),
	c({ op: "renamed", entry: "b", folder: false }, "b"),
	c({ op: "renamed", entry: "b.txt", folder: false }, "b.txt"),
	c({ op: "renamed", entry: "b.txt", ext: "", folder: false }, "b.txt"),
	c({ op: "renamed", entry: "b", ext: "md", folder: true }, "b.md"),
	c({ op: "renamed", entry: "b.md", ext: "md", folder: true }, "b.md.md"),
	c({ op: "renamed", entry: "b", folder: true }, "b"),
	c({ op: "renamed", entry: "b", ext: "", folder: true }, "b"),
	c({ op: "renamed", entry: "a:b.txt", ext: "txt", folder: false }, "a/b"),
	c({ op: "renamed", entry: "a：b", ext: "md", folder: true }, "a:b.md"),
	c({ op: "renamed", entry: ".txt", ext: "txt", folder: false }, ".txt"),
	c({ op: "renamed", entry: "日本.png", ext: "png", folder: false }, "日本"),
	c({ op: "renamed", entry: "x.float32", ext: "float32", folder: false }, "x"),
	c({ op: "renamed", entry: "", ext: "txt", folder: false }, ""),
	c({ op: "renamed", entry: "", ext: "txt", folder: true }, ".txt"),
)

add(
	"percent",
	"an id as a URL segment: encodeURIComponent, with . as %2E",
	c({ op: "percent", id: "abc" }, "abc"),
	c({ op: "percent", id: "a.b" }, "a%2Eb"),
	c({ op: "percent", id: "." }, "%2E"),
	c({ op: "percent", id: ".." }, "%2E%2E"),
	c({ op: "percent", id: "" }, ""),
	c({ op: "percent", id: "a b" }, "a%20b"),
	c({ op: "percent", id: "a/b?c=d&e#f" }, "a%2Fb%3Fc%3Dd%26e%23f"),
	c({ op: "percent", id: "-_!~*'()" }, "-_!~*'()"),
	c({ op: "percent", id: "AZaz09" }, "AZaz09"),
	c({ op: "percent", id: "%" }, "%25"),
	c({ op: "percent", id: "%2E" }, "%252E"),
	c({ op: "percent", id: "+" }, "%2B"),
	c({ op: "percent", id: "@:;,$[]" }, "%40%3A%3B%2C%24%5B%5D"),
	c({ op: "percent", id: "é" }, "%C3%A9"),
	c({ op: "percent", id: "日本" }, "%E6%97%A5%E6%9C%AC"),
	c({ op: "percent", id: "😀" }, "%F0%9F%98%80"),
	c({ op: "percent", id: "\u0000" }, "%00"),
	c({ op: "percent", id: "a\u0000b" }, "a%00b"),
	c({ op: "percent", id: "\u007f" }, "%7F"),
	c({ op: "percent", id: "\n" }, "%0A"),
	c({ op: "percent", id: "�" }, "%EF%BF%BD"),
	c({ op: "percent", id: "￿" }, "%EF%BF%BF"),
	c({ op: "percent", id: "\u{10ffff}" }, "%F4%8F%BF%BF"),
	c({ op: "percent", id: "é" }, "e%CC%81"),
	c({ op: "percent", id: "abc.def.ghi" }, "abc%2Edef%2Eghi"),
	c({ op: "percent", id: "clockument://tx/1" }, "clockument%3A%2F%2Ftx%2F1"),
)

add(
	"percent-lone",
	"an id with a lone surrogate cannot be encoded",
	c({ op: "percent", id: "\ud800" }, { error: true }),
	c({ op: "percent", id: "\udc00" }, { error: true }),
	c({ op: "percent", id: "a\ud800b" }, { error: true }),
	c({ op: "percent", id: "\udc00\ud800" }, { error: true }),
	c({ op: "percent", id: "😀\ud83d" }, { error: true }),
	c({ op: "percent", id: "a.\ude00" }, { error: true }),
)

add(
	"unpercent",
	"a segment decoded; one that does not decode names itself",
	c({ op: "unpercent", segment: "abc" }, "abc"),
	c({ op: "unpercent", segment: "a%2Eb" }, "a.b"),
	c({ op: "unpercent", segment: "a%2eb" }, "a.b"),
	c({ op: "unpercent", segment: "%2E%2E" }, ".."),
	c({ op: "unpercent", segment: "" }, ""),
	c({ op: "unpercent", segment: "a%20b" }, "a b"),
	c({ op: "unpercent", segment: "a%2Fb%3Fc" }, "a/b?c"),
	c({ op: "unpercent", segment: "%C3%A9" }, "é"),
	c({ op: "unpercent", segment: "%c3%a9" }, "é"),
	c({ op: "unpercent", segment: "%E6%97%A5%E6%9C%AC" }, "日本"),
	c({ op: "unpercent", segment: "%F0%9F%98%80" }, "😀"),
	c({ op: "unpercent", segment: "%00" }, "\u0000"),
	c({ op: "unpercent", segment: "a%00b" }, "a\u0000b"),
	c({ op: "unpercent", segment: "%25" }, "%"),
	c({ op: "unpercent", segment: "%252E" }, "%2E"),
	c({ op: "unpercent", segment: "+" }, "+"),
	c({ op: "unpercent", segment: "日本" }, "日本"),
	c({ op: "unpercent", segment: "é%C3%A9" }, "éé"),
	c({ op: "unpercent", segment: "%F4%8F%BF%BF" }, "\u{10ffff}"),
	c({ op: "unpercent", segment: "%EF%BF%BD" }, "�"),
	c({ op: "unpercent", segment: "%7F" }, "\u007f"),
	c({ op: "unpercent", segment: "\ud800%41" }, "\ud800A"),
)

add(
	"unpercent-bad",
	"a segment that does not decode is returned as it is",
	c({ op: "unpercent", segment: "%" }, "%"),
	c({ op: "unpercent", segment: "%2" }, "%2"),
	c({ op: "unpercent", segment: "%zz" }, "%zz"),
	c({ op: "unpercent", segment: "%2G" }, "%2G"),
	c({ op: "unpercent", segment: "a%" }, "a%"),
	c({ op: "unpercent", segment: "ok%41%" }, "ok%41%"),
	c({ op: "unpercent", segment: "%80" }, "%80"),
	c({ op: "unpercent", segment: "%BF" }, "%BF"),
	c({ op: "unpercent", segment: "%C3" }, "%C3"),
	c({ op: "unpercent", segment: "%C3%" }, "%C3%"),
	c({ op: "unpercent", segment: "%C3%2" }, "%C3%2"),
	c({ op: "unpercent", segment: "%C3A" }, "%C3A"),
	c({ op: "unpercent", segment: "%C3%41" }, "%C3%41"),
	c({ op: "unpercent", segment: "%C3%C3" }, "%C3%C3"),
	c({ op: "unpercent", segment: "%E6%97" }, "%E6%97"),
	c({ op: "unpercent", segment: "%F0%9F%98" }, "%F0%9F%98"),
	// overlong
	c({ op: "unpercent", segment: "%C0%80" }, "%C0%80"),
	c({ op: "unpercent", segment: "%C1%BF" }, "%C1%BF"),
	c({ op: "unpercent", segment: "%E0%80%80" }, "%E0%80%80"),
	c({ op: "unpercent", segment: "%E0%9F%BF" }, "%E0%9F%BF"),
	c({ op: "unpercent", segment: "%F0%80%80%80" }, "%F0%80%80%80"),
	c({ op: "unpercent", segment: "%F0%8F%BF%BF" }, "%F0%8F%BF%BF"),
	// surrogates and past U+10FFFF
	c({ op: "unpercent", segment: "%ED%A0%80" }, "%ED%A0%80"),
	c({ op: "unpercent", segment: "%ED%BF%BF" }, "%ED%BF%BF"),
	c({ op: "unpercent", segment: "%ED%9F%BF" }, "퟿"),
	c({ op: "unpercent", segment: "%EE%80%80" }, ""),
	c({ op: "unpercent", segment: "%F4%90%80%80" }, "%F4%90%80%80"),
	c({ op: "unpercent", segment: "%F8%88%80%80%80" }, "%F8%88%80%80%80"),
	c({ op: "unpercent", segment: "%FF" }, "%FF"),
	c({ op: "unpercent", segment: "%FE%FE" }, "%FE%FE"),
	// one bad escape spoils the whole segment
	c({ op: "unpercent", segment: "%41%42%C3" }, "%41%42%C3"),
	c({ op: "unpercent", segment: "é%zz" }, "é%zz"),
)

add(
	"bycodepoint-bmp",
	"code point order against UTF-16 order: they differ for astral scalar values and U+E000 to U+FFFF",
	bycp("a", "b", -1),
	bycp("b", "a", 1),
	bycp("a", "a", 0),
	bycp("", "", 0),
	bycp("", "a", -1),
	bycp("a", "", 1),
	bycp("a", "ab", -1),
	bycp("ab", "a", 1),
	bycp("abc", "abd", -1),
	bycp("Z", "a", -1),
	bycp("é", "z", 1),
	bycp("日", "é", 1),
	bycp("\u0000", "a", -1),
	bycp("\u0000", "", 1),
	bycp("a\u0000", "a", 1),
	bycp("a\u0000", "a\u0001", -1),
	bycp("\u007f", "\u0080", -1),
	bycp("߿", "ࠀ", -1),
	bycp("퟿", "", -1),
	bycp("", "￿", -1),
	bycp("￿", "", 1),
)

add(
	"bycodepoint-astral",
	"an astral scalar value sorts after every BMP one, though its surrogates sort before U+E000",
	bycp("\u{10000}", "￿", 1),
	bycp("￿", "\u{10000}", -1),
	bycp("\u{10000}", "", 1),
	bycp("", "\u{10000}", -1),
	bycp("\u{10000}", "퟿", 1),
	bycp("😀", "～", 1),
	bycp("😀", "ｱ", 1),
	bycp("😀", "😁", -1),
	bycp("😁", "😀", 1),
	bycp("😀", "😀", 0),
	bycp("😀", "😀a", -1),
	bycp("😀a", "😀", 1),
	bycp("a😀", "a￿", 1),
	bycp("a😀", "ab", 1),
	bycp("\u{10000}", "\u{10ffff}", -1),
	bycp("\u{10ffff}", "\u{10000}", 1),
	bycp("\u{1f600}", "\u{1d7ff}", 1),
	bycp("\u{e0001}", "\u{1f600}", 1),
	bycp("\u{d7ff}\u{10000}", "\u{e000}", -1),
	bycp("𐐀", "𐐨", -1),
	bycp("日本", "日😀", -1),
)

add(
	"bycodepoint-lone",
	"a lone surrogate sorts as its UTF-16 unit: after U+E000 to U+FFFF",
	bycp("\ud800", "￿", 1),
	bycp("￿", "\ud800", -1),
	bycp("\ud800", "", 1),
	bycp("\ud800", "퟿", 1),
	bycp("\ud800", "\udc00", -1),
	bycp("\udc00", "\ud800", 1),
	bycp("\ud800", "\ud800", 0),
	bycp("\ud800", "a", 1),
	bycp("\udfff", "\udc00", 1),
	bycp("\ud800", "\u{10000}", -1),
	bycp("퟿", "\ud800", -1),
	bycp("a\ud800", "a", 1),
)

// the reference answers the requests; the hand answers must agree
async function ask(requests: Req[]): Promise<unknown[]> {
	const child = new Deno.Command("deno", {
		args: ["run", "--quiet", "--allow-env", `${here}harness.ts`],
		stdin: "piped",
		stdout: "piped",
	}).spawn()
	const output = child.output()
	const w = child.stdin.getWriter()
	await w.write(new TextEncoder().encode(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"))
	await w.close()
	const { stdout } = await output
	return new TextDecoder().decode(stdout).trim().split("\n").map((l) => JSON.parse(l))
}

const short = (v: unknown) =>
	JSON.stringify(v).replace(/(.)\1{20,}/g, (m, ch) => `${ch}x${m.length}`)

function Buffer(s: string): number[] {
	return [...new TextEncoder().encode(s)]
}

const all = scenarios.flatMap((s) => s.cases.map(([r]) => r))
const answers = await ask(all)
if (answers.length !== all.length) throw new Error("the reference died")
let at = 0, count = 0, hand = 0
await Deno.mkdir(out, { recursive: true })
for (const f of Deno.readDirSync(out)) {
	if (f.name.endsWith(".json")) Deno.removeSync(new URL(f.name, out))
}
for (const [i, s] of scenarios.entries()) {
	const expect: unknown[] = []
	for (const [req, want] of s.cases) {
		const got = answers[at++] as Record<string, unknown>
		if (want !== undefined) {
			hand++
			const w = typeof want === "object" && want !== null && "error" in want
			if (w ? !("error" in got) : JSON.stringify(got.result) !== JSON.stringify(want)) {
				throw new Error(
					`${s.name}: ${short(req)}: by hand ${short(want)}, the reference ${short(got)}`,
				)
			}
		}
		expect.push("error" in got ? { error: true } : got)
	}
	const file = `${String(i + 1).padStart(2, "0")}-${s.name}.json`
	await Deno.writeTextFile(
		new URL(file, out),
		JSON.stringify({ title: s.title, requests: s.cases.map(([r]) => r), expect }, null, "\t") +
			"\n",
	)
	count += s.cases.length
}
console.log(`${scenarios.length} scenarios, ${count} requests, ${hand} checked by hand`)
