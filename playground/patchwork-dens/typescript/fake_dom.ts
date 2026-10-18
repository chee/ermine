// fake_dom: a DOM as small as the tools here need, for tests. elements with attributes, children,
// text, and listeners that bubble (stopPropagation stops them); a document whose root is connected.
// a patchwork-view coming under the root (appended, or a subtree holding one) is told connected,
// one going out (removed, or its text set over) disconnected: what a custom element is told
//
//   const dom = createDocument({ connected, disconnected })
//   dom.root.append(dom.createElement("div"))
//   dom.root.textContent                       // every text under it, in order
//   find(dom.root, "button")[0].click()
export type Hooks = {
	connected: (el: FakeElement) => void
	disconnected: (el: FakeElement) => void
}

export class FakeElement extends EventTarget {
	parentNode: FakeElement | null = null
	readonly childNodes: FakeElement[] = []
	readonly attributes = new Map<string, string>()
	repo?: unknown
	#text = ""
	readonly #listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

	constructor(readonly localName: string, readonly ownerDocument: FakeDocument) {
		super()
	}

	get isConnected(): boolean {
		return this.parentNode === null ? this === this.ownerDocument.root : this.parentNode.isConnected
	}

	get textContent(): string {
		return this.localName === "#text"
			? this.#text
			: this.childNodes.map((c) => c.textContent).join("")
	}
	set textContent(s: string) {
		for (const c of [...this.childNodes]) c.remove()
		if (s !== "") this.append(s)
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, String(value))
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}

	append(...nodes: (FakeElement | string)[]) {
		for (const n of nodes) {
			const el = typeof n === "string" ? this.ownerDocument.text(n) : n
			if (el.parentNode !== null) el.remove()
			el.parentNode = this
			this.childNodes.push(el)
			if (this.isConnected) tell(el, this.ownerDocument.hooks.connected)
		}
	}

	remove() {
		const up = this.parentNode
		if (up === null) return
		const was = this.isConnected
		up.childNodes.splice(up.childNodes.indexOf(this), 1)
		this.parentNode = null
		if (was) tell(this, this.ownerDocument.hooks.disconnected)
	}

	override addEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
		if (fn === null) return
		let fns = this.#listeners.get(type)
		if (fns === undefined) this.#listeners.set(type, fns = new Set())
		fns.add(fn)
	}
	override removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null) {
		if (fn !== null) this.#listeners.get(type)?.delete(fn)
	}
	// here, then up while it bubbles and nobody stopped it
	override dispatchEvent(e: Event): boolean {
		let stopped = false
		const stop = e.stopPropagation.bind(e)
		Object.defineProperty(e, "stopPropagation", {
			value: () => {
				stopped = true
				stop()
			},
		})
		const path: FakeElement[] = [this]
		if (e.bubbles) { for (let up = this.parentNode; up !== null; up = up.parentNode) path.push(up) }
		for (const at of path) {
			if (stopped) break
			for (const fn of [...(at.#listeners.get(e.type) ?? [])]) {
				if (typeof fn === "function") fn.call(at, e)
				else fn.handleEvent(e)
			}
		}
		return !e.defaultPrevented
	}
	click() {
		this.dispatchEvent(new Event("click", { bubbles: true }))
	}

	setText(s: string) {
		this.#text = s
	}
}

// el and every element under it that is a patchwork-view, told
function tell(el: FakeElement, f: (el: FakeElement) => void) {
	if (el.localName === "patchwork-view") f(el)
	for (const c of [...el.childNodes]) tell(c, f)
}

export class FakeDocument {
	readonly root: FakeElement
	constructor(readonly hooks: Hooks) {
		this.root = new FakeElement("body", this)
	}
	createElement(tag: string): FakeElement {
		return new FakeElement(tag.toLowerCase(), this)
	}
	text(s: string): FakeElement {
		const t = new FakeElement("#text", this)
		t.setText(s)
		return t
	}
}

export const createDocument = (hooks: Hooks): FakeDocument => new FakeDocument(hooks)

// every element under el (el too) with that name, in document order
export function find(el: FakeElement, name: string): FakeElement[] {
	const out: FakeElement[] = el.localName === name ? [el] : []
	for (const c of el.childNodes) out.push(...find(c, name))
	return out
}
