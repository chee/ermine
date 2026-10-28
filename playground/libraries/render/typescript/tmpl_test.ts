// @ermine/render/tmpl's checks: a template makes what h makes, errors say the tag, a page renders
// the same both ways. LLM generated
// the tag is imported as tmpl: deno fmt rewrites (whitespace and all) a template tagged html
import {
	assert,
	assertEquals,
	assertNotEquals,
	assertStrictEquals,
	assertThrows,
} from "@std/assert"
import { createAction, createErmine, ensureNode, patch, remove } from "@ermine/system"
import { bind, type Child, h, handler, track, under, type View } from "./h.ts"
import { createRoot, html as write, render, sent, take } from "./html.ts"
import tmpl from "./tmpl.ts"

const prefix = "@ermine/render/tmpl: "

Deno.test("assertEquals sees a view's symbol key (the checks below rest on it)", () => {
	const view = h("b")
	assert(Object.getOwnPropertySymbols(view).length > 0)
	assertNotEquals(view, { ...view, [Object.getOwnPropertySymbols(view)[0]]: false })
})

Deno.test("plain elements: tags, text, nesting", () => {
	assertEquals(tmpl`<div></div>`, h("div"))
	assertEquals(tmpl`<div>hi</div>`, h("div", null, "hi"))
	assertEquals(
		tmpl`<div class="a"><p>one</p><p>two <b>bold</b></p></div>`,
		h("div", { class: "a" }, h("p", null, "one"), h("p", null, "two ", h("b", null, "bold"))),
	)
	assertEquals(tmpl`<x/>`, h("x"))
	assertEquals(tmpl`<x />`, h("x"))
	assertEquals(tmpl`<x a=1/>`, h("x", { a: "1" }))
	assertEquals(tmpl`<my-element data-x="1"></my-element>`, h("my-element", { "data-x": "1" }))
})

Deno.test("attributes: quoted, single-quoted, bare-valued and bare", () => {
	assertEquals(
		tmpl`<a href="x" id='y' target=z download></a>`,
		h("a", { href: "x", id: "y", target: "z", download: true }),
	)
	assertEquals(tmpl`<a href=/some/path/>`, h("a", { href: "/some/path" }))
	assertEquals(tmpl`<a title=""/>`, h("a", { title: "" }))
	assertEquals(tmpl`<a b = "c" d/>`, h("a", { b: "c", d: true }))
	assertEquals(
		tmpl`<a title="it's" alt='say "hi"'/>`,
		h("a", { title: "it's", alt: 'say "hi"' }),
	)
	assertEquals(
		tmpl`<a b
			c="d"
		/>`,
		h("a", { b: true, c: "d" }),
	)
})

Deno.test("attributes: ${v} is v as it is, for any v", () => {
	const b = bind("/x")
	const call = handler("on/go", [1])
	const fn = () => {}
	const style = { color: "red" }
	const view =
		tmpl`<a b=${b} c=${call} d=${fn} e=${1} f=${style} g=${null} i=${undefined} j=${false}/>`
	assertEquals(
		view,
		h("a", { b, c: call, d: fn, e: 1, f: style, g: null, i: undefined, j: false }),
	)
	const { props } = view as View
	assertStrictEquals(props.b, b)
	assertStrictEquals(props.c, call)
	assertStrictEquals(props.d, fn)
	assertStrictEquals(props.f, style)
	// quotes round one value change nothing
	const quoted = tmpl`<a b="${b}" e='${1}'/>` as View
	assertStrictEquals(quoted.props.b, b)
	assertStrictEquals(quoted.props.e, 1)
})

Deno.test("attributes: spreads go in order with the others, a later one wins", () => {
	const b = bind("/x")
	const spread = { x: 2, y: 3, onClick: b }
	const view = tmpl`<a x=1 ...${spread} y=4 z=5/>` as View
	assertEquals(view, h("a", { x: 2, y: "4", onClick: b, z: "5" }))
	assertEquals(Object.keys(view.props), ["x", "y", "onClick", "z"])
	assertStrictEquals(view.props.onClick, b)
	assertEquals(tmpl`<a ...${{ x: 1 }} x=2/>`, h("a", { x: "2" }))
	assertEquals(tmpl`<a ...${null} ...${undefined} b/>`, h("a", { b: true }))
	assertEquals(tmpl`<a ...${{ k: 1 }}...${{ l: 2 }}/>`, h("a", { k: 1, l: 2 }))
})

Deno.test("attributes: key is just a prop", () => {
	assertEquals(tmpl`<li key=${"k"}>x</li>`, h("li", { key: "k" }, "x"))
	assertEquals((tmpl`<li key=${7}>x</li>` as View).key, "7")
	assertEquals(tmpl`<li key=k>x</li>`, h("li", { key: "k" }, "x"))
	assertEquals(tmpl`<li ...${{ key: "s" }}>x</li>`, h("li", { key: "s" }, "x"))
})

Deno.test("attributes: text mixed with values is joined, strings and numbers only", () => {
	assertEquals(
		tmpl`<a class="a ${"b"} c ${2}" id=x${1}y title='${"p"}${"q"}'/>`,
		h("a", { class: "a b c 2", id: "x1y", title: "pq" }),
	)
	// a value is not decoded, nor its text trimmed
	assertEquals(tmpl`<a title=" ${"&amp;"} "/>`, h("a", { title: " &amp; " }))
	const b = bind("/x")
	const call = handler("on/go")
	assertThrows(() => tmpl`<a class="a ${b}"/>`, Error, `${prefix}class: `)
	assertThrows(() => tmpl`<a class="a ${b}"/>`, Error, "a bind")
	assertThrows(() => tmpl`<a onClick="x ${call}"/>`, Error, "onClick")
	assertThrows(() => tmpl`<a onClick="x ${call}"/>`, Error, "a handler")
	assertThrows(() => tmpl`<a title="x ${null}"/>`, Error, "title: ")
	assertThrows(() => tmpl`<a title="${"x"}${{}}"/>`, Error, "object")
	assertThrows(() => tmpl`<a title=x${true}/>`, Error, "boolean")
	assertThrows(() => tmpl`<a title=x${[1]}/>`, Error, "title")
})

Deno.test("components: the tag is handed to h as it is", () => {
	const seen: unknown[] = []
	const C = (props: Record<string, unknown>): Child => {
		seen.push(props)
		return h("section", { n: props.a }, props.children as Child)
	}
	assertEquals(tmpl`<${C} a=${1}>x<//>`, h(C, { a: 1 }, "x"))
	assertEquals(seen[0], seen[1])
	assertEquals(tmpl`<${C}/>`, h(C))
	assertEquals(tmpl`<${C} a=${1}/>`, h(C, { a: 1 }))
	assertEquals(tmpl`<${C} a=${1}></${C}>`, h(C, { a: 1 }))
	assertEquals(tmpl`<${C} a="x"><b>y</b>${"z"}</${C}>`, h(C, { a: "x" }, h("b", null, "y"), "z"))
	assertEquals(
		tmpl`<${C} a=${1}><${C} a=${2}>deep<//>tail<//>`,
		h(C, { a: 1 }, h(C, { a: 2 }, "deep"), "tail"),
	)
	// a view in a component's props is the very one
	const inner = h("i")
	const Hold = (props: { inner: View }): Child => props.inner
	assertStrictEquals(tmpl`<${Hold} inner=${inner}/>`, inner)
	// whatever h does with a tag, even one that is no function or string
	const odd = { not: "a tag" } as unknown as string
	assertEquals(tmpl`<${odd} a=1>x</${odd}>`, h(odd, { a: "1" }, "x"))
	assertEquals(tmpl`<${"b"} a=1>x<//>`, h("b", { a: "1" }, "x"))
	// a component not closed by its own value
	const D = (): Child => null
	assertThrows(() => tmpl`<${C}>x</${D}>`, Error, "C")
	assertThrows(() => tmpl`<${C}>x</${D}>`, Error, "D")
})

Deno.test("closing: </div>, </${X}>, <//> and /> all close", () => {
	assertEquals(tmpl`<a><b>x<//><//>`, h("a", null, h("b", null, "x")))
	assertEquals(tmpl`<a><b>x</b></a>`, h("a", null, h("b", null, "x")))
	assertEquals(tmpl`<a><b>x</b ></a >`, h("a", null, h("b", null, "x")))
	assertEquals(tmpl`<a><b/><c/></a>`, h("a", null, h("b"), h("c")))
	const X = (): Child => "x"
	assertEquals(tmpl`<a><${X}/><${X}></${X}><${X}><//></a>`, h("a", null, "x", "x", "x"))
})

Deno.test("void elements close themselves, with or without a slash", () => {
	assertEquals(
		tmpl`<p>a<input type="text"><br>b<hr/><img src=x alt="">c</p>`,
		h(
			"p",
			null,
			"a",
			h("input", { type: "text" }),
			h("br"),
			"b",
			h("hr"),
			h("img", { src: "x", alt: "" }),
			"c",
		),
	)
	assertEquals(tmpl`<input><input>`, [h("input"), h("input")])
	assertEquals(
		tmpl`<div><link rel=a><meta name=b><wbr><col><area><base><embed><source><track></div>`,
		h(
			"div",
			null,
			h("link", { rel: "a" }),
			h("meta", { name: "b" }),
			h("wbr"),
			h("col"),
			h("area"),
			h("base"),
			h("embed"),
			h("source"),
			h("track"),
		),
	)
	assertEquals(tmpl`<input value=${1}>`, h("input", { value: 1 }))
	assertEquals(tmpl`<input value=${1}/>`, h("input", { value: 1 }))
	// the others do not
	assertThrows(() => tmpl`<div><span></div>`, Error, "<span>")
	// a void element has no closing tag
	assertThrows(() => tmpl`<div><input></input></div>`, Error, "</input>")
})

Deno.test("comments are dropped", () => {
	assertEquals(tmpl`<div><!-- a --><b/><!--b-->x<!-- ${1} --></div>`, h("div", null, h("b"), "x"))
	assertEquals(tmpl`<!-- only -->`, [])
	assertEquals(tmpl`<!-- a -->text<!-- b -->`, "text")
	assertEquals(
		tmpl`<div>
			<!-- multi
			line <b> -->
			x
		</div>`,
		h("div", null, "x"),
	)
	assertEquals(tmpl`<!---->x`, "x")
})

Deno.test("whitespace: a run with a newline is dropped at a text's ends, the rest stays", () => {
	assertEquals(
		tmpl`
			<ul>
				<li>a</li>
				<li>b</li>
			</ul>
		`,
		h("ul", null, h("li", null, "a"), h("li", null, "b")),
	)
	assertEquals(tmpl`<p> a </p>`, h("p", null, " a "))
	assertEquals(tmpl`<p>  </p>`, h("p", null, "  "))
	assertEquals(tmpl`<b>x</b> <i>y</i>`, [h("b", null, "x"), " ", h("i", null, "y")])
	assertEquals(
		tmpl`<p>
			one
			two
		</p>`,
		h("p", null, "one\n\t\t\ttwo"),
	)
	assertEquals(tmpl`<p>a  b</p>`, h("p", null, "a  b"))
	assertEquals(
		tmpl`<p>a
		</p>`,
		h("p", null, "a"),
	)
	assertEquals(
		tmpl`<p> a
		</p>`,
		h("p", null, " a"),
	)
	// each text between values on its own
	assertEquals(
		tmpl`<p>
			a ${1}
			b ${2} c
		</p>`,
		h("p", null, "a ", 1, "b ", 2, " c"),
	)
	assertEquals(
		tmpl`<p>${1}
			${2}</p>`,
		h("p", null, 1, 2),
	)
	assertEquals(tmpl`<p>${1} ${2}</p>`, h("p", null, 1, " ", 2))
	assertEquals(
		tmpl`
			hello
		`,
		"hello",
	)
	assertEquals(tmpl`  hello  `, "  hello  ")
	// \n written in the template's text is a newline
	assertEquals(tmpl`<p>\n a \n</p>`, h("p", null, "a"))
	// attributes keep theirs
	assertEquals(
		tmpl`<a title="
			x
		"/>`,
		h("a", { title: "\n\t\t\tx\n\t\t" }),
	)
})

Deno.test("entities: numeric and the six named, in text and static attributes", () => {
	assertEquals(
		tmpl`<p>&#60;&#x3c;&#x3C;&amp;&lt;&gt;&quot;&apos;&nbsp;</p>`,
		h("p", null, "<<<&<>\"'\u00a0"),
	)
	assertEquals(
		tmpl`<p title="&lt;a&gt; &amp; &#34;b&#x22;" alt='&apos;&quot;'/>`,
		h("p", { title: '<a> & "b"', alt: "'\"" }),
	)
	assertEquals(tmpl`<p title=a&amp;b/>`, h("p", { title: "a&b" }))
	// anything else stays as written
	assertEquals(
		tmpl`<p>&copy; &bogus; &amp &#; &#x; &AMP; & &;</p>`,
		h("p", null, "&copy; &bogus; &amp &#; &#x; &AMP; & &;"),
	)
	// not a character: stays
	assertEquals(
		tmpl`<p>&#xD800; &#1114112; &#99999999999999999999;</p>`,
		h("p", null, "&#xD800; &#1114112; &#99999999999999999999;"),
	)
	assertEquals(tmpl`<p>&#x10FFFF; &#128512;</p>`, h("p", null, "\u{10FFFF} \u{1F600}"))
	// decoded once
	assertEquals(tmpl`<p>&amp;lt; &amp;#60;</p>`, h("p", null, "&lt; &#60;"))
	// after the whitespace rule: &#10; is a newline kept
	assertEquals(tmpl`<p>&#10;a&#10;</p>`, h("p", null, "\na\n"))
	// a value is never decoded
	assertEquals(tmpl`<p>${"&amp;"}</p>`, h("p", null, "&amp;"))
	// a < is written &lt;
	assertEquals(tmpl`<p>1 &lt; 2</p>`, h("p", null, "1 < 2"))
	assertThrows(() => tmpl`<p>1 < 2</p>`, Error, "<")
})

Deno.test("roots: one is that view, several an array, text or a value is that", () => {
	assertEquals(tmpl`<a/>`, h("a"))
	assertEquals(tmpl`<a/><b/>`, [h("a"), h("b")])
	assertEquals(
		tmpl`
			<a/>
			<b/>
		`,
		[h("a"), h("b")],
	)
	assertEquals(tmpl`text`, "text")
	assertEquals(tmpl`a <b>c</b> d`, ["a ", h("b", null, "c"), " d"])
	assertEquals(tmpl`hello ${"you"}!`, ["hello ", "you", "!"])
	assertEquals(tmpl``, [])
	assertEquals(
		tmpl`
		`,
		[],
	)
	const b = bind("/x")
	assertStrictEquals(tmpl`${b}`, b)
	assertEquals(tmpl`${null}`, null)
	assertEquals(tmpl`${1}`, 1)
	assertEquals(tmpl`${1}${2}`, [1, 2])
	const list = [h("a"), h("b")]
	assertStrictEquals(tmpl`${list}`, list)
})

Deno.test("kids: any child in a ${v}, as it is", () => {
	const b = bind("/x")
	const list = [h("li", null, "a"), "b"]
	const view = h("i")
	const lister = under("/rows", (row) => h("li", null, bind(row.at)))
	const tracked = track(() => 1)
	assertEquals(
		tmpl`<div>${b}${list}${view}${"s"}${null}${undefined}${3}${false}${true}${lister}${tracked}</div>`,
		h("div", null, b, list, view, "s", null, undefined, 3, false, true, lister, tracked),
	)
	const made = tmpl`<div>text ${b} ${list}</div>` as View
	const kids = made.kids[0] as readonly Child[]
	assertStrictEquals(kids[1], b)
	assertStrictEquals(kids[3], list)
	assertStrictEquals(((tmpl`<div>${view}</div>` as View).kids[0] as readonly Child[])[0], view)
	const rows = ["a", "b", "c"]
	assertEquals(
		tmpl`<ul>${rows.map((row) => tmpl`<li>${row}</li>`)}</ul>`,
		h("ul", null, rows.map((row) => h("li", null, row))),
	)
})

Deno.test("errors: a tag closed by another, left open, closing nothing, or never finished", () => {
	assertThrows(() => tmpl`<div></span>`, Error, `${prefix}</span> does not close <div>`)
	assertThrows(() => tmpl`<div><b></div>`, Error, "</div> does not close <b>")
	assertThrows(() => tmpl`<div><b></b>`, Error, `${prefix}<div> is never closed`)
	assertThrows(() => tmpl`<ul><li>a`, Error, "<li> is never closed")
	assertThrows(() => tmpl`<a></a></a>`, Error, "</a> closes nothing")
	assertThrows(() => tmpl`</a>`, Error, "</a> closes nothing")
	assertThrows(() => tmpl`<//>`, Error, "closes nothing")
	assertThrows(() => tmpl`<div class="a"`, Error, "never finished")
	assertThrows(() => tmpl`<div`, Error, "never finished")
	assertThrows(() => tmpl`<!-- a`, Error, "comment")
	assertThrows(() => tmpl`<div></>`, Error, "does not close <div>")
	const Card = function Card(): Child {
		return null
	}
	assertThrows(() => tmpl`<${Card}>`, Error, "<Card> is never closed")
	assertThrows(() => tmpl`<${Card}></div>`, Error, "</div> does not close <Card>")
	assertThrows(() => tmpl`<div></${Card}>`, Error, "</Card> does not close <div>")
	assertThrows(() => tmpl`<${Card}></${() => {}}>`, Error, "does not close <Card>")
	// nothing is cached from a throw: it throws again
	const again = () => tmpl`<div></span>`
	assertThrows(again, Error, "</span>")
	assertThrows(again, Error, "</span>")
})

Deno.test("errors: what a tag cannot hold", () => {
	assertThrows(() => tmpl`<a ${{}}/>`, Error, "a value in <a>")
	assertThrows(() => tmpl`<a b${1}/>`, Error, "b in <a>")
	assertThrows(() => tmpl`<a b=/>`, Error, "b in <a> has no value")
	assertThrows(() => tmpl`<a b=>`, Error, "b in <a> has no value")
	assertThrows(() => tmpl`<a =b/>`, Error, "=")
	assertThrows(() => tmpl`<a "b"/>`, Error, '"')
	assertThrows(() => tmpl`<a / b>`, Error, "/")
	assertThrows(() => tmpl`<a${1}>`, Error, "<a>")
	assertThrows(() => tmpl`<>x</>`, Error, "<")
	assertThrows(() => tmpl`<!doctype html>`, Error, "<")
	assertThrows(() => tmpl`</a${1}>`, Error, "closing tag")
	assertThrows(() => tmpl`</${1}${2}>`, Error, "closing tag")
	assertThrows(() => tmpl`<${1}></${1}/>`, Error, "/")
})

Deno.test("the cache: one call site gives equal views for its values, and is read once", () => {
	const row = (n: number, name: string) => tmpl`<li class="row ${name}" n=${n}>${name}: ${n}</li>`
	assertEquals(row(1, "a"), h("li", { class: "row a", n: 1 }, "a", ": ", 1))
	assertEquals(row(2, "b"), h("li", { class: "row b", n: 2 }, "b", ": ", 2))
	assertEquals(row(1, "a"), row(1, "a"))
	// views are made new from the values each call
	assertNotEquals(row(1, "a"), row(1, "b"))
	// a template's strings are read on the first call only
	let reads = 0
	const strings = new Proxy(Object.assign(["<b>", "</b>"], { raw: ["<b>", "</b>"] }), {
		get(target, key, receiver) {
			reads++
			return Reflect.get(target, key, receiver)
		},
	}) as unknown as TemplateStringsArray
	assertEquals(tmpl(strings, 1), h("b", null, 1))
	const first = reads
	assert(first > 0)
	assertEquals(tmpl(strings, 2), h("b", null, 2))
	assertEquals(tmpl(strings, 3), h("b", null, 3))
	assertEquals(reads, first)
})

// ---- a page, rendered both ways ----
const settled = () => new Promise((r) => setTimeout(r, 0))

// a counter bound to a node, a handler and a list: written with a template, and with h
const written = {
	template: (): Child =>
		tmpl`
			<div id=app>
				<!-- the counter -->
				<button onClick=${handler("on/dec")}>−</button>
				<output class=${bind("count", (n: number) => n < 0 ? "below" : "")}>${
			bind("count")
		}</output>
				<button onClick=${handler("on/inc")}>+</button>
				<p class="clicks ${"big"}">clicks: ${bind("/shared/clicks")}</p>
				<input type=text value=${bind("count")}>
				<ul>
					${
			under("items", (item) =>
				tmpl`<li key=${item.name}>
							${bind(item.at)}
							<button onClick=${handler("on/remove", [item.name])}>×</button>
						</li>`)
		}
				</ul>
			</div>
		`,
	h: (): Child =>
		h(
			"div",
			{ id: "app" },
			h("button", { onClick: handler("on/dec") }, "−"),
			h("output", { class: bind("count", (n: number) => n < 0 ? "below" : "") }, bind("count")),
			h("button", { onClick: handler("on/inc") }, "+"),
			h("p", { class: "clicks big" }, "clicks: ", bind("/shared/clicks")),
			h("input", { type: "text", value: bind("count") }),
			h(
				"ul",
				null,
				under("items", (item) =>
					h(
						"li",
						{ key: item.name },
						bind(item.at),
						h("button", { onClick: handler("on/remove", [item.name]) }, "×"),
					)),
			),
		),
}

function visitor(view: () => Child) {
	const ermine = createErmine({
		host: { setup: () => void ensureNode("/shared/clicks", 0) },
	})
	const into = createRoot()
	const started = ermine.start(function p() {
		ensureNode("count", 0)
		ensureNode("items")
		ensureNode("items/apple", "apple")
		createAction("on/inc", () => {})
		createAction("on/dec", () => {})
		createAction("on/remove", (name: string) => remove(`items/${name}`))
		render(into, view(), { name: "/p", call: () => {} })
	}, "/p")
	if ("refused" in started) throw new Error(started.refused)
	ermine.within(() => {})
	sent(into)
	const set = (path: string, value: unknown) =>
		ermine.within(() => patch(path, [{ path: [], value }]))
	return { ermine, into, set }
}

Deno.test("a page: the html from a template is the html from h, and so are its updates", async () => {
	const a = visitor(written.template)
	const b = visitor(written.h)
	const page = write(a.into)
	assertEquals(page, write(b.into))
	assert(page.includes(`data-ermine-bind:text="/p/count"`))
	assert(page.includes(`<input type="text"`))
	assert(page.includes(`>apple<`))
	for (const v of [a, b]) {
		v.set("/p/count", -1)
		v.set("/shared/clicks", 4)
		v.ermine.within(() => ensureNode("/p/items/pear", "pear"))
	}
	await settled()
	const told = take(a.into)
	assert(told.length >= 3)
	assertEquals(told, take(b.into))
	assertEquals(write(a.into), write(b.into))
	a.ermine.close()
	b.ermine.close()
})
