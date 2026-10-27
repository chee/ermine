// @ermine/system: ermine, one package [chee 10-26: "ermine/ermine is meant to be ermine/system"]:
// the process api, verb-first and mechanical [chee 10-25: "let's change the process api to be verb
// first … a very clear mechanical api"; "the let's do @ermine/system"], and createErmine, the host's
// (typescript/ermine.ts). each process api function finds its process from the scope open
// (typescript/registry.ts) and does its work as it (typescript/system.ts, where each is written);
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
export * from "./typescript/nodes.ts"
export * from "./typescript/reading.ts"
export * from "./typescript/patching.ts"
export * from "./typescript/explaining.ts"
export * from "./typescript/names.ts"
export * from "./typescript/computing.ts"
export * from "./typescript/actions.ts"
export * from "./typescript/process.ts"
export type { System } from "./typescript/system.ts"
// the host's: createErmine, and the types hosts and features use
export * from "./typescript/ermine.ts"
export { PENDING } from "@ermine/core/scheduler"
export { REFUSED } from "@ermine/core/places/guard"
