// the words as imports, in any file: `import { read, edit } from "@ermine/ermine/words"`. none
// belongs to a process: each, as it is called, finds its process from the scope open now, as
// Solid's createSignal finds its owner [chee 10-25: "let's make the api a thing you import"].
//
//   import { memo, read } from "@ermine/ermine/words"
//   export default function setup() {
//     return memo("total", () => read("./items").length)
//   }
//
// found: a setup, a memo's or effect's run or act, a call, a teardown, all under their process's
// scope; the host's scope, the host's words (host code: ermine.getProcessContext().within(f)).
// nothing open (a module's top level, a timer, a listener, after an await): nothing-open, naming
// the word. the registry is registry.ts's, module state, never on a global and not exported from
// the package: a program can't reach the scheduler or another process's words through it [chee
// 10-25: "we cannot make the graph available on global like that"]. module identity: one copy of
// registry.ts, through the import map
import type { API } from "./words.ts"
import { found } from "./registry.ts"

type Word = Exclude<keyof API, "args" | "PENDING" | "REFUSED">
const word = <K extends Word>(name: K): API[K] =>
	((...a: unknown[]) => (found(name)[name] as (...a: unknown[]) => unknown)(...a)) as API[K]

export const open: API["open"] = word("open")
export const create: API["create"] = word("create")
export const make: API["make"] = word("make")
export const read: API["read"] = word("read")
export const peep: API["peep"] = word("peep")
export const reads: API["reads"] = word("reads")
export const entries: API["entries"] = word("entries")
export const list: API["list"] = word("list")
export const info: API["info"] = word("info")
export const edit: API["edit"] = word("edit")
export const watch: API["watch"] = word("watch")
export const place: API["place"] = word("place")
export const unplace: API["unplace"] = word("unplace")
export const move: API["move"] = word("move")
export const memo: API["memo"] = word("memo")
export const effect: API["effect"] = word("effect")
export const early: API["early"] = word("early")
export const method: API["method"] = word("method")
export const send: API["send"] = word("send")
export const teardown: API["teardown"] = word("teardown")
export const ref: API["ref"] = word("ref")
export const box: API["box"] = word("box")
export const status: API["status"] = word("status")
export const explain: API["explain"] = word("explain")
export const getCaller: API["getCaller"] = word("getCaller")
export const pulse: API["pulse"] = word("pulse")
// the process's args (a value on the api, a word here)
export const getArgs = (): readonly string[] => found("args").args
export { PENDING } from "@ermine/core/scheduler"
export { REFUSED } from "@ermine/places/guard"
