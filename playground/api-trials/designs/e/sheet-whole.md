# Writing an ermine program (design E)

A program is one file whose default export is a function, run once as the program starts; what it
returns is the process's value. Every function you hand ermine gets its own `e` first: the program,
a memo, an effect, a handler. Always call it `e`, so the inner one shadows the outer. Which `e` you
use decides whether reads are tracked, whether writes are allowed, and who the writes are from. Use
only this sheet's words, plus `e.show(text)`, which writes a line of output (a task may name more
functions on `e`). No imports. Paths: `"x"` or `"./x"` the current dir (the working folder), `"~/x"`
the program's own folder, `"/x"` the root you were given, `".."` up.

    export default function (e) { /* … */ }

## A whole program

A whole file, to copy as a shape: a lamp's brightness, a label made from it, an effect showing the
label, a handler setting the brightness. It shows "dim" at start, and "bright" after a send of 8 to
`./on/set`.

```js
export default function (e) {
	// every word is on e; each function below gets its own e first
	// a lamp's brightness, 0 to 10: the node holds the plain number 3
	const level = e.node("./level", 3)
	// derived: read level, give a label
	const label = e.memo("label", (e) => e.read(level) > 4 ? "bright" : "dim")
	// shows the label at first, then each time it changes
	e.effect("draw", (e) => e.read(label), (e, text) => e.show(text))
	// a send to ./on/set with 8 sets level to 8
	e.handler("./on/set", (e, n) => e.write(level, n))
}
```

## The words

**1. Getting nodes.** A node is a handle, NOT its value. `e.node(path, start?)`: made with start (or
null) if missing; in a memo's or effect's f it never makes. `e.byId(id)`: by id, never made.
`e.at(path)`: an `e` whose current dir is there. Printing a handle, or its `.value`, `.length`,
`.map`, throws "this is a node, not its value: use e.read(node)".

    const lamp = e.node("./lamp", { on: false, level: 3 })

**2. Reading.** `e.read(node, path?)` the value (tracked in a memo/effect). `e.peep(node)` the
value, untracked. `e.reads(node)` `[{ value, from }, ...]` every value it holds. `e.list(node)`
`[{ name, node }, ...]` sorted by name. `e.attributes(node)` `{ ... }`.

    const level = e.read(lamp, ["level"])

**3. Writing.** Not in a memo's or effect's f (NotHere). `e.write(node, value)`; one part:
`e.write(node, path, value)`. `e.edit(node, recipe)` a recipe on a draft, or return the new value.
`e.patch(node, [{ op: "remove", at: [0] }])`, `e.remove`, `e.move`, `e.place`, `e.unplace`.

    e.edit(lamp, (draft) => { draft.level = 5 })

**4. Computing.** `e.memo(name, (e) => …)` gives a node: read it. It runs again when what it read
changes; it may be async. `e.effect(name, (e) => what to watch, (e, now, before) => …)`: the act
runs after the round, when the value changed; it may write. Made from the program's `e` only.

    const bright = e.memo("bright", (e) => e.read(lamp).level > 4)
    e.effect("draw", (e) => e.read(bright), (e, now) => e.show(now ? "bright" : "dim"))

**5. Handlers and calls.** `e.handler(path, (e, ...args) => …)` lives at path; the caller gets what
it returns. `e.call(path, ...args)` gives a promise of the answer; it waits if no handler yet. Not
in a memo's or effect's f.

    e.handler("./on/toggle", (e) => e.edit(lamp, (d) => { d.on = !d.on }))
    const time = await e.call("/clock/now")

**6. State and waiting.** `e.status(x)` (a node or a call's promise):
`{ state: "done" | "pending" | "failed" | "looping", waiting, error }`, tracked, never makes the
caller pending. Reading a pending node in a memo makes the memo pending; elsewhere it throws
Pending. An `e` used after its run ended: Ended. The program's `e` used inside a memo: WrongE.

    e.effect("health", (e) => e.status(bright).state, (e, s) => e.show(s))

**7. Cleanup.** `e.teardown(fn)`: in a memo/effect, before the rerun and at stop; in the program, at
stop; in a handler, when the call ends.

    e.teardown(() => e.show("lamp off"))

**8. Why.** `e.why(node)`: `{ by: "memo" | "effect" | "call" | "outside", writer, caller, site }`.

    const b = e.why(lamp)
