// Addresses as strings: "/notes/today" is ["/", "notes", "today"]. The path tag makes each value one name.
import { PlacesError } from "./places.ts"

export type Address = readonly string[]

export function plan(address: Address): string[] | undefined {
	let names: string[] = []
	for (const step of address) {
		if (step === ".") continue
		if (step === "/") names = []
		else if (step !== "..") names.push(step)
		else if (names.length) names.pop()
		else return undefined
	}
	return names
}

export function parse(s: string): string[] {
	const out: string[] = s.startsWith("/") ? ["/"] : []
	for (const piece of s.split("/")) if (piece !== "") out.push(piece)
	return out
}

export const address = (a: string | Address): Address => typeof a === "string" ? parse(a) : a

export function path(strings: TemplateStringsArray, ...names: unknown[]): string[] {
	const out: string[] = []
	for (let i = 0; i < strings.length; i++) {
		const steps = parse(strings[i])
		if (i > 0 && steps[0] === "/") steps.shift()
		out.push(...steps)
		if (i < names.length) {
			const name = String(names[i])
			if (name === "" || name === "." || name === ".." || name === "/") {
				throw new PlacesError("not-a-name", name)
			}
			out.push(name)
		}
	}
	return out
}
