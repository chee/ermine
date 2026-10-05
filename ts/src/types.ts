// The shapes of CORE.tex and PROTOCOL.tex: values, patches, changes, records,
// and the interface every layer of a stack offers.

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** A node's id. The core only compares ids. */
export type Id = string;

/** Where in the code a change from outside was made. */
export type Site = { file: string; line: number; column: number };

/** One step of a path: a node placed in a parent's slot. */
export type Step = { parent: Id; name: string; node: Id };
export type Path = readonly Step[];

/** A key in a patch path: a string into an object, a whole number into a list. */
export type Key = string | number;

export type Patch =
  | { type: "snapshot"; value: Json }
  | { type: "splice"; path: readonly Key[]; range: readonly [number, number]; value?: Json }
  | { type: "set"; path: readonly Key[]; key: string; value?: Json };

/** A node and a time name one change in a graph. */
export type ChangeRef = { node: Id; time: number };

/** What every change carries besides its kind. */
export type Common = { agent: Json; process?: Id; cause?: Json; site?: Site };

export type Change =
  & ChangeRef
  & (
    | { kind: "make"; value: Json; data?: Json }
    | { kind: "write"; patches: readonly Patch[] }
    | { kind: "place"; name: string; id: Id; position?: number }
    | { kind: "unplace"; name: string; id: Id }
  )
  & Common;

export type Ending = "done" | "pending" | "failed" | "refused";

export type RecordError = { kind: "invalid" | "refused"; op: string; why: string };

/** Which program a run used: the first id in the slot, and every id there. */
export type ProgramEntry =
  | { node: Id; saw: number; slot: Id[] }
  | { node: Id; absent: true; slot: Id[] }
  | { node: Id; refused: true; slot: Id[] };

/** One directory a lookup searched. */
export type Searched = { node: Id; saw: number | null } | { node: Id; refused: true };

export type Lookup = { name: string; searched: Searched[]; found: Id[] };

/** What a run did, as PROTOCOL.tex's Records. */
export type Record = {
  process: Id;
  run: number;
  agent: Json;
  marked: ChangeRef[];
  compute?: ProgramEntry;
  effect?: ProgramEntry;
  lookups: Lookup[];
  reads: { node: Id; saw: number | null }[];
  directories: { node: Id; name?: string; saw: number | null }[];
  value?: Json;
  cleanup: ChangeRef[];
  changes: ChangeRef[];
  ending: Ending;
  errors: RecordError[];
};

/** What a subscriber receives. */
export type Event = { change: Change } | { record: Record };

// Operations. Every operation carries an agent and may carry a process; a
// change also carries a time (given by drive, or by the caller below it), a
// site when made from outside any process, and may carry a cause. A bound
// interface fills in agent and process itself.

export type Acting = { agent?: Json; process?: Id };
export type Stamp = { time?: number; site?: Site; cause?: Json };

/** data is the node's fixed data: any JSON, never changed, never read by the core. */
export type MakeOp = Acting & Stamp & { id: Id; value: Json; data?: Json };
export type WriteOp = Acting & Stamp & { node: Id; patches: readonly Patch[] };
export type PlaceOp = Acting & Stamp & { parent: Id; name: string; id: Id; position?: number };
export type UnplaceOp = Acting & Stamp & { parent: Id; name: string; id: Id };
export type ReadOp = Acting & { node: Id };
export type DataOp = Acting & { node: Id };
export type DirectoryOp = Acting & { node: Id; name?: string };
/** The path is where the search starts; a bound interface gives its own. */
export type LookupOp = Acting & { name: string; path?: Path };
export type SubscribeOp = Acting & { node: Id; send: (event: Event) => void };
export type UnsubscribeOp = Acting & { sub: number };

/** A process a change marked, and the change. */
export type Marked = { process: Id; by: ChangeRef };

/** What a change returns. Wrappers may add to it (drive adds runs, stopped). */
export type Changed = { change: Change; marked: Marked[] };

export type Reading = { value: Json } | { absent: true };
/** A node's fixed data, null if it was made without any. */
export type Fixed = { data: Json } | { absent: true };
export type Listing =
  | { directory: [string, Id[]][] }
  | { slot: Id[] }
  | { absent: true };
export type Found = { found: Id[]; searched: Searched[] };

/** What bind fixes. writes: false is read-only; reads: false is write-only. */
export type Binding = {
  agent: Json;
  process?: Id;
  path?: Path;
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
  make(op: MakeOp): Changed;
  read(op: ReadOp): Reading;
  data(op: DataOp): Fixed;
  directory(op: DirectoryOp): Listing;
  lookup(op: LookupOp): Found;
  write(op: WriteOp): Changed;
  place(op: PlaceOp): Changed;
  unplace(op: UnplaceOp): Changed;
  subscribe(op: SubscribeOp): { sub: number };
  unsubscribe(op: UnsubscribeOp): void;
  /** An interface acting as that agent and process, at that path. */
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
}

/** Tells a layer the top of the stack again. */
export type Tell = (api: Interface) => void;

/** A bound interface, which stops working once ended. */
export interface Bound extends Interface {
  end(): void;
}

/** A program read through a recording: the slot and the first id's value. */
export type Program = { node: Id; slot: Id[] } & Reading;

/**
 * A recording is the interface of one run. What goes through it is recorded,
 * and the graph remembers its reads, replacing the process's last run's.
 */
export interface Recording extends Interface {
  readonly process: Id;
  readonly agent: Json;
  readonly run: number;
  readonly reads: readonly { node: Id; saw: number | null }[];
  readonly directories: readonly { node: Id; name?: string; saw: number | null }[];
  readonly lookups: readonly Lookup[];
  readonly changes: readonly ChangeRef[];
  readonly errors: readonly RecordError[];
  /** The nodes program() read: the process node, for its slots, then each program node. */
  readonly programs: readonly Id[];
  /** Another interface recorded into this run, such as the effect's. */
  through(api: Interface): Interface;
  /**
   * Reads the process's program slot, then the first id in it. Both reads
   * are remembered and go in the record as its compute or effect, not its
   * reads. Undefined when the slot is gone.
   */
  program(slot: "compute" | "effect"): Program | undefined;
}

// Marks ermine errors by a shared symbol, not by class, so a layer bundled on
// its own knows the errors another layer's bundle throws.
const ermine = Symbol.for("ermine.error");

/** An error an operation can end in, and the operation, once a layer names it. */
export class ErmineError extends Error {
  op?: string;
  constructor(readonly kind: "invalid" | "refused", why: string, op?: string) {
    super(why);
    this.name = new.target.name;
    Object.defineProperty(this, ermine, { value: true });
    if (op !== undefined) this.op = op;
  }

  static override [Symbol.hasInstance](e: unknown): boolean {
    if (typeof e !== "object" || e === null || !(ermine in e)) return false;
    const kind = (e as { kind?: unknown }).kind;
    return this === ErmineError || (this === Invalid ? kind === "invalid" : kind === "refused");
  }
}

/** The graph rejected the operation. */
export class Invalid extends ErmineError {
  constructor(why: string, op?: string) {
    super("invalid", why, op);
  }
}

/** A wrapper said no. */
export class Refused extends ErmineError {
  constructor(why: string, op?: string) {
    super("refused", why, op);
  }
}

/**
 * A layer's top operation. The first call sets the top and gives back a way
 * to set it again, for the caller to keep; later calls are invalid, so no
 * holder can point the stack elsewhere once it is built.
 */
export function told(set: Tell): (api: Interface) => Tell {
  let done = false;
  return (api) => {
    if (done) throw new Invalid("this layer has been told the top of the stack", "top");
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
