// a helper in a file of its own, as a component library would be: it imports @ermine/system's
// functions and is given nothing; called from a setup, they find that setup's process
// (system_test.ts)
import { createMemo, read } from "@ermine/system"

export const countOf = (x: string) =>
	createMemo("count", () => Object.keys(read(x) as Record<string, unknown>).length)
