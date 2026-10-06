// rounds: the reference driver's scheduling, replayed over one harness's
// answers (PROTOCOL.tex, The reference driver: Marks, Rounds, Heights).
//
// The checker cannot run programs, but it does not need to: every answer says
// which runs finished and in what order, what each run read, which change set
// its value, and which changes its cleanup and effect made; the history says
// when each change happened, and the reference walk says what was running.
// From these the scheduler is replayed exactly: the due list with each
// process's first mark, heights raised after each compute and effect, a round's
// computes lowest height first, then oldest first mark, then lowest id (by
// code point), a process due again in its round running again as a new run,
// the earlier one finished then with no effect, and the round's other runs
// finished in the order their computes ran, each with its cleanup and effect.
// Which processes a change marked is taken from the records' `marked` (the
// marking invariant judges marks); everything else is predicted, and the
// answer must match it:
//
//   - the order the runs finished in;
//   - each value write and each cleanup and effect change at its turn: the
//     history's times must interleave as the rounds say;
//   - a superseded run makes no cleanup or effect change;
//   - a run whose process stopped after its compute (even if it was started
//     again) makes no cleanup or effect change: its effect would act for an
//     incarnation that is gone.
//
// It also gives each run the time of the graph its compute read, which the
// reads invariant uses to check every saw, every lookup and every program
// entry exactly.

// deno-lint-ignore-file no-explicit-any
import type { Switches } from "./adapter.ts";
import { byCodePoint, type Change, isObject } from "./model.ts";
import type { Entry } from "./play.ts";

export type RoundsInput = {
  entries: Entry[];
  /** every change, in time order */
  sorted: Change[];
  changes: Map<number, Change>;
  /** time -> the entry whose answer reported it */
  owner: Map<number, number>;
  /** the last change time before each entry */
  before: number[];
  /** the reference walk's order after the change at time t, or [] before any */
  walkAfter: (t: number) => string[];
  runsOf: (e: Entry) => any[];
  switches: Switches;
  /**
   * Marking of the changes runs, cleanups and handlers make, judged as the
   * marking invariant judges outside changes: the graph keeps each process's
   * last run's reads, and a change marks the running processes whose kept
   * reads it covers. `kept` reads a record's reads, `covers` says whether
   * they cover a change, `tolerated` excuses a mark the record cannot show.
   */
  marking?: {
    kept: (rec: any) => unknown;
    covers: (k: any, c: Change) => boolean;
    tolerated: (p: string, k: any, c: Change) => boolean;
  };
};

export type RoundsFailure = { key: string; message: string; entry: number; invariant?: string };

export type RoundsOutput = {
  failures: RoundsFailure[];
  /** each record -> the time of the graph its compute read (the last change before it) */
  computedAt: Map<any, number>;
  /** whether the replay reached the end of the trace */
  complete: boolean;
  /** how often each rule was exercised, for --stats */
  counts: Map<string, number>;
};

class Mismatch extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
  }
}

type Reads = { values: Set<string>; nodes: Set<string>; routes: Set<string> };

const timesIn = (xs: any): number[] =>
  Array.isArray(xs) ? xs.map((c: any) => c?.time).filter((t: any) => typeof t === "number") : [];

export function rounds(input: RoundsInput): RoundsOutput {
  const { entries, sorted, changes, owner, before, walkAfter, runsOf, switches } = input;
  const failures: RoundsFailure[] = [];
  const computedAt = new Map<any, number>();
  const counts = new Map<string, number>();
  const count = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const height = new Map<string, number>();
  const reads = new Map<string, Reads>();
  const incarnation = new Map<string, number>();
  let running = new Set<string>();
  // the reads the graph keeps for each process, for marking
  const kept = new Map<string, unknown>();
  const keep = (rec: any) => {
    if (!input.marking) return;
    if (switches.reads === "returned" && !("value" in rec) && rec.ending !== "pending") return;
    kept.set(rec.process, input.marking.kept(rec));
  };
  /** the changes requests made themselves: an outside change, a batch member (the marking invariant judges those) */
  const outside = new Set<number>();
  for (const e of entries) {
    const ok = e.answer?.ok;
    if (!isObject(ok)) continue;
    if (isObject(ok.change) && typeof (ok.change as any).time === "number") {
      outside.add((ok.change as any).time);
    }
    for (const a of Array.isArray(ok.answers) ? ok.answers : []) {
      if (typeof a?.ok?.change?.time === "number") outside.add(a.ok.change.time);
    }
  }

  const byEntry = new Map<number, Change[]>();
  for (const c of sorted) {
    const i = owner.get(c.time);
    if (i === undefined) continue;
    if (!byEntry.has(i)) byEntry.set(i, []);
    byEntry.get(i)!.push(c);
  }

  /** the time of the change that set the run's value, if it wrote one */
  const valueWrite = (rec: any): number | undefined => {
    if (!("value" in rec)) return;
    const c0 = rec.changes?.[0];
    if (!c0 || c0.node !== rec.process) return;
    const c = changes.get(c0.time);
    if (!c || c.kind !== "write" || c.process !== rec.process || "site" in c) return;
    return c0.time;
  };
  const effectTimes = (rec: any): number[] => {
    const vw = valueWrite(rec);
    return timesIn(rec.changes).filter((t) => t !== vw);
  };
  /**
   * Whether the run's compute was called, so that its reads replace the last
   * and the processes reading it go above it: not when the run ended before
   * its compute, for a bad place, a missing or unreadable program slot or
   * program node, or a program that would not load.
   */
  const computeCalled = (rec: any): boolean => {
    const errors: any[] = rec.errors ?? [];
    if (errors.some((e) => e?.op === "path" || (e?.op === "compute" && e?.kind === "invalid"))) {
      return false;
    }
    const c = rec.compute;
    if (!isObject(c) || c.refused || c.saw === null) return false;
    if ("effect" in rec) {
      const e = rec.effect;
      if (!isObject(e) || e.refused || e.saw === null) return false;
    } else if (
      errors.length && errors.every((e) => e?.kind === "refused") && !("value" in rec) &&
      !(rec.reads ?? []).length && !(rec.lookups ?? []).length &&
      !(rec.directories ?? []).length
    ) {
      // the effect slot itself was refused: the entry is left out
      return false;
    }
    return true;
  };
  const readsOf = (rec: any): Reads => {
    const r: Reads = { values: new Set(), nodes: new Set(), routes: new Set() };
    for (const x of rec.reads ?? []) {
      if (typeof x?.node === "string") r.values.add(x.node), r.nodes.add(x.node);
    }
    for (const x of rec.directories ?? []) if (typeof x?.node === "string") r.nodes.add(x.node);
    for (const l of rec.lookups ?? []) {
      for (const s of l?.searched ?? []) if (typeof s?.node === "string") r.nodes.add(s.node);
    }
    for (const x of rec.routes ?? []) r.routes.add(`${x.parent}\u0000${x.name}`);
    return r;
  };
  const raise = (p: string, reader: (q: string) => boolean) => {
    const h = height.get(p) ?? 0;
    for (const q of running) {
      if (q === p || !reader(q)) continue;
      if ((height.get(q) ?? 0) <= h) height.set(q, h + 1);
    }
  };

  for (const [i, e] of entries.entries()) {
    const own = byEntry.get(i) ?? [];
    const recs = runsOf(e);
    if (!own.length && !recs.length) continue;

    // what each change is: a run's value write, cleanup or effect, or free
    // (the request's own changes, a handler's, a stopped process's cleanup)
    const attributed = new Map<number, { rec: any; part: string }>();
    for (const rec of recs) {
      const vw = valueWrite(rec);
      if (vw !== undefined) attributed.set(vw, { rec, part: "value write" });
      for (const t of timesIn(rec.cleanup)) attributed.set(t, { rec, part: "cleanup" });
      for (const t of effectTimes(rec)) attributed.set(t, { rec, part: "effect" });
    }
    const marksOf = new Map<number, Set<string>>();
    for (const rec of recs) {
      for (const m of rec.marked ?? []) {
        if (typeof m?.time !== "number") continue;
        if (!marksOf.has(m.time)) marksOf.set(m.time, new Set());
        marksOf.get(m.time)!.add(rec.process);
      }
    }
    const queues = new Map<string, any[]>();
    for (const rec of recs) {
      if (!queues.has(rec.process)) queues.set(rec.process, []);
      queues.get(rec.process)!.push(rec);
    }
    const due = new Map<string, number>();
    const finished: any[] = [];
    let ptr = 0;
    let last = before[i];
    const describe = (t: number) => {
      const c = changes.get(t);
      const a = attributed.get(t);
      return `${t} (${c?.kind} ${c?.node}${c?.name ? " " + c.name : ""}${
        a ? `, ${a.part} of ${a.rec.process} run ${a.rec.run}` : ""
      })`;
    };

    const judgeMarks = (c: Change, now: Set<string>) => {
      const m = input.marking;
      if (!m || outside.has(c.time)) return;
      const marked = marksOf.get(c.time) ?? new Set<string>();
      const what = describe(c.time);
      count("marking: changes by runs, cleanups and handlers judged");
      if (marked.size) count("marking: of them, changes that marked a running process");
      for (const q of running) {
        if (!now.has(q)) continue;
        const k = kept.get(q);
        const expected = k !== undefined && m.covers(k, c) &&
          !(c.process === q && switches.own === "unmarked");
        if (expected && !marked.has(q) && staysUntilEnd(q)) {
          failures.push({
            invariant: "marking",
            key: q,
            message: `${q} read what change ${what} changed, and no run of ${q} in the answer is marked by it`,
            entry: i,
          });
        }
        if (!expected && marked.has(q) && !m.tolerated(q, k, c)) {
          if (c.process === q && switches.own === "unmarked") continue;
          failures.push({
            invariant: "marking",
            key: q,
            message: `${q} has a run marked by change ${what}, but its kept reads do not cover it`,
            entry: i,
          });
        }
      }
    };
    /** whether q keeps running, as the same incarnation, to the end of the answer */
    const staysUntilEnd = (q: string) => {
      for (let k = ptr; k < own.length; k++) {
        if (!walkAfter(own[k].time).includes(q)) return false;
      }
      return true;
    };
    const apply = (c: Change) => {
      ptr++;
      last = c.time;
      const now = new Set(walkAfter(c.time));
      judgeMarks(c, now);
      for (const p of running) {
        if (now.has(p)) continue;
        incarnation.set(p, (incarnation.get(p) ?? 0) + 1);
        due.delete(p);
      }
      for (const p of now) {
        if (running.has(p)) continue;
        // started: due, marked by this change, height 0, no reads yet
        due.set(p, Math.min(due.get(p) ?? Infinity, c.time));
        height.set(p, 0);
        reads.delete(p);
      }
      for (const p of marksOf.get(c.time) ?? []) {
        if (running.has(p) && now.has(p)) due.set(p, Math.min(due.get(p) ?? Infinity, c.time));
      }
      running = now;
    };
    const applyFree = () => {
      while (ptr < own.length && !attributed.has(own[ptr].time)) apply(own[ptr]);
    };
    const expect = (t: number, what: string) => {
      applyFree();
      if (ptr >= own.length || own[ptr].time !== t) {
        throw new Mismatch(
          "interleaving",
          `${what} is change ${describe(t)}, but the rounds put ${
            ptr < own.length ? `change ${describe(own[ptr].time)}` : "nothing"
          } before it`,
        );
      }
      apply(own[ptr]);
    };
    const pick = (): string => {
      let best: string | undefined;
      for (const p of due.keys()) {
        if (best === undefined) {
          best = p;
          continue;
        }
        const hp = height.get(p) ?? 0, hb = height.get(best) ?? 0;
        const fp = due.get(p)!, fb = due.get(best)!;
        if (hp < hb || (hp === hb && (fp < fb || (fp === fb && byCodePoint(p, best) < 0)))) {
          best = p;
        }
      }
      if (due.size > 1) {
        const hs = new Set([...due.keys()].map((p) => height.get(p) ?? 0));
        const fs = new Set([...due.values()]);
        count(
          hs.size > 1
            ? "rounds: picks decided by height"
            : fs.size > 1
            ? "rounds: picks decided by first mark"
            : "rounds: picks decided by id",
        );
      }
      return best!;
    };

    try {
      applyFree();
      while (due.size) {
        const order: string[] = [];
        const round = new Map<string, { rec: any; inc: number }>();
        // computes
        while (due.size) {
          const p = pick();
          const why = `height ${height.get(p) ?? 0}, first mark ${due.get(p)}`;
          due.delete(p);
          const rec = queues.get(p)?.shift();
          if (!rec) {
            throw new Mismatch(
              p,
              `${p} is due (${why}) and runs next, but the answer has no further run of it`,
            );
          }
          const earlier = round.get(p);
          if (earlier) {
            // superseded: finished now, as its compute ended, with no effect
            finished.push(earlier.rec);
            if (switches.kept === "finish") keep(earlier.rec);
            count("rounds: superseded runs");
            const made = [...timesIn(earlier.rec.cleanup), ...effectTimes(earlier.rec)];
            if (made.length) {
              failures.push({
                key: p,
                message:
                  `run ${earlier.rec.run} of ${p} was superseded in its round by run ${rec.run}, so it has no effect, but it made changes ${
                    made.join(", ")
                  }`,
                entry: i,
              });
            }
          }
          const at = order.indexOf(p);
          if (at >= 0) order.splice(at, 1);
          order.push(p);
          round.set(p, { rec, inc: incarnation.get(p) ?? 0 });
          computedAt.set(rec, last);
          if (switches.kept === "compute") keep(rec);
          const vw = valueWrite(rec);
          if (vw !== undefined) expect(vw, `the value write of ${p} run ${rec.run} (${why})`);
          if (computeCalled(rec)) {
            reads.set(p, readsOf(rec));
            raise(p, (q) => !!reads.get(q)?.values.has(p));
          }
        }
        // the round's runs finish in the order their computes ran
        for (const p of order) {
          const { rec, inc } = round.get(p)!;
          const stale = !running.has(p) || (incarnation.get(p) ?? 0) !== inc;
          if (stale) count("rounds: runs whose process stopped after their compute");
          const cleanup = timesIn(rec.cleanup), effect = effectTimes(rec);
          if (stale && (cleanup.length || effect.length)) {
            failures.push({
              key: p,
              message: `${p} stopped after run ${rec.run}'s compute${
                running.has(p) ? " and was started again" : ""
              }, so that run has no effect, but it made changes ${
                [...cleanup, ...effect].join(", ")
              }`,
              entry: i,
            });
          }
          if (switches.kept === "finish") keep(rec);
          for (const t of cleanup) expect(t, `a cleanup change of ${p} run ${rec.run}`);
          for (const t of effect) expect(t, `an effect change of ${p} run ${rec.run}`);
          if (!stale) {
            const changed = (switches.heights === "any" ? [...cleanup, ...effect] : effect)
              .map((t) => changes.get(t)).filter((c): c is Change => !!c);
            if (changed.length) {
              const nodes = new Set(changed.map((c) => c.node));
              const slots = new Set(
                changed.filter((c) => c.kind === "place" || c.kind === "unplace").map((c) =>
                  `${c.node}\u0000${c.name}`
                ),
              );
              raise(p, (q) => {
                const r = reads.get(q);
                if (!r) return false;
                const pool = switches.heights === "value-reads" ? r.values : r.nodes;
                if ([...nodes].some((n) => pool.has(n))) return true;
                return switches.heights === "any" && [...slots].some((s) => r.routes.has(s));
              });
            }
          }
          finished.push(rec);
        }
        applyFree();
      }
      applyFree();
      if (ptr < own.length) {
        throw new Mismatch(
          "interleaving",
          `change ${describe(own[ptr].time)} happened after the rounds were over`,
        );
      }
      for (const [p, q] of queues) {
        if (q.length) {
          throw new Mismatch(
            p,
            `run ${q[0].run} of ${p} is in the answer, but ${p} was not due when it would have run`,
          );
        }
      }
      for (let k = 0; k < recs.length; k++) {
        if (finished[k] !== recs[k]) {
          const show = (xs: any[]) => xs.map((r) => `${r.process}#${r.run}`).join(" ");
          throw new Mismatch(
            "order",
            `runs finished in the order ${show(recs)}; the rounds finish them ${show(finished)}`,
          );
        }
      }
    } catch (x) {
      if (!(x instanceof Mismatch)) throw x;
      failures.push({ key: x.key, message: x.message, entry: i });
      return { failures, computedAt, complete: false, counts };
    }
  }
  return { failures, computedAt, complete: true, counts };
}
