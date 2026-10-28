// ermine live on an edge, the page's side. LLM generated: a prototype (../typescript/edge.ts is the
// server's). as live-poll.js, but no server remembers this page: it says the version it last saw
// (seen) with each ask, and an answer { from, to, updates } is applied unless the page has already
// seen past it; each update as live.js does, told "ermine:change"
const root = document.querySelector("[data-ermine-process]")
const p = root.getAttribute("data-ermine-process")
// an update's element, by its binding's name. a name in a list's row is written from the row
// (":0": the row's data-ermine-in, its data-ermine-key, then ":0"), so each element's names are
// worked out whole, and found again when one isn't (the page's elements changed)
const whole = (name, el) => {
	const row = name[0] == ":" ? el.closest("[data-ermine-in]") : null
	if (!row) return name
	const list = whole(row.getAttribute("data-ermine-in"), row.parentElement)
	return `${list}/${row.getAttribute("data-ermine-key")}${name}`
}
let found = new Map()
function find(b) {
	if (found.get(b)?.isConnected) return found.get(b)
	found = new Map()
	for (const el of document.querySelectorAll("[data-ermine-binding]")) {
		for (const n of el.getAttribute("data-ermine-binding").split(" ")) found.set(whole(n, el), el)
	}
	return found.get(b)
}

let seen = Number(root.getAttribute("data-ermine-seen"))
const take = (answer) => {
	if (answer.to < seen) return
	seen = answer.to
	for (const [b, k, v] of answer.updates) {
		const el = find(b)
		if (!el) continue
		if (k == "text") el.textContent = v
		else if (k == "children") el.innerHTML = v, found = new Map()
		else if (k in el) el[k] = v ?? ""
		else if (v == null || v === false) el.removeAttribute(k)
		else el.setAttribute(k, v === true ? "" : v)
		el.dispatchEvent(
			new CustomEvent("ermine:change", { bubbles: true, detail: { binding: b, prop: k } }),
		)
	}
}
// an answer: 200 brings updates, 410 a page the server cannot carry on: a new one
const heard = async (r) =>
	r.status == 410 ? location.reload() : r.status == 200 && take(await r.json())
async function hold() {
	for (;;) {
		try {
			await heard(await fetch(`/missed?p=${encodeURIComponent(p)}&seen=${seen}`))
		} catch {
			await new Promise((wait) => setTimeout(wait, 1000))
		}
	}
}
hold()
for (const t of ["click", "submit", "input", "change", "keydown"]) {
	addEventListener(t, (e) => {
		for (let el = e.target; el && el.getAttribute; el = el.parentNode) {
			const h = el.getAttribute("data-ermine-handler:" + t)
			if (h == null) continue
			const form = t == "submit" ? Object.fromEntries(new FormData(el)) : undefined
			if (form) e.preventDefault(), el.reset()
			const said = { p, h, t, value: el.value, checked: el.checked, key: e.key, form, seen }
			// the element clicked inside the handler's, and where
			if (e.target != el) said.tv = e.target.value
			if (t == "click") {
				const r = el.getBoundingClientRect()
				said.at = [e.clientX - r.left, e.clientY - r.top, r.width, r.height].map(Math.round)
			}
			fetch("/event", { method: "POST", body: JSON.stringify(said) }).then(heard)
			return
		}
	}, true)
}
