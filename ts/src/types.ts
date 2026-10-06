// The shapes of CORE.tex and PROTOCOL.tex: values, addresses, patches,
// changes, items, records, errors, and the interface every layer of a stack
// offers.

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** A node's id. The core only compares ids, and uses them only for mounting. */
export type Id = string;

/** Where in the code a change from outside was made: its cause, unless the caller gave one. */
export type Site = { file: string; line: number; column: number };

/**
 * An address: an optional first "/", which starts at the start of the
 * interface's place; then any "..", each going back one step the way the
 * place was reached, to the node its walk came through; then names, going
 * down. ".", ".." and "/" are never names.
 */
export type Address = readonly string[];

/** One name walked: the parent, the slot's name, the member taken and its position in the slot. */
export type Step = { parent: Id; name: string; node: Id; position: number };
export type Route = readonly Step[];

/** A key in a patch path: a string into an object, a whole number into a list. */
export type Key = string | number;

export type Patch =
  | { type: "snapshot"; value: Json }
  | { type: "splice"; path: readonly Key[]; range: readonly [number, number]; value?: Json }
  | { type: "set"; path: readonly Key[]; key: string; value?: Json };

/** A node and a time name one change in a graph. */
export type ChangeRef = { node: Id; time: number };

/** What every change carries besides its kind. */
export type Common = { agent: Json; process?: Id; cause?: Json };

/**
 * A change. A placement's node is the parent. A placement with a value made
 * the node it placed: it is both the parent's change and the new node's first.
 */
export type Change =
  & ChangeRef
  & (
    | { kind: "write"; patches: readonly Patch[] }
    | { kind: "place"; name: string; id: Id; position?: number; value?: Json }
    | { kind: "unplace"; name: string; id: Id }
  )
  & Common;

/** Why a value item was given: the route its address took. */
export type RouteFrom = { route: Route };
/** Why an id in a slot was given: the route to the slot's node, and its position there. */
export type SlotFrom = { route: Route; position: number };
/** Why a lookup gave an id: the path from the place to the slot, and its position there. */
export type PathFrom = { path: Address; position: number };

/** A node's value, and the change that last set it (none for the root's first value). */
export type ValueItem = { value: Json; from: RouteFrom; change?: Change };
/** An id in a slot, the change that last set the slot, and pending when its node is not here. */
export type SlotItem = { id: Id; from: SlotFrom | PathFrom; change: Change; pending?: true };
export type Item = ValueItem | SlotItem;

/** A directory read: with a name, that slot's items; without, each name with its slot's items. */
export type Listing = { items: SlotItem[] } | { directory: [string, SlotItem[]][] };

export type Ending = "done" | "pending" | "failed" | "refused";

/** Why an operation failed: a code from PROTOCOL.tex's list, its details, and text for people. */
export type Why = {
  readonly code: string;
  readonly text?: string;
  readonly [detail: string]: Json | undefined;
};

/** An error as JSON: invalid, refused, or thrown by a program. */
export type ErrorJson = { kind: "invalid" | "refused" | "thrown"; op?: string; why: Why };
export type RecordError = ErrorJson;

/** Which program a run used: the first id in the slot whose node is here, and every id there. */
export type ProgramEntry =
  | { node: Id; saw: number | null; slot: Id[] }
  | { node: Id; refused: true; slot: Id[] };

/** One directory a lookup searched. */
export type Searched = { node: Id; saw: number | null } | { node: Id; refused: true };

export type Lookup = { name: string; searched: Searched[]; found: Id[] };

/** One read a run made: the address, the route it took, and the change it saw. */
export type ReadEntry = {
  op: "read" | "directory";
  address: Address;
  name?: string;
  route: Route;
  saw: number | null;
  refused?: true;
};

/** What a run did, as PROTOCOL.tex's Records. */
export type Record = {
  process: Id;
  run: number;
  agent: Json;
  marked: ChangeRef[];
  compute?: ProgramEntry;
  effect?: ProgramEntry;
  lookups: Lookup[];
  reads: ReadEntry[];
  value?: Json;
  cleanup: ChangeRef[];
  changes: ChangeRef[];
  ending: Ending;
  errors: RecordError[];
};

/** What a subscriber receives. */
export type Event = { change: Change } | { record: Record };

// Operations. Every operation carries an agent and may carry a process, and
// a place: names from the graph's root, the first chroot of which are hidden,
// so that its "/" is the node they reach. A change also carries a time (given
// by drive, or by the caller below it) and may carry a cause; one from outside
// any process that gives none gets its site, captured where the call entered
// the stack. A bound interface fills in agent, process and place itself.

export type Acting = { agent?: Json; process?: Id; place?: readonly string[]; chroot?: number };
export type Stamp = { time?: number; cause?: Json };

export type ReadOp = Acting & { address: Address };
export type DirectoryOp = Acting & { address: Address; name?: string };
/**
 * The search goes through the directories the place's walk went through,
 * from the one it reaches, ".", back up to its start, and takes the nearest
 * slot with the name that holds a node that is here.
 */
export type LookupOp = Acting & { name: string };
export type WriteOp = Acting & Stamp & { address: Address; patches: readonly Patch[] };
/** With a value, makes the node; without one, places it, or mounts it if the graph does not have it. */
export type PlaceOp = Acting & Stamp & {
  address: Address;
  name: string;
  id: Id;
  position?: number;
  value?: Json;
};
export type UnplaceOp = Acting & Stamp & { address: Address; name: string; id: Id };
export type SubscribeOp = Acting & { address: Address; send: (event: Event) => void };
export type UnsubscribeOp = Acting & { sub: number };

/** A process a change marked, and the change. */
export type Marked = { process: Id; by: ChangeRef };

/** What a change returns. Wrappers may add to it (drive adds runs, stopped). */
export type Changed = { change: Change; marked: Marked[] };

/** What bind fixes. writes: false is read-only; reads: false is write-only. */
export type Binding = {
  agent: Json;
  process?: Id;
  place?: readonly string[];
  chroot?: number;
  writes: boolean;
  reads?: boolean;
};

/** What a driver adds to a record when it finishes it. */
export type Finishing = { value?: Json; cleanup?: ChangeRef[]; errors?: RecordError[] };

/**
 * The operations of CORE.tex's table. A wrapper takes one and returns one,
 * may add operations, and passes on those it does not know.
 */
export interface Interface {
  /**
   * An item for each node the address's last name selects that is here, in
   * slot order, each with its own value, from and change: the first is the
   * node the address reaches. An address with no names, or only "..", reads
   * the one node it reaches; one that reaches nothing reads as none.
   */
  read(op: ReadOp): ValueItem[];
  /** The items of one slot, or every name with its slot's items; of a union's members together. */
  directory(op: DirectoryOp): Listing;
  /** The items of the nearest slot with the name, searching up the place. */
  lookup(op: LookupOp): SlotItem[];
  write(op: WriteOp): Changed;
  place(op: PlaceOp): Changed;
  unplace(op: UnplaceOp): Changed;
  /**
   * Sends each change to the node the address reaches, following the address
   * as its route changes, and each placement that changes its route, whether
   * or not it then reaches another node. Numbered from 1, in the order made.
   */
  subscribe(op: SubscribeOp): { sub: number };
  unsubscribe(op: UnsubscribeOp): void;
  /** An interface acting as that agent and process, at that place. */
  bind(api: Interface, binding: Binding): Bound;
  /** An interface passing everything to a bound api and recording it, for one run. */
  record(api: Interface, marked: readonly ChangeRef[]): Recording;
  /** Ends the recording, sends the record to the process's subscribers, returns it. */
  finish(recording: Recording, ending: Ending, finishing?: Finishing): Record;
  /**
   * Tells this layer, and the ones below, the top of the stack. A layer is
   * told once; later calls are invalid. It gives back a way to tell it again,
   * which the caller keeps: a wrapper tells the layer below when it is made,
   * and again when it is told itself.
   */
  top(api: Interface): Tell;
  /** The path of the directory this interface's place reaches, its ".", below its "/". */
  readonly cwd: readonly string[];
  /**
   * The id of the node an operation's address reaches, if it reaches one,
   * for a wrapper deciding about it, as protect does. Not an operation:
   * nothing is read, recorded or asked. Bound interfaces leave it out.
   */
  reach?(op: Acting & { address: Address }): Id | undefined;
}

/** Tells a layer the top of the stack again. */
export type Tell = (api: Interface) => void;

/** A bound interface, which stops working once ended. */
export interface Bound extends Interface {
  end(): void;
}

/**
 * A program read through a recording: every id in its slot, the first whose
 * node is here (the one used), and the items of reading the slot's address,
 * the used node's first: none if no id is here or the node gave none.
 */
export type Program = { node?: Id; slot: Id[]; items: ValueItem[] };

/**
 * A recording is the interface of one run. What goes through it is recorded,
 * and the graph remembers its reads alongside the process's last run's,
 * replacing them when the run is finished.
 */
export interface Recording extends Interface {
  readonly process: Id;
  readonly agent: Json;
  readonly run: number;
  readonly reads: readonly ReadEntry[];
  readonly lookups: readonly Lookup[];
  readonly changes: readonly ChangeRef[];
  readonly errors: readonly RecordError[];
  /** The nodes whose value this run read, program nodes included. */
  readonly values: ReadonlySet<Id>;
  /** Every node whose value or directory this run read, or whose slots a walk of it tried. */
  readonly nodes: ReadonlySet<Id>;
  /** Another interface recorded into this run, such as the effect's. */
  through(api: Interface): Interface;
  /**
   * Reads the program slot of the process node at the address, then the
   * first id in it whose node is here. Both reads are remembered and go in
   * the record as its compute or effect, not its reads. Undefined when the
   * slot is gone.
   */
  program(part: "compute" | "effect", at: Address): Program | undefined;
}

// Marks ermine errors by a shared symbol, not by class, so a layer bundled on
// its own knows the errors another layer's bundle throws.
const ermine = Symbol.for("ermine.error");

/** An error an operation can end in, why, and the operation, once a layer names it. */
export class ErmineError extends Error {
  op?: string;
  readonly why: Why;
  constructor(readonly kind: "invalid" | "refused", why: Why, op?: string) {
    super(why.text ?? why.code);
    this.name = new.target.name;
    this.why = why;
    Object.defineProperty(this, ermine, { value: true });
    if (op !== undefined) this.op = op;
  }

  /** The error as JSON: kind, op if named, and why. */
  toJSON(): ErrorJson {
    return this.op === undefined
      ? { kind: this.kind, why: this.why }
      : { kind: this.kind, op: this.op, why: this.why };
  }

  static override [Symbol.hasInstance](e: unknown): boolean {
    if (typeof e !== "object" || e === null || !(ermine in e)) return false;
    const kind = (e as { kind?: unknown }).kind;
    if ((this as unknown) === ErmineError) return true;
    return (this as unknown) === Invalid ? kind === "invalid" : kind === "refused";
  }
}

/** The graph, or an interface, rejected the operation. */
export class Invalid extends ErmineError {
  constructor(why: Why, op?: string) {
    super("invalid", why, op);
  }
}

/** A wrapper said no. */
export class Refused extends ErmineError {
  constructor(why: Why, op?: string) {
    super("refused", why, op);
  }
}

/** An invalid error with a code, its details, and text for people. */
export function invalid(code: string, text: string, details: { [detail: string]: Json } = {}) {
  return new Invalid({ code, ...details, text });
}

/** A field an operation needs is not there. */
export function missing(field: string) {
  return invalid("missing", `${field} is missing`, { field });
}

/** A field is of the wrong kind. */
export function wrongField(field: string, text = `${field} is of the wrong kind`) {
  return invalid("wrong-field", text, { field });
}

/**
 * A layer's top operation. The first call sets the top and gives back a way
 * to set it again, for the caller to keep; later calls are invalid, so no
 * holder can point the stack elsewhere once it is built.
 */
export function told(set: Tell): (api: Interface) => Tell {
  let done = false;
  return (api) => {
    if (done) throw invalid("told", "this layer has been told the top of the stack");
    done = true;
    set(api);
    return set;
  };
}

/** Names the operation an error ended, unless a layer below already did. */
export function naming<A extends unknown[], R>(op: string, fn: (...args: A) => R) {
  return (...args: A): R => {
    try {
      return fn(...args);
    } catch (e) {
      if (e instanceof ErmineError && e.op === undefined) e.op = op;
      throw e;
    }
  };
}

// Sites. A change from outside any process that gives no cause gets its site:
// the file, line and column of the code that called the top of the stack.
// Each module of the library registers its file, so frames inside it are
// passed over, whichever bundle it came in.

const FILES = Symbol.for("ermine.files");
type Global = { [FILES]?: Set<string> };

/** Marks a module's file as part of ermine, so a site is never inside it. */
export function ours(url: string) {
  const g = globalThis as Global;
  (g[FILES] ??= new Set()).add(url);
}
ours(import.meta.url);

type V8Error = {
  captureStackTrace?: (holder: object, entry?: unknown) => void;
  stackTraceLimit?: number;
};

/**
 * The site of the call that entered the stack at entry, the top's operation:
 * the first frame outside ermine. Undefined if no frame can be read.
 */
export function capture(entry?: unknown): Site | undefined {
  const E = Error as unknown as V8Error;
  const limit = E.stackTraceLimit;
  if (typeof limit === "number" && limit < 100) E.stackTraceLimit = 100;
  try {
    if (typeof E.captureStackTrace === "function" && typeof entry === "function") {
      const holder: { stack?: string } = {};
      E.captureStackTrace(holder, entry);
      const site = outside(holder.stack);
      if (site) return site;
    }
    return outside(new Error().stack);
  } finally {
    if (typeof limit === "number") E.stackTraceLimit = limit;
  }
}

/** The first frame of a stack whose file is not ermine's. */
function outside(stack: string | undefined): Site | undefined {
  if (typeof stack !== "string") return;
  const files = (globalThis as Global)[FILES] ?? new Set();
  for (const raw of stack.split("\n")) {
    const m = /(\S+):(\d+):(\d+)\)?\s*$/.exec(raw.trim());
    if (!m) continue;
    let file = m[1];
    file = file.slice(file.lastIndexOf("(") + 1);
    file = file.slice(file.lastIndexOf("@") + 1);
    if (!file || files.has(file)) continue;
    return { file, line: Number(m[2]), column: Number(m[3]) };
  }
}
