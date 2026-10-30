// Whether a person just interacted with the page (navigator.userActivation.isActive). The getter
// and object are read when this module loads, before any program runs, so a program that replaces
// them cannot claim a person did it. Never active without navigator.userActivation.
const activation = (globalThis as { navigator?: { userActivation?: object } }).navigator
	?.userActivation
const proto = (globalThis as { UserActivation?: { prototype: object } }).UserActivation?.prototype
const native = proto === undefined
	? undefined
	: Object.getOwnPropertyDescriptor(proto, "isActive")?.get

export const userActivated = (): boolean =>
	activation !== undefined && native !== undefined && native.call(activation) === true
