// The ermine harness's test features and answerers.
import type { Answerer } from "@ermine/places"
import type { Feature } from "./ermine.ts"

export function testFeature(
	spec: Record<string, unknown>,
	o: { log: (name: string, v: unknown) => void },
): Feature {
	return {
		name: spec.name as string,
		...spec.needs !== undefined && { needs: spec.needs as string[] },
		setup(f) {
			o.log("setups", spec.name)
			if (spec.early) void f.places
		},
	}
}

export function testAnswerer(
	spec: Record<string, unknown>,
	o: { log: (name: string, v: unknown) => void },
): Answerer {
	const name = spec.name as string
	return {
		from: name,
		read: (_part, id) => {
			o.log("answered", [name, id])
			if (spec.read === "throw") throw new Error(`${name} threw`)
			return spec.read === "add" ? [{ value: name, from: { kind: "test" } }] : []
		},
	}
}
