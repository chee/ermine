// whether a person's event is being dispatched now: the browser's own `event` (window.event), read
// through the native getter kept as this module loads, before any program runs, so a program that
// replaces window.event can't say a person did it. a writer (system.ts createWriter) asks it as it
// runs. it means "a trusted event was being dispatched", less than "a person did this"
// [chee 10-27: "duringUserEvent is good yeah do that"]. no `window` (a server, a worker): never
const native = Object.getOwnPropertyDescriptor(globalThis, "event")?.get?.bind(globalThis)

export const duringUserEvent = (): boolean => (native?.() as Event | undefined)?.isTrusted === true
