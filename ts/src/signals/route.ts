// The interface a signal is built over: it sends each call to the right
// place for the part that made it (plans/signals.org, The handle).
//
// In a compute, everything goes to ctx.api: reads are recorded and tracked,
// and a write is refused there as read-only.
//
// In an effect:
//   reads        go to lasting: not kept, not recorded (a peep); inside a
//                scope's compute, a signal reads through the scope instead
//                (ermine/dom, track.ts), so the scope's record has it
//   writes       go to ctx.api while the effect body runs, so they are in
//                the run's record; once it has returned ctx.api answers
//                "stopped" before doing anything, and from then on they go
//                to lasting ({"handler": name} in a handler call,
//                {"lasting": n} from a timer or a DOM listener)
//   subscribes   go to lasting

import type { Acts, ComputeGiven, EffectGiven } from "../loaders.ts";
import { ErmineError, type Interface, ours } from "../types.ts";

ours(import.meta.url);

/** What either part of a program is given. */
export type Given = ComputeGiven | EffectGiven;

/** An effect is given lasting; a compute is given pending. */
export const isEffect = (ctx: Given): ctx is EffectGiven => "lasting" in ctx;

/** The interface signals use, and which part it is for. */
export interface Route extends Interface {
  readonly part: "compute" | "effect";
}

const routes = new WeakMap<Given, Route>();

/** The route for this run's context: one per context, so every handle in a run shares it. */
export function routeOf(ctx: Given): Route {
  let r = routes.get(ctx);
  if (!r) routes.set(ctx, r = isEffect(ctx) ? effectRoute(ctx) : computeRoute(ctx));
  return r;
}

type Op = Parameters<Interface["read"]>[0];
const call = (to: Interface, name: string, op: unknown) =>
  // deno-lint-ignore no-explicit-any
  (to as any)[name](op);

/** Every operation of an interface, each sent where `to` says. */
function forward(to: (name: string) => Interface) {
  const names = [
    "read",
    "directory",
    "lookup",
    "write",
    "place",
    "unplace",
    "start",
    "subscribe",
    "unsubscribe",
    "forget",
    "bind",
    "record",
    "finish",
    "top",
  ];
  return Object.fromEntries(names.map((n) => [n, (op: unknown) => call(to(n), n, op)]));
}

function computeRoute(ctx: ComputeGiven): Route {
  return {
    ...forward(() => ctx.api),
    part: "compute",
    cwd: ctx.api.cwd,
  } as unknown as Route;
}

const READS = new Set(["read", "directory", "lookup"]);
const WRITES = new Set(["write", "place", "unplace", "start"]);

function effectRoute(ctx: EffectGiven): Route {
  const lasting: Acts = ctx.lasting;
  let running = true;

  /** A write: through ctx.api while the body runs, then through lasting for good. */
  const write = (name: string) => (op: unknown) => {
    if (running) {
      try {
        return call(ctx.api, name, op);
      } catch (e) {
        if (!(e instanceof ErmineError && e.why.code === "stopped")) throw e;
        running = false;
      }
    }
    return call(lasting, name, op);
  };

  const base = forward((n) => (READS.has(n) ? lasting : ctx.api));
  for (const n of WRITES) base[n] = write(n);
  base.subscribe = (op: unknown) => call(lasting, "subscribe", op);
  base.unsubscribe = (op: unknown) => call(lasting, "unsubscribe", op);

  return { ...base, part: "effect", cwd: lasting.cwd } as unknown as Route;
}
