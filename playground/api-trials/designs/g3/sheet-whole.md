# Writing an ermine program (design G3)

A program is one file whose default export is a function, run once as the program starts. Its words
are globals: use them as they are. They are also on `api`, the function's argument, if you'd rather
destructure. Use only this sheet's words, plus `show(text)`, which writes a line of output (a task
may name more functions, globals too). No imports. Paths: a bare `"x"` is x in the working folder,
the same as `"./x"`; `"/x"` is from the root.

    export default function () { const lamp = node("lamp"); /* … */ }

## A whole program

A whole file, to copy as a shape: a lamp's brightness, a label made from it, a watch showing the
label, a handler setting the brightness and keeping a history. It shows "dim" at start, and "bright"
after a call of 8 to `./on/set`.

```js
export default function () {
	// every word is a global: node, derived, on, show
	// a lamp's brightness, 0 to 10: the node holds the plain number 3
	const level = node("level", 3)
	// the levels it was set to: a list
	const history = node("history", [])
	// derived: read level, give a label
	const label = derived("label", () => level.get() > 4 ? "bright" : "dim")
	// shows the label at first, then each time it changes
	label.watch((text) => show(text))
	// a call to ./on/set with 8 sets level to 8, and pushes 8 onto the history
	on("on/set", (n) => {
		level.set(n)
		history.produce((list) => {
			list.push(n)
		})
	})
}
```

## The words

**1. Getting nodes.** `node(path, initial?)` gives a handle on the node at path. With an initial
value, the node is made holding it if nothing is there (what is there stays). Without one, nothing
is made: the handle may point at nothing yet.

    const lamp = node("lamp", { on: false, level: 3 })

**2. Reading.** `lamp.get()` gives the value now (nothing there: undefined). Inside a derived value
it is tracked: the derived value is worked out again when it changes.

    const level = lamp.get().level

**3. Writing.** `lamp.set(value)` replaces the whole value (nothing there: it is made).
`lamp.produce((draft) => { … })` changes part of it: change the draft (assign, push, splice) and
return nothing. The node must be there.

    lamp.produce((draft) => { draft.level = 5 })

**4. Computing.** `derived(name, () => …)` gives a handle on a node holding the function's result,
worked out again when what it read changes; `.get()` it. `lamp.watch((value) => …)` calls the
function with the value now, then with the new value at each change. Do outside things (show) in a
watch.

    const bright = derived("bright", () => lamp.get().level > 4)
    bright.watch((b) => show(b ? "bright" : "dim"))

**5. Handlers and calls.** `on(path, (...args) => …)` puts a handler at path: it answers each call
there, given its arguments. `node(path).call(...args)` gives a promise of the handler's reply.

    on("on/toggle", () => lamp.produce((draft) => { draft.on = !draft.on }))
    const time = await node("/clock/now").call()

**6. State and waiting.** A `get` of a node not there yet gives undefined; a derived value that read
it is worked out again once it is there. A watch is first called once the node is there. A call to a
path with no handler yet waits until one is placed. Handlers may be async.

    node("/sensor/level").watch((level) => show(`sensor: ${level}`))

**7. Cleanup.** `watch` gives back a function: call it to stop watching. `onStop(fn)`: fn runs when
the program stops.

    const stop = lamp.watch((value) => show(value.on ? "on" : "off"))
    onStop(() => show("lamp off"))

**8. Why.** There is no word for who wrote a node.
