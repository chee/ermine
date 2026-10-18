// stack: a tool for patchwork's folder ({ docs: [{ name, url }] }): each doc in a <patchwork-view>
// of its own, one under another, its name a button that opens it (patchwork:open-document, bubbling
// up from element), the selected one pressed (patchwork:selected-doc). a row is made for a url new
// to the folder and taken out for one gone; rows kept are never moved
export const plugins = [
	{
		type: "patchwork:tool",
		id: "stack",
		name: "Stack",
		supportedDatatypes: ["folder"],
		load: () => stack,
	},
]

function subscribe(element, selector, fn) {
	const { port1, port2 } = new MessageChannel()
	port2.onmessage = (e) => {
		if (e.data?.type === "change") fn(e.data.value)
	}
	element.dispatchEvent(
		new CustomEvent("patchwork:subscribe", {
			bubbles: true,
			composed: true,
			detail: { selector, port: port1 },
		}),
	)
	return () => {
		port2.postMessage({ type: "unsubscribe" })
		port2.onmessage = null
		port2.close()
	}
}

function stack(handle, element) {
	const doc = element.ownerDocument
	const list = doc.createElement("div")
	element.append(list)
	// url: its row and its button
	const rows = new Map()
	let selected = []
	const mark = () => {
		for (const [url, { button }] of rows) {
			button.setAttribute("aria-pressed", String(selected.includes(url)))
		}
	}
	const draw = () => {
		const docs = handle.doc()?.docs ?? []
		const urls = new Set(docs.map((d) => d.url))
		for (const [url, { row }] of rows) {
			if (urls.has(url)) continue
			row.remove()
			rows.delete(url)
		}
		for (const { name, url } of docs) {
			if (rows.has(url)) continue
			const row = doc.createElement("section")
			const button = doc.createElement("button")
			button.textContent = name ?? url
			button.addEventListener("click", () =>
				element.dispatchEvent(
					new CustomEvent("patchwork:open-document", { bubbles: true, detail: { url } }),
				))
			const view = doc.createElement("patchwork-view")
			view.setAttribute("doc-url", url)
			row.append(button, view)
			list.append(row)
			rows.set(url, { row, button })
		}
		mark()
	}
	draw()
	handle.on("change", draw)
	const unsubscribe = subscribe(element, { type: "patchwork:selected-doc" }, (urls) => {
		selected = urls
		mark()
	})
	return () => {
		unsubscribe()
		handle.off("change", draw)
		list.remove()
	}
}
