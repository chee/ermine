// @ermine/render/tmpl's checks: a template makes what h makes, errors say the tag, a page renders
// the same both ways. LLM generated
// a check of how a template is written is deno-fmt-ignore: deno fmt rewrites a template tagged
// html (<x/> as <x />, and so on)
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
import html from "./tmpl.ts"

const prefix = "@ermine/render/tmpl: "

Deno.test("assertEquals sees a view's symbol key (the checks below rest on it)", () => {
	const view = h("b")
	assert(Object.getOwnPropertySymbols(view).length > 0)
	assertNotEquals(view, { ...view, [Object.getOwnPropertySymbols(view)[0]]: false })
})

// deno-fmt-ignore
Deno.test("plain elements: tags, text, nesting", () => {
	assertEquals(html`<div></div>`, h("div"))
	assertEquals(html`<div>hi</div>`, h("div", null, "hi"))
	assertEquals(
		html`<div class="a"><p>one</p><p>two <b>bold</b></p></div>`,
		h("div", { class: "a" }, h("p", null, "one"), h("p", null, "two ", h("b", null, "bold"))),
	)
	assertEquals(html`<x/>`, h("x"))
	assertEquals(html`<x />`, h("x"))
	assertEquals(html`<x a=1/>`, h("x", { a: "1" }))
	assertEquals(html`<my-element data-x="1"></my-element>`, h("my-element", { "data-x": "1" }))
})

// deno-fmt-ignore
Deno.test("attributes: quoted, single-quoted, bare-valued and bare", () => {
	assertEquals(
		html`<a href="x" id='y' target=z download></a>`,
		h("a", { href: "x", id: "y", target: "z", download: true }),
	)
	assertEquals(html`<a href=/some/path/>`, h("a", { href: "/some/path" }))
	assertEquals(html`<a title=""/>`, h("a", { title: "" }))
	assertEquals(html`<a b = "c" d/>`, h("a", { b: "c", d: true }))
	assertEquals(
		html`<a title="it's" alt='say "hi"'/>`,
		h("a", { title: "it's", alt: 'say "hi"' }),
	)
	assertEquals(
		html`<a b
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
	const view = html`
		<a b=${b} c=${call} d=${fn} e=${1} f=${style} g=${null} i=${undefined}
			j=${false}/>
	`
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
	const quoted = html`
		<a b="${b}" e='${1}' />
	` as View
	assertStrictEquals(quoted.props.b, b)
	assertStrictEquals(quoted.props.e, 1)
})

Deno.test("attributes: spreads go in order with the others, a later one wins", () => {
	const b = bind("/x")
	const spread = { x: 2, y: 3, onClick: b }
	const view = html`<a x=1 ...${spread} y=4 z=5/>` as View
	assertEquals(view, h("a", { x: 2, y: "4", onClick: b, z: "5" }))
	assertEquals(Object.keys(view.props), ["x", "y", "onClick", "z"])
	assertStrictEquals(view.props.onClick, b)
	assertEquals(html`<a ...${{ x: 1 }} x=2/>`, h("a", { x: "2" }))
	assertEquals(
		html`
			<a ...${null} ...${undefined} b />
		`,
		h("a", { b: true }),
	)
	assertEquals(
		html`
			<a ...${{ k: 1 }}...${{ l: 2 }} />
		`,
		h("a", { k: 1, l: 2 }),
	)
})

Deno.test("attributes: key is just a prop", () => {
	assertEquals(html`<li key=${"k"}>x</li>`, h("li", { key: "k" }, "x"))
	assertEquals((html`<li key=${7}>x</li>` as View).key, "7")
	assertEquals(html`<li key=k>x</li>`, h("li", { key: "k" }, "x"))
	assertEquals(html`<li ...${{ key: "s" }}>x</li>`, h("li", { key: "s" }, "x"))
})

Deno.test("attributes: text mixed with values is joined, strings and numbers only", () => {
	assertEquals(
		html`
			<a class="a ${"b"} c ${2}" id=x${1}y title='${"p"}${"q"}' />
		`,
		h("a", { class: "a b c 2", id: "x1y", title: "pq" }),
	)
	// a value is not decoded, nor its text trimmed
	assertEquals(
		html`
			<a title=" ${"&amp;"} " />
		`,
		h("a", { title: " &amp; " }),
	)
	const b = bind("/x")
	const call = handler("on/go")
	assertThrows(
		() =>
			html`
				<a class="a ${b}" />
			`,
		Error,
		`${prefix}class: `,
	)
	assertThrows(
		() =>
			html`
				<a class="a ${b}" />
			`,
		Error,
		"a bind",
	)
	assertThrows(
		() =>
			html`
				<a onClick="x ${call}" />
			`,
		Error,
		"onClick",
	)
	assertThrows(
		() =>
			html`
				<a onClick="x ${call}" />
			`,
		Error,
		"a handler",
	)
	assertThrows(
		() =>
			html`
				<a title="x ${null}" />
			`,
		Error,
		"title: ",
	)
	assertThrows(
		() =>
			html`
				<a title="${"x"}${{}}" />
			`,
		Error,
		"object",
	)
	assertThrows(() => html`<a title=x${true}/>`, Error, "boolean")
	assertThrows(() => html`<a title=x${[1]}/>`, Error, "title")
})

Deno.test("components: the tag is handed to h as it is", () => {
	const seen: unknown[] = []
	const C = (props: Record<string, unknown>): Child => {
		seen.push(props)
		return h("section", { n: props.a }, props.children as Child)
	}
	assertEquals(html`<${C} a=${1}>x<//>`, h(C, { a: 1 }, "x"))
	assertEquals(seen[0], seen[1])
	assertEquals(
		html`
			<${C} />
		`,
		h(C),
	)
	assertEquals(html`<${C} a=${1}/>`, h(C, { a: 1 }))
	assertEquals(
		html`
			<${C} a=${1}>
				</${C}>
		`,
		h(C, { a: 1 }),
	)
	assertEquals(html`<${C} a="x"><b>y</b>${"z"}</${C}>`, h(C, { a: "x" }, h("b", null, "y"), "z"))
	assertEquals(
		html`
			<${C} a=${1}>
				<${C} a=${2}>deep<//>tail<//>
		`,
		h(C, { a: 1 }, h(C, { a: 2 }, "deep"), "tail"),
	)
	// a view in a component's props is the very one
	const inner = h("i")
	const Hold = (props: { inner: View }): Child => props.inner
	assertStrictEquals(html`<${Hold} inner=${inner}/>`, inner)
	// whatever h does with a tag, even one that is no function or string
	const odd = { not: "a tag" } as unknown as string
	assertEquals(html`<${odd} a=1>x</${odd}>`, h(odd, { a: "1" }, "x"))
	assertEquals(html`<${"b"} a=1>x<//>`, h("b", { a: "1" }, "x"))
	// a component not closed by its own value
	const D = (): Child => null
	assertThrows(() => html`<${C}>x</${D}>`, Error, "C")
	assertThrows(() => html`<${C}>x</${D}>`, Error, "D")
})

// deno-fmt-ignore
Deno.test("closing: </div>, </${X}>, <//> and /> all close", () => {
	assertEquals(html`<a><b>x<//><//>`, h("a", null, h("b", null, "x")))
	assertEquals(html`<a><b>x</b></a>`, h("a", null, h("b", null, "x")))
	assertEquals(html`<a><b>x</b ></a >`, h("a", null, h("b", null, "x")))
	assertEquals(html`<a><b/><c/></a>`, h("a", null, h("b"), h("c")))
	const X = (): Child => "x"
	assertEquals(html`<a><${X}/><${X}></${X}><${X}><//></a>`, h("a", null, "x", "x", "x"))
})

// deno-fmt-ignore
Deno.test("void elements close themselves, with or without a slash", () => {
	assertEquals(
		html`<p>a<input type="text"><br>b<hr/><img src=x alt="">c</p>`,
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
	assertEquals(html`<input><input>`, [h("input"), h("input")])
	assertEquals(
		html`<div><link rel=a><meta name=b><wbr><col><area><base><embed><source><track></div>`,
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
	assertEquals(html`<input value=${1}>`, h("input", { value: 1 }))
	assertEquals(html`<input value=${1}/>`, h("input", { value: 1 }))
	// the others do not
	assertThrows(() => html`<div><span></div>`, Error, "<span>")
	// a void element has no closing tag
	assertThrows(() => html`<div><input></input></div>`, Error, "</input>")
})

// deno-fmt-ignore
Deno.test("comments are dropped", () => {
	assertEquals(html`<div><!-- a --><b/><!--b-->x<!-- ${1} --></div>`, h("div", null, h("b"), "x"))
	assertEquals(html`<!-- only -->`, [])
	assertEquals(html`<!-- a -->text<!-- b -->`, "text")
	assertEquals(
		html`<div>
			<!-- multi
			line <b> -->
			x
		</div>`,
		h("div", null, "x"),
	)
	assertEquals(html`<!---->x`, "x")
})

// deno-fmt-ignore
Deno.test("whitespace: a run with a newline is dropped at a text's ends, the rest stays", () => {
	assertEquals(
		html`
			<ul>
				<li>a</li>
				<li>b</li>
			</ul>
		`,
		h("ul", null, h("li", null, "a"), h("li", null, "b")),
	)
	assertEquals(html`<p> a </p>`, h("p", null, " a "))
	assertEquals(html`<p>  </p>`, h("p", null, "  "))
	assertEquals(html`<b>x</b> <i>y</i>`, [h("b", null, "x"), " ", h("i", null, "y")])
	assertEquals(
		html`<p>
			one
			two
		</p>`,
		h("p", null, "one\n\t\t\ttwo"),
	)
	assertEquals(html`<p>a  b</p>`, h("p", null, "a  b"))
	assertEquals(
		html`<p>a
		</p>`,
		h("p", null, "a"),
	)
	assertEquals(
		html`<p> a
		</p>`,
		h("p", null, " a"),
	)
	// each text between values on its own
	assertEquals(
		html`<p>
			a ${1}
			b ${2} c
		</p>`,
		h("p", null, "a ", 1, "b ", 2, " c"),
	)
	assertEquals(
		html`<p>${1}
			${2}</p>`,
		h("p", null, 1, 2),
	)
	assertEquals(html`<p>${1} ${2}</p>`, h("p", null, 1, " ", 2))
	assertEquals(
		html`
			hello
		`,
		"hello",
	)
	assertEquals(html`  hello  `, "  hello  ")
	// \n written in the template's text is a newline
	assertEquals(html`<p>\n a \n</p>`, h("p", null, "a"))
	// attributes keep theirs
	assertEquals(
		html`<a title="
			x
		"/>`,
		h("a", { title: "\n\t\t\tx\n\t\t" }),
	)
})

// deno-fmt-ignore
Deno.test("entities: numeric and the six named, in text and static attributes", () => {
	assertEquals(
		html`<p>&#60;&#x3c;&#x3C;&amp;&lt;&gt;&quot;&apos;&nbsp;</p>`,
		h("p", null, "<<<&<>\"'\u00a0"),
	)
	assertEquals(
		html`<p title="&lt;a&gt; &amp; &#34;b&#x22;" alt='&apos;&quot;'/>`,
		h("p", { title: '<a> & "b"', alt: "'\"" }),
	)
	assertEquals(html`<p title=a&amp;b/>`, h("p", { title: "a&b" }))
	// anything else stays as written
	assertEquals(
		html`<p>&copy; &bogus; &amp &#; &#x; &AMP; & &;</p>`,
		h("p", null, "&copy; &bogus; &amp &#; &#x; &AMP; & &;"),
	)
	// not a character: stays
	assertEquals(
		html`<p>&#xD800; &#1114112; &#99999999999999999999;</p>`,
		h("p", null, "&#xD800; &#1114112; &#99999999999999999999;"),
	)
	assertEquals(html`<p>&#x10FFFF; &#128512;</p>`, h("p", null, "\u{10FFFF} \u{1F600}"))
	// decoded once
	assertEquals(html`<p>&amp;lt; &amp;#60;</p>`, h("p", null, "&lt; &#60;"))
	// after the whitespace rule: &#10; is a newline kept
	assertEquals(html`<p>&#10;a&#10;</p>`, h("p", null, "\na\n"))
	// a value is never decoded
	assertEquals(html`<p>${"&amp;"}</p>`, h("p", null, "&amp;"))
	// a < is written &lt;
	assertEquals(html`<p>1 &lt; 2</p>`, h("p", null, "1 < 2"))
	assertThrows(() => html`<p>1 < 2</p>`, Error, "<")
})

Deno.test("roots: one is that view, several an array, text or a value is that", () => {
	assertEquals(
		html`
			<a />
		`,
		h("a"),
	)
	assertEquals(
		html`
			<a /><b />
		`,
		[h("a"), h("b")],
	)
	assertEquals(
		html`
			<a />
			<b />
		`,
		[h("a"), h("b")],
	)
	assertEquals(html`text`, "text")
	assertEquals(html`a <b>c</b> d`, ["a ", h("b", null, "c"), " d"])
	assertEquals(html`hello ${"you"}!`, ["hello ", "you", "!"])
	assertEquals(html``, [])
	assertEquals(
		html`
		`,
		[],
	)
	const b = bind("/x")
	assertStrictEquals(html`${b}`, b)
	assertEquals(html`${null}`, null)
	assertEquals(html`${1}`, 1)
	assertEquals(html`${1}${2}`, [1, 2])
	const list = [h("a"), h("b")]
	assertStrictEquals(html`${list}`, list)
})

Deno.test("kids: any child in a ${v}, as it is", () => {
	const b = bind("/x")
	const list = [h("li", null, "a"), "b"]
	const view = h("i")
	const lister = under("/rows", (row) => h("li", null, bind(row.at)))
	const tracked = track(() => 1)
	assertEquals(
		html`<div>${b}${list}${view}${"s"}${null}${undefined}${3}${false}${true}${lister}${tracked}</div>`,
		h("div", null, b, list, view, "s", null, undefined, 3, false, true, lister, tracked),
	)
	const made = html`<div>text ${b} ${list}</div>` as View
	const kids = made.kids[0] as readonly Child[]
	assertStrictEquals(kids[1], b)
	assertStrictEquals(kids[3], list)
	assertStrictEquals(((html`<div>${view}</div>` as View).kids[0] as readonly Child[])[0], view)
	const rows = ["a", "b", "c"]
	assertEquals(
		html`<ul>${rows.map((row) => html`<li>${row}</li>`)}</ul>`,
		h("ul", null, rows.map((row) => h("li", null, row))),
	)
})

// deno-fmt-ignore
Deno.test("errors: a tag closed by another, left open, closing nothing, or never finished", () => {
	assertThrows(() => html`<div></span>`, Error, `${prefix}</span> does not close <div>`)
	assertThrows(() => html`<div><b></div>`, Error, "</div> does not close <b>")
	assertThrows(() => html`<div><b></b>`, Error, `${prefix}<div> is never closed`)
	assertThrows(() => html`<ul><li>a`, Error, "<li> is never closed")
	assertThrows(() => html`<a></a></a>`, Error, "</a> closes nothing")
	assertThrows(() => html`</a>`, Error, "</a> closes nothing")
	assertThrows(() => html`<//>`, Error, "closes nothing")
	assertThrows(() => html`<div class="a"`, Error, "never finished")
	assertThrows(() => html`<div`, Error, "never finished")
	assertThrows(() => html`<!-- a`, Error, "comment")
	assertThrows(() => html`<div></>`, Error, "does not close <div>")
	const Card = function Card(): Child {
		return null
	}
	assertThrows(() => html`<${Card}>`, Error, "<Card> is never closed")
	assertThrows(() => html`<${Card}></div>`, Error, "</div> does not close <Card>")
	assertThrows(() => html`<div></${Card}>`, Error, "</Card> does not close <div>")
	assertThrows(() => html`<${Card}></${() => {}}>`, Error, "does not close <Card>")
	// nothing is cached from a throw: it throws again
	const again = () => html`<div></span>`
	assertThrows(again, Error, "</span>")
	assertThrows(again, Error, "</span>")
})

// deno-fmt-ignore
Deno.test("errors: what a tag cannot hold", () => {
	assertThrows(() => html`<a ${{}}/>`, Error, "a value in <a>")
	assertThrows(() => html`<a b${1}/>`, Error, "b in <a>")
	assertThrows(() => html`<a b=/>`, Error, "b in <a> has no value")
	assertThrows(() => html`<a b=>`, Error, "b in <a> has no value")
	assertThrows(() => html`<a =b/>`, Error, "=")
	assertThrows(() => html`<a "b"/>`, Error, '"')
	assertThrows(() => html`<a / b>`, Error, "/")
	assertThrows(() => html`<a${1}>`, Error, "<a>")
	assertThrows(() => html`<>x</>`, Error, "<")
	assertThrows(() => html`<!doctype html>`, Error, "<")
	assertThrows(() => html`</a${1}>`, Error, "closing tag")
	assertThrows(() => html`</${1}${2}>`, Error, "closing tag")
	assertThrows(() => html`<${1}></${1}/>`, Error, "/")
})

Deno.test("the cache: one call site gives equal views for its values, and is read once", () => {
	const row = (n: number, name: string) => html`<li class="row ${name}" n=${n}>${name}: ${n}</li>`
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
	assertEquals(html(strings, 1), h("b", null, 1))
	const first = reads
	assert(first > 0)
	assertEquals(html(strings, 2), h("b", null, 2))
	assertEquals(html(strings, 3), h("b", null, 3))
	assertEquals(reads, first)
})

// ---- a page, rendered both ways ----
const settled = () => new Promise((r) => setTimeout(r, 0))

// a counter bound to a node, a handler and a list: written with a template, and with h
const written = {
	template: (): Child =>
		html`
			<div id=app>
				<!-- the counter -->
				<button onClick=${handler("on/dec")}>−</button>
				<output class=${bind("count", (n: number) => n < 0 ? "below" : "")}>${bind(
					"count",
				)}</output>
				<button onClick=${handler("on/inc")}>+</button>
				<p class="clicks ${"big"}">clicks: ${bind("/shared/clicks")}</p>
				<input type=text value=${bind("count")}>
				<ul>
					${under("items", (item) =>
						html`<li key=${item.name}>
							${bind(item.at)}
							<button onClick=${handler("on/remove", [item.name])}>×</button>
						</li>`)}
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
	assert(page.includes(`data-ermine-bind:text="count"`))
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
