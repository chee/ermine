// The reference protect (CORE.tex, Running and wrapping; PROTECT.tex). It
// asks may before every operation, including each directory a lookup reads,
// which reaches it again from the graph through the top of the stack. Each
// layer is told the top once: protect tells the layer below when it is made,
// and the host tells the outermost layer once the stack is built, so no
// holder can tell it again.
//
// may is given the operation's args and, as node, the node its address
// reaches: the parent, for a placement; the node the subscription reaches
// now, for an unsubscribe. protect learns it from the layer below's reach,
// as its own bookkeeping, which nothing is asked about. Each directory the
// walk of an address's own names reads is asked about too, as a directory
// read of that node, after the operation itself; following the place to
// where the address starts is not. A subscription is asked again each time
// its address reaches another node, and receives nothing while that is
// refused.

import {
  type Acting,
  type Address,
  type Binding,
  type Event,
  type Id,
  type Interface,
  type Json,
  ours,
  Refused,
  told,
} from "./types.ts";
import { equal, isObject } from "./patch.ts";

ours(import.meta.url);

/**
 * Whether the operation's agent and process may make it: true allows; false
 * refuses, and so does a map, whose entries go in the refusal's why, as the
 * harness's rules name the rule that said no.
 */
export type May = (
  agent: Json,
  process: Id | undefined,
  op: string,
  args: object,
) => boolean | { readonly [detail: string]: Json };

/** The operations that carry their agent, process and place, and need nothing more. */
const ACTING = ["read", "directory", "lookup", "write", "place", "unplace"] as const;

export function protect(api: Interface, may: May): Interface {
  const answer = (agent: unknown, process: unknown, op: string, args: object) =>
    may(agent as Json, typeof process === "string" ? process : undefined, op, args);
  const check = (agent: unknown, process: unknown, op: string, args: object, as = op) => {
    const said = answer(agent, process, op, args);
    if (said === true) return;
    const details = typeof said === "object" && said !== null ? said : {};
    throw new Refused(
      { code: "rule", ...details, text: `${JSON.stringify(agent)} may not ${op}${on(args)}` },
      as,
    );
  };
  /** Where an operation's address gets: the node it reaches, and the directories its walk reads. */
  const reached = (args: Acting & { address?: Address }): { node?: Id; read: Id[] } => {
    if (args === null || typeof args !== "object" || args.address === undefined) {
      return { read: [] };
    }
    try {
      return api.reach?.(args as Acting & { address: Address }) ?? { read: [] };
    } catch {
      // an operation the graph will find invalid; protect answers first
      return { read: [] };
    }
  };
  /** The args may is given: the operation's, and the node its address reaches, if any. */
  const about = (args: Acting & { address?: Address }, node = reached(args).node): object =>
    node === undefined ? args ?? {} : { ...args, node };
  /** Asks about the operation, then about each directory its address's walk reads. */
  const checkAll = (args: Acting & { address?: Address }, op: string) => {
    const where = reached(args);
    check(args?.agent, args?.process, op, about(args, where.node));
    for (const node of where.read) check(args?.agent, args?.process, "directory", { node }, op);
  };
  // each subscription made through here, for its unsubscribe
  const subs = new Map<number, Acting & { address: Address }>();
  // the binding of each interface bound through here, for its record
  const bindings = new WeakMap<object, Binding>();

  // pass on what it does not know
  const wrapped: Interface = { ...api };
  // unplacing by id is for the bookkeeping beneath the wrappers, never past them
  delete wrapped.release;
  for (const op of ACTING) {
    // deno-lint-ignore no-explicit-any
    const pass = (api as any)[op];
    // deno-lint-ignore no-explicit-any
    (wrapped as any)[op] = (args: any) => {
      checkAll(args, op);
      return pass(args);
    };
  }
  wrapped.subscribe = (args) => {
    checkAll(args, "subscribe");
    const { send, ...kept } = args;
    // asked again whenever the address reaches another node; nothing passes while refused
    let node = reached(kept).node;
    let allowed = true;
    const sent = (event: Event) => {
      if ("change" in event && event.reaches !== undefined) {
        const now = reached(kept).node;
        if (now !== node) {
          node = now;
          allowed = answer(kept.agent, kept.process, "subscribe", about(kept, now)) === true;
        }
      }
      if (allowed) send(event);
    };
    const answered = api.subscribe({ ...args, send: sent });
    subs.set(answered.sub, kept);
    return answered;
  };
  wrapped.unsubscribe = (args) => {
    const sub = subs.get(args?.sub);
    const node = sub === undefined ? undefined : reached(sub).node;
    check(args?.agent, args?.process, "unsubscribe", node === undefined ? args : { ...args, node });
    api.unsubscribe(args);
    subs.delete(args.sub);
  };
  // bind, record and finish act as the agent and process of the binding
  wrapped.bind = (inner, binding) => {
    check(binding?.agent, binding?.process, "bind", binding ?? {});
    const bound = api.bind(inner, binding);
    bindings.set(bound, binding);
    return bound;
  };
  wrapped.record = (inner, marked) => {
    const b = bindings.get(inner);
    check(b?.agent, b?.process, "record", { marked });
    return api.record(inner, marked);
  };
  wrapped.finish = (recording, ending, finishing) => {
    check(recording?.agent, recording?.process, "finish", { ending });
    return api.finish(recording, ending, finishing);
  };
  const below = api.top(wrapped);
  wrapped.top = told(below);
  return wrapped;
}

/**
 * The node an operation is on, as protect gives it to may: the node its
 * address reaches (the parent, for a placement), or the node a subscription
 * reaches, for an unsubscribe. A lookup has none.
 */
export function subject(_op: string, args: object): Id | undefined {
  const node = (args as { node?: unknown }).node;
  return typeof node === "string" ? node : undefined;
}

function on(args: object): string {
  const node = subject("", args);
  return node === undefined ? "" : ` on ${JSON.stringify(node)}`;
}

/**
 * A rule (PROTECT.tex, Rules): the fields it gives, each to equal the
 * operation's, and what it says. A field it leaves out matches anything.
 */
export type Rule = {
  readonly agent?: Json;
  readonly peer?: Json;
  readonly process?: Id;
  readonly op?: string;
  readonly node?: Id;
  readonly id?: Id;
  readonly allow: boolean;
};

/**
 * What a rule's fields are matched against: the agent's actor, when it has
 * one, and otherwise the whole agent; the agent's peer, the key a link
 * verified (only an owner stamps it, so a mounter cannot claim it); the last
 * step of the agent's code, when it has one, and otherwise the operation's
 * own process; and the node and id may is given.
 */
export function facts(
  agent: Json,
  process: Id | undefined,
  args: object,
): { actor: Json; peer?: Json; process?: Id; node?: Id; id?: Id } {
  const a = isObject(agent) ? agent : undefined;
  const actor = a && Object.hasOwn(a, "actor") ? a.actor : agent;
  const code = a && Array.isArray(a.code) ? a.code : undefined;
  const last = code?.[code.length - 1];
  const by = code
    ? (isObject(last) && typeof last.process === "string" ? last.process : undefined)
    : process;
  const { node, id } = args as { node?: unknown; id?: unknown };
  return {
    actor,
    ...(a && Object.hasOwn(a, "peer") ? { peer: a.peer } : {}),
    ...(by === undefined ? {} : { process: by }),
    ...(typeof node === "string" ? { node } : {}),
    ...(typeof id === "string" ? { id } : {}),
  };
}

/** Whether every field a rule gives equals the operation's; one the operation lacks never matches. */
export function matches(
  rule: Omit<Rule, "allow">,
  agent: Json,
  process: Id | undefined,
  op: string,
  args: object,
): boolean {
  const f = facts(agent, process, args);
  const has = (field: string) =>
    Object.hasOwn(rule, field) && (rule as { [k: string]: unknown })[field] !== undefined;
  if (has("agent") && !equal(rule.agent!, f.actor)) return false;
  if (has("peer") && (f.peer === undefined || !equal(rule.peer!, f.peer))) return false;
  if (has("process") && (f.process === undefined || rule.process !== f.process)) return false;
  if (has("op") && rule.op !== op) return false;
  if (has("node") && (f.node === undefined || rule.node !== f.node)) return false;
  if (has("id") && (f.id === undefined || rule.id !== f.id)) return false;
  return true;
}

/**
 * A may from a list of rules (PROTECT.tex, Rules): the first rule whose given
 * fields all equal the operation's wins, and a refusal names it by its place
 * in the list; if none does, the operation is allowed.
 */
export function rules(list: readonly Rule[]): May {
  return (agent, process, op, args) => {
    for (let rule = 0; rule < list.length; rule++) {
      if (!matches(list[rule], agent, process, op, args)) continue;
      return list[rule].allow === true || { rule };
    }
    return true;
  };
}
