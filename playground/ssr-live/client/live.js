// ermine live, the page's side. LLM generated: a prototype (../typescript/live.ts is the server's).
// what the server's bindings show, kept here: a stream of [binding, prop, value], the element
// found by data-ermine-binding ("text": its text, "children": its html, morphed in, else a
// property or an attribute), then told "ermine:change" as ermine-h's are; and the page's events
// sent back: the nearest data-ermine-handler:<event>, posted with what the element says
const root = document.querySelector("[data-ermine-process]")
const p = root.getAttribute("data-ermine-process")

// morph: el's kids made like html's, the page's own kept where they match (a row by its
// data-ermine-key, else the next of its kind), so what has focus, a caret and what's typed stay.
// what goes is taken out first, and a kept node moves only when its place changed
const keyOf = (n) => n.getAttribute?.("data-ermine-key") ?? undefined
const kindOf = (n) => n.nodeType == 1 ? n.tagName : n.nodeType
function morph(el, html) {
	const t = document.createElement("template")
	t.innerHTML = html
	kidsLike(el, t.content)
}
function kidsLike(el, like) {
	const old = [...el.childNodes]
	const used = new Set()
	const keyed = new Map(old.filter((n) => keyOf(n) != null).map((n) => [keyOf(n), n]))
	let next = 0
	const pairs = [...like.childNodes].map((n) => {
		const k = keyOf(n)
		let m = k == null ? undefined : keyed.get(k)
		if (k == null) {
			while (next < old.length && (used.has(old[next]) || keyOf(old[next]) != null)) next++
			const i = old.findIndex((o, i) =>
				i >= next && !used.has(o) && keyOf(o) == null && kindOf(o) == kindOf(n)
			)
			if (i >= 0) m = old[i], next = i + 1
		}
		if (m && kindOf(m) != kindOf(n)) m = undefined
		if (m) used.add(m)
		return [m, n]
	})
	for (const o of old) if (!used.has(o)) o.remove()
	pairs.forEach(([m, n], i) => {
		const node = m ?? n
		if (el.childNodes[i] != node) el.insertBefore(node, el.childNodes[i] ?? null)
		if (m) nodeLike(m, n)
	})
}
function nodeLike(m, n) {
	if (m.nodeType != 1) return void (m.data != n.data && (m.data = n.data))
	for (const a of [...m.attributes]) if (!n.hasAttribute(a.name)) m.removeAttribute(a.name)
	for (const a of n.attributes) {
		if (m.getAttribute(a.name) != a.value) m.setAttribute(a.name, a.value)
	}
	kidsLike(m, n.content ?? n)
}

const live = new EventSource("/live?p=" + encodeURIComponent(p))
live.onmessage = (m) => {
	for (const [b, k, v] of JSON.parse(m.data)) {
		const el = document.querySelector(`[data-ermine-binding~="${b}"]`)
		if (!el) continue
		if (k == "text") el.textContent != v && (el.textContent = v)
		else if (k == "children") morph(el, v)
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
live.onerror = () => live.readyState == 2 && gone()
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
			fetch("/event", { method: "POST", body: JSON.stringify(said) })
				.then((r) => r.status == 410 && gone())
			return
		}
	}, true)
}
