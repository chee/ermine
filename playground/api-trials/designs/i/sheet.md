# Writing an ermine program (design I)

A program is one file whose default export is a function, run once as the program starts. Its words
are globals: use them as they are. They are also on `api`, the function's argument, if you'd rather
destructure. Use only this sheet's words, plus `show(text)`, which writes a line of output (a task
may name more functions, globals too). No imports. Paths: `"./x"` is x in the working folder, `"/x"`
is from the root, a bare `"x"` is inside the program's own node.

    export default function () { const lamp = open("./lamp"); /* … */ }

**1. Getting nodes.** `open(path, value?)` gives a handle (a function) on the node at path. With a
value, it is made holding it if nothing is there (what is there stays). Without: maybe empty.

    const lamp = open("./lamp", { on: false, level: 3 })

**2. Reading.** `lamp()` gives the value now (nothing there: undefined). Inside a memo or effect it
is tracked: that memo or effect runs again when the value changes. `lamp.peep()` is the same,
untracked. `getReads(lamp)` gives `[{ value, from }]`, the value and who wrote it. `list(lamp)`
gives the names under it.

    const level = lamp().level

**3. Writing.** `lamp(value)` replaces the value (any value but a function). `lamp(recipe)` edits:
the recipe changes the draft (`(d) => { d.on = true }`) or returns the new value
(`(old) => old + 1`), and a changed draft wins. Nothing there: it is made (a recipe gets undefined).

    lamp((d) => { d.level = 5 })

**4. Computing.** `createMemo(name, f)` gives a handle on a node holding f's result, run again when
what f read changes; call it to read. `createEffect(name, f, act)`: f is tracked as a memo's;
`act(value, before)` runs with f's value at first, then each time it changes. Do outside things
(show) in act.

    const bright = createMemo("bright", () => lamp().level > 4)
    createEffect("draw", () => bright(), (b) => show(b ? "bright" : "dim"))

**5. Handlers and calls.** `createMethod(path, fn)`: fn answers each send to path, given its
arguments. `send(path, ...args)` gives fn's return (a promise, if fn is async).

    createMethod("./on/toggle", () => lamp((d) => { d.on = !d.on }))
    const time = send("/clock/now")

**6. State and waiting.** A read of a node not there yet gives undefined; a memo or effect that read
it runs again once it is there. A send to a path with no handler yet throws `PENDING`: the memo or
effect that sent stops, and runs again once a handler is there; a setup stays pending, never run
again: send (and read memos) in a memo or effect. A memo's f may be async, or return `PENDING` for
"not yet"; reading a memo with no value yet throws `PENDING`. Handlers may be async. `getStatus(x)`
gives a memo's or effect's `{ state: "done" | "pending" | "failed" | "looping", error? }`.

    createEffect("health", () => getStatus(bright).state, (s) => show(s))

**7. Cleanup.** `teardown(fn)`: `fn(why)` runs when what is running now goes: the program stopping
(`"ended"`), or a memo or effect running again (`"replaced"`).

    teardown((why) => show(`lamp off: ${why}`))

**8. Why.** `getWhy(x)` gives `{ change, by }`: `by.run` (a memo or effect wrote it; `by.computer`
is its node), `by.call` (a handler did; `by.handler`), or `by.outside` (anything else).

    const b = getWhy(lamp)
