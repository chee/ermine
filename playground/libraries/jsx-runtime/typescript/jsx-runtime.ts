/// <reference lib="dom" />
// @ermine/jsx-runtime: the automatic jsx runtime for @ermine/render's views (/** @jsxImportSource
// @ermine */): jsx(type, props, key), and jsxDEV with where it was written. its JSX is checked
// against the DOM's tags and props (HTMLElementTagNameMap)
import type { getNode } from "@ermine/system"
import {
	type Bound,
	type Child,
	type Component,
	Fragment,
	type Handler,
	make,
	type View,
} from "@ermine/render/h"

export { Fragment }
export const jsx = (tag: string | Component, props: Record<string, unknown>, key?: unknown): View =>
	make(tag, props, key)
export const jsxs = jsx
export const jsxDEV = (
	tag: string | Component,
	props: Record<string, unknown>,
	key?: unknown,
	_static?: boolean,
	at?: { fileName?: string; lineNumber?: number },
): View =>
	make(
		tag,
		props,
		key,
		at?.lineNumber ? `${at.fileName || "program.tsx"}:${at.lineNumber}` : undefined,
	)

// ---- the types jsx is checked against ----
type Node = ReturnType<typeof getNode>
type On<E> = Handler | Node | ((event: E) => void)
type Writable<E> = {
	[
		K in keyof E as K extends `on${string}` | "children" | "style" | "className" ? never
			: E[K] extends (...a: any[]) => any ? never
			: K extends string ? K
			: never
	]?: E[K] | Bound
}
type Events = {
	[K in keyof HTMLElementEventMap as `on${Capitalize<K>}`]?: On<HTMLElementEventMap[K]>
}
export type Props<E> =
	& Writable<E>
	& Events
	& { [on: `on${string}`]: On<any> | undefined }
	& { [data: `data-${string}`]: unknown }
	& {
		key?: string | number
		ref?: (el: E) => void
		class?: string | Bound
		className?: string | Bound
		style?: string | Bound | Partial<CSSStyleDeclaration>
		children?: Child
	}
type Tags = { [K in keyof HTMLElementTagNameMap]: Props<HTMLElementTagNameMap[K]> }

export declare namespace JSX {
	export type Element = View
	// a component may give any child: a list, text, nothing
	export type ElementType = keyof IntrinsicElements | ((props: any) => Child)
	export interface IntrinsicElements extends Tags {}
	export interface ElementChildrenAttribute {
		children: {}
	}
	export interface IntrinsicAttributes {
		key?: string | number
	}
}
