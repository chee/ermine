// @ermine/system: ermine, one package [chee 10-26: "ermine/ermine is meant to be system"]:
// the process api, verb-first and mechanical [chee 10-25: "let's change the process api to be verb
// first … a very clear mechanical api"; "the let's do @ermine/system"], and createErmine, the host's
// (typescript/ermine.ts). each process api function finds its process from the scope open
// (typescript/registry.ts) and does its work as it (typescript/system/, where each is written);
// nothing open (a timer, a listener, after an await): nothing-open
//
//   import { createMemo, ensureNode, read } from "@ermine/system"
//   export default function setup() {
//     ensureNode("items", [])        // a bare name: inside this process's own node
//     return createMemo("count", () => (read("items") as unknown[]).length)
//   }
//
// paths: where a name a process gives lands. a bare name and ./ are not the same place:
//   items      a bare name: inside this process's node (its own; gone when it stops)
//   ./items    beside this process: in the folder its node is in
//   ../items   above that: in the folder that folder is in
//   /items     from this process's root (its box's "/"; no box: the graph's root)
// so ensureNode("./count") puts count next to the process, not in it; ensureNode("count") puts it
// in. for the host (no process) the root is its node: a bare name and ./ both land in the root
export { createNode, ensureNode, getNode, hasNode, ref } from "./typescript/system/nodes.ts"
export {
	list,
	peep,
	read,
	readAll,
	readAllAttributes,
	readAllChildren,
	readAttributes,
	readChildren,
	readEntries,
} from "./typescript/system/reading.ts"
export { patch, patchAttributes, patchChildren } from "./typescript/system/patching.ts"
export { explain, explainAttributes, explainChildren } from "./typescript/system/explaining.ts"
export { place, remove, rename, unplace } from "./typescript/system/names.ts"
export { createEffect, createMemo, pulse } from "./typescript/system/computing.ts"
export { createAction, executeAction, getCaller } from "./typescript/system/actions.ts"
export { addTeardown, createWriter, getArgs, start } from "./typescript/system/process.ts"
export { getStatus } from "./typescript/system/status.ts"
export type { System } from "./typescript/system/shapes.ts"
export type { Patch } from "./typescript/context.ts"
// the host's: createErmine, and the types hosts and features use
export * from "./typescript/ermine.ts"
export { PENDING } from "@ermine/reactivity"
export { REFUSED } from "@ermine/processes/guard"
