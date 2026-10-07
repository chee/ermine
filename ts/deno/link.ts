// A link from the command line, so a host that only speaks lines on a pipe,
// as the C terminal does, can link:
//
// Wherever a channel goes, a name may go instead (src/link/name.ts): 64 hex
// digits are a channel, and anything else is a name, whose channel is the
// hex of sha256("ermine channel:" + name), the same in every host.
//
//   deno run deno/link.ts new [name]
//       prints a fresh channel, or the name's
//   deno run --allow-net --allow-read --allow-env deno/link.ts serve [channel]
//       serves a fresh graph, the reference scheduler's stack over it, with
//       root "root", whole; prints the channel and its peer id on stderr,
//       and serves until killed
//   deno run --allow-net --allow-read --allow-env deno/link.ts mount <channel>
//       mounts what the channel's owner serves, and bridges it to stdin and
//       stdout as PROTOCOL.tex lines (src/link/bridge.ts): one request a line
//       in, one answer a line out, in order, until stdin closes
//
//
// Two more run as ermine programs inside a host that speaks lines to them on
// stdin and stdout, as the C terminal's ermine loader does, started at the
// place to share or keep windows in (the terminal's /windows, without
// scope), with ERMINE_PID their process's id there, and with the host
// pushing their events ("push": true in the program):
//   link.ts host [channel]
//       shares its place over the link (src/link/relay.ts): each mounter's
//       requests go to the host as lines, chrooted at what it shares, and the
//       answers and events come back. The channel is the one given, else the
//       one its process node's value gives, else a fresh one. It shows the
//       channel, and the name if it was given one, in its window's screen,
//       and prints them on stderr.
//   link.ts mirror [channel]
//       mounts the channel (given, else its process node's value's) and keeps
//       each window there as a window here (src/link/windows.ts): screens kept
//       in step, keys typed here sent there.
//
// Their process node's value: null; a string, the channel or a name; or
// {"channel": channel or name, "place": [names]?}. For host, "place" is what
// to share, below its place ([], the whole place, by default; [pid] shares
// one window); for mirror, where to keep the windows, below its place
// ([] by default). A mirror of one shared window keeps it under the name, or
// the channel's first 8 digits.
//
// Each takes --url wss://... for another Subduction server than
// galaxy.observer. It lives here, not in src/link, because nothing under src
// uses Deno.

import { graph } from "../src/graph.ts";
import { stacks } from "../harness/main.ts";
import { channel } from "../src/link/wire.ts";
import { serve } from "../src/link/serve.ts";
import { mount } from "../src/link/mount.ts";
import { bridge } from "../src/link/bridge.ts";
import { Lines } from "../src/link/lines.ts";
import { relay } from "../src/link/relay.ts";
import { mirror } from "../src/link/windows.ts";
import { channelOf } from "../src/link/name.ts";

const USAGE =
  "usage: link.ts new [name] | serve [channel] | mount <channel> | host [channel] | mirror [channel]   [--url wss://...]\n" +
  "  (a channel is 64 hex digits, or a name standing for one)";

const encoder = new TextEncoder();

/** writes a line to stdout, whole */
function out(line: string) {
  const bytes = encoder.encode(line + "\n");
  let n = 0;
  while (n < bytes.length) n += Deno.stdout.writeSync(bytes.subarray(n));
}

/** each line read from stdin, until it closes */
async function* inLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of Deno.stdin.readable) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  if (pending) yield pending;
}

/** The host this program runs in, spoken to on stdout and stdin; the program exits when the host closes stdin. */
function hosted(): Lines {
  const lines = new Lines(out);
  (async () => {
    for await (const line of inLines()) lines.take(line);
    leave();
  })();
  return lines;
}

const isHex = (c: string) => /^[0-9a-f]{64}$/i.test(c.trim());

/** What a host or mirror was given, as an argument or its process node's value: the channel, the name, the place. */
type Given = { channel?: string; name?: string; place: string[]; why?: string };

function given(value: unknown): Given {
  const out: Given = { place: [] };
  let text: unknown = value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { channel?: unknown; place?: unknown };
    text = v.channel;
    if (v.place !== undefined) {
      if (Array.isArray(v.place) && v.place.every((n) => typeof n === "string")) {
        out.place = v.place;
      } else out.why = "place: a list of names";
    }
  }
  if (typeof text === "string" && text.trim()) {
    out.channel = channelOf(text);
    if (!isHex(text)) out.name = text.trim();
  } else if (text !== undefined && text !== null) {
    out.why = "channel: 64 hex digits, or a name";
  }
  return out;
}

/** The program's own process node's value, read from its place: its pid is its name there. */
async function ownValue(lines: Lines, pid: string | undefined): Promise<unknown> {
  if (!pid) return undefined;
  try {
    const { items } = await lines.request("read", { address: [pid] }) as {
      items: { value?: unknown }[];
    };
    return items[0]?.value;
  } catch {
    return undefined;
  }
}

/** Writes lines of text as its window's screen, if it has one; nothing if not. */
async function draw(lines: Lines, pid: string | undefined, text: string[], styles?: unknown[]) {
  if (!pid) return;
  try {
    const { items } = await lines.request("read", { address: [pid, "size"] }) as {
      items: { value?: { rows?: number; cols?: number } }[];
    };
    const size = items[0]?.value ?? {};
    const value = {
      rows: size.rows ?? 24,
      cols: size.cols ?? 80,
      lines: text,
      ...(styles ? { styles } : {}),
    };
    await lines.request("write", {
      address: [pid, "screen"],
      patches: [{ type: "snapshot", value }],
    });
  } catch { /* no window */ }
}

let bye: () => Promise<void> = () => Promise.resolve();

/** Says goodbye on the link, if it has one, then exits: the host killed it, or closed its stdin. */
function leave() {
  const late = setTimeout(() => Deno.exit(0), 1000);
  bye().finally(() => {
    clearTimeout(late);
    Deno.exit(0);
  });
}

/** What to say goodbye with, on SIGHUP or SIGTERM (as the host kills a program) or when stdin closes. */
function stopping(goodbye: () => Promise<void>) {
  bye = goodbye;
  Deno.addSignalListener("SIGHUP", leave);
  Deno.addSignalListener("SIGTERM", leave);
}

/** The person's agent, for requests that need one (a host that binds its programs puts its own). */
function agent() {
  return { actor: Deno.env.get("USER") ?? "someone", code: [] };
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function main(args: string[]) {
  const url = option(args, "--url");
  const [cmd, name] = args;
  if (cmd === "new") {
    console.log(name ? channelOf(name) : channel());
    return;
  }
  if (!["serve", "host", "mirror"].includes(cmd) && !(cmd === "mount" && name)) {
    console.error(USAGE);
    Deno.exit(2);
  }
  // loaded only to serve or mount: the wasm needs reading and the network
  const { subduction } = await import("../src/link/subduction.ts");
  if (cmd === "serve") {
    const ch = name ? channelOf(name) : channel();
    const api = stacks.schedule!(graph("root"), { root: "root" });
    const transport = await subduction(ch, { url });
    const served = serve(api, [], transport);
    console.error(`serving channel ${ch} as ${transport.self}`);
    const stop = async () => {
      await served.close("the owner stopped serving");
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    // serves until killed
    await new Promise(() => {});
  }
  if (cmd === "mount" && name) {
    const ch = channelOf(name);
    const remote = await mount(await subduction(ch, { url }));
    const lines = bridge(remote);
    console.error(`mounted channel ${ch}${isHex(name) ? "" : ` (${name})`}, owner ${remote.owner}`);
    remote.closed.then((why) => console.error(`link closed: ${why}`));
    for await (const line of inLines()) out(await lines.line(line));
    await remote.close();
    Deno.exit(0);
  }
  const pid = Deno.env.get("ERMINE_PID");
  if (cmd === "host") {
    const lines = hosted();
    const g = given(name ?? await ownValue(lines, pid));
    const ch = g.channel ?? channel();
    const what = g.place.length
      ? `/${g.place.join("/")} (below its place)`
      : "this terminal's windows";
    console.error(`sharing ${what} on channel ${ch}${g.name ? ` (${g.name})` : ""}`);
    const show = async (peers: string[]) => {
      const bold = [[1, { bold: true }]], green = [[1, { fg: 2, bold: true }]];
      const rows: [string, unknown[]][] = [
        [` sharing ${what} on galaxy.observer`, []],
        ["", []],
        ...(g.name ? [[" name:", bold], [` ${g.name}`, green]] as [string, unknown[]][] : []),
        [" channel:", bold],
        [` ${ch.slice(0, 32)}`, green],
        [` ${ch.slice(32)}`, green],
        ["", []],
        [
          ` to mount it from another ermine-term: C-g m, then the ${g.name ? "name" : "channel"},`,
          [],
        ],
        [` or start that one with ERMINE_MOUNT=<${g.name ? "name" : "channel"}>`, []],
        ...(g.why ? [["", []], [` (ignored: ${g.why})`, []]] as [string, unknown[]][] : []),
        ["", []],
        [` mounted by ${peers.length}`, []],
      ];
      const text = rows.map(([t]) => t), styles = rows.map(([, r]) => r);
      await draw(lines, pid, text, styles);
    };
    await show([]);
    const transport = await subduction(ch, { url });
    let shown = Promise.resolve();
    let mounted: string[] = [];
    const relayed = relay(lines, transport, {
      place: g.place,
      peers: (peers) => {
        console.error(`mounted by ${peers.length}: ${peers.join(" ")}`);
        mounted = peers;
        shown = shown.then(() => show(peers));
      },
    });
    // killed by the host (its window closed): tell the mounters first
    stopping(() => relayed.close("the owner stopped sharing"));
    if (pid) {
      await lines.subscribe(
        { address: [pid, "size"] },
        () => (shown = shown.then(() => show(mounted))),
      );
    }
    await new Promise(() => {});
  }
  if (cmd === "mirror") {
    const lines = hosted();
    const g = given(name ?? await ownValue(lines, pid));
    const ch = g.channel;
    if (!ch || g.why) {
      const why = g.why ?? "no channel: 64 hex digits, or a name";
      await draw(lines, pid, [
        ` mount: ${why}`,
        ` given: ${JSON.stringify(name ?? await ownValue(lines, pid))}`,
      ]);
      console.error(`mirror: ${why}`);
      await new Promise(() => {});
      return;
    }
    const called = g.name ?? ch.slice(0, 8);
    await draw(lines, pid, [` mounting ${called} ...`]);
    let remote;
    try {
      const transport = await subduction(ch, { url });
      console.error(`mirror: this side's key ${transport.self}`);
      remote = await mount(transport);
    } catch (e) {
      await draw(lines, pid, [
        ` mounting ${called}`,
        ` failed: ${e instanceof Error ? e.message : e}`,
      ]);
      await new Promise(() => {});
      return;
    }
    console.error(`mounted channel ${ch}${g.name ? ` (${g.name})` : ""}, owner ${remote.owner}`);
    stopping(() => remote.close("unmounted"));
    await mirror(lines, remote, {
      agent: agent(),
      id: pid ?? "mirror",
      place: g.place,
      as: called,
      show: (text) =>
        draw(lines, pid, [
          ` mounted ${g.name ? `${g.name}  ` : ""}${ch.slice(0, 16)}...`,
          ...text,
        ]),
    });
    await new Promise(() => {});
  }
  console.error(USAGE);
  Deno.exit(2);
}

if (import.meta.main) await main([...Deno.args]);
