// what a site costs at the create: nothing recorded, the stack held unread (what sites.ts does),
// and the stack parsed at once (util's capture). deno bench ermine/sites
import { createScheduler } from "@ermine/scheduler"
import { capture } from "@ermine/util/stacktrace"
import { createSites } from "./sites.ts"
import { INFO } from "./sites_fixture.ts"

const scheduler = createScheduler()
const sited = createSites(scheduler)
const ours = new Set<string>([import.meta.url])
const root = scheduler.createRootScope(INFO)
const inside = <T>(f: () => T) => scheduler.runWithScope(root, f)
const noop = () => {}

// scopes are made and torn down at once, so the scheduler's tree stays small
Deno.bench("scope, unwrapped", () => {
	scheduler.teardown(scheduler.createScope(INFO, root))
})
Deno.bench("scope, held unread (used)", () => {
	scheduler.teardown(sited.createScope(INFO, root))
})
Deno.bench("scope, held then parsed (siteOf asked)", () => {
	const s = sited.createScope(INFO, root)
	sited.siteOf(s)
	scheduler.teardown(s)
})
// parsed at once: the same capture, then util's outside() on it, as the create's own work
function eager() {
	const site = capture(ours, eager)
	const s = scheduler.createScope(INFO, root)
	scheduler.teardown(s)
	return site
}
Deno.bench("scope, parsed at once", () => {
	eager()
})
Deno.bench("computer, unwrapped", () => {
	inside(() => scheduler.teardown(scheduler.createComputer(noop, noop)))
})
Deno.bench("computer, held unread (used)", () => {
	inside(() => scheduler.teardown(sited.createComputer(noop, noop)))
})
