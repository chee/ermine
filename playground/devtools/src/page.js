// The devtools agent, evaluated in the inspected page by the panel (inspectedWindow.eval). It is
// the extension's object, kept at globalThis.__ermine_devtools; the page's graph never goes on
// window. A page that wants to be seen listens for the request and answers with the layer it picks:
//
//   addEventListener("ermine:devtools", (e) => e.detail.answer(host, { name: "shape" }))
//
// (playground/devtools/answer.ts does this: devtools(host, { name })). answer gives back a forget
// function; a page may keep answer and call it later. The agent fires the request when it is made
// and whenever the panel asks (ask), so a page that answers late is found.
//
// Two layers are understood, by what they have:
//   host   the demos' stand-in (playground/demos/shape/lib/host.ts): look, content, info, process,
//          ephemeral, hear, clock; outro, replace, call, write; world() for the scheduler
//   api    a process api (ermine/api): entries, list, peep, reads; or a world holding one as .api
//          (playground/demo-world's): s, host, places, apis.runs, parts, processes, call
// Every read goes through the layer's own reads, so protect is asked and a refused item shows as
// refused. Everything handed to the panel is JSON: it polls status() and asks for the rest by
// name; the scheduler's moments are kept in a bounded buffer, in words when taken. Evaluating this
// again keeps the agent that is there.

(() => {
  const VERSION = 3;
  const AGENT = "__ermine_devtools";
  const EVENT = "ermine:devtools";
  const STATUS = "ermine.computer.status";
  /** the most moments kept for each graph */
  const KEEP = 2000;
  /** the most rows a tree walk gives */
  const ROWS = 4000;
  /** the most cards a map holds, children shown under one card, ids shown under one name */
  const CAP = 520;
  const PER = 40;
  const STACK = 8;
  const W = 150;
  const H = 40;
  const COL = 196;
  const ROW = 50;

  const was = globalThis[AGENT];
  if (was?.v === VERSION) return true;
  was?.stop?.();

  /** name → what the agent holds of that graph */
  const graphs = new Map();
  let version = 0;

  // ---- values, in words ----

  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const isError = (v) => Object.prototype.toString.call(v) === "[object Error]";
  // a page's element (a view a process made), from any frame
  const isElement = (v) =>
    v !== null && typeof v === "object" && typeof v.nodeType === "number" && "nodeName" in v;
  function json(v) {
    try {
      return JSON.stringify(v, replacer) ?? String(v);
    } catch {
      return String(v);
    }
  }
  function replacer(_, x) {
    if (typeof x === "function") return `ƒ ${x.name || "handler"}`;
    if (typeof x === "bigint") return `${x}n`;
    if (typeof x === "symbol") return x.description ?? String(x);
    if (x === undefined) return x;
    if (isError(x)) return { error: x.name, message: x.message };
    if (ArrayBuffer.isView(x)) {
      return `${x.constructor?.name ?? "bytes"} ${x.length ?? x.byteLength}`;
    }
    return x;
  }
  /** a value drawn by its kind: [class, text] */
  function shown(v, n = 40) {
    if (v === undefined) return ["vk", ""];
    if (v === null) return ["vk", "∅"];
    if (typeof v === "string") return ["vs", `“${cut(v.replace(/\n/g, "⏎"), n)}”`];
    if (typeof v === "number") return ["vn", String(Math.round(v * 1000) / 1000)];
    if (typeof v === "bigint") return ["vn", `${v}n`];
    if (typeof v === "boolean") return [v ? "vt" : "vf", String(v)];
    if (typeof v === "function") return ["vfn", `ƒ ${v.name || "handler"}`];
    if (typeof v === "symbol") return ["vk", v.description ?? String(v)];
    if (isError(v)) return ["vf", cut(`${v.name}: ${v.message}`, n)];
    if (ArrayBuffer.isView(v)) {
      const name = v.constructor?.name === "Uint8Array" ? "bytes" : v.constructor?.name ?? "bytes";
      return ["vb", `${name} ${v.length ?? v.byteLength}`];
    }
    if (Array.isArray(v)) {
      const head = v.slice(0, 4).map((x) => (typeof x === "object" && x !== null ? "…" : json(x)));
      return ["vl", `[${v.length}] ${cut(head.join(" "), n)}`];
    }
    if (isElement(v)) return ["vm", `<${String(v.nodeName).toLowerCase()}>`];
    if (typeof v === "object") return ["vm", `{${cut(Object.keys(v).join(" "), n)}}`];
    return ["", String(v)];
  }
  /** a value in full, as text */
  function pretty(v) {
    if (typeof v === "function") return cut(v.toString(), 4000);
    if (isElement(v)) return cut(v.outerHTML ?? `<${v.nodeName}>`, 4000);
    if (typeof v === "symbol") return v.description ?? String(v);
    if (ArrayBuffer.isView(v) && v.BYTES_PER_ELEMENT === 1) {
      const hex = [...v.slice(0, 48)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      return `bytes ${v.length}: ${hex}${v.length > 48 ? " …" : ""}`;
    }
    try {
      return cut(JSON.stringify(v, replacer, 1) ?? String(v), 20000);
    } catch {
      return String(v);
    }
  }
  /** a status as the stand-in shows one */
  function statusOf(s) {
    if (s === undefined) return undefined;
    if (typeof s === "symbol") return { pending: true };
    if (isError(s)) {
      if (s.message === "looping") return { loop: {} };
      return { error: { name: s.name, message: s.message, ...(s.code ? { code: s.code } : {}) } };
    }
    if (s && typeof s === "object" && ("pending" in s || "error" in s || "loop" in s)) return s;
    return { error: { message: String(s) } };
  }
  const statusWord = (st) =>
    !st ? "" : st.error ? "error" : st.loop ? "loop" : st.pending !== undefined ? "pending" : "";
  const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const namesIn = (v) => (isMap(v) ? Object.keys(v).filter((k) => typeof v[k] === "string") : []);
  // a slot standing for a key a name can never be ("/", ".", ".."), written %2F, %2E, %2E%2E
  const ENCODED = /^((?:%25)*)(%2F|%2E|%2E%2E)$/;
  function unescaped(name) {
    const m = ENCODED.exec(name);
    if (!m) return name;
    if (m[1]) return name.slice(3);
    return { "%2F": "/", "%2E": ".", "%2E%2E": ".." }[m[2]];
  }
  const pathText = (p) => "/" + p.map(unescaped).join("/");
  const keyOf = (p, k) => pathText(p) + "#" + k;

  /** who a change is by: the header's actor and its metadata, the innermost of each */
  const whoOf = (h) => ({ ...(isMap(h?.metadata) ? h.metadata : {}), actor: h?.actor });

  // ---- the two layers, as one face ----

  /** the demos' stand-in host: content gives each item its node and versions */
  function hostFace(h) {
    const isStatus = (v) => v?.because?.place === "status";
    const where = (p) => ["/", ...p];
    const kind = (id, n) =>
      h.process?.(id)
        ? "proc"
        : typeof n?.value?.value === "function"
        ? "fn"
        : h.ephemeral?.(id)
        ? "eph"
        : "";
    const tickOf = (c) => {
      const t = whoOf(c).tick;
      return typeof t === "number" ? t : undefined;
    };
    const world = typeof h.world === "function" ? h.world() : undefined;
    // each process's computers, from the scheduler's scopes (a computer's process: the nearest
    // "process" in its info and above), made again when the clock has moved
    let indexed = -1;
    let byProc = new Map();
    const computers = (id) => {
      if (!world?.scope) return [];
      if (h.clock?.time !== indexed) {
        indexed = h.clock?.time;
        byProc = new Map();
        const walk = (o, proc) => {
          if (o.state === "gone") return;
          const p = typeof o.info?.process === "string" ? o.info.process : proc;
          if ("kind" in o && p !== undefined) byProc.set(p, [...(byProc.get(p) ?? []), o]);
          for (let x = o.newest; x; x = x.older) walk(x, p);
        };
        walk(world.scope, undefined);
      }
      return byProc.get(id) ?? [];
    };
    return {
      kind: "host",
      time: () => h.clock?.time ?? 0,
      when: () => `t${h.clock?.time ?? 0}`,
      version: () => h.clock?.time,
      items(p) {
        return h.content(where(p)).map((it) => {
          if (it.refused) return { id: String(it.id), refused: String(it.refused) };
          const n = it.node;
          if (!n) return { id: it.id, loaded: false, kids: [], infos: [] };
          const vs = it.versions ?? [];
          const v = vs.find((x) => !isStatus(x));
          const attrs = isMap(n.attributes?.value) ? n.attributes.value : {};
          return {
            id: it.id,
            loaded: true,
            value: v?.content,
            has: !!v,
            status: vs[0] && isStatus(vs[0]) ? statusOf(vs[0].content) : undefined,
            infos: Object.entries(attrs).filter(([k]) => k !== STATUS),
            kids: namesIn(n.children?.value),
            ids: isMap(n.children?.value) ? n.children.value : {},
            kind: kind(it.id, n),
            versions: vs.map((x) => ({
              content: x.content,
              change: x.change,
              status: isStatus(x),
            })),
          };
        });
      },
      holds: (it) =>
        Object.values(it.ids ?? {}).some((id) => typeof id === "string" && h.process?.(id)),
      child: (it, name) => it.ids?.[name],
      info(p, k, name) {
        const vs = h.info(where(p), name)[k]?.versions ?? [];
        const v = vs.find((x) => !isStatus(x));
        return v && { content: v.content, change: v.change };
      },
      tick: tickOf,
      can: {
        kill: typeof h.outro === "function",
        replace: typeof h.replace === "function",
        call: typeof h.call === "function",
        write: typeof h.write === "function",
      },
      killable: (id) => !!h.process?.(id),
      kill: (id) => h.outro(id),
      replace: (p) => h.replace({ address: where(p) }),
      call: (p, args) => h.call({ address: where(p), args }),
      write(p, k, id, value) {
        const api = typeof h.as === "function" ? h.as({ cause: "devtools" }) : h;
        return api.write(k === 0 ? where(p) : id, [{ path: [], value }]);
      },
      listen(tell) {
        if (typeof h.hear !== "function") return () => {};
        return h.hear((m) => {
          if ("due" in m) tell({ due: m.due, by: m.by, part: m.part });
          else if ("starts" in m) tell({ starts: m.starts, run: m.run, part: m.part });
          else if ("ends" in m) {
            tell({
              ends: m.ends,
              run: m.run,
              part: m.part,
              ended: m.ended,
              equal: m.equal,
              waits: m.waits,
              reads: m.reads,
              error: m.error === undefined ? undefined : json(m.error),
            });
          } else if ("acts" in m) {
            if (m.error !== undefined) tell({ acts: m.acts, run: m.run, error: json(m.error) });
          } else if ("call" in m) tell({ call: m.call, handler: m.handler });
          else if ("called" in m) {
            tell({
              called: m.called,
              handler: m.handler,
              ended: m.ended,
              error: m.error && json(m.error),
            });
          } else if ("started" in m) tell({ started: m.started, name: m.name, place: m.place });
          else if ("gone" in m) tell({ gone: m.gone });
        });
      },
      // what each of its computers tracks now (its latest run's reads), named by places
      reads: world?.places?.describe
        ? (id) => {
          const out = [];
          for (const c of computers(id)) {
            for (let l = c.node?.reads ?? null; l !== null; l = l.next) {
              const w = world.places.describe(l.to.owner);
              if (w) out.push(w);
            }
          }
          return out;
        }
        : undefined,
      // runs so far, when no moment told of one
      run: (id) => {
        const cs = computers(id);
        return cs.length ? { run: Math.max(...cs.map((c) => c.runs)) } : undefined;
      },
      scheduler: () => world && { s: world.scheduler, roots: [world.scope] },
    };
  }

  /** a process api, alone or in a world beside the scheduler and the host's tables */
  function apiFace(a, w) {
    const node = (p) => ({ path: p, part: "value" });
    const one = (id) => ({ id, part: "value" });
    const attempt = (f, or) => {
      try {
        return f();
      } catch {
        return or;
      }
    };
    const processes = () => {
      const out = new Map();
      for (const p of w?.processes?.values?.() ?? []) if (p?.id) out.set(p.id, p);
      return out;
    };
    const computers = () => w?.statusIds;
    let facts = 0;
    const offFacts = typeof w?.places?.watchAll === "function"
      ? w.places.watchAll(() => void facts++)
      : undefined;
    // a computer's node: its own (a memo's, an effect's), else the nearest scope above with one (a
    // process's binding is told as the process); none: not the graph's (a page's own feeds)
    const idOf = (c) => {
      const own = w?.parts?.get?.(c)?.entry?.id;
      if (own !== undefined) return own;
      for (let o = c; o; o = o.parent) if (o.info?.node !== undefined) return o.info.node;
    };
    let procs = processes();
    return {
      kind: "api",
      time: () => facts,
      when: () => new Date().toTimeString().slice(0, 8),
      version: () => (offFacts ? facts : undefined),
      stop: () => offFacts?.(),
      items(p, fresh) {
        if (fresh) procs = processes();
        const comps = computers();
        return a.entries(node(p)).map((it, k) => {
          if (it.refused) return { id: `refused ${k}`, refused: "refused by protect" };
          const id = it.id;
          const attrs = attempt(() => a.peep({ id, part: "attributes" }), undefined);
          const status = isMap(attrs) ? attrs[STATUS] : undefined;
          const kids = attempt(() => (k === 0 ? a.list(node(p)) : a.list(one(id))), []);
          const kind = procs.has(id)
            ? "proc"
            : comps?.has?.(id) || status !== undefined
            ? "comp"
            : typeof it.value === "function"
            ? "fn"
            : "";
          return {
            id,
            loaded: true,
            value: it.value,
            has: it.value !== undefined,
            status: statusOf(status),
            infos: isMap(attrs) ? Object.entries(attrs).filter(([k]) => k !== STATUS) : [],
            kids,
            kind,
            from: it.from,
          };
        });
      },
      holds: () => false,
      child: (_it, name, p, k) =>
        k === 0 ? attempt(() => a.entries(node([...p, name]))[0]?.id, undefined) : undefined,
      versions(p, k, id) {
        const x = k === 0 ? node(p) : one(id);
        const header = typeof a.change === "function"
          ? attempt(() => a.change(x), undefined)
          : undefined;
        const vs = attempt(() => a.reads(x), []);
        return vs.map((v, i) => ({
          content: v.value,
          change: i === 0 && header ? header : undefined,
          from: v.from,
          gone: v.gone,
          conflict: v.from?.kind === "conflict",
        }));
      },
      info(p, k, name, id) {
        const x = k === 0 ? { path: p, part: "attributes" } : { id, part: "attributes" };
        const v = attempt(() => a.peep(x, [name]), undefined);
        return v === undefined ? undefined : { content: v };
      },
      tick: () => undefined,
      can: {
        kill: typeof w?.apis?.stop === "function",
        replace: false,
        call: typeof w?.call === "function" || typeof a.send === "function",
        write: typeof a.edit === "function",
      },
      killable: (id) => procs.has(id),
      kill(id) {
        const p = processes().get(id);
        if (!p) throw new Error(`${id}: not a process this host started`);
        w.apis.stop(p);
        w.s?.pulse?.();
      },
      call(p, args) {
        const list = args === undefined ? [] : Array.isArray(args) ? args : [args];
        return typeof w?.call === "function" ? w.call(p, list) : a.send(node(p), ...list);
      },
      write(p, k, id, value) {
        const f = () => a.edit(k === 0 ? node(p) : one(id), [{ path: [], value }]);
        return typeof a.as === "function" ? a.as({ via: "devtools" }, f) : f();
      },
      listen(tell) {
        const s = w?.s;
        if (!s?.onMark) return () => {};
        const offs = [
          s.onMark((_, run, due) => {
            for (const c of due) {
              const id = idOf(c);
              if (id !== undefined) tell({ due: id, by: run ? idOf(run.computer) : undefined });
            }
          }),
          s.onRunStart((c, n) => {
            const id = idOf(c);
            if (id !== undefined) tell({ starts: id, run: n });
          }),
          s.onRunEnd((c, n, ended, _reads, more) => {
            const id = idOf(c);
            if (id === undefined) return;
            tell({
              ends: id,
              run: n,
              ended,
              equal: more?.equal,
              waits: more?.waits ? idOf(more.waits) : undefined,
              error: more && "error" in more ? json(more.error) : undefined,
            });
          }),
          s.onEffect((c, n, more) => {
            const id = idOf(c);
            if (id !== undefined && more && "error" in more) {
              tell({ acts: id, run: n, error: json(more.error) });
            }
          }),
        ];
        return () => offs.forEach((f) => f());
      },
      // the runs table: a computer's latest run by its node's id
      reads: typeof w?.apis?.runs === "function"
        ? (id) => attempt(() => w.apis.runs(id, "reads"), undefined)
        : undefined,
      run: typeof w?.apis?.runs === "function"
        ? (id) => {
          const r = attempt(() => w.apis.runs(id), undefined);
          return r && { run: r.n, ended: r.end, error: r.error && json(r.error) };
        }
        : undefined,
      scheduler: () => w?.s && { s: w.s, roots: [w.host].filter(Boolean) },
    };
  }

  function faceOf(layer) {
    if (typeof layer?.content === "function" && typeof layer?.look === "function") {
      return hostFace(layer);
    }
    if (typeof layer?.entries === "function" && typeof layer?.list === "function") {
      return apiFace(layer, undefined);
    }
    if (typeof layer?.api?.entries === "function") return apiFace(layer.api, layer);
    throw new Error(
      "ermine devtools: answer with a host (look, content) or a process api (entries, list), or a world holding one as .api",
    );
  }

  // ---- answering ----

  function answer(layer, o = {}) {
    for (const g of graphs.values()) if (g.layer === layer) return g.forget;
    const face = faceOf(layer);
    let name = String(o.name ?? "graph");
    for (let n = 2; graphs.has(name); n++) name = `${o.name ?? "graph"} ${n}`;
    const g = {
      name,
      layer,
      face,
      gen: ++version,
      travel: o.travel,
      travelError: undefined,
      moments: [],
      n: 0,
      round: 0,
      roundOpen: false,
      runs: new Map(),
      woken: new Map(),
      names: new Map(),
      where: new Map(),
      procs: [],
      seen: new Map(),
      roots: new Set(),
      offs: [],
    };
    g.offs.push(face.listen((m) => hear(g, m)));
    const sched = face.scheduler?.();
    if (sched?.s?.onRunStart) {
      for (const r of sched.roots) g.roots.add(r);
      g.offs.push(sched.s.onRunStart((c) => {
        let top = c;
        while (top.parent) top = top.parent;
        g.roots.add(top);
      }));
    }
    g.forget = () => {
      if (graphs.get(g.name) !== g) return;
      graphs.delete(g.name);
      for (const f of g.offs) f?.();
      face.stop?.();
      version++;
    };
    graphs.set(name, g);
    return g.forget;
  }

  function hear(g, m) {
    if (!g.roundOpen) {
      g.round++;
      g.roundOpen = true;
      setTimeout(() => (g.roundOpen = false), 0);
    }
    if ("due" in m) g.woken.set(m.due, m.by);
    if ("ends" in m && m.part !== "load" && m.ended !== "stopped") {
      g.runs.set(m.ends, { run: m.run, ended: m.ended, reads: m.reads, by: g.woken.get(m.ends) });
    }
    if ("gone" in m) (g.runs.delete(m.gone), g.woken.delete(m.gone));
    const kept = { ...m, reads: undefined, n: ++g.n, round: g.round, when: g.face.when() };
    g.moments.push(kept);
    if (g.moments.length > KEEP) g.moments.splice(0, g.moments.length - KEEP);
  }

  function ask() {
    const detail = { answer, version: VERSION };
    globalThis.dispatchEvent(new CustomEvent(EVENT, { detail }));
    return graphs.size;
  }

  // ---- names, reads and runs ----

  /** a node's name, with its parent's when it has one, so ten "panel"s say whose they are */
  function nameOf(g, id) {
    if (Array.isArray(id)) return id.length ? id.map(unescaped).join("/") : "/";
    const p = g.where.get(id)?.[0];
    if (p) {
      return p.length > 1
        ? `${unescaped(p[p.length - 2])}/${unescaped(p[p.length - 1])}`
        : p.length
        ? unescaped(p[0])
        : "root";
    }
    return g.names.get(id) ?? String(id);
  }

  /** what a computer's latest run read, as ids: a value, info or the names listed; a step of a walk
   * (one name, passed through) and the status left out */
  function readsOf(g, id) {
    const list = g.face.reads ? g.face.reads(id) : g.runs.get(id)?.reads;
    const ids = new Set();
    const reads = [];
    for (const r of list ?? []) {
      if (!r || !("part" in r)) continue;
      if ((r.part === "children" || r.part === "process") && r.path?.length) continue;
      if (r.part === "attributes" && r.path?.[0] === STATUS) continue;
      ids.add(r.id);
      reads.push(r);
    }
    return { ids, reads };
  }
  function runOf(g, id) {
    // the runs table first (it is the graph's); else what the moments told, else the scheduler's
    const r = g.face.kind === "api"
      ? g.face.run?.(id) ?? g.runs.get(id)
      : g.runs.get(id) ?? g.face.run?.(id);
    if (!r) return undefined;
    return { run: r.run, ended: r.ended, error: r.error, by: g.woken.get(id) };
  }
  const isComputer = (kind) => kind === "proc" || kind === "comp";

  /** who a change is by, in a few words */
  function who(g, change) {
    if (!change) return "";
    const w = whoOf(change);
    const p = w.process === undefined ? "" : nameOf(g, w.process);
    const by = w.handler !== undefined
      ? `${p}${p ? " " : ""}on/${w.handler}`
      : p
      ? `${p}${w.run !== undefined ? ` run ${w.run}` : ""}`
      : "";
    const via = w.via !== undefined ? `via ${w.via}` : "";
    return [
      w.person !== undefined ? `${w.person} via` : "",
      by ? "" : String(w.actor ?? ""),
      by,
      via,
    ]
      .filter(Boolean).join(" ");
  }
  function meta(g, change, from) {
    const tick = g.face.tick(change);
    const w = whoOf(change);
    const site = change?.external?.[0] ?? from?.where?.[0];
    const when = change?.time ?? from?.when;
    return [
      tick !== undefined ? `t${tick}` : when !== undefined ? clock(when) : "",
      change ? who(g, change) : from?.who !== undefined ? String(from.who) : "",
      w.cause !== undefined ? `because ${cut(json(w.cause), 40)}` : "",
      w.message !== undefined ? cut(String(w.message), 40) : "",
      site?.file ? `at ${String(site.file).split("?")[0].split("/").pop()}:${site.line}` : "",
      from?.head ? `head ${String(from.head).slice(0, 8)}` : "",
    ].filter(Boolean).join(" · ");
  }
  function clock(seconds) {
    const ms = seconds > 1e11 ? seconds : seconds * 1000;
    return new Date(ms).toTimeString().slice(0, 8);
  }

  // ---- the tree ----

  function folding(view) {
    const open = new Set(view?.open ?? []);
    const folded = new Set(view?.folded ?? []);
    const depth = view?.depth ?? 4;
    return (key, d, name) =>
      folded.has(key) ? true : open.has(key) ? false : d >= depth || name === "on";
  }

  /** the rows from the root, as the folds and the search leave them; the picked node's detail */
  function tree(g, view = {}) {
    const q = (view.search ?? "").trim().toLowerCase();
    const isFolded = folding(view);
    const rows = [];
    const where = new Map();
    const procs = [];
    const seen = new Map();
    let capped = false;
    let first = true;
    const walk = (p, name, depth) => {
      if (rows.length >= ROWS) return void (capped = true);
      let items;
      try {
        items = g.face.items(p, first);
        first = false;
      } catch (e) {
        rows.push({
          key: keyOf(p, 0),
          path: p,
          k: 0,
          id: "",
          name,
          depth,
          error: cut(String(e?.message ?? e), 200),
        });
        return;
      }
      items.forEach((it, k) => {
        const id = it.id;
        const list = where.get(id) ?? [];
        const mount = list.length > 0;
        list.push(p);
        where.set(id, list);
        const key = keyOf(p, k);
        if (isComputer(it.kind) && !mount && k === 0) procs.push({ id, path: p });
        const kids = it.kids ?? [];
        const fold = isFolded(key, depth, name);
        const canOpen = kids.length > 0 && !mount && k === 0;
        const hidden = view.only && !isComputer(it.kind) && !g.face.holds(it) && depth > 0 &&
          !(kids.length && !fold);
        const shownName = p.length === 0 ? "root" : unescaped(name);
        if (!hidden) {
          const value = it.kind === "fn" || !it.has ? undefined : shown(it.value);
          const run = isComputer(it.kind) && k === 0 && !mount ? runOf(g, id)?.run : undefined;
          const status = statusWord(it.status);
          const sign = `${value?.[1]}|${status}|${run}|${it.infos?.length}`;
          seen.set(id, sign);
          const was = g.seen.get(id);
          rows.push({
            key,
            path: p,
            k,
            id: String(id),
            name: shownName,
            depth,
            kind: it.kind ?? "",
            refused: it.refused,
            loaded: it.loaded !== false && !it.refused,
            value,
            status,
            run,
            infos: (it.infos ?? []).slice(0, 6).map(([n, v]) => [n, shown(v, 14)]),
            count: items.length,
            mount: mount ? pathText(list[0]) : undefined,
            offpath: k > 0 && kids.length > 0,
            canOpen,
            folded: fold,
            kids: kids.length,
            fresh: was !== undefined && was !== sign,
            hit: !!q &&
              (shownName.toLowerCase().includes(q) || String(id).toLowerCase().includes(q)),
          });
        }
        if (typeof id === "string") {
          g.names.set(id, p.length > 1 ? `${unescaped(p[p.length - 2])}/${shownName}` : shownName);
        }
        if (!it.loaded || it.refused || mount || k > 0 || (fold && !q)) return;
        for (const kid of kids) walk([...p, kid], kid, depth + 1);
      });
    };
    walk([], "/", 0);
    if (g.names.size > 20000) g.names.clear();
    g.where = where;
    g.procs = procs;
    g.seen = seen;
    return {
      rows,
      capped,
      procs: procs.length,
      time: g.face.time(),
      detail: view.picked ? detail(g, view.picked) : undefined,
    };
  }

  // ---- the detail pane ----

  function detail(g, pick) {
    const { path: p, k, id } = pick;
    const out = { path: p, k, id, title: pathText(p) + (k ? ` (${k + 1})` : "") };
    let it;
    try {
      it = g.face.items(p, true)[k];
    } catch (e) {
      return { ...out, error: String(e?.message ?? e) };
    }
    if (!it || String(it.id) !== id) return { ...out, gone: true };
    if (it.refused) return { ...out, refused: it.refused };
    if (it.loaded === false) return { ...out, unloaded: true };
    const tags = [];
    if (it.kind === "proc") tags.push(["ok", "process"]);
    if (it.kind === "comp") tags.push(["ok", "computer: a memo or effect"]);
    if (it.kind === "fn") tags.push(["vfn", "handler: a function held as a value"]);
    if (it.kind === "eph") tags.push(["pend", "ephemeral: never kept"]);
    const placed = g.where.get(it.id) ?? [p];
    if (placed.length > 1) tags.push(["err", `one node, ${placed.length} places`]);
    if (k > 0) tags.push(["pend", `${k + 1}th id under this name: off-path`]);
    out.kind = it.kind;
    out.tags = tags;
    if (it.status && Object.keys(it.status).length) {
      out.status = {
        cls: it.status.error || it.status.loop ? "err" : "pend",
        text: cut(json(it.status), 300),
      };
    }
    const can = g.face.can;
    out.can = {
      kill: can.kill && isComputer(it.kind) && g.face.killable(it.id),
      replace: can.replace && it.kind === "proc",
      call: can.call && it.kind === "fn" && k === 0,
      write: can.write && !isComputer(it.kind) && it.kind !== "fn",
    };
    if (isComputer(it.kind) && k === 0) {
      const e = readsOf(g, it.id);
      out.run = runOf(g, it.id);
      out.reads = [...e.ids].map((rid) => ({
        id: rid,
        name: nameOf(g, rid),
        parts: [
          ...new Set(
            e.reads.filter((r) => r.id === rid).map((r) =>
              r.part === "children" || r.part === "process"
                ? "names"
                : r.part === "attributes"
                ? "info"
                : "value"
            ),
          ),
        ].join(", "),
      }));
      if (out.run?.by !== undefined) out.run.byName = nameOf(g, out.run.by);
    }
    out.readers = g.procs.filter((q) => q.id !== it.id && readsOf(g, q.id).ids.has(it.id))
      .map((q) => ({ id: q.id, name: nameOf(g, q.id), path: q.path }));
    out.lit = {
      reads: (out.reads ?? []).map((r) => r.id),
      readers: out.readers.map((r) => r.id),
    };
    out.placed = placed.length > 1 ? placed.map((x) => ({ path: x, text: pathText(x) })) : [];
    // the value, a process's status in front, and the change that made each
    const versions = g.face.versions ? g.face.versions(p, k, it.id) : it.versions ?? [];
    out.versions = versions.map((v) => ({
      text: pretty(v.content),
      status: !!v.status,
      conflict: !!v.conflict,
      gone: !!v.gone,
      meta: [
        v.status ? "status, in front of the value" : "",
        v.conflict ? "another value sync has" : "",
        meta(g, v.change, v.from),
      ]
        .filter(Boolean).join(" · "),
    }));
    if (it.kind !== "fn" && it.has) {
      try {
        out.json = JSON.stringify(it.value, null, 1);
      } catch { /* not data */ }
    }
    out.infos = (it.infos ?? []).map(([name, v]) => {
      const iv = g.face.info(p, k, name, it.id);
      return {
        name,
        text: pretty(iv ? iv.content : v),
        meta: iv?.change ? meta(g, iv.change) : "",
      };
    });
    out.children = (it.kids ?? []).map((name) => ({
      name: unescaped(name),
      slot: name,
      id: g.face.child(it, name, p, k),
    }));
    return out;
  }

  // ---- the map: the same tree as cards, laid out left to right ----

  function map(g, view = {}) {
    const isFolded = folding(view);
    const q = (view.search ?? "").trim().toLowerCase();
    const cards = [];
    const home = new Map();
    const links = [];
    const procs = [];
    const where = new Map();
    let capped = false;
    let first = true;
    const walk = (p, name, depth, parent, crowded) => {
      let items;
      try {
        items = g.face.items(p, first);
        first = false;
      } catch {
        return;
      }
      let front;
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        const id = it.id;
        const list = where.get(id) ?? [];
        const mount = list.length > 0;
        list.push(p);
        where.set(id, list);
        if (mount) {
          const h = home.get(id);
          if (h && parent && h !== parent) {
            links.push({ from: parent.key, to: h.key, kind: "mount" });
          }
          continue;
        }
        if (k >= STACK) break;
        if (cards.length >= CAP) {
          capped = true;
          if (parent) parent.more++;
          continue;
        }
        const kids = it.kids ?? [];
        const key = keyOf(p, k);
        const folded = kids.length > 0 && k === 0 &&
          (isFolded(key, depth, name) || (crowded && !(view.open ?? []).includes(key)));
        const shownName = p.length === 0 ? "root" : unescaped(name);
        const card = {
          key,
          id: String(id),
          name: shownName,
          path: p,
          k,
          count: items.length,
          depth,
          kind: it.kind ?? "",
          refused: !!it.refused,
          loaded: it.loaded !== false && !it.refused,
          value: it.kind === "fn" || !it.has ? undefined : shown(it.value, 22),
          status: statusWord(it.status),
          run: isComputer(it.kind) && k === 0 ? runOf(g, id)?.run : undefined,
          folded,
          canOpen: kids.length > 0 && k === 0,
          more: 0,
          hit: !!q && (shownName.toLowerCase().includes(q) || String(id).toLowerCase().includes(q)),
          x: 0,
          y: 0,
          kidCards: [],
          parent,
        };
        if (k === 0) front = card;
        else card.front = front;
        cards.push(card);
        home.set(id, card);
        if (parent) {
          parent.kidCards.push(card);
          links.push({ from: parent.key, to: card.key, kind: "child" });
        }
        if (isComputer(it.kind) && k === 0) procs.push(card);
        if (!card.loaded || k > 0 || folded) continue;
        for (const kid of kids) {
          if (card.kidCards.length >= PER) {
            card.more++;
            continue;
          }
          walk([...p, kid], kid, depth + 1, card, kids.length > 8);
        }
      }
    };
    walk([], "/", 0, undefined, false);
    // across by depth, down by leaf row; a big list of leaves wraps into columns
    let row = 0;
    const place = (card) => {
      card.x = card.depth * COL;
      const real = card.kidCards;
      const leaves = real.filter((x) => !x.kidCards.length);
      if (real.length > 8 && leaves.length > 6) {
        const cols = Math.ceil(Math.sqrt(leaves.length / 3));
        const per = Math.ceil(leaves.length / cols);
        leaves.forEach((kid, i) => {
          kid.x = kid.depth * COL + Math.floor(i / per) * (W + 12);
          kid.y = (row + (i % per)) * ROW;
        });
        row += per;
        for (const kid of real) if (kid.kidCards.length) place(kid);
        const ys = real.map((x) => x.y);
        card.y = (Math.min(...ys) + Math.max(...ys)) / 2;
      } else {
        for (const kid of real) place(kid);
        if (!real.length) card.y = row++ * ROW;
        else card.y = (real[0].y + real[real.length - 1].y) / 2;
      }
    };
    if (cards[0]) place(cards[0]);
    // the read edges: each computer's latest run, to the cards it read
    const reads = [];
    for (const pr of procs.slice(0, 220)) {
      for (const rid of readsOf(g, pr.id).ids) {
        const to = home.get(rid);
        if (to && to !== pr) reads.push({ from: pr.key, to: to.key, reader: pr.id, read: to.id });
      }
    }
    g.where = where;
    g.procs = procs.map((c) => ({ id: c.id, path: c.path }));
    for (const c of cards) delete c.kidCards, delete c.parent, delete c.front;
    return {
      cards,
      links,
      reads,
      capped,
      procs: procs.length,
      time: g.face.time(),
      W,
      H,
      detail: view.picked ? detail(g, view.picked) : undefined,
    };
  }

  // ---- the scheduler's own shape: computers by rank, the keys they read and write, owners ----

  const keyIds = new WeakMap();
  let nextKey = 0;
  const boxKey = (k) => {
    if (k === null || (typeof k !== "object" && typeof k !== "function")) return `v:${String(k)}`;
    let n = keyIds.get(k);
    if (n === undefined) keyIds.set(k, n = ++nextKey);
    return `o:${n}`;
  };
  const SW = 170;
  const SCOL = 240;
  const SCAP = 600;
  const isComp = (o) => "kind" in o;
  const given = (o) => Object.entries(o.info ?? {}).filter(([k]) => k !== "run" && k !== "mark");
  const kidsOf = (o) => {
    const out = [];
    for (let x = o.newest; x; x = x.older) out.unshift(x);
    return out;
  };
  const short = (v, n = 24) => cut(typeof v === "string" ? v : json(v), n);

  function shape(g, mode = "values", picked) {
    const sched = g.face.scheduler?.();
    if (!sched) return { none: true };
    const roots = [...g.roots].filter((o) => o.state !== "gone");
    const scopes = [];
    const comps = [];
    let capped = false;
    const walk = (o) => {
      if (o.state === "gone") return;
      if (scopes.length >= SCAP * 2) return void (capped = true);
      scopes.push(o);
      if (isComp(o)) comps.push(o);
      for (const kid of kidsOf(o)) walk(kid);
    };
    for (const r of roots) walk(r);
    const inScopes = new Set(scopes);
    const scopeName = (o) => {
      const i = o.info ?? {};
      const v = i.name ?? i.process ?? i.why ?? i.actor ?? i.role ?? i.via;
      return v === undefined ? undefined : short(Array.isArray(v) ? v.join("/") : v, 30);
    };
    const processOf = (o) => {
      for (let x = o; x; x = x.parent) {
        const p = x.info?.process;
        if (typeof p === "string") return p;
        if (x.info?.node !== undefined) return String(x.info.node);
      }
    };
    const owner = (o) => {
      const out = [];
      for (let x = o.parent; x && out.length < 2; x = x.parent) {
        const n = scopeName(x);
        if (n) out.unshift(n);
      }
      return out.join(" › ");
    };
    const boxes = new Map();
    const add = (k, b) => {
      let box = boxes.get(k);
      if (!box) boxes.set(k, box = { ...b, key: boxKey(k), x: 0, y: 0 });
      return box;
    };
    const compBox = (c) => {
      const flags = [];
      if (c.due) flags.push("due");
      if (c.looping) flags.push("looping");
      if (c.early) flags.push("early");
      const proc = processOf(c);
      return add(c, {
        kind: c.kind,
        label: owner(c) || "·",
        sub: `${c.kind} #${c.n}${
          proc ? ` · ${nameOf(g, proc)}` : ""
        } · rank ${c.rank} · ${c.runs} runs`,
        flags,
        place: proc,
        scope: c,
      });
    };
    const scopeBox = (o) =>
      add(o, {
        kind: "scope",
        label: scopeName(o) ?? `scope #${o.n}`,
        sub: given(o).map(([k, v]) => `${k}=${short(v, 14)}`).join(" ") || `#${o.n}`,
        flags: o.parent ? [] : ["root"],
        place: processOf(o),
        scope: o,
      });
    const partOf = (
      src,
    ) => (src !== null && typeof src === "object" && "part" in src
      ? String(src.part)
      : String(src));
    const keyBox = (k) => {
      const isSpot = k !== null && typeof k === "object" && "id" in k && "source" in k;
      if (!isSpot) return add(k, { kind: "key", label: short(k, 30), sub: typeof k, flags: [] });
      const id = String(k.id);
      const path = k.path === null
        ? "change"
        : k.path?.length
        ? "/" + k.path.map(String).join("/")
        : "";
      return add(k, {
        kind: "key",
        label: nameOf(g, id),
        sub: `${partOf(k.source)}${path}${k.keys ? " · keys" : ""}`,
        flags: [],
        place: id,
      });
    };
    const arrows = [];
    const live = new Set(comps);
    const shownComps = comps.slice(0, SCAP);
    if (shownComps.length < comps.length) capped = true;
    const ranks = [...new Set(shownComps.map((c) => c.rank))].sort((a, b) => a - b);
    const col = new Map(ranks.map((r, i) => [r, i]));
    const columns = (at) => {
      const by = new Map();
      for (const [b, c] of at) by.set(c, [...(by.get(c) ?? []), b]);
      const cols = [...by.keys()].sort((a, b) => a - b);
      const tall = Math.max(0, ...[...by.values()].map((l) => l.length));
      cols.forEach((c, i) => {
        const list = by.get(c).sort((a, b) =>
          a.label.localeCompare(b.label) || a.sub.localeCompare(b.sub)
        );
        const top = (tall - list.length) * ROW / 2;
        list.forEach((b, j) => ((b.x = i * SCOL), (b.y = top + j * ROW)));
      });
    };
    if (mode === "values") {
      for (const c of shownComps) compBox(c);
      for (const c of shownComps) {
        for (const w of c.values ?? []) {
          if (live.has(w) && boxes.has(w)) {
            arrows.push({ from: boxes.get(w), to: boxes.get(c), kind: "value" });
          }
        }
      }
      columns(shownComps.map((c) => [boxes.get(c), col.get(c.rank)]));
    } else if (mode === "keys") {
      const layer = new Map();
      for (const c of shownComps) layer.set(compBox(c), 2 * col.get(c.rank) + 1);
      const writer = new Map();
      for (const c of shownComps) for (const k of c.wrote ?? []) writer.set(k, c);
      const keyLayer = (k) => {
        const w = writer.get(k);
        return w ? 2 * col.get(w.rank) + 2 : 0;
      };
      for (const c of shownComps) {
        const seen = new Set();
        for (let l = c.node?.reads ?? null; l !== null; l = l.next) {
          const k = l.to.owner;
          if (seen.has(k)) continue;
          seen.add(k);
          const b = keyBox(k);
          layer.set(b, keyLayer(k));
          arrows.push({ from: b, to: boxes.get(c), kind: "read" });
        }
        for (const k of c.wrote ?? []) {
          const b = keyBox(k);
          layer.set(b, keyLayer(k));
          arrows.push({ from: boxes.get(c), to: b, kind: "wrote" });
        }
      }
      columns([...layer]);
    } else {
      let row = 0;
      const place = (o, depth) => {
        const b = isComp(o) ? compBox(o) : scopeBox(o);
        b.x = depth * SCOL;
        const kids = kidsOf(o).filter((k) => k.state !== "gone" && inScopes.has(k));
        if (!kids.length) b.y = row++ * ROW;
        else {
          const ys = kids.map((k) => {
            const kb = place(k, depth + 1);
            arrows.push({ from: b, to: kb, kind: "owner" });
            return kb.y;
          });
          b.y = (ys[0] + ys[ys.length - 1]) / 2;
        }
        return b;
      };
      for (const r of roots) if (inScopes.has(r)) (place(r, 0), row++);
    }
    const n = (k) => [...boxes.values()].filter((b) => b.kind === k).length;
    const counts = mode === "owners"
      ? `${n("scope")} scopes · ${n("compute")} computes · ${n("effect")} effects`
      : mode === "keys"
      ? `${shownComps.length} computers · ${n("key")} keys · ${arrows.length} links`
      : `${shownComps.length} computers · ${ranks.length} ranks · ${arrows.length} values`;
    const byScope = new Map(
      [...boxes.values()].filter((b) => b.scope).map((b) => [b.scope, b.key]),
    );
    const list = [...boxes.values()];
    const about = picked && list.find((b) => b.key === picked);
    return {
      mode,
      counts,
      capped,
      W: SW,
      H,
      boxes: list.map((b) => ({
        key: b.key,
        kind: b.kind,
        label: b.label,
        sub: b.sub,
        flags: b.flags,
        place: b.place,
        placeName: b.place === undefined ? undefined : nameOf(g, b.place),
        up: b.scope ? ancestors(b.scope, byScope) : [],
        x: b.x,
        y: b.y,
      })),
      arrows: arrows.map((a) => ({ from: a.from.key, to: a.to.key, kind: a.kind })),
      about: about ? aboutOf(about) : undefined,
    };
  }
  function ancestors(o, byScope) {
    const out = [];
    for (let x = o.parent; x; x = x.parent) {
      const k = byScope.get(x);
      if (k) out.push(k);
    }
    return out;
  }
  function aboutOf(b) {
    const lines = [`${b.kind}: ${b.label}`, b.sub];
    const sc = b.scope;
    if (sc && isComp(sc)) {
      lines.push(
        `due ${sc.due || "no"} · ranked ${sc.ranked} · stamp ${sc.stamp}`,
        `values ${sc.values?.length ?? 0} · wrote ${sc.wrote?.size ?? 0} · kept causes ${
          sc.kept?.length ?? 0
        }`,
      );
      if (sc.after) lines.push(`waits after #${sc.after.n}`);
      if (sc.loop?.length) lines.push(`loop: ${sc.loop.map((x) => `#${x.n}`).join(" → ")}`);
    }
    if (sc) {
      const pairs = given(sc);
      if (pairs.length) lines.push(pairs.map(([k, v]) => `${k}: ${short(v, 40)}`).join("\n"));
      const up = [];
      for (let x = sc.parent; x; x = x.parent) {
        up.push(given(x).map(([k, v]) => `${k}=${short(v, 16)}`).join(" ") || `#${x.n}`);
      }
      if (up.length) lines.push(`owners: ${up.join(" ‹ ")}`);
    }
    return lines.join("\n");
  }

  // ---- what the scheduler did, in words ----

  function words(g, m) {
    const name = (id) => nameOf(g, id);
    if ("due" in m) {
      return {
        id: m.due,
        cls: "k",
        text: `  ${name(m.due)} is due (a change it read${
          m.by !== undefined ? `, by ${name(m.by)}` : ""
        })`,
      };
    }
    if ("starts" in m) {
      return {
        id: m.starts,
        cls: "",
        text: `⚙ ${name(m.starts)} runs (run ${m.run}${
          m.part === "load" ? ", finding its program" : ""
        })`,
      };
    }
    if ("call" in m) {
      return { id: m.call, cls: "", text: `ƒ ${name(m.call)} on/${m.handler} called` };
    }
    if ("called" in m) {
      if (m.ended !== "failed") return undefined;
      return {
        id: m.called,
        cls: "err",
        text: `  ${name(m.called)} on/${m.handler} → failed${
          m.error ? `: ${cut(m.error, 80)}` : ""
        }`,
      };
    }
    if ("ends" in m) {
      const cls = m.ended === "failed" || m.ended === "looping"
        ? "err"
        : m.ended === "pending" || m.ended === "stopped"
        ? "pend"
        : "ok";
      const how = m.ended === "done"
        ? (m.equal ? "done, same value: readers sleep" : "done")
        : m.ended;
      return {
        id: m.ends,
        cls,
        text: `  ${name(m.ends)} → ${how}${
          m.waits !== undefined ? `, waits for ${name(m.waits)}` : ""
        }${m.error ? `: ${cut(m.error, 80)}` : ""}`,
      };
    }
    if ("acts" in m) {
      return {
        id: m.acts,
        cls: "err",
        text: `  ${name(m.acts)} acted → failed: ${cut(m.error ?? "", 80)}`,
      };
    }
    if ("started" in m) {
      return {
        id: m.started,
        cls: "ok",
        text: `+ ${m.name} started at ${pathText(m.place ?? [])}`,
      };
    }
    if ("gone" in m) return { id: m.gone, cls: "pend", text: `✕ ${name(m.gone)} gone` };
  }

  function moments(g, after = 0) {
    const list = [];
    for (const m of g.moments) {
      if (m.n <= after) continue;
      const w = words(g, m);
      if (w) {
        list.push({
          n: m.n,
          round: m.round,
          when: m.when,
          id: String(w.id),
          cls: w.cls,
          text: w.text,
        });
      }
    }
    return { gen: g.gen, last: g.n, list };
  }

  // ---- writes ----

  function act(g, op, a = {}) {
    const f = g.face;
    if (op === "kill") return f.kill(a.id);
    if (op === "replace") return f.replace(a.path);
    if (op === "call") return f.call(a.path, a.args);
    if (op === "write") return f.write(a.path, a.k, a.id, a.value);
    if (op === "go") {
      if (!g.travel) throw new Error("this host has no time travel");
      g.travelError = undefined;
      const r = g.travel.go(a.time);
      if (r && typeof r.then === "function") {
        r.then(() => version++, (e) => (g.travelError = String(e?.message ?? e)));
      }
      return undefined;
    }
    throw new Error(`no such act: ${op}`);
  }

  // ---- the agent ----

  /** f as JSON-safe: { ok } or { error } */
  function attempt(f) {
    try {
      const ok = f();
      if (ok && typeof ok.then === "function") {
        ok.catch(() => {});
        return { ok: "a promise: its result lands later" };
      }
      if (ok === undefined) return { ok: null };
      const text = json(ok);
      try {
        return { ok: JSON.parse(text) };
      } catch {
        return { ok: text };
      }
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }
  const named = (name, f) => {
    const g = graphs.get(name);
    if (!g) return { gone: true };
    try {
      return f(g);
    } catch (e) {
      return { error: String(e?.stack ?? e?.message ?? e) };
    }
  };

  const agent = {
    v: VERSION,
    ask,
    answer,
    status() {
      return {
        v: VERSION,
        version,
        graphs: [...graphs.values()].map((g) => ({
          name: g.name,
          gen: g.gen,
          kind: g.face.kind,
          time: g.face.time(),
          version: g.face.version(),
          events: g.n,
          can: { ...g.face.can, scheduler: !!g.face.scheduler?.() },
          travel: !!g.travel,
          travelError: g.travelError,
        })),
      };
    },
    tree: (name, view) => named(name, (g) => tree(g, view)),
    map: (name, view) => named(name, (g) => map(g, view)),
    pick: (name, picked) => named(name, (g) => detail(g, picked)),
    shape: (name, mode, picked) => named(name, (g) => shape(g, mode, picked)),
    moments: (name, after) => named(name, (g) => moments(g, after)),
    times: (name) =>
      named(name, (g) => {
        if (!g.travel) return { none: true };
        const times = (g.travel.times() ?? []).map((t) => ({
          time: Number(t.time),
          label: String(t.label ?? ""),
        }));
        return { times, note: g.travel.note };
      }),
    act: (name, op, args) => named(name, (g) => attempt(() => act(g, op, args))),
    stop() {
      for (const g of [...graphs.values()]) g.forget();
    },
  };

  Object.defineProperty(globalThis, AGENT, { value: agent, configurable: true });
  ask();
  return true;
})();
