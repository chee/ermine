// the finder in the devtools: its own ermine in the panel, the finder (finder.tsx, copied from
// ermine-mac as it is) a program in it, and the host's side of the graph it explores. this is the
// one seam changed: ermine-mac's graphs.ts answers "page" from the page's own ermine in the same
// window (pageGraph) and "mac" over the relay; here "page" is the inspected page, asked through the
// devtools' channel (the eval bridge, the devtools page's in Safari): the agent there answers each
// ask with the same pageGraph, run on the ermine the page answered with (pagegraph.ts). the
// actions, the inbox and the clocks are graphs.ts' own, as connectGraphs makes them.
//
// loaded into the panel as finder.js, beside panel.js; the panel finds it at
// globalThis.ermineFinder (the panel's own window, not the page's)
import {
	createAction,
	createErmine,
	ensureNode,
	type Ermine,
	executeAction,
	patch,
	peep,
	read,
} from "@ermine/system";
import { render } from "@ermine/render/dom";
import { Explorer } from "./finder.tsx";
import { graphAt, type GraphName, inboxOf, NOW, TICK } from "./graphs.ts";
import { BROWSER, den, DENS, page, SHOWING, shows } from "./places.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
// a node's value, set; and read untracked. @ermine/system's functions: called where something is
// open (an action), or from host code inside ermine.within
const set = (path: string, value: unknown) => {
	ensureNode(path);
	patch(path, [{ path: [], value }]);
};
const now = <T>(path: string): T | undefined => peep(() => read(path) as T);
/** an ask of the finder's, handed to the inspected page's agent: what came back */
export type Asker = (op: "ask" | "change", m: Any) => Promise<Any>;

const NAME = "graph";
const CODE = "/code/finder";

export function mountFinder(into: Element, asker: Asker) {
	const ermine = createErmine({ host: { at: "/host" } });

	// what places.ts and the finder expect to be there (main.ts' seeds that the finder reads)
	ermine.within(() => {
		ensureNode(DENS);
		ensureNode(den(BROWSER, "about"), { name: "the devtools", what: "a devtools panel" });
		ensureNode(page("relay"), null);
		ensureNode(page("mode"), "graph");
		ensureNode(page("in"), false);
		ensureNode(page("shown"), []);
		ensureNode("/code", {});
	});

	const stopClocks = connect(ermine, asker);

	const box = into.appendChild(document.createElement("div"));
	box.className = "area-slot";
	const call = (action: Any, ...args: unknown[]) =>
		ermine.within(() => executeAction(action, ...args));
	const running = ermine.start(function finder() {
		render(box, Explorer({ name: NAME, label: "graph", graph: "page" }), {
			// the process's path: what its bindings' paths are said from
			name: CODE,
			call,
		});
	}, CODE);
	if ("refused" in running) throw new Error(`the finder's place is taken: ${CODE}`);

	const at = `${page(`finder/${NAME}`)}/at`;
	return {
		/** shown or hidden: hidden, its clocks stop (places.ts' shows) */
		showing(on: boolean) {
			ermine.within(() => {
				if (now(page("mode")) !== (on ? "graph" : "")) set(page("mode"), on ? "graph" : "");
			});
		},
		/** the place picked: a path from the root, or "#<id>" */
		at: () => ermine.within(() => now<string>(at)),
		/** go to a place, as a click in the finder does */
		go: (place: string) => call(`${CODE}/on/finder-${NAME}-go`, place),
		/** gone: its program stopped, its clocks too, its box out of the panel (another graph is
		 * shown: a finder of its own) */
		stop() {
			stopClocks();
			running.stop();
			box.remove();
		},
	};
}

// graphs.ts' connectGraphs, its "page" side through the devtools' channel; no "mac"
function connect(ermine: Ermine, asker: Asker) {
	let told = 0;
	const tell = (graph: GraphName, name: string, m: Any) => {
		const at = inboxOf(graph, name);
		const was = now<{ n: number; m: Any }[]>(at) ?? [];
		set(at, [...was, { n: ++told, m }]);
	};
	// told from host code (an answer come back, the clipboard's): nothing is open there
	const hostTell = (graph: GraphName, name: string, m: Any) =>
		ermine.within(() => tell(graph, name, m));
	const named = (name: unknown): name is string =>
		typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/i.test(name);
	let asked = 0;
	const explorers = new Set<string>();
	const graph: GraphName = "page";
	const G = graphAt(graph);
	// an ask sent to the page; what came back, or why nothing did, told to the explorer
	const send = (op: "ask" | "change", name: string, m: Any, ask: string) =>
		asker(op, { ...m, ask }).then(
			(r) =>
				hostTell(
					graph,
					name,
					r && typeof r === "object" && !r.gone ? r : {
						do: m?.do,
						ask,
						path: m?.path,
						error: r?.gone ? "the page's graph is gone (it answers no more)" : "no answer",
					},
				),
			(err) =>
				hostTell(graph, name, {
					do: m?.do,
					ask,
					path: m?.path,
					error: String(err?.message ?? err),
				}),
		);
	ermine.within(() => {
		ensureNode(`${G}/inbox`);
		createAction(`${G}/ask`, (name: string, m: Any) => {
			if (!named(name)) throw new Error(`no explorer is called ${String(name)}`);
			explorers.add(name);
			ensureNode(inboxOf(graph, name), []);
			const ask = `x${++asked}`;
			queueMicrotask(() => void send("ask", name, m, ask));
			return ask;
		});
		createAction(`${G}/change`, (name: string, m: Any) => {
			if (!named(name)) throw new Error(`no explorer is called ${String(name)}`);
			ensureNode(inboxOf(graph, name), []);
			const ask = `x${++asked}`;
			queueMicrotask(() => void send("change", name, m, ask));
			return ask;
		});
		createAction(`${G}/took`, (name: string, n: number) => {
			if (!named(name)) return;
			const at = inboxOf(graph, name);
			const was = now<{ n: number }[]>(at) ?? [];
			const left = was.filter((x) => x.n > n);
			if (left.length !== was.length) set(at, left);
		});
		createAction(`${G}/copy`, (name: string, text: string) => {
			if (!named(name)) return;
			const done = navigator.clipboard?.writeText(String(text));
			if (!done) {
				return tell(graph, name, { do: "copy", error: "this browser won't let a page copy" });
			}
			done.then(
				() => hostTell(graph, name, { do: "copy", text: String(text) }),
				() =>
					hostTell(graph, name, {
						do: "copy",
						error: "the browser wouldn't let me copy that",
					}),
			);
		});
		set(TICK, Date.now());
		set(NOW, Date.now());
	});
	let nowAt = Date.now(), seen = false;
	const clocks = setInterval(() =>
		ermine.within(() => {
			const shown = SHOWING.map((p) => now(p));
			const any = document.visibilityState === "visible" &&
				[...explorers].some((name) => shows(name, shown));
			const back = any && !seen;
			seen = any;
			if (!any) return;
			const t = Date.now();
			set(TICK, t);
			if (back || t - nowAt >= 15_000) set(NOW, nowAt = t);
		}), 1000);
	return () => clearInterval(clocks);
}

(globalThis as { ermineFinder?: unknown }).ermineFinder = { mount: mountFinder };
