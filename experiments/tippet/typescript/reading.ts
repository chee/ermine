// A feature for @ermine/system that makes readAll show what history holds beside what read shows
// (WIRE.md, assignments): the other cells at the path, and the other versions of the entry. Position
// 0 is read's; the rest come from here, each from the step that made it.
import type { Feature } from "@ermine/system/features"
import type { History } from "./history.ts"

export function reading(history: Pick<History, "versions">): Feature {
	return {
		name: "tippet-reading",
		setup(feature) {
			feature.onRead((x, items, next) => {
				const rest = history.versions(String(x.id), x.part, x.path).slice(1).map((v) => ({
					value: v.value,
					from: { feature: "tippet-reading", heads: v.from.heads },
					...(v.gone && { gone: true as const }),
				}))
				return next(x, [...items, ...rest])
			})
		},
	}
}
