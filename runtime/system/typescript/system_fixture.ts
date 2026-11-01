// A helper in a file of its own, as a component library would be. It is given nothing and finds the
// process of the setup that calls it.
import { createMemo, read } from "@ermine/system"

export const countOf = (x: string) =>
	createMemo("count", () => Object.keys(read(x) as Record<string, unknown>).length)
