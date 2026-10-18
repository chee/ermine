import createEntry from "@ermine/node/entry"
import update from "@ermine/node/update"
import { createPlaces, place, unplace } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import * as lib from "@ermine/places/lib"
import { createScheduler, PENDING } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { trace } from "@ermine/scheduler/trace"
import { createTable } from "@ermine/table"
import { createGuard, slot, target } from "@ermine/places/guard"
import { plan } from "@ermine/places/path"

// a handle: the id of a node, and its path from the root
const ROOT = { id: "root", path: [] }
const entry = (h) => table.get("children", h.id)
// ---- the host, once: everything made here, places connecting them ----
const table = createTable((part, id) => places.onTableChange(part, id))
const paths = createPaths()
const s = createScheduler()
s.onTrackingEnd((key) => places.release(key))
trace(s, (m) => (moments.push(m), record(m))) // moments: added for the inspector
const places = createPlaces({ root: "root", table, paths, scheduler: s })
const host = s.createRootScope({ actor: "chee@laptop", "trusted-event": true })

const parts = new Map() // computation → { entry, at, scope, pending? }
const moments = [] // added for the inspector: every scheduler moment
const defined = new Map() // handler id → { scope, guard }
globalThis.ermine = {
	table,
	places,
	s,
	header: (extra) => createChangeHeader(s, extra),
	writes: { place, unplace },
	parts,
	moments,
} // added for the inspector: the page reads the world from here

// ---- added for the demo: the root node, and a data folder holding n ----
s.runWithScope(host, () => {
	table.add("value", "root", createEntry(undefined, createChangeHeader(s)))
	table.add("children", "root", createEntry({}, createChangeHeader(s)))
	node([node([ROOT, "data"]), "n"], 21)
})

// ---- a process, started at a place ----
function start(at, setup, may) {
	const self = s.runWithScope(host, () => node(at))
	const scope = s.createScope({ process: self.id }, host)
	const t = tools(self, createGuard({ places, scheduler: s, table, may, from: self.path }))
	s.runWithScope(scope, () => {
		// unplace is kill (a move also leaves this slot: this can't tell the two apart)
		s.createEffect(() => {
			for (const m of places.walk([at[1]], at[0].id)) return m.id === self.id
		}, (here) => here || queueMicrotask(() => s.teardown(scope)))
		t.put(self, setup(t, self)) // run is untracked: setup once, its return its value
	})
	s.pulse() // the parts it made run their first time
	return self
}

// ---- what a process is handed: places, the store and link, each call asked first ----
function tools(self, guard) {
	const t = {
		make(at, value?) {
			guard.write("place", slot(at[0], at[1]))
			return node(at, value)
		},
		get(x, path?) {
			guard.read(target(x, "value", path))
			return places.readValue("value", x.id, path)
		},
		find(address) {
			const found = address[0] === "/" ? plan(address) : lib.lookup(places, address, self.path)
			const id = found && lib.get(places, found)
			if (id === undefined) return []
			const at = found!.slice(0, -1)
			return guard.members([{ name: found!.at(-1)!, id, path: found! }], at)
		},
		put(x, value) {
			guard.write("edit", target(x, "value"))
			const n = table.get("value", x.id)
			update(n, [{ path: [], value }], createChangeHeader(s))
			places.commit([n])
		},
		// computes and effects: nodes inside, each its own scope under the process's
		part(kind, name, f, act?) {
			const entry = t.make([self, name])
			const own = s.createScope({ part: name })
			s.runWithScope(own, () => {
				const c = kind === "compute"
					? s.createComputer(f, (v) => t.put(entry, v))
					: s.createEffect(f, (v, before) => (t.put(entry, v), act(v, before)))
				parts.set(c, { entry, at: [self, name], scope: own })
			})
			return entry
		},
		// a node holding the function; a call is owned by the scope open here
		handler(at, fn) {
			const entry = t.make(at, fn)
			defined.set(entry.id, { scope: s.getCurrentScope()!, guard })
			return entry
		},
		cleanup: (f) => s.registerTeardown(s.getCurrentScope()!, f),
	}
	return t
}

// ---- a call: owned by the definer, saying the caller and whether a person did it ----
function call(address, args, caller, trusted) {
	const path = plan(address) ?? []
	const found = { id: s.runWithScope(host, () => lib.get(places, path)), path }
	const { scope, guard } = defined.get(found.id)
	const own = s.createScope({ caller, "trusted-event": trusted }, scope)
	try {
		return s.runWithScope(own, () => {
			guard.write("execute", target(found, "value"))
			return places.readValue("value", found.id)(...args)
		})
	} finally {
		s.teardown(own)
		s.pulse()
	}
}

// ---- pending goes in the place (written from inside the hook, mid-pulse) ----
function record(m) {
	if (!("ends" in m) || !parts.has(m.ends)) return
	const p = parts.get(m.ends)
	s.runWithScope(
		p.scope,
		() =>
			status(
				p,
				m.ended === "pending"
					? { pending: true }
					: m.ended === "failed"
					? { error: m.error }
					: undefined,
			),
	)
}
function status(p, value) {
	if (value && !p.pending) {
		p.pending = crypto.randomUUID()
		table.add("value", p.pending, createEntry(value, createChangeHeader(s)))
		places.commit(place(entry(p.at[0]), p.at[1], p.pending, createChangeHeader(s)))
	} else if (value) {
		const n = table.get("value", p.pending)
		update(n, [{ path: [], value }], createChangeHeader(s))
		places.commit([n])
	} else if (p.pending) {
		places.commit(unplace(entry(p.at[0]), p.at[1], createChangeHeader(s)))
		table.del("value", p.pending)
		p.pending = undefined
	}
}

// a node: a new id, a value and a children node in the store, placed at the slot
function node(at, value?) {
	const id = crypto.randomUUID()
	table.add("value", id, createEntry(value, createChangeHeader(s)))
	table.add("children", id, createEntry({}, createChangeHeader(s)))
	places.commit(place(entry(at[0]), at[1], id, createChangeHeader(s)))
	return { id, path: [...at[0].path, at[1]] }
}

// ---- the program: steps 1–7 ----
const demo = start([ROOT, "demo"], (t, self) => {
	const counter = t.make([self, "counter"], 0) // 4
	const n = t.part("compute", "n", () => { // 1, 2
		const [found] = t.find(["/", "data", "n"])
		return found ? t.get(found) : PENDING
	})
	const double = t.part("compute", "double", () => { // 3
		const v = t.get(n)
		return typeof v === "number" ? 2 * v : PENDING
	})
	const add = t.make([self, "add"], null) // 5
	t.part(
		"effect",
		"adding",
		() => places.readChange("value", add.id),
		(_, before) => before && t.put(counter, t.get(counter) + 1),
	)
	t.handler([t.make([self, "on"]), "press"], () => t.put(add, Date.now()))

	const view = document.createElement("div") // 6
	const text = view.appendChild(document.createElement("p"))
	const button = view.appendChild(
		Object.assign(document.createElement("button"), { textContent: "+1" }),
	)
	t.part(
		"effect",
		"show",
		() => [t.get(n), t.get(double), t.get(counter)],
		([v, d, c]) => (text.textContent = `n is ${v}, double ${d}, count ${c}`),
	)
	button.onclick = (e) => call(["demo", "on", "press"], [], "chee@laptop", e.isTrusted)
	t.cleanup(() => view.remove())
	return view
})
document.body.append(s.runWithScope(host, () => places.readValue("value", demo.id))) // 7
