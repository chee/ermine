// files url folder (FILES.tex, A folder that is not a store): a device host that lays a shared
// document out in a folder, with the files program on it, and syncs it through Subduction.
//
// Left out of the port to today's graph. It was written on the old scheduler's nodes with versions
// (intro, versions, ephemeral, a process placed in a slot) and on the old sync wiring; core's graph
// has neither, and sync is being rewritten for it (extensions/subduction/plan.org). The folder half
// is here: store.ts's mirror, the files program (program.ts) and its watcher (watch.ts), on
// graph.ts. What is missing is the sync half, which waits for the rewrite. The old file is in git.
export {}
