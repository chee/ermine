// ermine live with GET and POST only, the page's side. LLM generated: a prototype (live.js is the
// event stream's). a post's answer is what this page missed, its own change and anyone's since its
// last answer; a GET /missed held open brings the rest. answers are numbered { n, updates } and
// applied in order; each update as live.js does, told "ermine:change"
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

let next = 1
const early = new Map()
const take = (answer) => {
	early.set(answer.n, answer.updates)
	for (; early.has(next); next++) {
		apply(early.get(next))
		early.delete(next)
	}
}
function apply(updates) {
	for (const [b, k, v] of updates) {
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
// the server has forgotten this page (it restarted, or the page was away too long): a new one
const gone = () => location.reload()
// an answer: 200 brings updates, 204 nothing, 410 a page the server forgot
const heard = async (r) => r.status == 410 ? gone() : r.status == 200 && take(await r.json())
async function hold() {
	for (;;) {
		try {
			await heard(await fetch("/missed?p=" + encodeURIComponent(p)))
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
			const said = { p, h, t, value: el.value, checked: el.checked, key: e.key, form }
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
