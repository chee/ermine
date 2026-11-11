// The ermine harness's test features.
import type { Feature, Hook } from "./ermine.ts"

export function testFeature(
	spec: Record<string, unknown>,
	o: {
		log: (name: string, v: unknown) => void
	},
): Feature {
	const { log } = o
	const name = spec.name as string
	const say = (hook: Hook, ...more: unknown[]) => log("hooks", [name, hook, ...more])
	const boom = () => {
		throw new Error(`${name} threw`)
	}
	return {
		name,
		...spec.needs !== undefined && { needs: spec.needs as string[] },
		setup(f) {
			if (spec.early) void f.places
			if (spec.onRead) {
				f.onRead((x, items, next) => {
					say("onRead", x.id)
					const how = spec.onRead
					if (how === "throw") boom()
					if (how === "drop") return []
					if (how === "add") {
						return next(x, [...items, { value: name, from: { kind: "test" } }])
					}
					return next(x, items)
				})
			}
		},
	}
}
