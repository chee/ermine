-- LLM generated working output
-- the scopes tree of scheduler.ts: root, scope, compute and effect (a computation is a scope),
-- cleanup, clean, dispose, run(o, f), current, and what is open; and what a run, a set and an act
-- do to the tree. theorem 6 of proof.md §9 (with §13.3: "6 (c): no exceptions"), clean's
-- after/from (D3's fix), and what scopes promise.
--
-- proved (Inv t [] and Ids t hold from empty through every call at the top: inv_empty,
-- ids_empty, top_grow, top_cleanup, top_dispose, top_clean, top_run, top_go, top_give, top_act):
-- - six_a, 6 (a): o alive, the cleanups under it inert (touch nothing): dispose(o) returns,
--   having run exactly D(o) (trace; trace_eq: children newest first, each fully, then o's
--   cleanups newest first), every one even when some throw, and throws the first error.
--   dispose_inert: the same at any fuel, in any state where what o reaches is tidy.
-- - six_c, 6 (c): at the top, after dispose(o) every scope under o is gone, with no children
--   and no cleanups, and o is out of its parent's children. dispose_clears: the same in a
--   cleanup, when no dispose or clean under way below is of a scope under o. not so otherwise:
--   dispose(p) from a cleanup of a grandchild under p returns with that grandchild's parent
--   disposing and its older sibling alive (checked against scheduler.ts); they go once the
--   outer dispose returns.
-- - clean_after (clean_inert at any fuel): clean(o, after, from), its cleanups inert, disposes
--   exactly the children made after the after-th, then runs exactly the cleanups from the
--   from-th on, both newest first; o and the rest stay.
-- - six_b, 6 (b): cleanups as code that registers, makes, disposes, runs, writes, throws. every
--   cleanup registered under o, before dispose(o) or during it, has run exactly once when it
--   returns; none ever runs twice (Ids). grow_throws, make_throws: scope (compute, effect) under
--   a disposing or gone scope throws; cleanup_now: cleanup on one runs at once; cleanup_push.
-- - dispose_some: under Inv, fuel mu t + 1 is enough (mu: alive scopes plus the size of the
--   code held in cleanups); dispose_fuel: more fuel, the same result.
-- what is open:
-- - balanced (exec_flat, dispose_flat, clean_flat, run_flat, go_flat, give_flat, act_flat): when
--   a call returns or throws, what is open is what was open before it.
-- - unscoped: with nothing open, scope(info), compute, effect and cleanup throw unscoped and
--   change nothing. root and scope(info, parent) need nothing open.
-- - after_await: calls from the top of the stack, one after another, each start with nothing
--   open (steps_flat), so making there is unscoped: a continuation after an await is such a call.
-- - attach: make_open, comp_open, cleanup_push, cleanup_now: what is made, and a cleanup, goes
--   on the scope open (open_throws: it not alive, disposed). within_under: code naming only
--   scopes under o, run with one under o open, makes only under o and registers cleanups only
--   on scopes under o; run_under, go_under: the same for run(o, f), and for a run of a
--   computation under o. takes, takes_go: disposing o after takes all of it, and runs every
--   cleanup registered there exactly once.
-- - info: grow_info, a scope made under p has the pairs given, then ["owner", p's info] (Info:
--   it nests, innermost first; levels unfolds it); grow_empty, make_empty: a scope given no pairs
--   is not made (empty; a computation's info is its own). the header: write_header, a write's
--   pairs are the info of the scope open (write_outside: nothing open, none); go_header, in a run
--   the run's own pairs, then its owner's info. line_spec: the scopes over one, root first
-- - the going path: bury (a pulse's end, an attended computation going: clean(x) with x open,
--   then the host's gone told, nothing new open). top_bury: Inv and Ids kept, so no cleanup runs
--   twice through goings either; going: its cleanups inert, every one under x disposed and every
--   cleanup of x run, exactly once each, newest first; x left alive (asleep) with no children and
--   no cleanups; what is not under x as it was. bury_flat: balanced
-- - who is open: run_opens (run(o, f): o, the writer kept), go_opens (a run: its computation,
--   written by its own read, its info the run's), give_opens and act_opens (a set, an act: the
--   computation, written by it), call_opens (a cleanup: its scope; a computation's written by
--   it, any other's by the writer open), kids_opens (what clean disposes under o goes with o open,
--   as its cleanups: a computation's written by it). opens_comp, opens_plain: so a plain scope's
--   cleanup, run by a computation's clean, is written by the nearest computation over it.
-- - Scopes.Check: scenarios 43, 44 and 46 by evaluation, and plain scopes' cleanups run by a
--   computation's clean: written by it, one scope down or more; under an inner one, by that one.
--
-- the model, and where it departs from the code:
-- - scopes are records in a map from their number (Scope.n) to {parent, children, cleanups,
--   state, info, comp}; children hold numbers, not objects (numbers are unique, so lastIndexOf
--   agrees). numbers start at 1 (made counts them). a number not made yet maps to the empty
--   record, gone: the code cannot name such a scope; here naming one acts as naming a gone one.
-- - info: a scope's pairs, opaque (a pair is two numbers here, never looked into), then its
--   owner's info, nested (Info). a run's info (its number, the tick of its mark) is given to go;
--   its owner is the computation's parent's info then. a computation's first info (the tick of
--   its mark) is not kept: .root [] / .under [] until its first run
-- - a computation is a scope with comp set, made under the one open (comp). what dispose does
--   to it besides the tree (drop: live, order, tracker, writers, acts, causes, and the host's
--   forget it may call; `ran = undefined`) is assumed to touch no scope, and is left out. its
--   runs, sets and acts are modelled for what they do to the tree (go, give, act); the
--   scheduler calls them for alive computations only. a run's info (its number, the tick of
--   its mark) and an effect's after/from (`acted`) are given to go, not kept. the pulse, which
--   calls them, is not modelled.
-- - what is open: a stack (Tree.opened), its head open, the rest put back as each bracket above
--   it ends: the code's `open` and the `was` each enter keeps. enter pushes, and puts back what
--   was open, as its finally does. nothing open (open undefined): the empty stack.
-- - a writer (By): a computation (its latest run), or the read of the run of a computation going
--   on (Who.read x). the run's number is not kept: runs of one computation never overlap.
-- - code (Code) is what a cleanup, a setup, a run's f, a set or an act may do to the tree:
--   cleanup on the scope open, scope, compute or effect, root, dispose, run, write. scopes are
--   named by number. no catch: a throw ends the code (run's throw is its caller's). reads,
--   pulses, results and anything else are left out.
-- - a write: changed(keys, current().by). the log records what current showed (Event.write).
-- - each registration takes a fresh id (regs); the log records each registration and each run.
-- - errors are values (Err). disposed() and unscoped() make a new SchedulerError each time;
--   here one value each.
-- - the recursion takes fuel: dispose n runs out (none) at depth n.
-- - first and act call clean (and computations' runs call scope, cleanup, dispose) between
--   pulses' steps, with no dispose or clean under way: "at the top" (Inv t []). something may
--   be open then: a pulse may be called in run(o, f).
--
-- javascript, assumed:
-- - a finally runs whether its try returns or throws, so enter puts back what was open either
--   way (the model's enter does; the code sets `open` nowhere else, and starts it undefined).
-- - an async function returns at its first await; the code after it runs later, as a
--   microtask, and javascript starts a microtask only on an empty stack: every frame of the code
--   before it has returned, each enter with its finally. so a continuation is a call from the
--   top (Call), as an event's handler and a timer's are; nothing calls the scheduler but such
--   calls and the code they run.

namespace Scopes

-- Scope.state
inductive State where
  | alive
  | disposing
  | gone
  deriving DecidableEq, Repr

-- a pair of a scope's info, [key, value]: opaque, as keys are. here two numbers, never looked
-- into
abbrev Pair := Nat × Nat

-- a scope's info (scheduler.ts Scope.info): the pairs given, then ["owner", the info of the scope
-- it was made under] (a root: none). so it nests, innermost first
inductive Info where
  | root (own : List Pair)
  | under (own : List Pair) (owner : Info)
  deriving DecidableEq, Repr

-- the pairs, then the owner's info if there is one
def Info.of (i : List Pair) : Option Info → Info
  | none => .root i
  | some o => .under i o

-- who made a change (By): a computation (its latest run), or a run's own read (the run of that
-- computation going on)
inductive Who where
  | comp (x : Nat)
  | read (x : Nat)
  deriving DecidableEq, Repr

-- what is open (the code's `open`): the scope, and the writer (none: from outside)
structure Bracket where
  scope : Nat
  who : Option Who
  deriving DecidableEq, Repr

-- what current() shows (Open): the scope open, the pairs of a write made now, the writer
structure Current where
  scope : Nat
  pairs : Info
  who : Option Who
  deriving DecidableEq, Repr

-- code: what a cleanup, a setup, a run's f, a set or an act may do to the tree
inductive Code where
  | done
  | throw (e : Nat)
  -- cleanup(f) on the scope open, then k
  | reg (f k : Code)
  -- scope(info, p): under p, else under the scope open; then k
  | make (p : Option Nat) (i : List Pair) (k : Code)
  -- compute or effect: a computation under the scope open; then k
  | comp (k : Code)
  -- root(info), then k
  | root (i : List Pair) (k : Code)
  -- dispose(o), then k
  | disp (o : Nat) (k : Code)
  -- run(o, f), then k: f with o open; f's throw is the caller's
  | run (o : Nat) (f k : Code)
  -- a change, written by the writer open, with the pairs of what is open
  -- (changed(keys, current().by)); then k
  | write (k : Code)
  deriving DecidableEq, Repr

-- what code or the scheduler throws
inductive Err where
  | thrown (e : Nat)
  | disposed
  | unscoped
  -- a scope made with no pairs (scheduler.ts grow: empty)
  | empty
  deriving DecidableEq, Repr

-- Scope, without n (the map's key). a cleanup is its id and its code. comp: a computation
structure Scope where
  parent : Option Nat := none
  children : List Nat := []
  cleanups : List (Nat × Code) := []
  state : State := .gone
  info : Info := .root []
  comp : Bool := false

-- what the log records
inductive Event where
  | reg (i o : Nat)
  | run (i : Nat)
  -- a write, with what current showed then
  | write (c : Option Current)
  deriving DecidableEq, Repr

-- the scopes, made (the code's `made`), regs (cleanup ids given), the log, what is open (the
-- head open)
structure Tree where
  scopes : Nat → Scope
  made : Nat
  regs : Nat
  log : List Event
  opened : List Bracket

-- none: out of fuel; else the tree after, and what was thrown
abbrev Result := Option (Tree × Option Err)

def Tree.set (t : Tree) (o : Nat) (r : Scope) : Tree :=
  { t with scopes := fun m => if m = o then r else t.scopes m }

def Tree.note (t : Tree) (e : Event) : Tree := { t with log := t.log ++ [e] }

-- nothing made yet, nothing open
def empty : Tree := ⟨fun _ => {}, 0, 0, [], []⟩

-- `failed ??= { error: e }`: the first error kept
def pick : Option Err → Option Err → Option Err
  | some e, _ => some e
  | none, e => e

-- the first error of a list
def first : List (Option Err) → Option Err
  | [] => none
  | e :: es => pick e (first es)

-- then k, unless it threw (a throw in code ends it) or ran out of fuel
def chain : Result → (Tree → Result) → Result
  | none, _ => none
  | some (t, some e), _ => some (t, some e)
  | some (t, none), k => k t

-- enter(next, f): f with b open; what was open is back after, whatever f did (its finally)
def enter (b : Bracket) (t : Tree) (f : Tree → Result) : Result :=
  match f { t with opened := b :: t.opened } with
  | none => none
  | some (t', e) => some ({ t' with opened := t.opened }, e)

-- the writer open (open?.by): nothing open, none
def Tree.who (t : Tree) : Option Who :=
  match t.opened with
  | [] => none
  | b :: _ => b.who

-- a cleanup opens its scope (opens): a computation's written by it, any other's by the writer
-- open
def opens (t : Tree) (o : Nat) : Bracket :=
  ⟨o, if (t.scopes o).comp then some (.comp o) else t.who⟩

-- o and the scopes over it, from the root down: current's walk up the parents, turned round.
-- with fuel; o + 1 is enough, a parent being older than its child
def line (t : Tree) : Nat → Nat → List Nat
  | 0, _ => []
  | n + 1, o =>
    match (t.scopes o).parent with
    | none => [o]
    | some p => line t n p ++ [o]

-- the pairs of a write made with o open (getInfo): o's info, nesting its owners'
def pairs (t : Tree) (o : Nat) : Info := (t.scopes o).info

-- the info of the scope x is under, as its owner pair holds it (a root: none)
def ownerOf (t : Tree) (x : Nat) : Option Info := (t.scopes x).parent.map fun p => (t.scopes p).info

-- current(): what is open, the pairs of a write made now, and the writer; nothing open, none
def current (t : Tree) : Option Current :=
  match t.opened with
  | [] => none
  | b :: _ => some ⟨b.scope, pairs t b.scope, b.who⟩

-- grow(parent, info): a new scope (c: a computation, its info its own: no pairs needed); under a
-- scope not alive, disposed; a scope with no pairs, empty. its info: the pairs, then its owner's
def grow (t : Tree) : Option Nat → List Pair → Bool → Except Err (Tree × Nat)
  | none, i, c =>
    if c = false ∧ i = [] then .error .empty
    else .ok ({ t with made := t.made + 1 }.set (t.made + 1)
      { state := .alive, info := .root i, comp := c }, t.made + 1)
  | some p, i, c =>
    if (t.scopes p).state ≠ .alive then .error .disposed
    else if c = false ∧ i = [] then .error .empty
    else
      let t' := t.set p { t.scopes p with children := (t.scopes p).children ++ [t.made + 1] }
      .ok ({ t' with made := t.made + 1 }.set (t.made + 1)
        { parent := some p, state := .alive, info := .under i (t.scopes p).info, comp := c },
        t.made + 1)

-- scope(info, up), and make's parent(): a new scope under up, else under the one open; nothing
-- open, unscoped
def scope (t : Tree) (up : Option Nat) (i : List Pair) (c : Bool) : Except Err (Tree × Nat) :=
  match up, t.opened with
  | some p, _ => grow t (some p) i c
  | none, b :: _ => grow t (some b.scope) i c
  | none, [] => .error .unscoped

-- code running; d: dispose. cleanup(f) is the reg case
def exec (d : Tree → Nat → Result) : Tree → Code → Result
  | t, .done => some (t, none)
  | t, .throw e => some (t, some (.thrown e))
  | t, .reg f k =>
    match t.opened with
    | [] => some (t, some .unscoped)
    | b :: _ =>
      let i := t.regs
      let t := { t with regs := i + 1 }.note (.reg i b.scope)
      if (t.scopes b.scope).state = .alive then
        exec d (t.set b.scope { t.scopes b.scope with cleanups := (t.scopes b.scope).cleanups ++ [(i, f)] }) k
      -- on a scope not alive, f runs now, with its scope open
      else chain (enter (opens t b.scope) (t.note (.run i)) (fun t => exec d t f)) (fun t => exec d t k)
  | t, .make p i k =>
    match scope t p i false with
    | .error e => some (t, some e)
    | .ok (t, _) => exec d t k
  | t, .comp k =>
    match scope t none [] true with
    | .error e => some (t, some e)
    | .ok (t, _) => exec d t k
  | t, .root i k =>
    match grow t none i false with
    | .error e => some (t, some e)
    | .ok (t, _) => exec d t k
  | t, .disp o k => chain (d t o) (fun t => exec d t k)
  | t, .run o f k =>
    if (t.scopes o).state ≠ .alive then some (t, some .disposed)
    else chain (enter ⟨o, t.who⟩ t (fun t => exec d t f)) (fun t => exec d t k)
  | t, .write k => exec d (t.note (.write (current t))) k

-- cleanup(f), on the scope open
def cleanup (d : Tree → Nat → Result) (t : Tree) (f : Code) : Result :=
  exec d t (.reg f .done)

-- run(o, f)
def run (d : Tree → Nat → Result) (t : Tree) (o : Nat) (f : Code) : Result :=
  exec d t (.run o f .done)

-- clean's loops (the `for` with try/catch): every step, even after a throw; the first error
def each {α : Type} (step : Tree → α → Result) : Tree → List α → Option Err → Result
  | t, [], f => some (t, f)
  | t, x :: xs, f =>
    match step t x with
    | none => none
    | some (t, e) => each step t xs (pick f e)

-- one of clean's cleanups, on o: fs[i](), with o open (opens)
def call (d : Tree → Nat → Result) (o : Nat) (t : Tree) (x : Nat × Code) : Result :=
  enter (opens t o) (t.note (.run x.1)) (fun t => exec d t x.2)

-- clean's kids, newest first: the children past the last one made by the after-th
def later (l : List Nat) (after : Nat) : List Nat := l.reverse.takeWhile (· > after)

-- what clean leaves of the children
def kept (l : List Nat) (after : Nat) : List Nat := (l.reverse.dropWhile (· > after)).reverse

-- clean's first loop: the kids newest first, each disposed, with o open as its cleanups are
-- (opens): a computation's written by it, any other's by the writer open
def kids (d : Tree → Nat → Result) (o : Nat) (t : Tree) (ks : List Nat) : Result :=
  enter (opens t o) t (fun t => each d t ks none)

-- clean(o, after, from), from named start; d: dispose. what is under o goes in o's bracket
-- (kids), then o's cleanups, each in its own (call)
def clean (d : Tree → Nat → Result) (t : Tree) (o after start : Nat) : Result :=
  match kids d o (t.set o { t.scopes o with children := kept (t.scopes o).children after })
      (later (t.scopes o).children after) with
  | none => none
  | some (t, failed) =>
    each (call d o) (t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take start })
      ((t.scopes o).cleanups.drop start).reverse failed

-- dispose's last step: o out of its parent's children (lastIndexOf, splice)
def unlink (t : Tree) (o : Nat) : Tree :=
  match (t.scopes o).parent with
  | none => t
  | some p => t.set p { t.scopes p with children := ((t.scopes p).children.reverse.erase o).reverse }

-- dispose(o), with fuel
def dispose : Nat → Tree → Nat → Result
  | 0, _, _ => none
  | n + 1, t, o =>
    if (t.scopes o).state ≠ .alive then some (t, none)
    else
      match clean (dispose n) (t.set o { t.scopes o with state := .disposing }) o 0 0 with
      | none => none
      | some (t, e) => some (unlink (t.set o { t.scopes o with state := .gone }) o, e)

-- a run of the computation x, on the tree (first): what is under it goes first, clean(x,
-- after, from), written by x (all of a compute's; of an effect's, what was made since its last
-- act); gone by
-- then, nothing more; else its info becomes the run's (i: its number, the tick of the mark that
-- made it due) and f runs with x open, written by its own read. the first error, the clean's or
-- f's: first catches both
def go (n : Nat) (t : Tree) (x after start : Nat) (i : List Pair) (f : Code) : Result :=
  match clean (dispose n) t x after start with
  | none => none
  | some (t, e) =>
    if (t.scopes x).state ≠ .alive then some (t, e)
    else
      match enter ⟨x, some (.read x)⟩ (t.set x { t.scopes x with info := .of i (ownerOf t x) })
          (fun t => exec (dispose n) t f) with
      | none => none
      | some (t, e') => some (t, pick e e')

-- a compute's set, on the tree: with x open, written by x
def give (n : Nat) (t : Tree) (x : Nat) (f : Code) : Result :=
  enter ⟨x, some (.comp x)⟩ t (fun t => exec (dispose n) t f)

-- an effect's act, on the tree: what is under it goes (clean(x)); gone by then, nothing more;
-- else the act runs with x open, written by x. the first error
def act (n : Nat) (t : Tree) (x : Nat) (f : Code) : Result :=
  match clean (dispose n) t x 0 0 with
  | none => none
  | some (t, e) =>
    if (t.scopes x).state ≠ .alive then some (t, e)
    else
      match give n t x f with
      | none => none
      | some (t, e') => some (t, pick e e')

-- an attended computation going at a pulse's end (scheduler.ts bury): all under it goes and all
-- its teardowns run (clean(x), x open as a computation's); gone by then, nothing more; else it
-- stays alive (asleep: no scope moves) and the host's gone(failed) is told, with nothing new open:
-- what clean failed with is gone's to see, not thrown; what gone throws is the caller's
def bury (n : Nat) (t : Tree) (x : Nat) (g : Code) : Result :=
  match clean (dispose n) t x 0 0 with
  | none => none
  | some (t, e) =>
    if (t.scopes x).state ≠ .alive then some (t, none)
    else exec (dispose n) t g

-- a call from the top of the stack: code (a host's, an event's handler, a timer, a continuation
-- after an await), or the scheduler's own, in a pulse called from the top: a run, a set, an act,
-- a going
inductive Call where
  | code (c : Code)
  | go (x after start : Nat) (i : List Pair) (f : Code)
  | give (x : Nat) (f : Code)
  | act (x : Nat) (f : Code)
  | bury (x : Nat) (g : Code)

def Call.call (n : Nat) (t : Tree) : Call → Result
  | .code c => exec (dispose n) t c
  | .go x a s i f => Scopes.go n t x a s i f
  | .give x f => Scopes.give n t x f
  | .act x f => Scopes.act n t x f
  | .bury x g => Scopes.bury n t x g

-- calls one after another, each from the top; none if one ran out of fuel. what one throws is
-- its caller's, and the next goes on
def steps (n : Nat) : Tree → List Call → Option Tree
  | t, [] => some t
  | t, c :: cs =>
    match c.call n t with
    | none => none
    | some (t', _) => steps n t' cs

-- D(o) of proof.md §9: o's children newest first, each fully, then o's cleanups newest first.
-- a scope not alive: nothing (dispose returns at once)
def fold : Nat → Tree → Nat → List (Nat × Code)
  | 0, _, _ => []
  | n + 1, t, o =>
    if (t.scopes o).state = .alive then
      (t.scopes o).children.reverse.flatMap (fold n t) ++ (t.scopes o).cleanups.reverse
    else []

-- the scope record, gone and emptied
def Scope.wipe (r : Scope) : Scope := { r with children := [], cleanups := [], state := .gone }

-- code that touches no scope: done, or throw
def Code.inert : Code → Prop
  | .done => True
  | .throw _ => True
  | _ => False

-- what inert code throws
def Code.out : Code → Option Err
  | .throw e => some (.thrown e)
  | _ => none

-- m reached from o through children lists (o included)
inductive reach (t : Tree) : Nat → Nat → Prop
  | refl (o : Nat) : reach t o o
  | step {o c m : Nat} : c ∈ (t.scopes o).children → reach t c m → reach t o m

-- m under o: o is on m's parent chain (m included)
inductive under (t : Tree) (o : Nat) : Nat → Prop
  | refl : under t o o
  | step {m p : Nat} : (t.scopes m).parent = some p → under t o p → under t o m

-- a parent is older than its child
def up (t : Tree) : Prop := ∀ m p, (t.scopes m).parent = some p → p < m

/-! ## basics -/

@[simp] theorem set_scopes (t : Tree) (o : Nat) (r : Scope) (m : Nat) :
    (t.set o r).scopes m = if m = o then r else t.scopes m := rfl
@[simp] theorem set_made (t : Tree) (o : Nat) (r : Scope) : (t.set o r).made = t.made := rfl
@[simp] theorem set_regs (t : Tree) (o : Nat) (r : Scope) : (t.set o r).regs = t.regs := rfl
@[simp] theorem set_log (t : Tree) (o : Nat) (r : Scope) : (t.set o r).log = t.log := rfl
@[simp] theorem note_scopes (t : Tree) (e : Event) : (t.note e).scopes = t.scopes := rfl
@[simp] theorem note_made (t : Tree) (e : Event) : (t.note e).made = t.made := rfl
@[simp] theorem note_regs (t : Tree) (e : Event) : (t.note e).regs = t.regs := rfl
@[simp] theorem note_log (t : Tree) (e : Event) : (t.note e).log = t.log ++ [e] := rfl
@[simp] theorem set_opened (t : Tree) (o : Nat) (r : Scope) : (t.set o r).opened = t.opened := rfl
@[simp] theorem note_opened (t : Tree) (e : Event) : (t.note e).opened = t.opened := rfl

-- what was open, put back: the tree as it was
@[simp] theorem reopen (t : Tree) (l : List Bracket) : { { t with opened := l } with opened := t.opened } = t :=
  rfl

-- enter, unfolded
theorem enter_eq (b : Bracket) (t : Tree) (f : Tree → Result) :
    enter b t f = match f { t with opened := b :: t.opened } with
      | none => none
      | some (t', e) => some ({ t' with opened := t.opened }, e) := rfl

theorem enter_some {b : Bracket} {t : Tree} {f : Tree → Result} {t' : Tree} {e : Option Err}
    (h : enter b t f = some (t', e)) :
    ∃ t₁, f { t with opened := b :: t.opened } = some (t₁, e) ∧ t' = { t₁ with opened := t.opened } := by
  unfold enter at h
  split at h
  · cases h
  · rename_i t₁ e₁ h₁
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    exact ⟨t₁, h₁, rfl⟩

theorem pick_assoc (a b c : Option Err) : pick (pick a b) c = pick a (pick b c) := by
  cases a <;> cases b <;> simp [pick]

@[simp] theorem pick_none (a : Option Err) : pick a none = a := by cases a <;> rfl

theorem first_append (a b : List (Option Err)) : first (a ++ b) = pick (first a) (first b) := by
  induction a with
  | nil => rfl
  | cons x xs ih => simp [first, ih, pick_assoc]

theorem flat_congr {α β : Type} {f g : α → List β} : ∀ {l : List α}, (∀ x ∈ l, f x = g x) →
    l.flatMap f = l.flatMap g
  | [], _ => rfl
  | x :: xs, h => by
    have ih : xs.flatMap f = xs.flatMap g := flat_congr (fun y hy => h y (List.mem_cons_of_mem _ hy))
    simp only [List.flatMap_cons, h x List.mem_cons_self, ih]

theorem each_cons {α : Type} (step : Tree → α → Result) (t : Tree) (x : α) (xs : List α)
    (f : Option Err) : each step t (x :: xs) f =
      match step t x with
      | none => none
      | some (t, e) => each step t xs (pick f e) := rfl

-- sorted children: clean's kids are those made after the after-th, the rest are kept
theorem take_desc (r : List Nat) (a : Nat) (h : r.Pairwise (· > ·)) :
    r.takeWhile (· > a) = r.filter (· > a) ∧ r.dropWhile (· > a) = r.filter (fun x => !(x > a)) := by
  induction r with
  | nil => simp
  | cons x xs ih =>
    rw [List.pairwise_cons] at h
    obtain ⟨ih1, ih2⟩ := ih h.2
    by_cases hx : x > a
    · simp [hx, ih1, ih2]
    · have hall : ∀ y ∈ xs, ¬ y > a := fun y hy => by have := h.1 y hy; omega
      have h1 : xs.filter (· > a) = [] := by
        rw [List.filter_eq_nil_iff]; intro y hy; simpa using hall y hy
      have h2 : xs.filter (fun x => !(x > a)) = xs := by
        rw [List.filter_eq_self]; intro y hy; simpa using hall y hy
      simp [hx, h1, h2]

theorem later_eq (l : List Nat) (a : Nat) (h : l.Pairwise (· < ·)) :
    later l a = (l.filter (· > a)).reverse := by
  have : l.reverse.Pairwise (· > ·) := by
    rw [List.pairwise_reverse]; exact h
  simp [later, (take_desc _ a this).1, List.filter_reverse]

theorem kept_eq (l : List Nat) (a : Nat) (h : l.Pairwise (· < ·)) :
    kept l a = l.filter (fun x => !(x > a)) := by
  have : l.reverse.Pairwise (· > ·) := by
    rw [List.pairwise_reverse]; exact h
  simp only [kept, (take_desc _ a this).2, List.filter_reverse, List.reverse_reverse]

/-! ## reach and under -/

theorem under_top {t : Tree} {c o m : Nat} (h : under t c m) (hc : (t.scopes c).parent = some o) :
    under t o m := by
  induction h with
  | refl => exact .step hc .refl
  | step hp _ ih => exact .step hp ih

theorem reach_under {t : Tree} {o m : Nat} (h : reach t o m)
    (hp : ∀ m c, reach t o m → c ∈ (t.scopes m).children → (t.scopes c).parent = some m) :
    under t o m := by
  induction h with
  | refl => exact .refl
  | step hc hr ih =>
    rename_i o' c' m'
    have := ih (fun m c hm hcm => hp m c (.step hc hm) hcm)
    exact under_top this (hp _ _ (.refl _) hc)

theorem under_le {t : Tree} (hu : up t) {o m : Nat} (h : under t o m) : o ≤ m := by
  induction h with
  | refl => exact Nat.le_refl _
  | step hp _ ih => have := hu _ _ hp; omega

theorem under_line {t : Tree} {a b m : Nat} (ha : under t a m) (hb : under t b m) :
    under t a b ∨ under t b a := by
  induction ha generalizing b with
  | refl => exact .inr hb
  | step hp hap ih =>
    cases hb with
    | refl => exact .inl (.step hp hap)
    | step hp' hbp =>
      rw [hp] at hp'; cases hp'
      exact ih hbp

theorem under_up {t : Tree} {a b : Nat} (h : under t a b) (hne : b ≠ a) :
    ∃ p, (t.scopes b).parent = some p ∧ under t a p := by
  cases h with
  | refl => exact absurd rfl hne
  | step hp hu => exact ⟨_, hp, hu⟩

-- two children of one scope have nothing under both
theorem apart {t : Tree} (hu : up t) {o k₁ k₂ m : Nat} (h₁ : (t.scopes k₁).parent = some o)
    (h₂ : (t.scopes k₂).parent = some o) (hne : k₁ ≠ k₂) (hm₁ : under t k₁ m)
    (hm₂ : under t k₂ m) : False := by
  have l₁ := hu _ _ h₁
  have l₂ := hu _ _ h₂
  rcases under_line hm₁ hm₂ with h | h
  · obtain ⟨p, hp, hpu⟩ := under_up h (Ne.symm hne)
    rw [h₂] at hp; cases hp
    have := under_le hu hpu; omega
  · obtain ⟨p, hp, hpu⟩ := under_up h hne
    rw [h₁] at hp; cases hp
    have := under_le hu hpu; omega

theorem reach_cases {t : Tree} {o m : Nat} (h : reach t o m) :
    m = o ∨ ∃ c ∈ (t.scopes o).children, reach t c m := by
  cases h with
  | refl => exact .inl rfl
  | step hc hr => exact .inr ⟨_, hc, hr⟩

theorem reach_trans {t : Tree} {a b c : Nat} (h₁ : reach t a b) (h₂ : reach t b c) : reach t a c := by
  induction h₁ with
  | refl => exact h₂
  | step hc _ ih => exact .step hc (ih h₂)

-- agreeing on what is reached from k: the same is reached
theorem reach_congr {t t' : Tree} {k : Nat} (h : ∀ m, reach t k m → t'.scopes m = t.scopes m)
    (m : Nat) : reach t' k m ↔ reach t k m := by
  constructor
  · intro hr
    induction hr with
    | refl => exact .refl _
    | step hc _ ih =>
      have e := h _ (.refl _)
      rw [e] at hc
      exact .step hc (ih (fun m hm => h m (.step hc hm)))
  · intro hr
    induction hr with
    | refl => exact .refl _
    | step hc _ ih =>
      have e := h _ (.refl _)
      exact .step (by rw [e]; exact hc) (ih (fun m hm => h m (.step hc hm)))

theorem fold_congr {t t' : Tree} (n : Nat) : ∀ k, (∀ m, reach t k m → t'.scopes m = t.scopes m) →
    fold n t' k = fold n t k := by
  induction n with
  | zero => intro _ _; rfl
  | succ n ih =>
    intro k h
    have e := h _ (.refl _)
    simp only [fold, e]
    congr 2
    apply flat_congr
    intro c hc
    rw [List.mem_reverse] at hc
    exact ih c (fun m hm => h m (.step hc hm))

/-! ## (a): cleanups that touch nothing -/

-- what (a) needs of the scopes reached from o: alive, each child's parent is it, children in
-- the order made, cleanups inert
structure tidy (t : Tree) (o : Nat) : Prop where
  alive : ∀ m, reach t o m → (t.scopes m).state = .alive
  par : ∀ m c, reach t o m → c ∈ (t.scopes m).children → (t.scopes c).parent = some m
  sorted : ∀ m, reach t o m → (t.scopes m).children.Pairwise (· < ·)
  inert : ∀ m, reach t o m → ∀ x ∈ (t.scopes m).cleanups, x.2.inert

theorem tidy_congr {t t' : Tree} {k : Nat} (h : tidy t k)
    (e : ∀ m, reach t k m → t'.scopes m = t.scopes m) : tidy t' k := by
  have r := reach_congr e
  constructor
  · intro m hm; rw [r] at hm; rw [e m hm]; exact h.alive m hm
  · intro m c hm hc
    rw [r] at hm; rw [e m hm] at hc
    rw [e c (reach_trans hm (.step hc (.refl _)))]
    exact h.par m c hm hc
  · intro m hm; rw [r] at hm; rw [e m hm]; exact h.sorted m hm
  · intro m hm; rw [r] at hm; rw [e m hm]; exact h.inert m hm

theorem tidy_sub {t : Tree} {o c : Nat} (h : tidy t o) (hr : reach t o c) : tidy t c :=
  ⟨fun m hm => h.alive m (reach_trans hr hm), fun m c hm => h.par m c (reach_trans hr hm),
    fun m hm => h.sorted m (reach_trans hr hm), fun m hm => h.inert m (reach_trans hr hm)⟩

-- dispose(o) took t to t' following D: it ran D's cleanups, in order, and nothing else; its
-- error is D's first; what was reached is wiped, o is out of its parent's children, the rest is
-- as it was
structure follows (D : List (Nat × Code)) (t : Tree) (o : Nat) (t' : Tree) (e : Option Err) : Prop where
  log : t'.log = t.log ++ D.map (fun x => Event.run x.1)
  error : e = first (D.map (fun x => x.2.out))
  wiped : ∀ m, reach t o m → t'.scopes m = (t.scopes m).wipe
  rest : ∀ m, ¬ reach t o m → (t.scopes o).parent ≠ some m → t'.scopes m = t.scopes m
  parent : ∀ p, (t.scopes o).parent = some p →
    t'.scopes p = { t.scopes p with children := ((t.scopes p).children.reverse.erase o).reverse }
  made : t'.made = t.made
  regs : t'.regs = t.regs

theorem exec_inert (d : Tree → Nat → Result) (t : Tree) (c : Code) (h : c.inert) :
    exec d t c = some (t, c.out) := by
  cases c <;> simp_all [Code.inert, exec, Code.out]

theorem call_inert (d : Tree → Nat → Result) (o : Nat) (t : Tree) (x : Nat × Code) (h : x.2.inert) :
    call d o t x = some (t.note (.run x.1), x.2.out) := by
  simp only [call, enter, exec_inert d _ _ h]


theorem calls_inert (d : Tree → Nat → Result) (o : Nat) : ∀ (cs : List (Nat × Code)) (t : Tree)
    (f : Option Err), (∀ x ∈ cs, x.2.inert) →
    each (call d o) t cs f = some ({ t with log := t.log ++ cs.map (fun x => Event.run x.1) },
      pick f (first (cs.map (fun x => x.2.out))))
  | [], t, f, _ => by simp [each, first]
  | x :: xs, t, f, h => by
    rw [each_cons]
    simp only [call_inert d o _ _ (h x List.mem_cons_self)]
    rw [calls_inert d o xs _ _ (fun y hy => h y (List.mem_cons_of_mem _ hy))]
    simp [Tree.note, first, pick_assoc]

theorem erase_out {o : Nat} {l : List Nat} (h : o ∉ l) : (l.reverse.erase o).reverse = l := by
  rw [List.erase_of_not_mem (by simpa using h)]; simp

theorem follows_parent {D : List (Nat × Code)} {t t' : Tree} {o : Nat} {e : Option Err} (h : follows D t o t' e)
    (m : Nat) :
    (t'.scopes m).parent = (t.scopes m).parent := by
  by_cases hr : reach t o m
  · rw [h.wiped m hr]; rfl
  · by_cases hp : (t.scopes o).parent = some m
    · rw [h.parent m hp]
    · rw [h.rest m hr hp]

-- (a) at fuel n
def spec_inert (n : Nat) : Prop :=
  ∀ t o t' e, up t → tidy t o → dispose n t o = some (t', e) → follows (fold n t o) t o t' e

-- clean's first loop, (a)'s way: kids of o, each disposed fully, one after the other
theorem kids_inert {n : Nat} (hA : spec_inert n) (o : Nat) : ∀ (ks : List Nat) (t : Tree) (f : Option Err)
    (t' : Tree) (e : Option Err),
    up t → (∀ k ∈ ks, tidy t k) → (∀ k ∈ ks, (t.scopes k).parent = some o) →
    (∀ k ∈ ks, k ∉ (t.scopes o).children) → ks.Nodup →
    each (dispose n) t ks f = some (t', e) →
    t'.log = t.log ++ (ks.flatMap (fold n t)).map (fun x => Event.run x.1) ∧
    e = pick f (first ((ks.flatMap (fold n t)).map (fun x => x.2.out))) ∧
    (∀ m, ∀ k ∈ ks, reach t k m → t'.scopes m = (t.scopes m).wipe) ∧
    (∀ m, (∀ k ∈ ks, ¬ reach t k m) → t'.scopes m = t.scopes m) ∧
    t'.made = t.made ∧ t'.regs = t.regs
  | [], t, f, t', e, _, _, _, _, _, h => by
    simp [each] at h; obtain ⟨rfl, rfl⟩ := h; simp [first]
  | k :: ks, t, f, t', e, hu, ht, hp, hc, hn, h => by
    rw [each_cons] at h
    rcases hd : dispose n t k with _ | ⟨t₁, e₁⟩
    · simp [hd] at h
    simp only [hd] at h
    have R := hA t k t₁ e₁ hu (ht k List.mem_cons_self) hd
    have hk := hp k List.mem_cons_self
    have hok := hu _ _ hk
    rw [List.nodup_cons] at hn
    -- what is reached from another kid is not reached from k, and is not o
    have away : ∀ k' ∈ ks, ∀ m, reach t k' m → ¬ reach t k m ∧ m ≠ o := by
      intro k' hk' m hm
      have hk'o := hp k' (List.mem_cons_of_mem _ hk')
      have u' := reach_under hm (fun m c hm hc => (ht k' (List.mem_cons_of_mem _ hk')).par m c hm hc)
      refine ⟨fun hm' => ?_, ?_⟩
      · have u := reach_under hm' (fun m c hm hc => (ht k List.mem_cons_self).par m c hm hc)
        exact apart hu hk hk'o (fun e => hn.1 (e ▸ hk')) u u'
      · have := under_le hu u'; have := hu _ _ hk'o; omega
    have same : ∀ k' ∈ ks, ∀ m, reach t k' m → t₁.scopes m = t.scopes m := by
      intro k' hk' m hm
      obtain ⟨h1, h2⟩ := away k' hk' m hm
      exact R.rest m h1 (by rw [hk]; intro e; cases e; exact h2 rfl)
    have ho : t₁.scopes o = t.scopes o := by
      rw [R.parent o hk, erase_out (hc k List.mem_cons_self)]
    have hu₁ : up t₁ := fun m p hm => hu m p (by rw [← follows_parent R m]; exact hm)
    obtain ⟨l, er, w, r, hm, hr⟩ := kids_inert hA o ks t₁ (pick f e₁) t' e hu₁
      (fun k' hk' => tidy_congr (ht k' (List.mem_cons_of_mem _ hk')) (same k' hk'))
      (fun k' hk' => by
        rw [same k' hk' k' (.refl _)]; exact hp k' (List.mem_cons_of_mem _ hk'))
      (fun k' hk' => by rw [ho]; exact hc k' (List.mem_cons_of_mem _ hk'))
      hn.2 h
    have fl : ks.flatMap (fold n t₁) = ks.flatMap (fold n t) :=
      flat_congr (fun k' hk' => fold_congr n k' (same k' hk'))
    have rc : ∀ k' ∈ ks, ∀ m, reach t₁ k' m ↔ reach t k' m :=
      fun k' hk' m => reach_congr (same k' hk') m
    rw [fl] at l er
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
    · rw [l, R.log]; simp [List.flatMap_cons]
    · rw [er, R.error]; simp [List.flatMap_cons, first_append, pick_assoc]
    · intro m k' hk' hm
      rcases List.mem_cons.mp hk' with rfl | hk'
      · rw [r m (fun k'' hk'' hm'' => ((away k'' hk'' m ((rc k'' hk'' m).mp hm'')).1 hm)), R.wiped m hm]
      · rw [w m k' hk' ((rc k' hk' m).mpr hm), same k' hk' m hm]
    · intro m hm
      rw [r m (fun k' hk' hm' => hm k' (List.mem_cons_of_mem _ hk') ((rc k' hk' m).mp hm'))]
      by_cases hmo : m = o
      · subst hmo; exact ho
      · exact R.rest m (hm k List.mem_cons_self) (by rw [hk]; intro e; cases e; exact hmo rfl)
    · rw [hm, R.made]
    · rw [hr, R.regs]

-- the same for kids: the loop in o's bracket, what is open no part of what it does to the tree
theorem opened_inert {n : Nat} (hA : spec_inert n) (o : Nat) (ks : List Nat) (t t' : Tree)
    (e : Option Err) (hu : up t) (ht : ∀ k ∈ ks, tidy t k)
    (hp : ∀ k ∈ ks, (t.scopes k).parent = some o) (hc : ∀ k ∈ ks, k ∉ (t.scopes o).children)
    (hn : ks.Nodup) (h : kids (dispose n) o t ks = some (t', e)) :
    t'.log = t.log ++ (ks.flatMap (fold n t)).map (fun x => Event.run x.1) ∧
    e = pick none (first ((ks.flatMap (fold n t)).map (fun x => x.2.out))) ∧
    (∀ m, ∀ k ∈ ks, reach t k m → t'.scopes m = (t.scopes m).wipe) ∧
    (∀ m, (∀ k ∈ ks, ¬ reach t k m) → t'.scopes m = t.scopes m) ∧
    t'.made = t.made ∧ t'.regs = t.regs := by
  obtain ⟨t₁, h₁, rfl⟩ := enter_some h
  have rc : ∀ k m, reach { t with opened := opens t o :: t.opened } k m ↔ reach t k m :=
    fun k m => reach_congr (t := t) (t' := { t with opened := opens t o :: t.opened }) (k := k)
      (fun _ _ => rfl) m
  have fl : ks.flatMap (fold n { t with opened := opens t o :: t.opened }) = ks.flatMap (fold n t) :=
    flat_congr (fun k _ => fold_congr n k (fun _ _ => rfl))
  obtain ⟨l, er, w, r, hm, hr⟩ := kids_inert hA o ks { t with opened := opens t o :: t.opened } none
    t₁ e hu (fun k hk => tidy_congr (ht k hk) (fun _ _ => rfl)) hp hc hn h₁
  rw [fl] at l er
  exact ⟨l, er, fun m k hk hm' => w m k hk ((rc k m).mpr hm'),
    fun m hm' => r m (fun k hk h' => hm' k hk ((rc k m).mp h')), hm, hr⟩

theorem dispose_inert : ∀ n, spec_inert n
  | 0 => by intro t o t' e _ _ h; simp [dispose] at h
  | n + 1 => by
    intro t o t' e hu ht h
    have ih := dispose_inert n
    have ha := ht.alive o (.refl _)
    have hs := ht.sorted o (.refl _)
    -- the children: younger than o, so all past the 0th
    have hco : ∀ c ∈ (t.scopes o).children, (t.scopes c).parent = some o ∧ o < c := fun c hc =>
      ⟨ht.par o c (.refl _) hc, hu _ _ (ht.par o c (.refl _) hc)⟩
    have hkept : kept (t.scopes o).children 0 = [] := by
      rw [kept_eq _ _ hs, List.filter_eq_nil_iff]
      intro c hc; have := (hco c hc).2; simp; omega
    have hlater : later (t.scopes o).children 0 = (t.scopes o).children.reverse := by
      rw [later_eq _ _ hs, List.filter_eq_self.mpr]
      intro c hc; have := (hco c hc).2; simp; omega
    unfold dispose at h
    simp only [ha, ne_eq, not_true_eq_false, ↓reduceIte] at h
    split at h
    · simp at h
    rename_i t₄ e₄ h₄
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    unfold clean at h₄
    split at h₄
    · simp at h₄
    rename_i t₃ f₃ h₃
    -- t₂: o disposing, its children taken
    let t₂ := (t.set o { t.scopes o with state := .disposing }).set o
      { t.scopes o with state := .disposing, children := [] }
    have h₃' : kids (dispose n) o t₂ (t.scopes o).children.reverse = some (t₃, f₃) := by
      simpa [t₂, hkept, hlater] using h₃
    have e₂ : ∀ m, m ≠ o → t₂.scopes m = t.scopes m := fun m hm => by simp [t₂, hm]
    have far : ∀ c ∈ (t.scopes o).children, ∀ m, reach t c m → m ≠ o ∧ o < m := by
      intro c hc m hm
      have u := reach_under hm (fun m' c' hm' hc' => ht.par m' c' (.step hc hm') hc')
      have := under_le hu u; have := (hco c hc).2; omega
    have same₂ : ∀ c ∈ (t.scopes o).children, ∀ m, reach t c m → t₂.scopes m = t.scopes m :=
      fun c hc m hm => e₂ m (far c hc m hm).1
    have hu₂ : up t₂ := by
      intro m p hm; by_cases hmo : m = o
      · subst hmo; simp [t₂] at hm; exact hu _ _ hm
      · rw [e₂ m hmo] at hm; exact hu _ _ hm
    have K := opened_inert ih o (t.scopes o).children.reverse t₂ t₃ f₃ hu₂
      (fun c hc => by
        rw [List.mem_reverse] at hc
        exact tidy_congr (tidy_sub ht (.step hc (.refl _))) (same₂ c hc))
      (fun c hc => by
        rw [List.mem_reverse] at hc
        rw [e₂ c (by have := (hco c hc).2; omega)]; exact (hco c hc).1)
      (fun c _ => by simp [t₂])
      (List.nodup_iff_pairwise_ne.mpr (List.pairwise_reverse.mpr (hs.imp (fun h => by omega))))
      h₃'
    obtain ⟨Kl, Ke, Kw, Kr, Km, Kg⟩ := K
    have fl : (t.scopes o).children.reverse.flatMap (fold n t₂) =
        (t.scopes o).children.reverse.flatMap (fold n t) :=
      flat_congr (fun c hc => fold_congr n c (same₂ c (List.mem_reverse.mp hc)))
    rw [fl] at Kl Ke
    have rc : ∀ c ∈ (t.scopes o).children.reverse, ∀ m, reach t₂ c m ↔ reach t c m :=
      fun c hc m => reach_congr (same₂ c (List.mem_reverse.mp hc)) m
    have hrest : ∀ m, (∀ c ∈ (t.scopes o).children, ¬ reach t c m) → t₃.scopes m = t₂.scopes m :=
      fun m hm => Kr m (fun c hc hr => hm c (List.mem_reverse.mp hc) ((rc c hc m).mp hr))
    have ho₃ : t₃.scopes o = { t.scopes o with state := .disposing, children := [] } := by
      rw [hrest o (fun c hc hr => (far c hc o hr).1 rfl)]; simp [t₂]
    simp only [ho₃, List.drop_zero, List.take_zero] at h₄
    rw [calls_inert _ _ _ _ _ (fun x hx => ht.inert o (.refl _) x (List.mem_reverse.mp hx))] at h₄
    simp only [Option.some.injEq, Prod.mk.injEq] at h₄
    obtain ⟨rfl, rfl⟩ := h₄
    have hfold : fold (n + 1) t o = (t.scopes o).children.reverse.flatMap (fold n t) ++
        (t.scopes o).cleanups.reverse := by simp [fold, ha]
    -- the parent: older than o, so reached from none of its children
    have hpo : ∀ p, (t.scopes o).parent = some p → p < o := fun p hp => hu _ _ hp
    constructor
    · simp only [unlink, set_scopes]
      split <;> simp [Kl, hfold, t₂]
    · rw [hfold, Ke]; simp [first_append, pick]
    · intro m hm
      rcases reach_cases hm with rfl | ⟨c, hc, hr⟩
      · simp only [unlink, set_scopes]
        split
        · simp [Scope.wipe]
        · rename_i p hp
          have := hpo p hp
          simp [show m ≠ p by omega, Scope.wipe]
      · have ⟨hmo, hlt⟩ := far c hc m hr
        have hw := Kw m c (List.mem_reverse.mpr hc) ((rc c (List.mem_reverse.mpr hc) m).mpr hr)
        rw [e₂ m hmo] at hw
        simp only [unlink, set_scopes]
        split
        · simp [hmo, hw]
        · rename_i p hp
          have := hpo p hp
          simp [show m ≠ p by omega, hmo, hw]
    · intro m hm hmp
      have hmo : m ≠ o := fun e => hm (e ▸ .refl _)
      have h3 := hrest m (fun c hc hr => hm (.step hc hr))
      rw [e₂ m hmo] at h3
      simp only [unlink, set_scopes]
      split
      · simp [hmo, h3]
      · rename_i p hp
        simp [show m ≠ p from fun e => hmp (e ▸ hp), hmo, h3]
    · intro p hp
      have hpo' := hpo p hp
      have h3 := hrest p (fun c hc hr => by have := (far c hc p hr).2; omega)
      rw [e₂ p (by omega)] at h3
      simp only [unlink, set_scopes]
      simp [hp, h3, show p ≠ o by omega]
    · simp [unlink]; split <;> simp [Km, t₂]
    · simp [unlink]; split <;> simp [Kg, t₂]

/-! ## clean(o, after, from), cleanups that touch nothing -/

-- what clean(o, after, from) does when its cleanups touch nothing: the children made after the
-- after-th go, newest first, each fully, then the cleanups from the from-th on, newest first;
-- the first error; o keeps the rest, and stays
theorem clean_inert (n : Nat) (t : Tree) (o after start : Nat) (t' : Tree) (e : Option Err)
    (hu : up t) (ht : tidy t o) (h : clean (dispose n) t o after start = some (t', e)) :
    let gone := ((t.scopes o).children.filter (· > after)).reverse.flatMap (fold n t) ++
      ((t.scopes o).cleanups.drop start).reverse
    t'.log = t.log ++ gone.map (fun x => Event.run x.1) ∧
    e = first (gone.map (fun x => x.2.out)) ∧
    t'.scopes o = { t.scopes o with
      children := (t.scopes o).children.filter (fun c => !(c > after)),
      cleanups := (t.scopes o).cleanups.take start } ∧
    (∀ m, ∀ c ∈ (t.scopes o).children, c > after → reach t c m → t'.scopes m = (t.scopes m).wipe) ∧
    (∀ m, m ≠ o → (∀ c ∈ (t.scopes o).children, c > after → ¬ reach t c m) →
      t'.scopes m = t.scopes m) ∧
    t'.made = t.made ∧ t'.regs = t.regs := by
  intro gone
  have hs := ht.sorted o (.refl _)
  have hco : ∀ c ∈ (t.scopes o).children, (t.scopes c).parent = some o ∧ o < c := fun c hc =>
    ⟨ht.par o c (.refl _) hc, hu _ _ (ht.par o c (.refl _) hc)⟩
  unfold clean at h
  split at h
  · simp at h
  rename_i t₃ f₃ h₃
  rw [later_eq _ _ hs, kept_eq _ _ hs] at h₃
  let ks := ((t.scopes o).children.filter (· > after)).reverse
  have hks : ∀ c ∈ ks, c ∈ (t.scopes o).children ∧ c > after := by
    intro c hc; simpa [ks] using hc
  let t₂ := t.set o { t.scopes o with children := (t.scopes o).children.filter (fun c => !(c > after)) }
  have e₂ : ∀ m, m ≠ o → t₂.scopes m = t.scopes m := fun m hm => by simp [t₂, hm]
  have far : ∀ c ∈ (t.scopes o).children, ∀ m, reach t c m → m ≠ o ∧ o < m := by
    intro c hc m hm
    have u := reach_under hm (fun m' c' hm' hc' => ht.par m' c' (.step hc hm') hc')
    have := under_le hu u; have := (hco c hc).2; omega
  have same₂ : ∀ c ∈ (t.scopes o).children, ∀ m, reach t c m → t₂.scopes m = t.scopes m :=
    fun c hc m hm => e₂ m (far c hc m hm).1
  have hu₂ : up t₂ := by
    intro m p hm; by_cases hmo : m = o
    · subst hmo; simp [t₂] at hm; exact hu _ _ hm
    · rw [e₂ m hmo] at hm; exact hu _ _ hm
  have K := opened_inert (dispose_inert n) o ks t₂ t₃ f₃ hu₂
    (fun c hc => tidy_congr (tidy_sub ht (.step (hks c hc).1 (.refl _))) (same₂ c (hks c hc).1))
    (fun c hc => by
      rw [e₂ c (by have := (hco c (hks c hc).1).2; omega)]; exact (hco c (hks c hc).1).1)
    (fun c hc => by simp [t₂, (hks c hc).2])
    (List.nodup_iff_pairwise_ne.mpr (List.pairwise_reverse.mpr
      ((hs.sublist List.filter_sublist).imp (fun h => by omega))))
    (by simpa [t₂, ks] using h₃)
  obtain ⟨Kl, Ke, Kw, Kr, Km, Kg⟩ := K
  have fl : ks.flatMap (fold n t₂) = ks.flatMap (fold n t) :=
    flat_congr (fun c hc => fold_congr n c (same₂ c (hks c hc).1))
  rw [fl] at Kl Ke
  have rc : ∀ c ∈ ks, ∀ m, reach t₂ c m ↔ reach t c m :=
    fun c hc m => reach_congr (same₂ c (hks c hc).1) m
  have hrest : ∀ m, (∀ c ∈ ks, ¬ reach t c m) → t₃.scopes m = t₂.scopes m :=
    fun m hm => Kr m (fun c hc hr => hm c hc ((rc c hc m).mp hr))
  have ho₃ : t₃.scopes o = { t.scopes o with
      children := (t.scopes o).children.filter (fun c => !(c > after)) } := by
    rw [hrest o (fun c hc hr => (far c (hks c hc).1 o hr).1 rfl)]; simp [t₂]
  simp only [ho₃] at h
  rw [calls_inert _ _ _ _ _ (fun x hx => ht.inert o (.refl _) x
    (List.mem_of_mem_drop (List.mem_reverse.mp hx)))] at h
  simp only [Option.some.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · simp [Kl, t₂, gone, ks]
  · simp [Ke, gone, ks, first_append, pick]
  · simp
  · intro m c hc hgt hr
    have ⟨hmo, _⟩ := far c hc m hr
    have hck : c ∈ ks := by simp [ks, hc, hgt]
    have hw := Kw m c hck ((rc c hck m).mpr hr)
    rw [e₂ m hmo] at hw
    simp [hmo, hw]
  · intro m hmo hm
    have h3 := hrest m (fun c hc => hm c (hks c hc).1 (hks c hc).2)
    rw [e₂ m hmo] at h3
    simp [hmo, h3]
  · simp [Km, t₂]
  · simp [Kg, t₂]

/-! ## the invariant, at any point of a run -/

-- what is going on further down the stack: a dispose(x) under way (x disposing), or a clean of
-- p in its first loop, with the kids it has still to dispose
inductive Frame where
  | disp (x : Nat)
  | kids (p : Nat) (ks : List Nat)

-- the scope a frame is of
def Frame.at : Frame → Nat
  | .disp x => x
  | .kids p _ => p

-- what holds of the scopes whenever code runs, given the frames below it (ctx). at the top
-- (ctx = []): no scope is disposing, every alive scope is in its parent's children
structure Inv (t : Tree) (ctx : List Frame) : Prop where
  -- a scope not made yet is the empty record
  fresh : ∀ m, t.made < m → t.scopes m = {}
  older : up t
  par : ∀ p c, c ∈ (t.scopes p).children → (t.scopes c).parent = some p
  sorted : ∀ p, (t.scopes p).children.Pairwise (· < ·)
  -- an alive scope is in its parent's children, or is a kid a clean of its parent has still
  -- to dispose
  linked : ∀ c p, (t.scopes c).state = .alive → (t.scopes c).parent = some p →
    c ∈ (t.scopes p).children ∨ ∃ ks, Frame.kids p ks ∈ ctx ∧ c ∈ ks
  framed : ∀ c, (t.scopes c).state = .disposing → Frame.disp c ∈ ctx
  gone : ∀ c, (t.scopes c).state = .gone →
    (t.scopes c).children = [] ∧ (t.scopes c).cleanups = []
  listed : ∀ p c, c ∈ (t.scopes p).children → (t.scopes c).state ≠ .gone

-- what a call never undoes: counters and the log only grow, parents stay, a scope not alive
-- stays as it is, but for children taken out
structure Mono (t t' : Tree) : Prop where
  made : t.made ≤ t'.made
  regs : t.regs ≤ t'.regs
  log : ∃ l, t'.log = t.log ++ l
  parent : ∀ m, m ≤ t.made → (t'.scopes m).parent = (t.scopes m).parent
  still : ∀ m, m ≤ t.made → (t.scopes m).state ≠ .alive →
    (t'.scopes m).state = (t.scopes m).state ∧ (t'.scopes m).cleanups = (t.scopes m).cleanups ∧
    (t'.scopes m).children.Sublist (t.scopes m).children

theorem Mono.refl (t : Tree) : Mono t t :=
  ⟨Nat.le_refl _, Nat.le_refl _, ⟨[], by simp⟩, fun _ _ => rfl,
    fun _ _ _ => ⟨rfl, rfl, List.Sublist.refl _⟩⟩

theorem Mono.trans {t₁ t₂ t₃ : Tree} (a : Mono t₁ t₂) (b : Mono t₂ t₃) : Mono t₁ t₃ := by
  obtain ⟨l₁, h₁⟩ := a.log
  obtain ⟨l₂, h₂⟩ := b.log
  refine ⟨Nat.le_trans a.made b.made, Nat.le_trans a.regs b.regs, ⟨l₁ ++ l₂, by simp [h₁, h₂]⟩,
    fun m hm => by rw [b.parent m (Nat.le_trans hm a.made), a.parent m hm], fun m hm hs => ?_⟩
  obtain ⟨s₁, c₁, k₁⟩ := a.still m hm hs
  obtain ⟨s₂, c₂, k₂⟩ := b.still m (Nat.le_trans hm a.made) (by rw [s₁]; exact hs)
  exact ⟨s₂.trans s₁, c₂.trans c₁, k₂.trans k₁⟩

theorem Inv.alive_made {t : Tree} {ctx : List Frame} (h : Inv t ctx) {m : Nat}
    (hm : (t.scopes m).state ≠ .gone) : m ≤ t.made := by
  by_cases hlt : t.made < m
  · rw [h.fresh m hlt] at hm; exact absurd rfl hm
  · omega

theorem Inv.child_made {t : Tree} {ctx : List Frame} (h : Inv t ctx) {p c : Nat}
    (hc : c ∈ (t.scopes p).children) : c ≤ t.made := by
  by_cases hlt : t.made < c
  · have := h.par p c hc; rw [h.fresh c hlt] at this; simp at this
  · omega

-- a kid gone from the first loop's list once it is not alive
theorem Inv.pop {t : Tree} {ctx : List Frame} {p k : Nat} {ks : List Nat}
    (h : Inv t (.kids p (k :: ks) :: ctx)) (hk : (t.scopes k).state ≠ .alive) :
    Inv t (.kids p ks :: ctx) := by
  refine ⟨h.fresh, h.older, h.par, h.sorted, fun c q ha hq => ?_, fun c hc => ?_, h.gone, h.listed⟩
  · rcases h.linked c q ha hq with h' | ⟨ks', hk', hc⟩
    · exact .inl h'
    · rcases List.mem_cons.mp hk' with e | e
      · cases e
        rcases List.mem_cons.mp hc with rfl | hc
        · exact absurd ha hk
        · exact .inr ⟨ks, List.mem_cons_self, hc⟩
      · exact .inr ⟨ks', List.mem_cons_of_mem _ e, hc⟩
  · rcases List.mem_cons.mp (h.framed c hc) with e | e
    · cases e
    · exact List.mem_cons_of_mem _ e

theorem Inv.drop {t : Tree} {ctx : List Frame} {p : Nat} (h : Inv t (.kids p [] :: ctx)) :
    Inv t ctx := by
  refine ⟨h.fresh, h.older, h.par, h.sorted, fun c q ha hq => ?_, fun c hc => ?_, h.gone, h.listed⟩
  · rcases h.linked c q ha hq with h' | ⟨ks', hk', hc⟩
    · exact .inl h'
    · rcases List.mem_cons.mp hk' with e | e
      · cases e; simp at hc
      · exact .inr ⟨ks', e, hc⟩
  · rcases List.mem_cons.mp (h.framed c hc) with e | e
    · cases e
    · exact e

/-! ### lists -/

theorem kept_sub (l : List Nat) (a : Nat) : (kept l a).Sublist l := by
  have := (List.dropWhile_sublist (l := l.reverse) (· > a)).reverse
  simpa [kept] using this

theorem mem_split {l : List Nat} {a x : Nat} (h : x ∈ l) : x ∈ kept l a ∨ x ∈ later l a := by
  have e := List.takeWhile_append_dropWhile (p := (· > a)) (l := l.reverse)
  have : x ∈ l.reverse := by simpa using h
  rw [← e, List.mem_append] at this
  rcases this with h' | h'
  · exact .inr h'
  · exact .inl (by simpa [kept] using h')

theorem nodup_of_sorted {l : List Nat} (h : l.Pairwise (· < ·)) : l.Nodup :=
  List.nodup_iff_pairwise_ne.mpr (h.imp (fun h => by omega))

-- unlink's list
theorem out_sub (l : List Nat) (x : Nat) : ((l.reverse.erase x).reverse).Sublist l := by
  have := (List.erase_sublist (a := x) (l := l.reverse)).reverse
  simpa using this

theorem out_mem {l : List Nat} {x c : Nat} (h : c ∈ l) (hne : c ≠ x) : c ∈ (l.reverse.erase x).reverse := by
  rw [List.mem_reverse, List.mem_erase_of_ne hne, List.mem_reverse]; exact h

theorem out_not {l : List Nat} (x : Nat) (h : l.Nodup) : x ∉ (l.reverse.erase x).reverse := by
  rw [List.mem_reverse]
  exact List.Nodup.not_mem_erase (List.nodup_iff_pairwise_ne.mpr
    (List.pairwise_reverse.mpr ((List.nodup_iff_pairwise_ne.mp h).imp (fun h => Ne.symm h))))

/-! ### steps -/

-- a set that keeps parent, and keeps a scope not alive as it is but for children taken out
theorem mono_set (t : Tree) (o : Nat) (r : Scope) (hp : r.parent = (t.scopes o).parent)
    (hs : (t.scopes o).state ≠ .alive → r.state = (t.scopes o).state ∧
      r.cleanups = (t.scopes o).cleanups ∧ r.children.Sublist (t.scopes o).children) :
    Mono t (t.set o r) := by
  refine ⟨Nat.le_refl _, Nat.le_refl _, ⟨[], by simp⟩, fun m _ => ?_, fun m _ hm => ?_⟩
  · by_cases e : m = o
    · subst e; simp [hp]
    · simp [e]
  · by_cases e : m = o
    · subst e; simp [hs hm]
    · simp [e]

-- a set of a scope alive at the start (its parent kept): still Mono from the start
theorem Mono.set_alive {t t' : Tree} (h : Mono t t') (x : Nat) (r : Scope)
    (hp : r.parent = (t'.scopes x).parent) (ha : (t.scopes x).state = .alive) :
    Mono t (t'.set x r) := by
  refine ⟨h.made, h.regs, h.log, fun m hm => ?_, fun m hm hs => ?_⟩
  · by_cases e : m = x
    · subst e; simp [hp, h.parent m hm]
    · simp [e, h.parent m hm]
  · have e : m ≠ x := fun e => hs (e ▸ ha)
    simp [e, h.still m hm hs]

-- one scope's record changed: what Inv asks of the change
theorem inv_set {t : Tree} {ctx ctx' : List Frame} {o : Nat} {r : Scope} (h : Inv t ctx)
    (hctx : ∀ f ∈ ctx, f ∈ ctx' ∨ f = .disp o) (ho : o ≤ t.made)
    (hp : r.parent = (t.scopes o).parent) (hch : r.children.Sublist (t.scopes o).children)
    -- an alive child taken out is a kid a clean has still to dispose
    (hlink : ∀ c, (t.scopes c).state = .alive → (t.scopes c).parent = some o → c ≠ o →
      c ∈ (t.scopes o).children → c ∉ r.children → ∃ ks, Frame.kids o ks ∈ ctx' ∧ c ∈ ks)
    (halive : r.state = .alive → (t.scopes o).state = .alive)
    (hdisp : r.state = .disposing → Frame.disp o ∈ ctx')
    (hgone : r.state = .gone → r.children = [] ∧ r.cleanups = [])
    (hlisted : r.state = .gone → ∀ p, o ∉ (t.scopes p).children) :
    Inv (t.set o r) ctx' := by
  -- frames of ctx other than o's dispose are in ctx'
  have keep : ∀ f ∈ ctx, f ≠ .disp o → f ∈ ctx' := fun f hf hne =>
    (hctx f hf).resolve_right hne
  have hpar : ∀ m, ((t.set o r).scopes m).parent = (t.scopes m).parent := by
    intro m; by_cases e : m = o
    · subst e; simp [hp]
    · simp [e]
  refine ⟨fun m hm => ?_, fun m p hm => ?_, fun p c hc => ?_, fun p => ?_, fun c p hc hpc => ?_,
    fun c hc => ?_, fun c hc => ?_, fun p c hc => ?_⟩
  · simp only [set_made] at hm
    simp [show m ≠ o by omega, h.fresh m hm]
  · rw [hpar] at hm; exact h.older _ _ hm
  · have hc' : c ∈ (t.scopes p).children := by
      by_cases e : p = o
      · subst e; simp at hc; exact hch.mem hc
      · simpa [e] using hc
    rw [hpar]; exact h.par p c hc'
  · by_cases e : p = o
    · subst e; simp; exact (h.sorted p).sublist hch
    · simp [e, h.sorted]
  · rw [hpar] at hpc
    by_cases e : c = o
    · subst e
      simp at hc
      have hc' := halive hc
      rcases h.linked c p hc' hpc with h' | ⟨ks, hk, hck⟩
      · have : p ≠ c := by have := h.older _ _ hpc; omega
        exact .inl (by simpa [this] using h')
      · exact .inr ⟨ks, keep _ hk (by simp), hck⟩
    · simp [e] at hc
      rcases h.linked c p hc hpc with h' | ⟨ks, hk, hck⟩
      · by_cases e' : p = o
        · subst e'
          by_cases hr : c ∈ r.children
          · exact .inl (by simpa using hr)
          · exact .inr (hlink c hc hpc e h' hr)
        · exact .inl (by simpa [e'] using h')
      · exact .inr ⟨ks, keep _ hk (by simp), hck⟩
  · by_cases e : c = o
    · subst e; simp at hc; exact hdisp hc
    · simp [e] at hc
      exact keep _ (h.framed c hc) (by intro h'; cases h'; exact e rfl)
  · by_cases e : c = o
    · subst e; simp at hc ⊢; exact hgone hc
    · simp [e] at hc ⊢; exact h.gone c hc
  · have hc' : c ∈ (t.scopes p).children := by
      by_cases e : p = o
      · subst e; simp at hc; exact hch.mem hc
      · simpa [e] using hc
    by_cases e : c = o
    · subst e; simp
      intro hg; exact hlisted hg p hc'
    · simp [e]; exact h.listed p c hc'

theorem inv_disposing {t : Tree} {ctx : List Frame} {x : Nat} (h : Inv t ctx)
    (ha : (t.scopes x).state = .alive) :
    Inv (t.set x { t.scopes x with state := .disposing }) (.disp x :: ctx) :=
  inv_set h (fun f hf => .inl (List.mem_cons_of_mem _ hf)) (h.alive_made (by rw [ha]; simp)) rfl
    (List.Sublist.refl _) (fun _ _ _ _ h' h'' => absurd h' h'') (by simp) (by simp) (by simp)
    (by simp)

-- clean's first step: the kids taken out of o's children, into the first loop's frame
theorem inv_cut {t : Tree} {ctx : List Frame} {o : Nat} (a : Nat) (h : Inv t ctx)
    (ho : (t.scopes o).state ≠ .gone) :
    Inv (t.set o { t.scopes o with children := kept (t.scopes o).children a })
      (.kids o (later (t.scopes o).children a) :: ctx) :=
  inv_set h (fun _ hf => .inl (List.mem_cons_of_mem _ hf)) (h.alive_made ho) rfl (kept_sub _ _)
    (fun _ _ _ _ h' h'' => ⟨_, List.mem_cons_self, (mem_split h').resolve_left h''⟩)
    (fun e => e) (fun e => List.mem_cons_of_mem _ (h.framed o e)) (fun e => absurd e ho)
    (fun e => absurd e ho)

-- a scope's cleanups changed, it not gone
theorem inv_cleanups {t : Tree} {ctx : List Frame} {o : Nat} (l : List (Nat × Code))
    (h : Inv t ctx) (ho : (t.scopes o).state ≠ .gone) :
    Inv (t.set o { t.scopes o with cleanups := l }) ctx :=
  inv_set h (fun _ hf => .inl hf) (h.alive_made ho) rfl (List.Sublist.refl _)
    (fun _ _ _ _ h' h'' => absurd h' h'') (fun e => e) (fun e => h.framed o e)
    (fun e => absurd e ho) (fun e => absurd e ho)

theorem unlink_set (t : Tree) (x : Nat) (r : Scope) (hp : r.parent = (t.scopes x).parent)
    (hne : (t.scopes x).parent ≠ some x) : unlink (t.set x r) x = (unlink t x).set x r := by
  unfold unlink
  simp only [set_scopes, ↓reduceIte, hp]
  split
  · rfl
  · rename_i q hq
    have : q ≠ x := fun e => hne (e ▸ hq)
    simp only [this, ↓reduceIte, Tree.set, Tree.mk.injEq, and_true]
    funext m
    by_cases e : m = x
    · subst e; simp [Ne.symm this]
    · simp [e]

-- dispose's end: o gone, out of its parent's children, its frame popped
theorem inv_gone {t : Tree} {ctx : List Frame} {x : Nat} (h : Inv t (.disp x :: ctx))
    (hd : (t.scopes x).state = .disposing) (hc : (t.scopes x).children = [])
    (hf : (t.scopes x).cleanups = []) :
    Inv (unlink (t.set x { t.scopes x with state := .gone }) x) ctx := by
  have hx := h.alive_made (by rw [hd]; simp)
  have hne : (t.scopes x).parent ≠ some x := fun e => by have := h.older _ _ e; omega
  rw [unlink_set t x { t.scopes x with state := .gone } rfl hne]
  -- unlink first: x out of its parent's children
  have h₁ : Inv (unlink t x) (.disp x :: ctx) := by
    unfold unlink
    split
    · exact h
    · rename_i q hq
      have hq' : q ≤ t.made := by have := h.older _ _ hq; omega
      exact inv_set h (fun f hf => .inl hf) hq' rfl (out_sub _ _)
        (fun c hca _ _ h' h'' => by
          by_cases e : c = x
          · subst e; rw [hd] at hca; cases hca
          · exact absurd (out_mem h' e) h'')
        (fun e => e) (fun e => h.framed q e)
        (fun e => ⟨by simp [(h.gone q e).1], by simp [(h.gone q e).2]⟩)
        (fun e => by intro p hp; exact h.listed p q hp e)
  have hu : (unlink t x).scopes x = t.scopes x := by
    unfold unlink; split
    · rfl
    · rename_i q hq; simp [show x ≠ q from fun e => hne (e ▸ hq)]
  have hm : (unlink t x).made = t.made := by unfold unlink; split <;> rfl
  rw [← hu]
  refine inv_set h₁ (fun f hf => ?_) (by rw [hm]; exact hx) rfl (List.Sublist.refl _)
    (fun _ _ _ _ h' h'' => absurd h' h'') (by simp) (by simp) (by simp [hu, hc, hf]) ?_
  · rcases List.mem_cons.mp hf with e | e
    · exact .inr e
    · exact .inl e
  · intro _ p hp
    have := h₁.par p x hp
    rw [hu] at this
    unfold unlink at hp
    revert hp
    split
    · rename_i hq; rw [hq] at this; cases this
    · rename_i q hq
      rw [hq] at this; cases this
      simpa using out_not x (nodup_of_sorted (h.sorted p))

theorem Inv.congr {t t' : Tree} {ctx : List Frame} (h : Inv t ctx) (ho : t'.scopes = t.scopes)
    (hm : t'.made = t.made) : Inv t' ctx := by
  obtain ⟨a, b, c, d, e, f, g, i⟩ := h
  exact ⟨by rw [ho, hm]; exact a, by unfold up; rw [ho]; exact b, by rw [ho]; exact c,
    by rw [ho]; exact d, by rw [ho]; exact e, by rw [ho]; exact f, by rw [ho]; exact g,
    by rw [ho]; exact i⟩

theorem Mono.congr {t t' : Tree} (ho : t'.scopes = t.scopes) (hm : t'.made = t.made)
    (hr : t.regs ≤ t'.regs) (hl : ∃ l, t'.log = t.log ++ l) : Mono t t' :=
  ⟨by omega, hr, hl, fun m _ => by rw [ho], fun m _ _ => by rw [ho]; exact ⟨rfl, rfl, List.Sublist.refl _⟩⟩

theorem mono_unlink (t : Tree) (x : Nat) : Mono t (unlink t x) := by
  unfold unlink
  split
  · exact Mono.refl t
  · rename_i q hq
    exact mono_set t q _ rfl (fun _ => ⟨rfl, rfl, out_sub _ _⟩)

-- what grow gives when it gives a scope: a root
theorem grow_none_ok {t t' : Tree} {i : List Pair} {c : Bool} {n : Nat}
    (hr : grow t none i c = .ok (t', n)) :
    t' = { t with made := t.made + 1 }.set (t.made + 1) { state := .alive, info := .root i, comp := c } ∧
      n = t.made + 1 := by
  simp only [grow] at hr
  split at hr
  · cases hr
  · simp only [Except.ok.injEq, Prod.mk.injEq] at hr; exact ⟨hr.1.symm, hr.2.symm⟩

-- and under p: p alive
theorem grow_some_ok {t t' : Tree} {p : Nat} {i : List Pair} {c : Bool} {n : Nat}
    (hr : grow t (some p) i c = .ok (t', n)) :
    (t.scopes p).state = .alive ∧
      t' = { t.set p { t.scopes p with children := (t.scopes p).children ++ [t.made + 1] } with
        made := t.made + 1 }.set (t.made + 1)
          { parent := some p, state := .alive, info := .under i (t.scopes p).info, comp := c } ∧
      n = t.made + 1 := by
  simp only [grow] at hr
  split at hr
  · cases hr
  rename_i ha
  simp only [ne_eq, Decidable.not_not] at ha
  split at hr
  · cases hr
  · simp only [Except.ok.injEq, Prod.mk.injEq] at hr; exact ⟨ha, hr.1.symm, hr.2.symm⟩

-- grow(o): a scope made under an alive o
theorem inv_make {t : Tree} {i : List Pair} {c : Bool} {ctx : List Frame} {o : Nat} {t' : Tree} {n : Nat} (h : Inv t ctx)
    (hr : grow t (some o) i c = .ok (t', n)) : Inv t' ctx ∧ Mono t t' := by
  obtain ⟨ha, rfl, rfl⟩ := grow_some_ok hr
  have ho := h.alive_made (by rw [ha]; simp)
  -- the new scope: N
  have hN : ∀ m, m ≤ t.made → m ≠ t.made + 1 := fun m hm => by omega
  have hoN : o ≠ t.made + 1 := by omega
  have hc : ∀ p c, c ∈ (t.scopes p).children → c ≤ t.made := fun p c hc => h.child_made hc
  constructor
  · refine ⟨fun m hm => ?_, fun m p hm => ?_, fun p c hc' => ?_, fun p => ?_,
      fun c p hc' hp => ?_, fun c hc' => ?_, fun c hc' => ?_, fun p c hc' => ?_⟩
    · simp only [set_made] at hm
      simp [show m ≠ t.made + 1 by omega, show m ≠ o by omega, h.fresh m (by omega)]
    · by_cases e : m = t.made + 1
      · subst e; simp at hm; omega
      · by_cases e' : m = o
        · subst e'; simp [e] at hm; exact h.older _ _ hm
        · simp [e, e'] at hm; exact h.older _ _ hm
    · by_cases e : p = t.made + 1
      · subst e; simp at hc'
      · by_cases e' : p = o
        · subst e'
          simp [e] at hc'
          rcases hc' with hc' | rfl
          · have := hc _ _ hc'
            have hp := h.par _ _ hc'
            have : c ≠ p := by have := h.older _ _ hp; omega
            simp [show c ≠ t.made + 1 by omega, this, hp]
          · simp
        · simp [e, e'] at hc'
          have := hc _ _ hc'
          have hp := h.par _ _ hc'
          by_cases e'' : c = o
          · subst e''; simp [show c ≠ t.made + 1 by omega, hp]
          · simp [show c ≠ t.made + 1 by omega, e'', hp]
    · by_cases e : p = t.made + 1
      · subst e; simp
      · by_cases e' : p = o
        · subst e'
          simp [e, List.pairwise_append, h.sorted p]
          intro a ha'; have := hc _ _ ha'; omega
        · simp [e, e', h.sorted p]
    · by_cases e : c = t.made + 1
      · subst e; simp at hp ⊢; subst hp; simp [hoN]
      · have hc'' : (t.scopes c).state = .alive := by
          by_cases e' : c = o <;> simp_all
        have hp' : (t.scopes c).parent = some p := by
          by_cases e' : c = o <;> simp_all
        have hpc : p ≤ t.made := by have := h.older _ _ hp'; have := h.alive_made (m := c) (by rw [hc'']; simp); omega
        rcases h.linked c p hc'' hp' with h' | h'
        · left
          by_cases e' : p = o
          · subst e'; simp [hN p hpc, h']
          · simp [hN p hpc, e', h']
        · exact .inr h'
    · by_cases e : c = t.made + 1
      · subst e; simp at hc'
      · have : (t.scopes c).state = .disposing := by by_cases e' : c = o <;> simp_all
        exact h.framed c this
    · by_cases e : c = t.made + 1
      · subst e; simp at hc'
      · by_cases e' : c = o
        · subst e'; simp [e] at hc'; rw [ha] at hc'; cases hc'
        · simp [e, e'] at hc' ⊢; exact h.gone c hc'
    · by_cases e : c = t.made + 1
      · subst e; simp
      · have hc'' : c ∈ (t.scopes p).children := by
          by_cases e' : p = t.made + 1
          · subst e'; simp at hc'
          · by_cases e'' : p = o
            · subst e''; simp [e'] at hc'; rcases hc' with hc' | hc'
              · exact hc'
              · exact absurd hc' e
            · simpa [e', e''] using hc'
        have := h.listed p c hc''
        by_cases e' : c = o
        · subst e'; simp [e, ha]
        · simp [e, e', this]
  · refine ⟨by simp, by simp, ⟨[], by simp⟩, fun m hm => ?_, fun m hm hs => ?_⟩
    · by_cases e : m = o
      · subst e; simp [hN m hm]
      · simp [hN m hm, e]
    · have e : m ≠ o := fun e => hs (e ▸ ha)
      simp [hN m hm, e]

-- root(): a scope with no parent
theorem inv_root {t : Tree} {i : List Pair} {c : Bool} {ctx : List Frame} {t' : Tree} {n : Nat} (h : Inv t ctx)
    (hr : grow t none i c = .ok (t', n)) : Inv t' ctx := by
  obtain ⟨rfl, rfl⟩ := grow_none_ok hr
  have hc : ∀ p c, c ∈ (t.scopes p).children → c ≤ t.made := fun p c hc => h.child_made hc
  refine ⟨fun m hm => ?_, fun m p hm => ?_, fun p c hc' => ?_, fun p => ?_,
    fun c p hc' hp => ?_, fun c hc' => ?_, fun c hc' => ?_, fun p c hc' => ?_⟩
  · simp only [set_made] at hm
    simp [show m ≠ t.made + 1 by omega, h.fresh m (by omega)]
  · by_cases e : m = t.made + 1
    · subst e; simp at hm
    · simp [e] at hm; exact h.older _ _ hm
  · by_cases e : p = t.made + 1
    · subst e; simp at hc'
    · simp [e] at hc'
      have := hc _ _ hc'
      simp [show c ≠ t.made + 1 by omega, h.par _ _ hc']
  · by_cases e : p = t.made + 1
    · subst e; simp
    · simp [e, h.sorted p]
  · by_cases e : c = t.made + 1
    · subst e; simp at hp
    · simp [e] at hc' hp
      have hpc : p ≤ t.made := by
        have := h.older _ _ hp; have := h.alive_made (m := c) (by rw [hc']; simp); omega
      rcases h.linked c p hc' hp with h' | h'
      · exact .inl (by simp [show p ≠ t.made + 1 by omega, h'])
      · exact .inr h'
  · by_cases e : c = t.made + 1
    · subst e; simp at hc'
    · simp [e] at hc'; exact h.framed c hc'
  · by_cases e : c = t.made + 1
    · subst e; simp at hc'
    · simp [e] at hc' ⊢; exact h.gone c hc'
  · by_cases e : p = t.made + 1
    · subst e; simp at hc'
    · simp [e] at hc'
      have := hc _ _ hc'
      simp [show c ≠ t.made + 1 by omega, h.listed p c hc']

theorem mono_root {t : Tree} {i : List Pair} {c : Bool} {t' : Tree} {n : Nat}
    (hr : grow t none i c = .ok (t', n)) : Mono t t' := by
  obtain ⟨rfl, rfl⟩ := grow_none_ok hr
  refine ⟨by simp, by simp, ⟨[], by simp⟩, fun m hm => ?_, fun m hm _ => ?_⟩
  · simp [show m ≠ t.made + 1 by omega]
  · simp [show m ≠ t.made + 1 by omega]

-- scope(info, up) made it: grow did, under up or the one open
theorem scope_ok {t : Tree} {p : Option Nat} {i : List Pair} {c : Bool} {t' : Tree} {n : Nat}
    (h : scope t p i c = .ok (t', n)) : ∃ q, grow t (some q) i c = .ok (t', n) := by
  unfold scope at h
  split at h
  · exact ⟨_, h⟩
  · exact ⟨_, h⟩
  · cases h

-- what is open is no part of Inv or Mono
theorem Inv.opened {t : Tree} {ctx : List Frame} (h : Inv t ctx) (l : List Bracket) :
    Inv { t with opened := l } ctx := h.congr rfl rfl

theorem chain_some {r : Result} {k : Tree → Result} {t' : Tree} {e : Option Err}
    (h : chain r k = some (t', e)) :
    ∃ t₁ e₁, r = some (t₁, e₁) ∧ ((e₁ ≠ none ∧ t' = t₁ ∧ e = e₁) ∨ (e₁ = none ∧ k t₁ = some (t', e))) := by
  match r, h with
  | some (t₁, some e₁), h => simp [chain] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨_, _, rfl, .inl ⟨by simp, rfl, rfl⟩⟩
  | some (t₁, none), h => exact ⟨_, _, rfl, .inr ⟨rfl, h⟩⟩

-- dispose keeps Inv (for the frames it was called in), takes nothing back, and leaves x not alive
def spec_keep (n : Nat) : Prop := ∀ t x ctx t' e, Inv t ctx → dispose n t x = some (t', e) →
  Inv t' ctx ∧ Mono t t' ∧ (t'.scopes x).state ≠ .alive

-- so does a cleanup's code
def spec_exec (n : Nat) : Prop := ∀ c t ctx t' e, Inv t ctx → exec (dispose n) t c = some (t', e) →
  Inv t' ctx ∧ Mono t t'

-- enter keeps what its f keeps: what is open is no part of Inv or Mono
theorem enter_keep {b : Bracket} {t : Tree} {g : Tree → Result} {ctx : List Frame} {t' : Tree}
    {e : Option Err}
    (hg : ∀ t₁ e₁, g { t with opened := b :: t.opened } = some (t₁, e₁) →
      Inv t₁ ctx ∧ Mono { t with opened := b :: t.opened } t₁)
    (h : enter b t g = some (t', e)) : Inv t' ctx ∧ Mono t t' := by
  obtain ⟨t₁, h₁, rfl⟩ := enter_some h
  have G := hg t₁ e h₁
  have A : Mono t { t with opened := b :: t.opened } := Mono.congr rfl rfl (Nat.le_refl _) ⟨[], by simp⟩
  have B : Mono t₁ { t₁ with opened := t.opened } := Mono.congr rfl rfl (Nat.le_refl _) ⟨[], by simp⟩
  exact ⟨G.1.opened _, A.trans (G.2.trans B)⟩

theorem exec_keep {n : Nat} (hP : spec_keep n) : ∀ (c : Code) (t : Tree) (ctx : List Frame) (t' : Tree)
    (e : Option Err), Inv t ctx → exec (dispose n) t c = some (t', e) → Inv t' ctx ∧ Mono t t'
  | .done, t, ctx, t', e, hI, h => by
    simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
  | .throw _, t, ctx, t', e, hI, h => by
    simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
  | .reg f k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
    rename_i b bs ho
    let t₁ := ({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)
    have I₁ : Inv t₁ ctx := hI.congr rfl rfl
    have M₁ : Mono t t₁ := Mono.congr rfl rfl (by simp [t₁]) ⟨_, rfl⟩
    split at h
    · rename_i ha
      have I₂ := inv_cleanups ((t₁.scopes b.scope).cleanups ++ [(t.regs, f)]) I₁ (by rw [ha]; simp)
      have M₂ : Mono t₁ _ := mono_set t₁ b.scope { t₁.scopes b.scope with cleanups :=
        (t₁.scopes b.scope).cleanups ++ [(t.regs, f)] } rfl (fun hs => absurd ha hs)
      have := exec_keep hP k _ ctx t' e I₂ h
      exact ⟨this.1, M₁.trans (M₂.trans this.2)⟩
    · obtain ⟨t₂, e₂, h₂, h'⟩ := chain_some h
      have I₂ : Inv (t₁.note (.run t.regs)) ctx := I₁.congr rfl rfl
      have M₂ : Mono t₁ (t₁.note (.run t.regs)) := Mono.congr rfl rfl (Nat.le_refl _) ⟨_, rfl⟩
      have F := enter_keep (fun t₃ e₃ h₃ => exec_keep hP f _ ctx t₃ e₃ (I₂.opened _) h₃) h₂
      rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
      · exact ⟨F.1, M₁.trans (M₂.trans F.2)⟩
      · have K := exec_keep hP k _ ctx t' e F.1 h'
        exact ⟨K.1, M₁.trans (M₂.trans (F.2.trans K.2))⟩
  | .make p i k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have M := inv_make hI hq
      have K := exec_keep hP k _ ctx t' e M.1 h
      exact ⟨K.1, M.2.trans K.2⟩
  | .comp k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have M := inv_make hI hq
      have K := exec_keep hP k _ ctx t' e M.1 h
      exact ⟨K.1, M.2.trans K.2⟩
  | .root i k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
    · rename_i t₁ n₁ hr
      have K := exec_keep hP k _ ctx t' e (inv_root hI hr) h
      exact ⟨K.1, (mono_root hr).trans K.2⟩
  | .disp o k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    obtain ⟨t₁, e₁, h₁, h'⟩ := chain_some h
    have D := hP t o ctx t₁ e₁ hI h₁
    rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
    · exact ⟨D.1, D.2.1⟩
    · have K := exec_keep hP k _ ctx t' e D.1 h'
      exact ⟨K.1, D.2.1.trans K.2⟩
  | .run o f k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
    · obtain ⟨t₂, e₂, h₂, h'⟩ := chain_some h
      have F := enter_keep (fun t₃ e₃ h₃ => exec_keep hP f _ ctx t₃ e₃ (hI.opened _) h₃) h₂
      rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
      · exact F
      · have K := exec_keep hP k _ ctx t' e F.1 h'
        exact ⟨K.1, F.2.trans K.2⟩
  | .write k, t, ctx, t', e, hI, h => by
    simp only [exec] at h
    have K := exec_keep hP k (t.note _) ctx t' e (hI.congr rfl rfl) h
    exact ⟨K.1, (Mono.congr (t := t) (t' := t.note _) rfl rfl (Nat.le_refl _) ⟨_, rfl⟩).trans K.2⟩

theorem kids_keep {n : Nat} (hP : spec_keep n) (p : Nat) (ctx : List Frame) :
    ∀ (ks : List Nat) (t : Tree) (f : Option Err) (t' : Tree) (e : Option Err),
    Inv t (.kids p ks :: ctx) → each (dispose n) t ks f = some (t', e) →
    Inv t' (.kids p [] :: ctx) ∧ Mono t t'
  | [], t, f, t', e, hI, h => by
    simp [each] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
  | k :: ks, t, f, t', e, hI, h => by
    rw [each_cons] at h
    split at h
    · cases h
    rename_i t₁ e₁ h₁
    have D := hP t k _ t₁ e₁ hI h₁
    have R := kids_keep hP p ctx ks t₁ _ t' e (D.1.pop D.2.2) h
    exact ⟨R.1, D.2.1.trans R.2⟩

-- the same for kids: the loop in o's bracket
theorem opened_keep {n : Nat} (hP : spec_keep n) (p : Nat) (ctx : List Frame) {o : Nat}
    (ks : List Nat) (t t' : Tree) (e : Option Err) (hI : Inv t (.kids p ks :: ctx))
    (h : kids (dispose n) o t ks = some (t', e)) : Inv t' (.kids p [] :: ctx) ∧ Mono t t' :=
  enter_keep (fun t₁ e₁ h₁ => kids_keep hP p ctx ks _ none t₁ e₁ (hI.opened _) h₁) h

theorem calls_keep {n : Nat} (hE : spec_exec n) (ctx : List Frame) (o : Nat) :
    ∀ (cs : List (Nat × Code)) (t : Tree) (f : Option Err) (t' : Tree) (e : Option Err),
    Inv t ctx → each (call (dispose n) o) t cs f = some (t', e) → Inv t' ctx ∧ Mono t t'
  | [], t, f, t', e, hI, h => by
    simp [each] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t⟩
  | x :: xs, t, f, t', e, hI, h => by
    rw [each_cons] at h
    split at h
    · cases h
    rename_i t₁ e₁ h₁
    have M₀ : Mono t (t.note (.run x.1)) := Mono.congr rfl rfl (Nat.le_refl _) ⟨_, rfl⟩
    have I₀ : Inv (t.note (.run x.1)) ctx := hI.congr rfl rfl
    have D := enter_keep (fun t₂ e₂ h₂ => hE x.2 _ ctx t₂ e₂ (I₀.opened _) h₂) h₁
    have R := calls_keep hE ctx o xs t₁ _ t' e D.1 h
    exact ⟨R.1, M₀.trans (D.2.trans R.2)⟩

-- under Inv, a scope's children are all past the 0th: clean(o) takes them all
theorem Inv.kept_zero {t : Tree} {ctx : List Frame} (h : Inv t ctx) (o : Nat) :
    kept (t.scopes o).children 0 = [] := by
  rw [kept_eq _ _ (h.sorted o), List.filter_eq_nil_iff]
  intro c hc; have := h.older _ _ (h.par o c hc); simp; omega

theorem dispose_keep : ∀ n, spec_keep n
  | 0 => by intro t x ctx t' e _ h; simp [dispose] at h
  | n + 1 => by
    intro t x ctx t' e hI h
    have hP := dispose_keep n
    have hE : spec_exec n := exec_keep hP
    by_cases ha : (t.scopes x).state ≠ .alive
    · simp [dispose, ha] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hI, Mono.refl t, ha⟩
    simp only [ne_eq, Decidable.not_not] at ha
    have hx := hI.alive_made (by rw [ha]; simp)
    unfold dispose at h
    simp only [ha, ne_eq, not_true_eq_false, ↓reduceIte] at h
    split at h
    · simp at h
    rename_i t₄ e₄ h₄
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    unfold clean at h₄
    split at h₄
    · simp at h₄
    rename_i t₃ f₃ h₃
    let t₁ := t.set x { t.scopes x with state := .disposing }
    have I₁ : Inv t₁ (.disp x :: ctx) := inv_disposing hI ha
    have M₁ : Mono t t₁ := mono_set t x _ rfl (fun hs => absurd ha hs)
    have hd₁ : (t₁.scopes x).state = .disposing := by simp [t₁]
    have I₂ := inv_cut 0 I₁ (by rw [hd₁]; simp)
    let t₂ := t₁.set x { t₁.scopes x with children := kept (t₁.scopes x).children 0 }
    have M₂ : Mono t₁ t₂ := mono_set t₁ x _ rfl (fun _ => ⟨rfl, rfl, kept_sub _ _⟩)
    have K := opened_keep hP x (.disp x :: ctx) _ t₂ t₃ f₃ I₂ h₃
    have I₃ := K.1.drop
    have M₂₃ := K.2
    have hx₂ : x ≤ t₂.made := by simp [t₂, t₁]; exact hx
    have S₃ := M₂₃.still x hx₂ (by simp [t₂, t₁])
    have hd₃ : (t₃.scopes x).state = .disposing := by rw [S₃.1]; simp [t₂, t₁]
    have hk₃ : (t₃.scopes x).children = [] := by
      have := S₃.2.2
      simp only [t₂, set_scopes, ↓reduceIte] at this
      rw [I₁.kept_zero x] at this
      exact List.sublist_nil.mp this
    let t₃' := t₃.set x { t₃.scopes x with cleanups := (t₃.scopes x).cleanups.take 0 }
    have I₃' : Inv t₃' (.disp x :: ctx) := inv_cleanups _ I₃ (by rw [hd₃]; simp)
    have L := calls_keep hE (.disp x :: ctx) x _ t₃' f₃ t₄ e₄ I₃' h₄
    have hx₃ : x ≤ t₃'.made := by
      simp [t₃']; exact Nat.le_trans hx (Nat.le_trans M₁.made (Nat.le_trans M₂.made M₂₃.made))
    have S₄ := L.2.still x hx₃ (by simp [t₃', hd₃])
    have hd₄ : (t₄.scopes x).state = .disposing := by rw [S₄.1]; simp [t₃', hd₃]
    have hf₄ : (t₄.scopes x).cleanups = [] := by rw [S₄.2.1]; simp [t₃']
    have hk₄ : (t₄.scopes x).children = [] := by
      have := S₄.2.2; simp [t₃', hk₃] at this; exact this
    refine ⟨inv_gone L.1 hd₄ hk₄ hf₄, ?_, ?_⟩
    · have M₃ : Mono t t₃' := (M₁.trans (M₂.trans M₂₃)).set_alive x _ rfl ha
      have M₅ : Mono t (t₄.set x { t₄.scopes x with state := .gone }) :=
        (M₃.trans L.2).set_alive x _ rfl ha
      exact M₅.trans (mono_unlink _ x)
    · have hne : (t₄.scopes x).parent ≠ some x := fun e => by have := L.1.older _ _ e; omega
      unfold unlink
      split
      · simp
      · rename_i q hq
        simp at hq
        simp [show x ≠ q from fun e => hne (e ▸ hq)]

/-! ## theorem 6 (c): after dispose(o), everything under o is gone -/

-- o gone, and no frame below of a scope under o: everything under o is gone
theorem Inv.clear {t : Tree} {ctx : List Frame} (h : Inv t ctx) {o : Nat}
    (hg : (t.scopes o).state = .gone) (hf : ∀ f ∈ ctx, ¬ under t o f.at) :
    ∀ m, under t o m → (t.scopes m).state = .gone := by
  intro m hm
  induction hm with
  | refl => exact hg
  | step hp hu ih =>
    rename_i m p
    match hs : (t.scopes m).state with
    | .gone => rfl
    | .alive =>
      rcases h.linked m p hs hp with h' | ⟨ks, hk, _⟩
      · rw [(h.gone p ih).1] at h'; simp at h'
      · exact absurd hu (hf _ hk)
    | .disposing => exact absurd (.step hp hu) (hf _ (h.framed m hs))

-- under, back: a scope made before a call is under o after it only if it was before
theorem Mono.back {t t' : Tree} {ctx : List Frame} (M : Mono t t') (hI : Inv t ctx) {o m : Nat}
    (hm : m ≤ t.made) (h : under t' o m) : under t o m := by
  revert hm
  induction h with
  | refl => intro _; exact .refl
  | @step m' p hp _ ih =>
    intro hm
    rw [M.parent m' hm] at hp
    exact .step hp (ih (by have := hI.older _ _ hp; omega))

-- 6 (c), in general: dispose(o) called with no frame below of a scope under o (so o is not
-- disposing). when it returns, every scope under o is gone, with no children and no cleanups,
-- and o is out of its parent's children
theorem dispose_clears (n : Nat) (t : Tree) (o : Nat) (ctx : List Frame) (t' : Tree)
    (e : Option Err) (hI : Inv t ctx) (hf : ∀ f ∈ ctx, f.at ≤ t.made ∧ ¬ under t o f.at)
    (h : dispose n t o = some (t', e)) :
    Inv t' ctx ∧
    (∀ m, under t' o m → (t'.scopes m).state = .gone ∧ (t'.scopes m).children = [] ∧
      (t'.scopes m).cleanups = []) ∧
    (∀ p, (t'.scopes o).parent = some p → o ∉ (t'.scopes p).children) := by
  obtain ⟨I, M, ha⟩ := dispose_keep n t o ctx t' e hI h
  have hf' : ∀ f ∈ ctx, ¬ under t' o f.at := fun f hf' hu =>
    (hf f hf').2 (M.back hI (hf f hf').1 hu)
  have hg : (t'.scopes o).state = .gone := by
    match hs : (t'.scopes o).state with
    | .gone => rfl
    | .alive => exact absurd hs ha
    | .disposing => exact absurd .refl (hf' _ (I.framed o hs))
  refine ⟨I, fun m hm => ?_, fun p _ hp => I.listed p o hp hg⟩
  have := I.clear hg hf' m hm
  exact ⟨this, (I.gone m this).1, (I.gone m this).2⟩

-- 6 (c), at the top (no dispose or clean under way: what the host and the scheduler's pulse
-- see between calls)
theorem six_c (n : Nat) (t : Tree) (o : Nat) (t' : Tree) (e : Option Err) (hI : Inv t [])
    (h : dispose n t o = some (t', e)) :
    Inv t' [] ∧
    (∀ m, under t' o m → (t'.scopes m).state = .gone ∧ (t'.scopes m).children = [] ∧
      (t'.scopes m).cleanups = []) ∧
    (∀ p, (t'.scopes o).parent = some p → o ∉ (t'.scopes p).children) :=
  dispose_clears n t o [] t' e hI (by simp) h

/-! ## termination: fuel enough -/

-- a code's size
def Code.size : Code → Nat
  | .done => 1
  | .throw _ => 1
  | .reg f k => 1 + f.size + k.size
  | .make _ _ k => 1 + k.size
  | .comp k => 1 + k.size
  | .root _ k => 1 + k.size
  | .disp _ k => 1 + k.size
  | .run _ f k => 1 + f.size + k.size
  | .write k => 1 + k.size

-- what a scope may still cost: 1 while alive, and its cleanups' code
def Scope.weight (r : Scope) : Nat :=
  (if r.state = .alive then 1 else 0) + (r.cleanups.map (fun x => x.2.size)).sum

def total (f : Nat → Nat) : Nat → Nat
  | 0 => f 0
  | k + 1 => total f k + f (k + 1)

-- the measure: every scope made, weighed
def mu (t : Tree) : Nat := total (fun m => (t.scopes m).weight) t.made

theorem total_congr {f g : Nat → Nat} : ∀ k, (∀ m ≤ k, f m = g m) → total f k = total g k
  | 0, h => by simp [total, h 0 (Nat.le_refl _)]
  | k + 1, h => by
    simp only [total]
    rw [total_congr k (fun m hm => h m (by omega)), h (k + 1) (Nat.le_refl _)]

theorem total_set (f : Nat → Nat) (o a : Nat) : ∀ k, o ≤ k →
    total (fun m => if m = o then a else f m) k + f o = total f k + a
  | 0, h => by
    have : o = 0 := by omega
    subst this; simp [total]; omega
  | k + 1, h => by
    simp only [total]
    by_cases e : o = k + 1
    · subst e
      have := total_congr (f := fun m => if m = k + 1 then a else f m) (g := f) k
        (fun m hm => by simp [show m ≠ k + 1 by omega])
      simp [this]; omega
    · have := total_set f o a k (by omega)
      simp [Ne.symm e]; omega

theorem mu_set (t : Tree) (o : Nat) (r : Scope) (ho : o ≤ t.made) :
    mu (t.set o r) + (t.scopes o).weight = mu t + r.weight := by
  unfold mu
  have := total_set (fun m => (t.scopes m).weight) o r.weight t.made ho
  simp only [set_made]
  rw [← this]
  congr 1
  apply total_congr
  intro m _
  by_cases e : m = o <;> simp [e]

theorem mu_congr {t t' : Tree} (ho : t'.scopes = t.scopes) (hm : t'.made = t.made) : mu t' = mu t := by
  simp [mu, ho, hm]

-- a set that keeps the weight
theorem mu_same (t : Tree) (o : Nat) (r : Scope) (ho : o ≤ t.made) (hw : r.weight = (t.scopes o).weight) :
    mu (t.set o r) = mu t := by
  have := mu_set t o r ho; omega

theorem mu_make {t : Tree} {i : List Pair} {c : Bool} {ctx : List Frame} {o : Nat} {t' : Tree} {n : Nat} (h : Inv t ctx)
    (hr : grow t (some o) i c = .ok (t', n)) : mu t' = mu t + 1 := by
  obtain ⟨ha, rfl, rfl⟩ := grow_some_ok hr
  have ho := h.alive_made (by rw [ha]; simp)
  let t₁ := t.set o { t.scopes o with children := (t.scopes o).children ++ [t.made + 1] }
  have m₁ : mu t₁ = mu t := mu_same t o _ ho (by simp [Scope.weight])
  unfold mu
  simp only [set_made, total]
  have : total (fun m => ((({ t₁ with made := t.made + 1 } : Tree).set (t.made + 1)
      { parent := some o, state := .alive, info := .under i (t.scopes o).info, comp := c }).scopes m).weight) t.made =
      total (fun m => (t₁.scopes m).weight) t.made :=
    total_congr _ (fun m hm => by simp [show m ≠ t.made + 1 by omega])
  rw [this]
  have : mu t₁ = total (fun m => (t₁.scopes m).weight) t.made := rfl
  rw [← this, m₁]
  simp [Scope.weight]
  rfl

theorem weight_eq (r : Scope) :
    r.weight = (if r.state = .alive then 1 else 0) + (r.cleanups.map (fun x => x.2.size)).sum := rfl

theorem mu_state (t : Tree) (x : Nat) (st : State) (hx : x ≤ t.made)
    (ha : (t.scopes x).state = .alive) (hs : st ≠ .alive) :
    mu (t.set x { t.scopes x with state := st }) + 1 = mu t := by
  have := mu_set t x { t.scopes x with state := st } hx
  have w₁ : ({ t.scopes x with state := st } : Scope).weight =
      ((t.scopes x).cleanups.map (fun x => x.2.size)).sum := by simp [Scope.weight, hs]
  have w₂ : (t.scopes x).weight = 1 + ((t.scopes x).cleanups.map (fun x => x.2.size)).sum := by
    simp [Scope.weight, ha]
  omega

theorem mu_cleanups (t : Tree) (x : Nat) (l : List (Nat × Code)) (hx : x ≤ t.made) :
    mu (t.set x { t.scopes x with cleanups := l }) + ((t.scopes x).cleanups.map (fun x => x.2.size)).sum =
      mu t + (l.map (fun x => x.2.size)).sum := by
  have := mu_set t x { t.scopes x with cleanups := l } hx
  have w₁ : ({ t.scopes x with cleanups := l } : Scope).weight =
      (if (t.scopes x).state = .alive then 1 else 0) + (l.map (fun x => x.2.size)).sum := rfl
  have w₂ := weight_eq (t.scopes x)
  omega

theorem mu_children (t : Tree) (x : Nat) (l : List Nat) (hx : x ≤ t.made) :
    mu (t.set x { t.scopes x with children := l }) = mu t :=
  mu_same t x _ hx (by simp [Scope.weight])

theorem sizes_push (l : List (Nat × Code)) (i : Nat) (f : Code) :
    ((l ++ [(i, f)]).map (fun x => x.2.size)).sum = (l.map (fun x => x.2.size)).sum + f.size := by
  simp

-- dispose n finishes when mu is below n, and mu does not grow
def spec_ends (n : Nat) : Prop := ∀ t x ctx, Inv t ctx → mu t < n →
  ∃ t' e, dispose n t x = some (t', e) ∧ mu t' ≤ mu t

-- enter returns when its f does, with mu as f leaves it
theorem enter_ends {b : Bracket} {t : Tree} {g : Tree → Result} {m : Nat}
    (hg : ∃ t₁ e₁, g { t with opened := b :: t.opened } = some (t₁, e₁) ∧ mu t₁ ≤ m) :
    ∃ t' e, enter b t g = some (t', e) ∧ mu t' ≤ m := by
  obtain ⟨t₁, e₁, h₁, hm⟩ := hg
  exact ⟨{ t₁ with opened := t.opened }, e₁, by simp [enter, h₁], by rw [mu_congr rfl rfl]; exact hm⟩

theorem mu_opened (t : Tree) (l : List Bracket) : mu { t with opened := l } = mu t := mu_congr rfl rfl

theorem mu_root {t : Tree} {i : List Pair} {c : Bool} {t' : Tree} {n : Nat}
    (hr : grow t none i c = .ok (t', n)) : mu t' = mu t + 1 := by
  obtain ⟨rfl, rfl⟩ := grow_none_ok hr
  unfold mu
  simp only [set_made, total]
  have : total (fun m => ((({ t with made := t.made + 1 } : Tree).set (t.made + 1)
      { state := .alive, info := .root i, comp := c }).scopes m).weight) t.made =
      total (fun m => (t.scopes m).weight) t.made :=
    total_congr _ (fun m hm => by simp [show m ≠ t.made + 1 by omega])
  rw [this]
  simp [Scope.weight]


theorem exec_ends {n : Nat} (hT : spec_ends n) : ∀ (c : Code) (t : Tree) (ctx : List Frame),
    Inv t ctx → mu t + c.size ≤ n →
    ∃ t' e, exec (dispose n) t c = some (t', e) ∧ mu t' ≤ mu t + c.size
  | .done, t, _, _, _ => ⟨t, none, rfl, by simp⟩
  | .throw e, t, _, _, _ => ⟨t, some (.thrown e), rfl, by simp⟩
  | .reg f k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    split
    · exact ⟨t, _, rfl, by simp [Code.size]⟩
    rename_i b bs ho
    let t₁ := ({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)
    have I₁ : Inv t₁ ctx := hI.congr rfl rfl
    have m₁ : mu t₁ = mu t := mu_congr rfl rfl
    split
    · rename_i ha
      have ho := I₁.alive_made (by rw [ha]; simp)
      have I₂ := inv_cleanups ((t₁.scopes b.scope).cleanups ++ [(t.regs, f)]) I₁ (by rw [ha]; simp)
      have m₂ := mu_cleanups t₁ b.scope ((t₁.scopes b.scope).cleanups ++ [(t.regs, f)]) ho
      rw [sizes_push] at m₂
      obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx I₂ (by omega)
      exact ⟨t', e, h, by simp [Code.size]; omega⟩
    · let t₂ := t₁.note (.run t.regs)
      have I₂ : Inv t₂ ctx := I₁.congr rfl rfl
      have m₂ : mu t₂ = mu t := mu_congr rfl rfl
      obtain ⟨t₃, e₃, h₃, hm₃⟩ := enter_ends (b := opens t₁ b.scope) (t := t₂)
        (g := fun t => exec (dispose n) t f)
        (exec_ends hT f _ ctx (I₂.opened _) (by rw [mu_opened]; omega))
      rw [mu_opened t₂] at hm₃
      rw [h₃]
      cases e₃ with
      | some e₃ => exact ⟨t₃, some e₃, rfl, by simp [Code.size]; omega⟩
      | none =>
        have I₃ := (enter_keep (fun t₄ e₄ h₄ =>
          exec_keep (dispose_keep n) f _ ctx t₄ e₄ (I₂.opened _) h₄) h₃).1
        obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx I₃ (by omega)
        exact ⟨t', e, h, by simp [Code.size]; omega⟩
  | .make p i k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    split
    · exact ⟨t, _, rfl, by omega⟩
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have M := inv_make hI hq
      have m₁ := mu_make hI hq
      obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx M.1 (by omega)
      exact ⟨t', e, h, by simp [Code.size]; omega⟩
  | .comp k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    split
    · exact ⟨t, _, rfl, by omega⟩
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have M := inv_make hI hq
      have m₁ := mu_make hI hq
      obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx M.1 (by omega)
      exact ⟨t', e, h, by simp [Code.size]; omega⟩
  | .root i k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    split
    · exact ⟨t, _, rfl, by omega⟩
    · rename_i t₁ n₁ hr
      have m₁ := mu_root hr
      obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx (inv_root hI hr) (by omega)
      exact ⟨t', e, h, by simp [Code.size]; omega⟩
  | .disp o k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    obtain ⟨t₁, e₁, h₁, hm₁⟩ := hT t o ctx hI (by omega)
    rw [h₁]
    cases e₁ with
    | some e₁ => exact ⟨t₁, some e₁, rfl, by simp [Code.size]; omega⟩
    | none =>
      have I₁ := (dispose_keep n t o ctx t₁ none hI h₁).1
      obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx I₁ (by omega)
      exact ⟨t', e, h, by simp [Code.size]; omega⟩
  | .run o f k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    split
    · exact ⟨t, _, rfl, by omega⟩
    · obtain ⟨t₃, e₃, h₃, hm₃⟩ := enter_ends (b := ⟨o, t.who⟩) (t := t)
        (g := fun t => exec (dispose n) t f)
        (exec_ends hT f _ ctx (hI.opened _) (by rw [mu_opened]; omega))
      rw [mu_opened t] at hm₃
      rw [h₃]
      cases e₃ with
      | some e₃ => exact ⟨t₃, some e₃, rfl, by simp [Code.size]; omega⟩
      | none =>
        have I₃ := (enter_keep (fun t₄ e₄ h₄ =>
          exec_keep (dispose_keep n) f _ ctx t₄ e₄ (hI.opened _) h₄) h₃).1
        obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx I₃ (by omega)
        exact ⟨t', e, h, by simp [Code.size]; omega⟩
  | .write k, t, ctx, hI, hn => by
    simp only [exec]
    simp only [Code.size] at hn
    have m₁ : mu (t.note (.write (current t))) = mu t := mu_congr rfl rfl
    obtain ⟨t', e, h, hm⟩ := exec_ends hT k _ ctx (hI.congr (t' := t.note (.write (current t))) rfl rfl)
      (by omega)
    exact ⟨t', e, h, by simp [Code.size]; omega⟩

theorem kids_ends {n : Nat} (hT : spec_ends n) (p : Nat) (ctx : List Frame) :
    ∀ (ks : List Nat) (t : Tree) (f : Option Err), Inv t (.kids p ks :: ctx) → mu t < n →
    ∃ t' e, each (dispose n) t ks f = some (t', e) ∧ mu t' ≤ mu t
  | [], t, f, _, _ => ⟨t, f, rfl, Nat.le_refl _⟩
  | k :: ks, t, f, hI, hn => by
    rw [each_cons]
    obtain ⟨t₁, e₁, h₁, hm₁⟩ := hT t k _ hI hn
    have D := dispose_keep n t k _ t₁ e₁ hI h₁
    obtain ⟨t', e, h, hm⟩ := kids_ends hT p ctx ks t₁ (pick f e₁) (D.1.pop D.2.2) (by omega)
    exact ⟨t', e, by rw [h₁]; exact h, by omega⟩

-- the same for kids: the loop in o's bracket
theorem opened_ends {n : Nat} (hT : spec_ends n) (p : Nat) (ctx : List Frame) (o : Nat)
    (ks : List Nat) (t : Tree) (hI : Inv t (.kids p ks :: ctx)) (hn : mu t < n) :
    ∃ t' e, kids (dispose n) o t ks = some (t', e) ∧ mu t' ≤ mu t := by
  obtain ⟨t₁, e₁, h₁, hm⟩ := kids_ends hT p ctx ks { t with opened := opens t o :: t.opened } none
    (hI.opened _) (by rw [mu_opened]; exact hn)
  rw [mu_opened] at hm
  exact enter_ends ⟨t₁, e₁, h₁, hm⟩

theorem calls_ends {n : Nat} (hT : spec_ends n) (ctx : List Frame) (o : Nat) :
    ∀ (cs : List (Nat × Code)) (t : Tree) (f : Option Err), Inv t ctx →
    mu t + (cs.map (fun x => x.2.size)).sum ≤ n →
    ∃ t' e, each (call (dispose n) o) t cs f = some (t', e) ∧
      mu t' ≤ mu t + (cs.map (fun x => x.2.size)).sum
  | [], t, f, _, _ => ⟨t, f, rfl, by simp⟩
  | x :: xs, t, f, hI, hn => by
    rw [each_cons]
    simp only [List.map_cons, List.sum_cons] at hn ⊢
    have I₀ : Inv (t.note (.run x.1)) ctx := hI.congr rfl rfl
    have m₀ : mu (t.note (.run x.1)) = mu t := mu_congr rfl rfl
    obtain ⟨t₁, e₁, h₁, hm₁⟩ := enter_ends (b := opens t o) (t := t.note (.run x.1))
      (g := fun t => exec (dispose n) t x.2)
      (exec_ends hT x.2 _ ctx (I₀.opened _) (by rw [mu_opened]; omega))
    rw [mu_opened (t.note (.run x.1))] at hm₁
    have I₁ := (enter_keep (fun t₄ e₄ h₄ =>
      exec_keep (dispose_keep n) x.2 _ ctx t₄ e₄ (I₀.opened _) h₄) h₁).1
    obtain ⟨t', e, h, hm⟩ := calls_ends hT ctx o xs t₁ (pick f e₁) I₁ (by omega)
    exact ⟨t', e, by simp only [call]; rw [h₁]; exact h, by omega⟩

theorem dispose_ends : ∀ n, spec_ends n
  | 0 => by intro t x ctx _ h; omega
  | n + 1 => by
    intro t x ctx hI hn
    have hT := dispose_ends n
    by_cases ha : (t.scopes x).state ≠ .alive
    · exact ⟨t, none, by simp [dispose, ha], Nat.le_refl _⟩
    simp only [ne_eq, Decidable.not_not] at ha
    have hx := hI.alive_made (by rw [ha]; simp)
    let t₁ := t.set x { t.scopes x with state := .disposing }
    have I₁ : Inv t₁ (.disp x :: ctx) := inv_disposing hI ha
    have m₁ : mu t₁ + 1 = mu t := mu_state t x .disposing hx ha (by simp)
    have I₂ := inv_cut (o := x) 0 I₁ (by simp [t₁])
    let t₂ := t₁.set x { t₁.scopes x with children := kept (t₁.scopes x).children 0 }
    have m₂ : mu t₂ = mu t₁ := mu_children t₁ x _ (by simp [t₁]; exact hx)
    obtain ⟨t₃, f₃, h₃, hm₃⟩ := opened_ends hT x (.disp x :: ctx) x _ t₂ I₂ (by omega)
    have K := opened_keep (dispose_keep n) x (.disp x :: ctx) _ t₂ t₃ f₃ I₂ h₃
    have I₃ := K.1.drop
    have hx₂ : x ≤ t₂.made := by simp [t₂, t₁]; exact hx
    have S₃ := K.2.still x hx₂ (by simp [t₂, t₁])
    have hd₃ : (t₃.scopes x).state = .disposing := by rw [S₃.1]; simp [t₂, t₁]
    have hx₃ : x ≤ t₃.made := Nat.le_trans hx₂ K.2.made
    let t₃' := t₃.set x { t₃.scopes x with cleanups := (t₃.scopes x).cleanups.take 0 }
    have I₃' : Inv t₃' (.disp x :: ctx) := inv_cleanups _ I₃ (by rw [hd₃]; simp)
    have m₃ : mu t₃' + ((t₃.scopes x).cleanups.map (fun x => x.2.size)).sum = mu t₃ := by
      have := mu_cleanups t₃ x ((t₃.scopes x).cleanups.take 0) hx₃
      rw [show (((t₃.scopes x).cleanups.take 0).map (fun x => x.2.size)).sum = 0 by simp] at this
      exact this
    obtain ⟨t₄, e₄, h₄, hm₄⟩ := calls_ends hT (.disp x :: ctx) x ((t₃.scopes x).cleanups.drop 0).reverse
      t₃' f₃ I₃' (by simp [List.map_reverse, List.sum_reverse]; omega)
    have L := calls_keep (exec_keep (dispose_keep n)) (.disp x :: ctx) x _ t₃' f₃ t₄ e₄ I₃' h₄
    have hx₄ : x ≤ t₃'.made := by simp [t₃']; exact hx₃
    have S₄ := L.2.still x hx₄ (by simp [t₃', hd₃])
    refine ⟨unlink (t₄.set x { t₄.scopes x with state := .gone }) x, e₄, ?_, ?_⟩
    · unfold dispose
      simp only [ha, ne_eq, not_true_eq_false, ↓reduceIte]
      unfold clean
      rw [h₃]
      simp only []
      rw [h₄]
    · have hw : ({ t₄.scopes x with state := .gone } : Scope).weight = (t₄.scopes x).weight := by
        simp [Scope.weight, S₄.1, t₃', hd₃]
      have m₅ := mu_same t₄ x _ (Nat.le_trans hx₄ L.2.made) hw
      have m₆ : mu (unlink (t₄.set x { t₄.scopes x with state := .gone }) x) =
          mu (t₄.set x { t₄.scopes x with state := .gone }) := by
        unfold unlink
        split
        · rfl
        · rename_i q hq
          have : q ≤ t₄.made := by
            have := L.1.older x q (by simpa using hq); have := L.2.made; omega
          exact mu_same _ q _ (by simpa using this) (by simp [Scope.weight])
      simp [List.map_reverse, List.sum_reverse] at hm₄
      omega

-- fuel enough: mu + 1
theorem dispose_some (t : Tree) (x : Nat) (ctx : List Frame) (hI : Inv t ctx) :
    ∃ t' e, dispose (mu t + 1) t x = some (t', e) := by
  obtain ⟨t', e, h, _⟩ := dispose_ends (mu t + 1) t x ctx hI (by omega)
  exact ⟨t', e, h⟩

/-! ## theorem 6 (b): every cleanup runs once -/

-- the id a run event names
def Event.id : Event → Option Nat
  | .run i => some i
  | .reg _ _ => none
  | .write _ => none

-- the cleanups run, in order
def runs (l : List Event) : List Nat := l.filterMap Event.id

-- the ids of a scope's cleanups
def ids (t : Tree) (m : Nat) : List Nat := (t.scopes m).cleanups.map Prod.fst

-- cleanup ids: on one scope at most, once there, given out below regs; what ran, ran once and
-- is on no scope
structure Ids (t : Tree) : Prop where
  nodup : ∀ m, (ids t m).Nodup
  apart : ∀ m m' i, i ∈ ids t m → i ∈ ids t m' → m = m'
  below : ∀ m i, i ∈ ids t m → i < t.regs
  once : (runs t.log).Nodup
  done : ∀ i, i ∈ runs t.log → i < t.regs ∧ ∀ m, i ∉ ids t m

-- what a call did with cleanups, l its log, P cleanups it held (taken off their scope) to run
structure AccP (P : List Nat) (t t' : Tree) (l : List Event) : Prop where
  log : t'.log = t.log ++ l
  regs : t.regs ≤ t'.regs
  once : (runs l).Nodup
  -- what ran was on a scope before, or held, or is new; and is on no scope after
  ran : ∀ i, i ∈ runs l → ((∃ m, i ∈ ids t m) ∨ i ∈ P ∨ t.regs ≤ i) ∧ i < t'.regs ∧
    ∀ m, i ∉ ids t' m
  -- what is on a scope after was there before, or is new
  kept : ∀ m i, i ∈ ids t' m → i ∈ ids t m ∨ t.regs ≤ i
  -- a cleanup on m before, or registered on m during: on m still, or ran
  track : ∀ m i, (i ∈ ids t m ∨ Event.reg i m ∈ l) → i ∈ ids t' m ∨ i ∈ runs l
  -- registered during: a new id
  fresh : ∀ i m, Event.reg i m ∈ l → t.regs ≤ i ∧ i < t'.regs
  -- what was held, ran
  all : ∀ i, i ∈ P → i ∈ runs l

abbrev Acc := AccP []

@[simp] theorem runs_append (a b : List Event) : runs (a ++ b) = runs a ++ runs b := by
  simp [runs, List.filterMap_append]
@[simp] theorem runs_run (i : Nat) : runs [.run i] = [i] := rfl
@[simp] theorem runs_reg (i o : Nat) : runs [.reg i o] = [] := rfl
@[simp] theorem runs_nil : runs [] = [] := rfl
@[simp] theorem runs_cons_run (i : Nat) (l : List Event) : runs (.run i :: l) = i :: runs l := rfl
@[simp] theorem runs_cons_reg (i o : Nat) (l : List Event) : runs (.reg i o :: l) = runs l := rfl
@[simp] theorem runs_write (c : Option Current) : runs [.write c] = [] := rfl
@[simp] theorem runs_cons_write (c : Option Current) (l : List Event) : runs (.write c :: l) = runs l := rfl

-- nothing on the scopes changed but what is not cleanups
theorem Acc.same {t t' : Tree} (hi : ∀ m, ids t' m = ids t m) (hl : t'.log = t.log)
    (hr : t'.regs = t.regs) : Acc t t' [] :=
  ⟨by simp [hl], by omega, by simp, by simp, fun m i h => .inl (by rw [← hi]; exact h),
    fun m i h => by simp at h; exact .inl (by rw [hi]; exact h), by simp, by simp⟩

theorem Ids.same {t t' : Tree} (h : Ids t) (hi : ∀ m, ids t' m = ids t m) (hl : t'.log = t.log)
    (hr : t'.regs = t.regs) : Ids t' :=
  ⟨fun m => by rw [hi]; exact h.nodup m, fun m m' i a b => by rw [hi] at a b; exact h.apart m m' i a b,
    fun m i a => by rw [hi] at a; rw [hr]; exact h.below m i a, by rw [hl]; exact h.once,
    fun i a => by rw [hl] at a; rw [hr]; exact ⟨(h.done i a).1, fun m => by rw [hi]; exact (h.done i a).2 m⟩⟩

theorem Acc.trans {t₁ t₂ t₃ : Tree} {l₁ l₂ : List Event} (a : Acc t₁ t₂ l₁) (b : Acc t₂ t₃ l₂) :
    Acc t₁ t₃ (l₁ ++ l₂) := by
  refine ⟨by rw [b.log, a.log, List.append_assoc], Nat.le_trans a.regs b.regs, ?_, ?_, ?_, ?_, ?_,
    by simp⟩
  · rw [runs_append, List.nodup_append]
    refine ⟨a.once, b.once, fun i hi j hj e => ?_⟩
    subst e
    obtain ⟨_, hlt, hno⟩ := a.ran i hi
    rcases (b.ran i hj).1 with ⟨m, hm⟩ | hp | hge
    · exact hno m hm
    · simp at hp
    · omega
  · intro i hi
    rw [runs_append, List.mem_append] at hi
    rcases hi with hi | hi
    · obtain ⟨h1, h2, h3⟩ := a.ran i hi
      refine ⟨h1, Nat.lt_of_lt_of_le h2 b.regs, fun m hm => ?_⟩
      rcases b.kept m i hm with h | h
      · exact h3 m h
      · omega
    · obtain ⟨h1, h2, h3⟩ := b.ran i hi
      refine ⟨?_, h2, h3⟩
      rcases h1 with ⟨m, hm⟩ | hp | hge
      · rcases a.kept m i hm with h | h
        · exact .inl ⟨m, h⟩
        · exact .inr (.inr h)
      · simp at hp
      · exact .inr (.inr (Nat.le_trans a.regs hge))
  · intro m i hi
    rcases b.kept m i hi with h | h
    · exact a.kept m i h
    · exact .inr (Nat.le_trans a.regs h)
  · intro m i hi
    rw [List.mem_append] at hi
    rw [runs_append, List.mem_append]
    rcases hi with hi | hi | hi
    · rcases a.track m i (.inl hi) with h | h
      · rcases b.track m i (.inl h) with h' | h'
        · exact .inl h'
        · exact .inr (.inr h')
      · exact .inr (.inl h)
    · rcases a.track m i (.inr hi) with h | h
      · rcases b.track m i (.inl h) with h' | h'
        · exact .inl h'
        · exact .inr (.inr h')
      · exact .inr (.inl h)
    · rcases b.track m i (.inr hi) with h' | h'
      · exact .inl h'
      · exact .inr (.inr h')
  · intro i m hi
    rw [List.mem_append] at hi
    rcases hi with hi | hi
    · have := a.fresh i m hi; have := b.regs; omega
    · have := b.fresh i m hi; have := a.regs; omega

theorem ids_set (t : Tree) (o : Nat) (r : Scope) (m : Nat) :
    ids (t.set o r) m = if m = o then r.cleanups.map Prod.fst else ids t m := by
  by_cases e : m = o <;> simp [ids, e]

-- cleanup(f) with o open, alive: pushed, with a new id
theorem acc_push {t : Tree} (hD : Ids t) (o : Nat) (f : Code) :
    Ids ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).set o
      { (({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).scopes o with
        cleanups := ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).scopes o).cleanups
          ++ [(t.regs, f)] }) ∧
    Acc t ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).set o
      { (({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).scopes o with
        cleanups := ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).scopes o).cleanups
          ++ [(t.regs, f)] }) [.reg t.regs o] := by
  -- the ids after: o's, with t.regs at the end
  have hi : ∀ m, ids ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).set o
      { (({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).scopes o with
        cleanups := ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).scopes o).cleanups
          ++ [(t.regs, f)] }) m = if m = o then ids t o ++ [t.regs] else ids t m := by
    intro m; rw [ids_set]; by_cases e : m = o <;> simp [e, ids]
  have nb : ∀ m, t.regs ∉ ids t m := fun m h => by have := hD.below m _ h; omega
  constructor
  · refine ⟨fun m => ?_, fun m m' i a b => ?_, fun m i a => ?_, ?_, fun i a => ?_⟩
    · rw [hi]; by_cases e : m = o
      · simp only [e, ↓reduceIte, List.nodup_append]
        exact ⟨hD.nodup o, by simp, fun a ha b hb e => by simp at hb; subst hb; subst e; exact nb o ha⟩
      · simp [e, hD.nodup m]
    · rw [hi] at a b
      by_cases e : m = o <;> by_cases e' : m' = o
      · rw [e, e']
      · simp [e, e'] at a b; rcases a with a | a
        · exact absurd (hD.apart _ _ _ a b) (Ne.symm e')
        · subst a; exact absurd b (nb m')
      · simp [e, e'] at a b; rcases b with b | b
        · exact absurd (hD.apart _ _ _ a b) e
        · subst b; exact absurd a (nb m)
      · simp [e, e'] at a b; exact hD.apart _ _ _ a b
    · rw [hi] at a; simp
      by_cases e : m = o
      · simp [e] at a; rcases a with a | a
        · have := hD.below o i a; omega
        · omega
      · simp [e] at a; have := hD.below m i a; omega
    · simp [hD.once]
    · simp at a
      have ⟨h1, h2⟩ := hD.done i a
      refine ⟨by simp; omega, fun m hm => ?_⟩
      rw [hi] at hm
      by_cases e : m = o
      · simp [e] at hm; rcases hm with hm | hm
        · exact h2 o hm
        · omega
      · simp [e] at hm; exact h2 m hm
  · refine ⟨by simp, by simp, by simp, by simp, fun m i a => ?_, fun m i a => ?_,
      fun i m a => ?_, by simp⟩
    · rw [hi] at a
      by_cases e : m = o
      · simp [e] at a; rcases a with a | a
        · exact .inl (by rw [e]; exact a)
        · exact .inr (by omega)
      · simp [e] at a; exact .inl a
    · rw [hi]
      rcases a with a | a
      · left; by_cases e : m = o
        · subst e; simp [a]
        · simp [e, a]
      · simp at a; obtain ⟨rfl, rfl⟩ := a; left; simp
    · simp at a; obtain ⟨rfl, rfl⟩ := a; simp

-- cleanup(f) with o open, not alive: f runs now, with a new id
theorem acc_now {t : Tree} (hD : Ids t) (o : Nat) :
    Ids ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).note (.run t.regs)) ∧
    Acc t ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).note (.run t.regs))
      [.reg t.regs o, .run t.regs] := by
  have nb : ∀ m, t.regs ∉ ids t m := fun m h => by have := hD.below m _ h; omega
  have hi : ∀ m, ids ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs o)).note
      (.run t.regs)) m = ids t m := fun m => rfl
  constructor
  · refine ⟨fun m => by rw [hi]; exact hD.nodup m, fun m m' i a b => by
      rw [hi] at a b; exact hD.apart m m' i a b, fun m i a => by
      rw [hi] at a; have := hD.below m i a; simp; omega, ?_, fun i a => ?_⟩
    · simp only [note_log, runs_append, runs_reg, runs_run, List.append_nil]
      rw [List.nodup_append]
      refine ⟨hD.once, by simp, fun a ha b hb e => ?_⟩
      simp at hb; have := (hD.done a ha).1; omega
    · simp at a
      rcases a with a | a
      · have ⟨h1, h2⟩ := hD.done i a
        exact ⟨by simp; omega, fun m => by rw [hi]; exact h2 m⟩
      · subst a; exact ⟨by simp, fun m => by rw [hi]; exact nb m⟩
  · refine ⟨by simp, by simp, by simp, fun i a => ?_, fun m i a => .inl (by rw [← hi]; exact a),
      fun m i a => ?_, fun i m a => ?_, by simp⟩
    · simp at a; subst a
      exact ⟨.inr (.inr (Nat.le_refl _)), by simp, fun m => by rw [hi]; exact nb m⟩
    · rcases a with a | a
      · exact .inl (by rw [hi]; exact a)
      · simp at a; obtain ⟨rfl, rfl⟩ := a; exact .inr (by simp)
    · simp at a; obtain ⟨rfl, rfl⟩ := a; simp

-- grow(o): no cleanup moves
theorem ids_make {t : Tree} {i : List Pair} {c : Bool} {ctx : List Frame} {o : Nat} {t' : Tree} {n : Nat} (h : Inv t ctx)
    (hr : grow t (some o) i c = .ok (t', n)) : (∀ m, ids t' m = ids t m) ∧ t'.log = t.log ∧
    t'.regs = t.regs := by
  obtain ⟨-, rfl, rfl⟩ := grow_some_ok hr
  refine ⟨fun m => ?_, rfl, rfl⟩
  by_cases e : m = t.made + 1
  · subst e; simp [ids, h.fresh (t.made + 1) (by omega)]
  · by_cases e' : m = o
    · subst e'; simp [ids, e]
    · simp [ids, e, e']

-- root(): no cleanup moves
theorem ids_root_same {t : Tree} {i : List Pair} {c : Bool} {ctx : List Frame} {t' : Tree} {n : Nat}
    (h : Inv t ctx) (hr : grow t none i c = .ok (t', n)) :
    (∀ m, ids t' m = ids t m) ∧ t'.log = t.log ∧ t'.regs = t.regs := by
  obtain ⟨rfl, rfl⟩ := grow_none_ok hr
  refine ⟨fun m => ?_, rfl, rfl⟩
  by_cases e : m = t.made + 1
  · subst e; simp [ids, h.fresh (t.made + 1) (by omega)]
  · simp [ids, e]

theorem ids_root {t : Tree} {i : List Pair} {c : Bool} {ctx : List Frame} {t' : Tree} {n : Nat} (h : Inv t ctx) (hD : Ids t)
    (hr : grow t none i c = .ok (t', n)) : Ids t' :=
  let ⟨hi, hl, hr'⟩ := ids_root_same h hr
  hD.same hi hl hr'

-- a write: no cleanup moves
theorem acc_write {t : Tree} (hD : Ids t) (c : Option Current) :
    Ids (t.note (.write c)) ∧ Acc t (t.note (.write c)) [.write c] := by
  refine ⟨⟨hD.nodup, hD.apart, hD.below, by simpa using hD.once, fun i a => ?_⟩,
    ⟨by simp, by simp, by simp, fun i a => by simp at a, fun m i a => .inl a,
      fun m i a => ?_, fun i m a => by simp at a, by simp⟩⟩
  · simp at a; exact hD.done i a
  · rcases a with a | a
    · exact .inl a
    · simp at a

-- enter keeps what its f keeps: what is open is no part of Ids or Acc
theorem enter_once {b : Bracket} {t : Tree} {g : Tree → Result} {t' : Tree} {e : Option Err}
    (hg : ∀ t₁ e₁, g { t with opened := b :: t.opened } = some (t₁, e₁) →
      Ids t₁ ∧ ∃ l, Acc { t with opened := b :: t.opened } t₁ l)
    (h : enter b t g = some (t', e)) : Ids t' ∧ ∃ l, Acc t t' l := by
  obtain ⟨t₁, h₁, rfl⟩ := enter_some h
  obtain ⟨D, l, A⟩ := hg t₁ e h₁
  have A₀ : Acc t { t with opened := b :: t.opened } [] := Acc.same (fun _ => rfl) rfl rfl
  have A₂ : Acc t₁ { t₁ with opened := t.opened } [] := Acc.same (fun _ => rfl) rfl rfl
  exact ⟨D.same (fun _ => rfl) rfl rfl, _, (A₀.trans A).trans A₂⟩

-- dispose keeps Ids, and accounts for what it ran
def spec_once (n : Nat) : Prop := ∀ t x ctx t' e, Inv t ctx → Ids t → dispose n t x = some (t', e) →
  Ids t' ∧ ∃ l, Acc t t' l

theorem exec_once {n : Nat} (hB : spec_once n) : ∀ (c : Code) (t : Tree) (ctx : List Frame) (t' : Tree)
    (e : Option Err), Inv t ctx → Ids t → exec (dispose n) t c = some (t', e) →
    Ids t' ∧ ∃ l, Acc t t' l
  | .done, t, ctx, t', e, _, hD, h => by
    simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
  | .throw _, t, ctx, t', e, _, hD, h => by
    simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
  | .reg f k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
    rename_i b bs ho
    let t₁ := ({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)
    have I₁ : Inv t₁ ctx := hI.congr rfl rfl
    split at h
    · rename_i ha
      have I₂ := inv_cleanups ((t₁.scopes b.scope).cleanups ++ [(t.regs, f)]) I₁ (by rw [ha]; simp)
      obtain ⟨D₂, A₂⟩ := acc_push hD b.scope f
      obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e I₂ D₂ h
      exact ⟨D, _, A₂.trans A⟩
    · obtain ⟨t₂, e₂, h₂, h'⟩ := chain_some h
      have I₂ : Inv (t₁.note (.run t.regs)) ctx := I₁.congr rfl rfl
      obtain ⟨D₂, A₂⟩ := acc_now hD b.scope
      obtain ⟨D₃, l₃, A₃⟩ := enter_once (fun t₄ e₄ h₄ =>
        exec_once hB f _ ctx t₄ e₄ (I₂.opened _) (D₂.same (fun _ => rfl) rfl rfl) h₄) h₂
      rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
      · exact ⟨D₃, _, A₂.trans A₃⟩
      · have I₃ := (enter_keep (fun t₄ e₄ h₄ =>
          exec_keep (dispose_keep n) f _ ctx t₄ e₄ (I₂.opened _) h₄) h₂).1
        obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e I₃ D₃ h'
        exact ⟨D, _, (A₂.trans A₃).trans A⟩
  | .make p i k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have M := inv_make hI hq
      obtain ⟨hi, hl, hr'⟩ := ids_make hI hq
      obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e M.1 (hD.same hi hl hr') h
      exact ⟨D, _, (Acc.same hi hl hr').trans A⟩
  | .comp k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have M := inv_make hI hq
      obtain ⟨hi, hl, hr'⟩ := ids_make hI hq
      obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e M.1 (hD.same hi hl hr') h
      exact ⟨D, _, (Acc.same hi hl hr').trans A⟩
  | .root i k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
    · rename_i t₁ n₁ hr
      obtain ⟨hi, hl, hr'⟩ := ids_root_same hI hr
      obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e (inv_root hI hr) (hD.same hi hl hr') h
      exact ⟨D, _, (Acc.same hi hl hr').trans A⟩
  | .disp o k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    obtain ⟨t₁, e₁, h₁, h'⟩ := chain_some h
    obtain ⟨D₁, l₁, A₁⟩ := hB t o ctx t₁ e₁ hI hD h₁
    rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
    · exact ⟨D₁, _, A₁⟩
    · have I₁ := (dispose_keep n t o ctx t₁ e₁ hI h₁).1
      obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e I₁ D₁ h'
      exact ⟨D, _, A₁.trans A⟩
  | .run o f k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
    · obtain ⟨t₂, e₂, h₂, h'⟩ := chain_some h
      obtain ⟨D₂, l₂, A₂⟩ := enter_once (fun t₄ e₄ h₄ =>
        exec_once hB f _ ctx t₄ e₄ (hI.opened _) (hD.same (fun _ => rfl) rfl rfl) h₄) h₂
      rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
      · exact ⟨D₂, _, A₂⟩
      · have I₂ := (enter_keep (fun t₄ e₄ h₄ =>
          exec_keep (dispose_keep n) f _ ctx t₄ e₄ (hI.opened _) h₄) h₂).1
        obtain ⟨D, l, A⟩ := exec_once hB k _ ctx t' e I₂ D₂ h'
        exact ⟨D, _, A₂.trans A⟩
  | .write k, t, ctx, t', e, hI, hD, h => by
    simp only [exec] at h
    obtain ⟨D₁, A₁⟩ := acc_write hD (current t)
    obtain ⟨D, l, A⟩ := exec_once hB k (t.note (.write (current t))) ctx t' e (hI.congr rfl rfl) D₁ h
    exact ⟨D, _, A₁.trans A⟩

theorem kids_once {n : Nat} (hB : spec_once n) (p : Nat) (ctx : List Frame) :
    ∀ (ks : List Nat) (t : Tree) (f : Option Err) (t' : Tree) (e : Option Err),
    Inv t (.kids p ks :: ctx) → Ids t → each (dispose n) t ks f = some (t', e) →
    Ids t' ∧ ∃ l, Acc t t' l
  | [], t, f, t', e, _, hD, h => by
    simp [each] at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
  | k :: ks, t, f, t', e, hI, hD, h => by
    rw [each_cons] at h
    split at h
    · cases h
    rename_i t₁ e₁ h₁
    have P := dispose_keep n t k _ t₁ e₁ hI h₁
    obtain ⟨D₁, l₁, A₁⟩ := hB t k _ t₁ e₁ hI hD h₁
    obtain ⟨D, l, A⟩ := kids_once hB p ctx ks t₁ _ t' e (P.1.pop P.2.2) D₁ h
    exact ⟨D, _, A₁.trans A⟩

-- clean's second loop: the cleanups it took off o, held (P), each run once
-- the same for kids: the loop in o's bracket
theorem opened_once {n : Nat} (hB : spec_once n) (p : Nat) (ctx : List Frame) {o : Nat}
    (ks : List Nat) (t t' : Tree) (e : Option Err) (hI : Inv t (.kids p ks :: ctx)) (hD : Ids t)
    (h : kids (dispose n) o t ks = some (t', e)) : Ids t' ∧ ∃ l, Acc t t' l :=
  enter_once (fun t₁ e₁ h₁ => kids_once hB p ctx ks _ none t₁ e₁ (hI.opened _)
    (hD.same (fun _ => rfl) rfl rfl) h₁) h

theorem calls_once {n : Nat} (hB : spec_once n) (ctx : List Frame) (o : Nat) :
    ∀ (R : List (Nat × Code)) (t : Tree) (f : Option Err) (t' : Tree) (e : Option Err),
    Inv t ctx → Ids t → (R.map Prod.fst).Nodup →
    (∀ i ∈ R.map Prod.fst, (∀ m, i ∉ ids t m) ∧ i < t.regs ∧ i ∉ runs t.log) →
    each (call (dispose n) o) t R f = some (t', e) → Ids t' ∧ ∃ l, AccP (R.map Prod.fst) t t' l
  | [], t, f, t', e, _, hD, _, _, h => by
    simp [each] at h; obtain ⟨rfl, rfl⟩ := h
    exact ⟨hD, [], by simpa using (Acc.same (t := t) (t' := t) (fun _ => rfl) rfl rfl)⟩
  | (i, c) :: R, t, f, t', e, hI, hD, hn, hR, h => by
    rw [each_cons] at h
    split at h
    · cases h
    rename_i t₁ e₁ h₁
    simp only [List.map_cons, List.nodup_cons] at hn
    have hi := hR i List.mem_cons_self
    let t₀ := t.note (.run i)
    have D₀ : Ids t₀ := by
      refine ⟨hD.nodup, hD.apart, hD.below, ?_, fun j a => ?_⟩
      · simp only [t₀, note_log, runs_append, runs_run]
        rw [List.nodup_append]
        refine ⟨hD.once, by simp, fun a ha b hb e => ?_⟩
        simp at hb; subst hb; subst e; exact hi.2.2 ha
      · simp only [t₀, note_log, runs_append, runs_run, List.mem_append, List.mem_singleton] at a
        rcases a with a | rfl
        · exact hD.done j a
        · exact ⟨hi.2.1, hi.1⟩
    have I₀ : Inv t₀ ctx := hI.congr rfl rfl
    obtain ⟨D₁, l₁, A₁⟩ := enter_once (fun t₄ e₄ h₄ =>
      exec_once hB c _ ctx t₄ e₄ (I₀.opened _) (D₀.same (fun _ => rfl) rfl rfl) h₄) h₁
    have I₁ := (enter_keep (fun t₄ e₄ h₄ =>
      exec_keep (dispose_keep n) c _ ctx t₄ e₄ (I₀.opened _) h₄) h₁).1
    -- the rest of R: on no scope at t₁, not run, below regs
    have hR' : ∀ j ∈ R.map Prod.fst, (∀ m, j ∉ ids t₁ m) ∧ j < t₁.regs ∧ j ∉ runs t₁.log := by
      intro j hj
      have hj' := hR j (List.mem_cons_of_mem _ hj)
      refine ⟨fun m hm => ?_, Nat.lt_of_lt_of_le hj'.2.1 A₁.regs, ?_⟩
      · rcases A₁.kept m j hm with h | h
        · exact hj'.1 m h
        · simp [t₀] at h; omega
      · rw [A₁.log]
        simp only [t₀, note_log, runs_append, runs_run, List.mem_append, List.mem_singleton]
        rintro ((h | h) | h)
        · exact hj'.2.2 h
        · subst h; exact hn.1 hj
        · rcases (A₁.ran j h).1 with ⟨m, hm⟩ | hp | hge
          · exact hj'.1 m hm
          · simp at hp
          · simp [t₀] at hge; omega
    obtain ⟨D, l₂, A₂⟩ := calls_once hB ctx o R t₁ _ t' e I₁ D₁ hn.2 hR' h
    refine ⟨D, .run i :: l₁ ++ l₂, ?_⟩
    have ni₁ : ∀ m, i ∉ ids t₁ m := fun m hm => by
      rcases A₁.kept m i hm with h | h
      · exact hi.1 m h
      · simp [t₀] at h; omega
    have ni₂ : ∀ m, i ∉ ids t' m := fun m hm => by
      rcases A₂.kept m i hm with h | h
      · exact ni₁ m h
      · have := A₁.regs; simp [t₀] at this; omega
    have r₁ : i ∉ runs l₁ := fun h => by
      rcases (A₁.ran i h).1 with ⟨m, hm⟩ | hp | hge
      · exact hi.1 m hm
      · simp at hp
      · simp [t₀] at hge; omega
    refine ⟨?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · rw [A₂.log, A₁.log]; simp [t₀]
    · have := A₁.regs; have := A₂.regs; simp [t₀] at *; omega
    · simp only [List.cons_append, runs_cons_run, runs_append, List.nodup_cons, List.mem_append,
        not_or, List.nodup_append]
      refine ⟨⟨r₁, fun h => ?_⟩, A₁.once, A₂.once, fun a ha b hb e => ?_⟩
      · rcases (A₂.ran i h).1 with ⟨m, hm⟩ | hp | hge
        · exact ni₁ m hm
        · exact hn.1 hp
        · have := A₁.regs; have r₀ : t₀.regs = t.regs := rfl; omega
      · subst e
        obtain ⟨_, hlt, hno⟩ := A₁.ran a ha
        rcases (A₂.ran a hb).1 with ⟨m, hm⟩ | hp | hge
        · exact hno m hm
        · exact (hR' a hp).2.2 (by rw [A₁.log]; simp [ha])
        · omega
    · intro j hj
      simp only [List.cons_append, runs_cons_run, runs_append, List.mem_cons, List.mem_append] at hj
      rcases hj with rfl | hj | hj
      · exact ⟨.inr (.inl List.mem_cons_self), Nat.lt_of_lt_of_le hi.2.1
          (Nat.le_trans (by simp [t₀]) (Nat.le_trans A₁.regs A₂.regs)), ni₂⟩
      · obtain ⟨h1, h2, h3⟩ := A₁.ran j hj
        refine ⟨?_, Nat.lt_of_lt_of_le h2 A₂.regs, fun m hm => ?_⟩
        · rcases h1 with ⟨m, hm⟩ | hp | hge
          · exact .inl ⟨m, hm⟩
          · simp at hp
          · exact .inr (.inr (by simpa [t₀] using hge))
        · rcases A₂.kept m j hm with h | h
          · exact h3 m h
          · omega
      · obtain ⟨h1, h2, h3⟩ := A₂.ran j hj
        refine ⟨?_, h2, h3⟩
        rcases h1 with ⟨m, hm⟩ | hp | hge
        · rcases A₁.kept m j hm with h | h
          · exact .inl ⟨m, h⟩
          · exact .inr (.inr (by simpa [t₀] using h))
        · exact .inr (.inl (List.mem_cons_of_mem _ hp))
        · exact .inr (.inr (by have := A₁.regs; simp [t₀] at this; omega))
    · intro m j hj
      rcases A₂.kept m j hj with h | h
      · rcases A₁.kept m j h with h' | h'
        · exact .inl h'
        · exact .inr (by simpa [t₀] using h')
      · exact .inr (by have := A₁.regs; simp [t₀] at this; omega)
    · intro m j hj
      simp only [List.cons_append, runs_cons_run, runs_append, List.mem_cons, List.mem_append]
      rcases hj with hj | hj
      · rcases A₁.track m j (.inl hj) with h | h
        · rcases A₂.track m j (.inl h) with h' | h'
          · exact .inl h'
          · exact .inr (.inr (.inr h'))
        · exact .inr (.inr (.inl h))
      · simp only [List.cons_append, List.mem_cons, List.mem_append] at hj
        rcases hj with hj | hj | hj
        · cases hj
        · rcases A₁.track m j (.inr hj) with h | h
          · rcases A₂.track m j (.inl h) with h' | h'
            · exact .inl h'
            · exact .inr (.inr (.inr h'))
          · exact .inr (.inr (.inl h))
        · rcases A₂.track m j (.inr hj) with h' | h'
          · exact .inl h'
          · exact .inr (.inr (.inr h'))
    · intro j m hj
      simp only [List.cons_append, List.mem_cons, List.mem_append] at hj
      rcases hj with hj | hj | hj
      · cases hj
      · have := A₁.fresh j m hj; have := A₂.regs; simp [t₀] at *; omega
      · have := A₂.fresh j m hj; have := A₁.regs; simp [t₀] at *; omega
    · intro j hj
      simp only [List.map_cons, List.mem_cons] at hj
      simp only [List.cons_append, runs_cons_run, runs_append, List.mem_cons, List.mem_append]
      rcases hj with rfl | hj
      · exact .inl rfl
      · exact .inr (.inr (A₂.all j hj))

-- clean's second step: o's cleanups from the start-th on taken off, to be run
theorem Ids.cut {t : Tree} (h : Ids t) (o s : Nat) :
    Ids (t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take s }) := by
  have sub : ∀ m, (ids (t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take s }) m).Sublist
      (ids t m) := by
    intro m; rw [ids_set]; by_cases e : m = o
    · subst e; simp only [↓reduceIte, ids]; exact (List.take_sublist _ _).map _
    · simp [e]
  exact ⟨fun m => (h.nodup m).sublist (sub m), fun m m' i a b => h.apart m m' i ((sub m).mem a)
    ((sub m').mem b), fun m i a => h.below m i ((sub m).mem a), h.once,
    fun i a => ⟨(h.done i a).1, fun m hm => (h.done i a).2 m ((sub m).mem hm)⟩⟩

-- what the second loop runs: on no scope once taken off, not run before, ids below regs
theorem Ids.held {t : Tree} (h : Ids t) (o s : Nat) :
    let t' := t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take s }
    let R := ((t.scopes o).cleanups.drop s).reverse
    (R.map Prod.fst).Nodup ∧
    ∀ i ∈ R.map Prod.fst, (∀ m, i ∉ ids t' m) ∧ i < t'.regs ∧ i ∉ runs t'.log := by
  intro t' R
  have split := List.take_append_drop s ((t.scopes o).cleanups)
  have nd : (((t.scopes o).cleanups.take s).map Prod.fst ++
      ((t.scopes o).cleanups.drop s).map Prod.fst).Nodup := by
    rw [← List.map_append, split]; exact h.nodup o
  rw [List.nodup_append] at nd
  have mem : ∀ i ∈ R.map Prod.fst, i ∈ ids t o := by
    intro i hi
    simp only [R, List.map_reverse, List.mem_reverse] at hi
    rw [ids, ← split, List.map_append, List.mem_append]; exact .inr hi
  have nr : (R.map Prod.fst).Nodup := by
    simp only [R, List.map_reverse]
    exact List.nodup_iff_pairwise_ne.mpr
      (List.pairwise_reverse.mpr ((List.nodup_iff_pairwise_ne.mp nd.2.1).imp (fun h => Ne.symm h)))
  refine ⟨nr, fun i hi => ⟨fun m hm => ?_, h.below o i (mem i hi),
    fun hr => (h.done i hr).2 o (mem i hi)⟩⟩
  rw [ids_set] at hm
  by_cases e : m = o
  · subst e; simp only [↓reduceIte] at hm
    simp only [R, List.map_reverse, List.mem_reverse] at hi
    exact nd.2.2 i hm i hi rfl
  · simp [e] at hm; exact e (h.apart m o i hm (mem i hi))

theorem acc_cut {t t' : Tree} {o s : Nat} {l : List Event}
    (A : AccP ((((t.scopes o).cleanups.drop s).reverse).map Prod.fst)
      (t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take s }) t' l) :
    Acc t t' l := by
  have sub : ∀ m i, i ∈ ids (t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take s }) m →
      i ∈ ids t m := by
    intro m i hi; rw [ids_set] at hi; by_cases e : m = o
    · subst e; simp only [↓reduceIte] at hi; exact ((List.take_sublist _ _).map _).mem hi
    · simpa [e] using hi
  refine ⟨A.log, A.regs, A.once, fun i hi => ?_, fun m i hi => ?_, fun m i hi => ?_, A.fresh,
    by simp⟩
  · obtain ⟨h1, h2, h3⟩ := A.ran i hi
    refine ⟨?_, h2, h3⟩
    rcases h1 with ⟨m, hm⟩ | hp | hge
    · exact .inl ⟨m, sub m i hm⟩
    · simp only [List.map_reverse, List.mem_reverse, List.mem_map] at hp
      obtain ⟨x, hx, rfl⟩ := hp
      exact .inl ⟨o, by simp [ids]; exact ⟨x.2, by simpa using List.mem_of_mem_drop hx⟩⟩
    · exact .inr (.inr hge)
  · rcases A.kept m i hi with h | h
    · exact .inl (sub m i h)
    · exact .inr h
  · rcases hi with hi | hi
    · by_cases e : m = o
      · subst e
        have split := List.take_append_drop s ((t.scopes m).cleanups)
        rw [ids, ← split, List.map_append, List.mem_append] at hi
        rcases hi with hi | hi
        · exact A.track m i (.inl (by rw [ids_set]; simp only [↓reduceIte]; exact hi))
        · exact .inr (A.all i (by simpa using hi))
      · exact A.track m i (.inl (by rw [ids_set]; simpa [e] using hi))
    · exact A.track m i (.inr hi)

-- a set with the record already there
theorem set_same (t : Tree) (o : Nat) : t.set o (t.scopes o) = t := by
  unfold Tree.set; congr; funext m; by_cases e : m = o
  · subst e; simp
  · simp [e]

theorem inv_take {t : Tree} {ctx : List Frame} (h : Inv t ctx) (o s : Nat) :
    Inv (t.set o { t.scopes o with cleanups := (t.scopes o).cleanups.take s }) ctx := by
  by_cases hg : (t.scopes o).state = .gone
  · have e : ({ t.scopes o with cleanups := (t.scopes o).cleanups.take s } : Scope) = t.scopes o := by
      have := (h.gone o hg).2
      cases hr : t.scopes o; simp_all
    rw [e, set_same]; exact h
  · exact inv_cleanups _ h hg

-- clean keeps Ids, and accounts for what it ran
theorem clean_once {n : Nat} (hB : spec_once n) (t : Tree) (o a s : Nat) (ctx : List Frame) (t' : Tree)
    (e : Option Err) (hI : Inv t ctx) (hD : Ids t) (hg : (t.scopes o).state ≠ .gone)
    (h : clean (dispose n) t o a s = some (t', e)) : Ids t' ∧ ∃ l, Acc t t' l := by
  unfold clean at h
  split at h
  · cases h
  rename_i t₃ f₃ h₃
  have I₂ := inv_cut (o := o) a hI hg
  have same₂ : ∀ m, ids (t.set o { t.scopes o with children := kept (t.scopes o).children a }) m =
      ids t m := fun m => by rw [ids_set]; by_cases e : m = o <;> simp [e, ids]
  have D₂ := hD.same same₂ rfl rfl
  obtain ⟨D₃, l₃, A₃⟩ := opened_once hB o ctx _ _ t₃ f₃ I₂ D₂ h₃
  have I₃ := (opened_keep (dispose_keep n) o ctx _ _ t₃ f₃ I₂ h₃).1.drop
  have I₃' := inv_take I₃ o s
  obtain ⟨hn, hR⟩ := D₃.held o s
  obtain ⟨D₄, l₄, A₄⟩ := calls_once hB ctx o _ _ f₃ t' e I₃' (D₃.cut o s) hn hR h
  exact ⟨D₄, _, ((Acc.same same₂ rfl rfl).trans A₃).trans (acc_cut A₄)⟩

theorem unlink_log (t : Tree) (x : Nat) : (unlink t x).log = t.log := by
  unfold unlink; split <;> rfl

theorem unlink_regs (t : Tree) (x : Nat) : (unlink t x).regs = t.regs := by
  unfold unlink; split <;> rfl

theorem unlink_ids (t : Tree) (x m : Nat) : ids (unlink t x) m = ids t m := by
  unfold unlink; split
  · rfl
  · rename_i q _; rw [ids_set]; by_cases e : m = q <;> simp [e, ids]

theorem dispose_once : ∀ n, spec_once n
  | 0 => by intro t x ctx t' e _ _ h; simp [dispose] at h
  | n + 1 => by
    intro t x ctx t' e hI hD h
    have hB := dispose_once n
    by_cases ha : (t.scopes x).state ≠ .alive
    · simp [dispose, ha] at h; obtain ⟨rfl, rfl⟩ := h
      exact ⟨hD, [], Acc.same (fun _ => rfl) rfl rfl⟩
    simp only [ne_eq, Decidable.not_not] at ha
    unfold dispose at h
    simp only [ha, ne_eq, not_true_eq_false, ↓reduceIte] at h
    split at h
    · simp at h
    rename_i t₄ e₄ h₄
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    obtain ⟨rfl, rfl⟩ := h
    have I₁ := inv_disposing hI ha
    have same₁ : ∀ m, ids (t.set x { t.scopes x with state := .disposing }) m = ids t m :=
      fun m => by rw [ids_set]; by_cases e : m = x <;> simp [e, ids]
    obtain ⟨D₄, l, A⟩ := clean_once hB _ x 0 0 _ t₄ e₄ I₁ (hD.same same₁ rfl rfl) (by simp) h₄
    have same₅ : ∀ m, ids (unlink (t₄.set x { t₄.scopes x with state := .gone }) x) m = ids t₄ m :=
      fun m => by rw [unlink_ids, ids_set]; by_cases e : m = x <;> simp [e, ids]
    have hl : (unlink (t₄.set x { t₄.scopes x with state := .gone }) x).log = t₄.log := by
      rw [unlink_log]; rfl
    have hr : (unlink (t₄.set x { t₄.scopes x with state := .gone }) x).regs = t₄.regs := by
      rw [unlink_regs]; rfl
    exact ⟨D₄.same same₅ hl hr, _, ((Acc.same same₁ rfl rfl).trans A).trans (Acc.same same₅ hl hr)⟩

-- under, forward: what is under o before a call is under it after
theorem Mono.fwd {t t' : Tree} {ctx : List Frame} (M : Mono t t') (hI : Inv t ctx)
    {o m : Nat} (h : under t o m) : under t' o m := by
  induction h with
  | refl => exact .refl
  | @step m' p hp _ ih =>
    have hm : m' ≤ t.made := by
      by_cases hlt : t.made < m'
      · rw [hI.fresh m' hlt] at hp; cases hp
      · omega
    exact .step (by rw [M.parent m' hm]; exact hp) ih

-- 6 (b), at the top: every cleanup registered under o, before dispose(o) or during it, runs
-- exactly once by the time it returns (l: the log it adds). and Ids holds after: no cleanup ever
-- runs twice
theorem six_b (n : Nat) (t : Tree) (o : Nat) (t' : Tree) (e : Option Err) (hI : Inv t [])
    (hD : Ids t) (h : dispose n t o = some (t', e)) :
    Ids t' ∧ ∃ l, t'.log = t.log ++ l ∧
      ∀ i, ((∃ m, under t o m ∧ i ∈ ids t m) ∨ (∃ m, under t' o m ∧ Event.reg i m ∈ l)) →
        (runs t'.log).count i = 1 := by
  obtain ⟨D, l, A⟩ := dispose_once n t o [] t' e hI hD h
  obtain ⟨I', M, _⟩ := dispose_keep n t o [] t' e hI h
  obtain ⟨_, C, _⟩ := six_c n t o t' e hI h
  refine ⟨D, l, A.log, fun i hi => ?_⟩
  -- it ran in l
  have hr : i ∈ runs l := by
    rcases hi with ⟨m, hm, hi⟩ | ⟨m, hm, hi⟩
    · rcases A.track m i (.inl hi) with h' | h'
      · have := (C m (M.fwd hI hm)).2.2
        simp [ids, this] at h'
      · exact h'
    · rcases A.track m i (.inr hi) with h' | h'
      · have := (C m hm).2.2
        simp [ids, this] at h'
      · exact h'
  -- and not before
  have hn : i ∉ runs t.log := by
    intro h'
    obtain ⟨hlt, hno⟩ := hD.done i h'
    rcases hi with ⟨m, _, hi⟩ | ⟨m, _, hi⟩
    · exact hno m hi
    · have := (A.fresh i m hi).1; omega
  rw [A.log, runs_append, List.count_append, List.count_eq_zero_of_not_mem hn,
    List.Nodup.count A.once]
  simp [hr]

/-! ## the rest of 6 (b), and the scope open: what scope, make and cleanup do -/

-- grow(p) (and so scope, compute, effect) under a disposing or gone scope throws disposed
theorem grow_throws (t : Tree) (p : Nat) (i : List Pair) (c : Bool) (h : (t.scopes p).state ≠ .alive) :
    grow t (some p) i c = .error .disposed := by
  simp [grow, h]

-- what grow makes under p: the next number, p its parent and the last of p's children, alive,
-- with the info and kind given; nothing else changes
theorem grow_some {t : Tree} {ctx : List Frame} {p : Nat} {i : List Pair} {c : Bool} {t' : Tree}
    {m : Nat} (hI : Inv t ctx) (h : grow t (some p) i c = .ok (t', m)) :
    m = t.made + 1 ∧ t'.made = m ∧
    t'.scopes m = { parent := some p, state := .alive, info := .under i (t.scopes p).info, comp := c } ∧
    (t'.scopes p).children = (t.scopes p).children ++ [m] ∧ (t.scopes p).state = .alive ∧
    (∀ x, x ≠ m → x ≠ p → t'.scopes x = t.scopes x) ∧ t'.regs = t.regs ∧ t'.log = t.log ∧
    t'.opened = t.opened := by
  obtain ⟨ha, rfl, rfl⟩ := grow_some_ok h
  have hp := hI.alive_made (by rw [ha]; simp)
  refine ⟨rfl, rfl, by simp, ?_, ha, fun x hx hx' => by simp [hx, hx'], rfl, rfl, rfl⟩
  simp [show p ≠ t.made + 1 by omega]

-- in code: scope(info, p) under a scope not alive throws, the tree as it was
theorem make_throws (d : Tree → Nat → Result) (t : Tree) (p : Nat) (i : List Pair) (k : Code)
    (h : (t.scopes p).state ≠ .alive) : exec d t (.make (some p) i k) = some (t, some .disposed) := by
  simp [exec, scope, grow_throws t p i false h]

-- the same under the scope open, not alive: scope(info), compute, effect
theorem open_throws (d : Tree → Nat → Result) (t : Tree) (b : Bracket) (bs : List Bracket)
    (ho : t.opened = b :: bs) (h : (t.scopes b.scope).state ≠ .alive) (i : List Pair) (k : Code) :
    exec d t (.make none i k) = some (t, some .disposed) ∧ exec d t (.comp k) = some (t, some .disposed) := by
  simp [exec, scope, ho, grow_throws t b.scope _ _ h]

-- nothing open: scope(info), compute, effect and cleanup throw unscoped, and change nothing
-- (root and scope(info, parent) need nothing open)
theorem unscoped (d : Tree → Nat → Result) (t : Tree) (ho : t.opened = []) (i : List Pair) (f k : Code) :
    exec d t (.make none i k) = some (t, some .unscoped) ∧
    exec d t (.comp k) = some (t, some .unscoped) ∧
    exec d t (.reg f k) = some (t, some .unscoped) := by
  simp [exec, scope, ho]

-- scope(info) with b open: made as grow makes it under b's scope
theorem make_open (d : Tree → Nat → Result) (t : Tree) (b : Bracket) (bs : List Bracket)
    (ho : t.opened = b :: bs) (i : List Pair) (k : Code) :
    exec d t (.make none i k) = match grow t (some b.scope) i false with
      | .error e => some (t, some e)
      | .ok (t, _) => exec d t k := by
  simp [exec, scope, ho]

-- compute, effect with b open: a computation, made as grow makes it under b's scope
theorem comp_open (d : Tree → Nat → Result) (t : Tree) (b : Bracket) (bs : List Bracket)
    (ho : t.opened = b :: bs) (k : Code) :
    exec d t (.comp k) = match grow t (some b.scope) [] true with
      | .error e => some (t, some e)
      | .ok (t, _) => exec d t k := by
  simp [exec, scope, ho]

theorem chain_done (r : Result) : chain r (fun t => some (t, none)) = r := by
  match r with
  | none => rfl
  | some (t, none) => rfl
  | some (t, some e) => rfl

-- cleanup(f) with b open, its scope not alive: f runs now, with that scope open (its
-- registration and its run logged)
theorem cleanup_now (d : Tree → Nat → Result) (t : Tree) (b : Bracket) (bs : List Bracket)
    (ho : t.opened = b :: bs) (f : Code) (h : (t.scopes b.scope).state ≠ .alive) :
    cleanup d t f = enter (opens t b.scope) ((({ t with regs := t.regs + 1 } : Tree).note
      (.reg t.regs b.scope)).note (.run t.regs)) (fun t => exec d t f) := by
  have h' : ¬ ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)).scopes
      b.scope).state = .alive := by simpa using h
  simp only [cleanup, exec]
  split
  · rename_i e; rw [ho] at e; cases e
  rename_i b' bs' e
  rw [ho] at e; cases e
  simp only [h', ↓reduceIte]
  exact chain_done _

-- cleanup(f) with b open, its scope alive: pushed on it, to run when it is cleaned or disposed
theorem cleanup_push (d : Tree → Nat → Result) (t : Tree) (b : Bracket) (bs : List Bracket)
    (ho : t.opened = b :: bs) (f : Code) (h : (t.scopes b.scope).state = .alive) :
    cleanup d t f = some ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)).set
      b.scope { t.scopes b.scope with cleanups := (t.scopes b.scope).cleanups ++ [(t.regs, f)] },
      none) := by
  have h' : ((({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)).scopes
      b.scope).state = .alive := by simpa using h
  simp only [cleanup, exec]
  split
  · rename_i e; rw [ho] at e; cases e
  rename_i b' bs' e
  rw [ho] at e; cases e
  simp only [h', ↓reduceIte]
  simp [h]

/-! ## the invariants hold between calls -/

theorem inv_empty : Inv empty [] :=
  ⟨fun _ _ => rfl, fun _ _ h => by simp [empty] at h, fun _ _ h => by simp [empty] at h,
    fun _ => by simp [empty], fun _ _ h => by simp [empty] at h, fun _ h => by simp [empty] at h,
    fun _ _ => by simp [empty], fun _ _ h => by simp [empty] at h⟩

theorem ids_empty : Ids empty :=
  ⟨fun _ => by simp [ids, empty], fun _ _ _ h => by simp [ids, empty] at h,
    fun _ _ h => by simp [ids, empty] at h, by simp [empty, runs], fun _ h => by simp [empty, runs] at h⟩

-- clean(o, after, from) at the top (before a compute's run, an effect's run or act: o alive)
theorem clean_keep (n : Nat) (t : Tree) (o a s : Nat) (ctx : List Frame) (t' : Tree) (e : Option Err)
    (hI : Inv t ctx) (ha : (t.scopes o).state = .alive)
    (h : clean (dispose n) t o a s = some (t', e)) : Inv t' ctx ∧ Mono t t' := by
  unfold clean at h
  split at h
  · cases h
  rename_i t₃ f₃ h₃
  have I₂ := inv_cut (o := o) a hI (by rw [ha]; simp)
  have M₂ : Mono t _ := mono_set t o { t.scopes o with children := kept (t.scopes o).children a }
    rfl (fun hs => absurd ha hs)
  have K := opened_keep (dispose_keep n) o ctx _ _ t₃ f₃ I₂ h₃
  have I₃' := inv_take K.1.drop o s
  have L := calls_keep (exec_keep (dispose_keep n)) ctx o _ _ f₃ t' e I₃' h
  exact ⟨L.1, ((M₂.trans K.2).set_alive o { t₃.scopes o with cleanups := (t₃.scopes o).cleanups.take s }
    rfl ha).trans L.2⟩

-- the invariants, from the start (empty) through any sequence of calls at the top
theorem top_grow {i : List Pair} {c : Bool} {t t' : Tree} {p : Option Nat} {n : Nat} (hI : Inv t []) (hD : Ids t)
    (h : grow t p i c = .ok (t', n)) : Inv t' [] ∧ Ids t' := by
  cases p with
  | none => exact ⟨inv_root hI h, ids_root hI hD h⟩
  | some q =>
    obtain ⟨hi, hl, hr⟩ := ids_make hI h
    exact ⟨(inv_make hI h).1, hD.same hi hl hr⟩

theorem top_cleanup {n : Nat} {t t' : Tree} {f : Code} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (h : cleanup (dispose n) t f = some (t', e)) : Inv t' [] ∧ Ids t' :=
  ⟨(exec_keep (dispose_keep n) _ t [] t' e hI h).1, (exec_once (dispose_once n) _ t [] t' e hI hD h).1⟩

theorem top_dispose {n : Nat} {t t' : Tree} {o : Nat} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (h : dispose n t o = some (t', e)) : Inv t' [] ∧ Ids t' :=
  ⟨(dispose_keep n t o [] t' e hI h).1, (dispose_once n t o [] t' e hI hD h).1⟩

theorem top_clean {n : Nat} {t t' : Tree} {o a s : Nat} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (ha : (t.scopes o).state = .alive) (h : clean (dispose n) t o a s = some (t', e)) :
    Inv t' [] ∧ Ids t' :=
  ⟨(clean_keep n t o a s [] t' e hI ha h).1, (clean_once (dispose_once n) t o a s [] t' e hI hD (by rw [ha]; simp) h).1⟩

/-! ## fuel does not matter -/

-- what d gives, d' gives too
def below (d d' : Tree → Nat → Result) : Prop := ∀ t x r, d t x = some r → d' t x = some r

theorem chain_below {r r' : Result} {k k' : Tree → Result} (hr : ∀ x, r = some x → r' = some x)
    (hk : ∀ t x, k t = some x → k' t = some x) (x : Tree × Option Err)
    (h : chain r k = some x) : chain r' k' = some x := by
  obtain ⟨t', e⟩ := x
  obtain ⟨t₁, e₁, h₁, h'⟩ := chain_some h
  rw [hr _ h₁]
  rcases h' with ⟨hne, ht, he⟩ | ⟨he, h'⟩
  · rw [ht, he]
    cases e₁ with
    | none => exact absurd rfl hne
    | some e₁ => rfl
  · rw [he]; exact hk t₁ _ h'

theorem enter_below {b : Bracket} {t : Tree} {g g' : Tree → Result}
    (hg : ∀ x, g { t with opened := b :: t.opened } = some x →
      g' { t with opened := b :: t.opened } = some x)
    (r : Tree × Option Err) (h : enter b t g = some r) : enter b t g' = some r := by
  obtain ⟨t', e⟩ := r
  obtain ⟨t₁, h₁, rfl⟩ := enter_some h
  simp [enter, hg _ h₁]

theorem exec_below {d d' : Tree → Nat → Result} (h : below d d') :
    ∀ (c : Code) (t : Tree) (r : Tree × Option Err), exec d t c = some r → exec d' t c = some r
  | .done, _, _, hr => hr
  | .throw _, _, _, hr => hr
  | .reg f k, t, r, hr => by
    rcases ho : t.opened with _ | ⟨b, bs⟩
    · simp only [exec, ho] at hr ⊢; exact hr
    simp only [exec, ho] at hr ⊢
    split at hr
    · split
      · exact exec_below h k _ r hr
      · contradiction
    · split
      · contradiction
      · exact chain_below (fun x hx => enter_below (fun y hy => exec_below h f _ y hy) x hx)
          (fun t x hx => exec_below h k t x hx) r hr
  | .make p i k, t, r, hr => by
    simp only [exec] at hr ⊢
    split at hr
    · exact hr
    · exact exec_below h k _ r hr
  | .comp k, t, r, hr => by
    simp only [exec] at hr ⊢
    split at hr
    · exact hr
    · exact exec_below h k _ r hr
  | .root i k, t, r, hr => by
    simp only [exec] at hr ⊢
    split at hr
    · exact hr
    · exact exec_below h k _ r hr
  | .disp o k, t, r, hr => by
    simp only [exec] at hr ⊢
    exact chain_below (fun x hx => h t o x hx) (fun t x hx => exec_below h k t x hx) r hr
  | .run o f k, t, r, hr => by
    simp only [exec] at hr ⊢
    split at hr
    · split
      · exact hr
      · contradiction
    · split
      · contradiction
      · exact chain_below (fun x hx => enter_below (fun y hy => exec_below h f _ y hy) x hx)
          (fun t x hx => exec_below h k t x hx) r hr
  | .write k, t, r, hr => by
    simp only [exec] at hr ⊢
    exact exec_below h k _ r hr

theorem each_below {α : Type} {step step' : Tree → α → Result}
    (h : ∀ t x r, step t x = some r → step' t x = some r) :
    ∀ (xs : List α) (t : Tree) (f : Option Err) (r : Tree × Option Err),
    each step t xs f = some r → each step' t xs f = some r
  | [], _, _, _, hr => hr
  | x :: xs, t, f, r, hr => by
    rw [each_cons] at hr ⊢
    split at hr
    · cases hr
    rename_i t₁ e₁ h₁
    rw [h t x _ h₁]
    exact each_below h xs _ _ r hr

theorem clean_below {d d' : Tree → Nat → Result} (h : below d d') (t : Tree) (o a s : Nat)
    (r : Tree × Option Err) (hr : clean d t o a s = some r) : clean d' t o a s = some r := by
  unfold clean kids at hr ⊢
  split at hr
  · cases hr
  rename_i t₃ f₃ h₃
  rw [enter_below (fun y hy => each_below h _ _ _ y hy) _ h₃]
  exact each_below (fun t x r hx => enter_below (fun y hy => exec_below h x.2 _ y hy) r hx) _ _ _ r hr

theorem dispose_below : ∀ n, below (dispose n) (dispose (n + 1))
  | 0 => fun _ _ _ h => by simp [dispose] at h
  | n + 1 => fun t x r h => by
    unfold dispose at h ⊢
    split at h
    · split
      · exact h
      · contradiction
    · split
      · contradiction
      split at h
      · cases h
      rename_i t₄ e₄ h₄
      rw [clean_below (dispose_below n) _ _ _ _ _ h₄]
      exact h

-- more fuel, the same result
theorem dispose_fuel {n m : Nat} (hm : n ≤ m) (t : Tree) (x : Nat) (r : Tree × Option Err)
    (h : dispose n t x = some r) : dispose m t x = some r := by
  induction hm with
  | refl => exact h
  | step _ ih => exact dispose_below _ t x r ih

/-! ## 6 (a) and clean, at the top -/

-- the cleanups dispose(o) runs, in order: D(o) of proof.md §9
def trace (t : Tree) (o : Nat) : List (Nat × Code) := fold (t.made + 1) t o

theorem fold_succ {t : Tree} {ctx : List Frame} (h : Inv t ctx) :
    ∀ n k, t.made < k + n → fold (n + 1) t k = fold n t k
  | 0, k, hk => by simp [fold, h.fresh k (by omega)]
  | n + 1, k, hk => by
    simp only [fold]
    split
    · congr 1
      apply flat_congr
      intro c hc
      rw [List.mem_reverse] at hc
      have := h.older _ _ (h.par k c hc)
      exact fold_succ h n c (by omega)
    · rfl

theorem fold_stable {t : Tree} {ctx : List Frame} (h : Inv t ctx) (k : Nat) :
    ∀ n, t.made < n → fold n t k = trace t k
  | 0, hn => by omega
  | n + 1, hn => by
    by_cases e : n = t.made
    · subst e; rfl
    · rw [fold_succ h n k (by omega), fold_stable h k n (by omega)]

-- D(o)'s equation: children newest first, each fully, then o's cleanups newest first
theorem trace_eq {t : Tree} {ctx : List Frame} (h : Inv t ctx) (o : Nat) :
    trace t o = if (t.scopes o).state = .alive then
      (t.scopes o).children.reverse.flatMap (trace t) ++ (t.scopes o).cleanups.reverse else [] := by
  unfold trace
  simp only [fold]
  split
  · congr 1
    apply flat_congr
    intro c hc
    rw [List.mem_reverse] at hc
    have := h.older _ _ (h.par o c hc)
    exact (fold_succ h t.made c (by omega)).symm
  · rfl

theorem reach_alive {t : Tree} (h : Inv t []) {o m : Nat} (hr : reach t o m)
    (ha : (t.scopes o).state = .alive) : (t.scopes m).state = .alive := by
  induction hr with
  | refl => exact ha
  | @step o c m hc _ ih =>
    apply ih
    match hs : (t.scopes c).state with
    | .alive => rfl
    | .disposing => have := h.framed c hs; simp at this
    | .gone => exact absurd hs (h.listed o c hc)

theorem Inv.tidy {t : Tree} (h : Inv t []) {o : Nat} (ha : (t.scopes o).state = .alive)
    (hq : ∀ m, reach t o m → ∀ x ∈ (t.scopes m).cleanups, x.2.inert) : tidy t o :=
  ⟨fun _ hm => reach_alive h hm ha, fun m c _ hc => h.par m c hc, fun m _ => h.sorted m, hq⟩

-- 6 (a), at the top: o alive, the cleanups under it touch nothing. with fuel past mu and made,
-- dispose(o) returns, having run D(o) = trace t o in order, every one even when some throw; it
-- throws D(o)'s first error; what was reached is wiped, o is out of its parent's children, the
-- rest is as it was
theorem six_a (t : Tree) (o : Nat) (hI : Inv t []) (ha : (t.scopes o).state = .alive)
    (hq : ∀ m, reach t o m → ∀ x ∈ (t.scopes m).cleanups, x.2.inert) (n : Nat) (hn : mu t < n)
    (hm : t.made < n) : ∃ t' e, dispose n t o = some (t', e) ∧ follows (trace t o) t o t' e := by
  obtain ⟨t', e, h, _⟩ := dispose_ends n t o [] hI hn
  have R := dispose_inert n t o t' e hI.older (hI.tidy ha hq) h
  rw [fold_stable hI o n hm] at R
  exact ⟨t', e, h, R⟩

theorem clean_ends (n : Nat) (t : Tree) (o a s : Nat) (ctx : List Frame) (hI : Inv t ctx)
    (ha : (t.scopes o).state = .alive) (hn : mu t < n) :
    ∃ t' e, clean (dispose n) t o a s = some (t', e) := by
  have ho := hI.alive_made (by rw [ha]; simp)
  unfold clean
  have I₂ := inv_cut (o := o) a hI (by rw [ha]; simp)
  have m₂ := mu_children t o (kept (t.scopes o).children a) ho
  obtain ⟨t₃, f₃, h₃, hm₃⟩ := opened_ends (dispose_ends n) o ctx o _ _ I₂ (by omega)
  rw [h₃]
  have K := opened_keep (dispose_keep n) o ctx _ _ t₃ f₃ I₂ h₃
  have I₃' := inv_take K.1.drop o s
  have ho₃ : o ≤ t₃.made := Nat.le_trans ho K.2.made
  have m₃ := mu_cleanups t₃ o ((t₃.scopes o).cleanups.take s) ho₃
  have sp : (((t₃.scopes o).cleanups).map (fun x => x.2.size)).sum =
      (((t₃.scopes o).cleanups.take s).map (fun x => x.2.size)).sum +
      (((t₃.scopes o).cleanups.drop s).map (fun x => x.2.size)).sum := by
    rw [← List.sum_append, ← List.map_append, List.take_append_drop]
  obtain ⟨t', e, h, _⟩ := calls_ends (dispose_ends n) ctx o ((t₃.scopes o).cleanups.drop s).reverse _ f₃ I₃'
    (by simp only [List.map_reverse, List.sum_reverse] at m₂ m₃ hm₃ ⊢; omega)
  exact ⟨t', e, h⟩

-- clean(o, after, from) at the top, its cleanups touching nothing (3): with fuel past mu and
-- made it returns, having disposed the children made after the after-th, newest first, each
-- fully (D of each), then run the cleanups from the from-th on, newest first; the first error;
-- o stays, with the other children and the first from cleanups; what the gone children reached
-- is wiped, the rest is as it was
theorem clean_after (t : Tree) (o after start : Nat) (hI : Inv t []) (ha : (t.scopes o).state = .alive)
    (hq : ∀ m, reach t o m → ∀ x ∈ (t.scopes m).cleanups, x.2.inert) (n : Nat) (hn : mu t < n)
    (hm : t.made < n) :
    ∃ t' e, clean (dispose n) t o after start = some (t', e) ∧
    let gone := ((t.scopes o).children.filter (· > after)).reverse.flatMap (trace t) ++
      ((t.scopes o).cleanups.drop start).reverse
    t'.log = t.log ++ gone.map (fun x => Event.run x.1) ∧
    e = first (gone.map (fun x => x.2.out)) ∧
    t'.scopes o = { t.scopes o with
      children := (t.scopes o).children.filter (fun c => !(c > after)),
      cleanups := (t.scopes o).cleanups.take start } ∧
    (∀ m, ∀ c ∈ (t.scopes o).children, c > after → reach t c m → t'.scopes m = (t.scopes m).wipe) ∧
    (∀ m, m ≠ o → (∀ c ∈ (t.scopes o).children, c > after → ¬ reach t c m) →
      t'.scopes m = t.scopes m) := by
  obtain ⟨t', e, h⟩ := clean_ends n t o after start [] hI ha hn
  obtain ⟨l, er, ho, w, r, _, _⟩ := clean_inert n t o after start t' e hI.older (hI.tidy ha hq) h
  have fl : ((t.scopes o).children.filter (· > after)).reverse.flatMap (fold n t) =
      ((t.scopes o).children.filter (· > after)).reverse.flatMap (trace t) :=
    flat_congr (fun c _ => fold_stable hI c n hm)
  rw [fl] at l er
  exact ⟨t', e, h, l, er, ho, w, r⟩

/-! ## what is open: brackets are balanced -/

-- what is open after r, returned or thrown, is what was open in t
def flat (t : Tree) (r : Result) : Prop := ∀ x, r = some x → x.1.opened = t.opened

-- enter puts back what was open, whatever f did: its finally
theorem enter_flat (b : Bracket) (t : Tree) (g : Tree → Result) : flat t (enter b t g) := by
  intro x h
  obtain ⟨t', e⟩ := x
  obtain ⟨t₁, _, rfl⟩ := enter_some h
  rfl

theorem chain_flat {t : Tree} {r : Result} {k : Tree → Result} (hr : flat t r)
    (hk : ∀ t', t'.opened = t.opened → flat t' (k t')) : flat t (chain r k) := by
  intro x h
  obtain ⟨t', e⟩ := x
  obtain ⟨t₁, e₁, h₁, h'⟩ := chain_some h
  have e₁' := hr _ h₁
  rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
  · exact e₁'
  · exact (hk t₁ e₁' _ h').trans e₁'

theorem exec_flat {d : Tree → Nat → Result} (hd : ∀ t o, flat t (d t o)) :
    ∀ (c : Code) (t : Tree), flat t (exec d t c)
  | .done, t => by intro x h; simp [exec] at h; subst h; rfl
  | .throw _, t => by intro x h; simp [exec] at h; subst h; rfl
  | .reg f k, t => by
    intro x h
    simp only [exec] at h
    split at h
    · simp at h; subst h; rfl
    split at h
    · have := exec_flat hd k _ x h; exact this
    · have := chain_flat (enter_flat _ _ _) (fun t' e => by
        intro y hy; rw [exec_flat hd k t' y hy, e]) x h
      exact this
  | .make p i k, t => by
    intro x h
    simp only [exec] at h
    split at h
    · simp at h; subst h; rfl
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have : t₁.opened = t.opened := by
        obtain ⟨-, rfl, rfl⟩ := grow_some_ok hq; rfl
      rw [exec_flat hd k t₁ x h, this]
  | .comp k, t => by
    intro x h
    simp only [exec] at h
    split at h
    · simp at h; subst h; rfl
    · rename_i t₁ n₁ hr
      obtain ⟨q, hq⟩ := scope_ok hr
      have : t₁.opened = t.opened := by
        obtain ⟨-, rfl, rfl⟩ := grow_some_ok hq; rfl
      rw [exec_flat hd k t₁ x h, this]
  | .root i k, t => by
    intro x h
    simp only [exec] at h
    split at h
    · simp at h; subst h; rfl
    · rename_i t₁ n₁ hr
      have : t₁.opened = t.opened := by
        obtain ⟨rfl, rfl⟩ := grow_none_ok hr; rfl
      rw [exec_flat hd k t₁ x h, this]
  | .disp o k, t => by
    intro x h
    simp only [exec] at h
    exact chain_flat (hd t o) (fun t' e => by intro y hy; rw [exec_flat hd k t' y hy, e]) x h
  | .run o f k, t => by
    intro x h
    simp only [exec] at h
    split at h
    · simp at h; subst h; rfl
    · exact chain_flat (enter_flat _ _ _) (fun t' e => by
        intro y hy; rw [exec_flat hd k t' y hy, e]) x h
  | .write k, t => by
    intro x h
    simp only [exec] at h
    rw [exec_flat hd k _ x h]; rfl

theorem each_flat {α : Type} {step : Tree → α → Result} (hs : ∀ t x, flat t (step t x)) :
    ∀ (xs : List α) (t : Tree) (f : Option Err), flat t (each step t xs f)
  | [], t, f => by intro x h; simp [each] at h; subst h; rfl
  | x :: xs, t, f => by
    intro y h
    rw [each_cons] at h
    split at h
    · cases h
    rename_i t₁ e₁ h₁
    rw [each_flat hs xs t₁ _ y h, hs t x _ h₁]

theorem call_flat (d : Tree → Nat → Result) (o : Nat) (t : Tree) (x : Nat × Code) :
    flat t (call d o t x) :=
  enter_flat _ _ _

-- the kids in o's bracket, the cleanups each in theirs: flat whatever dispose does
theorem clean_flat {d : Tree → Nat → Result} (t : Tree) (o a s : Nat) :
    flat t (clean d t o a s) := by
  intro x h
  unfold clean at h
  split at h
  · cases h
  rename_i t₃ f₃ h₃
  rw [each_flat (call_flat d o) _ _ _ x h]
  exact (enter_flat _ _ _ _ h₃).trans (rfl : t.opened = _)

-- dispose(o): what was open is back after
theorem dispose_flat : ∀ n t o, flat t (dispose n t o)
  | 0, t, o => by intro x h; simp [dispose] at h
  | n + 1, t, o => by
    intro x h
    unfold dispose at h
    split at h
    · simp at h; subst h; rfl
    split at h
    · cases h
    rename_i t₄ e₄ h₄
    simp only [Option.some.injEq] at h
    subst h
    have := clean_flat _ o 0 0 _ h₄
    simp only [unlink]
    split <;> exact this

-- run(o, f): when it returns or throws, what is open is what was open before
theorem run_flat (n : Nat) (t : Tree) (o : Nat) (f : Code) : flat t (run (dispose n) t o f) :=
  exec_flat (dispose_flat n) _ _

theorem go_flat (n : Nat) (t : Tree) (x a s : Nat) (i : List Pair) (f : Code) :
    flat t (go n t x a s i f) := by
  intro y h
  unfold go at h
  split at h
  · cases h
  rename_i t₁ e₁ h₁
  have h₁' := clean_flat _ x a s _ h₁
  split at h
  · simp at h; subst h; exact h₁'
  split at h
  · cases h
  rename_i t₂ e₂ h₂
  simp only [Option.some.injEq] at h
  subst h
  rw [enter_flat _ _ _ _ h₂]; exact h₁'

theorem give_flat (n : Nat) (t : Tree) (x : Nat) (f : Code) : flat t (give n t x f) :=
  enter_flat _ _ _

theorem act_flat (n : Nat) (t : Tree) (x : Nat) (f : Code) : flat t (act n t x f) := by
  intro y h
  unfold act at h
  split at h
  · cases h
  rename_i t₁ e₁ h₁
  have h₁' := clean_flat _ x 0 0 _ h₁
  split at h
  · simp at h; subst h; exact h₁'
  split at h
  · cases h
  rename_i t₂ e₂ h₂
  simp only [Option.some.injEq] at h
  subst h
  rw [give_flat _ _ _ _ _ h₂]; exact h₁'

theorem bury_flat (n : Nat) (t : Tree) (x : Nat) (g : Code) : flat t (bury n t x g) := by
  intro y h
  unfold bury at h
  split at h
  · cases h
  rename_i t₁ e₁ h₁
  have h₁' := clean_flat _ x 0 0 _ h₁
  split at h
  · simp at h; subst h; exact h₁'
  · rw [exec_flat (dispose_flat n) g t₁ y h]; exact h₁'

theorem Call.flat (n : Nat) (t : Tree) : ∀ c : Call, Scopes.flat t (c.call n t)
  | .code c => exec_flat (dispose_flat n) c t
  | .go x a s i f => go_flat n t x a s i f
  | .give x f => give_flat n t x f
  | .act x f => act_flat n t x f
  | .bury x g => bury_flat n t x g

/-! ## nothing open: after an await -/

theorem steps_flat (n : Nat) : ∀ (t : Tree) (cs : List Call) (t' : Tree), steps n t cs = some t' →
    t'.opened = t.opened
  | t, [], t', h => by simp [steps] at h; subst h; rfl
  | t, c :: cs, t', h => by
    simp only [steps] at h
    split at h
    · cases h
    rename_i t₁ e₁ h₁
    rw [steps_flat n t₁ cs t' h, Call.flat n t c _ h₁]

-- after an await. javascript runs code after an await as a microtask, and a microtask only on an
-- empty stack, so it is a call from the top, as an event's handler is; and every call before it
-- has returned or thrown. from the start (nothing open), through any calls, nothing is open
-- when the next one starts: making a scope there (no parent named), a computation, or a cleanup
-- throws unscoped and changes nothing
theorem after_await (n : Nat) (cs : List Call) (t : Tree) (h : steps n empty cs = some t)
    (i : List Pair) (f k : Code) :
    t.opened = [] ∧ current t = none ∧
    (Call.code (.make none i k)).call n t = some (t, some .unscoped) ∧
    (Call.code (.comp k)).call n t = some (t, some .unscoped) ∧
    (Call.code (.reg f k)).call n t = some (t, some .unscoped) := by
  have ho : t.opened = [] := steps_flat n empty cs t h
  obtain ⟨a, b, c⟩ := unscoped (dispose n) t ho i f k
  exact ⟨ho, by simp [current, ho], a, b, c⟩

/-! ## the header: a write's pairs -/

-- each one's parent is the one before it
def downs (t : Tree) : List Nat → Prop
  | a :: b :: l => (t.scopes b).parent = some a ∧ downs t (b :: l)
  | _ => True

theorem line_succ (t : Tree) (n o : Nat) : line t (n + 1) o =
    match (t.scopes o).parent with
    | none => [o]
    | some p => line t n p ++ [o] := rfl

theorem downs_snoc (t : Tree) : ∀ (l : List Nat) (a b : Nat), downs t l → l.getLast? = some a →
    (t.scopes b).parent = some a → downs t (l ++ [b])
  | [], _, _, _, h, _ => by simp at h
  | [x], a, b, _, h, hp => by simp at h; subst h; simp [downs, hp]
  | x :: y :: l, a, b, hd, h, hp => by
    obtain ⟨h₁, h₂⟩ := hd
    have := downs_snoc t (y :: l) a b h₂ (by simpa using h) hp
    exact ⟨h₁, this⟩

-- line, with fuel past o: from the root down to o, each one's parent the one before it, and
-- exactly the scopes over o (o included)
theorem line_spec {t : Tree} (hu : up t) : ∀ n o, o < n →
    (line t n o).getLast? = some o ∧ (∀ r ∈ (line t n o).head?, (t.scopes r).parent = none) ∧
    downs t (line t n o) ∧ ∀ m, m ∈ line t n o ↔ under t m o
  | 0, o, h => absurd h (Nat.not_lt_zero _)
  | n + 1, o, h => by
    rw [line_succ]
    split
    · rename_i hp
      refine ⟨rfl, by simpa using hp, trivial, fun m => ⟨fun hm => ?_, fun hm => ?_⟩⟩
      · simp at hm; subst hm; exact .refl
      · cases hm with
        | refl => simp
        | step hq _ => rw [hp] at hq; cases hq
    · rename_i p hp
      have hpo := hu _ _ hp
      obtain ⟨l1, l2, l3, l4⟩ := line_spec hu n p (by omega)
      refine ⟨by simp, fun r hr => ?_, downs_snoc t _ p o l3 l1 hp,
        fun m => ⟨fun hm => ?_, fun hm => ?_⟩⟩
      · rw [List.head?_append] at hr
        cases hh : (line t n p).head? with
        | none =>
          rw [List.head?_eq_none_iff] at hh; rw [hh] at l1; simp at l1
        | some r' =>
          rw [hh] at hr; simp at hr; subst hr; exact l2 r' (by simp [hh])
      · rw [List.mem_append] at hm
        rcases hm with hm | hm
        · exact .step hp ((l4 m).mp hm)
        · simp at hm; subst hm; exact .refl
      · cases hm with
        | refl => simp
        | step hq hu' => rw [hp] at hq; cases hq; exact List.mem_append_left _ ((l4 m).mpr hu')

theorem line_fuel {t : Tree} (hu : up t) : ∀ n m o, o < n → o < m → line t n o = line t m o
  | 0, _, _, h, _ => absurd h (Nat.not_lt_zero _)
  | _ + 1, 0, _, _, h => absurd h (Nat.not_lt_zero _)
  | n + 1, m + 1, o, h₁, h₂ => by
    rw [line_succ, line_succ]
    split
    · rfl
    · rename_i p hp
      have := hu _ _ hp
      rw [line_fuel hu n m p (by omega) (by omega)]

-- what current shows, with b open
theorem current_open {t : Tree} {b : Bracket} {bs : List Bracket} (ho : t.opened = b :: bs) :
    current t = some ⟨b.scope, pairs t b.scope, b.who⟩ := by
  simp [current, ho]

-- the header: a write's pairs are the info of the scope open (getInfo), and its writer is the
-- writer open
theorem write_header (d : Tree → Nat → Result) (t : Tree) (k : Code) (b : Bracket)
    (bs : List Bracket) (ho : t.opened = b :: bs) :
    exec d t (.write k) = exec d (t.note (.write (some ⟨b.scope, (t.scopes b.scope).info, b.who⟩))) k := by
  simp only [exec]
  rw [current_open ho]
  rfl

-- a write with nothing open: from outside, no pairs, no writer
theorem write_outside (d : Tree → Nat → Result) (t : Tree) (k : Code) (ho : t.opened = []) :
    exec d t (.write k) = exec d (t.note (.write none)) k := by
  simp only [exec]
  rw [show current t = none by simp [current, ho]]

-- the info, unfolded: each level's own pairs, innermost first
def Info.levels : Info → List (List Pair)
  | .root i => [i]
  | .under i o => i :: o.levels

/-! ## what is made with a scope open goes under it -/

-- code naming only scopes in P (run(s, f) and scope(info, s): P s), making no root and
-- disposing nothing: what it makes goes under the scope open, or under one in P
def Code.within (P : Nat → Prop) : Code → Prop
  | .done => True
  | .throw _ => True
  | .reg f k => f.within P ∧ k.within P
  | .make none _ k => k.within P
  | .make (some p) _ k => P p ∧ k.within P
  | .comp k => k.within P
  | .root _ _ => False
  | .disp _ _ => False
  | .run s f k => P s ∧ f.within P ∧ k.within P
  | .write k => k.within P

theorem Code.within_mono {P Q : Nat → Prop} (h : ∀ s, P s → Q s) : ∀ c : Code, c.within P →
    c.within Q
  | .done, _ => trivial
  | .throw _, _ => trivial
  | .reg f k, ⟨a, b⟩ => ⟨within_mono h f a, within_mono h k b⟩
  | .make none _ k, a => within_mono h k a
  | .make (some p) _ k, ⟨a, b⟩ => ⟨h p a, within_mono h k b⟩
  | .comp k, a => within_mono h k a
  | .root _ _, a => a.elim
  | .disp _ _, a => a.elim
  | .run s f k, ⟨a, b, c⟩ => ⟨h s a, within_mono h f b, within_mono h k c⟩
  | .write k, a => within_mono h k a

-- under reads only the scopes
theorem under_congr {t t' : Tree} (h : t'.scopes = t.scopes) {a b : Nat} :
    under t' a b ↔ under t a b := by
  constructor
  · intro hu
    induction hu with
    | refl => exact .refl
    | step hp _ ih => exact .step (by rw [← h]; exact hp) ih
  · intro hu
    induction hu with
    | refl => exact .refl
    | step hp _ ih => exact .step (by rw [h]; exact hp) ih

theorem under_opened (t : Tree) (l : List Bracket) {a b : Nat} :
    under { t with opened := l } a b ↔ under t a b := under_congr (t := t) (t' := { t with opened := l }) rfl

-- from t to t', what was made is under o, and every cleanup registered is on a scope under o
def Under (o : Nat) (t t' : Tree) : Prop :=
  (∀ m, t.made < m → m ≤ t'.made → under t' o m) ∧
  ∃ l, t'.log = t.log ++ l ∧ ∀ i s, Event.reg i s ∈ l → under t' o s

theorem Under.refl (o : Nat) (t : Tree) : Under o t t :=
  ⟨fun _ h₁ h₂ => absurd h₂ (by omega), [], by simp, fun _ _ h => by simp at h⟩

-- nothing made, nothing logged
theorem Under.same {o : Nat} {t t' : Tree} (hm : t'.made = t.made) (hl : t'.log = t.log) :
    Under o t t' :=
  ⟨fun _ h₁ h₂ => absurd h₂ (by omega), [], by simp [hl], fun _ _ h => by simp at h⟩

-- nothing made; logged, no registration
theorem Under.quiet {o : Nat} {t t' : Tree} (hm : t'.made = t.made) (l : List Event)
    (hl : t'.log = t.log ++ l) (hr : ∀ i s, Event.reg i s ∉ l) : Under o t t' :=
  ⟨fun _ h₁ h₂ => absurd h₂ (by omega), l, hl, fun i s h => absurd h (hr i s)⟩

theorem Under.trans {o : Nat} {t₁ t₂ t₃ : Tree} {ctx : List Frame} (I₂ : Inv t₂ ctx)
    (M : Mono t₂ t₃) (a : Under o t₁ t₂) (b : Under o t₂ t₃) : Under o t₁ t₃ := by
  obtain ⟨am, l₁, al, ar⟩ := a
  obtain ⟨bm, l₂, bl, br⟩ := b
  refine ⟨fun m h₁ h₂ => ?_, l₁ ++ l₂, by rw [bl, al, List.append_assoc], fun i s h => ?_⟩
  · by_cases hm : m ≤ t₂.made
    · exact M.fwd I₂ (am m h₁ hm)
    · exact bm m (by omega) h₂
  · rcases List.mem_append.mp h with h | h
    · exact M.fwd I₂ (ar i s h)
    · exact br i s h

-- what was open put back: nothing else changes
theorem Under.reopen {o : Nat} {t t' : Tree} (U : Under o t t') (l : List Bracket) :
    Under o t { t' with opened := l } := by
  obtain ⟨um, l', ul, ur⟩ := U
  exact ⟨fun m h₁ h₂ => (under_opened t' l).mpr (um m h₁ h₂), l', ul,
    fun i s h => (under_opened t' l).mpr (ur i s h)⟩

theorem enter_under {o : Nat} {b : Bracket} {t : Tree} {g : Tree → Result} {t' : Tree}
    {e : Option Err}
    (hg : ∀ t₁ e₁, g { t with opened := b :: t.opened } = some (t₁, e₁) →
      Under o { t with opened := b :: t.opened } t₁)
    (h : enter b t g = some (t', e)) : Under o t t' := by
  obtain ⟨t₁, h₁, rfl⟩ := enter_some h
  exact Under.reopen (hg t₁ e h₁) _

-- scope(info, p) made it: under p if named, else under the one open
theorem scope_where {t : Tree} {p : Option Nat} {i : List Pair} {c : Bool} {t' : Tree} {n : Nat}
    (h : scope t p i c = .ok (t', n)) :
    ∃ q, grow t (some q) i c = .ok (t', n) ∧ (p = some q ∨ (p = none ∧ ∃ b ∈ t.opened.head?, b.scope = q)) := by
  unfold scope at h
  split at h
  · exact ⟨_, h, .inl rfl⟩
  · rename_i b bs ho
    exact ⟨_, h, .inr ⟨rfl, b, by simp [ho], rfl⟩⟩
  · cases h

-- made by grow under q, q under o: it is under o, and nothing else is new
theorem grow_under {o q : Nat} {t : Tree} {ctx : List Frame} {i : List Pair} {c : Bool} {t' : Tree}
    {n : Nat} (hI : Inv t ctx) (hq : under t o q) (h : grow t (some q) i c = .ok (t', n)) :
    Under o t t' := by
  obtain ⟨hn, hm, hs, -, -, -, -, hl, -⟩ := grow_some hI h
  have M := (inv_make hI h).2
  refine ⟨fun m h₁ h₂ => ?_, [], by simp [hl], fun _ _ h => by simp at h⟩
  have : m = n := by omega
  subst this
  exact .step (by rw [hs]) (M.fwd hI hq)

-- within code, run with a scope under o open (or none): every scope it makes is under o, and
-- every cleanup it registers is on a scope under o. through runs too: run(s, f) opens s, under o
theorem within_under {n : Nat} (o : Nat) : ∀ (c : Code) (t : Tree) (ctx : List Frame) (t' : Tree)
    (e : Option Err), Inv t ctx → c.within (under t o) → (∀ b ∈ t.opened.head?, under t o b.scope) →
    exec (dispose n) t c = some (t', e) → Under o t t'
  | .done, t, _, t', e, _, _, _, h => by
    simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
  | .throw _, t, _, t', e, _, _, _, h => by
    simp [exec] at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
  | .reg f k, t, ctx, t', e, hI, hc, hb, h => by
    obtain ⟨hf, hk⟩ := hc
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
    rename_i b bs ho
    have hbo : under t o b.scope := hb b (by simp [ho])
    let t₁ := ({ t with regs := t.regs + 1 } : Tree).note (.reg t.regs b.scope)
    have I₁ : Inv t₁ ctx := hI.congr rfl rfl
    have M₁ : Mono t t₁ := Mono.congr rfl rfl (by simp [t₁]) ⟨_, rfl⟩
    split at h
    · rename_i ha
      let t₂ := t₁.set b.scope { t₁.scopes b.scope with
        cleanups := (t₁.scopes b.scope).cleanups ++ [(t.regs, f)] }
      have I₂ : Inv t₂ ctx := inv_cleanups _ I₁ (by rw [ha]; simp)
      have M₂ : Mono t t₂ := M₁.trans (mono_set t₁ b.scope _ rfl (fun hs => absurd ha hs))
      have U₂ : Under o t t₂ := ⟨fun m h₁ h₂ => absurd h₂ (by simp [t₂, t₁]; omega),
        [.reg t.regs b.scope], by simp [t₂, t₁, Tree.note],
        fun i s hs => by simp at hs; obtain ⟨rfl, rfl⟩ := hs; exact M₂.fwd hI hbo⟩
      have hk' := Code.within_mono (fun s hs => M₂.fwd hI hs) k hk
      have K := exec_keep (dispose_keep n) k t₂ ctx t' e I₂ h
      exact U₂.trans I₂ K.2 (within_under o k t₂ ctx t' e I₂ hk'
        (fun b' hb' => M₂.fwd hI (hb b' hb')) h)
    · obtain ⟨t₂, e₂, h₂, h'⟩ := chain_some h
      let t₁' := t₁.note (.run t.regs)
      have I₁' : Inv t₁' ctx := I₁.congr rfl rfl
      have M₁' : Mono t t₁' := M₁.trans (Mono.congr rfl rfl (Nat.le_refl _) ⟨_, rfl⟩)
      have U₁ : Under o t t₁' := ⟨fun m h₁ h₂ => absurd h₂ (by simp [t₁', t₁]; omega),
        [.reg t.regs b.scope, .run t.regs], by simp [t₁', t₁, Tree.note],
        fun i s hs => by simp at hs; obtain ⟨rfl, rfl⟩ := hs; exact M₁'.fwd hI hbo⟩
      -- f, with b's scope open again
      have F := enter_keep (fun t₄ e₄ h₄ =>
        exec_keep (dispose_keep n) f _ ctx t₄ e₄ (I₁'.opened _) h₄) h₂
      have UF : Under o t₁' t₂ := enter_under (fun t₄ e₄ h₄ =>
        within_under o f _ ctx t₄ e₄ (I₁'.opened _)
          (Code.within_mono (fun s hs => (under_opened _ _).mpr (M₁'.fwd hI hs)) f hf)
          (fun b' hb' => by
            simp at hb'; subst hb'
            exact (under_opened _ _).mpr (M₁'.fwd hI hbo)) h₄) h₂
      have U₂ := U₁.trans I₁' F.2 UF
      have M₂ := M₁'.trans F.2
      have o₂ : t₂.opened = t.opened := by
        have := enter_flat _ _ _ _ h₂; exact this
      rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
      · exact U₂
      · have hk' := Code.within_mono (fun s hs => M₂.fwd hI hs) k hk
        have K := exec_keep (dispose_keep n) k t₂ ctx t' e F.1 h'
        exact U₂.trans F.1 K.2 (within_under o k t₂ ctx t' e F.1 hk'
          (fun b' hb' => M₂.fwd hI (hb b' (by rw [← o₂]; exact hb'))) h')
  | .make p i k, t, ctx, t', e, hI, hc, hb, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
    rename_i t₁ n₁ hr
    obtain ⟨q, hq, hw⟩ := scope_where hr
    have hk : k.within (under t o) := by
      cases p with
      | none => exact hc
      | some p => exact hc.2
    have hqo : under t o q := by
      rcases hw with rfl | ⟨rfl, b, hb', rfl⟩
      · exact hc.1
      · exact hb b hb'
    have M := inv_make hI hq
    have U₁ := grow_under hI hqo hq
    have o₁ : t₁.opened = t.opened := (grow_some hI hq).2.2.2.2.2.2.2.2
    have K := exec_keep (dispose_keep n) k t₁ ctx t' e M.1 h
    exact U₁.trans M.1 K.2 (within_under o k t₁ ctx t' e M.1
      (Code.within_mono (fun s hs => M.2.fwd hI hs) k hk)
      (fun b' hb' => M.2.fwd hI (hb b' (by rw [← o₁]; exact hb'))) h)
  | .comp k, t, ctx, t', e, hI, hc, hb, h => by
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
    rename_i t₁ n₁ hr
    obtain ⟨q, hq, hw⟩ := scope_where hr
    have hqo : under t o q := by
      rcases hw with h' | ⟨_, b, hb', rfl⟩
      · cases h'
      · exact hb b hb'
    have M := inv_make hI hq
    have U₁ := grow_under hI hqo hq
    have o₁ : t₁.opened = t.opened := (grow_some hI hq).2.2.2.2.2.2.2.2
    have K := exec_keep (dispose_keep n) k t₁ ctx t' e M.1 h
    exact U₁.trans M.1 K.2 (within_under o k t₁ ctx t' e M.1
      (Code.within_mono (fun s hs => M.2.fwd hI hs) k hc)
      (fun b' hb' => M.2.fwd hI (hb b' (by rw [← o₁]; exact hb'))) h)
  | .root _ _, _, _, _, _, _, hc, _, _ => hc.elim
  | .disp _ _, _, _, _, _, _, hc, _, _ => hc.elim
  | .run s f k, t, ctx, t', e, hI, hc, hb, h => by
    obtain ⟨hs, hf, hk⟩ := hc
    simp only [exec] at h
    split at h
    · simp at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
    obtain ⟨t₂, e₂, h₂, h'⟩ := chain_some h
    have F := enter_keep (fun t₄ e₄ h₄ =>
      exec_keep (dispose_keep n) f _ ctx t₄ e₄ (hI.opened _) h₄) h₂
    have UF : Under o t t₂ := enter_under (fun t₄ e₄ h₄ =>
      within_under o f _ ctx t₄ e₄ (hI.opened _)
        (Code.within_mono (fun s hs => (under_opened _ _).mpr hs) f hf)
        (fun b' hb' => by simp at hb'; subst hb'; exact (under_opened _ _).mpr hs) h₄) h₂
    have o₂ : t₂.opened = t.opened := by
      have := enter_flat _ _ _ _ h₂; exact this
    rcases h' with ⟨_, rfl, rfl⟩ | ⟨_, h'⟩
    · exact UF
    · have hk' := Code.within_mono (fun s hs => F.2.fwd hI hs) k hk
      have K := exec_keep (dispose_keep n) k t₂ ctx t' e F.1 h'
      exact UF.trans F.1 K.2 (within_under o k t₂ ctx t' e F.1 hk'
        (fun b' hb' => F.2.fwd hI (hb b' (by rw [← o₂]; exact hb'))) h')
  | .write k, t, ctx, t', e, hI, hc, hb, h => by
    simp only [exec] at h
    let t₁ := t.note (.write (current t))
    have I₁ : Inv t₁ ctx := hI.congr rfl rfl
    have M₁ : Mono t t₁ := Mono.congr rfl rfl (Nat.le_refl _) ⟨_, rfl⟩
    have U₁ : Under o t t₁ := Under.quiet rfl [.write (current t)] rfl (by simp)
    have K := exec_keep (dispose_keep n) k t₁ ctx t' e I₁ h
    exact U₁.trans I₁ K.2 (within_under o k t₁ ctx t' e I₁
      (Code.within_mono (fun s hs => M₁.fwd hI hs) k hc)
      (fun b' hb' => M₁.fwd hI (hb b' hb')) h)

-- run(o, f), f within: every scope f makes is under o, and every cleanup it registers is on a
-- scope under o, whatever was open around the call
theorem run_under {n : Nat} (o : Nat) (t : Tree) (ctx : List Frame) (f : Code) (t' : Tree)
    (e : Option Err) (hI : Inv t ctx) (hf : f.within (under t o))
    (h : run (dispose n) t o f = some (t', e)) : Under o t t' := by
  simp only [run, exec] at h
  split at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t
  rw [chain_done] at h
  exact enter_under (fun t₄ e₄ h₄ =>
    within_under o f _ ctx t₄ e₄ (hI.opened _)
      (Code.within_mono (fun s hs => (under_opened _ _).mpr hs) f hf)
      (fun b' hb' => by simp at hb'; subst hb'; exact .refl) h₄) h

/-! ## runs, sets, acts: who is open -/

-- setting a scope's info is no part of Inv (it not gone), Mono, or Ids
theorem inv_info {t : Tree} {ctx : List Frame} {x : Nat} (i : Info) (h : Inv t ctx)
    (hx : (t.scopes x).state ≠ .gone) : Inv (t.set x { t.scopes x with info := i }) ctx :=
  inv_set h (fun _ hf => .inl hf) (h.alive_made hx) rfl (List.Sublist.refl _)
    (fun _ _ _ _ h' h'' => absurd h' h'') (fun e => e) (fun e => h.framed x e)
    (fun e => absurd e hx) (fun e => absurd e hx)

theorem mono_info (t : Tree) (x : Nat) (i : Info) :
    Mono t (t.set x { t.scopes x with info := i }) :=
  mono_set t x _ rfl (fun _ => ⟨rfl, rfl, List.Sublist.refl _⟩)

theorem ids_info (t : Tree) (x : Nat) (i : Info) (m : Nat) :
    ids (t.set x { t.scopes x with info := i }) m = ids t m := by
  rw [ids_set]; by_cases e : m = x <;> simp [e, ids]

-- line reads only the parents
theorem line_congr {t t' : Tree} (h : ∀ m, (t'.scopes m).parent = (t.scopes m).parent) :
    ∀ n o, line t' n o = line t n o
  | 0, _ => rfl
  | n + 1, o => by
    rw [line_succ, line_succ, h o]
    split
    · rfl
    · rw [line_congr h n]

-- pairs reads only the scopes
theorem pairs_opened (t : Tree) (l : List Bracket) (o : Nat) :
    pairs { t with opened := l } o = pairs t o := rfl

-- run(o, f), o alive: f runs with o open, the writer open kept; f's throw is the caller's
theorem run_opens (d : Tree → Nat → Result) (t : Tree) (o : Nat) (f : Code)
    (h : (t.scopes o).state = .alive) :
    run d t o f = enter ⟨o, t.who⟩ t (fun t => exec d t f) := by
  simp [run, exec, h, chain_done]

-- run(o, f), o not alive: disposed, f not run, the tree as it was
theorem run_throws (d : Tree → Nat → Result) (t : Tree) (o : Nat) (f : Code)
    (h : (t.scopes o).state ≠ .alive) : run d t o f = some (t, some .disposed) := by
  simp [run, exec, h]

-- a run of x: after its clean, x alive, x's info is the run's, and f runs with x open, written
-- by its own read
theorem go_opens (n : Nat) (t : Tree) (x a s : Nat) (i : List Pair) (f : Code) {t₀ : Tree}
    {e₀ : Option Err} (hc : clean (dispose n) t x a s = some (t₀, e₀))
    (ha : (t₀.scopes x).state = .alive) :
    go n t x a s i f =
      match enter ⟨x, some (.read x)⟩ (t₀.set x { t₀.scopes x with info := .of i (ownerOf t₀ x) })
          (fun t => exec (dispose n) t f) with
      | none => none
      | some (t, e') => some (t, pick e₀ e') := by
  unfold go
  rw [hc]
  simp [ha]

-- in a run of x, under p: what current shows at f's start. x open, the pairs the run's own, then
-- ["owner", p's info], written by the run's own read
theorem go_header (t₀ : Tree) {x p : Nat} (hp : (t₀.scopes x).parent = some p) (i : List Pair)
    (l : List Bracket) :
    current { t₀.set x { t₀.scopes x with info := .of i (ownerOf t₀ x) } with
      opened := ⟨x, some (.read x)⟩ :: l } =
      some ⟨x, .under i (t₀.scopes p).info, some (.read x)⟩ := by
  rw [current_open rfl]
  simp [pairs, ownerOf, hp, Info.of]

-- what is made under p nests p's info: its own pairs, then p's info (as it was at the making)
theorem grow_info {t t' : Tree} {p : Nat} {i : List Pair} {c : Bool} {n : Nat}
    (h : grow t (some p) i c = .ok (t', n)) :
    (t'.scopes n).info = .under i (t.scopes p).info ∧
      (t'.scopes n).info.levels = i :: (t.scopes p).info.levels := by
  obtain ⟨-, rfl, rfl⟩ := grow_some_ok h
  simp [Info.levels]

-- a scope given no pairs is not made: empty, the tree as it was (a computation's info is its own)
theorem grow_empty (t : Tree) (p : Option Nat) (hp : ∀ q, p = some q → (t.scopes q).state = .alive) :
    grow t p [] false = .error .empty := by
  cases p with
  | none => simp [grow]
  | some q => simp [grow, hp q rfl]

theorem make_empty (d : Tree → Nat → Result) (t : Tree) (p : Nat) (k : Code)
    (hp : (t.scopes p).state = .alive) : exec d t (.make (some p) [] k) = some (t, some .empty) := by
  simp [exec, scope, grow_empty t (some p) (fun q e => by cases e; exact hp)]

-- a compute's set: with x open, written by x
theorem give_opens (n : Nat) (t : Tree) (x : Nat) (f : Code) :
    give n t x f = enter ⟨x, some (.comp x)⟩ t (fun t => exec (dispose n) t f) := rfl

-- an effect's act: after its clean, x alive, the act runs with x open, written by x
theorem act_opens (n : Nat) (t : Tree) (x : Nat) (f : Code) {t₀ : Tree} {e₀ : Option Err}
    (hc : clean (dispose n) t x 0 0 = some (t₀, e₀)) (ha : (t₀.scopes x).state = .alive) :
    act n t x f =
      match enter ⟨x, some (.comp x)⟩ t₀ (fun t => exec (dispose n) t f) with
      | none => none
      | some (t, e') => some (t, pick e₀ e') := by
  unfold act
  rw [hc]
  simp [ha, give]

-- a cleanup opens its scope: a computation's written by it, any other's by the writer open when
-- it runs (a dispose at the top, nothing open: none, from outside; in a computation's clean: the
-- computation, kids_opens)
theorem call_opens (d : Tree → Nat → Result) (o : Nat) (t : Tree) (x : Nat × Code) :
    call d o t x = enter ⟨o, if (t.scopes o).comp then some (.comp o) else t.who⟩
      (t.note (.run x.1)) (fun t => exec d t x.2) := rfl

-- what clean disposes under o goes with o open, as its cleanups do: a computation's written by
-- it, any other's by the writer open
theorem kids_opens (d : Tree → Nat → Result) (o : Nat) (t : Tree) (ks : List Nat) :
    kids d o t ks = enter ⟨o, if (t.scopes o).comp then some (.comp o) else t.who⟩ t
      (fun t => each d t ks none) := rfl

-- a computation's bracket is written by it
theorem opens_comp (t : Tree) {x : Nat} (hx : (t.scopes x).comp = true) :
    opens t x = ⟨x, some (.comp x)⟩ := by
  simp [opens, hx]

-- a plain scope's bracket keeps the writer open: under a computation's (its clean's kids, a
-- plain scope's kids and cleanups under them, any depth), that computation
theorem opens_plain (t : Tree) {p : Nat} (hp : (t.scopes p).comp = false) (b : Bracket)
    (l : List Bracket) : opens { t with opened := b :: l } p = ⟨p, b.who⟩ := by
  simp [opens, hp, Tree.who]

/-! ## runs, sets, acts: the invariants, and what they make -/

theorem top_run {n : Nat} {t t' : Tree} {o : Nat} {f : Code} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (h : run (dispose n) t o f = some (t', e)) : Inv t' [] ∧ Ids t' :=
  ⟨(exec_keep (dispose_keep n) _ t [] t' e hI h).1, (exec_once (dispose_once n) _ t [] t' e hI hD h).1⟩

theorem top_give {n : Nat} {t t' : Tree} {x : Nat} {f : Code} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (h : give n t x f = some (t', e)) : Inv t' [] ∧ Ids t' :=
  ⟨(enter_keep (fun t₄ e₄ h₄ => exec_keep (dispose_keep n) f _ [] t₄ e₄ (hI.opened _) h₄) h).1,
    (enter_once (fun t₄ e₄ h₄ => exec_once (dispose_once n) f _ [] t₄ e₄ (hI.opened _)
      (hD.same (fun _ => rfl) rfl rfl) h₄) h).1⟩

-- a run, after its clean: Inv and Ids kept, its cleanups accounted for
theorem go_after (n : Nat) (t : Tree) (ctx : List Frame) (x a s : Nat) (i : List Pair) (f : Code)
    {t₀ : Tree} {e₀ : Option Err} (hc : clean (dispose n) t x a s = some (t₀, e₀))
    (I₀ : Inv t₀ ctx) (D₀ : Ids t₀) {t' : Tree} {e : Option Err}
    (h : go n t x a s i f = some (t', e)) :
    Inv t' ctx ∧ Mono t₀ t' ∧ Ids t' ∧ ∃ l, Acc t₀ t' l := by
  unfold go at h
  rw [hc] at h
  simp only [] at h
  split at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h
    exact ⟨I₀, Mono.refl _, D₀, [], Acc.same (fun _ => rfl) rfl rfl⟩
  rename_i ha₀
  split at h
  · cases h
  rename_i t₂ e₂ h₂
  simp only [Option.some.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  have hx : (t₀.scopes x).state ≠ .gone := by simp at ha₀; rw [ha₀]; simp
  have I₁ := inv_info (x := x) (.of i (ownerOf t₀ x)) I₀ hx
  have D₁ := D₀.same (ids_info t₀ x (.of i (ownerOf t₀ x))) rfl rfl
  have F := enter_keep (fun t₄ e₄ h₄ =>
    exec_keep (dispose_keep n) f _ ctx t₄ e₄ (I₁.opened _) h₄) h₂
  obtain ⟨D₂, l, A⟩ := enter_once (fun t₄ e₄ h₄ =>
    exec_once (dispose_once n) f _ ctx t₄ e₄ (I₁.opened _) (D₁.same (fun _ => rfl) rfl rfl) h₄) h₂
  exact ⟨F.1, (mono_info t₀ x (.of i (ownerOf t₀ x))).trans F.2, D₂, _, (Acc.same (ids_info t₀ x (.of i (ownerOf t₀ x))) rfl rfl).trans A⟩

-- a run returned: its clean did
theorem go_clean {n : Nat} {t : Tree} {x a s : Nat} {i : List Pair} {f : Code} {r : Tree × Option Err}
    (h : go n t x a s i f = some r) : ∃ t₀ e₀, clean (dispose n) t x a s = some (t₀, e₀) := by
  unfold go at h
  split at h
  · cases h
  · rename_i t₀ e₀ hc; exact ⟨t₀, e₀, hc⟩

theorem top_go {n : Nat} {t t' : Tree} {x a s : Nat} {i : List Pair} {f : Code} {e : Option Err}
    (hI : Inv t []) (hD : Ids t) (ha : (t.scopes x).state = .alive)
    (h : go n t x a s i f = some (t', e)) : Inv t' [] ∧ Ids t' := by
  obtain ⟨t₀, e₀, hc⟩ := go_clean h
  obtain ⟨I₀, _⟩ := clean_keep n t x a s [] t₀ e₀ hI ha hc
  have D₀ := (clean_once (dispose_once n) t x a s [] t₀ e₀ hI hD (by rw [ha]; simp) hc).1
  obtain ⟨I, _, D, _⟩ := go_after n t [] x a s i f hc I₀ D₀ h
  exact ⟨I, D⟩

-- an act, after its clean: Inv and Ids kept
theorem act_after (n : Nat) (t : Tree) (ctx : List Frame) (x : Nat) (f : Code) {t₀ : Tree}
    {e₀ : Option Err} (hc : clean (dispose n) t x 0 0 = some (t₀, e₀)) (I₀ : Inv t₀ ctx)
    (D₀ : Ids t₀) {t' : Tree} {e : Option Err} (h : act n t x f = some (t', e)) :
    Inv t' ctx ∧ Mono t₀ t' ∧ Ids t' ∧ ∃ l, Acc t₀ t' l := by
  unfold act at h
  rw [hc] at h
  simp only [] at h
  split at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h
    exact ⟨I₀, Mono.refl _, D₀, [], Acc.same (fun _ => rfl) rfl rfl⟩
  split at h
  · cases h
  rename_i t₂ e₂ h₂
  simp only [Option.some.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  have F := enter_keep (fun t₄ e₄ h₄ =>
    exec_keep (dispose_keep n) f _ ctx t₄ e₄ (I₀.opened _) h₄) h₂
  obtain ⟨D₂, l, A⟩ := enter_once (fun t₄ e₄ h₄ =>
    exec_once (dispose_once n) f _ ctx t₄ e₄ (I₀.opened _) (D₀.same (fun _ => rfl) rfl rfl) h₄) h₂
  exact ⟨F.1, F.2, D₂, _, A⟩

theorem top_act {n : Nat} {t t' : Tree} {x : Nat} {f : Code} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (ha : (t.scopes x).state = .alive) (h : act n t x f = some (t', e)) :
    Inv t' [] ∧ Ids t' := by
  have : ∃ t₀ e₀, clean (dispose n) t x 0 0 = some (t₀, e₀) := by
    unfold act at h
    split at h
    · cases h
    · rename_i t₀ e₀ hc; exact ⟨t₀, e₀, hc⟩
  obtain ⟨t₀, e₀, hc⟩ := this
  obtain ⟨I₀, _⟩ := clean_keep n t x 0 0 [] t₀ e₀ hI ha hc
  have D₀ := (clean_once (dispose_once n) t x 0 0 [] t₀ e₀ hI hD (by rw [ha]; simp) hc).1
  obtain ⟨I, _, D, _⟩ := act_after n t [] x f hc I₀ D₀ h
  exact ⟨I, D⟩

-- a run of x, x under o, f within: what f makes is under o, and every cleanup it registers is
-- on a scope under o. what the cleanups its clean runs do is theirs
theorem go_under (n : Nat) (o : Nat) (t : Tree) (ctx : List Frame) (x a s : Nat) (i : List Pair)
    (f : Code) (hI : Inv t ctx) (ha : (t.scopes x).state = .alive) (hx : under t o x)
    (hf : f.within (under t o)) {t₀ : Tree} {e₀ : Option Err}
    (hc : clean (dispose n) t x a s = some (t₀, e₀)) {t' : Tree} {e : Option Err}
    (h : go n t x a s i f = some (t', e)) : Under o t₀ t' := by
  obtain ⟨I₀, M₀⟩ := clean_keep n t x a s ctx t₀ e₀ hI ha hc
  unfold go at h
  rw [hc] at h
  simp only [] at h
  split at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h; exact Under.refl o t₀
  rename_i ha₀
  split at h
  · cases h
  rename_i t₂ e₂ h₂
  simp only [Option.some.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  have hx₀ : (t₀.scopes x).state ≠ .gone := by simp at ha₀; rw [ha₀]; simp
  have I₁ := inv_info (x := x) (.of i (ownerOf t₀ x)) I₀ hx₀
  have M := M₀.trans (mono_info t₀ x (.of i (ownerOf t₀ x)))
  have F := enter_keep (fun t₄ e₄ h₄ =>
    exec_keep (dispose_keep n) f _ ctx t₄ e₄ (I₁.opened _) h₄) h₂
  exact (Under.same (o := o) (t := t₀) (t' := t₀.set x { t₀.scopes x with info := .of i (ownerOf t₀ x) }) rfl rfl).trans
    I₁ F.2 (enter_under (fun t₄ e₄ h₄ =>
      within_under o f _ ctx t₄ e₄ (I₁.opened _)
        (Code.within_mono (fun s hs => (under_opened _ _).mpr (M.fwd hI hs)) f hf)
        (fun b' hb' => by simp at hb'; subst hb'; exact (under_opened _ _).mpr (M.fwd hI hx)) h₄) h₂)

-- what a call made under o, dispose(o) after takes: every scope it made is gone, and every
-- cleanup it registered has run, exactly once
theorem taken {o m : Nat} {t₀ t₁ t₂ : Tree} {la : List Event} {e₂ : Option Err}
    (U : Under o t₀ t₁) (A : Acc t₀ t₁ la) (I₁ : Inv t₁ []) (D₁ : Ids t₁)
    (h₂ : dispose m t₁ o = some (t₂, e₂)) :
    (∀ x, t₀.made < x → x ≤ t₁.made → (t₂.scopes x).state = .gone) ∧
    ∃ l, t₁.log = t₀.log ++ l ∧ ∀ i s, Event.reg i s ∈ l → (runs t₂.log).count i = 1 := by
  obtain ⟨Um, l, hl, Ur⟩ := U
  have hla : la = l := by
    have := A.log; rw [hl] at this; exact (List.append_cancel_left this).symm
  subst hla
  obtain ⟨_, C, _⟩ := six_c m t₁ o t₂ e₂ I₁ h₂
  obtain ⟨D₂, l₂, hl₂, B⟩ := six_b m t₁ o t₂ e₂ I₁ D₁ h₂
  obtain ⟨_, M₂, _⟩ := dispose_keep m t₁ o [] t₂ e₂ I₁ h₂
  refine ⟨fun x h₁ h₂ => (C x (M₂.fwd I₁ (Um x h₁ h₂))).1, la, hl, fun i s hs => ?_⟩
  rcases A.track s i (.inr hs) with h | h
  · exact B i (.inl ⟨s, Ur i s hs, h⟩)
  · have hin : i ∈ runs t₂.log := by
      rw [hl₂, runs_append, hl, runs_append]; simp [h]
    rw [List.Nodup.count D₂.once]; simp [hin]

-- disposing o takes what run(o, f) made, f within, through every run(s, ·) it opened under o:
-- after dispose(o), every scope it made is gone, and every cleanup it registered has run,
-- exactly once
theorem takes (n m : Nat) (t : Tree) (o : Nat) (f : Code) (hI : Inv t []) (hD : Ids t)
    (hf : f.within (under t o)) {t₁ : Tree} {e₁ : Option Err}
    (h₁ : run (dispose n) t o f = some (t₁, e₁)) {t₂ : Tree} {e₂ : Option Err}
    (h₂ : dispose m t₁ o = some (t₂, e₂)) :
    (∀ x, t.made < x → x ≤ t₁.made → (t₂.scopes x).state = .gone) ∧
    ∃ l, t₁.log = t.log ++ l ∧ ∀ i s, Event.reg i s ∈ l → (runs t₂.log).count i = 1 := by
  have I₁ := (exec_keep (dispose_keep n) _ t [] t₁ e₁ hI h₁).1
  obtain ⟨D₁, la, A⟩ := exec_once (dispose_once n) _ t [] t₁ e₁ hI hD h₁
  exact taken (run_under o t [] f t₁ e₁ hI hf h₁) A I₁ D₁ h₂

-- the same through a run of a computation x under o (a run opens its computation): what f made
-- is gone after dispose(o), and every cleanup it registered has run, exactly once
theorem takes_go (n m : Nat) (t : Tree) (o x a s : Nat) (i : List Pair) (f : Code)
    (hI : Inv t []) (hD : Ids t) (ha : (t.scopes x).state = .alive) (hx : under t o x)
    (hf : f.within (under t o)) {t₀ : Tree} {e₀ : Option Err}
    (hc : clean (dispose n) t x a s = some (t₀, e₀)) {t₁ : Tree} {e₁ : Option Err}
    (h₁ : go n t x a s i f = some (t₁, e₁)) {t₂ : Tree} {e₂ : Option Err}
    (h₂ : dispose m t₁ o = some (t₂, e₂)) :
    (∀ y, t₀.made < y → y ≤ t₁.made → (t₂.scopes y).state = .gone) ∧
    ∃ l, t₁.log = t₀.log ++ l ∧ ∀ j s', Event.reg j s' ∈ l → (runs t₂.log).count j = 1 := by
  obtain ⟨I₀, _⟩ := clean_keep n t x a s [] t₀ e₀ hI ha hc
  have D₀ := (clean_once (dispose_once n) t x a s [] t₀ e₀ hI hD (by rw [ha]; simp) hc).1
  obtain ⟨I₁, _, D₁, la, A⟩ := go_after n t [] x a s i f hc I₀ D₀ h₁
  exact taken (go_under n o t [] x a s i f hI ha hx hf hc h₁) A I₁ D₁ h₂


/-! ## the going path: an attended computation going at a pulse's end -/

-- a going at the top keeps Inv and Ids: no cleanup ever runs twice (six_b's Ids), through goings
theorem top_bury {n : Nat} {t t' : Tree} {x : Nat} {g : Code} {e : Option Err} (hI : Inv t [])
    (hD : Ids t) (ha : (t.scopes x).state = .alive) (h : bury n t x g = some (t', e)) :
    Inv t' [] ∧ Ids t' := by
  unfold bury at h
  split at h
  · cases h
  rename_i t₀ e₀ hc
  obtain ⟨I₀, _⟩ := clean_keep n t x 0 0 [] t₀ e₀ hI ha hc
  have D₀ := (clean_once (dispose_once n) t x 0 0 [] t₀ e₀ hI hD (by rw [ha]; simp) hc).1
  split at h
  · simp at h; obtain ⟨rfl, rfl⟩ := h; exact ⟨I₀, D₀⟩
  · exact ⟨(exec_keep (dispose_keep n) g t₀ [] t' e I₀ h).1,
      (exec_once (dispose_once n) g t₀ [] t' e I₀ D₀ h).1⟩

-- what a going does to the tree, its cleanups inert: every one under x disposed and every one of
-- x's cleanups run, exactly once each, newest first; x left with no children and no cleanups, its
-- state as it was (alive: asleep, not gone); what is not under x as it was
theorem going {n : Nat} {t t' : Tree} {x : Nat} {e : Option Err} (hu : up t) (ht : tidy t x)
    (h : clean (dispose n) t x 0 0 = some (t', e)) :
    let gone := (t.scopes x).children.reverse.flatMap (fold n t) ++ (t.scopes x).cleanups.reverse
    t'.log = t.log ++ gone.map (fun y => Event.run y.1) ∧
      (t'.scopes x).children = [] ∧ (t'.scopes x).cleanups = [] ∧
      (t'.scopes x).state = (t.scopes x).state ∧
      ∀ m, m ≠ x → (∀ c ∈ (t.scopes x).children, ¬ reach t c m) → t'.scopes m = t.scopes m := by
  intro gone
  obtain ⟨h1, -, h3, -, h5, -⟩ := clean_inert n t x 0 0 t' e hu ht h
  have hpos : ∀ c ∈ (t.scopes x).children, c > 0 := fun c hc => by
    have := hu _ _ (ht.par x c (.refl _) hc); omega
  have f1 : (t.scopes x).children.filter (· > 0) = (t.scopes x).children :=
    List.filter_eq_self.2 fun c hc => by simpa using hpos c hc
  have f2 : (t.scopes x).children.filter (fun c => !(c > 0)) = [] :=
    List.filter_eq_nil_iff.2 fun c hc => by have := hpos c hc; simp; omega
  refine ⟨?_, ?_, ?_, ?_, fun m hm hr => h5 m hm fun c hc _ => hr c hc⟩
  · rw [h1]; simp only [gone, f1, List.drop_zero]
  · rw [h3]; exact f2
  · rw [h3]; simp
  · rw [h3]

end Scopes

-- fidelity: conformance scenarios 43, 44 and 46 (core/scheduler/conformance/scheduler), checked by
-- evaluation (#guard). pairs as numbers: actor 1, chee 2, app 3, notes 4, why 5, save 6,
-- plain 7, run 8, mark 9
namespace Scopes.Check

open Scopes

-- the writes a log holds
def writes (t : Tree) : List (Option Current) :=
  t.log.filterMap (fun e => match e with | .write c => some c | _ => none)

-- who wrote, where: the scope open and the writer of each write
def whos (t : Tree) : List (Option (Nat × Option Who)) :=
  (writes t).map (·.map fun c => (c.scope, c.who))

-- 43: scope with nothing open is unscoped; with no pairs, empty; a scope under the one given, else
-- the one open; its info nests its owner's; disposing the root takes what is under it
#guard (exec (dispose 20) empty (.make none [] .done)).map (·.2) == some (some .unscoped)
#guard (exec (dispose 20) empty (.root [] .done)).map (·.2) == some (some .empty)
#guard (exec (dispose 20) empty (.root [(1, 2)] (.make (some 1) [] .done))).map (·.2) ==
  some (some .empty)
#guard match exec (dispose 20) empty
    (.root [(1, 2)] (.make (some 1) [(3, 4), (1, 4)] (.run 2 (.write .done)
      (.run 2 (.make none [(5, 6)] (.run 3 (.write .done) .done))
        (.disp 1 (.run 3 .done .done)))))) with
  | some (t, e) => writes t == [some ⟨2, .under [(3, 4), (1, 4)] (.root [(1, 2)]), none⟩,
      some ⟨3, .under [(5, 6)] (.under [(3, 4), (1, 4)] (.root [(1, 2)])), none⟩] &&
      e == some .disposed && t.opened == []
  | none => false

-- 44: a run opens its computation, its info the run's (then its owner's), written by its own
-- read; a set by the computation
#guard match steps 20 empty [.code (.root [(1, 4)] (.run 1 (.comp .done) .done)),
    .go 2 0 0 [(8, 1), (9, 1)] (.write .done), .give 2 (.write .done)] with
  | some t => writes t == [some ⟨2, .under [(8, 1), (9, 1)] (.root [(1, 4)]), some (.read 2)⟩,
      some ⟨2, .under [(8, 1), (9, 1)] (.root [(1, 4)]), some (.comp 2)⟩]
  | none => false

-- 46: a cleanup opens its scope: a computation's written by it (its info still the run's that
-- made it), a plain one's by the writer open (none at the top)
#guard match steps 20 empty [
    .code (.root [(1, 4)] (.make (some 1) [(5, 7)] (.run 2 (.reg (.write .done) .done)
      (.run 1 (.comp .done) .done)))),
    .go 3 0 0 [(8, 1), (9, 1)] (.reg (.write .done) .done),
    .go 3 0 0 [(8, 2), (9, 3)] .done,
    .code (.disp 2 .done)] with
  | some t => writes t == [some ⟨3, .under [(8, 1), (9, 1)] (.root [(1, 4)]), some (.comp 3)⟩,
      some ⟨2, .under [(5, 7)] (.root [(1, 4)]), none⟩]
  | none => false

-- a plain scope made in a run, its cleanup run by the computation's clean before its next run
-- (children first): written by the computation, as the computation's own cleanup, after
#guard match steps 20 empty [
    .code (.root [(1, 1)] (.run 1 (.comp .done) .done)),
    .go 2 0 0 [] (.make none [(7, 7)] (.run 3 (.reg (.write .done) .done) (.reg (.write .done) .done))),
    .go 2 0 0 [] .done] with
  | some t => whos t == [some (3, some (.comp 2)), some (2, some (.comp 2))]
  | none => false

-- deeper: a plain scope under a plain scope under the computation, written by it; an act's
-- clean the same
#guard match steps 20 empty [
    .code (.root [(1, 1)] (.run 1 (.comp .done) .done)),
    .go 2 0 0 [] (.make none [(7, 7)] (.run 3 (.make none [(7, 7)]
      (.run 4 (.reg (.write .done) .done) .done)) .done)),
    .go 2 0 0 [] .done,
    .act 2 (.make none [(7, 7)] (.run 5 (.reg (.write .done) .done) .done)),
    .act 2 .done] with
  | some t => whos t == [some (4, some (.comp 2)), some (5, some (.comp 2))]
  | none => false

-- under a computation made in the run: written by that inner one, the nearest over it
#guard match steps 20 empty [
    .code (.root [(1, 1)] (.run 1 (.comp .done) .done)),
    .go 2 0 0 [] (.comp .done),
    .go 3 0 0 [] (.make none [(7, 7)] (.run 4 (.reg (.write .done) .done) .done)),
    .go 2 0 0 [] .done] with
  | some t => whos t == [some (4, some (.comp 3))]
  | none => false

-- a going: what is under the computation goes and its cleanups run, written by it, children
-- first; it stays alive; then gone is told, nothing open: from outside
#guard match steps 20 empty [
    .code (.root [(1, 1)] (.run 1 (.comp .done) .done)),
    .go 2 0 0 [] (.make none [(7, 7)] (.run 3 (.reg (.write .done) .done) (.reg (.write .done) .done))),
    .bury 2 (.write .done)] with
  | some t => whos t == [some (3, some (.comp 2)), some (2, some (.comp 2)), none] &&
      (t.scopes 2).state == .alive && (t.scopes 3).state == .gone && (t.scopes 2).children == []
  | none => false

end Scopes.Check
