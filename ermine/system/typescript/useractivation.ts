// whether a person just interacted with the page: navigator.userActivation.isActive (transient
// activation), read through the UserActivation getter and the navigator.userActivation object as they
// were as this module loads, before any program runs, so a program that replaces either can't say a
// person did it. a writer (system.ts createWriter) asks it as it runs. all it promises is "a person
// had just interacted with the page when this was written" [chee 10-27]. (window.event.isTrusted is
// also true for events the browser fires itself, so it says nothing of a person.) no
// navigator.userActivation (deno, an old browser): never
const activation = (globalThis as { navigator?: { userActivation?: object } }).navigator
	?.userActivation
const proto = (globalThis as { UserActivation?: { prototype: object } }).UserActivation?.prototype
const native = proto === undefined
	? undefined
	: Object.getOwnPropertyDescriptor(proto, "isActive")?.get

export const userActivated = (): boolean =>
	activation !== undefined && native !== undefined && native.call(activation) === true
