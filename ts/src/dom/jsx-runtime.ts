/// <reference lib="dom" />
// The automatic JSX runtime: "jsx": "react-jsx" with this directory as the
// jsxImportSource, through an import map entry such as
// "ermine/dom/jsx-runtime": "./src/dom/jsx-runtime.ts". Classic JSX uses h
// from mod.ts with an "@jsx h" pragma, as the tests do.

import type { Child } from "./render.ts";
import type { Handle } from "./handle.ts";

export { Fragment, jsx, jsxs } from "./render.ts";
export type { Child, Component } from "./render.ts";

/** A static value, an accessor, or a handle: a bound attribute. */
type Bindable<T> = T | (() => T) | Handle;

interface Attributes<E extends Element> {
  children?: Child;
  ref?: (el: E) => void;
  class?: Bindable<string | undefined>;
  style?: Bindable<string | Record<string, string | number | null> | undefined>;
  onClick?: (e: MouseEvent) => unknown;
  onInput?: (e: InputEvent) => unknown;
  onChange?: (e: Event) => unknown;
  onSubmit?: (e: SubmitEvent) => unknown;
  onKeyDown?: (e: KeyboardEvent) => unknown;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
}

// deno-lint-ignore no-namespace
export namespace JSX {
  export type Element = Child;
  export interface ElementChildrenAttribute {
    children: Record<never, never>;
  }
  export interface IntrinsicAttributes {
    key?: unknown;
  }
  export type IntrinsicElements =
    & { [K in keyof HTMLElementTagNameMap]: Attributes<HTMLElementTagNameMap[K]> }
    // deno-lint-ignore no-explicit-any
    & { [tag: string]: Attributes<any> };
}
