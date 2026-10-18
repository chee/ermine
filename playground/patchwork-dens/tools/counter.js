// counter: a datatype ({ title, count }) and a tool for it: the title, the count and a button
// adding one. the clicks across every counter are the tool's own, in its tool storage: a doc asked
// for with patchwork:subscribe { type: "patchwork:tool-storage", toolId }, answered with its url
export const plugins = [
	{
		type: "patchwork:datatype",
		id: "counter",
		name: "Counter",
		load: () => counter,
	},
	{
		type: "patchwork:tool",
		id: "counter",
		name: "Counter",
		supportedDatatypes: ["counter"],
		load: () => tool,
	},
]

const counter = {
	init(doc) {
		doc.title = "a counter"
		doc.count = 0
	},
	getTitle: (doc) => doc.title ?? "counter",
	setTitle(doc, title) {
		doc.title = title
	},
}

// patchwork's subscribe, by hand: a selector bubbling up from element with a port, its answers
// { type: "change", value } on the port
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

function tool(handle, element) {
	const doc = element.ownerDocument
	const title = doc.createElement("h2")
	const count = doc.createElement("output")
	const button = doc.createElement("button")
	const clicks = doc.createElement("small")
	button.textContent = "+1"
	let storage
	const draw = () => {
		const d = handle.doc() ?? {}
		title.textContent = counter.getTitle(d)
		count.textContent = String(d.count ?? 0)
		clicks.textContent = storage ? `${storage.doc()?.clicks ?? 0} clicks, every counter` : ""
	}
	const click = () => {
		handle.change((d) => {
			d.count = (d.count ?? 0) + 1
		})
		storage?.change((s) => {
			s.clicks = (s.clicks ?? 0) + 1
		})
	}
	const unsubscribe = subscribe(
		element,
		{ type: "patchwork:tool-storage", toolId: "counter" },
		async (url) => {
			storage?.off("change", draw)
			storage = await element.repo.find(url)
			storage.on("change", draw)
			draw()
		},
	)
	button.addEventListener("click", click)
	handle.on("change", draw)
	element.append(title, count, button, clicks)
	draw()
	return () => {
		unsubscribe()
		storage?.off("change", draw)
		handle.off("change", draw)
		button.removeEventListener("click", click)
		for (const e of [title, count, button, clicks]) e.remove()
	}
}
