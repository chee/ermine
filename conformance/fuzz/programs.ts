// Programs in the test language (PROTOCOL.tex, Programs as data), in the
// current dialect. Templates use read results only through $value, $ids and
// $missing-of-$value, so the adapter's lowering is faithful for them.

// deno-lint-ignore-file no-explicit-any
import type { Rng } from "./random.ts";
import type { Json } from "./model.ts";

export const STRS = ["", "a", "hi", "héllo", "😀x😀", "a\u0000b", "日本語", '\n\t"', "ab😀cd"];
// 9007199254740993 is left out: PROTOCOL says scenarios never send a number binary64 cannot hold.
export const NUMS = [
  0,
  1,
  -1,
  2,
  3,
  0.5,
  1e21,
  1e-7,
  123456789012345680000,
  1.5e300,
  5e-324,
  0.1,
  1e20,
  -2.5,
];
export const KEYS = ["x", "y", "z", "é", "😀", "b", "a"];

export function jval(r: Rng, d = 2): Json {
  switch (r.int(d > 0 ? 7 : 4)) {
    case 0:
      return null;
    case 1:
      return r.chance(0.5);
    case 2:
      return r.pick(NUMS);
    case 3:
      return r.pick(STRS);
    case 4:
    case 5: {
      const n = r.int(4);
      const a: Json[] = [];
      for (let i = 0; i < n; i++) a.push(jval(r, d - 1));
      return a;
    }
    default: {
      const o: { [k: string]: Json } = {};
      const n = r.int(4);
      for (let i = 0; i < n; i++) o[r.pick(KEYS)] = jval(r, d - 1);
      return o;
    }
  }
}

const v = (name: string) => ({ $: name });
const val = (name: string) => ({ $value: v(name) });

/** What a process's programs may touch, so that no unplanned cycle forms. */
export type Scope = {
  self: string;
  /** nodes a compute may read: data nodes and lower processes */
  readable: string[];
  /** the data node a derived compute reads first, so that diamonds form */
  primary?: string;
  /** a diamond's two reads: a lower process and that process's primary */
  diamond?: string[];
  /** nodes whose whole directory a "children" compute may read */
  dirs?: string[];
  /** lookup names */
  names: string[];
  /** a node no compute reads, for the log effect */
  log: string;
  /** nodes an effect or handler may write that no lower-or-equal compute reads */
  writable: string[];
  /** data nodes a handler may write */
  handlerTargets: string[];
  /** a child process node a starter places */
  child?: string;
  /** mirror source and destination */
  mirror?: { src: string; dst: string };
  portable: boolean;
};

export type Kind = "derived" | "lookup" | "mirror" | "pure" | "random" | "diamond" | "children";

/** A compute of the kind, returning a value; `stamped` adds the time of the first mark. */
export function compute(r: Rng, kind: Kind, s: Scope, stamped: boolean): Json {
  const stamp = stamped ? { t: { $get: [v("changes"), 0, "time"] } } : {};
  switch (kind) {
    case "diamond":
    case "derived": {
      let nodes: string[];
      if (kind === "diamond" && s.diamond) {
        nodes = r.chance(0.5) ? [...s.diamond] : [...s.diamond].reverse();
      } else {
        const n = 1 + r.int(Math.min(3, s.readable.length));
        const rest = r.shuffle(s.readable.filter((x) => x !== s.primary));
        // the primary always: it is what makes diamonds with the processes above
        nodes = (s.primary ? [s.primary, ...rest] : rest).slice(0, n);
      }
      const steps: Json[] = nodes.map((node, i) => ({ do: "read", node, as: `x${i}` }));
      if (r.chance(0.3)) {
        steps.push({ do: "if", test: { $missing: val("x0") }, then: [{ do: "pending" }] });
      }
      if (r.chance(0.2)) {
        steps.push({
          do: "try",
          steps: [{ do: "throw", message: r.pick(["bad", 1, { x: 1 }]) }],
          as: "err",
        });
      }
      const vals = nodes.map((_, i) => val(`x${i}`));
      // $value of an absent node is missing, which may only be tested: guard each.
      const guarded: Json[] = [];
      nodes.forEach((_, i) => {
        guarded.push({
          do: "if",
          test: { $missing: val(`x${i}`) },
          then: [{ do: "let", as: `y${i}`, value: null }],
          else: [{ do: "let", as: `y${i}`, value: vals[i] }],
        });
      });
      steps.push(...guarded);
      steps.push({
        do: "return",
        value: { from: s.self, vals: nodes.map((_, i) => v(`y${i}`)), ...stamp },
      });
      return steps;
    }
    case "children": {
      // a whole directory: marked by every placement in it. Its length is the
      // same in every dialect; the listing itself only in the full profile.
      const node = r.pick(s.dirs?.length ? s.dirs : s.readable);
      return [
        { do: "directory", node, as: "d" },
        {
          do: "return",
          value: { n: { $len: v("d") }, ...(s.portable ? {} : { d: v("d") }), ...stamp },
        },
      ];
    }
    case "lookup": {
      const name = r.pick(s.names);
      return [
        { do: "lookup", name, as: "f" },
        { do: "return", value: { found: { $ids: v("f") }, ...stamp } },
      ];
    }
    case "mirror": {
      const src = s.mirror!.src;
      return [
        { do: "read", node: src, as: "x" },
        { do: "if", test: { $missing: val("x") }, then: [{ do: "pending" }] },
        { do: "return", value: { v: val("x"), ...stamp } },
      ];
    }
    case "pure": {
      const a = r.pick(NUMS.filter((n) => Math.abs(n) < 1e6));
      return [
        { do: "let", as: "a", value: a },
        { do: "let", as: "s", value: r.pick(STRS) },
        {
          do: "return",
          value: {
            sum: { $add: [v("a"), 1] },
            len: { $len: v("s") },
            eq: { $eq: [{ x: 1, y: [2] }, { y: [2], x: 1 }] },
            not: { $not: { $eq: [v("a"), 1] } },
            cat: { $concat: [v("s"), "!"] },
            self: v("self"),
            ...stamp,
          },
        },
      ];
    }
    case "random":
      return randomSteps(r, "compute", s, 2, 1 + r.int(5));
  }
}

export type EffectKind = "log" | "mirror" | "starter" | "handler" | "random" | "cleanlog";

/** An effect made of the pieces asked for, in order; their cleanups are one cleanup step, last. */
export function effect(r: Rng, pieces: EffectKind[], s: Scope): Json {
  const steps: Json[] = [];
  const cleanup: Json[] = [];
  for (const piece of pieces) {
    switch (piece) {
      case "log":
        // The log write comes first, so the effects invariant can rely on it running.
        steps.unshift({
          do: "write",
          node: s.log,
          patches: [{ type: "splice", path: [], range: [0, 0], value: [v("value")] }],
        });
        break;
      case "mirror":
        steps.push({
          do: "write",
          node: s.mirror!.dst,
          patches: [{ type: "snapshot", value: { $get: [v("value"), "v"] } }],
        });
        break;
      case "starter":
        if (!s.child) break;
        steps.push({ do: "place", parent: v("self"), name: "kids", id: s.child });
        cleanup.push({ do: "unplace", parent: v("self"), name: "kids", id: s.child });
        break;
      case "cleanlog":
        // a cleanup that leaves a trace, so the order cleanups run in shows
        cleanup.push({
          do: "write",
          node: s.log,
          patches: [{ type: "splice", path: [], range: [0, 0], value: [{ bye: v("self") }] }],
        });
        break;
      case "handler": {
        const target = r.pick(s.handlerTargets);
        const write = (value: Json) => ({
          do: "write",
          node: target,
          patches: [{ type: "snapshot", value }],
        });
        const body: Json[] = [
          {
            do: "if",
            test: { $missing: v("input") },
            then: [write("none")],
            else: [write(v("input"))],
          },
        ];
        const variant = r.int(4);
        if (variant === 1) {
          // a handler that throws after a write: the write stands, the fire answer has the error
          body.push({ do: "throw", message: "handler" });
        } else if (variant === 2) {
          // a handler that reads through the lasting interface
          const from = r.pick(s.handlerTargets);
          body.push(
            { do: "read", node: from, as: "seen" },
            {
              do: "if",
              test: { $missing: val("seen") },
              then: [],
              else: [write({ seen: val("seen") })],
            },
          );
        }
        steps.push({ do: "handler", name: "h", steps: body });
        break;
      }
      case "random":
        steps.push(...(randomSteps(r, "effect", s, 1, 1 + r.int(3)) as Json[]));
        break;
    }
  }
  if (cleanup.length) steps.push({ do: "cleanup", steps: cleanup });
  return steps;
}

// random step trees, after c/scratch/diff/gen.ts -------------------------------

type Part = "compute" | "effect" | "handler";

function expr(r: Rng, part: Part, vars: string[], d: number): Json {
  const base = part === "compute"
    ? ["self", "path", "changes"]
    : part === "effect"
    ? ["self", "value", "previous"]
    : ["self", "input"];
  const vs = [...base, ...vars];
  switch (r.int(d > 0 ? 15 : 5)) {
    case 0:
    case 1:
      return v(r.pick(vs));
    case 2:
      return r.pick(NUMS);
    case 3:
      return r.pick(STRS);
    case 4:
      return r.pick([null, true, false]);
    case 5:
      return { $get: [expr(r, part, vars, d - 1), r.pick(["x", 0, 1, "node", "time"])] };
    case 6:
      return { $eq: [expr(r, part, vars, d - 1), expr(r, part, vars, d - 1)] };
    case 7:
      return { $not: expr(r, part, vars, d - 1) };
    case 8:
      return { $missing: expr(r, part, vars, d - 1) };
    case 9:
      return { $add: [expr(r, part, vars, d - 1), r.pick(NUMS)] };
    case 10:
      return {
        $concat: r.chance(0.5)
          ? [r.pick(STRS), expr(r, part, vars, d - 1)]
          : [[1], expr(r, part, vars, d - 1)],
      };
    case 11:
      return { $len: expr(r, part, vars, d - 1) };
    case 12:
      return { $quote: r.pick([{ $: "x" }, { $nope: 1 }, [1, { $add: [1] }]]) };
    case 13:
      return r.pick([{ $nope: 1 }, { $: 3 }, { $get: 5 }, { $eq: [1] }, { $add: [] }, { $len: 3 }]);
    default:
      return [expr(r, part, vars, d - 1), expr(r, part, vars, d - 1)];
  }
}

function randomSteps(
  r: Rng,
  part: Part,
  s: Scope,
  d: number,
  n: number,
  vars: string[] = [],
): Json[] {
  const out: Json[] = [];
  for (let i = 0; i < n; i++) out.push(randomStep(r, part, s, d, vars));
  return out;
}

function randomStep(r: Rng, part: Part, s: Scope, d: number, vars: string[]): Json {
  const fresh = () => {
    const x = r.pick(["x", "y", "z", "w"]);
    if (!vars.includes(x)) vars.push(x);
    return x;
  };
  const e = (depth = 1) => expr(r, part, vars, depth);
  const k = r.int(d > 0 ? 18 : 13);
  const reads = part === "compute";
  switch (k) {
    case 0:
    case 1:
      if (reads) return { do: "read", node: r.pick(s.readable), as: fresh() };
      return { do: "let", as: fresh(), value: e() };
    case 2:
      if (reads) {
        // a whole directory (no name) as well as one slot; the whole listing
        // differs between dialects, so the portable profile names a slot
        return {
          do: "directory",
          node: r.pick(s.readable),
          ...(s.portable || r.chance(0.6) ? { name: r.pick(["kids", "k1", "theme"]) } : {}),
          as: fresh(),
        };
      }
      return { do: "let", as: fresh(), value: e() };
    case 3:
      if (reads) return { do: "lookup", name: r.pick(s.names), as: fresh() };
      return { do: "let", as: fresh(), value: e() };
    case 4:
      return { do: "let", as: fresh(), value: e(2) };
    case 5:
      return { do: "return", value: e(2) };
    case 6:
      return part === "compute" ? { do: "pending" } : { do: "let", as: fresh(), value: e() };
    case 7:
      return { do: "throw", message: r.chance(0.5) ? r.pick(["bad", 1, { x: 1 }, null]) : e() };
    case 8:
    case 9:
      if (part === "compute" && r.chance(0.8)) return { do: "let", as: fresh(), value: e() };
      return {
        do: "write",
        node: r.pick(s.writable),
        patches: [{ type: "snapshot", value: e() }],
      };
    case 10:
      if (part === "compute") return { do: "return", value: e() };
      return { do: "make", id: r.pick(["n1", "n2"]), value: e() };
    case 11:
      if (part === "effect" && r.chance(0.4)) {
        return {
          do: "handler",
          name: r.pick(["h", "g"]),
          steps: randomSteps(r, "handler", s, 0, 1 + r.int(2), [...vars]),
        };
      }
      return { do: "let", as: fresh(), value: e() };
    case 12:
      if (part === "effect" && r.chance(0.4)) {
        return { do: "cleanup", steps: randomSteps(r, "handler", s, 0, 1 + r.int(2), [...vars]) };
      }
      return { do: "return", value: e() };
    case 13:
    case 14: {
      const step: any = {
        do: "if",
        test: r.chance(0.7) ? { $eq: [e(), e()] } : e(),
        then: randomSteps(r, part, s, d - 1, 1 + r.int(2), vars),
      };
      if (r.chance(0.5)) step.else = randomSteps(r, part, s, d - 1, 1 + r.int(2), vars);
      return step;
    }
    case 15:
      return {
        do: "each",
        list: r.chance(0.6) ? [1, 2, "a"] : e(),
        as: fresh(),
        steps: randomSteps(r, part, s, d - 1, 1 + r.int(2), vars),
      };
    default:
      return { do: "try", steps: randomSteps(r, part, s, d - 1, 1 + r.int(3), vars), as: fresh() };
  }
}
