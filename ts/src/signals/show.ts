/// <reference lib="dom" />
// Views: JSX drawn from an effect (plans/signals.org, Views; ts/demo/dom.org,
// Scopes).
//
//   export function effect(ctx) {
//     const { count } = my(ctx)
//     return show(ctx, el, () => <button onClick={() => count((n) => n + 1)}>{count}</button>)
//   }
//
// show renders with ermine/dom, owned by the process: each bound part is a
// scope the scheduler runs, so a click updates the text node without the
// process's effect drawing anything. A later effect run leaves the view as
// it is: scopes belong to the process, not to one effect run. A kill
// disposes them, and the render's root takes the DOM out.

import { type Child, render, type Scope } from "../dom/mod.ts";
import type { EffectGiven } from "../loaders.ts";
import { ours } from "../types.ts";

ours(import.meta.url);

/** Keyed by the element: the process that drew into it, and its render. */
const views = new WeakMap<Node, { self: string; scope: Scope }>();

/** Renders fn into el on the process's first effect run; later runs leave it. */
export function show(ctx: EffectGiven, el: Node, fn: () => Child): void {
  const view = views.get(el);
  if (view && view.self === ctx.self && !view.scope.disposed) return;
  views.set(el, { self: ctx.self, scope: render(fn, el, ctx) });
}
