# Writing an ermine program (design D)

A program is one file whose default export is a function, run once as the program starts. It is
given `api`: take your words from it. Use only this sheet's words, plus `show(text)`, which writes a
line of output (a task may name more functions in `api`). No imports. Paths: `"./x"` is x in the
working folder, `"/x"` is from the root, a bare `"x"` is inside the program's own node.

    export default function (api) { const { open, show } = api; /* … */ }

**1. Getting nodes.** `open(path, value?)` gives a handle on the node at path. With a value, the
node is made holding it if nothing is there (what is there stays). Without one: the node there,
maybe empty. `lamp.info()` is a handle on its attributes.

    const lamp = open("./lamp", { on: false, level: 3 })

**2. Reading.** `lamp.read()` gives the value now (nothing there: undefined). Inside a memo or
effect it is tracked: that memo or effect runs again when the value changes. `lamp.peep()` is the
same, untracked. `lamp.reads()` gives `[{ value, from }]`, the value and who wrote it. `lamp.list()`
gives the names under it.

    const level = lamp.read().level

**3. Writing.** `lamp.set(value)` replaces the value. `lamp.edit(change)`: a recipe, changing the
draft (`(d) => { d.on = true }`) or returning the new value (`(old) => old + 1`), or patches
(`[{ path: ["on"], value: true }]`). The node must be there.

    lamp.edit((d) => { d.level = 5 })

**4. Computing.** `memo(name, f)` gives a handle on a node holding f's result, run again when what f
read changes; `.read()` it. `effect(name, f, act)`: f is tracked as a memo's; `act(value,
before)`
runs with f's value at first, then each time it changes. Do outside things (show) in act.

    const bright = memo("bright", () => lamp.read().level > 4)
    effect("draw", () => bright.read(), (b) => show(b ? "bright" : "dim"))

**5. Handlers and calls.** `method(path, fn)`: fn answers each send to path, given its arguments.
`send(path, ...args)` gives fn's return (a promise, if fn is async).

    method("./on/toggle", () => lamp.edit((d) => { d.on = !d.on }))
    const time = send("/clock/now")

**6. State and waiting.** A read of a node not there yet gives undefined; a memo or effect that read
it runs again once it is there. A send to a path with no handler yet throws `PENDING`: the memo or
effect that sent stops, and runs again once a handler is there; a setup stays pending, never run
again: send (and read memos) in a memo or effect. A memo's f may be async, or return `PENDING` for
"not yet"; reading a memo with no value yet throws `PENDING`. Handlers may be async. A memo's or
effect's `bright.status()`: `{ state: "done" | "pending" | "failed" | "looping", error? }`.

    effect("health", () => bright.status().state, (s) => show(s))

**7. Cleanup.** `teardown(fn)`: `fn(why)` runs when what is running now goes: the program stopping
(`"ended"`), or a memo or effect running again (`"replaced"`).

    teardown((why) => show(`lamp off: ${why}`))

**8. Why.** `lamp.why()` gives `{ change, by }`: `by.run` (a memo or effect wrote it; `by.computer`
is its node), `by.call` (a handler did; `by.handler`), or `by.outside` (anything else).

    const b = lamp.why()
