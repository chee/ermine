// @ermine/system: ermine, one package [chee 10-26: "ermine/ermine is meant to be ermine/system"]:
// the process api, verb-first and mechanical [chee 10-25: "let's change the process api to be verb
// first … a very clear mechanical api"; "the let's do @ermine/system"], and createErmine, the host's
// (typescript/ermine.ts). each process api function finds its process from the scope open
// (typescript/registry.ts) and does its work as it (typescript/system.ts, where each is written);
// nothing open (a timer, a listener, after an await): nothing-open
//
//   import { createMemo, ensureNode, read } from "@ermine/system"
//   export default function setup() {
//     ensureNode("./items", [])
//     return createMemo("count", () => (read("./items") as unknown[]).length)
//   }
import { foundFor, type System, systemFrom } from "./typescript/system.ts"

const system = systemFrom(foundFor)

export const getNode: System["getNode"] = system.getNode
export const hasNode: System["hasNode"] = system.hasNode
export const ensureNode: System["ensureNode"] = system.ensureNode
export const createNode: System["createNode"] = system.createNode
export const ref: System["ref"] = system.ref
export const read: System["read"] = system.read
export const readAttributes: System["readAttributes"] = system.readAttributes
export const readChildren: System["readChildren"] = system.readChildren
export const readAll: System["readAll"] = system.readAll
export const readAllAttributes: System["readAllAttributes"] = system.readAllAttributes
export const readAllChildren: System["readAllChildren"] = system.readAllChildren
export const readEntries: System["readEntries"] = system.readEntries
export const peep: System["peep"] = system.peep
export const patch: System["patch"] = system.patch
export const patchAttributes: System["patchAttributes"] = system.patchAttributes
export const patchChildren: System["patchChildren"] = system.patchChildren
export const explain: System["explain"] = system.explain
export const explainAttributes: System["explainAttributes"] = system.explainAttributes
export const explainChildren: System["explainChildren"] = system.explainChildren
export const place: System["place"] = system.place
export const unplace: System["unplace"] = system.unplace
export const rename: System["rename"] = system.rename
export const list: System["list"] = system.list
export const createMemo: System["createMemo"] = system.createMemo
export const createEffect: System["createEffect"] = system.createEffect
export const watch: System["watch"] = system.watch
export const createAction: System["createAction"] = system.createAction
export const executeAction: System["executeAction"] = system.executeAction
export const getCaller: System["getCaller"] = system.getCaller
export const getStatus: System["getStatus"] = system.getStatus
export const addTeardown: System["addTeardown"] = system.addTeardown
export const createBox: System["createBox"] = system.createBox
export const getArgs: System["getArgs"] = system.getArgs
export type { System } from "./typescript/system.ts"
// the host's: createErmine, and the types hosts and features use
export * from "./typescript/ermine.ts"
export { PENDING } from "@ermine/core/scheduler"
export { REFUSED } from "@ermine/core/places/guard"
