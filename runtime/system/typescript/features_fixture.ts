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
			if (spec.onId) {
				f.onId((kind, next) => {
					say("onId", kind)
					if (spec.onId === "throw") boom()
					if (spec.onId === "throw-process" && kind === "process") boom()
					const id = next(kind)
					return spec.onId === "wrap" ? `${name}-${id}` : id
				})
			}
			if (spec.onCreateFunction) {
				f.onCreateFunction((made, next) => {
					say("onCreateFunction", made.kind, made.id)
					if (spec.onCreateFunction === "throw") boom()
					if (spec.onCreateFunction === "drop") return
					next(made)
				})
			}
		},
	}
}
