-- LLM generated working output
-- the scheduler's synchronous core (core/scheduler/typescript/scheduler.ts) as a deterministic step
-- function on a state. the host makes computations (make), writes keys (write) and marks them
-- (changed: scheduler.ts mark) between pulses; a pulse (pulse, with fuel) is begin, then step
-- until step says it ended, then close. a step is one run (first = start, exec, ending), one act,
-- or a phase change.
-- the trace: `log`, every moment and every call of set and act, tagged with pulse and round;
-- `observations`, `moments`, `started`, `completed` read it. Model.Check, at the end, runs
-- conformance scenarios on it.
--
-- abstractions:
-- - keys K and values V: any types with decidable equality. the store is the host's: K → Option V
-- - computations: a fixed list, given as a function from n (the order made) to what each is. one
--   is live from its make (the host's, between pulses, in order of n) on
-- - f: a read program, a decision tree: read a key and branch on what is there (none: nothing),
--   write in the run (mark([k], the run)), or end with a value, an error or PENDING. a run is then
--   a function of what it read, by construction
-- - equal: V → V → Option Bool, none for an equal that throws; `same` is helpers.ts's
-- - a compute's set: writes v at its key `to` (if any) and marks it, mark([to], the compute), as
--   the harness wires it. `key`: make's key, its writer from the start
-- - an effect's act: the writes it makes, from (value, previous); each marked, mark([k], effect)
-- - the tracker: each computation's read keys as a list (`reads`), its latest run's, or during a
--   run the last run's and this one's so far (the tracker drops the stale links at the run's end)
-- - causes: Basic.lean's Cause, of runs named (computation, run number). causes.ts's loop and from
--   are taken as specified there, by `back` on the computations (`loopof`, `came`)
-- - order: `next` is the due p whose after is not due, least by (rank, mark, n) (Order.lean proves
--   the heap is that). the rank is a parameter: any function of the state; theorems needing it
--   assume Basic.lean's `ranked` over the current `edges` (Rank.lean proves rank.ts is)
-- - moments: a log of events, each tagged with its pulse and round, with two more: set and act,
--   when they are called (the observations)
--
-- departures from scheduler.ts:
-- - no scopes, cleanups, dispose, clean, run(), current (Scopes.lean): nothing is under a
--   computation, no computation goes, and a computation's state is always alive
-- - no async (A8): no promises, landed, land, awaiting; a run's Run is never used after it
-- - make only by the host, in order of n; never in a run, set or act. `running` and the cut in
--   make are then never used
-- - a change by a run names its computation (its latest run): the same in a synchronous run
-- - the tracker's readers are listed in the order made (n), not the order the links were made: the
--   due moments of one change can come in another order. nothing else depends on that order
-- - no sweep, forget, nodes; no hook (nothing throws from it, no endless cap)
-- - errors have no payload; a set never throws; an act never throws (what it wrote is its writes)
-- - an act reads nothing of the store: its writes are a function of (value, previous)
-- - f never catches the scheduler's Stop
-- - causes are equal when their runs are (computation, run number): a run's cause is one object
--   in a pulse (causeOf cuts an old one once per pulse), so this is identity there
-- - a run's cause, the pulse it is of, and cut are kept per computation for its latest run
--   (`cause`, `when`, `cut`), not on the run: only a latest run's change carries its cause
--   (scheduler.ts due), and a cut is read only while its run is flagged, so the same
-- - waitsAfter walks at most made + 1 afters, not until a repeat: the same while after-chains are
--   acyclic (Quiescence.lean, Lemma N)
-- - next answers none when nothing is ready (the code's `best!` would throw); with something due
--   that never happens (Quiescence.lean, next_total)
-- - a run's record keeps what each read saw (`seen`), what f gave (`out`) and how it ended
--   (`ended`): the model's, for the theorems
-- - an ends moment's reads (every read of the run, in order, duplicates kept: scheduler.ts's
--   `reads`) are not in Event.ends; a run's record has them, the keys of `seen`
-- - `wrote` is not kept (it is writers inverted); `holding` is all: every kept is cleared at a
--   pulse's end; `acting` is the effect's entry in `acts`; `open` is async only
-- - kept: a list. keep skips a cause whose run is the last kept's (causes.ts: the same object at
--   once), so a cause may come again later. start takes c's kept as the run's given (first: given =
--   c.kept, c.kept = []); finish puts it back in front unless done, and the run gives it up
--   (finish: c.kept = r.given.concat(c.kept), r.given = none). a cause of the given kept again in
--   the run stays after a done end (it was dropped before: a mark naming another computation in a
--   run); here a change in a run names that run, so that cannot happen
-- - a run's values: ins, append if absent (scheduler.ts: w.seen === r.id, run ids unique)
-- - ranIn, heldIn (causes.ts's pulse numbers) are went and all: went is cleared at close
-- - not modelled: listeners (arrays, replaced on add and remove), reads listed only while someone
--   listens, a Run's inside under a symbol, readers walked in place
-- - names: Model's mark is scheduler.ts's due, changed its mark(keys, by), learn its write; Run is
--   its Ran (a run, inside); a computation is its Computer
import Scheduler.Basic

namespace Model

-- an update of a function at one point
def put {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) : α → β :=
  fun x => if x = a then b else f x

@[simp] theorem put_same {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) :
    put f a b a = b := by simp [put]

@[simp] theorem put_ne {α β : Type} [DecidableEq α] (f : α → β) {a x : α} (b : β) (h : x ≠ a) :
    put f a b x = f x := by simp [put, h]

theorem put_apply {α β : Type} [DecidableEq α] (f : α → β) (a : α) (b : β) (x : α) :
    put f a b x = if x = a then b else f x := rfl

-- a read program (scheduler.ts, a computation's f)
inductive Prog (K V : Type) where
  -- returns v
  | value (v : V)
  -- throws
  | error
  -- returns or throws PENDING
  | pending
  -- reads k (tracked; may stop the run), then goes on with what is there
  | read (k : K) (next : Option V → Prog K V)
  -- writes v at k and marks it: mark([k], the run)
  | write (k : K) (v : V) (next : Prog K V)

-- what a computation does with its result (scheduler.ts, set and act)
inductive Kind (K V : Type) where
  -- set: writes the result at `to` and marks it, mark([to], the compute) (the harness's wiring)
  | compute (to : Option K)
  -- act: the writes it makes, given (value, previous); each marked, mark([k], the effect)
  | effect (act : V → Option V → List (K × V))

-- a computation, as made (scheduler.ts, make)
structure Comp (K V : Type) where
  kind : Kind K V
  f : Prog K V
  -- none: the comparison threw
  equal : V → V → Option Bool
  -- make's key: where its results land, its writer from the start
  key : Option K := none

-- what f gave
inductive Out (V : Type) where
  | value (v : V)
  | error
  | pending
  deriving DecidableEq, Repr

-- scheduler.ts, Ended
inductive Ended where
  | done | pending | failed | stopped | looping
  deriving DecidableEq, Repr

-- a run's cause: of runs named (computation, run number) (causes.ts, Cause)
abbrev Why := Cause (Nat × Nat)

-- a run (scheduler.ts, Ran). seen, out, ended: the model's record of it
structure Run (K V : Type) where
  n : Nat
  mark : Nat
  given : List Why
  loop : Option (List Nat)
  values : List Nat := []
  stopped : Option Nat := none
  -- each key read (tracked), and what the store held there then, in order
  seen : List (K × Option V) := []
  -- what f gave; none while going on or stopped
  out : Option (Out V) := none
  -- none while going on
  ended : Option Ended := none

-- a moment (scheduler.ts, Moment), and the calls of set and act. who: by's computation
inductive Event (V : Type) where
  | due (c tick : Nat) (who : Option Nat)
  | starts (c run rank : Nat)
  | ends (c run : Nat) (ended : Ended) (equal : Option Bool) (waits : Option Nat)
      (through : Option (List Nat))
  -- set called with v
  | set (c : Nat) (v : V)
  -- act called with (value, previous)
  | act (c : Nat) (v : V) (previous : Option V)
  -- the act's moment, after it
  | acts (c run : Nat)
  deriving DecidableEq, Repr

-- an event, tagged with the pulse (pulses ended before it) and the round in it
structure Entry (V : Type) where
  pulse : Nat
  round : Nat
  event : Event V
  deriving DecidableEq, Repr

-- the moment's kind: moments, not the calls of set and act
def Event.moment {V : Type} : Event V → Bool
  | .set .. => false
  | .act .. => false
  | _ => true

inductive Phase where
  | runs | acts
  deriving DecidableEq, Repr

-- the scheduler's state, and the host's store
structure State (K V : Type) where
  -- the host's: what each key holds
  store : K → Option V
  -- computations made: 0 .. made - 1 are live
  made : Nat
  -- the tracker: the keys each computation's links reach
  reads : Nat → List K
  -- each key's writer: the compute last named by a change of it
  writers : K → Option Nat
  -- order.ts: the writers its last run read, and the one it waits after
  values : Nat → List Nat
  after : Nat → Option Nat
  -- order.ts due: the tick each became due at (its mark)
  due : Nat → Option Nat
  tick : Nat
  -- c.kept: the causes of the marks since its last run that ended done; never a run's given (start
  -- takes it out, finish puts it back unless done)
  kept : Nat → List Why
  -- causes.ts ran: ran this pulse (or had its cause cut in it)
  went : Nat → Bool
  -- c.ran: its latest run; and that run's cause, the pulse it is of, cut
  ran : Nat → Option (Run K V)
  cause : Nat → Why
  when : Nat → Nat
  cut : Nat → Bool
  -- c.runs
  runs : Nat → Nat
  -- c.loop: the loop of the latest mark; c.looping
  loop : Nat → Option (List Nat)
  looping : Nat → Bool
  -- the effects to act, in the order their runs ended
  acts : List (Nat × V)
  -- a compute's last result given to set; an effect's last acted on
  last : Nat → Option V
  -- pulses ended
  pulses : Nat
  pulsing : Bool
  phase : Phase
  round : Nat
  log : List (Entry V)

variable {K V : Type} [DecidableEq K] [DecidableEq V]

-- before anything is made
def empty : State K V where
  store := fun _ => none
  made := 0
  reads := fun _ => []
  writers := fun _ => none
  values := fun _ => []
  after := fun _ => none
  due := fun _ => none
  tick := 0
  kept := fun _ => []
  went := fun _ => false
  ran := fun _ => none
  cause := fun c => .mk (c, 0) []
  when := fun _ => 0
  cut := fun _ => false
  runs := fun _ => 0
  loop := fun _ => none
  looping := fun _ => false
  acts := []
  last := fun _ => none
  pulses := 0
  pulsing := false
  phase := .runs
  round := 0
  log := []

-- told a moment (scheduler.ts, pass)
def say (s : State K V) (e : Event V) : State K V :=
  { s with log := s.log ++ [⟨s.pulses, s.round, e⟩] }

-- the host's store, written
def store (s : State K V) (k : K) (v : V) : State K V :=
  { s with store := put s.store k (some v) }

-- c's latest run, changed
def edit (s : State K V) (c : Nat) (g : Run K V → Run K V) : State K V :=
  { s with ran := put s.ran c ((s.ran c).map g) }

-- a set's insert
def ins (x : Nat) (l : List Nat) : List Nat := if x ∈ l then l else l ++ [x]

-- causes

-- a cause, its runs by computation only: what causes.ts compares
def plain : Why → Cause Nat
  | .mk o ps => .mk o.1 (ps.attach.map fun ⟨p, _⟩ => plain p)

-- on a path back to a run of t (causes.ts, loop's `on`; Basic.lean, back)
def on (t : Nat) (k : Why) : Bool := (plain k).back t

-- a cause and every cause behind it
def behind : Why → List Why
  | .mk o ps => .mk o ps :: (ps.attach.map fun ⟨p, _⟩ => behind p).flatten

-- the computations on a loop through t, in the order made (causes.ts, loop's answer)
def through (s : State K V) (t : Nat) (k : Why) : List Nat :=
  (List.range s.made).filter fun x => (behind k).any fun y => y.of.1 == x && on t y

-- causes.ts loop: a loop through t when t ran this pulse and k is on a path back to a run of t
def loopof (s : State K V) (k : Why) (t : Nat) : Option (List Nat) :=
  if s.went t && on t k then some (through s t k) else none

-- causes.ts from: a mark kept on t came out of a run of c in this pulse ("from" is lean's)
def came (s : State K V) (t c : Nat) : Bool :=
  s.went c && (s.kept t).any (on c)

-- causes.ts keep: a mark's cause kept on t. the same cause again at once: once
def keep (s : State K V) (t : Nat) (k : Why) : State K V :=
  if (s.kept t).getLast?.map (·.of) = some k.of then s
  else { s with kept := put s.kept t (s.kept t ++ [k]) }

-- scheduler.ts causeOf: c's latest run's cause; one from an earlier pulse is cut to the run alone,
-- of this pulse (causes.run: it ran this pulse)
def causeof (s : State K V) (c : Nat) : State K V × Why :=
  if s.when c = s.pulses then (s, s.cause c)
  else
    let k : Why := .mk (c, ((s.ran c).map (·.n)).getD 0) []
    ({ s with cause := put s.cause c k, when := put s.when c s.pulses, went := put s.went c true }, k)

-- marks

-- the due part of a mark: due at t unless it is (order.set, and the due moment)
def due (s : State K V) (d t : Nat) (who : Option Nat) : State K V :=
  if (s.due d).isSome then s else say { s with due := put s.due d (some t) } (.due d t who)

-- the rest of a mark, after the cause is kept: loop l, the run that made it flagged or not
def settle (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat)) (flagged : Bool) :
    State K V :=
  -- a loop mark from a run known to loop: the loop is cut there
  if l.isSome && flagged then
    match who with
    | some c => { s with cut := put s.cut c true }
    | none => s
  else
    let s := { s with loop := put s.loop d l }
    -- a looping computation is due again only by a change from outside the loop
    if s.looping d && l.isSome then s
    else due { s with looping := put s.looping d false } d t who

-- scheduler.ts due: d marked at t, by the latest run of who (which has one), or from outside
def mark (s : State K V) (d t : Nat) (who : Option Nat) : State K V :=
  match who with
  | none => settle s d t none none false
  | some c =>
    let (s, k) := causeof s c
    let s := keep s d k
    settle s d t (some c) (loopof s k d) ((s.ran c).bind (·.loop)).isSome

-- the readers of a key, in the order made (the tracker's readers)
def readers (s : State K V) (k : K) : List Nat :=
  (List.range s.made).filter fun d => decide (k ∈ s.reads d)

-- who, if it names a computation with a run (scheduler.ts mark's r)
def runof (s : State K V) (who : Option Nat) : Option Nat :=
  who.filter fun c => (s.ran c).isSome

-- scheduler.ts write: k's writer, the compute named by the change
def learn (s : State K V) (k : K) : Option Nat → State K V
  | some c => { s with writers := put s.writers k (some c) }
  | none => s

-- scheduler.ts mark's loop: what read k is marked at t, by the run r
def tell (s : State K V) (k : K) (t : Nat) (r : Option Nat) : State K V :=
  (readers s k).foldl (fun s d => mark s d t r) s

-- scheduler.ts mark(keys, by): these keys changed, by who (its latest run), or from outside. a
-- compute named so becomes their writer; what read them is marked at the next tick
def changed (cs : Nat → Comp K V) (s : State K V) (keys : List K) (who : Option Nat) :
    State K V :=
  let t := s.tick + 1
  let s := { s with tick := t }
  let r := runof s who
  let w := r.filter fun c => match (cs c).kind with | .compute _ => true | .effect _ => false
  keys.foldl (fun s k => tell (learn s k w) k t r) s

-- reads

-- the afters from w, at most f of them
def chain (s : State K V) : Nat → Nat → List Nat
  | 0, _ => []
  | f + 1, x => match s.after x with
    | none => []
    | some y => y :: chain s f y

-- scheduler.ts waitsAfter: c is on w's after-chain
def waits (s : State K V) (w c : Nat) : Bool := decide (c ∈ chain s (s.made + 1) w)

-- scheduler.ts first's f(own), with track at each read: c's run of p, to its end or its stop
def exec (cs : Nat → Comp K V) (c : Nat) : State K V → Prog K V → State K V × Out V
  | s, .value v => (s, .value v)
  | s, .error => (s, .error)
  | s, .pending => (s, .pending)
  | s, .read k next =>
    let x := s.store k
    -- tracked
    let s := { s with reads := put s.reads c (s.reads c ++ [k]) }
    let s := edit s c fun r => { r with seen := r.seen ++ [(k, x)] }
    match s.writers k with
    | none => exec cs c s (next x)
    | some w =>
      if w = c then exec cs c s (next x)
      else
        let s := edit s c fun r => { r with values := ins w r.values }
        -- its writer due: the run stops, unless the writer waits after it or is due by its doing
        if (s.due w).isSome && !waits s w c && !came s w c then
          (edit s c fun r => { r with stopped := some w }, .error)
        else exec cs c s (next x)
  | s, .write k v next => exec cs c (changed cs (store s k v) [k] (some c)) next

-- runs

-- a failure of a flagged run that cut a loop: finish ends it looping, through its loop (L3)
def fails (s : State K V) (c : Nat) (r : Run K V) (ended : Ended) : Bool :=
  ended == .failed && r.loop.isSome && s.cut c

-- scheduler.ts finish. the run's flag ends with it, unless it ended pending (it may land: L1)
def finish (s : State K V) (c : Nat) (ended : Ended) (equal : Option Bool) (waits : Option Nat)
    (through : Option (List Nat)) : State K V :=
  match s.ran c with
  | none => s
  | some r =>
    let through := if fails s c r ended then r.loop else through
    let ended := if fails s c r ended then .looping else ended
    -- not done: what it was given goes back in front of c's kept, and the run gives it up
    let s := if ended ≠ .done then { s with kept := put s.kept c (r.given ++ s.kept c) } else s
    let s := if ended = .looping then { s with looping := put s.looping c true } else s
    let s := if ended ≠ .stopped then { s with values := put s.values c r.values } else s
    let r' := { r with
      ended := some ended, given := [], loop := if ended = .pending then r.loop else none }
    let s := { s with ran := put s.ran c (some r') }
    say s (.ends c r.n ended equal waits through)

-- scheduler.ts stop: due again at its old mark, waiting after its writer
def stop (s : State K V) (c : Nat) : State K V :=
  match s.ran c with
  | none => s
  | some r =>
    -- no mark reached it in the stopped run: it runs again as flagged as it was
    let s := if (s.due c).isNone then { s with loop := put s.loop c r.loop } else s
    let s := { s with after := put s.after c r.stopped, due := put s.due c (some r.mark) }
    finish s c .stopped none r.stopped none

-- helpers.ts same, against the last: none when equal threw
def same (eq : V → V → Option Bool) (v : V) : Option V → Option Bool
  | none => some false
  | some l => eq v l

-- scheduler.ts set, as the harness wires it: called with v, it writes v at to and says so
def set (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V) : State K V :=
  let s := say s (.set c v)
  match (cs c).kind with
  | .compute (some k) => changed cs (store s k v) [k] (some c)
  | _ => s

-- scheduler.ts result: equal to the last, it stops there
def result (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V) : State K V :=
  match same (cs c).equal v (s.last c) with
  | none => finish s c .failed none none none
  | some e =>
    let flag := ((s.ran c).bind (·.loop))
    -- flagged: a new result, or a loop it cut, ends looping
    if flag.isSome && (!e || s.cut c) then finish s c .looping (some e) none flag
    else match (cs c).kind with
      | .effect _ =>
        let s := if e then s else { s with acts := s.acts ++ [(c, v)] }
        finish s c .done (some e) none none
      | .compute _ =>
        if e then finish s c .done (some e) none none
        else
          let s := set cs s c v
          let s := { s with last := put s.last c (some v) }
          finish s c .done (some e) none none

-- scheduler.ts first, up to f: not due, after nothing, a new run of c given the causes kept,
-- taken out of c's kept
def start (s : State K V) (c rank : Nat) : State K V :=
  let n := s.runs c + 1
  let g := s.kept c
  let r : Run K V := { n, mark := (s.due c).getD 0, given := g, loop := s.loop c }
  let s := { s with
    due := put s.due c none, after := put s.after c none, runs := put s.runs c n,
    kept := put s.kept c [],
    went := put s.went c true, loop := put s.loop c none, ran := put s.ran c (some r),
    cause := put s.cause c (.mk (c, n) g), when := put s.when c s.pulses, cut := put s.cut c false,
    -- an effect acts on its latest run's value only
    acts := s.acts.filter fun a => a.1 ≠ c }
  say s (.starts c n rank)

-- scheduler.ts first, after f gave o: stopped, failed, pending, or a result
def ending (cs : Nat → Comp K V) (s : State K V) (c : Nat) (o : Out V) : State K V :=
  if ((s.ran c).bind (·.stopped)).isSome then stop s c
  else
    let s := edit s c fun r => { r with out := some o }
    match o with
    | .error => finish s c .failed none none none
    | .pending => finish s c .pending none none none
    | .value v => result cs s c v

-- scheduler.ts first: c's run, from its start to its end
def first (cs : Nat → Comp K V) (s : State K V) (c rank : Nat) : State K V :=
  let (s, o) := exec cs c (start s c rank) (cs c).f
  -- the run's end: the links it did not read again are dropped
  let s := { s with reads := put s.reads c (((s.ran c).map fun r => r.seen.map (·.1)).getD []) }
  ending cs s c o

-- acts

-- scheduler.ts act: e acts on v, with the value it acted on last. due again: its value is old, it
-- does not act; its next run does
def act (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V) : State K V :=
  if (s.due e).isSome then s
  else match (cs e).kind with
    | .compute _ => s
    | .effect g =>
      let p := s.last e
      let s := say s (.act e v p)
      let s := (g v p).foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s
      let s := { s with last := put s.last e (some v) }
      say s (.acts e (((s.ran e).map (·.n)).getD 0))

-- order

-- order.ts edges: the writers p's last run read, and the one it waits after; live, not p
def edges (s : State K V) (p : Nat) : List Nat :=
  (s.values p ++ (s.after p).toList).filter fun q => q != p && q < s.made

-- order.ts next's candidates: due, and not waiting after a due one
def ready (s : State K V) (p : Nat) : Bool :=
  (s.due p).isSome && match s.after p with
    | some q => (s.due q).isNone
    | none => true

-- order.ts next: the ready one least by (rank, mark, n)
def next (rank : State K V → Nat → Nat) (s : State K V) : Option Nat :=
  let key := fun p => (rank s p, (s.due p).getD 0)
  ((List.range s.made).filter (ready s)).foldl (fun best p => match best with
    | none => some p
    | some b =>
      if (key p).1 < (key b).1 || ((key p).1 == (key b).1 && (key p).2 < (key b).2) then some p
      else some b) none

-- pulses

-- one step of a pulse: a run (the run phase), an act (the act phase), or the next round. none:
-- nothing is due and no act is left, the pulse ends (scheduler.ts pulse's loop)
def step (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (s : State K V) :
    Option (State K V) :=
  match s.phase with
  | .runs => match next rank s with
    | some c => some (first cs s c (rank s c))
    | none => some { s with phase := .acts }
  | .acts => match s.acts with
    | a :: rest => some (act cs { s with acts := rest } a.1 a.2)
    | [] =>
      if (List.range s.made).any fun p => (s.due p).isSome then
        some { s with phase := .runs, round := s.round + 1 }
      else none

-- a pulse begins
def begin (s : State K V) : State K V :=
  { s with pulsing := true, phase := .runs, round := 0 }

-- a pulse ends: causes and runs forgotten (causes.end), pulses ended counted
def close (s : State K V) : State K V :=
  { s with pulsing := false, kept := fun _ => [], went := fun _ => false,
           pulses := s.pulses + 1, round := 0, phase := .runs }

-- steps until the pulse ends, at most fuel of them; none: still going
def steps (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) : Nat → State K V → Option (State K V)
  | 0, _ => none
  | f + 1, s => match step cs rank s with
    | some s' => steps cs rank f s'
    | none => some (close s)

-- scheduler.ts pulse, with fuel: none when it did not end within fuel steps
def pulse (cs : Nat → Comp K V) (rank : State K V → Nat → Nat) (fuel : Nat) (s : State K V) :
    Option (State K V) :=
  steps cs rank fuel (begin s)

-- the host

-- scheduler.ts make (compute, effect): the next computation, due at the next tick
def make (cs : Nat → Comp K V) (s : State K V) : State K V :=
  let c := s.made
  let s := { s with made := c + 1 }
  let s := match (cs c).key with
    | some k => { s with writers := put s.writers k (some c) }
    | none => s
  let t := s.tick + 1
  mark { s with tick := t } c t none

-- the harness's write: each kept at its key, then mark(keys), from outside
def write (cs : Nat → Comp K V) (s : State K V) (kvs : List (K × V)) : State K V :=
  changed cs (kvs.foldl (fun s kv => store s kv.1 kv.2) s) (kvs.map (·.1)) none

-- what the theorems read

-- a run from scratch on a store: what f gives, and each key read with what was there (A2: a
-- write in it is passed over)
def eval (st : K → Option V) : Prog K V → Out V × List (K × Option V)
  | .value v => (.value v, [])
  | .error => (.error, [])
  | .pending => (.pending, [])
  | .read k next =>
    let r := eval st (next (st k))
    (r.1, (k, st k) :: r.2)
  | .write _ _ next => eval st next

-- no writes in runs (A2)
def nowrites : Prog K V → Prop
  | .value _ => True
  | .error => True
  | .pending => True
  | .read _ next => ∀ x, nowrites (next x)
  | .write .. => False

-- the observations: set and act calls, with their pulse and round
def observations (s : State K V) : List (Entry V) :=
  s.log.filter fun e => !e.event.moment

-- the moments of a pulse
def moments (s : State K V) (p : Nat) : List (Event V) :=
  (s.log.filter fun e => e.pulse == p && e.event.moment).map (·.event)

-- the runs of c started in a pulse's round, and those that ended other than stopped
def started (s : State K V) (p r c : Nat) : Nat :=
  (s.log.filter fun e => e.pulse == p && e.round == r && match e.event with
    | .starts d .. => d == c
    | _ => false).length

def completed (s : State K V) (p r c : Nat) : Nat :=
  (s.log.filter fun e => e.pulse == p && e.round == r && match e.event with
    | .ends d _ ended .. => d == c && ended != .stopped
    | _ => false).length

end Model

-- fidelity: conformance scenarios (core/scheduler/conformance/scheduler) on the model, checked by
-- evaluation (#guard). computations are named by n; the scope o is not one
namespace Model.Check

open Model

-- the ranks of rank.ts by brute force: a component with nothing after it is 0, else one more than
-- the most of what it is after (Rank.lean proves rank.ts ranked)
def reach (n : Nat) (e : Nat → List Nat) (p : Nat) : List Nat :=
  (List.range (n + 1)).foldl (fun acc _ => acc ++ (acc.flatMap e).filter (· ∉ acc)) (e p)

def ranks (n : Nat) (e : Nat → List Nat) : Nat → Nat := go (n + 1) where
  go : Nat → Nat → Nat
  | 0, _ => 0
  | f + 1, p =>
    let scc := (List.range n).filter fun x => x == p || (x ∈ reach n e p && p ∈ reach n e x)
    ((scc.flatMap e).filter (· ∉ scc)).foldl (fun m q => max m (go f q + 1)) 0

-- the harness's values: null, numbers, pairs (a list of two)
inductive J where
  | null | num (n : Int) | pair (a b : J)
  deriving DecidableEq, Repr

-- sum's: null is 0
def J.int : Option J → Int
  | some (.num n) => n
  | _ => 0

def rk (s : State String J) : Nat → Nat := ranks s.made (edges s)
-- Object.is, and equal "json": the same here
def jeq : J → J → Option Bool := fun a b => some (a == b)
def cmp (f : Prog String J) (to : String) : Comp String J :=
  { kind := .compute (some to), f, equal := jeq }
def eff (f : Prog String J) (act : J → Option J → List (String × J)) : Comp String J :=
  { kind := .effect act, f, equal := jeq }
def go (cs : Nat → Comp String J) (s : State String J) : State String J :=
  (pulse cs rk 1000 s).getD s
def makes (cs : Nat → Comp String J) (n : Nat) (s : State String J) : State String J :=
  (List.range n).foldl (fun s _ => make cs s) s

-- 03-diamond: each side once, the join after both, the effect once, on the whole
def diamond : Nat → Comp String J
  | 0 => cmp (.read "x" fun x => .value (.num (J.int x + 1))) "b"
  | 1 => cmp (.read "x" fun x => .read "x" fun y => .value (.num (J.int x + J.int y))) "c"
  | 2 => cmp (.read "b" fun x => .read "c" fun y => .value (.num (J.int x + J.int y))) "d"
  | _ => eff (.read "d" fun x => .value (x.getD .null)) (fun _ _ => [])
def d1 := go diamond (makes diamond 4 (write diamond empty [("x", .num 1)]))
def d2 := write diamond d1 [("x", .num 2)]
def d3 := go diamond d2
#guard d2.tick == 9
#guard moments d3 1 == [.due 0 9 none, .due 1 9 none, .starts 0 2 0, .due 2 10 (some 0),
  .ends 0 2 .done (some false) none none, .starts 1 2 0, .ends 1 2 .done (some false) none none,
  .starts 2 2 1, .due 3 12 (some 2), .ends 2 2 .done (some false) none none, .starts 3 2 2,
  .ends 3 2 .done (some false) none none, .acts 3 2]
#guard (observations d3).filter (fun e => match e.event with | .act .. => true | _ => false) ==
  [⟨0, 0, .act 3 (.num 4) none⟩, ⟨1, 0, .act 3 (.num 7) (some (.num 4))⟩]
#guard d3.store "d" == some (.num 7)

-- 12-loop-set: a compute whose set changes what it read: a loop through it
def selfloop : Nat → Comp String J
  | _ => cmp (.read "c" fun x => .value (.num (J.int x + 1))) "c"
def l1 := go selfloop (make selfloop empty)
def l2 := go selfloop l1
def l3 := go selfloop (write selfloop l2 [("c", .num 10)])
#guard moments l1 0 == [.due 0 1 none, .starts 0 1 0, .due 0 2 (some 0),
  .ends 0 1 .done (some false) none none, .starts 0 2 0,
  .ends 0 2 .looping (some false) none (some [0])]
#guard l1.store "c" == some (.num 1)
#guard moments l2 1 == []
#guard l3.store "c" == some (.num 11)
#guard moments l3 2 == [.due 0 3 none, .starts 0 3 0, .due 0 4 (some 0),
  .ends 0 3 .done (some false) none none, .starts 0 4 0,
  .ends 0 4 .looping (some false) none (some [0])]

-- 35-acts-due: an act that makes another effect due again: that act is skipped (C7)
def actsdue : Nat → Comp String J
  | 0 => eff (.read "a" fun x => .value (x.getD .null))
      (fun v _ => [("b", .num (2 * J.int (some v)))])
  | _ => eff (.read "a" fun x => .read "b" fun y => .value (.pair (x.getD .null) (y.getD .null)))
      (fun _ _ => [])
def a1 := go actsdue (write actsdue (makes actsdue 2 empty) [("a", .num 2)])
#guard (observations a1).map (·.event) ==
  [.act 0 (.num 2) none, .act 1 (.pair (.num 2) (.num 4)) none]

-- 07-stopped: a read of a key whose writer is due stops the run; it runs again after it
def stopped : Nat → Comp String J
  | 0 => cmp (.read "flag" fun f => if f = some (.num 1) then .read "w" fun w => .value (w.getD .null)
      else .value (.num 0)) "q"
  | _ => cmp (.read "x" fun x => .value (.num (J.int x + 1))) "w"
def t1 := go stopped (makes stopped 2 (write stopped empty [("flag", .num 0), ("x", .num 1)]))
def t2 := write stopped t1 [("flag", .num 1), ("x", .num 5)]
def t3 := go stopped t2
#guard t2.tick == 6
#guard moments t3 1 == [.due 0 6 none, .due 1 6 none, .starts 0 2 0,
  .ends 0 2 .stopped none (some 1) none, .starts 1 2 0, .ends 1 2 .done (some false) none none,
  .starts 0 3 1, .ends 0 3 .done (some false) none none]
#guard t3.store "q" == some (.num 6)

-- 30-loop-stopped: a flagged run that stops keeps its flag: the loop ends (C1, F1)
def c1 : Nat → Comp String J
  | 0 => cmp (.read "k" fun k => .read "j" fun j => .value (.num (J.int k + 1 + J.int j % 1))) "k"
  | _ => cmp (.read "k" fun k => .value (.num (J.int k % 1))) "j"
def c1a := pulse c1 rk 1000 (makes c1 2 empty)
#guard (c1a.map fun s => (s.store "k", s.store "j")) == some (some (.num 2), some (.num 0))

-- 33-loop-in-runs: two computes each writing, in its run, what the other reads: the loop ends.
-- the moments are the TS harness's, as run
def inruns : Nat → Comp String J
  | 0 => { kind := .compute none, equal := jeq,
           f := .read "ky" fun y => .write "kx" (.num (J.int y + 1)) (.value (.num 0)) }
  | _ => { kind := .compute none, equal := jeq,
           f := .read "kx" fun x => .write "ky" (.num (J.int x + 1)) (.value (.num 0)) }
def r1 := go inruns (makes inruns 2 empty)
def r3 := go inruns (go inruns r1)
#guard moments r1 0 == [.due 0 1 none, .due 1 2 none, .starts 0 1 0,
  .ends 0 1 .done (some false) none none, .starts 1 1 0, .due 0 4 (some 1),
  .ends 1 1 .done (some false) none none, .starts 0 2 0, .due 1 5 (some 0),
  .ends 0 2 .done (some true) none none, .starts 1 2 0,
  .ends 1 2 .looping (some true) none (some [0, 1])]
#guard (r1.store "kx", r1.store "ky") == (some (.num 3), some (.num 4))
#guard moments r3 1 == [] && moments r3 2 == []

-- 53-loop-flag-ends: a run's flag ends with it (L1). a change the host names by c, after c's
-- flagged run ended done, makes c due as a loop through it; its run, flagged, ends looping
def flagged : Nat → Comp String J
  | _ => cmp (.read "c" fun x => if x = none then .value (.num 1)
      else .read "c" fun y => .value (y.getD .null)) "c"
def f1 := go flagged (make flagged empty)
def f2 := changed flagged (store f1 "c" (.num 7)) ["c"] (some 0)
def f3 := go flagged f2
#guard moments f1 0 == [.due 0 1 none, .starts 0 1 0, .due 0 2 (some 0),
  .ends 0 1 .done (some false) none none, .starts 0 2 0, .ends 0 2 .done (some true) none none]
#guard ((f1.ran 0).bind (·.loop)) == none
#guard moments f3 1 == [.due 0 3 (some 0), .starts 0 3 0,
  .ends 0 3 .looping (some false) none (some [0])]
#guard (f3.store "c", f3.due 0) == (some (.num 7), none)
#guard moments (go flagged f3) 2 == []

-- a change the host names by c while c's latest run is flagged and pending (a run ending pending
-- keeps its flag): a loop mark, cut. c is not due, its pending run read c = 1, and f from scratch
-- now gives 7. so Theorem 2 (Quiescence.lean, Wide) asks the computation the host names to have
-- an unflagged latest run. the same in the TS (harness: f = if c = null then 1 else if c = 1 then
-- pending else c; pulse; run(c) writing c := 7; pulse: no moment, c holds 7, run 2 pending)
def hostcut : Nat → Comp String J
  | _ => cmp (.read "c" fun x => if x = none then .value (.num 1)
      else .read "c" fun y => if y = some (.num 1) then .pending
      else .read "c" fun z => .value (z.getD .null)) "c"
def u1 := go hostcut (make hostcut empty)
def u2 := changed hostcut (store u1 "c" (.num 7)) ["c"] (some 0)
def u3 := go hostcut u2
#guard moments u1 0 == [.due 0 1 none, .starts 0 1 0, .due 0 2 (some 0),
  .ends 0 1 .done (some false) none none, .starts 0 2 0, .ends 0 2 .pending none none none]
#guard ((u1.ran 0).bind (·.loop)).isSome
#guard moments u3 1 == [] && u3.due 0 == none && u3.cut 0
#guard ((u3.ran 0).bind (·.ended), (u3.ran 0).map (·.seen), u3.store "c") ==
  (some .pending, some [("c", some (.num 1)), ("c", some (.num 1))], some (.num 7))
#guard (eval u3.store (hostcut 0).f).1 == .value (.num 7)

end Model.Check
