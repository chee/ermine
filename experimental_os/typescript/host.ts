// host.ts: core 0 of the ermine OS. It loads the SD card, builds the stack
// (sync > procs > protect > keeper > the bare graph), makes /hw from the device
// tree the metal handed over, starts /boot, and runs the loop of PI-OS.tex:
// drain the ring into handler calls, settle, keep, wait. With --bare it
// builds no stack and runs the bare monitor instead.

import { graph, type Graph, type Kept } from "../../core/graph/typescript/graph.ts";
import { matches, type May, protect, type Rule } from "../../core/protect/typescript/protect.ts";
import type { Id, Json } from "../../core/graph/typescript/types.ts";
import { keep, type Keeper, load } from "../../experimental_layers/keep/typescript/keeper.ts";
import { files } from "../../experimental_layers/keep/typescript/deno/files.ts";
import type { Metal, Rec } from "./metal.ts";
import { Display, Fonts, Line, Pasteboard, Power, Sound, Timer, Web } from "./ports.ts";
import { type Agent, type Procs, procs, resolve } from "./procs.ts";
import { image, update } from "./image.ts";
import { Console } from "./console.ts";
import { Blitter } from "./blitter.ts";
import { sync } from "./sync.ts";

export type Options = {
  /** the SD card: a folder the keeper writes its log in */
  sd: string;
  metal: Metal;
  /** what the host says, besides /dev/cons */
  say?: (text: string) => void;
  /** booted with the service flag: raw commands to the metal are allowed at hw> */
  service: boolean;
  /** booted bare: no stack, the monitor */
  bare: boolean;
};

/** A rule as /etc/rules holds it: PROTECT.tex's, and "under", a path from the root this host matches. */
type HostRule = Rule & { under?: string; note?: string };

/** The irqs of a person's hands: the host vouches that a person made them. */
const HANDS = new Set([34, 35, 36]);
const HOST: Agent = { actor: "machine", code: [] };

export class Machine {
  g!: Graph;
  keeper!: Keeper;
  procs?: Procs;
  running = false;
  base = 0;
  last = 0;
  /** core 0's busy share of the last second, per mille */
  load = 0;
  turns = 0;
  person: string;
  timer: Timer;
  #busy = 0;
  #window = 0;
  #second = -1;
  #minute = -1;
  #flushing?: Promise<void>;
  #lastFlush = 0;
  #counts = new Map<number, number>();
  /** records for lines no driver has claimed yet */
  #pending = new Map<number, Rec[]>();
  #folded = new Map<number, string>();
  #loop?: Promise<void>;
  #log: string[] = [];
  #monitor?: Console;
  /** whether sync is in the stack this boot */
  synced = false;
  /** the last raw records, for a person at hw> */
  recent: Rec[] = [];

  constructor(readonly o: Options) {
    this.person = o.metal.dt.user;
    this.timer = new Timer(o.metal);
  }

  /** time: one clock, unique and increasing, microseconds since T on the metal's clock. */
  clock = () => {
    this.last = Math.max(this.last + 1, this.base + this.o.metal.now());
    return this.last;
  };

  /** The host's own words: to its log, and to /dev/cons, which the screen shows under everything. */
  say(text: string) {
    this.o.say?.(text);
    this.#log.push(text);
    if (this.#log.length > 200) this.#log.shift();
    this.#monitor?.print(text + "\n");
    const api = this.procs?.api;
    if (!api) return;
    try {
      const address = ["/", "dev", "cons"];
      if (this.g.read({ agent: "machine", address }).length) {
        api.write({ agent: HOST as Json, address, patches: [{ type: "snapshot", value: [...this.#log] }] });
      }
    } catch {
      // not yet
    }
  }

  async boot(): Promise<void> {
    const backend = files(this.o.sd);
    let kept: Kept | undefined;
    try {
      kept = await load(backend);
    } catch (e) {
      this.say(`the SD card could not be read: ${(e as Error).message}; booting empty`);
    }
    this.g = graph("machine", kept);
    this.keeper = keep(this.g, backend, "machine", { kept, auto: false, failed: (e) => this.say(`keeper: ${e}`) });
    this.base = (kept?.time ?? 0) + 1;
    this.last = this.base - 1;
    const dt = this.o.metal.dt;
    this.say(`ermine on ${dt.model}, ${dt.cpu}, ${dt.cores} cores, ${Math.round(dt.memory / 2 ** 30)} GB; ${dt.os}`);
    this.say(kept ? `the SD card (${this.o.sd}) holds a graph up to T=${kept.time}` : `the SD card (${this.o.sd}) is empty`);
    if (this.o.bare) {
      this.bareMonitor();
      return;
    }
    const may: May = (agent, process, op, args) => this.may(agent, process, op, args);
    const prot = protect(this.keeper, may);
    const p = procs({
      graph: this.g,
      below: prot,
      release: (op) => this.keeper.release!(op),
      // a change made elsewhere, which sync takes in
      apply: (id, change) => this.keeper.apply!(id, change),
      clock: this.clock,
      host: HOST,
      log: (t) => this.say(t),
    });
    this.procs = p;
    const api = p.api;
    // the image is the machine's own, as firmware is: it writes the card beneath protect, before any process runs
    const below = {
      ...this.keeper,
      place: (op: Parameters<Keeper["place"]>[0]) => this.keeper.place({ ...op, time: this.clock() }),
      write: (op: Parameters<Keeper["write"]>[0]) => this.keeper.write({ ...op, time: this.clock() }),
    };
    if (!kept) {
      await image(below, this.person);
      this.say("first boot: the image made the SD card");
    } else {
      try {
        for (const line of await update(below, this.person)) this.say(line);
      } catch (e) {
        this.say(`image: the update stopped: ${(e as Error).message}`);
      }
    }
    // sync: a wrapper over procs, the top of the stack from here, before any process runs (sync.ts)
    try {
      const synced = await sync({ sd: this.o.sd, graph: this.g, procs: p, host: HOST, say: (t) => this.say(t) });
      this.synced = true;
      // keeping the graph keeps what sync committed too (SYNC.tex, Starting again)
      const flush = this.keeper.flush;
      this.keeper.flush = () => Promise.all([flush(), synced.flush()]).then(() => {});
    } catch (e) {
      this.say(`sync: ${(e as Error).message}; no sync this boot`);
    }
    this.makeHw(api);
    this.makeStack(api);
    api.place({ agent: HOST as Json, address: ["/", "dev"], name: "cons", id: "cons", value: [...this.#log], ephemeral: true });
    api.write({ agent: HOST as Json, address: ["/", "dev", "clock"], patches: [{ type: "snapshot", value: { base: this.base, unit: "µs" } }] });
    this.tickClock(true);
    const boot = this.g.read({ agent: "machine", address: ["/", "boot"] })[0]?.value;
    const entries = Array.isArray(boot) ? boot as { [k: string]: Json }[] : [];
    for (const [i, entry] of entries.entries()) {
      try {
        const pid = p.start({
          at: entry.start as string[],
          program: entry.program as string,
          name: (entry.name as string | undefined) ?? undefined,
          data: entry.data ?? null,
          chroot: typeof entry.chroot === "number" ? entry.chroot : undefined,
          actor: entry.actor === "person" ? this.person : (entry.actor ?? "machine"),
          cause: { boot: i },
        });
        this.say(`start ${pid}  /${(entry.start as string[]).join("/")}  ${entry.program}`);
      } catch (e) {
        this.say(`boot: ${JSON.stringify(entry)}: ${(e as Error).message}`);
      }
    }
  }

  /** The host's may: /etc/rules, first match wins, none allows; a rule's "under" matches a path. */
  may(agent: Json, process: Id | undefined, op: string, args: object): ReturnType<May> {
    const list = this.g.read({ agent: "machine", address: ["/", "etc", "rules"] })[0]?.value;
    if (!Array.isArray(list)) return true;
    const a = args as { address?: string[]; place?: string[]; chroot?: number; program?: string };
    const program = a.program ?? this.procs?.programOf(agent);
    let path: string | undefined;
    if (Array.isArray(a.address)) {
      try {
        path = "/" + resolve(a.place ?? [], a.chroot ?? 0, a.address).join("/");
      } catch {
        path = undefined;
      }
    }
    const given = program ? { ...args, program } : args;
    for (let i = 0; i < list.length; i++) {
      const { under, note: _n, ...plain } = list[i] as HostRule;
      if (under !== undefined) {
        if (path === undefined) continue;
        const prefix = under.endsWith("/") ? under : under + "/";
        if (path !== under && !path.startsWith(prefix)) continue;
      }
      if (!matches(plain, agent, process, op, given)) continue;
      return plain.allow === true || { rule: i };
    }
    return true;
  }

  /** /hw from the device tree: made again at each boot, ephemeral, by host code. */
  makeHw(api: Procs["api"]) {
    const dt = this.o.metal.dt;
    const place = (address: string[], name: string, id: Id, value: unknown) =>
      api.place({ agent: HOST as Json, address, name, id, value: value as Json, ephemeral: true });
    place(["/"], "hw", "hw", { model: dt.model, cpu: dt.cpu, cores: dt.cores, memory: dt.memory, os: dt.os, host: dt.host, user: dt.user });
    place(["/", "hw"], "screens", "hw.screens", null);
    dt.screens.forEach((s, i) => place(["/", "hw", "screens"], String(i), `hw.screen.${i}`, s));
    place(["/", "hw"], "fb", "hw.fb", { ...dt.fb });
    const bin = atob(dt.font.alpha);
    const alpha = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) alpha[i] = bin.charCodeAt(i);
    place(["/", "hw"], "font", "hw.font", { name: dt.font.name, w: dt.font.w, h: dt.font.h, chars: dt.font.chars, alpha });
    place(["/", "hw"], "devices", "hw.devices", null);
    place(["/", "hw"], "irq", "hw.irq", null);
    const m = this.o.metal;
    const ports: { [name: string]: unknown } = {
      display: new Display(m),
      speech: new Sound(m),
      uart0: new Line(m),
      clipboard: new Pasteboard(m),
      power: new Power(m),
      web: new Web(m),
      font: new Fonts(m),
    };
    // core 0's own devices: the timer, and the blitter, the 2D engine any program may use
    ports.blitter = new Blitter({ w: dt.font.w, h: dt.font.h, chars: dt.font.chars, alpha });
    const devices = [
      ...dt.devices,
      { name: "timer", irq: 97, note: "core 0's own" },
      { name: "blitter", note: "core 0's own: BitBlt, and text from the font ROM" },
    ];
    for (const d of devices) {
      place(["/", "hw", "devices"], d.name, `hw.dev.${d.name}`, d);
      const port = d.name === "timer" ? this.timer : ports[d.name];
      if (port) place(["/", "hw", "devices", d.name], "port", `hw.dev.${d.name}.port`, port);
      if (typeof d.irq === "number") {
        place(["/", "hw", "irq"], String(d.irq), `hw.irq.${d.irq}`, { device: d.name, owner: null, handler: "irq", count: 0, dropped: 0, masked: false });
      }
    }
    const p = this.procs!;
    // the raw stream, for a person at the hardware's depth
    p.hostHandler(["hw"], "records", (_h, n = 20) => this.recent.slice(-n) as unknown as Json);
    p.hostHandler(["hw"], "send", (_h, cmd: { op: string }) => {
      if (!this.o.service) throw new Error("raw commands to the metal need the service flag at power-on (-- --service)");
      this.o.metal.send(cmd);
      return true;
    });
  }

  /** /stack: the stack as a read-only node, and the host's handlers at that depth. */
  makeStack(api: Procs["api"]) {
    api.place({
      agent: HOST as Json,
      address: ["/"],
      name: "stack",
      id: "stack",
      value: [
        ...(this.synced ? ["sync, over Subduction (experimental_os/typescript/sync.ts)"] : []),
        "procs (experimental_os/typescript/procs.ts)",
        "protect, with /etc/rules",
        `keeper, on ${this.o.sd}`,
        "the bare graph, root machine",
      ],
      ephemeral: true,
    });
    const p = this.procs!;
    // new code is shown as new; replacing it is a person's choice
    p.hostHandler(["stack"], "replace", (_h, pid: string) => p.replace(pid));
    p.hostHandler(["stack"], "flush", () => {
      this.flush(true);
      return "writing the SD card";
    });
    p.hostHandler(["stack"], "live", () => [...p.live().entries()].map(([id, v]) => `${id}: ${String(v)}`) as Json);
  }

  /** host code that writes /dev/clock/second and minute as they turn, and wall each second */
  tickClock(force = false) {
    const second = Math.floor(this.o.metal.now() / 1e6);
    if (second === this.#second && !force) return;
    this.#second = second;
    const api = this.procs!.api;
    const w = (name: string, value: Json) => {
      const address = ["/", "dev", "clock", name];
      if (this.g.read({ agent: "machine", address }).length) {
        api.write({ agent: HOST as Json, address, patches: [{ type: "snapshot", value }] });
      } else api.place({ agent: HOST as Json, address: ["/", "dev", "clock"], name, id: `clock-${name}`, value });
    };
    w("second", second);
    const minute = Math.floor(second / 60);
    if (minute !== this.#minute || force) {
      this.#minute = minute;
      w("minute", minute);
    }
    const now = new Date();
    w("wall", now.toTimeString().slice(0, 8));
    if (force || now.getSeconds() === 0) w("date", now.toDateString());
    this.fold();
  }

  /** counts folded into /hw/irq once a second, never per interrupt */
  fold() {
    const api = this.procs!.api;
    const irqs = this.g.directory({ agent: "machine", address: ["/", "hw", "irq"] });
    for (const [name] of "directory" in irqs ? irqs.directory : []) {
      const irq = Number(name);
      const item = this.g.read({ agent: "machine", address: ["/", "hw", "irq", name] })[0];
      if (!item) continue;
      const v = item.value as { [k: string]: Json };
      const count = (v.count as number) + (this.#counts.get(irq) ?? 0);
      const dropped = this.o.metal.dropped.get(irq) ?? 0;
      const next = { ...v, count, dropped };
      const key = JSON.stringify(next);
      if (this.#folded.get(irq) === key) continue;
      this.#folded.set(irq, key);
      this.#counts.set(irq, 0);
      api.write({ agent: HOST as Json, address: ["/", "hw", "irq", name], patches: [{ type: "snapshot", value: next }] });
    }
  }

  /** Every record since the last turn: one handler call for each owner. */
  drain(): number {
    const recs = this.o.metal.take();
    // lines claimed since the last turn get what waited for them, first
    for (const [irq, held] of [...this.#pending]) {
      const owner = (this.g.read({ agent: "machine", address: ["/", "hw", "irq", String(irq)] })[0]?.value as { owner?: string } | undefined)?.owner;
      if (!owner) continue;
      this.#pending.delete(irq);
      recs.unshift(...held);
    }
    if (!recs.length) return 0;
    this.recent.push(...recs);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    const p = this.procs!;
    const groups = new Map<string, { owner: string; handler: string; irqs: Set<number>; recs: Rec[] }>();
    for (const r of recs) {
      if (r.irq === 1) {
        this.say(`power off (${r.why})`);
        this.running = false;
        continue;
      }
      this.#counts.set(r.irq, (this.#counts.get(r.irq) ?? 0) + 1);
      const line = this.g.read({ agent: "machine", address: ["/", "hw", "irq", String(r.irq)] })[0]?.value as
        | { owner?: string; handler?: string; masked?: boolean }
        | undefined;
      if (!line?.owner || line.masked) {
        // no driver has the line yet: it stays pending, as a level-triggered interrupt does
        const held = this.#pending.get(r.irq) ?? [];
        held.push(r);
        if (held.length > 64) held.shift();
        this.#pending.set(r.irq, held);
        continue;
      }
      const key = `${line.owner} ${line.handler ?? "irq"}`;
      let gr = groups.get(key);
      if (!gr) groups.set(key, gr = { owner: line.owner, handler: line.handler ?? "irq", irqs: new Set(), recs: [] });
      gr.irqs.add(r.irq);
      gr.recs.push(r);
    }
    for (const gr of groups.values()) {
      if (!p.owner(gr.owner)) continue;
      const irq = [...gr.irqs];
      // a person's hands: the host vouches for them
      const caller: Agent = irq.every((i) => HANDS.has(i))
        ? { actor: this.person, person: this.person, trusted: true, irq, code: [] }
        : { actor: "machine", irq, code: [] };
      try {
        p.call(["proc", gr.owner, "on", gr.handler], caller, [gr.recs]);
      } catch (e) {
        this.say(`irq ${irq} to ${gr.owner}: ${(e as Error).message}`);
      }
    }
    return recs.length;
  }

  flush(now = false) {
    const t = performance.now();
    if (!now && t - this.#lastFlush < 5000) return;
    if (this.#flushing) return;
    this.#lastFlush = t;
    this.#flushing = this.keeper.flush().catch((e) => this.say(`keeper: ${e}`)).finally(() => {
      this.#flushing = undefined;
    });
  }

  run() {
    this.running = true;
    this.o.metal.send({ op: "ready" });
    this.#loop = this.loop();
  }

  /** resolves when the loop stops: power off */
  stopped(): Promise<void> {
    return this.#loop ?? Promise.resolve();
  }

  async loop(): Promise<void> {
    while (this.running) {
      const t0 = performance.now();
      if (this.#monitor) this.monitorTurn();
      else {
        this.drain();
        if (!this.running) break;
        this.tickClock();
        const ran = this.procs!.settle(4000);
        if (ran >= 4000) this.say("a turn hit its budget of 4000 runs");
        this.flush();
      }
      this.turns++;
      this.account(performance.now() - t0);
      if (this.procs && this.procs.due() > 0) {
        await new Promise((r) => setTimeout(r, 0));
        continue;
      }
      await this.o.metal.wait(1000 - (this.o.metal.now() / 1000) % 1000);
    }
    if (this.keeper) {
      await this.#flushing;
      await this.keeper.flush().catch(() => {});
    }
  }

  account(work: number) {
    const now = performance.now();
    this.#busy += work;
    if (now - this.#window >= 1000) {
      this.load = Math.min(1000, Math.round((this.#busy / (now - this.#window)) * 1000));
      this.#busy = 0;
      this.#window = now;
    }
  }

  async off(): Promise<void> {
    this.running = false;
    this.o.metal.post({ irq: 2, at: this.o.metal.now() });
    await this.stopped();
  }

  // --- the bare monitor: no stack, operations on the bare graph, on the screen and the serial line

  bareMonitor() {
    const m = this.o.metal;
    this.#monitor = new Console(m);
    this.#monitor.print(
      "\n*** booted bare: the monitor ***\n" +
        "no scheduler, no protect, no processes. Every change here carries this file's site.\n" +
        "read path | ls path | write path json | rm path name id | off\n\nbare# ",
    );
    this.run();
  }

  #line = "";
  monitorTurn() {
    for (const r of this.o.metal.take()) {
      if (r.irq === 1) {
        this.running = false;
        return;
      }
      let text = "";
      if (r.irq === 36) text = atob(r.rx as string);
      else if (r.irq === 34 && r.down) text = r.key === "Enter" ? "\r" : r.key === "Backspace" ? "\x7f" : (r.text as string);
      else if (r.irq === 33 && r.event === "mode") this.#monitor!.mode(r.w as number, r.h as number);
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          const line = this.#line.trim();
          this.#line = "";
          let said: string;
          try {
            said = this.bare(line);
          } catch (e) {
            said = `error: ${(e as Error).message}`;
          }
          this.#monitor!.print("\n" + said + (said ? "\n" : "") + "bare# ");
        } else if (ch === "\x7f" || ch === "\b") {
          if (this.#line) {
            this.#line = this.#line.slice(0, -1);
            this.#monitor!.print("\b \b");
          }
        } else if (ch >= " ") {
          this.#line += ch;
          this.#monitor!.print(ch);
        }
      }
    }
  }

  bare(line: string): string {
    const [cmd, path = "/", ...rest] = line.split(/\s+/);
    const address = ["/", ...path.split("/").filter((n) => n)];
    const show = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof ArrayBuffer ? `bytes(${v.byteLength})` : v));
    const agent = { actor: this.person, code: [] };
    switch (cmd) {
      case "":
        return "";
      case "read":
        return this.g.read({ agent, address }).map((i) => show(i)).join("\n") || "(nothing)";
      case "ls": {
        const l = this.g.directory({ agent, address });
        if (!("directory" in l)) return "";
        return l.directory.map(([n, items]) => `${n}  ${items.map((i) => i.id + (i.pending ? "…" : "")).join(" ")}`).join("\n");
      }
      case "write": {
        const value = JSON.parse(rest.join(" "));
        // the keeper, beneath every other layer: so a change made here is saved
        const c = this.keeper.write({ agent, address, time: this.clock(), patches: [{ type: "snapshot", value }] });
        return `t=${c.change.time} cause ${show(c.change.cause)}`;
      }
      case "rm": {
        const [name, id] = rest;
        const c = this.keeper.unplace({ agent, address, name, id, time: this.clock() });
        return `t=${c.change.time}`;
      }
      case "off":
        this.running = false;
        return "power off";
    }
    return `no command ${cmd}`;
  }
}
