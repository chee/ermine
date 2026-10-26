// a helper in a file of its own, as a component library would be: it imports its words and is
// given no api; called from a setup, its words find that setup's process (found_test.ts)
import { memo, read } from "./found.ts"

export const countOf = (x: string) =>
	memo("count", () => Object.keys(read(x) as Record<string, unknown>).length)
