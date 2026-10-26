// the ermine harness's test features (ermine_harness.ts says each), in a file of their own: a
// feature's files and its setup's file are skipped by the sites, so a feature beside the
// programs would make their lines no site
import { Refusal } from "@ermine/places/guard"
import { no } from "@ermine/protect"
import type { Feature, Hook, ProcessContext } from "./ermine.ts"

export function testFeature(
	spec: Record<string, unknown>,
	o: {
		log: (name: string, v: unknown) => void
		slots: Map<string, (o: ProcessContext | undefined) => unknown>
		late: Map<string, () => void>
	},
): Feature {
	const { log, slots, late } = o
	const name = spec.name as string
	const say = (hook: Hook, ...more: unknown[]) => log("hooks", [name, hook, ...more])
	const boom = () => {
		throw new Error(`${name} threw`)
	}
	return {
		name,
		...spec.needs !== undefined && { needs: spec.needs as string[] },
		files: [import.meta.url],
		setup(f) {
			if (spec.early) void f.places
			if (spec.late) late.set(name, () => f.onWrite((o, wr, next) => next(o, wr)))
			if (spec.onTable) {
				f.onTable((t, next) => {
					say("onTable")
					if (spec.onTable === "throw") boom()
					return next(t)
				})
			}
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
			const slot = spec.slot ? f.reserveSlot<number>() : undefined
			if (slot) slots.set(name, (o) => o === undefined ? undefined : slot.get(o))
			let matched = 0
			if (spec.onWrite || slot) {
				f.onWrite((o, wr, next) => {
					if (slot) slot.set(o, (slot.get(o) ?? 0) + 1)
					const how = spec.onWrite
					if (how === undefined) return next(o, wr)
					// only: "host": only the host's context's writes
					if (spec.only === "host" && o.process !== undefined) return next(o, wr)
					// ids, parts: only writes to these nodes, these parts; takes: only writes taking
					// something out (an entry gone, or every patch with no value and no move)
					if (Array.isArray(spec.ids) && !spec.ids.includes(wr.id)) return next(o, wr)
					if (Array.isArray(spec.parts) && !spec.parts.includes(wr.part)) return next(o, wr)
					const out = wr.gone ||
						wr.patches.every((p) => !("value" in p) && p.move === undefined)
					if (spec.takes && !out) return next(o, wr)
					// times: the first so many it matches only
					if (typeof spec.times === "number" && matched++ >= spec.times) return next(o, wr)
					if (wr.gone) say("onWrite", wr.part, wr.id, "gone")
					else say("onWrite", wr.part, wr.id)
					if (how === "throw") boom()
					if (how === "drop") return
					if (how === "copy") return next(o, { ...wr })
					if (how === "refuse") {
						throw new Refusal(no(`${name} refused`), {
							who: undefined,
							op: "edit",
							target: { id: wr.id },
						})
					}
					next(o, wr)
				})
			}
			if (spec.onTeardown) {
				f.onTeardown((sc, why, next) => {
					say("onTeardown", why)
					const how = spec.onTeardown
					if (how === "throw") boom()
					if (how === "drop") return
					if (how === "why") return next(sc, `${name}:${why}`)
					next(sc, why)
				})
			}
			if (spec.onStatus) {
				f.onStatus((x, st, next) => {
					say("onStatus", x.id)
					const how = spec.onStatus
					if (how === "throw") boom()
					if (how === "drop") return st
					const out = next(x, st)
					return how === "add" && out !== undefined ? { ...out, [name]: true } : out
				})
			}
			if (spec.onRecord) {
				f.onRecord((r, next) => {
					say("onRecord", r.run ? "run" : "call", r.id, (r.run ?? r.call)!.end)
					const how = spec.onRecord
					if (how === "throw") boom()
					if (how === "drop") return
					next(r)
				})
			}
		},
	}
}
