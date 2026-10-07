// The steps loader on its own: programs as data, given what a part is given.

import { assertEquals, assertThrows } from "@std/assert";
import {
  type Acts,
  type Loaded,
  PENDING,
  type Running,
  Thrown,
} from "../../scheduler/typescript/loaders.ts";
import { steps } from "./steps.ts";
import { ErmineError, type Json } from "./types.ts";

const process = {} as Running;

/** A compute's function for these steps, called with nothing to read. */
function compute(list: Json, vars: { [key: string]: unknown } = {}) {
  const f = steps({ live: (kind) => ({ kind }) as unknown as Json }).load(list, "compute", process);
  return f(
    {
      api: {} as Acts,
      self: "p",
      cwd: ["a"],
      name: "p",
      changes: [],
      pending: PENDING,
      ...vars,
    } as unknown as Parameters<Loaded>[0],
  );
}

const why = (f: () => unknown) => {
  const e = assertThrows(f);
  return e instanceof Thrown || e instanceof ErmineError ? e.why.code : undefined;
};

Deno.test("a part that is not a list of known steps cannot be loaded", () => {
  for (const code of ["hello", [{ do: "nope" }], [{ do: "if", test: true, then: "x" }]]) {
    const e = assertThrows(() => steps().load(code as Json, "compute", process));
    assertEquals((e as ErmineError).why.code, "not-a-program");
  }
});

Deno.test("expressions: variables, $get, $len in code points, $concat, $eq, $quote", () => {
  assertEquals(
    compute([{
      do: "return",
      value: {
        self: { $: "self" },
        cwd: { $: "cwd" },
        got: { $get: [{ $quote: { a: [1, 2] } }, "a", 1] },
        none: { $missing: { $get: [{ $quote: {} }, "x"] } },
        len: { $len: "h😀" },
        cat: { $concat: [[1], [2, 3]] },
        eq: { $eq: [{ $quote: { x: 1, y: 2 } }, { $quote: { y: 2, x: 1 } }] },
        quoted: { $quote: { $: "self" } },
      },
    }]),
    {
      self: "p",
      cwd: ["a"],
      got: 2,
      none: true,
      len: 2,
      cat: [1, 2, 3],
      eq: true,
      quoted: { $: "self" },
    },
  );
});

Deno.test("a compute that ends without return returns null; pending returns the pending value", () => {
  assertEquals(compute([]), null);
  assertEquals(compute([{ do: "pending" }]), PENDING);
});

Deno.test("mistakes: unbound, missing-value, not-boolean, operator, thrown, wrong-part", () => {
  assertEquals(why(() => compute([{ do: "return", value: { $: "nope" } }])), "unbound");
  assertEquals(
    why(() => compute([{ do: "return", value: { $get: [{ $quote: {} }, "x"] } }])),
    "missing-value",
  );
  assertEquals(why(() => compute([{ do: "if", test: 1, then: [] }])), "not-boolean");
  assertEquals(why(() => compute([{ do: "return", value: { $add: [1, "a"] } }])), "operator");
  assertEquals(why(() => compute([{ do: "return", value: { $nope: 1 } }])), "operator");
  assertEquals(why(() => compute([{ do: "throw", message: "x" }])), "thrown");
  assertEquals(why(() => compute([{ do: "handler", name: "h", steps: [] }])), "wrong-part");
});

Deno.test("try catches a throw as its error, and a let sees it after", () => {
  assertEquals(
    compute([
      { do: "try", steps: [{ do: "throw", message: "x" }], as: "e" },
      { do: "try", steps: [], as: "f" },
      { do: "return", value: [{ $: "e" }, { $: "f" }] },
    ]),
    [{ kind: "thrown", why: { code: "thrown", message: "x" } }, null],
  );
});

Deno.test("each binds each element in turn", () => {
  assertEquals(
    compute([
      { do: "let", as: "n", value: 0 },
      {
        do: "each",
        list: [1, 2, 3],
        as: "x",
        steps: [{ do: "let", as: "n", value: { $add: [{ $: "n" }, { $: "x" }] } }],
      },
      { do: "return", value: { $: "n" } },
    ]),
    6,
  );
});
