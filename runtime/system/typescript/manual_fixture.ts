// a test feature: no pulse runs on its own; a test runs one with pulse() when it means to
import type { Feature } from "./features.ts"

export const manual: Feature = {
	name: "manual",
	setup: (f) => f.onSchedule(() => {}),
}
