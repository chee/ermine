// An answerer for @ermine/system that makes readAll show what history holds beside what read shows
// (WIRE.md, assignments): the other cells at the path, and the other versions of the entry, each
// from the step that made it. The table's own value comes first; history's first cell is that one.
import type { Answerer } from "@ermine/places"
import type { History } from "./history.ts"

export function reading(history: Pick<History, "versions">): Answerer {
	return {
		from: "tippet-reading",
		read: (part, id, path) =>
			history.versions(String(id), part, path).slice(1).map((v) => ({
				value: v.value,
				from: { heads: v.from.heads },
				...(v.gone && { gone: true as const }),
			})),
	}
}
