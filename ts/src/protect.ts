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
// as its own bookkeeping, which nothing is asked about.

import {
  type Acting,
  type Address,
  type Binding,
  type Id,
  type Interface,
  type Json,
  ours,
  Refused,
  told,
} from "./types.ts";

ours(import.meta.url);

/** Whether the operation's agent and process may make it. */
export type May = (agent: Json, process: Id | undefined, op: string, args: object) => boolean;

/** The operations that carry their agent, process and place, and need nothing more. */
const ACTING = ["read", "directory", "lookup", "write", "place", "unplace"] as const;

export function protect(api: Interface, may: May): Interface {
  const check = (agent: unknown, process: unknown, op: string, args: object) => {
    const p = typeof process === "string" ? process : undefined;
    if (!may(agent as Json, p, op, args)) {
      throw new Refused(
        { code: "rule", text: `${JSON.stringify(agent)} may not ${op}${on(args)}` },
        op,
      );
    }
  };
  /** The args may is given: the operation's, and the node its address reaches, if any. */
  const about = (args: Acting & { address?: Address }): object => {
    if (args === null || typeof args !== "object" || args.address === undefined) return args ?? {};
    let node: Id | undefined;
    try {
      node = api.reach?.(args as Acting & { address: Address });
    } catch {
      // an operation the graph will find invalid; protect answers first
    }
    return node === undefined ? args : { ...args, node };
  };
  // each subscription made through here, for its unsubscribe
  const subs = new Map<number, Acting & { address: Address }>();
  // the binding of each interface bound through here, for its record
  const bindings = new WeakMap<object, Binding>();

  // pass on what it does not know
  const wrapped: Interface = { ...api };
  for (const op of ACTING) {
    // deno-lint-ignore no-explicit-any
    const pass = (api as any)[op];
    // deno-lint-ignore no-explicit-any
    (wrapped as any)[op] = (args: any) => {
      check(args?.agent, args?.process, op, about(args));
      return pass(args);
    };
  }
  wrapped.subscribe = (args) => {
    check(args?.agent, args?.process, "subscribe", about(args));
    const answer = api.subscribe(args);
    const { send: _send, ...kept } = args;
    subs.set(answer.sub, kept);
    return answer;
  };
  wrapped.unsubscribe = (args) => {
    const sub = subs.get(args?.sub);
    const node = sub === undefined ? undefined : (about(sub) as { node?: Id }).node;
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
