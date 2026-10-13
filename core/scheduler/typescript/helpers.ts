// helpers: what a promise is, and when two results are the same

export const isPromise = (v: unknown): v is PromiseLike<unknown> =>
	v !== null && (typeof v === "object" || typeof v === "function") &&
	typeof (v as { then?: unknown }).then === "function"

// the same: by the computation's own comparison, else Object.is
export const same = (
	equal: ((a: unknown, b: unknown) => boolean) | undefined,
	a: unknown,
	b: unknown,
) => equal ? equal(a, b) : Object.is(a, b)
