// the finder's page side, evaluated in the inspected page after the agent (page.js): graphs.ts'
// pageGraph, as ermine-mac has it, handed to the agent, which runs it on the ermine the page
// answered with and answers the finder's asks from it. bundled with places.ts left out (its
// install would write to the page's storage): pageGraph needs none of it
import { pageGraph } from "./graphs.ts";

// deno-lint-ignore no-explicit-any
const agent = (globalThis as any).__ermine_devtools;
if (agent) agent.pageGraph = pageGraph;
