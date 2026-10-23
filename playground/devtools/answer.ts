// devtools(host, { name }): this page's graph shown to the ermine devtools extension, when it asks.
// nothing goes on window: the extension's agent fires "ermine:devtools" on window, its detail
// holding answer; this listens and answers with host, each time it is asked. a page that never
// calls this stays invisible. gives back the stop: no more answers, and the graph taken out of the
// devtools that have it.
//
//   import { devtools } from "../../devtools/answer.ts"
//   const stop = devtools(host, { name: "shape" })
//
// host: the layer the page picks for devtools to read and write through, as it is: the demos'
// stand-in host (look, content, info, outro, replace, call, hear, world), a process api (entries,
// list, peep, reads, edit, send), or a world holding one as .api (playground/demo-world's). every
// read devtools makes is that layer's own, so protect is asked as for anyone.
// travel: going back in time, when the host has a history (the inspector's Travel)

export const EVENT = "ermine:devtools";

export type Travel = {
  // the moments, oldest first; time is the host's own
  times: () => { time: number; label: string }[];
  // the graph set back to how it was at time
  go: (time: number) => unknown;
  // what going back does not set back
  note?: string;
};

export type Shown = { name?: string; travel?: Travel };

// what the request carries: answer, given the layer and how to show it, gives back the forget
export type Request = {
  answer: (host: unknown, o: { name: string; travel?: Travel }) => () => void;
  version?: number;
};

export function devtools(host: unknown, o: Shown = {}): () => void {
  const name = o.name ?? "graph";
  const forgets = new Set<() => void>();
  const hear = (e: Event) => {
    const answer = (e as CustomEvent<Request>).detail?.answer;
    if (typeof answer !== "function") return;
    forgets.add(answer(host, o.travel ? { name, travel: o.travel } : { name }));
  };
  globalThis.addEventListener(EVENT, hear);
  return () => {
    globalThis.removeEventListener(EVENT, hear);
    for (const forget of forgets) forget();
    forgets.clear();
  };
}
