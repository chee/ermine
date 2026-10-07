/** @jsxRuntime classic */
/** @jsx h */
// The counter: one module, both parts, so they share the declarations.
// As a published program it would import "ermine/signals" and set
// @jsxImportSource ermine/dom; here the imports are relative, so it checks
// and runs inside this repository.

import { h } from "../../dom/mod.ts";
import { input, me, show, signals } from "../mod.ts";
import type { ComputeGiven, EffectGiven } from "../../loaders.ts";
import { screen } from "demo";

void h;

const my = signals({ count: input(0) });

// Only reads, tracked. The memo is a function of reads.
export function compute(ctx: ComputeGiven) {
  const { count } = my(ctx);
  const double = () => count() * 2;
  return { count: count(), double: double() };
}

// Makes count on the first run. Draws once; later runs resume the view.
export function effect(ctx: EffectGiven) {
  const { count } = my(ctx);
  const self = me<{ count: number; double: number }>(ctx);
  return show(ctx, screen(ctx.self), () => (
    <div>
      <div class="big">{count}</div>
      <div class="label">double: {() => self()?.double}</div>
      <button type="button" onClick={() => count((n) => n + 1)}>🐇 hop!</button>
    </div>
  ));
}
