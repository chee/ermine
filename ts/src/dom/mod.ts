/// <reference lib="dom" />
// ermine/dom: JSX that renders handles on the graph, and leads back to it.
// The design is ts/demo/dom.org.

import type { JSX as Types } from "./jsx-runtime.ts";
import { h as make } from "./render.ts";

export { type Handle, isHandle, isPatch, node, parse, patchOf } from "./handle.ts";
export {
  apply,
  type Child,
  type Component,
  each,
  Fragment,
  insert,
  jsx,
  jsxs,
  render,
  text,
} from "./render.ts";
export { type Scope, scope, untracked } from "./track.ts";
export { type Reason, type Why, why } from "./why.ts";

/** The classic factory, for an "@jsx h" pragma; its JSX namespace types the tags. */
export const h: typeof make & { JSX?: never } = make;
export declare namespace h {
  export namespace JSX {
    export type Element = Types.Element;
    export type ElementChildrenAttribute = Types.ElementChildrenAttribute;
    export type IntrinsicAttributes = Types.IntrinsicAttributes;
    export type IntrinsicElements = Types.IntrinsicElements;
  }
}
