// boot: the page den. a den whose processes get ermine/api's api, offering two runners for one form
// (javascript source) and two apis, and the page's element as a surface
//
//   const page = createPageDen({ scheduler, table, places, scopes, id: "tab-91aa", root: el })
//   page.den                   // /system/dens/tab-91aa, at /system/den too
//   //   runners/javascript      { takes: javascript source, api: ermine.api }      apis.run
//   //   runners/patchwork-tool  { takes: javascript source, api: patchwork.tool }  runner.ts
//   //   surfaces/root           { kind: dom }                                      root (given)
//   page.surface               // surfaces/root's offer (none without root)
//
//   const host = createHost()  // a world for one page: { scheduler, table, places, scopes, scope, hosted }
//
// createHost(root = "R"): a scheduler, a table, places from root (processes' rows first, then
// children; root's children made, empty), scope nodes, and the host's scope { actor: "host" };
// hosted(f): f with it open
// createPageDen(setup), a scope open: ermine/api's apis over the host (its places, table, scheduler,
// commit: setup.commit, else places.commit), the den made with their createProcessAPI, each api
// made noted with its Context (what the patchwork-tool runner asks for); api.start is not this
// den's (programs: none) and throws. closing the den is the host's: page.den.close()
import { createProcessAPIs, type ProcessAPIs } from "@ermine/api"
import createEntry, { type Entry } from "@ermine/node/entry"
import { children, createPlaces, type Id, type Places } from "@ermine/places"
import { createChangeHeader } from "@ermine/places/header"
import { processes } from "@ermine/processes"
import { createScopeNodes, type ScopeNodes } from "@ermine/processes/scopes"
import { createScheduler, type Scheduler, type Scope } from "@ermine/scheduler"
import { createPaths } from "@ermine/scheduler/paths"
import { createTable, type Key, type Table } from "@ermine/table"
import {
	API,
	type Context,
	createDen,
	type Den,
	KIND,
	type Offered,
	type Setup as DenSetup,
	TAKES,
} from "@ermine/dens"
import { createToolRunner, type Element, JS, TOOL_API } from "./runner.ts"

export type World = {
	readonly scheduler: Scheduler
	readonly table: Table
	readonly places: Places
	readonly scopes: ScopeNodes
	readonly scope: Scope
	hosted: <T>(f: () => T) => T
}

export function createHost(root: Id = "R"): World {
	const scheduler = createScheduler()
	const table = createTable((part, id) => places.onTableChange(part as Key, id))
	const places: Places = createPlaces({
		root,
		table,
		paths: createPaths<unknown>(),
		scheduler,
		contributors: [processes(root), children],
	})
	scheduler.onTrackingEnd((key) => places.release(key))
	const scopes = createScopeNodes({ scheduler, table })
	const scope = scheduler.createRootScope({ actor: "host" })
	const hosted = <T>(f: () => T): T => scheduler.runWithScope(scope, f)
	hosted(() => table.add("children", root, createEntry({}, createChangeHeader(scheduler))))
	return { scheduler, table, places, scopes, scope, hosted }
}

export type Setup = Omit<DenSetup, "createProcessAPI"> & {
	root?: Element
	// how ermine/api asks for a pulse (none: queueMicrotask)
	schedule?: (f: () => void) => void
}

export type Page = {
	readonly den: Den
	readonly apis: ProcessAPIs
	readonly surface?: Offered
}

export function createPageDen(setup: Setup): Page {
	const { scheduler, table, places } = setup
	const commit = setup.commit ?? ((changed: readonly Entry<unknown>[]) => places.commit(changed))
	const contexts = new WeakMap<object, Context>()
	const apis = createProcessAPIs({
		scheduler,
		table,
		commit,
		host: { places, table, scheduler, commit },
		programs: () => {
			throw new Error("the page den starts processes, not programs")
		},
		...(setup.schedule === undefined ? {} : { schedule: setup.schedule }),
	})
	const den = createDen({
		...setup,
		createProcessAPI: (ctx) => {
			const api = apis.createProcessAPI(ctx)
			contexts.set(api, ctx)
			return api
		},
	})
	const contextOf = (api: unknown) =>
		typeof api === "object" && api !== null ? contexts.get(api) : undefined
	den.offer("runners", "javascript", { [TAKES]: JS, [API]: "ermine.api" }, apis.run)
	den.offer(
		"runners",
		"patchwork-tool",
		{ [TAKES]: JS, [API]: TOOL_API },
		createToolRunner(contextOf),
	)
	let surface: Offered | undefined
	if (setup.root !== undefined) {
		const o = den.offer("surfaces", "root", { [KIND]: "dom" }, setup.root)
		if (!("refused" in o)) surface = o
	}
	return { den, apis, ...(surface === undefined ? {} : { surface }) }
}
