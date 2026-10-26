# Writing an ermine program (design L)

A program is a file whose default export is a function, run once as the program starts. Import the
words from `"ermine"`, in any file; use only this sheet's words (`show(text)` writes a line of
output). A task's own functions are the function's argument. A word finds your program only while
ermine runs your code: at a module's top level, in a timer or after an await, nothing is open (it
throws). Paths: `"./x"` is x in the working folder, `"/x"` from the root, a bare `"x"` in your node.

    import { open, read, show } from "ermine"; export default function ({ save }) { /* … */ }

**1. Getting nodes.** `open(path, value?)` gives the node at path. With a value, it is made holding
the value if nothing is there (what is there stays). Without one: the node there, maybe empty.

    const lamp = open("./lamp", { on: false, level: 3 })

**2. Reading.** `read(x, path?)` gives the value now (nothing there: undefined). Inside a memo or
effect it is tracked: that memo or effect runs again when the value changes. `peep(x)` is read,
untracked. `reads(x)` gives `[{ value, from }]`, the value and who wrote it. `list(x)` gives the
names under x.

    const level = read(lamp, ["level"])

**3. Writing.** `edit(x, change)`: a recipe, changing the draft (`(d) => { d.on = true }`) or
returning the new value (`(old) => old + 1`), or patches (`[{ path: ["on"], value: true }]`).
Nothing there: it is made.

    edit(lamp, (d) => { d.level = 5 })

**4. Computing.** `memo(name, f)` gives a node holding f's result, run again when what f read
changes; read it with `read`. `effect(name, f, act)`: f is tracked as a memo's; act(value, before)
runs with f's value at first, then each time it changes. Do outside things (show) in act.

    const bright = memo("bright", () => read(lamp).level > 4)
    effect("draw", () => read(bright), (b) => show(b ? "bright" : "dim"))

**5. Handlers and calls.** `method(path, fn)`: fn answers each send to path, given its arguments.
`send(path, ...args)` gives fn's return (a promise, if fn is async). An await: before it,
`const back = here()`; after, `back(() => edit(…))`. A component (a JSX tag's function, any file)
runs in a place of its own, and again by itself when what it read changes.

    method("./on/toggle", () => edit(lamp, (d) => { d.on = !d.on }))
    const time = send("/clock/now")
    // lamp.jsx: import { read } from "ermine"; export const Lamp = ({ at }) => <p>{read(at).on}</p>
    show(<Lamp at="./lamp" />) // once, in the setup; main.jsx: import { Lamp } from "./lamp.jsx"

**6. State and waiting.** A read of a node not there yet gives undefined; a memo or effect that read
it runs again once it is there. A send to a path with no handler yet throws `PENDING`: the memo or
effect that sent stops, and runs again once a handler is there; a setup stays pending, never run
again: send (and read memos) in a memo or effect. A memo's f may be async, or return `PENDING` for
"not yet"; reading a memo with no value yet throws `PENDING`. `status(x)` gives a memo's or effect's
`{ state: "done" | "pending" | "failed" | "looping", error? }`.

    effect("health", () => status(bright).state, (s) => show(s))

**7. Cleanup.** `teardown(fn)`: `fn(why)` runs when what is running now goes: the program stopping
(`"ended"`), or a memo or effect running again (`"replaced"`).

    teardown((why) => show(`lamp off: ${why}`))

**8. Why.** `why(x)` gives `{ change, by }`: `by.run` (a memo or effect wrote it; `by.computer` is
its node), `by.call` (a handler did; `by.handler`), or `by.outside` (anything else).

    const b = why(lamp)
