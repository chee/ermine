// helpers: what counts as a value a part gives, when two are the same, and why an effect part ran
import { GraphError } from "../../graph/ts/graph.ts"
import { isLive } from "../../programs/ts/records.ts"
import type { Proc } from "./types.ts"

export const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export const isPromise = (v: unknown) =>
	v !== null && (typeof v === "object" || typeof v === "function") &&
	typeof (v as { then?: unknown }).then === "function"

const isMap = (v: unknown) =>
	v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype

// why an effect part ran: its value not the same
export function whyNew(v: unknown, given: boolean): string {
	if (given) return "not equal by its comparison"
	if (Array.isArray(v)) return "a new list"
	if (v instanceof Uint8Array) return "new bytes"
	if (ArrayBuffer.isView(v)) return "a new typed array"
	if (isMap(v)) return "a new map"
	if (typeof v === "object" && v !== null || isLive(v)) return "a new live value"
	return "not equal"
}

// a value a part may give: anything but undefined; a setup's not a promise
export function valueOf(v: unknown, setup: boolean): unknown {
	if (v === undefined) throw new GraphError("wrong-field", "value: a part gives a value")
	if (setup && isPromise(v)) throw new GraphError("broken-promises", "a setup gives no promise")
	return v
}

// the same as the process's last value: by its own comparison, else Object.is
export const same = (p: Proc, v: unknown) =>
	p.last !== undefined && (p.equal ? p.equal(v, p.last.value) : Object.is(v, p.last.value))
