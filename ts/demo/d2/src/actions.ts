// What a person can do to the desk. Each is an ordinary change, or a start,
// made by the host as the actor it vouches for, through the top of the
// stack; none gives a cause, so each carries the site it was made from.

import type { Id, Json } from "d2/ermine";
import type { World } from "./stack.ts";

/** Moves an id to the front of its slot: the item that wins changes. */
export function front(w: World, parent: string[], name: string, id: Id) {
  return w.act(
    `front: ${[...parent, name].join("/")} ← ${id}`,
    () => w.s.place({ agent: w.actor, address: parent, name, id, position: 0 }),
  );
}

/**
 * Places a copy of a value nearer: in the directory a process runs in, so its
 * lookup stops there. The value is read as the actor, through the top of the
 * stack, from where the lookup found it (an address from at, such as
 * ["..", "..", "theme"]), so protect decides the read as it decides the
 * placement: nothing the actor could not read is copied.
 */
export function nearer(w: World, at: string[], name: string, found: string[]) {
  return w.act(`place ${name} nearer: ${[...at, name].join("/")}`, () => {
    const [first] = w.s.read({ agent: w.actor, place: at, address: found });
    if (!first) throw new Error(`${found.join("/")} reads as nothing`);
    const id = `${name}.near.${at[at.length - 1]}.${w.s.time + 1}`;
    return w.s.place({ agent: w.actor, address: at, name, id, value: first.value, position: 0 });
  });
}

/** Places a card's node again under another name, so two processes read one node. */
export function twice(w: World, cards: string[], id: Id, name: string) {
  return w.act(
    `show twice: ${[...cards, name].join("/")} = ${id}`,
    () => w.s.place({ agent: w.actor, address: cards, name, id }),
  );
}

/** Kills a process: unplaces it from its slot. */
export function kill(w: World, pid: Id) {
  const start = w.started.get(pid);
  const parent = start && w.pathOf(start.node);
  if (!parent) return;
  return w.act(
    `unplace ${pid} (a kill)`,
    () => w.s.unplace({ agent: w.actor, address: parent, name: pid, id: pid }),
  );
}

/** The program path a process was started with, from the program node it kept. */
export function programPath(w: World, programNode: Id): string[] | undefined {
  const p = w.where.get(programNode)?.[0];
  if (!p) return;
  const dir = w.where.get(p.parent)?.[0];
  return dir ? [dir.name, p.name] : [p.name];
}

/** Starts the program again where the process is, then unplaces the old one. */
export function restart(w: World, pid: Id, program: Id) {
  const start = w.started.get(pid);
  const parent = start && w.pathOf(start.node);
  const path = programPath(w, program);
  if (!parent || !path) return;
  return w.act(`restart ${pid}: start ${path.join("/")} again, then unplace the old`, () => {
    const started = w.s.start({ agent: w.actor, address: parent, program: path });
    w.s.unplace({ agent: w.actor, address: parent, name: pid, id: pid });
    return started;
  });
}

/** Starts a program at a place, as the actor; with place, its "/" is still the root. */
export function startHere(w: World, at: string[], program: string[]) {
  return w.act(`start ${program.join("/")} at ${at.join("/")} as ${w.actor}`, () =>
    // the place is where the process acts from: following it is not asked about
    w.s.start({ agent: w.actor, place: at, address: [], program }));
}

/** Writes a program's source: one module, both parts. */
export function editProgram(w: World, program: Id, source: Json) {
  const path = w.pathOf(program);
  if (!path) return;
  const parts: Json[] = typeof source === "string"
    ? [
      { type: "set", path: [], key: "compute", value: source },
      { type: "set", path: [], key: "effect", value: source },
    ]
    : [{ type: "snapshot", value: source }];
  return w.act(
    `edit ${path.join("/")}`,
    () => w.s.write({ agent: w.actor, address: path, patches: parts as never }),
  );
}

/** Writes bytes the person dropped: the host writes them, as the person, since input is JSON. */
export function dropBytes(w: World, at: string[], bytes: ArrayBuffer) {
  return w.act(
    `drop ${bytes.byteLength} bytes on ${at.join("/")}`,
    () => w.s.write({ agent: w.actor, address: at, patches: [{ type: "snapshot", value: bytes }] }),
  );
}
