# Writing an ermine program (design K)

A program is one file whose default export is a function, run once as the program starts. Its words
are Solid 2.0's, as you'd import them from solid-js; here they are globals (no imports), also on
`api`. Use only this sheet's words, plus `show(text)`, which writes a line of output (a task may
name more functions, globals too). Every value lives in a node of ermine's tree; what is marked
"ermine's" is not Solid's. Paths: `"./x"` is x in the working folder, `"/x"` is from the root, a
bare `"x"` is inside the program's own node.

    export default function () { const [count, setCount] = createSignal(0, { name: "./count" }) }

**1. Getting nodes.** `createSignal(value, { name })` gives `[get, set]` on the node at path name
(ermine's: in Solid, name is a debug name). It is made holding value if nothing is there (what is
there stays; no value: maybe empty). `createStore(value, { name })` gives `[store, setStore]` on an
object or list. Without a name: a node of its own.

    const [lamp, setLamp] = createStore({ on: false, level: 3 }, { name: "./lamp" })

**2. Reading.** `count()` gives a signal's value now (nothing there: undefined); a store is read by
its properties. Inside a memo, or an effect's compute, it is tracked. `untrack(() => …)` reads
untracked.

    const level = lamp.level

**3. Writing.** `setCount(value)`, or `setCount((prev) => next)`. `setLamp((draft) => { … })`
changes the draft (assign, push, splice), or returns a new value when that is easier. Nothing there:
it is made. A write is seen at once (ermine's); `flush()` runs what it wakes now.

    setLamp((draft) => { draft.level = 5 })

**4. Computing.** `createMemo(() => …, { name })` gives a getter on a node holding the result,
worked out again when what it read changes. `createEffect(compute, (value, prev) => …)`: compute is
tracked; the second function runs with its value at first, then each time compute runs again. Do
outside things (show) there.

    const bright = createMemo(() => lamp.level > 4, { name: "bright" })
    createEffect(() => bright(), (b) => show(b ? "bright" : "dim"))

**5. Handlers and calls** (ermine's). `createMethod(path, fn)`: fn answers each send to path, given
its arguments. `send(path, ...args)` gives fn's return (a promise, if fn is async). Solid's
`action(function* (…) { … })` gives an async function; `yield` a promise to wait for it.

    createMethod("./on/toggle", () => setLamp((draft) => { draft.on = !draft.on }))
    const time = send("/clock/now")

**6. State and waiting.** A memo's function may be async. A read with no value yet (an async memo,
or a send to a path with no handler yet) is not ready: the memo or effect that read it waits, and
runs again once it is; the setup is never run again (it stays not ready), so read and send those in
a memo or effect. `isPending(() => bright())` is true while what it reads is not ready. `latest(fn)`
gives fn's value now.

    createEffect(() => isPending(() => bright()), (p) => show(p ? "updating" : "ready"))

**7. Cleanup.** `onCleanup(fn)`: fn runs when what is running now goes (the program stopping, or a
memo or effect running again). An effect's second function may return a cleanup, run before its next
run.

    onCleanup(() => show("lamp off"))

**8. Why.** There is no word for this.
