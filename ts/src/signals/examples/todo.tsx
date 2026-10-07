/** @jsxRuntime classic */
/** @jsx h */
// The todo list: todos is kept beside the process and outlives it; the
// draft is the process's own and goes with it. Relative imports, as in
// counter.tsx.

import { each, h } from "../../dom/mod.ts";
import { input, keep, me, show, signals } from "../mod.ts";
import type { ComputeGiven, EffectGiven } from "../../loaders.ts";
import { screen } from "demo";

void h;

type Todo = { text: string; done: boolean };

const my = signals({
  todos: keep(null), // ./todos: one child node per todo; outlives the process
  draft: input(""), // what is being typed; gone with the process
});

export function compute(ctx: ComputeGiven) {
  const { todos } = my(ctx);
  const all = todos.names().map((name) => todos.at<Todo>(name)()); // each read is tracked
  return { left: all.filter((t) => !t.done).length, total: all.length };
}

export function effect(ctx: EffectGiven) {
  const { todos, draft } = my(ctx);
  const self = me<{ left: number; total: number }>(ctx);
  return show(ctx, screen(ctx.self), () => (
    <form
      onSubmit={(e: SubmitEvent) => {
        e.preventDefault();
        if (draft()) todos.add({ text: draft(), done: false });
        draft("");
      }}
    >
      <input value={draft} onInput={(e: Event) => draft((e.target as HTMLInputElement).value)} />
      <ul>
        {each(todos, (_row, name) => {
          const todo = todos.at<Todo>(name);
          return (
            <li>
              <input
                type="checkbox"
                checked={() => todo().done}
                onChange={() => todo((t) => ({ ...t, done: !t.done }))}
              />
              {() => todo().text}
              <button type="button" onClick={() => todos.drop(name)}>×</button>
            </li>
          );
        })}
      </ul>
      <p>{() => `${self()?.left ?? 0} of ${self()?.total ?? 0} left`}</p>
    </form>
  ));
}
