// The reference protect (CORE.tex, Running and wrapping). It asks may before
// every operation, including each directory a lookup reads, which reaches it
// again from the graph through the top of the stack. Each layer is told the
// top once: protect tells the layer below when it is made, and the host tells
// the outermost layer once the stack is built, so no holder can tell it again.

import {
  type Acting,
  type Binding,
  type Id,
  type Interface,
  type Json,
  Refused,
  told,
} from "./types.ts";

/** Whether the operation's agent and process may make it. */
export type May = (agent: Json, process: Id | undefined, op: string, args: object) => boolean;

/** The operations that carry their agent and process, and need nothing more. */
const ACTING = [
  "make",
  "read",
  "data",
  "directory",
  "lookup",
  "write",
  "place",
  "unplace",
] as const;

export function protect(api: Interface, may: May): Interface {
  const check = (agent: unknown, process: unknown, op: string, args: object) => {
    const p = typeof process === "string" ? process : undefined;
    if (!may(agent as Json, p, op, args)) {
      throw new Refused(`${JSON.stringify(agent)} may not ${op}${on(op, args)}`, op);
    }
  };
  const ask = <A extends Acting, R>(op: string, pass: (args: A) => R) => (args: A): R => {
    check(args?.agent, args?.process, op, args);
    return pass(args);
  };
  // the node each subscription made through here is on, for its unsubscribe
  const subs = new Map<number, Id>();
  // the binding of each interface bound through here, for its record
  const bindings = new WeakMap<object, Binding>();

  // pass on what it does not know
  const wrapped: Interface = { ...api };
  for (const op of ACTING) {
    // deno-lint-ignore no-explicit-any
    (wrapped as any)[op] = ask(op, (api as any)[op]);
  }
  wrapped.subscribe = (args) => {
    check(args?.agent, args?.process, "subscribe", args);
    const answer = api.subscribe(args);
    subs.set(answer.sub, args.node);
    return answer;
  };
  wrapped.unsubscribe = (args) => {
    const node = subs.get(args?.sub);
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
 * The node an operation is on: the parent for a placement, the new id for a
 * make, and otherwise its node; protect gives an unsubscribe its
 * subscription's node.
 */
export function subject(op: string, args: object): Id | undefined {
  const a = args as { [key: string]: unknown };
  const node = op === "make" ? a.id : op === "place" || op === "unplace" ? a.parent : a.node;
  return typeof node === "string" ? node : undefined;
}

function on(op: string, args: object): string {
  const node = subject(op, args);
  return node === undefined ? "" : ` on ${JSON.stringify(node)}`;
}
