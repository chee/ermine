// main.ts: the ermine OS, booted by a port's metal (../mac/ermine-mac runs
// it), or with no metal at all:
//
//   deno run -A experimental_os/typescript/main.ts --headless [--fresh] [--sd DIR]
//
// Booted by the metal, stdin and stdout are the bus (../mac/METAL.md), so
// nothing here may print to stdout; what the OS says goes to stderr, which
// the metal keeps in ~/.ermine/os.log. Headless, stdin and stdout are the
// serial line, and lines starting "!" are hands on the machine (metal.ts).
//
// --sd is the SD card, a folder (default ~/.ermine/sd); --fresh empties it
// first, so the image makes it again; --service allows raw commands to the
// metal at hw>; --bare boots the bare monitor and no stack.

import { connect, headless } from "./metal.ts";
import { Machine } from "./host.ts";

function parse(argv: string[]) {
  const out: { [k: string]: string | boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const [, k, v] = m;
    if (v !== undefined) out[k] = v;
    else if (["sd", "w", "h", "unit"].includes(k)) out[k] = argv[++i];
    else out[k] = true;
  }
  return out as { sd?: string; w?: string; h?: string; unit?: string; fresh?: boolean; headless?: boolean; service?: boolean; bare?: boolean };
}

const args = parse(Deno.args);
const home = Deno.env.get("HOME") ?? ".";
const sd = args.sd ?? `${home}/.ermine/sd`;
if (args.fresh) await Deno.remove(sd, { recursive: true }).catch(() => {});

const metal = args.headless
  ? await headless({ user: Deno.env.get("USER") ?? "person", w: Number(args.w ?? 800), h: Number(args.h ?? 500), unit: Number(args.unit ?? 1) })
  : await connect();
const machine = new Machine({
  sd,
  metal,
  service: !!args.service,
  bare: !!args.bare,
  say: (text) => console.error(`[os] ${text}`),
});
await machine.boot();
if (!args.bare) machine.run();
await machine.stopped();
Deno.exit(0);
