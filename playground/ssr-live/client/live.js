// ermine live, the page's side. LLM generated: a prototype (../typescript/live.ts is the server's).
// what the server's bindings show, kept here: a stream of [binding, prop, value], the element
// found by data-ermine-binding ("text": its text, "children": its html, else a property or an
// attribute), then told "ermine:change" as ermine-h's are; and the page's events sent back: the
// nearest data-ermine-handler:<event>, posted with what the element says
const root = document.querySelector("[data-ermine-process]")
const p = root.getAttribute("data-ermine-process")
const live = new EventSource("/live?p=" + encodeURIComponent(p))
live.onmessage = (m) => {
	for (const [b, k, v] of JSON.parse(m.data)) {
		const el = document.querySelector(`[data-ermine-binding~="${b}"]`)
		if (!el) continue
		if (k == "text") el.textContent = v
		else if (k == "children") el.innerHTML = v
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
