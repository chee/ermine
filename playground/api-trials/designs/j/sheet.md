# Writing an ermine program (design J)

A program is one file whose default export is a function, run once as the program starts. Its words
are globals: use them as they are. They are also on `api`, the function's argument, if you'd rather
destructure. Use only this sheet's words, plus `show(text)`, which writes a line of output (a task
may name more functions, globals too). No imports. Paths: `"./x"` is x in the working folder, `"/x"`
is from the root, a bare `"x"` is inside the program's own node.

    export default function () { const lamp = open("./lamp"); /* … */ }

**1. Getting nodes.** `open(path, value?)` gives a handle (a function) on the node at path. With a
value, it is made holding it if nothing is there (what is there stays). Without: maybe empty.

    const lamp = open("./lamp", { on: false, level: 3 })

**2. Reading.** `lamp()` gives the value now (nothing there yet: undefined). Inside a memo or effect
it is tracked: that memo or effect runs again when the value changes.

    const level = lamp().level

**3. Writing.** `lamp(value)` replaces the value (any value but a function). `lamp(recipe)` edits:
the recipe changes the draft (`(d) => { d.on = true }`) or returns the new value
(`(old) => old + 1`), and a changed draft wins. Nothing there: it is made (a recipe gets undefined).

    lamp((d) => { d.level = 5 })

**4. Computing.** `memo(name, f)` gives a handle on a node holding f's result, run again when what f
read changes; call it to read. `effect(name, f, act)`: f is tracked as a memo's;
`act(value, before)` runs with f's value at first, then each time it changes. Do outside things
(show) in act.

    const bright = memo("bright", () => lamp().level > 4)
    effect("draw", () => bright(), (b) => show(b ? "bright" : "dim"))

**5. Handlers and calls.** `method(path, fn)`: fn answers each send to path, given its arguments.
`send(path, ...args)` gives fn's return (a promise, if fn is async).

    method("./on/toggle", () => lamp((d) => { d.on = !d.on }))
    const time = send("/clock/now")

**6. State and waiting.** A read of a node not there yet gives undefined, and so does a memo with no
value yet; a memo or effect that read it runs again once it is there. A send to a path with no
handler yet stops the memo or effect that sent, and runs it again once a handler is there; a setup
that sent stays stopped and is never run again, so send in a memo or effect. A memo's f may be
async. Handlers may be async.

    effect("there", () => lamp() !== undefined, (yes) => show(yes ? "lamp" : "no lamp yet"))

**7. Cleanup.** There is no word for this.

**8. Why.** There is no word for this.
