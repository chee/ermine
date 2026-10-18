// the tasks: each says what to make, gives data the model sees and data it does not, and checks the result by running it

import { bluish, type Drawing, sameColor } from "./canvas.ts"

export type Check = { name: string; ok: boolean; required?: boolean }

export type Page = {
	window: any
	root: any
	outlet: unknown[]
	drawings: Drawing[]
	errors: string[]
	click(el: any): Promise<void>
	type(el: any, text: string): Promise<void>
	settle(): Promise<void>
}

type Tables = Record<string, Record<string, unknown>[]>
type Shape = "scalar" | "strings" | "pairs"

export type DataTask = {
	id: string
	kind: "data"
	ask: string
	data: Tables
	hidden: Tables
	shape: Shape
	answer(data: Tables): unknown
}
export type ViewTask = {
	id: string
	kind: "ui" | "canvas" | "compound"
	ask: string
	data?: unknown
	hidden?: unknown
	check(page: Page, data: any): Promise<Check[]>
}
export type Task = DataTask | ViewTask

const orders = [
	{ id: 1, customer: "Ada", category: "food", amount: 12.5, status: "paid" },
	{ id: 2, customer: "Grace", category: "books", amount: 30, status: "unpaid" },
	{ id: 3, customer: "Linus", category: "food", amount: 7.25, status: "paid" },
	{ id: 4, customer: "Ada", category: "toys", amount: 18, status: "paid" },
	{
		id: 5,
		customer: "Margaret",
		category: "books",
		amount: 22,
		status: "paid",
	},
	{ id: 6, customer: "Linus", category: "toys", amount: 5.5, status: "unpaid" },
	{ id: 7, customer: "Grace", category: "food", amount: 9, status: "unpaid" },
]
const ordersHidden = [
	{ id: 1, customer: "Bo", category: "garden", amount: 40, status: "paid" },
	{ id: 2, customer: "Cy", category: "food", amount: 3.5, status: "unpaid" },
	{ id: 3, customer: "Di", category: "garden", amount: 11, status: "unpaid" },
	{ id: 4, customer: "Ed", category: "music", amount: 25, status: "paid" },
	{ id: 5, customer: "Bo", category: "food", amount: 6, status: "paid" },
	{
		id: 6,
		customer: "Fay",
		category: "music",
		amount: 14.75,
		status: "unpaid",
	},
]
const products = [
	{ name: "lamp", price: 24.5, stock: 3 },
	{ name: "chair", price: 89, stock: 1 },
	{ name: "mug", price: 6.75, stock: 20 },
	{ name: "desk", price: 150, stock: 2 },
	{ name: "pen", price: 1.2, stock: 100 },
	{ name: "rug", price: 60, stock: 4 },
]
const productsHidden = [
	{ name: "kettle", price: 31, stock: 5 },
	{ name: "spoon", price: 2.5, stock: 50 },
	{ name: "sofa", price: 420, stock: 1 },
	{ name: "plant", price: 18.9, stock: 7 },
	{ name: "clock", price: 45, stock: 2 },
]

const byTotal = (rows: typeof orders) => {
	const totals = new Map<string, number>()
	for (const o of rows) {
		totals.set(o.category, (totals.get(o.category) ?? 0) + o.amount)
	}
	return [...totals].sort((a, b) => b[1] - a[1])
}

export const dataTasks: DataTask[] = [
	{
		id: "join-names",
		kind: "data",
		ask:
			`Make one string of all the names in table \`people\`, in table order, separated by ", " except the last two, which are joined by " and ". For three names: "Ann, Bob and Cy".`,
		data: {
			people: [{ name: "Ada", age: 36 }, { name: "Grace", age: 85 }, {
				name: "Linus",
				age: 54,
			}, { name: "Margaret", age: 37 }],
		},
		hidden: {
			people: [{ name: "Tom", age: 20 }, { name: "Uma", age: 31 }, {
				name: "Vic",
				age: 44,
			}],
		},
		shape: "scalar",
		answer: (d) => {
			const n = d.people.map((p) => p.name as string)
			return n.length < 2 ? n.join("") : n.slice(0, -1).join(", ") + " and " + n.at(-1)
		},
	},
	{
		id: "sum-paid",
		kind: "data",
		ask: `What is the total \`amount\` of the orders in table \`orders\` whose status is "paid"?`,
		data: { orders },
		hidden: { orders: ordersHidden },
		shape: "scalar",
		answer: (d) =>
			d.orders.filter((o) => o.status == "paid").reduce(
				(s, o) => s + (o.amount as number),
				0,
			),
	},
	{
		id: "by-category",
		kind: "data",
		ask: `Total \`amount\` per category in table \`orders\`, largest total first. Return a list of {category, total}.`,
		data: { orders },
		hidden: { orders: ordersHidden },
		shape: "pairs",
		answer: (d) => byTotal(d.orders as typeof orders),
	},
	{
		id: "top-3",
		kind: "data",
		ask: `The names of the 3 most expensive products in table \`products\`, most expensive first. Return a list of names.`,
		data: { products },
		hidden: { products: productsHidden },
		shape: "strings",
		answer: (d) =>
			[...d.products].sort((a, b) => (b.price as number) - (a.price as number))
				.slice(0, 3).map((p) => p.name),
	},
	{
		id: "format-people",
		kind: "data",
		ask:
			`For each row of table \`people\` make the string "Last, First (age)", like "Hopper, Grace (85)". Sort by last name A to Z. Return a list of strings.`,
		data: {
			people: [
				{ first: "Grace", last: "Hopper", age: 85 },
				{ first: "Ada", last: "Lovelace", age: 36 },
				{ first: "Alan", last: "Turing", age: 41 },
				{ first: "Margaret", last: "Hamilton", age: 37 },
			],
		},
		hidden: {
			people: [
				{ first: "Zed", last: "Young", age: 22 },
				{ first: "Amy", last: "Baker", age: 60 },
				{ first: "Kim", last: "Moss", age: 33 },
			],
		},
		shape: "strings",
		answer: (d) =>
			[...d.people].sort((a, b) => String(a.last).localeCompare(String(b.last)))
				.map((p) => `${p.last}, ${p.first} (${p.age})`),
	},
	{
		id: "count-fish",
		kind: "data",
		ask: `How many rows of table \`notes\` have a \`text\` that mentions "fish", in any case?`,
		data: {
			notes: [
				{ id: 1, text: "Fed the fish today" },
				{ id: 2, text: "Buy milk" },
				{ id: 3, text: "FISH tank needs cleaning" },
				{ id: 4, text: "call mum" },
				{ id: 5, text: "the goldfish looks happy" },
			],
		},
		hidden: {
			notes: [
				{ id: 1, text: "nothing" },
				{ id: 2, text: "Fish and chips" },
				{ id: 3, text: "fishing trip" },
				{ id: 4, text: "dog walk" },
			],
		},
		shape: "scalar",
		answer: (d) => d.notes.filter((n) => /fish/i.test(String(n.text))).length,
	},
]

// comparing a data answer, as the JS function returned it or as SQL rows

const near = (a: unknown, b: unknown) => {
	if (typeof b == "number") return Math.abs(Number(a) - b) < 0.011
	return String(a).trim() == String(b).trim()
}

export function compare(
	shape: Shape,
	got: unknown,
	want: unknown,
	sql: boolean,
): boolean {
	if (sql) {
		const rows = got as Record<string, unknown>[]
		if (!Array.isArray(rows) || !rows.length) return false
		const values = rows.map((r) => Object.values(r))
		if (shape == "scalar") return rows.length == 1 && near(values[0][0], want)
		if (shape == "strings") {
			const w = want as string[]
			return values.length == w.length &&
				values.every((v, i) => near(v[0], w[i]))
		}
		const w = want as [string, number][]
		return values.length == w.length &&
			values.every((v, i) => v.length >= 2 && near(v[0], w[i][0]) && near(v[1], w[i][1]))
	}
	if (shape == "scalar") {
		if (Array.isArray(got) && got.length == 1) got = got[0]
		return got != null && typeof got != "object" && near(got, want)
	}
	if (shape == "strings") {
		const w = want as string[]
		return Array.isArray(got) && got.length == w.length &&
			got.every((v, i) => near(v, w[i]))
	}
	const w = want as [string, number][]
	let pairs: unknown[][] | undefined
	if (Array.isArray(got)) {
		pairs = got.map((
			r,
		) => (Array.isArray(r) ? r : r && typeof r == "object" ? Object.values(r) : [r]))
	} else if (got && typeof got == "object") pairs = Object.entries(got)
	return !!pairs && pairs.length == w.length &&
		pairs.every((v, i) => near(v[0], w[i][0]) && near(v[1], w[i][1]))
}

// looking at a page

const textOf = (el: any) => (el?.textContent ?? "").replace(/\s+/g, " ").trim()
const shown = (el: any, window: any) => {
	for (let e = el; e && e.nodeType == 1; e = e.parentElement) {
		if (
			e.hidden || window.getComputedStyle(e).display == "none" ||
			e.style.visibility == "hidden"
		) return false
	}
	return true
}
const all = (page: Page, selector: string) => [...page.window.document.querySelectorAll(selector)] as any[]
const buttonLike = (page: Page) =>
	all(
		page,
		"button, input[type=button], input[type=submit], [onclick], [role=button]",
	).filter((b) => shown(b, page.window))
const findButton = (page: Page, word?: RegExp) => {
	const buttons = buttonLike(page)
	return (word && buttons.find((b) => word.test(textOf(b) || b.value || ""))) ??
		buttons[0]
}
const lastOut = (page: Page) => page.outlet.at(-1)
const pageText = (page: Page) => {
	const body = page.window.document.body.cloneNode(true)
	for (const s of body.querySelectorAll("script, style")) s.remove()
	return textOf(body)
}

// a run of n elements, in page order, whose sizes are the values times one scale
function proportional(sizes: number[], values: number[]) {
	const n = values.length
	for (let start = 0; start < sizes.length; start++) {
		if (!(sizes[start] > 0)) continue
		const k = sizes[start] / values[0]
		let i = 1
		for (let j = start + 1; j < sizes.length && i < n; j++) {
			if (
				Math.abs(sizes[j] - k * values[i]) <=
					Math.max(1.5, 0.08 * k * values[i])
			) i++
		}
		if (i == n) return true
	}
	return false
}

const cssSize = (v: string) => {
	const m = String(v ?? "").match(/^([\d.]+)(px|%|em|rem|vh)?$/)
	return m ? +m[1] : NaN
}
function domBars(page: Page, values: number[]) {
	const els = all(page, "*").filter((e) => !["HTML", "BODY", "SCRIPT", "STYLE"].includes(e.tagName))
	const height = els.map((e) => cssSize(e.style?.height) || cssSize(e.getAttribute?.("height")))
	const width = els.map((e) => cssSize(e.style?.width) || cssSize(e.getAttribute?.("width")))
	const filled = (s: number[]) => s.filter((v) => v > 0)
	return proportional(filled(height), values) ||
		proportional(filled(width), values)
}

function canvasBars(page: Page, values: number[]) {
	for (const d of page.drawings) {
		const area = d.width * d.height
		const boxes = d.shapes.filter((s) => s.kind == "fill").map((s) => s.box)
			.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) < 0.5 * area)
		if (
			proportional(boxes.map((b) => b.y1 - b.y0), values) ||
			proportional(boxes.map((b) => b.x1 - b.x0), values)
		) return true
	}
	return false
}
const canvasTexts = (page: Page) => page.drawings.flatMap((d) => d.texts.map((t) => t.text)).join(" ")

const fish = {
	fish: [
		{ x: 80, y: 90, color: "#ff7f50", size: 40 },
		{ x: 250, y: 160, color: "#ffd700", size: 30 },
		{ x: 160, y: 230, color: "#ff69b4", size: 50 },
	],
}
const fishHidden = {
	fish: [
		{ x: 320, y: 60, color: "#7fff00", size: 36 },
		{ x: 60, y: 200, color: "#ff4500", size: 44 },
		{ x: 200, y: 120, color: "#da70d6", size: 28 },
		{ x: 300, y: 250, color: "#ffffff", size: 32 },
	],
}
const bars = [{ label: "mon", value: 4 }, { label: "tue", value: 7 }, {
	label: "wed",
	value: 2,
}, { label: "thu", value: 5 }]
const barsHidden = [{ label: "jan", value: 10 }, { label: "feb", value: 3 }, {
	label: "mar",
	value: 8,
}]

export const viewTasks: ViewTask[] = [
	{
		id: "counter",
		kind: "ui",
		ask: `A button that shows the current count, starting at 0. Each click adds 1 and sends the new count to the outlet with out(count).`,
		async check(page) {
			const first = findButton(page)
			const rendered = !!first
			for (let i = 0; i < 3; i++) {
				const b = findButton(page)
				if (b) await page.click(b)
			}
			const outs = page.outlet.map(Number)
			return [
				{ name: "button", ok: rendered, required: true },
				{
					name: "outlet 1,2,3",
					ok: outs.slice(-3).join() == "1,2,3",
					required: true,
				},
				{ name: "shows 3", ok: /\b3\b/.test(pageText(page)), required: true },
			]
		},
	},
	{
		id: "todo",
		kind: "ui",
		ask:
			`A todo list: a text <input>, an "Add" button and a <ul>. Clicking Add puts the input's text at the end of the list as a new <li> and clears the input. Clicking an <li> toggles it done by adding or removing the class "done".`,
		async check(page) {
			const input = () => all(page, "input[type=text], input:not([type]), textarea")[0]
			const add = () => findButton(page, /add/i)
			const rendered = !!input() && !!add()
			for (const t of ["milk", "eggs"]) {
				if (input()) await page.type(input(), t)
				if (add()) await page.click(add())
			}
			const items = () => all(page, "li")
			const texts = items().map(textOf)
			const added = texts.length == 2 && /milk/.test(texts[0]) &&
				/eggs/.test(texts[1])
			const cleared = !!input() && input().value == ""
			const li = items()[0]
			if (li) await page.click(li.querySelector("span, label") ?? li)
			const first = items()[0]
			const done = !!first &&
				(first.classList.contains("done") || !!first.querySelector(".done"))
			if (first) await page.click(first)
			const undone = !!items()[0] && !items()[0].classList.contains("done") &&
				!items()[0].querySelector(".done")
			return [
				{ name: "input and button", ok: rendered, required: true },
				{ name: "adds items", ok: added, required: true },
				{ name: "clears input", ok: cleared },
				{ name: "toggles done", ok: done && undone, required: true },
			]
		},
	},
	{
		id: "price-table",
		kind: "ui",
		ask:
			`Show \`data\` (a list of products) as a <table> with one row per product and columns Name and Price. Show the price in dollars with 2 decimals, like $3.50.`,
		data: products,
		hidden: productsHidden,
		async check(page, data: typeof products) {
			const rows = all(page, "tr").map(textOf)
			const each = data.every((p) => rows.some((r) => r.includes(p.name) && r.includes("$" + p.price.toFixed(2))))
			const count = rows.filter((r) => data.some((p) => r.includes(p.name))).length ==
				data.length
			return [
				{ name: "a row per product", ok: count, required: true },
				{ name: "name and $price", ok: each, required: true },
			]
		},
	},
	{
		id: "filter",
		kind: "ui",
		ask:
			`A search <input> above a <ul> of the fruit names in \`data\`. Typing in the input shows only the fruits whose name contains the typed text, ignoring case.`,
		data: ["Apple", "Banana", "Cherry", "Mango", "Orange", "Grape"],
		hidden: ["Lemon", "Melon", "Kiwi", "Plum", "Peach"],
		async check(page, data: string[]) {
			const visible = () => all(page, "li").filter((l) => shown(l, page.window)).map(textOf)
			const at = (words: string[]) => {
				const v = visible()
				return v.length == words.length &&
					words.every((w) => v.some((t) => t.includes(w)))
			}
			const start = at(data)
			const input = () => all(page, "input")[0]
			const tries = data == undefined ? [] : ["AN", "e"]
			let filters = !!input()
			for (const q of tries) {
				if (!input()) break
				await page.type(input(), q)
				filters &&= at(
					data.filter((f) => f.toLowerCase().includes(q.toLowerCase())),
				)
			}
			return [
				{ name: "lists all at first", ok: start, required: true },
				{ name: "filters", ok: filters, required: true },
			]
		},
	},
	{
		id: "swatches",
		kind: "ui",
		ask:
			`Show each colour in \`data\` as a 50x50 square <div> with that background colour. Clicking a square sends its name to the outlet with out(name).`,
		data: [{ name: "sky", hex: "#87ceeb" }, { name: "leaf", hex: "#3cb371" }, {
			name: "rose",
			hex: "#ff007f",
		}],
		hidden: [
			{ name: "sand", hex: "#c2b280" },
			{ name: "plum", hex: "#8e4585" },
			{ name: "ink", hex: "#1b1b3a" },
			{ name: "mint", hex: "#98ff98" },
		],
		async check(page, data: { name: string; hex: string }[]) {
			const squares = data.map((c) => all(page, "*").find((e) => e.style?.backgroundColor && sameColor(e.style.backgroundColor, c.hex)))
			const found = squares.every(Boolean)
			if (squares[1]) await page.click(squares[1])
			const second = lastOut(page) == data[1].name
			if (squares[0]) await page.click(squares[0])
			const first = lastOut(page) == data[0].name
			return [
				{ name: "a square per colour", ok: found, required: true },
				{ name: "click sends name", ok: second && first, required: true },
			]
		},
	},
	{
		id: "bar-chart",
		kind: "ui",
		ask:
			`A bar chart of \`data\` made of HTML elements or SVG (no canvas): one bar per item, each bar's height proportional to its value, with its label under it.`,
		data: bars,
		hidden: barsHidden,
		async check(page, data: typeof bars) {
			return [
				{
					name: "proportional bars",
					ok: domBars(page, data.map((b) => b.value)),
					required: true,
				},
				{
					name: "labels",
					ok: data.every((b) => pageText(page).includes(b.label)),
					required: true,
				},
			]
		},
	},
	{
		id: "fish-tank",
		kind: "canvas",
		ask:
			`Draw a fish tank on the canvas: fill the whole canvas with blue water, then draw each fish in \`data.fish\` at its x, y in its color: an oval body about \`size\` wide, and a triangle tail.`,
		data: fish,
		hidden: fishHidden,
		async check(page, data: typeof fish) {
			const d = page.drawings.find((d) => d.shapes.length) ?? page.drawings[0]
			const area = d ? d.width * d.height : 1
			const water = !!d &&
				d.shapes.some((s) =>
					s.kind == "fill" && bluish(s.style) &&
					(s.box.x1 - s.box.x0) * (s.box.y1 - s.box.y0) >= 0.8 * area
				)
			const found = data.fish.filter((f) =>
				!!d && d.shapes.some((s) => {
					if (s.kind == "clear" || !sameColor(s.style, f.color)) return false
					const cx = (s.box.x0 + s.box.x1) / 2, cy = (s.box.y0 + s.box.y1) / 2
					return Math.abs(cx - f.x) <= f.size && Math.abs(cy - f.y) <= f.size
				})
			)
			return [
				{ name: "blue water", ok: water, required: true },
				{
					name: "every fish placed",
					ok: found.length == data.fish.length,
					required: true,
				},
			]
		},
	},
	{
		id: "canvas-chart",
		kind: "canvas",
		ask:
			`Draw a bar chart of \`data\` on the canvas: one filled rectangle per item, its height proportional to its value, with the label text under each bar.`,
		data: bars,
		hidden: barsHidden,
		async check(page, data: typeof bars) {
			return [
				{
					name: "proportional bars",
					ok: canvasBars(page, data.map((b) => b.value)),
					required: true,
				},
				{
					name: "labels",
					ok: data.every((b) => canvasTexts(page).includes(b.label)),
					required: true,
				},
			]
		},
	},
]

// gathering and drawing in one ask: the raw tables come as `data`, and the same ask can be split into a query and a view

const todos = [
	{ person: "Grace", task: "taxes", done: true },
	{ person: "Ada", task: "letters", done: true },
	{ person: "Ada", task: "garden", done: false },
	{ person: "Linus", task: "kernel", done: true },
	{ person: "Ada", task: "piano", done: true },
	{ person: "Grace", task: "boat", done: false },
]
const todosHidden = [
	{ person: "Zoe", task: "a", done: false },
	{ person: "Max", task: "b", done: true },
	{ person: "Zoe", task: "c", done: true },
	{ person: "Max", task: "d", done: true },
	{ person: "Ivy", task: "e", done: false },
]

export const compoundTasks: ViewTask[] = [
	{
		id: "spend-chart",
		kind: "compound",
		ask: `A bar chart of the total \`amount\` per category of the orders, largest total first, with the category name under each bar.`,
		data: { orders },
		hidden: { orders: ordersHidden },
		async check(page, data: { orders: typeof orders }) {
			const totals = byTotal(data.orders)
			const values = totals.map((t) => t[1])
			const labels = page.drawings.length ? canvasTexts(page) : pageText(page)
			return [
				{
					name: "proportional bars",
					ok: domBars(page, values) || canvasBars(page, values),
					required: true,
				},
				{
					name: "labels",
					ok: totals.every((t) => labels.includes(t[0])),
					required: true,
				},
			]
		},
	},
	{
		id: "unpaid-table",
		kind: "compound",
		ask:
			`A <table> of the orders that are not paid: one row per order with customer and amount, biggest amount first, then a last row with the total amount.`,
		data: { orders },
		hidden: { orders: ordersHidden },
		async check(page, data: { orders: typeof orders }) {
			const unpaid = data.orders.filter((o) => o.status != "paid").sort((
				a,
				b,
			) => b.amount - a.amount)
			const rows = all(page, "tr").map(textOf)
			const has = (r: string, n: number) => r.includes(String(n)) || r.includes(n.toFixed(2))
			const at = unpaid.map((o) => rows.findIndex((r) => r.includes(o.customer) && has(r, o.amount)))
			const total = unpaid.reduce((s, o) => s + o.amount, 0)
			const totalRow = rows.findIndex((r) => has(r, total))
			return [
				{
					name: "unpaid rows in order",
					ok: at.every((i, k) => i >= 0 && (k == 0 || i > at[k - 1])),
					required: true,
				},
				{
					name: "no paid rows",
					ok: !data.orders.some((o) =>
						o.status == "paid" &&
						rows.some((r) => r.includes(o.customer) && has(r, o.amount))
					),
					required: true,
				},
				{
					name: "total row last",
					ok: totalRow >= 0 && totalRow > Math.max(...at),
					required: true,
				},
			]
		},
	},
	{
		id: "done-stats",
		kind: "compound",
		ask: `One line per person, in alphabetical order, showing how many of their todos are done out of their total, like "Ada: 2/3 done".`,
		data: { todos },
		hidden: { todos: todosHidden },
		async check(page, data: { todos: typeof todos }) {
			const people = [...new Set(data.todos.map((t) => t.person))].sort()
			const text = pageText(page)
			const at = people.map((p) => {
				const mine = data.todos.filter((t) => t.person == p)
				return text.search(
					new RegExp(
						`${p}\\W+${mine.filter((t) => t.done).length}\\s*/\\s*${mine.length}`,
					),
				)
			})
			return [
				{
					name: "a line per person",
					ok: at.every((i) => i >= 0),
					required: true,
				},
				{
					name: "alphabetical",
					ok: at.every((i, k) => k == 0 || i > at[k - 1]),
					required: true,
				},
			]
		},
	},
]

export const tasks: Task[] = [...dataTasks, ...viewTasks, ...compoundTasks]
export const taskById = (id: string) => tasks.find((t) => t.id == id)!
