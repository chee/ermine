// A share: a process that serves a subtree of this graph on a channel, as
// serve.ts serves it, for as long as it runs. The owner's side of a mirror
// (mirror.ts), as a process, because everything that does something is one:
// it is started the scheduler's way, shows where it runs, and stops when it
// is killed.
//
// Its value is {"channel": c, "address": a, "url"?: u}: the channel to serve
// on, the address from the root of the subtree served, and, for the host's
// connect, the server to reach the channel through. What mounters do is
// served against the interface the host gives (api), as serve.ts does it:
// each mounter's operations carry the agent and cause it sent, and act as no
// process of the owner's. The share process only holds the link open.
//
// Its status is its ephemeral node ./pid/link: {"state": "connecting" |
// "serving" | "gone", "channel": c, "address": a, "self"?: key, "mounters":
// [peer…], "why"?: text}. Killing it ends every mount, each told why, and the
// status goes with the process's other ephemeral nodes.
//
// What is served is the subtree and nothing else. serve.ts chroots every
// address there, but a placement names an id, not an address: placing an id
// the owner has, with no value, puts that node in one more place (CORE.tex,
// Placement), so a mounter that knew or guessed the id of a node outside the
// subtree could mount it inside and read and write it. So a mounter's
// placement of an id with no value is refused unless a walk of the subtree,
// as the mounter reads it, finds that id: it can move and mount what it can
// already reach, never bring in what it cannot.

import { isObject } from "../patch.ts";
import type { Builtin, ComputeGiven, EffectGiven, Running } from "../loaders.ts";
import {
  type Id,
  type Interface,
  invalid,
  type Json,
  type Listing,
  ours,
  type PlaceOp,
  Refused,
  type WriteOp,
} from "../types.ts";
import { serve, type Served, type ServeOptions } from "./serve.ts";
import type { Later } from "./later.ts";
import type { Transport } from "./wire.ts";

ours(import.meta.url);

export type ShareOptions = ServeOptions & {
  /** The transport for a share's channel; given the share's whole value, for its url. */
  connect: (channel: string, value: ShareValue) => Transport;
  /** The interface served: the top of the host's stack, as its outside acts use it. */
  api: () => Interface;
};

/** What a share's value says. */
export type ShareValue = { channel: string; address: string[]; url?: string };

export type ShareStatus = {
  state: "connecting" | "serving" | "gone";
  channel: string;
  address: string[];
  self?: string;
  mounters: string[];
  why?: string;
};

/** Whether a value is a share's. */
export function isShare(v: unknown): v is ShareValue {
  return isObject(v) && typeof v.channel === "string" && Array.isArray(v.address) &&
    v.address.every((n) => typeof n === "string") &&
    (v.url === undefined || typeof v.url === "string");
}

/**
 * The api a share serves: as given, but a placement with no value is refused
 * unless the id is already in the subtree at served, as the placer reads it.
 */
function within(api: Interface, served: readonly string[]): Interface {
  const place = (op: PlaceOp) => {
    if (op.value === undefined && !reaches(api, served, op)) {
      throw new Refused({
        code: "rule",
        rule: "served",
        id: op.id,
        text: `${
          JSON.stringify(op.id)
        } is not in what is shared: a mounter can place only what it can reach`,
      }, "place");
    }
    return api.place(op);
  };
  const out = Object.create(api) as Interface;
  return Object.assign(out, { place });
}

/** Whether a walk of the subtree at served, as op's agent reads it, finds op.id. */
function reaches(api: Interface, served: readonly string[], op: PlaceOp): boolean {
  const at = {
    agent: op.agent,
    place: [...served],
    chroot: served.length,
  };
  const seen = new Set<Id>();
  const paths: string[][] = [[]];
  const root = api.read({ ...at, address: [] })[0]?.from.route;
  const top = root?.length ? root[root.length - 1].node : undefined;
  if (top === op.id) return true;
  if (top !== undefined) seen.add(top);
  while (paths.length) {
    const path = paths.pop()!;
    let listing: Listing;
    try {
      listing = api.directory({ ...at, address: path }) as Listing;
    } catch {
      continue; // refused, or gone: not reachable this way
    }
    if (!("directory" in listing)) continue;
    for (const [name, items] of listing.directory) {
      for (const item of items) {
        if (item.id === op.id) return true;
      }
      const first = items.find((i) => !i.pending);
      if (first && !seen.has(first.id)) {
        seen.add(first.id);
        paths.push([...path, name]);
      }
    }
  }
  return false;
}

/** What shares give a host: the program for builtin's table, and what each share serves now. */
export type Shares = {
  readonly program: Builtin;
  readonly served: ReadonlyMap<Id, Served>;
};

/** The host's shares: one served subtree for each share process running. */
export function shares(options: ShareOptions): Shares {
  const served = new Map<Id, Served>();
  const program: Builtin = {
    compute({ api, name, pending }: ComputeGiven) {
      const own = api.read({ address: [name] }).find((i) => "value" in i);
      if (!own) return pending;
      if (!isShare(own.value)) {
        throw invalid(
          "wrong-field",
          'a share\'s value is {"channel": c, "address": [names…], "url"?: u}',
          { field: "value" },
        );
      }
      const { channel, address, url } = own.value;
      return url === undefined ? { channel, address } : { channel, address, url };
    },
    effect({ self, name, value, lasting }: EffectGiven) {
      if (served.has(self) || !isShare(value)) return;
      let status: ShareStatus = {
        state: "connecting",
        channel: value.channel,
        address: [...value.address],
        mounters: [],
      };
      lasting.place({
        address: [name],
        name: "link",
        id: `${self}/link`,
        value: status as unknown as Json,
        ephemeral: true,
      } as PlaceOp);
      let over = false;
      const say = (change: Partial<ShareStatus>) => {
        if (over) return;
        status = { ...status, ...change };
        try {
          lasting.write({
            address: [name, "link"],
            patches: [{ type: "snapshot", value: status as unknown as Json }],
          } as WriteOp);
        } catch {
          over = true; // killed meanwhile
        }
      };
      const transport = options.connect(value.channel, value);
      const s = serve(within(options.api(), value.address), value.address, transport, options);
      served.set(self, s);
      const mounters = () => say({ mounters: s.peers() });
      const begun = s.wire.onconn!;
      s.wire.onconn = (conn) => {
        begun(conn);
        mounters();
        conn.closed.then(mounters);
      };
      const ready = (transport as Partial<Later>).ready;
      if (ready) {
        ready.then(
          (t) => say({ state: "serving", self: t.self }),
          (e) => {
            say({ state: "gone", why: e instanceof Error ? e.message : String(e) });
            served.delete(self);
            s.close().catch(() => {});
          },
        );
      } else say({ state: "serving", self: transport.self });
    },
    killed(p: Running) {
      const s = served.get(p.id);
      served.delete(p.id);
      s?.close("the owner stopped sharing").catch(() => {});
    },
  };
  return { program, served };
}
