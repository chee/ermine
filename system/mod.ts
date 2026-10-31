// @ermine/system: the process API and createErmine for hosts. Each function finds the process
// it runs for from the open scope; called with nothing open (a timer, a listener, after an await)
// it throws nothing-open.
//
//   import { createMemo, ensureNode, read } from "@ermine/system"
//   export default function setup() {
//     ensureNode("items", [])        // a bare name: inside this process's own node
//     return createMemo("count", () => (read("items") as unknown[]).length)
//   }
//
// Paths. A bare name and ./ are not the same place:
//   items      a bare name: inside this process's node (its own; gone when it stops)
//   ./items    beside this process: in the folder its node is in
//   ../items   above that: in the folder that folder is in
//   /items     from the graph's root
// For the host (no process) both a bare name and ./ land in the root.
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
