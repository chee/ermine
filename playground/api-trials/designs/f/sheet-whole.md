# Writing an ermine program (design F)

A program is one file whose default export is a function, run once as the program starts; what it
returns is the process's value. Every callback's first argument is `me`: whoever is acting right now
(the setup, one run of a computation, one act of an effect, one call to a handler). Always call it
`me` (the nearest shadows the outer). A string is always a path: making or naming takes a path,
using takes a handle. Use only this sheet's words, plus `me.show(text)`, which writes a line of
output (a task may name more functions on `me`). No imports. Paths: `"x"` or `"./x"` the current
directory (the working folder), `"~/x"` the own folder, `"/"` the given root, `".."` up.

    export default function (me) { /* … */ }

## A whole program

A whole file, to copy as a shape: a lamp's brightness, a label made from it, an effect showing the
label, a handler setting the brightness. It shows "dim" at start, and "bright" after a send of 8 to
`./on/set`.

```js
export default function (me) {
	// every word is on me; each callback below gets its own me first
	// a lamp's brightness, 0 to 10: the node holds the plain number 3
	const level = me.make("./level", 3)
	// derived: read level, give a label
	const label = me.compute("~/label", (me) => me.read(level) > 4 ? "bright" : "dim")
	// shows the label at first, then each time it changes
	me.effect("~/draw", (me) => me.read(label), (text, before, me) => me.show(text))
	// a send to ./on/set with 8 sets level to 8
	me.answer("./on/set", (me, n) => me.write(level, n))
}
```

## The words

**1. Getting nodes.** `me.node(path, from?)`: a handle; not made; may point at nothing yet.
`me.make(path, start?)`: made if missing (start used only if made now). `me.byId(id)`.
`me.info(node)`: `{ id, path, exists }`. A handle has no value on it: using it as one throws
NotAValue ("this is a node; use me.read(node)").

    const lamp = me.make("./lamp", { on: false, level: 3 })

**2. Reading.** `me.read(node)`: the value, tracked inside a computation. `me.peek(node)`: the
value, never tracked, never throws "not ready". `me.values(node)`: `[{ value, from }]`.
`me.children(node)`: `[{ name, node }]` sorted by name. `me.attributes(node)`: `{ key: value }`.

    const level = me.read(lamp).level

**3. Writing** (not inside a computation). `me.write(node, v)` replace (Missing: me.make it first).
`me.writeAt(node, keys, v)` replace one part. `me.edit(node, draft => { … })`: change a draft;
return nothing. `me.remove(node)`, `me.move(node, path)`, `me.place(node, path)`.

    me.edit(lamp, (draft) => { draft.level = 5 })

**4. Computing.** `me.compute(path, (me) => …)`: cached at path; returns its node. It reruns when
its reads change; it may be async. `me.effect(path, (me) => …, (now, before, me) => …)`: like
compute, then the act runs after the round when the value is done and changed.

    const bright = me.compute("~/bright", (me) => me.read(lamp).level > 4)
    me.effect("~/draw", (me) => me.read(bright), (now, before, me) => me.show(now ? "bright" : "dim"))

**5. Handlers and calls.** `me.answer(path, (me, ...args) => …)`: a handler at path; the caller gets
what it returns. `me.send(node, ...args)`: a promise; waits if no handler yet. Not inside a
computation.

    me.answer("./on/toggle", (me) => me.edit(lamp, (d) => { d.on = !d.on }))
    const time = await me.send(me.node("/clock/now"))

**6. State and waiting.** `me.status(node)`:
`{ state: "done" | "pending" | "failed" | "looping", waits, error, loop }`. `await me.ready(node)`:
outside computations, wait until done, then get the value. A pending read inside a computation makes
that computation pending; outside one it throws NotReady. A `me` used after it ends: Ended; inside a
callback, any `me` but its own: WrongMe.

    const n = await me.ready(bright)

**7. Cleanup.** `me.cleanup(fn)`: runs when this `me` ends: rerun, next act, stop.

    me.cleanup(() => me.show("lamp off"))

**8. Why.** `me.why(node)`: `{ kind: "run" | "call" | "outside", node, caller?, site? }`.

    const b = me.why(lamp)
