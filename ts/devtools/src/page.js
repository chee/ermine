// The devtools agent, evaluated in the inspected page. A host shows its graph
// to devtools by pushing it onto globalThis.__ermine:
//
//   (globalThis.__ermine ??= []).push({ name: "demo", api });
//
// api is any Interface: the host decides which layer devtools sees. The agent
// uses only the graph's own operations, as the agent "devtools": it reads
// directories and values by address, looks names up from a place, and
// subscribes to every address it has listed, so it hears the changes to what
// the panel has seen and the records of the processes there. It never writes.
//
// The panel polls status() and asks for the rest by name; everything it gets
// back is JSON. Evaluating this again keeps the agent that is there.

(() => {
  const VERSION = 1;
  if (globalThis.__ermine_devtools?.v === VERSION) return true;

  const AGENT = "devtools";
  /** the most events kept for each graph */
  const KEEP = 5000;
  /** the most addresses subscribed to in each graph */
  const SUBS = 4000;

  /** name to what the agent knows of that graph */
  const graphs = new Map();
  let version = 0;

  const listed = () => (Array.isArray(globalThis.__ermine) ? globalThis.__ermine : []);

  const json = (e) => {
    if (e && typeof e === "object" && "why" in e && "kind" in e) {
      return { kind: e.kind, op: e.op, why: e.why };
    }
    return { kind: "thrown", why: { code: "thrown", text: String(e?.message ?? e) } };
  };

  const attempt = (f) => {
    try {
      return { ok: f() };
    } catch (e) {
      return { error: json(e) };
    }
  };

  /** The state for a graph, made again when the host gives another api by that name. */
  function state(name) {
    const entry = listed().find((g) => g && g.name === name);
    if (!entry) return;
    let s = graphs.get(name);
    if (s && s.api === entry.api) return s;
    if (s) {
      for (const sub of s.subs.values()) {
        try {
          s.api.unsubscribe({ agent: AGENT, sub });
        } catch { /* the old graph may be gone */ }
      }
    }
    s = {
      api: entry.api,
      subs: new Map(),
      events: [],
      seen: new Set(),
      n: 0,
      gen: (s?.gen ?? 0) + 1,
    };
    graphs.set(name, s);
    version++;
    return s;
  }

  function hear(s, event) {
    const key = "change" in event
      ? `c ${event.change.node}@${event.change.time}`
      : `r ${event.record.process}#${event.record.run}`;
    if (s.seen.has(key)) return;
    s.seen.add(key);
    s.events.push({ n: ++s.n, key, ...structuredClone(event) });
    if (s.events.length > KEEP) s.seen.delete(s.events.shift().key);
    version++;
  }

  function follow(s, address) {
    const key = JSON.stringify(address);
    if (s.subs.has(key) || s.subs.size >= SUBS) return;
    try {
      const { sub } = s.api.subscribe({ agent: AGENT, address, send: (e) => hear(s, e) });
      s.subs.set(key, sub);
    } catch { /* an address that refuses is shown as refused when read */ }
  }

  const agent = {
    v: VERSION,
    status() {
      return {
        version,
        graphs: listed().filter((g) => g && typeof g.name === "string").map((g) => {
          const s = state(g.name);
          return { name: g.name, gen: s.gen, events: s.n, subs: s.subs.size };
        }),
      };
    },
    /** What an address reads as, and its directory; and each name's slot followed. */
    listing(name, address) {
      const s = state(name);
      if (!s) return { gone: true };
      follow(s, address);
      const read = attempt(() => s.api.read({ agent: AGENT, address }));
      const directory = attempt(() => s.api.directory({ agent: AGENT, address }).directory);
      for (const [slot] of directory.ok ?? []) follow(s, [...address, slot]);
      return structuredClone({ read, directory });
    },
    /** A name looked up from a place, nearest directory first. */
    lookup(name, place, slot) {
      const s = state(name);
      if (!s) return { gone: true };
      return structuredClone(attempt(() => s.api.lookup({ agent: AGENT, place, name: slot })));
    },
    /** The events after n, and the generation they belong to. */
    events(name, after) {
      const s = state(name);
      if (!s) return { gone: true };
      return { gen: s.gen, events: s.events.filter((e) => e.n > after) };
    },
  };

  Object.defineProperty(globalThis, "__ermine_devtools", { value: agent, configurable: true });
  return true;
})();
