// A mounted terminal's windows, kept as windows of this one: for a program
// a host runs (as the C terminal runs programs/mount, at its /windows), with
// a mount of another terminal's shared /windows, or of one shared window
// (relay.ts, through mount.ts). It keeps them at options.place, names below
// the program's own place ([], the place itself, by default): nowhere is
// fixed. For each window there it keeps a node, under the same name, with
// screen, keys and size below it, all ephemeral, so they go when the program
// is killed. When what is mounted is one window (it has a screen), it is
// kept as one window named options.as. Each screen is kept in step with the remote one: read once,
// then each change the remote pushes is written here as the same patches.
// Each key the person writes into a kept window's keys node is written to
// the remote window's keys node. The remote window's size is its own
// terminal's; the size here is this terminal's, and is not sent.
//
// Windows come and go as the remote /windows says: its subscription tells of
// each placement and unplacement under it, and a listing every few seconds
// catches anything missed.
//
// A screen is written here at most options.rate times a second (60 by
// default): what came since the last write is one write, its patches one
// after another, and a write of one snapshot makes what came before it
// needless. A write here that takes longer than a second, or more than 50
// events waiting, shows in the mount's window (options.show) until it
// catches up.

import { ours } from "../types.ts";
import type { Lines } from "./lines.ts";
import type { Remote } from "./mount.ts";

ours(import.meta.url);

import type { Json } from "../types.ts";
type Event = {
  change?: { time?: number; kind?: string; patches?: unknown; cause?: unknown };
  reaches?: unknown;
};

/** A write of one snapshot: what came before it is needless. */
const whole = (e: Event) =>
  e.reaches === undefined && e.change?.kind === "write" && Array.isArray(e.change.patches) &&
  e.change.patches.length === 1 && (e.change.patches[0] as { type?: unknown })?.type === "snapshot";

/** One remote window, kept here. */
type Kept = {
  name: string; // its name here
  at: string[]; // its address at the remote: [name], or [] when one window is mounted
  id: string;
  ready: boolean;
  gone: boolean;
  time: number; // the remote screen's change time when it was read
  queued: Event[]; // its events before it was read
  remoteSub?: number;
  keysSub?: number;
  // its screen's writes here, at most options.rate a second
  pending: Event[]; // what came since the last write
  writing: boolean;
  last: number; // when the last write began (ms)
  took: number; // how long it took (ms)
  timer?: ReturnType<typeof setTimeout>;
  coalesced: number; // events a later snapshot made needless
};

export type MirrorOptions = {
  /** the agent of the mount's requests to the remote (its owner acts as its own process anyway) */
  agent: Json;
  /** this program's own process id here: the kept nodes' ids start with it */
  id: string;
  /** where to keep the windows: names below the program's place (default []) */
  place?: readonly string[];
  /** the name here of the window, when what is mounted is one window (default "mounted") */
  as?: string;
  /** what to show of the mount, a line each, when it changes */
  show?: (lines: string[]) => void;
  /** a listing of the remote /windows this often, in case a change was missed (ms) */
  every?: number;
  /** each screen written here at most this many times a second (default 60) */
  rate?: number;
};

export type Mirrored = {
  /** the remote windows kept now */
  windows(): string[];
  /** stops keeping them, and unplaces what it keeps here */
  stop(): Promise<void>;
};

/** Keeps the remote's windows as windows here, until the link ends or stop. */
export async function mirror(
  host: Lines,
  remote: Remote,
  options: MirrorOptions,
): Promise<Mirrored> {
  const kept = new Map<string, Kept>();
  const agent = options.agent;
  const place = [...(options.place ?? [])];
  let syncing = false, again = false, stopped = false;
  let status = "";
  const gap = 1000 / (options.rate ?? 60);

  /** the watchdog: windows whose writes here fall behind */
  const behind = () =>
    [...kept.values()].filter((k) => k.took > 1000 || k.pending.length > 50).map((k) =>
      ` behind: ${k.name}: a write took ${k.took} ms, ${k.pending.length} waiting, ${k.coalesced} replaced`
    );
  let shownBehind = "";
  const show = () =>
    options.show?.([
      ...(status ? [` ${status}`] : []),
      ...behind(),
      ` owner ${remote.owner.slice(0, 16)}...`,
      ` ${kept.size} window${kept.size === 1 ? "" : "s"}: ${[...kept.keys()].join(" ")}`,
      "",
      " C-g x on this window unmounts",
    ]);

  const log = (what: string, e: unknown) =>
    console.error(`mirror: ${what}: ${e instanceof Error ? e.message : JSON.stringify(e)}`);

  async function snapshot(k: Kept) {
    const items = await remote.read({ agent, address: [...k.at, "screen"] }) as {
      value?: Json;
      change?: { time?: number };
    }[];
    const item = items[0];
    return { value: item?.value ?? { rows: 0, cols: 0, lines: [] }, time: item?.change?.time ?? 0 };
  }

  /**
   * Keeps one remote window here. If it cannot, what it made is undone and
   * the window is not kept, so the next listing tries again; if it is
   * dropped (or stop is called) while being made, what it made is undone too.
   */
  async function add(name: string, at: string[]) {
    if (stopped) return;
    const k: Kept = {
      name,
      at,
      id: `${options.id}/${name}`,
      ready: false,
      gone: false,
      time: 0,
      queued: [],
      pending: [],
      writing: false,
      last: 0,
      took: 0,
      coalesced: 0,
    };
    kept.set(name, k);
    try {
      const { sub } = await remote.subscribe({
        agent,
        address: [...at, "screen"],
        send: (e) => {
          if (k.gone) return;
          if (k.ready) apply(k, e as Event);
          else k.queued.push(e as Event);
        },
      });
      k.remoteSub = sub;
      if (k.gone) return await undo(k);
      const screen = await snapshot(k);
      k.time = screen.time;
      if (k.gone) return await undo(k);
      const make = (address: string[], node: string, id: string, value: Json) =>
        host.request("place", {
          address: [...place, ...address],
          name: node,
          id,
          value,
          ephemeral: true,
        });
      await make([], name, k.id, { mounted: at[0] ?? null });
      if (k.gone) return await undo(k);
      await make([name], "screen", `${k.id}/screen`, screen.value);
      if (k.gone) return await undo(k);
      await make([name], "keys", `${k.id}/keys`, "");
      if (k.gone) return await undo(k);
      await make([name], "size", `${k.id}/size`, { rows: 0, cols: 0 });
      if (k.gone) return await undo(k);
      k.keysSub = await host.subscribe(
        { address: [...place, name, "keys"] },
        (e) => keys(k, e as Event),
      );
      if (k.gone) return await undo(k);
      k.ready = true;
      for (const e of k.queued.splice(0)) {
        if ((e.change?.time ?? Infinity) > k.time) apply(k, e);
      }
    } catch (e) {
      log(`keeping ${name}`, e);
      await drop(k);
      return;
    }
    show();
  }

  /** A change to the remote screen, to be made here with what else comes before the next write. */
  function apply(k: Kept, e: Event) {
    if (k.gone) return;
    k.pending.push(e);
    if (whole(e)) {
      k.coalesced += k.pending.length - 1;
      k.pending.splice(0, k.pending.length - 1);
    }
    schedule(k);
  }

  function schedule(k: Kept) {
    if (k.gone || k.writing || k.timer !== undefined || !k.pending.length) return;
    k.timer = setTimeout(() => write(k), Math.max(0, k.last + gap - Date.now()));
  }

  /** What came since the last write, made here as one: its patches, or the screen read again. */
  async function write(k: Kept) {
    k.timer = undefined;
    if (k.gone || !k.pending.length) return;
    const events = k.pending.splice(0);
    k.writing = true;
    k.last = Date.now();
    try {
      const patches = events.map((e) => e.change?.patches);
      if (events.every((e) => !e.reaches && Array.isArray(e.change?.patches))) {
        await host.request("write", {
          address: [...place, k.name, "screen"],
          patches: (patches as unknown[][]).flat(),
        });
      } else {
        const screen = await snapshot(k);
        await host.request("write", {
          address: [...place, k.name, "screen"],
          patches: [{ type: "snapshot", value: screen.value }],
        });
      }
    } catch (err) {
      log(`screen of ${k.name}`, err);
    }
    k.writing = false;
    k.took = Date.now() - k.last;
    const now = behind().join("\n");
    if (now !== shownBehind) {
      shownBehind = now;
      show();
    }
    schedule(k);
  }

  /** A key the person wrote here, written to the remote window, with its cause here. */
  async function keys(k: Kept, e: Event) {
    const patches = e.change?.patches;
    if (k.gone || !Array.isArray(patches)) return;
    try {
      const cause = e.change?.cause;
      await remote.write({
        agent,
        address: [...k.at, "keys"],
        patches,
        ...(cause === undefined ? {} : { cause: cause as never }),
      });
    } catch (err) {
      log(`keys of ${k.name}`, err);
    }
  }

  /** Stops keeping a window, and unplaces what was made of it. */
  async function drop(k: Kept) {
    k.gone = true;
    clearTimeout(k.timer);
    k.pending.length = 0;
    k.queued.length = 0;
    if (kept.get(k.name) === k) kept.delete(k.name);
    await undo(k);
    show();
  }

  /** What was made of a window: its subscriptions ended, its nodes unplaced. Again if more was made since. */
  async function undo(k: Kept) {
    const keysSub = k.keysSub, remoteSub = k.remoteSub;
    k.keysSub = k.remoteSub = undefined;
    if (keysSub !== undefined) {
      host.deaf(keysSub);
      await host.request("unsubscribe", { sub: keysSub }).catch(() => {});
    }
    if (remoteSub !== undefined) {
      await remote.unsubscribe({ agent, sub: remoteSub }).catch(() => {});
    }
    for (const node of ["size", "keys", "screen"]) {
      await host.request("unplace", {
        address: [...place, k.name],
        name: node,
        id: `${k.id}/${node}`,
      })
        .catch(() => {});
    }
    await host.request("unplace", { address: [...place], name: k.name, id: k.id }).catch(() => {});
  }

  /** The remote /windows listed, and what is kept made to match it. */
  async function sync() {
    if (syncing) return void (again = true);
    syncing = true;
    try {
      do {
        again = false;
        if (stopped) break;
        const listing = await remote.directory({ agent, address: [] }) as {
          directory: [string, { id?: string; pending?: boolean }[]][];
        };
        const names = listing.directory.filter(([, items]) => items.some((i) => i.id && !i.pending))
          .map(([n]) => n);
        // one window mounted (it has a screen): kept as one, named options.as; else each window under its name
        const here = new Map<string, string[]>(
          names.includes("screen") ? [[options.as ?? "mounted", []]] : names.map((n) => [n, [n]]),
        );
        for (const k of [...kept.values()]) {
          if (k.at.join("/") !== here.get(k.name)?.join("/")) await drop(k);
        }
        for (const [name, at] of here) if (!kept.has(name)) await add(name, at);
      } while (again);
    } catch (e) {
      log("listing", e);
    }
    syncing = false;
  }

  await remote.subscribe({ agent, address: [], send: () => sync() });
  const timer = setInterval(sync, options.every ?? 5000);
  await sync();
  show();

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const k of [...kept.values()]) await drop(k);
  };
  remote.closed.then(async (why) => {
    status = `link closed: ${why}`;
    await stop();
    show();
  });
  return { windows: () => [...kept.keys()], stop };
}
