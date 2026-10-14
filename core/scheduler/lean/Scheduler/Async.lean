-- LLM generated working output
-- async (A8 dropped) on the model (Model.lean): promises, awaiting, settle, landed, land, and changes
-- named by an awaited run's own read. built on Model's pieces (start, exec, ending, result, finish,
-- act, next, mark, changed); the sync step is Model's.
--
-- the model:
-- - a promise is a value: `promise : V → Bool` (helpers.ts isPromise), a parameter. a run whose f
--   gives one ends pending (awaiting): Model's ending sees pending (hide), and the run's handle
--   (its computation and record) waits in `awaiting` until it settles. `gave`: the promise the
--   latest run gave
-- - settle: the environment's, between pulses: any awaiting run, latest or not, settles to a
--   value, an error or PENDING (Out). still the latest: it goes to `landed`; else nowhere
-- - named: a change after an await, between pulses: kvs kept, then changed(keys, the run's own
--   read). the latest run: Model's changed by c. an older one: changed by c with c's record that
--   run's for the call, its cause cut to it alone (causeOf), then c's latest put back
-- - land: at the start of each round (pulse's loop), the first landed: the run still c's latest
--   and c not due, its outcome is the run's `out`, then failed, pending, or Model's result
-- - Check, at the end: scenarios 15, 36, 37, 39, 40 as the TS runs them, and the counterexamples
--
-- departures from scheduler.ts, beyond Model.lean's:
-- - settle and named only between pulses (pulsing false): a promise cannot settle in a pulse
-- - a run's continuation is what the environment does: named changes, then a settle. a read after
--   the await (stopped) is a settle to an error
-- - land and settle ask "still the latest" by the run's number on c's record, not c.runs (the same:
--   start sets both)
--
-- proved, for every state Reach reaches (A2):
-- - Reach.good: Good, Quiescence's invariant with promises. follows: f along what it read gave
--   its out, or the promise the run gave (gave). fresh (Lemma F): not due, done, failed or
--   pending, its loop not cut (cut): what it read is still there. cut: a cut loop's run is flagged
--   and not done. what is owed (awaiting, landed) is of runs made, each once, and the latest
--   run's is pending with a promise given
-- - quiescence_done, quiescent (Theorem 2): a compute done and not due holds its value (last, up to
--   equal), and f from scratch on the store gives that value, or the same promise the value landed
--   for, reading the same. a landed result is from a run whose reads are still fresh (§13.3)
-- - quiescence_pending: pending, not due, not cut: f from scratch gives PENDING or the same
--   promise; pending_keeps, land_keeps: a run ending pending, or a landing of PENDING, sets
--   nothing, so the key holds the last set value
-- - act_fresh, step_acts (Theorem 3): an act is called with its effect's value from scratch on the
--   store at the act (or what the same promise landed with), and at that moment every compute
--   done and not due holds its value on that store: no act sees a landed value mixed with newer
--   inputs (C8). only a pending, due, failed or looping compute's key can be behind
-- - Reach.live, loop_went (Theorem 7 without A8, F7): every computation behind a live cause went
--   this pulse; a loop a mark finds is of computations that went. step_went, named_went, tell_went:
--   went is set only by a run's start or a change its run named (a landing's set, an act, a change
--   after an await), and close clears it. so a flagged cycle closes in this pulse or through a
--   change named by a run since the last pulse
-- - pulse_sync (termination with landings): a pulse is its landings, one step each at its start,
--   then exactly Model's pulse of the same computations with each promise read as PENDING (erase):
--   it ends whenever that one does, within as many more steps as landings
--
-- assumed (hypotheses where used):
-- - A2: no f writes in its run
-- - tame: a change named by a handle is by a run still its computation's latest, or unflagged.
--   without it Theorem 2 is false: Check's `stale` (and the TS: an older flagged run's own change
--   is cut as a loop, though its computation's latest run, done, read the key)
-- - the host's changes name no computation (Quiescence.lean); host writes may come any time
--
-- not claimed: failed or pending runs whose loop was cut (a flagged run's own change after its
-- await) may hold stale reads: Check's `cutfail` lands failed, f from scratch now gives a promise
import Scheduler.Quiescence

namespace Model.Async

-- the scheduler with promises: the model's state, and what the promises left
structure State (K V : Type) where
  s : Model.State K V
  -- settled promises for the next pulse: the computation, the run's number, how it settled
  landed : List (Nat × Nat × Out V)
  -- the promises not settled, in the order given: each run's computation and record (its handle)
  awaiting : List (Nat × Run K V)
  -- the promise each computation's latest run gave, if it gave one
  gave : Nat → Option V

variable {K V : Type} [DecidableEq K] [DecidableEq V]

def empty : State K V := ⟨Model.empty, [], [], fun _ => none⟩

-- what f gave, as ending sees it: a promise is pending
def hide (promise : V → Bool) : Out V → Out V
  | .value v => if promise v then .pending else .value v
  | o => o

-- the promise f gave, if it gave one
def given (promise : V → Bool) : Out V → Option V
  | .value v => if promise v then some v else none
  | _ => none

-- scheduler.ts first: c's run. a promise given (and not stopped): it ends pending, awaiting
def run (cs : Nat → Comp K V) (promise : V → Bool) (a : State K V) (c rk : Nat) : State K V :=
  let (s, o) := exec cs c (start a.s c rk) (cs c).f
  let s := { s with reads := put s.reads c (((s.ran c).map fun r => r.seen.map (·.1)).getD []) }
  let p := if ((s.ran c).bind (·.stopped)).isSome then none else given promise o
  let s' := ending cs s c (hide promise o)
  { s := s', landed := a.landed, gave := put a.gave c p,
    awaiting := match p, s'.ran c with
      | some _, some r => a.awaiting ++ [(c, r)]
      | _, _ => a.awaiting }

-- scheduler.ts land: the run still c's latest and c not due, its outcome lands; else nowhere
def land (cs : Nat → Comp K V) (a : State K V) (c n : Nat) (o : Out V) : State K V :=
  if (a.s.ran c).map (·.n) = some n ∧ a.s.due c = none then
    let s := edit a.s c fun r => { r with out := some o }
    { a with s := match o with
      | .error => finish s c .failed none none none
      | .pending => finish s c .pending none none none
      | .value v => result cs s c v }
  else a

-- awaiting's settle: the i-th promise settles to o (the environment's); its run still the latest,
-- it waits in landed for the next pulse
def settle (a : State K V) (i : Nat) (o : Out V) : State K V :=
  match a.awaiting[i]? with
  | none => a
  | some (c, r) =>
    { a with awaiting := a.awaiting.eraseIdx i,
             landed := if (a.s.ran c).map (·.n) = some r.n then a.landed ++ [(c, r.n, o)]
               else a.landed }

-- a change after an await: kvs kept, then changed(keys, the i-th run's own read)
def named (cs : Nat → Comp K V) (a : State K V) (i : Nat) (kvs : List (K × V)) : State K V :=
  match a.awaiting[i]? with
  | none => a
  | some (c, r) =>
    let s := kvs.foldl (fun s kv => store s kv.1 kv.2) a.s
    let keys := kvs.map (·.1)
    if (s.ran c).map (·.n) = some r.n then { a with s := changed cs s keys (some c) }
    else
      -- an older run: c's record is that run's for the call, its cause not this pulse's (cut)
      let s1 := { s with ran := put s.ran c (some r), when := put s.when c (s.pulses + 1) }
      let s2 := changed cs s1 keys (some c)
      { a with s := { s2 with ran := s.ran, cause := put s2.cause c (s.cause c),
                               when := put s2.when c (s.when c), cut := put s2.cut c (s.cut c) } }

-- one step of a pulse: a landing (at a round's start), a run, an act, or the next round
def step (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    (a : State K V) : Option (State K V) :=
  match a.s.phase, a.landed with
  | .runs, (c, n, o) :: rest => some (land cs { a with landed := rest } c n o)
  | .runs, [] => match next rank a.s with
    | some c => some (run cs promise a c (rank a.s c))
    | none => some { a with s := { a.s with phase := .acts } }
  | .acts, _ => (Model.step cs rank a.s).map fun s => { a with s }

def steps (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat) :
    Nat → State K V → Option (State K V)
  | 0, _ => none
  | f + 1, a => match step cs promise rank a with
    | some a' => steps cs promise rank f a'
    | none => some { a with s := close a.s }

-- scheduler.ts pulse, with fuel
def pulse (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    (fuel : Nat) (a : State K V) : Option (State K V) :=
  steps cs promise rank fuel { a with s := begin a.s }

-- the host's, on the model
def make (cs : Nat → Comp K V) (a : State K V) : State K V := { a with s := Model.make cs a.s }
def write (cs : Nat → Comp K V) (a : State K V) (kvs : List (K × V)) : State K V :=
  { a with s := Model.write cs a.s kvs }

end Model.Async

namespace Model.Async

open Relation

set_option linter.unusedSectionVars false
set_option linter.unusedSimpArgs false
set_option linter.unusedVariables false

variable {K V : Type} [DecidableEq K] [DecidableEq V]

-- what a change leaves as it was
structure Calm (s s' : Model.State K V) : Prop where
  store : s'.store = s.store
  made : s'.made = s.made
  reads : s'.reads = s.reads
  after : s'.after = s.after
  ran : s'.ran = s.ran
  runs : s'.runs = s.runs
  acts : s'.acts = s.acts
  last : s'.last = s.last
  pulses : s'.pulses = s.pulses
  pulsing : s'.pulsing = s.pulsing
  phase : s'.phase = s.phase

theorem Calm.refl (s : Model.State K V) : Calm s s :=
  ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem Calm.trans {s s' s'' : Model.State K V} (a : Calm s s') (b : Calm s' s'') : Calm s s'' :=
  ⟨b.1.trans a.1, b.2.trans a.2, b.3.trans a.3, b.4.trans a.4, b.5.trans a.5, b.6.trans a.6,
    b.7.trans a.7, b.8.trans a.8, b.9.trans a.9, b.10.trans a.10, b.11.trans a.11⟩

-- causes over pulses: this pulse's cause, its computation went; between pulses each this pulse's
-- cause is cut, its computation alone
structure Cuts (s : Model.State K V) : Prop where
  went : ∀ c, (s.ran c).isSome → s.when c = s.pulses → s.went c = true
  cut : s.pulsing = false → ∀ c, (s.ran c).isSome → s.when c = s.pulses →
    ∃ n, s.cause c = .mk (c, n) []

theorem Cuts.of_eq {s s' : Model.State K V} (h : Cuts s) (e1 : s'.when = s.when)
    (e2 : s'.pulses = s.pulses) (e3 : s'.went = s.went) (e4 : s'.cause = s.cause)
    (e5 : s'.pulsing = s.pulsing) (e6 : s'.ran = s.ran) : Cuts s' :=
  ⟨fun c hr hc => by rw [e1, e2] at hc; rw [e6] at hr; rw [e3]; exact h.went c hr hc,
    fun hp c hr hc => by rw [e1, e2] at hc; rw [e5] at hp; rw [e6] at hr; rw [e4]; exact h.cut hp c hr hc⟩

theorem causeof_cuts {s : Model.State K V} (h : Cuts s) (c : Nat) (hc : (s.ran c).isSome) :
    Cuts (causeof s c).1 ∧ Calm s (causeof s c).1 ∧ (causeof s c).1.cut = s.cut ∧
    (causeof s c).1.when c = s.pulses ∧ (causeof s c).1.cause c = (causeof s c).2 ∧
    (causeof s c).1.went c = true ∧
    (∀ d, (causeof s c).1.when d = s.when d ∨ (causeof s c).1.when d = s.pulses) ∧
    (∀ d, s.went d = true → (causeof s c).1.went d = true) := by
  unfold causeof
  split
  · rename_i hw
    exact ⟨h, Calm.refl s, rfl, hw, rfl, h.went c hc hw, fun _ => Or.inl rfl, fun _ h => h⟩
  · rename_i hw
    refine ⟨⟨fun d hr hd => ?_, fun hp d hr hd => ?_⟩,
      ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, by simp, by simp, by simp,
      fun d => ?_, fun d hd => ?_⟩
    · by_cases e : d = c
      · subst e; simp
      · simp [put_ne _ _ e] at hd ⊢; exact h.went d hr hd
    · by_cases e : d = c
      · subst e; simp
      · simp [put_ne _ _ e] at hd ⊢; exact h.cut hp d hr hd
    · by_cases e : d = c
      · subst e; simp
      · simp [put_ne _ _ e]
    · by_cases e : d = c
      · subst e; simp
      · simp [put_ne _ _ e, hd]

-- between pulses, causeOf gives c's run alone
theorem causeof_cut {s : Model.State K V} (h : Cuts s) (hp : s.pulsing = false) (c : Nat)
    (hc : (s.ran c).isSome) : ∃ n, (causeof s c).2 = .mk (c, n) [] := by
  unfold causeof
  split
  · rename_i hw; exact h.cut hp c hc hw
  · exact ⟨_, rfl⟩


-- the rest of a mark, from a state with s's runs and dues, its loop mark not cut: moves, d due or
-- looping (Quiescence's mark_moves, its settle)
theorem settle_moves (s s1 : Model.State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (hd : d < s.made) (e1 : s1.made = s.made) (e2 : s1.reads = s.reads) (e3 : s1.ran = s.ran)
    (e4 : s1.after = s.after) (e5 : s1.acts = s.acts) (e6 : s1.last = s.last) (e7 : s1.due = s.due)
    (e8 : s1.looping = s.looping) (e9 : s1.writers = s.writers) (e10 : s1.store = s.store) :
    Moves s (Model.settle s1 d t who l false) ∧
      (((Model.settle s1 d t who l false).due d).isSome ∨ s.looping d = true) := by
  simp only [Model.settle, Bool.and_false, Bool.false_eq_true, ite_false]
  split
  · rename_i h
    simp only [Bool.and_eq_true] at h
    refine ⟨⟨e1, e2, e3, e4, e5, e6, ?_, ?_, ?_, ?_, ?_⟩, Or.inr (by simpa [e8] using h.1)⟩
    · intro x m hx; simpa [e7] using hx
    · intro x hx; simp [e7] at hx; exact Or.inl hx
    · intro x hx; simp [e8, e7] at hx ⊢; exact hx
    · intro k w hk; simp [e9] at hk; exact Or.inl hk
    · intro k hk; simp [e10] at hk
  · simp only [due]
    split
    · rename_i hdue
      refine ⟨⟨e1, e2, e3, e4, e5, e6, ?_, ?_, ?_, ?_, ?_⟩, Or.inl (by simpa [e7] using hdue)⟩
      · intro x m hx; simpa [e7] using hx
      · intro x hx; simp [e7] at hx; exact Or.inl hx
      · intro x hx
        by_cases hxd : x = d
        · subst hxd; simp at hx
        · simp [put_ne _ _ hxd, e8, e7] at hx ⊢; exact hx
      · intro k w hk; simp [e9] at hk; exact Or.inl hk
      · intro k hk; simp [e10] at hk
    · rename_i hdue
      refine ⟨⟨by simp [say, e1], by simp [say, e2], by simp [say, e3], by simp [say, e4],
        by simp [say, e5], by simp [say, e6], ?_, ?_, ?_, ?_, ?_⟩, Or.inl (by simp [say])⟩
      · intro x m hx
        by_cases hxd : x = d
        · subst hxd; simp [e7, hx] at hdue
        · simp [say, put_ne _ _ hxd, e7, hx]
      · intro x hx
        by_cases hxd : x = d
        · subst hxd; exact Or.inr hd
        · simp [say, put_ne _ _ hxd, e7] at hx; exact Or.inl hx
      · intro x hx
        by_cases hxd : x = d
        · subst hxd; simp [say] at hx
        · simp [say, put_ne _ _ hxd, e8, e7] at hx ⊢; exact hx
      · intro k w hk; simp [say, e9] at hk; exact Or.inl hk
      · intro k hk; simp [say, e10] at hk

-- settle and due: they leave the causes, cuts aside
theorem due_calm (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    Calm s (due s d t who) ∧ (due s d t who).cut = s.cut ∧ (due s d t who).when = s.when ∧
    (due s d t who).went = s.went ∧ (due s d t who).cause = s.cause := by
  unfold due
  split
  · exact ⟨Calm.refl s, rfl, rfl, rfl, rfl⟩
  · exact ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl, rfl⟩

theorem settle_calm (s : Model.State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) :
    Calm s (Model.settle s d t who l fl) ∧ (Model.settle s d t who l fl).when = s.when ∧
    (Model.settle s d t who l fl).went = s.went ∧ (Model.settle s d t who l fl).cause = s.cause ∧
    (∀ x, (Model.settle s d t who l fl).cut x = true ↔ s.cut x = true ∨ (who = some x ∧ fl = true ∧ l.isSome)) := by
  unfold Model.settle
  split
  · rename_i h
    simp only [Bool.and_eq_true] at h
    split
    · rename_i c
      refine ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl, fun x => ?_⟩
      by_cases e : x = c
      · subst e; simp [h.1, h.2]
      · simp only [put_ne _ _ e]
        constructor
        · intro hx; exact Or.inl hx
        · rintro (hx | ⟨hx, _⟩)
          · exact hx
          · cases hx; exact absurd rfl e
    · exact ⟨Calm.refl s, rfl, rfl, rfl, fun x => by simp⟩
  · rename_i h
    have hn : ∀ x, ¬(who = some x ∧ fl = true ∧ l.isSome = true) := by
      intro x ⟨_, h2, h3⟩; simp [h2, h3] at h
    dsimp only
    split
    · exact ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl,
        fun x => by simp [hn x]⟩
    · obtain ⟨a, b, c, d', e⟩ := due_calm { s with loop := put s.loop d l, looping := put s.looping d false }
        d t who
      exact ⟨Calm.trans (s' := { s with loop := put s.loop d l, looping := put s.looping d false })
        ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ a, c, d', e,
        fun x => by rw [b]; simp [hn x]⟩

theorem keep_calm (s : Model.State K V) (d : Nat) (k : Why) :
    ∃ kp, keep s d k = { s with kept := kp } := keep_shape s d k

-- a mark: calm; the causes kept cut; a cut grows only at a flagged run that marked
theorem mark_calm {s : Model.State K V} (h : Cuts s) (d t : Nat) (who : Option Nat)
    (hw : ∀ c, who = some c → (s.ran c).isSome) :
    Calm s (mark s d t who) ∧ Cuts (mark s d t who) ∧
    (∀ x, (mark s d t who).cut x = true ↔ s.cut x = true ∨
      (who = some x ∧ ((s.ran x).bind (·.loop)).isSome = true ∧
        (mark s d t who).cut x = true)) ∧
    (∀ x, (mark s d t who).when x = s.when x ∨ (mark s d t who).when x = s.pulses) ∧
    (∀ x, s.went x = true → (mark s d t who).went x = true) := by
  cases who with
  | none =>
    obtain ⟨a, b, c, e, f⟩ := settle_calm s d t none none false
    refine ⟨a, h.of_eq b a.pulses c e a.pulsing a.ran, fun x => ?_, fun x => Or.inl (by
      simp only [mark]; rw [b]), fun x hx => by simp only [mark]; rw [c]; exact hx⟩
    have := f x
    simp only [mark] at this ⊢
    rw [this]; simp
  | some c =>
    simp only [mark]
    obtain ⟨h1, h2, h3, _, _, _, h7, h8⟩ := causeof_cuts h c (hw c rfl)
    generalize hs1 : causeof s c = p at h1 h2 h3 h7 h8
    obtain ⟨s1, k⟩ := p
    simp only at h1 h2 h3 h7 h8 ⊢
    obtain ⟨kp, hk⟩ := keep_calm s1 d k
    rw [hk]
    obtain ⟨a, b, c', e, f⟩ := settle_calm { s1 with kept := kp } d t (some c)
      (loopof { s1 with kept := kp } k d) (((s1.ran c).bind (·.loop)).isSome)
    have a' : Calm s1 { s1 with kept := kp } := ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
    refine ⟨h2.trans (a'.trans a), (h1.of_eq rfl rfl rfl rfl rfl rfl).of_eq b a.pulses c' e a.pulsing a.ran,
      ?_, fun x => by rw [b]; exact h7 x, fun x hx => by rw [c']; exact h8 x hx⟩
    intro x
    constructor
    · intro hx
      rcases (f x).1 hx with hx | ⟨hx1, hx2, _⟩
      · left; simpa [h3] using hx
      · right; cases hx1; refine ⟨rfl, ?_, hx⟩; rw [← h2.ran]; exact hx2
    · intro hx
      rcases hx with hx | ⟨_, _, hx⟩
      · exact (f x).2 (Or.inl (by simpa [h3] using hx))
      · exact hx

theorem fold_inv {α β : Type} (P : β → Prop) (f : β → α → β) (h : ∀ b a, P b → P (f b a)) :
    ∀ (l : List α) (b : β), P b → P (l.foldl f b)
  | [], _, hb => hb
  | a :: l, b, hb => fold_inv P f h l (f b a) (h b a hb)

-- what a change does to the causes and the cuts: calm, cut causes, a cut grows only at the named
-- computation, flagged
def Kept (s0 : Model.State K V) (r : Option Nat) (s1 : Model.State K V) : Prop :=
  Calm s0 s1 ∧ Cuts s1 ∧ (∀ x, s0.cut x = true → s1.cut x = true) ∧
    (∀ x, s1.cut x = true → s0.cut x = true ∨ (r = some x ∧ ((s0.ran x).bind (·.loop)).isSome = true)) ∧
    (∀ x, s1.when x = s0.when x ∨ s1.when x = s0.pulses) ∧ (∀ x, s0.went x = true → s1.went x = true)

theorem Kept.marked {s0 s1 : Model.State K V} {r : Option Nat} (h : Kept s0 r s1) (d t : Nat)
    (hr : ∀ c, r = some c → (s0.ran c).isSome) : Kept s0 r (mark s1 d t r) := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := h
  obtain ⟨m1, m2, m3, m4, m5⟩ := mark_calm h2 d t r (fun c hc => h1.ran ▸ hr c hc)
  refine ⟨h1.trans m1, m2, fun x hx => (m3 x).2 (Or.inl (h3 x hx)), fun x hx => ?_, fun x => ?_,
    fun x hx => m5 x (h6 x hx)⟩
  · rcases (m3 x).1 hx with hx | ⟨hx1, hx2, _⟩
    · exact h4 x hx
    · exact Or.inr ⟨hx1, by rw [← h1.ran]; exact hx2⟩
  · rcases m4 x with e | e
    · rw [e]; exact h5 x
    · right; rw [e, h1.pulses]

theorem Kept.told {s0 s1 : Model.State K V} {r : Option Nat} (h : Kept s0 r s1) (k : K) (t : Nat)
    (hr : ∀ c, r = some c → (s0.ran c).isSome) : Kept s0 r (tell s1 k t r) :=
  fold_inv (Kept s0 r) (fun s d => mark s d t r) (fun _ d hb => hb.marked d t hr) _ _ h

theorem Kept.learned {s0 s1 : Model.State K V} {r : Option Nat} (h : Kept s0 r s1) (k : K)
    (w : Option Nat) : Kept s0 r (learn s1 k w) := by
  obtain ⟨h1, h2, h3, h4, h5, h6⟩ := h
  cases w with
  | none => exact ⟨h1, h2, h3, h4, h5, h6⟩
  | some c =>
    exact ⟨h1.trans ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩,
      h2.of_eq rfl rfl rfl rfl rfl rfl, h3, h4, h5, h6⟩

theorem changed_kept (cs : Nat → Comp K V) {s : Model.State K V} (h : Cuts s) (keys : List K)
    (who : Option Nat) : Kept s (runof s who) (changed cs s keys who) := by
  simp only [changed]
  have h0 : Kept s (runof s who) { s with tick := s.tick + 1 } :=
    ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, h.of_eq rfl rfl rfl rfl rfl rfl,
      fun _ h => h, fun _ h => Or.inl h, fun _ => Or.inl rfl, fun _ h => h⟩
  have e : runof { s with tick := s.tick + 1 } who = runof s who := rfl
  rw [e]
  have hr : ∀ c, runof s who = some c → (s.ran c).isSome := by
    intro c hc; simp only [runof, Option.filter_eq_some_iff] at hc; exact hc.2
  exact fold_inv (Kept s (runof s who)) _ (fun b k hb => (hb.learned k _).told k _ hr) keys _ h0

theorem Kept.when_le {s0 s1 : Model.State K V} {r : Option Nat} (h : Kept s0 r s1)
    (hw : ∀ c, s0.when c ≤ s0.pulses) : ∀ c, s1.when c ≤ s1.pulses := by
  intro c
  rw [h.1.pulses]
  rcases h.2.2.2.2.1 c with e | e <;> rw [e]
  · exact hw c
  · exact Nat.le_refl _

-- a change by an unflagged run or from outside: its cuts as they were
theorem changed_cut (cs : Nat → Comp K V) {s : Model.State K V} (h : Cuts s) (keys : List K)
    (who : Option Nat) (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    (changed cs s keys who).cut = s.cut := by
  obtain ⟨_, _, h3, h4, _⟩ := changed_kept cs h keys who
  funext x
  cases e : s.cut x with
  | true => exact h3 x e
  | false =>
    cases e' : (changed cs s keys who).cut x with
    | false => rfl
    | true =>
      rcases h4 x e' with h | ⟨h1, h2⟩
      · rw [e] at h; cases h
      · simp only [runof, Option.filter_eq_some_iff] at h1
        rw [hw x h1.1] at h2; cases h2

-- a cut cause is on a path back only to its own computation
theorem on_cut (d c n : Nat) : on d (.mk (c, n) [] : Why) = (c == d) := by
  simp [on, plain, Cause.back]

-- between pulses, a mark by a flagged run: d other than c is due or looping, as from outside; c's
-- own mark is a loop mark, cut
theorem mark_flag {s : Model.State K V} (h : Cuts s) (hp : s.pulsing = false) (d t c : Nat)
    (hd : d < s.made) (hf : ((s.ran c).bind (·.loop)).isSome = true) :
    Moves s (mark s d t (some c)) ∧
      (d ≠ c → ((mark s d t (some c)).due d).isSome ∨ s.looping d = true) ∧
      (d = c → (mark s d t (some c)).cut c = true) := by
  have hrc : (s.ran c).isSome := by
    cases e : s.ran c with
    | none => rw [e] at hf; cases hf
    | some _ => rfl
  obtain ⟨n, hn⟩ := causeof_cut h hp c hrc
  obtain ⟨_, h2, h3, _, _, h6⟩ := causeof_cuts h c hrc
  have e3 : (causeof s c).1.due = s.due ∧ (causeof s c).1.looping = s.looping ∧
      (causeof s c).1.writers = s.writers := by
    unfold causeof; split <;> exact ⟨rfl, rfl, rfl⟩
  simp only [mark]
  generalize hs1 : causeof s c = p at hn h2 h3 h6 e3
  obtain ⟨s1, k⟩ := p
  simp only at hn h2 h3 h6 e3 ⊢
  subst hn
  obtain ⟨kp, hk⟩ := keep_calm s1 d (.mk (c, n) [])
  rw [hk]
  have hf' : ((s1.ran c).bind (·.loop)).isSome = true := by rw [h2.ran]; exact hf
  rw [hf']
  by_cases hdc : d = c
  · subst hdc
    have hl : (loopof { s1 with kept := kp } (.mk (d, n) []) d).isSome = true := by
      simp [loopof, h6, on_cut]
    have : Model.settle { s1 with kept := kp } d t (some d) (loopof { s1 with kept := kp } (.mk (d, n) []) d) true =
        { s1 with kept := kp, cut := put s1.cut d true } := by
      simp [Model.settle, hl]
    rw [this]
    refine ⟨Moves.of_eq h2.store h2.made h2.reads e3.2.2 h2.after e3.1 h2.ran e3.2.1 h2.acts h2.last,
      fun h => absurd rfl h, fun _ => by simp⟩
  · have hl : loopof { s1 with kept := kp } (.mk (c, n) []) d = none := by
      simp [loopof, on_cut, Ne.symm hdc]
    rw [hl]
    have : Model.settle { s1 with kept := kp } d t (some c) none true =
        Model.settle { s1 with kept := kp } d t (some c) none false := by
      simp [Model.settle]
    rw [this]
    obtain ⟨m, hm⟩ := settle_moves s { s1 with kept := kp } d t (some c) none hd h2.made h2.reads h2.ran
      h2.after h2.acts h2.last e3.1 e3.2.1 e3.2.2 h2.store
    exact ⟨m, fun _ => hm, fun h => absurd h hdc⟩

-- what a flagged run's marks leave: d due or looping, or d = c and c's cut set
def Flagged (s s' : Model.State K V) (c d : Nat) : Prop :=
  (d ≠ c → (s'.due d).isSome ∨ s.looping d = true) ∧ (d = c → s'.cut c = true)

theorem Flagged.moves {s s' s'' : Model.State K V} {c d : Nat} (h : Flagged s s' c d)
    (m : Moves s' s'') (hc : s'.cut c = true → s''.cut c = true) : Flagged s s'' c d :=
  ⟨fun hd => (h.1 hd).imp_left m.isSome, fun hd => hc (h.2 hd)⟩

theorem marks_flag {c : Nat} (t : Nat) :
    ∀ (ds : List Nat) (s : Model.State K V), Cuts s → s.pulsing = false →
    ((s.ran c).bind (·.loop)).isSome = true → (∀ d ∈ ds, d < s.made) →
    Moves s (ds.foldl (fun s d => mark s d t (some c)) s) ∧
      Cuts (ds.foldl (fun s d => mark s d t (some c)) s) ∧
      (∀ x, s.cut x = true → (ds.foldl (fun s d => mark s d t (some c)) s).cut x = true) ∧
      ∀ d ∈ ds, Flagged s (ds.foldl (fun s d => mark s d t (some c)) s) c d
  | [], s, h, _, _, _ => ⟨Moves.refl s, h, fun _ h => h, by simp⟩
  | d :: ds, s, h, hp, hf, hd => by
    simp only [List.foldl_cons]
    obtain ⟨m1, h1, h2⟩ := mark_flag h hp d t c (hd d (by simp)) hf
    have hrc : (s.ran c).isSome := by
      cases e : s.ran c with
      | none => rw [e] at hf; cases hf
      | some _ => rfl
    obtain ⟨c1, k1, k2, _⟩ := mark_calm h d t (some c) (fun x hx => by cases hx; exact hrc)
    have hp' : (mark s d t (some c)).pulsing = false := by rw [c1.pulsing]; exact hp
    have hf' : (((mark s d t (some c)).ran c).bind (·.loop)).isSome = true := by rw [c1.ran]; exact hf
    have hd' : ∀ x ∈ ds, x < (mark s d t (some c)).made := by
      rw [c1.made]; exact fun x hx => hd x (by simp [hx])
    obtain ⟨m2, k3, k4, h3⟩ := marks_flag t ds (mark s d t (some c)) k1 hp' hf' hd'
    refine ⟨m1.trans m2, k3, fun x hx => k4 x ((k2 x).2 (Or.inl hx)), ?_⟩
    intro x hx
    rcases List.mem_cons.1 hx with rfl | hx
    · exact Flagged.moves ⟨h1, h2⟩ m2 (k4 c)
    · obtain ⟨h4, h5⟩ := h3 x hx
      exact ⟨fun hxc => (h4 hxc).imp_right fun h => (m1.looping x h).1, h5⟩

-- between pulses, a change named by a flagged run of c: moves, but for c, whose mark is cut
theorem changed_flag (cs : Nat → Comp K V) {s : Model.State K V} (h : Cuts s)
    (hp : s.pulsing = false) (keys : List K) (c : Nat)
    (hf : ((s.ran c).bind (·.loop)).isSome = true) :
    Moves s (changed cs s keys (some c)) ∧
      ∀ k ∈ keys, ∀ d, d < s.made → k ∈ s.reads d → Flagged s (changed cs s keys (some c)) c d := by
  have hrc : (s.ran c).isSome = true := by
    cases e : s.ran c with
    | none => rw [e] at hf; cases hf
    | some _ => rfl
  simp only [changed]
  generalize ht : s.tick + 1 = t
  generalize hs0 : ({ s with tick := t } : Model.State K V) = s0
  have m0 : Moves s s0 := by
    subst hs0
    exact Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl
  have c0 : Cuts s0 := by subst hs0; exact h.of_eq rfl rfl rfl rfl rfl rfl
  have hr : runof s0 (some c) = some c := by
    subst hs0; simp [runof, Option.filter, hrc]
  rw [hr]
  generalize hwr : ((some c).filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have hw1 : ∀ x, w = some x → x = c := by
    intro x hx; subst hwr; exact (Option.some.inj (Option.filter_eq_some_iff.1 hx).1).symm
  have fold : ∀ (ks : List K) (s1 : Model.State K V), s1.ran = s.ran → Cuts s1 →
      s1.pulsing = false →
      Moves s1 (ks.foldl (fun s k => tell (learn s k w) k t (some c)) s1) ∧
      Cuts (ks.foldl (fun s k => tell (learn s k w) k t (some c)) s1) ∧
      (∀ x, s1.cut x = true → (ks.foldl (fun s k => tell (learn s k w) k t (some c)) s1).cut x = true) ∧
      ∀ k ∈ ks, ∀ d, d < s1.made → k ∈ s1.reads d →
        Flagged s1 (ks.foldl (fun s k => tell (learn s k w) k t (some c)) s1) c d := by
    intro ks
    induction ks with
    | nil => intro s1 _ h1 _; exact ⟨Moves.refl s1, h1, fun _ h => h, by simp⟩
    | cons k ks ih =>
      intro s1 e1 h1 hp1
      simp only [List.foldl_cons]
      have ml := learn_moves s1 k w (fun x hx => by rw [e1, hw1 x hx]; exact hrc)
      have cl : Calm s1 (learn s1 k w) := by
        cases w <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
      have hl1 : Cuts (learn s1 k w) := by cases w <;> exact h1.of_eq rfl rfl rfl rfl rfl rfl
      have hl2 : (learn s1 k w).cut = s1.cut := by cases w <;> rfl
      obtain ⟨mt, ct, kt, ht⟩ := marks_flag t (readers (learn s1 k w) k) (learn s1 k w) hl1
        (by rw [cl.pulsing]; exact hp1) (by rw [cl.ran, e1]; exact hf)
        (fun d hd => by simp [readers] at hd; exact hd.1)
      have et : (tell (learn s1 k w) k t (some c)).ran = s.ran := by
        simp only [tell]; rw [mt.ran, ml.ran, e1]
      have pt : (tell (learn s1 k w) k t (some c)).pulsing = false := by
        have := (fold_inv (Kept (learn s1 k w) (some c)) (fun s d => mark s d t (some c))
          (fun _ d hb => hb.marked d t (fun x hx => by cases hx; rw [cl.ran, e1]; exact hrc))
          (readers (learn s1 k w) k) _
          ⟨Calm.refl _, hl1, fun _ h => h, fun _ h => Or.inl h, fun _ => Or.inl rfl,
            fun _ h => h⟩).1.pulsing
        simp only [tell]; rw [this, cl.pulsing]; exact hp1
      obtain ⟨mf, cf, kf, hf2⟩ := ih _ et ct pt
      refine ⟨(ml.trans mt).trans mf, cf, fun x hx => kf x (kt x (by rw [hl2]; exact hx)), ?_⟩
      intro k' hk' d hd hrd
      rcases List.mem_cons.1 hk' with rfl | hk'
      · have hd' : d ∈ readers (learn s1 k' w) k' := by
          simp [readers, ml.made, ml.reads, hd, hrd]
        obtain ⟨f1, f2⟩ := ht d hd'
        refine ⟨fun hdc => ?_, fun hdc => kf c (f2 hdc)⟩
        rcases f1 hdc with f | f
        · exact Or.inl (mf.isSome f)
        · exact Or.inr (ml.looping d f).1
      · have hd' : d < (tell (learn s1 k w) k t (some c)).made := by
          simp only [tell]; rw [mt.made, ml.made]; exact hd
        have hrd' : k' ∈ (tell (learn s1 k w) k t (some c)).reads d := by
          simp only [tell]; rw [mt.reads, ml.reads]; exact hrd
        obtain ⟨f1, f2⟩ := hf2 k' hk' d hd' hrd'
        exact ⟨fun hdc => (f1 hdc).imp_right fun f => ((ml.trans mt).looping d f).1, f2⟩
  obtain ⟨mf, _, _, hf2⟩ := fold keys s0 (by subst hs0; rfl) c0 (by subst hs0; exact hp)
  refine ⟨m0.trans mf, fun k hk d hd hrd => ?_⟩
  obtain ⟨f1, f2⟩ := hf2 k hk d (by rw [m0.made]; exact hd) (by rw [m0.reads]; exact hrd)
  exact ⟨fun hdc => (f1 hdc).imp_right fun f => (m0.looping d f).1, f2⟩

-- the invariant

-- the promises owed, by run: each awaiting and each landed one's computation and run number
def owed (a : State K V) : List (Nat × Nat) :=
  a.awaiting.map (fun e => (e.1, e.2.n)) ++ a.landed.map (fun e => (e.1, e.2.1))

-- Quiescence's Good, with promises: f's run gave its out, or the promise it awaits (follows); Lemma
-- F but for a run whose loop was cut (fresh); and what the promises owed are
structure Good (cs : Nat → Comp K V) (promise : V → Bool) (a : State K V) : Prop where
  after_due : ∀ x w, a.s.after x = some w → (a.s.due x).isSome ∧ w < a.s.made
  acyclic : ∀ x, ¬TransGen (aft a.s) x x
  due_made : ∀ x, (a.s.due x).isSome → x < a.s.made
  writers_made : ∀ k w, a.s.writers k = some w → w < a.s.made
  ran_made : ∀ c, (a.s.ran c).isSome → c < a.s.made
  reads : ∀ c, a.s.reads c = ((a.s.ran c).map fun r => r.seen.map (·.1)).getD []
  -- a run not stopped read along f to what f gave: its out, or the promise it gave
  follows : ∀ c r, a.s.ran c = some r → r.ended ≠ some .stopped →
    ∃ o, follow (cs c).f r.seen = some o ∧ (a.gave c = none → r.out = some o) ∧
      ∀ p, a.gave c = some p → o = .value p ∧ promise p = true
  -- Lemma F: not due, done, failed or pending, its loop not cut: what it read is still there
  fresh : ∀ c r, a.s.ran c = some r → a.s.due c = none → settled r → a.s.cut c = false →
    ∀ q ∈ r.seen, a.s.store q.1 = q.2
  looping : ∀ c, a.s.looping c = true → a.s.due c = none ∧ ∃ r, a.s.ran c = some r ∧
    r.ended = some .looping
  pending : ∀ c r, a.s.ran c = some r → r.ended = some .pending → r.out = some .pending
  acts : ∀ e v, (e, v) ∈ a.s.acts → iseffect (cs e) = true ∧ ∃ r, a.s.ran e = some r ∧
    r.loop = none ∧ r.ended = some .done ∧ r.out = some (.value v)
  computes : ∀ c r, iseffect (cs c) = false → a.s.ran c = some r → r.ended = some .done →
    ∃ v, r.out = some (.value v) ∧ near (cs c).equal v (a.s.last c)
  effects : ∀ e r, iseffect (cs e) = true → a.s.ran e = some r → r.ended = some .done →
    ∃ v, r.out = some (.value v) ∧
      (near (cs e).equal v (a.s.last e) ∨ (e, v) ∈ a.s.acts ∨ (a.s.due e).isSome)
  failed : ∀ c r, a.s.ran c = some r → r.ended = some .failed →
    r.out = some .error ∨ ∃ v, r.out = some (.value v) ∧ same (cs c).equal v (a.s.last c) = none
  -- a cut loop: its latest run flagged, not done
  cut : ∀ c, a.s.cut c = true → ∃ r, a.s.ran c = some r ∧ r.loop.isSome ∧ r.ended ≠ some .done
  when_le : ∀ c, a.s.when c ≤ a.s.pulses
  times : Cuts a.s
  runs : ∀ c, ((a.s.ran c).map (·.n)).getD 0 = a.s.runs c
  -- the promises owed: of runs made, each once; the latest run's: pending, a promise given
  owed_le : ∀ x ∈ owed a, 0 < x.2 ∧ x.2 ≤ a.s.runs x.1
  nodup : (owed a).Nodup
  owing : ∀ c r, a.s.ran c = some r → (c, r.n) ∈ owed a → r.ended = some .pending ∧
    (a.gave c).isSome
  -- a handle's flag, while its run is the latest, is that run's
  handles : ∀ c r0, (c, r0) ∈ a.awaiting → ∀ r, a.s.ran c = some r → r.n = r0.n → r.loop = r0.loop

-- s' from s by changes: Quiescence's Moves, but a reader of a key moved may instead have its loop
-- cut, and a cut is new only at a flagged run not done (a flagged run's own change, named)
structure Shift (s s' : Model.State K V) : Prop where
  made : s'.made = s.made
  reads : s'.reads = s.reads
  ran : s'.ran = s.ran
  after : s'.after = s.after
  acts : s'.acts = s.acts
  last : s'.last = s.last
  due : ∀ d m, s.due d = some m → s'.due d = some m
  fresh : ∀ d, (s'.due d).isSome → (s.due d).isSome ∨ d < s.made
  looping : ∀ d, s'.looping d = true → s.looping d = true ∧ s'.due d = s.due d
  writers : ∀ k w, s'.writers k = some w → s.writers k = some w ∨ (s.ran w).isSome
  store : ∀ k, s'.store k ≠ s.store k → ∀ d, d < s.made → k ∈ s.reads d →
    (s'.due d).isSome ∨ s.looping d = true ∨ s'.cut d = true
  cut : ∀ x, s'.cut x = true → s.cut x = true ∨
    ∃ r, s.ran x = some r ∧ r.loop.isSome ∧ r.ended ≠ some .done
  cut_le : ∀ x, s.cut x = true → s'.cut x = true
  runs : s'.runs = s.runs

theorem shifted {s s' : Model.State K V} (m : Moves s s') (hc : s'.cut = s.cut)
    (hr : s'.runs = s.runs) : Shift s s' :=
  ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping, m.writers,
    fun k hk d hd hr => (m.store k hk d hd hr).elim Or.inl (fun h => Or.inr (Or.inl h)),
    fun x h => Or.inl (hc ▸ h), fun x h => hc ▸ h, hr⟩

theorem Shift.isSome {s s' : Model.State K V} (h : Shift s s') {d : Nat} (hd : (s.due d).isSome) :
    (s'.due d).isSome := by
  obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 hd
  simp [h.due d m hm]

-- changes that touch no run keep the invariant
theorem Good.shift {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {s' : Model.State K V} (m : Shift a.s s') (ht : Cuts s')
    (hw : ∀ c, s'.when c ≤ s'.pulses) : Good cs promise { a with s := s' } where
  after_due x w h := by
    rw [m.after] at h
    obtain ⟨h1, h2⟩ := g.after_due x w h
    exact ⟨m.isSome h1, m.made ▸ h2⟩
  acyclic x h := by
    have e : aft s' = aft a.s := by funext a b; simp [aft, m.after]
    exact g.acyclic x (e ▸ h)
  due_made x h := by
    rcases m.fresh x h with h | h
    · exact m.made ▸ g.due_made x h
    · exact m.made ▸ h
  writers_made k w h := by
    rcases m.writers k w h with h | h
    · exact m.made ▸ g.writers_made k w h
    · exact m.made ▸ g.ran_made w h
  ran_made c h := m.made ▸ g.ran_made c (m.ran ▸ h)
  reads c := by simp only; rw [m.reads, m.ran]; exact g.reads c
  follows c r h := g.follows c r (m.ran ▸ h)
  fresh c r h hd hs hc q hq := by
    simp only at h hd hc ⊢
    have h' : a.s.ran c = some r := m.ran ▸ h
    have hd' : a.s.due c = none := by
      cases e : a.s.due c with
      | none => rfl
      | some x => rw [m.due c x e] at hd; simp at hd
    have hc' : a.s.cut c = false := by
      cases e : a.s.cut c with
      | false => rfl
      | true => rw [m.cut_le c e] at hc; cases hc
    by_cases e : s'.store q.1 = a.s.store q.1
    · rw [e]; exact g.fresh c r h' hd' hs hc' q hq
    · exfalso
      have hcm : c < a.s.made := g.ran_made c (by simp [h'])
      have hr : q.1 ∈ a.s.reads c := by
        rw [g.reads c, h']; simp only [Option.map_some, Option.getD_some]
        exact List.mem_map_of_mem hq
      rcases m.store q.1 e c hcm hr with h1 | h1 | h1
      · simp [hd] at h1
      · obtain ⟨_, r', h2, h3⟩ := g.looping c h1
        rw [h'] at h2; cases h2
        rcases hs with h4 | h4 | h4 <;> rw [h4] at h3 <;> cases h3
      · rw [h1] at hc; cases hc
  looping c h := by
    obtain ⟨h1, e⟩ := m.looping c h
    obtain ⟨h2, r, h3, h4⟩ := g.looping c h1
    exact ⟨e.trans h2, r, m.ran ▸ h3, h4⟩
  pending c r h := g.pending c r (m.ran ▸ h)
  acts e v h := by
    simp only at h
    rw [m.acts] at h
    obtain ⟨h1, r, h2⟩ := g.acts e v h
    exact ⟨h1, r, m.ran ▸ h2.1, h2.2⟩
  computes c r hc h hd := by
    obtain ⟨v, h1, h2⟩ := g.computes c r hc (m.ran ▸ h) hd
    exact ⟨v, h1, m.last ▸ h2⟩
  effects e r he h hd := by
    obtain ⟨v, h1, h2⟩ := g.effects e r he (m.ran ▸ h) hd
    refine ⟨v, h1, ?_⟩
    rcases h2 with h2 | h2 | h2
    · exact Or.inl (m.last ▸ h2)
    · exact Or.inr (Or.inl (m.acts ▸ h2))
    · exact Or.inr (Or.inr (m.isSome h2))
  failed c r h hf := m.last ▸ g.failed c r (m.ran ▸ h) hf
  cut c h := by
    simp only at h ⊢; rw [m.ran]
    rcases m.cut c h with h | h
    · exact g.cut c h
    · exact h
  when_le := hw
  times := ht
  runs c := by simp only; rw [m.ran, m.runs]; exact g.runs c
  owed_le x hx := by simp only; rw [m.runs]; exact g.owed_le x hx
  nodup := g.nodup
  owing c r h hx := g.owing c r (m.ran ▸ h) hx
  handles c r0 hx r h := g.handles c r0 hx r (m.ran ▸ h)

theorem Good.moves {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {s' : Model.State K V} (m : Moves a.s s') (hcut : s'.cut = a.s.cut)
    (hruns : s'.runs = a.s.runs) (ht : Cuts s') (hw : ∀ c, s'.when c ≤ s'.pulses) :
    Good cs promise { a with s := s' } :=
  g.shift (shifted m hcut hruns) ht hw

-- the host

theorem Good.empty (cs : Nat → Comp K V) (promise : V → Bool) :
    Good cs promise (Async.empty : State K V) where
  after_due x w h := by simp [Async.empty, Model.empty] at h
  acyclic x h := by
    obtain ⟨z, hz, _⟩ := tg_head h
    simp [aft, Async.empty, Model.empty] at hz
  due_made x h := by simp [Async.empty, Model.empty] at h
  writers_made k w h := by simp [Async.empty, Model.empty] at h
  ran_made c h := by simp [Async.empty, Model.empty] at h
  reads c := by simp [Async.empty, Model.empty]
  follows c r h := by simp [Async.empty, Model.empty] at h
  fresh c r h := by simp [Async.empty, Model.empty] at h
  looping c h := by simp [Async.empty, Model.empty] at h
  pending c r h := by simp [Async.empty, Model.empty] at h
  acts e v h := by simp [Async.empty, Model.empty] at h
  computes c r _ h := by simp [Async.empty, Model.empty] at h
  effects e r _ h := by simp [Async.empty, Model.empty] at h
  failed c r h := by simp [Async.empty, Model.empty] at h
  cut c h := by simp [Async.empty, Model.empty] at h
  when_le c := by simp [Async.empty, Model.empty]
  times := ⟨fun c h => by simp [Async.empty, Model.empty] at h,
    fun _ c h => by simp [Async.empty, Model.empty] at h⟩
  runs c := by simp [Async.empty, Model.empty]
  owed_le x h := by simp [owed, Async.empty] at h
  nodup := by simp [owed, Async.empty]
  owing c r h := by simp [Async.empty, Model.empty] at h
  handles c r0 h := by simp [Async.empty] at h

-- a change from outside
theorem Good.tell {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) (keys : List K) :
    Good cs promise { a with s := changed cs a.s keys none } := by
  have k := changed_kept cs g.times keys none
  exact g.moves (changed_moves cs a.s keys none (by simp)).1
    (changed_cut cs g.times keys none (by simp)) k.1.runs k.2.1 (k.when_le g.when_le)

theorem Good.write {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) (kvs : List (K × V)) : Good cs promise (write cs a kvs) := by
  obtain ⟨st, h1, h2⟩ := stores_shape a.s kvs
  simp only [Async.write, Model.write, h1]
  have ht : Cuts { a.s with store := st } := g.times.of_eq rfl rfl rfl rfl rfl rfl
  obtain ⟨m, h⟩ := changed_moves cs { a.s with store := st } (kvs.map (·.1)) none (by simp)
  have k := changed_kept cs ht (kvs.map (·.1)) none
  refine g.moves ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping,
    m.writers, ?_⟩ (changed_cut cs ht _ none (by simp)) k.1.runs k.2.1 (k.when_le g.when_le)
  intro k hk d hd hr
  by_cases e : (changed cs { a.s with store := st } (kvs.map (·.1)) none).store k = st k
  · rw [e] at hk
    exact h k (h2 k hk) d hd hr
  · exact m.store k e d hd hr

theorem Good.begin {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) : Good cs promise { a with s := Model.begin a.s } :=
  g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl) rfl rfl
    ⟨g.times.went, fun hp => by simp [Model.begin] at hp⟩ g.when_le

theorem Good.close {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) : Good cs promise { a with s := Model.close a.s } := by
  have ht : Cuts (Model.close a.s) := by
    refine ⟨fun c _ hc => ?_, fun _ c _ hc => ?_⟩
    · have := g.when_le c; simp [Model.close] at hc; omega
    · have := g.when_le c; simp [Model.close] at hc; omega
  exact g.moves (s' := Model.close a.s) (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl) rfl rfl
    ht (fun c => by have := g.when_le c; simp [Model.close]; omega)

-- more made, new writers among them; nothing else the invariant reads moves
theorem Good.grow {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {s' : Model.State K V} (e1 : a.s.made ≤ s'.made) (e2 : s'.store = a.s.store)
    (e3 : s'.reads = a.s.reads) (e4 : s'.after = a.s.after) (e5 : s'.due = a.s.due)
    (e6 : s'.ran = a.s.ran) (e7 : s'.looping = a.s.looping) (e8 : s'.acts = a.s.acts)
    (e9 : s'.last = a.s.last) (e10 : ∀ k w, s'.writers k = some w → w < s'.made)
    (e11 : s'.cut = a.s.cut) (e12 : s'.runs = a.s.runs) (e13 : Cuts s')
    (e14 : ∀ c, s'.when c ≤ s'.pulses) : Good cs promise { a with s := s' } where
  after_due x w h := by
    simp only at h ⊢; rw [e4] at h; obtain ⟨h1, h2⟩ := g.after_due x w h
    exact ⟨e5 ▸ h1, by omega⟩
  acyclic x h := by
    have e : aft s' = aft a.s := by funext a b; simp [aft, e4]
    exact g.acyclic x (e ▸ h)
  due_made x h := by have := g.due_made x (e5 ▸ h); simp only; omega
  writers_made k w h := e10 k w h
  ran_made c h := by have := g.ran_made c (e6 ▸ h); simp only; omega
  reads c := by simp only; rw [e3, e6]; exact g.reads c
  follows c r h := g.follows c r (e6 ▸ h)
  fresh c r h hd hs hc := by simp only; rw [e2]; exact g.fresh c r (e6 ▸ h) (e5 ▸ hd) hs (e11 ▸ hc)
  looping c h := by
    obtain ⟨h1, r, h2, h3⟩ := g.looping c (e7 ▸ h)
    exact ⟨e5 ▸ h1, r, e6 ▸ h2, h3⟩
  pending c r h := g.pending c r (e6 ▸ h)
  acts e v h := by
    obtain ⟨h1, r, h2⟩ := g.acts e v (e8 ▸ h)
    exact ⟨h1, r, e6 ▸ h2.1, h2.2⟩
  computes c r hc h hd := by
    obtain ⟨v, h1, h2⟩ := g.computes c r hc (e6 ▸ h) hd
    exact ⟨v, h1, e9 ▸ h2⟩
  effects e r he h hd := by
    obtain ⟨v, h1, h2⟩ := g.effects e r he (e6 ▸ h) hd
    exact ⟨v, h1, e9 ▸ e8 ▸ e5 ▸ h2⟩
  failed c r h hf := e9 ▸ g.failed c r (e6 ▸ h) hf
  cut c h := by simp only at h ⊢; rw [e11] at h; rw [e6]; exact g.cut c h
  when_le := e14
  times := e13
  runs c := by simp only; rw [e6, e12]; exact g.runs c
  owed_le x hx := by simp only; rw [e12]; exact g.owed_le x hx
  nodup := g.nodup
  owing c r h hx := g.owing c r (e6 ▸ h) hx
  handles c r0 hx r h := g.handles c r0 hx r (e6 ▸ h)

theorem Good.make {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) : Good cs promise (make cs a) := by
  simp only [Async.make, Model.make]
  generalize hs1 : (match (cs a.s.made).key with
      | some k => { a.s with made := a.s.made + 1, writers := put a.s.writers k (some a.s.made) }
      | none => { a.s with made := a.s.made + 1 } : Model.State K V) = s1
  have f1 : s1.made = a.s.made + 1 ∧ s1.store = a.s.store ∧ s1.reads = a.s.reads ∧
      s1.after = a.s.after ∧ s1.due = a.s.due ∧ s1.ran = a.s.ran ∧ s1.looping = a.s.looping ∧
      s1.acts = a.s.acts ∧ s1.last = a.s.last ∧ s1.cut = a.s.cut ∧ s1.runs = a.s.runs ∧
      s1.when = a.s.when ∧ s1.pulses = a.s.pulses ∧ s1.went = a.s.went ∧ s1.cause = a.s.cause ∧
      s1.pulsing = a.s.pulsing ∧ (∀ k w, s1.writers k = some w → w < s1.made) := by
    subst hs1
    cases hk : (cs a.s.made).key with
    | none =>
      refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, ?_⟩
      intro k w h; have := g.writers_made k w h; simp only; omega
    | some k =>
      refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, ?_⟩
      intro k' w h
      by_cases e : k' = k
      · subst e; simp at h; simp only; omega
      · simp [put_ne _ _ e] at h; have := g.writers_made k' w h; simp only; omega
  obtain ⟨e1, e2, e3, e4, e5, e6, e7, e8, e9, e11, e12, w1, w2, w3, w4, w5, e10⟩ := f1
  have g1 := g.grow (s' := { s1 with tick := s1.tick + 1 }) (by simp [e1]) e2 e3 e4 e5 e6 e7 e8 e9 e10
    e11 e12 (g.times.of_eq w1 w2 w3 w4 w5 e6) (fun c => by simp only; rw [w1, w2]; exact g.when_le c)
  have hd : a.s.made < ({ s1 with tick := s1.tick + 1 } : Model.State K V).made := by simp [e1]
  have m := (mark_moves _ a.s.made (s1.tick + 1) none hd (by simp)).1
  obtain ⟨c1, c2, c3, c4, _⟩ := mark_calm g1.times a.s.made (s1.tick + 1) none (by simp)
  have g2 := g1.moves m (funext fun x => by
    cases e : ({ s1 with tick := s1.tick + 1 } : Model.State K V).cut x <;>
    cases e' : (mark { s1 with tick := s1.tick + 1 } a.s.made (s1.tick + 1) none).cut x <;>
    simp_all) c1.runs c2 (fun c => by
      rw [c1.pulses]
      rcases c4 c with e | e <;> rw [e]
      · exact g1.when_le c
      · exact Nat.le_refl _)
  subst hs1
  exact g2

-- settle

theorem perm_erase {α : Type} {l : List α} {i : Nat} {x : α} (h : l[i]? = some x) :
    l.Perm (x :: l.eraseIdx i) := by
  obtain ⟨hi, hx⟩ := List.getElem?_eq_some_iff.1 h
  rw [List.eraseIdx_eq_take_drop_succ]
  have e : l = l.take i ++ l.drop i := (List.take_append_drop i l).symm
  conv => lhs; rw [e]
  rw [List.drop_eq_getElem_cons hi, hx]
  exact List.perm_middle

-- a promise settles: its run, still the latest, waits in landed; else nowhere
theorem Good.settle {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) (i : Nat) (o : Out V) : Good cs promise (settle a i o) := by
  unfold Async.settle
  split
  · exact g
  · rename_i c r hi
    -- what is owed after: the same, or less that one
    have hp : (a.awaiting.map (fun e => (e.1, e.2.n))).Perm
        ((c, r.n) :: (a.awaiting.eraseIdx i).map (fun e => (e.1, e.2.n))) := by
      have := (perm_erase hi).map (fun e : Nat × Run K V => (e.1, e.2.n))
      simpa using this
    have sub : ∀ (L : List (Nat × Nat × Out V)), ∀ x,
        x ∈ (a.awaiting.eraseIdx i).map (fun e => (e.1, e.2.n)) ++ L.map (fun e => (e.1, e.2.1)) →
        x ∈ a.awaiting.map (fun e => (e.1, e.2.n)) ++ L.map (fun e => (e.1, e.2.1)) := by
      intro L x hx
      rcases List.mem_append.1 hx with hx | hx
      · exact List.mem_append_left _ (hp.mem_iff.2 (List.mem_cons_of_mem _ hx))
      · exact List.mem_append_right _ hx
    -- the owed after is in the owed before, and has no repeats
    have key : ∀ (L : List (Nat × Nat × Out V)), (L = a.landed ∨ L = a.landed ++ [(c, r.n, o)]) →
        (∀ x, x ∈ (a.awaiting.eraseIdx i).map (fun e => (e.1, e.2.n)) ++ L.map (fun e => (e.1, e.2.1)) →
          x ∈ owed a) ∧
        ((a.awaiting.eraseIdx i).map (fun e => (e.1, e.2.n)) ++ L.map (fun e => (e.1, e.2.1))).Nodup := by
      intro L hL
      rcases hL with rfl | rfl
      · refine ⟨fun x hx => sub _ x hx, ?_⟩
        refine List.Sublist.nodup ?_ g.nodup
        exact List.Sublist.append ((List.eraseIdx_sublist _ _).map _) (List.Sublist.refl _)
      · have pm : (owed a).Perm ((a.awaiting.eraseIdx i).map (fun e => (e.1, e.2.n)) ++
            (a.landed ++ [(c, r.n, o)]).map (fun e => (e.1, e.2.1))) := by
          simp only [owed, List.map_append, List.map_cons, List.map_nil]
          refine (hp.append_right _).trans ?_
          have := List.perm_middle (a := (c, r.n))
            (l₁ := (a.awaiting.eraseIdx i).map (fun e => (e.1, e.2.n)) ++
              a.landed.map (fun e => (e.1, e.2.1))) (l₂ := [])
          simp only [List.append_nil, List.append_assoc] at this
          exact this.symm
        exact ⟨fun x hx => pm.mem_iff.2 hx, pm.nodup_iff.1 g.nodup⟩
    generalize hL : (if (a.s.ran c).map (·.n) = some r.n then a.landed ++ [(c, r.n, o)]
      else a.landed) = L
    have hL' : L = a.landed ∨ L = a.landed ++ [(c, r.n, o)] := by
      subst hL; split <;> simp
    obtain ⟨k1, k2⟩ := key L hL'
    exact {
      after_due := g.after_due, acyclic := g.acyclic, due_made := g.due_made,
      writers_made := g.writers_made, ran_made := g.ran_made, reads := g.reads,
      follows := g.follows, fresh := g.fresh, looping := g.looping, pending := g.pending,
      acts := g.acts, computes := g.computes, effects := g.effects, failed := g.failed,
      cut := g.cut, when_le := g.when_le, times := g.times, runs := g.runs,
      owed_le := fun x hx => g.owed_le x (k1 x hx)
      nodup := k2
      owing := fun c' r' h hx => g.owing c' r' h (k1 _ hx)
      handles := fun c' r0 hx => g.handles c' r0 (List.mem_of_mem_eraseIdx hx) }

-- named

-- a handle is tame: its run still the latest, or unflagged
def tame (a : State K V) (i : Nat) : Prop :=
  ∀ c r, a.awaiting[i]? = some (c, r) → (a.s.ran c).map (·.n) = some r.n ∨ r.loop = none

-- a computation with a promise owed has a run
theorem Good.ran_of {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {c n : Nat} (h : (c, n) ∈ owed a) : (a.s.ran c).isSome := by
  have h1 := g.owed_le _ h
  have h2 := g.runs c
  cases e : a.s.ran c with
  | none => rw [e] at h2; simp at h2; simp at h1; omega
  | some _ => rfl

-- the keys written, then a change of them: what moves (Good.write's store clause)
theorem stores_moves (cs : Nat → Comp K V) (s : Model.State K V) (kvs : List (K × V)) (who : Option Nat)
    (hw : ∀ c, who = some c → ((s.ran c).bind (·.loop)) = none) :
    Moves s (changed cs (kvs.foldl (fun s kv => store s kv.1 kv.2) s) (kvs.map (·.1)) who) := by
  obtain ⟨st, h1, h2⟩ := stores_shape s kvs
  rw [h1]
  obtain ⟨m, h⟩ := changed_moves cs { s with store := st } (kvs.map (·.1)) who hw
  refine ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping, m.writers, ?_⟩
  intro k hk d hd hr
  by_cases e : (changed cs { s with store := st } (kvs.map (·.1)) who).store k = st k
  · rw [e] at hk
    exact h k (h2 k hk) d hd hr
  · exact m.store k e d hd hr

theorem Good.named {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) (hp : a.s.pulsing = false) (i : Nat) (kvs : List (K × V))
    (ht : tame a i) : Good cs promise (named cs a i kvs) := by
  unfold Async.named
  split
  · exact g
  · rename_i c r hi
    have hmem : (c, r) ∈ a.awaiting := List.mem_of_getElem? hi
    have howed : (c, r.n) ∈ owed a := by
      simp only [owed]; exact List.mem_append_left _ (List.mem_map.2 ⟨(c, r), hmem, rfl⟩)
    have hrc : (a.s.ran c).isSome := g.ran_of howed
    obtain ⟨st, h1, h2⟩ := stores_shape a.s kvs
    simp only [h1]
    have hst : Cuts { a.s with store := st } := g.times.of_eq rfl rfl rfl rfl rfl rfl
    split
    · -- the latest run: Model's change by c
      rename_i hl
      obtain ⟨rr, hrr, hn⟩ : ∃ rr, a.s.ran c = some rr ∧ rr.n = r.n := by
        cases e : a.s.ran c with
        | none => rw [e] at hl; cases hl
        | some rr => rw [e] at hl; simp at hl; exact ⟨rr, rfl, hl⟩
      have hloop := g.handles c r hmem rr hrr hn
      have hpend := (g.owing c rr hrr (hn ▸ howed)).1
      have k := changed_kept cs hst (kvs.map (·.1)) (some c)
      cases hf : r.loop with
      | none =>
        have hw : ∀ x, some c = some x → (((({ a.s with store := st } : Model.State K V)).ran x).bind (·.loop)) = none := by
          intro x hx; cases hx; simp [hrr, hloop, hf]
        have m := stores_moves cs a.s kvs (some c) (by
          intro x hx; cases hx; simp [hrr, hloop, hf])
        rw [h1] at m
        exact g.moves m (changed_cut cs hst _ _ hw) k.1.runs k.2.1 (k.when_le g.when_le)
      | some l =>
        have hfl : ((({ a.s with store := st } : Model.State K V).ran c).bind (·.loop)).isSome = true := by
          simp [hrr, hloop, hf]
        obtain ⟨m, hm⟩ := changed_flag cs hst hp (kvs.map (·.1)) c hfl
        refine g.shift ⟨m.made, m.reads, m.ran, m.after, m.acts, m.last, m.due, m.fresh, m.looping,
          m.writers, ?_, ?_, k.2.2.1, k.1.runs⟩ k.2.1 (k.when_le g.when_le)
        · intro k' hk d hd hr
          have hk' : st k' ≠ a.s.store k' := by
            have := k.1.store; simp only at this; rw [this] at hk; exact hk
          obtain ⟨f1, f2⟩ := hm k' (h2 k' hk') d hd hr
          by_cases hdc : d = c
          · exact Or.inr (Or.inr (by rw [hdc]; exact f2 hdc))
          · rcases f1 hdc with f | f
            · exact Or.inl f
            · exact Or.inr (Or.inl f)
        · intro x hx
          rcases k.2.2.2.1 x hx with h | ⟨h3, _⟩
          · exact Or.inl h
          · simp only [runof, Option.filter_eq_some_iff] at h3
            cases h3.1
            exact Or.inr ⟨rr, hrr, by simp [hloop, hf], by rw [hpend]; simp⟩
    · -- an older run: by names it, unflagged (tame)
      rename_i hl
      have hf : r.loop = none := by
        rcases ht c r hi with h | h
        · exact absurd h hl
        · exact h
      generalize hs1 : ({ a.s with store := st, ran := put a.s.ran c (some r), when := put a.s.when c (a.s.pulses + 1) } : Model.State K V) = s1
      have c1 : Cuts s1 := by
        subst hs1
        refine ⟨fun d hr hd => ?_, fun hp' d hr hd => ?_⟩
        · by_cases e : d = c
          · subst e; simp at hd
          · simp [put_ne _ _ e] at hr hd ⊢; exact g.times.went d hr hd
        · by_cases e : d = c
          · subst e; simp at hd
          · simp [put_ne _ _ e] at hr hd hp' ⊢; exact g.times.cut hp' d hr hd
      have hw1 : ∀ x, some c = some x → ((s1.ran x).bind (·.loop)) = none := by
        intro x hx; cases hx; subst hs1; simp [hf]
      obtain ⟨m, hm⟩ := changed_moves cs s1 (kvs.map (·.1)) (some c) hw1
      have kk := changed_kept cs c1 (kvs.map (·.1)) (some c)
      have hcut := changed_cut cs c1 (kvs.map (·.1)) (some c) hw1
      generalize hs2 : changed cs s1 (kvs.map (·.1)) (some c) = s2 at m hm kk hcut
      have e1 : s1.made = a.s.made := by subst hs1; rfl
      have e2 : s1.reads = a.s.reads := by subst hs1; rfl
      have e3 : s1.after = a.s.after := by subst hs1; rfl
      have e4 : s1.acts = a.s.acts := by subst hs1; rfl
      have e5 : s1.last = a.s.last := by subst hs1; rfl
      have e6 : s1.due = a.s.due := by subst hs1; rfl
      have e7 : s1.looping = a.s.looping := by subst hs1; rfl
      have e8 : s1.writers = a.s.writers := by subst hs1; rfl
      have e9 : s1.store = st := by subst hs1; rfl
      have e10 : s1.cut = a.s.cut := by subst hs1; rfl
      have e11 : s1.pulses = a.s.pulses := by subst hs1; rfl
      have e12 : s1.went = a.s.went := by subst hs1; rfl
      have e14 : s1.pulsing = a.s.pulsing := by subst hs1; rfl
      have e15 : ∀ d, d ≠ c → s1.ran d = a.s.ran d := by intro d hd; subst hs1; simp [put_ne _ _ hd]
      have e16 : ∀ d, d ≠ c → s1.when d = a.s.when d := by intro d hd; subst hs1; simp [put_ne _ _ hd]
      have p2 : s2.pulses = a.s.pulses := kk.1.pulses.trans e11
      have mv : Moves a.s { s2 with ran := a.s.ran, cause := put s2.cause c (a.s.cause c), when := put s2.when c (a.s.when c), cut := put s2.cut c (a.s.cut c) } := by
        refine ⟨m.made.trans e1, m.reads.trans e2, rfl, m.after.trans e3, m.acts.trans e4,
          m.last.trans e5, fun d x h => m.due d x (e6 ▸ h), fun d h => ?_, fun d h => ?_,
          fun k w h => ?_, fun k h d hd hr => ?_⟩
        · rcases m.fresh d h with h | h
          · exact Or.inl (e6 ▸ h)
          · exact Or.inr (e1 ▸ h)
        · obtain ⟨h3, h4⟩ := m.looping d h
          exact ⟨e7 ▸ h3, by simp only; rw [h4, e6]⟩
        · rcases m.writers k w h with h | h
          · exact Or.inl (e8 ▸ h)
          · by_cases e : w = c
            · subst e; exact Or.inr hrc
            · exact Or.inr (by rw [← e15 w e]; exact h)
        · have hk : st k ≠ a.s.store k := by
            have := kk.1.store; simp only at h; rw [this, e9] at h; exact h
          rcases hm k (h2 k hk) d (e1 ▸ hd) (e2 ▸ hr) with h | h
          · exact Or.inl h
          · exact Or.inr (e7 ▸ h)
      have hc2 : put s2.cut c (a.s.cut c) = a.s.cut := by
        funext x; rw [put_apply]; split
        · rename_i e; rw [e]
        · rw [hcut, e10]
      refine g.moves mv hc2 (kk.1.runs.trans (by subst hs1; rfl))
        ⟨fun d hr hd => ?_, fun hp' d hr hd => ?_⟩ (fun d => ?_)
      · simp only at hr hd ⊢
        rw [p2] at hd
        by_cases e : d = c
        · subst e
          simp only [put_same] at hd
          exact kk.2.2.2.2.2 d (by rw [e12]; exact g.times.went d hr hd)
        · rw [put_ne _ _ e] at hd
          exact kk.2.1.went d (by rw [kk.1.ran, e15 d e]; exact hr) (by rw [kk.1.pulses, e11]; exact hd)
      · simp only at hr hd hp' ⊢
        rw [p2] at hd
        by_cases e : d = c
        · subst e
          simp only [put_same] at hd ⊢
          exact g.times.cut (by rw [← e14, ← kk.1.pulsing]; exact hp') d hr hd
        · rw [put_ne _ _ e] at hd ⊢
          exact kk.2.1.cut hp' d (by rw [kk.1.ran, e15 d e]; exact hr) (by rw [kk.1.pulses, e11]; exact hd)
      · simp only
        rw [p2]
        by_cases e : d = c
        · subst e; simp only [put_same]; exact g.when_le d
        · rw [put_ne _ _ e]
          rcases kk.2.2.2.2.1 d with h | h <;> rw [h]
          · rw [e16 d e]; exact g.when_le d
          · rw [e11]; exact Nat.le_refl _

-- runs

-- a run, A2: start, f read along the store; what the state is when it is told how f ended (first_spec)
theorem run_spec (cs : Nat → Comp K V) (promise : V → Bool) (a : State K V) (c rk : Nat)
    (hp : nowrites (cs c).f) :
    ∃ (s3 : Model.State K V) (o : Out V) (seen : List (K × Option V)) (vals : List Nat)
      (st : Option Nat),
      (run cs promise a c rk).s = ending cs s3 c (hide promise o) ∧
      (run cs promise a c rk).landed = a.landed ∧
      (run cs promise a c rk).gave = put a.gave c (if st.isSome then none else given promise o) ∧
      (run cs promise a c rk).awaiting =
        (match (if st.isSome then none else given promise o), (ending cs s3 c (hide promise o)).ran c with
          | some _, some r => a.awaiting ++ [(c, r)]
          | _, _ => a.awaiting) ∧
      s3.ran = put a.s.ran c (some (begun a.s c vals st seen)) ∧
      s3.reads = put a.s.reads c (seen.map (·.1)) ∧
      s3.store = a.s.store ∧ s3.made = a.s.made ∧ s3.writers = a.s.writers ∧ s3.last = a.s.last ∧
      s3.looping = a.s.looping ∧ s3.due = put a.s.due c none ∧ s3.after = put a.s.after c none ∧
      s3.acts = a.s.acts.filter (fun x => x.1 ≠ c) ∧ s3.cut = put a.s.cut c false ∧
      s3.runs = put a.s.runs c (a.s.runs c + 1) ∧ s3.when = put a.s.when c a.s.pulses ∧
      s3.went = put a.s.went c true ∧ s3.pulses = a.s.pulses ∧ s3.pulsing = a.s.pulsing ∧
      s3.cause = put a.s.cause c (.mk (c, a.s.runs c + 1) (a.s.kept c)) ∧ s3.kept = a.s.kept ∧
      (∀ q ∈ seen, a.s.store q.1 = q.2) ∧
      (st = none → follow (cs c).f seen = some o) ∧
      (∀ w, st = some w → (a.s.due w).isSome ∧ waits (start a.s c rk) w c = false ∧ w ≠ c ∧
        ∃ k, a.s.writers k = some w) := by
  have h0 : (start a.s c rk).ran c = some (begun a.s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, heq, hst, hfo, hstop⟩ :=
    exec_spec cs c (cs c).f hp (start a.s c rk) _ h0 rfl
  simp only [run]
  generalize hx : exec cs c (start a.s c rk) (cs c).f = x at heq hfo
  obtain ⟨s2, o⟩ := x
  simp only at heq hfo
  subst heq
  refine ⟨_, o, seen, vals, st, rfl, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_,
    ?_, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  all_goals first
    | rfl
    | trivial
    | (simp [start, say, put_put, begun]; done)
    | (simp only [put_same, Option.bind_some]; rfl)
    | skip
  intro w hw
  obtain ⟨h1, h2, h3, h4⟩ := hstop w hw
  refine ⟨?_, h2, h3, ?_⟩
  · simpa [start, say, put_ne _ _ h3] using h1
  · simpa [start, say] using h4

-- what a run of c leaves, F from a, its record rf (Quiescence's Post, with promises)
structure After (cs : Nat → Comp K V) (promise : V → Bool) (a : State K V) (c rk : Nat)
    (F : State K V) (rf : Run K V) : Prop where
  made : F.s.made = a.s.made
  ran_c : F.s.ran c = some rf
  ran : ∀ d, d ≠ c → F.s.ran d = a.s.ran d
  reads : F.s.reads = put a.s.reads c (rf.seen.map (·.1))
  after : F.s.after = put a.s.after c none ∨ ∃ w, F.s.after = put a.s.after c (some w) ∧
    waits (start a.s c rk) w c = false ∧ w ≠ c ∧ w < a.s.made ∧ (F.s.due c).isSome
  due : ∀ d m, d ≠ c → a.s.due d = some m → F.s.due d = some m
  fresh : ∀ d, (F.s.due d).isSome → (a.s.due d).isSome ∨ d < a.s.made
  looping : ∀ d, d ≠ c → F.s.looping d = true → a.s.looping d = true ∧ F.s.due d = a.s.due d
  looping_c : F.s.looping c = true → F.s.due c = none ∧ rf.ended = some .looping
  writers : ∀ k w, F.s.writers k = some w → a.s.writers k = some w ∨ (a.s.ran w).isSome ∨ w = c
  store : ∀ k, F.s.store k ≠ a.s.store k → ∀ d, d < a.s.made → d ≠ c → k ∈ a.s.reads d →
    (F.s.due d).isSome ∨ a.s.looping d = true
  follows : rf.ended ≠ some .stopped → ∃ o, follow (cs c).f rf.seen = some o ∧
    (F.gave c = none → rf.out = some o) ∧ ∀ p, F.gave c = some p → o = .value p ∧ promise p = true
  fresh_c : F.s.due c = none → settled rf → F.s.cut c = false → ∀ q ∈ rf.seen, F.s.store q.1 = q.2
  pending : rf.ended = some .pending → rf.out = some .pending
  acts : ∀ e v, (e, v) ∈ F.s.acts → (e ≠ c ∧ (e, v) ∈ a.s.acts) ∨
    (e = c ∧ iseffect (cs c) = true ∧ rf.loop = none ∧ rf.ended = some .done ∧
      rf.out = some (.value v))
  acts_keep : ∀ e v, e ≠ c → (e, v) ∈ a.s.acts → (e, v) ∈ F.s.acts
  last : ∀ d, d ≠ c → F.s.last d = a.s.last d
  computes : iseffect (cs c) = false → rf.ended = some .done →
    ∃ v, rf.out = some (.value v) ∧ near (cs c).equal v (F.s.last c)
  effects : iseffect (cs c) = true → rf.ended = some .done →
    ∃ v, rf.out = some (.value v) ∧
      (near (cs c).equal v (F.s.last c) ∨ (c, v) ∈ F.s.acts ∨ (F.s.due c).isSome)
  failed : rf.ended = some .failed →
    rf.out = some .error ∨ ∃ v, rf.out = some (.value v) ∧ same (cs c).equal v (F.s.last c) = none
  -- the async part: the cuts, the causes, the counts and what is owed
  cut : ∀ d, d ≠ c → F.s.cut d = a.s.cut d
  cut_c : F.s.cut c = true → rf.loop.isSome ∧ rf.ended ≠ some .done
  gave : ∀ d, d ≠ c → F.gave d = a.gave d
  times : Cuts F.s
  when_le : ∀ d, F.s.when d ≤ F.s.pulses
  runs : ∀ d, d ≠ c → F.s.runs d = a.s.runs d
  runs_c : F.s.runs c = rf.n ∧ a.s.runs c ≤ rf.n
  -- what is owed: a new run, which may await; or a landing, of a run that owes nothing more
  owed : (a.s.runs c < rf.n ∧ F.landed = a.landed ∧ ((F.awaiting = a.awaiting ∧ F.gave c = none) ∨
      (F.awaiting = a.awaiting ++ [(c, rf)] ∧ rf.ended = some .pending ∧ (F.gave c).isSome))) ∨
    (F.landed = a.landed ∧ F.awaiting = a.awaiting ∧ (c, rf.n) ∉ owed a)

theorem Good.after {cs : Nat → Comp K V} {promise : V → Bool} {a F : State K V} {c rk : Nat}
    {rf : Run K V} (g : Good cs promise a) (hcm : c < a.s.made)
    (p : After cs promise a c rk F rf) : Good cs promise F := by
  have hd' : ∀ d, d ≠ c → F.s.due d = none → a.s.due d = none := by
    intro d hd h
    cases e : a.s.due d with
    | none => rfl
    | some m => rw [p.due d m hd e] at h; cases h
  -- what is owed: as before, or one more, of c's new run; a landing's run owes nothing
  have book : (∀ x ∈ owed F, 0 < x.2 ∧ x.2 ≤ F.s.runs x.1) ∧ (owed F).Nodup ∧
      (∀ d r, F.s.ran d = some r → (d, r.n) ∈ owed F → r.ended = some .pending ∧ (F.gave d).isSome) ∧
      (∀ d r0, (d, r0) ∈ F.awaiting → ∀ r, F.s.ran d = some r → r.n = r0.n → r.loop = r0.loop) := by
    have le : ∀ x ∈ owed a, x.2 ≤ F.s.runs x.1 := by
      intro x hx
      have := (g.owed_le x hx).2
      by_cases e : x.1 = c
      · rw [e] at this ⊢; rw [p.runs_c.1]; have := p.runs_c.2; omega
      · rw [p.runs x.1 e]; exact this
    rcases p.owed with ⟨hlt, hl, haw⟩ | ⟨hl, haw, hno⟩
    · have old : ∀ x ∈ owed a, x.1 = c → x.2 < rf.n := by
        intro x hx e
        have := (g.owed_le x hx).2; rw [e] at this; omega
      have hperm : (owed F = owed a ∧ F.gave c = none) ∨ (F.awaiting = a.awaiting ++ [(c, rf)] ∧
          rf.ended = some .pending ∧ (F.gave c).isSome ∧ (owed F).Perm ((c, rf.n) :: owed a)) := by
        rcases haw with ⟨e, e'⟩ | ⟨e, h1, h2⟩
        · left; simp only [owed, e, hl, e']; exact ⟨trivial, trivial⟩
        · refine Or.inr ⟨e, h1, h2, ?_⟩
          simp only [owed, e, hl, List.map_append, List.map_cons, List.map_nil,
            List.append_assoc, List.singleton_append]
          exact List.perm_middle
      have hown : ∀ x, x ∈ owed F ↔ x ∈ owed a ∨
          (x = (c, rf.n) ∧ rf.ended = some .pending ∧ (F.gave c).isSome) := by
        intro x
        rcases hperm with ⟨e, e'⟩ | ⟨_, h1, h2, pm⟩
        · rw [e]
          constructor
          · exact Or.inl
          · rintro (h | ⟨_, _, h⟩)
            · exact h
            · rw [e'] at h; cases h
        · rw [pm.mem_iff, List.mem_cons]
          constructor
          · rintro (h | h)
            · exact Or.inr ⟨h, h1, h2⟩
            · exact Or.inl h
          · rintro (h | ⟨h, _⟩)
            · exact Or.inr h
            · exact Or.inl h
      refine ⟨fun x hx => ?_, ?_, fun d r h hx => ?_, fun d r0 hx r h hn => ?_⟩
      · rcases (hown x).1 hx with hx | ⟨rfl, _⟩
        · exact ⟨(g.owed_le x hx).1, le x hx⟩
        · refine ⟨by omega, by rw [p.runs_c.1]; exact Nat.le_refl _⟩
      · rcases hperm with ⟨e, _⟩ | ⟨_, _, _, pm⟩
        · rw [e]; exact g.nodup
        · refine pm.nodup_iff.2 (List.nodup_cons.2 ⟨fun h => ?_, g.nodup⟩)
          have := old _ h rfl; simp at this
      · by_cases hd : d = c
        · subst hd; rw [p.ran_c] at h; cases h
          rcases (hown _).1 hx with hx | ⟨_, h1, h2⟩
          · have := old _ hx rfl; simp at this
          · exact ⟨h1, h2⟩
        · rw [p.ran d hd] at h
          rcases (hown _).1 hx with hx | ⟨hx, _⟩
          · rw [p.gave d hd]; exact g.owing d r h hx
          · exact absurd (Prod.mk.inj hx).1 hd
      · have hx' : (d, r0) ∈ a.awaiting ∨ (d, r0) = (c, rf) := by
          rcases haw with ⟨e, _⟩ | ⟨e, _, _⟩
          · rw [e] at hx; exact Or.inl hx
          · rw [e] at hx; simpa using hx
        by_cases hd : d = c
        · subst hd; rw [p.ran_c] at h; cases h
          rcases hx' with hx' | hx'
          · have := old (d, r0.n) (by
              simp only [owed]; exact List.mem_append_left _ (List.mem_map.2 ⟨_, hx', rfl⟩)) rfl
            simp at this; omega
          · have := (Prod.mk.inj hx').2; subst this; rfl
        · rcases hx' with hx' | hx'
          · exact g.handles d r0 hx' r (p.ran d hd ▸ h) hn
          · exact absurd (Prod.mk.inj hx').1 hd
    · have e : owed F = owed a := by simp only [owed, hl, haw]
      refine ⟨fun x hx => ⟨(g.owed_le x (e ▸ hx)).1, le x (e ▸ hx)⟩, e ▸ g.nodup,
        fun d r h hx => ?_, fun d r0 hx r h hn => ?_⟩
      · by_cases hd : d = c
        · subst hd; rw [p.ran_c] at h; cases h; rw [e] at hx; exact absurd hx hno
        · rw [p.ran d hd] at h; rw [p.gave d hd]; exact g.owing d r h (e ▸ hx)
      · rw [haw] at hx
        by_cases hd : d = c
        · subst hd; rw [p.ran_c] at h; cases h
          exfalso; apply hno; rw [hn]; simp only [owed]
          exact List.mem_append_left _ (List.mem_map.2 ⟨_, hx, rfl⟩)
        · exact g.handles d r0 hx r (p.ran d hd ▸ h) hn
  exact {
    after_due := fun x w h => by
      by_cases hx : x = c
      · subst hx
        rcases p.after with e | ⟨w', e, _, _, h3, h4⟩
        · rw [e] at h; simp at h
        · rw [e] at h; simp at h; subst h; exact ⟨h4, p.made ▸ h3⟩
      · have h' : a.s.after x = some w := by
          rcases p.after with e | ⟨w', e, _⟩ <;> (rw [e, put_ne _ _ hx] at h; exact h)
        obtain ⟨h1, h2⟩ := g.after_due x w h'
        obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h1
        exact ⟨by simp [p.due x m hx hm], p.made ▸ h2⟩
    acyclic := fun x h => by
      have sub : ∀ a' b, TransGen (fun x y => put a.s.after c none x = some y) a' b →
          TransGen (aft a.s) a' b := by
        intro a' b h
        refine tg_mono (fun x y hxy => ?_) h
        by_cases hx : x = c
        · subst hx; simp at hxy
        · simp [put_ne _ _ hx] at hxy; exact hxy
      rcases p.after with e | ⟨w, e, hw1, hw2, hw3, _⟩
      · have e' : aft F.s = fun x y => put a.s.after c none x = some y := by
          funext a' b; simp [aft, e]
        exact g.acyclic x (sub x x (e' ▸ h))
      · have e' : aft F.s = fun x y => put (put a.s.after c none) c (some w) x = some y := by
          funext a' b; simp [aft, e, put_put]
        rw [e'] at h
        rcases tg_put (by simp) h with h | ⟨h1, h2⟩
        · exact g.acyclic x (sub x x h)
        · have hwc : TransGen (fun x y => put a.s.after c none x = some y) w c := by
            rcases h1 with rfl | h1 <;> rcases h2 with h2 | h2
            · exact absurd h2 hw2
            · exact h2
            · subst h2; exact h1
            · exact TransGen.trans h2 h1
          have ea : aft (start a.s c rk) = fun x y => put a.s.after c none x = some y := by
            funext a' b; simp [aft, start, say]
          have hst : waits (start a.s c rk) w c = true := by
            refine waits_of_tg ?_ ?_ (by simpa [start, say] using hw3) ?_
            · intro y hy
              rw [ea] at hy
              exact g.acyclic y (sub y y hy)
            · intro a' b hab
              have : put a.s.after c none a' = some b := by simpa [start, say] using hab
              by_cases ha : a' = c
              · subst ha; simp at this
              · rw [put_ne _ _ ha] at this
                simpa [start, say] using (g.after_due a' b this).2
            · rw [ea]; exact hwc
          rw [hw1] at hst; cases hst
    due_made := fun x h => by
      rcases p.fresh x h with h | h
      · exact p.made ▸ g.due_made x h
      · exact p.made ▸ h
    writers_made := fun k w h => by
      rcases p.writers k w h with h | h | h
      · exact p.made ▸ g.writers_made k w h
      · exact p.made ▸ g.ran_made w h
      · exact p.made ▸ (h ▸ hcm)
    ran_made := fun d h => by
      by_cases hd : d = c
      · exact p.made ▸ (hd ▸ hcm)
      · exact p.made ▸ g.ran_made d (p.ran d hd ▸ h)
    reads := fun d => by
      by_cases hd : d = c
      · subst hd; simp [p.reads, p.ran_c]
      · rw [p.reads, put_ne _ _ hd, p.ran d hd]; exact g.reads d
    follows := fun d r h hs => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.follows hs
      · rw [p.gave d hd]; exact g.follows d r (p.ran d hd ▸ h) hs
    fresh := fun d r h hdue hs hcut q hq => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.fresh_c hdue hs hcut q hq
      · have h' : a.s.ran d = some r := p.ran d hd ▸ h
        have hcut' : a.s.cut d = false := by rw [← p.cut d hd]; exact hcut
        by_cases e : F.s.store q.1 = a.s.store q.1
        · rw [e]; exact g.fresh d r h' (hd' d hd hdue) hs hcut' q hq
        · exfalso
          have hr : q.1 ∈ a.s.reads d := by
            rw [g.reads d, h']; simp only [Option.map_some, Option.getD_some]
            exact List.mem_map_of_mem hq
          rcases p.store q.1 e d (g.ran_made d (by simp [h'])) hd hr with h1 | h1
          · simp [hdue] at h1
          · obtain ⟨_, r', h2, h3⟩ := g.looping d h1
            rw [h'] at h2; cases h2
            rcases hs with h4 | h4 | h4 <;> rw [h4] at h3 <;> cases h3
    looping := fun d h => by
      by_cases hd : d = c
      · subst hd; obtain ⟨h1, h2⟩ := p.looping_c h; exact ⟨h1, rf, p.ran_c, h2⟩
      · obtain ⟨h1, e⟩ := p.looping d hd h
        obtain ⟨h2, r, h3, h4⟩ := g.looping d h1
        exact ⟨e.trans h2, r, (p.ran d hd).trans h3, h4⟩
    pending := fun d r h hp => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.pending hp
      · exact g.pending d r (p.ran d hd ▸ h) hp
    acts := fun e v h => by
      rcases p.acts e v h with ⟨h1, h2⟩ | ⟨h1, h2, h3⟩
      · obtain ⟨h3, r, h4⟩ := g.acts e v h2
        exact ⟨h3, r, (p.ran e h1).trans h4.1, h4.2⟩
      · subst h1; exact ⟨h2, rf, p.ran_c, h3⟩
    computes := fun d r hcd h hdone => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.computes hcd hdone
      · obtain ⟨v, h1, h2⟩ := g.computes d r hcd (p.ran d hd ▸ h) hdone
        exact ⟨v, h1, (p.last d hd).symm ▸ h2⟩
    effects := fun e r he h hdone => by
      by_cases hd : e = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.effects he hdone
      · obtain ⟨v, h1, h2⟩ := g.effects e r he (p.ran e hd ▸ h) hdone
        refine ⟨v, h1, ?_⟩
        rcases h2 with h2 | h2 | h2
        · exact Or.inl ((p.last e hd).symm ▸ h2)
        · exact Or.inr (Or.inl (p.acts_keep e v hd h2))
        · obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h2
          exact Or.inr (Or.inr (by simp [p.due e m hd hm]))
    failed := fun d r h hf => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c] at h; cases h; exact p.failed hf
      · exact (p.last d hd).symm ▸ g.failed d r (p.ran d hd ▸ h) hf
    cut := fun d h => by
      by_cases hd : d = c
      · subst hd; exact ⟨rf, p.ran_c, p.cut_c h⟩
      · rw [p.cut d hd] at h; rw [p.ran d hd]; exact g.cut d h
    when_le := p.when_le
    times := p.times
    runs := fun d => by
      by_cases hd : d = c
      · subst hd; rw [p.ran_c, p.runs_c.1]; rfl
      · rw [p.ran d hd, p.runs d hd]; exact g.runs d
    owed_le := book.1
    nodup := book.2.1
    owing := book.2.2.1
    handles := book.2.2.2 }

theorem Cuts.of_ran {s s' : Model.State K V} (h : Cuts s) (e1 : s'.when = s.when)
    (e2 : s'.pulses = s.pulses) (e3 : s'.went = s.went) (e4 : s'.cause = s.cause)
    (e5 : s'.pulsing = s.pulsing) (e6 : ∀ c, (s'.ran c).isSome → (s.ran c).isSome) : Cuts s' :=
  ⟨fun c hr hc => by rw [e1, e2] at hc; rw [e3]; exact h.went c (e6 c hr) hc,
    fun hp c hr hc => by rw [e1, e2] at hc; rw [e5] at hp; rw [e4]; exact h.cut hp c (e6 c hr) hc⟩

-- a run's end that leaves the store, the dues (c not due) and the afters (c after nothing)
theorem after_plain {cs : Nat → Comp K V} {promise : V → Bool} {a F : State K V} {c rk : Nat}
    {rf : Run K V}
    (hm : F.s.made = a.s.made) (hr : F.s.ran = put a.s.ran c (some rf))
    (hreads : F.s.reads = put a.s.reads c (rf.seen.map (·.1))) (ha : F.s.after = put a.s.after c none)
    (hd : F.s.due = put a.s.due c none) (hst : F.s.store = a.s.store) (hw : F.s.writers = a.s.writers)
    (hl : ∀ d, d ≠ c → F.s.looping d = a.s.looping d)
    (hlc : F.s.looping c = true → rf.ended = some .looping)
    (hlast : ∀ d, d ≠ c → F.s.last d = a.s.last d)
    (X : List (Nat × V)) (hacts : F.s.acts = a.s.acts.filter (fun x => x.1 ≠ c) ++ X)
    (hX : ∀ x ∈ X, x.1 = c ∧ iseffect (cs c) = true ∧ rf.loop = none ∧ rf.ended = some .done ∧
      rf.out = some (.value x.2))
    (hseen : F.s.cut c = false → ∀ q ∈ rf.seen, a.s.store q.1 = q.2)
    (hfol : rf.ended ≠ some .stopped → ∃ o, follow (cs c).f rf.seen = some o ∧
      (F.gave c = none → rf.out = some o) ∧ ∀ p, F.gave c = some p → o = .value p ∧ promise p = true)
    (hpend : rf.ended = some .pending → rf.out = some .pending)
    (hcomp : iseffect (cs c) = false → rf.ended = some .done →
      ∃ v, rf.out = some (.value v) ∧ near (cs c).equal v (F.s.last c))
    (heff : iseffect (cs c) = true → rf.ended = some .done →
      ∃ v, rf.out = some (.value v) ∧
        (near (cs c).equal v (F.s.last c) ∨ (c, v) ∈ F.s.acts ∨ (F.s.due c).isSome))
    (hfail : rf.ended = some .failed →
      rf.out = some .error ∨ ∃ v, rf.out = some (.value v) ∧ same (cs c).equal v (F.s.last c) = none)
    (hcut : ∀ d, d ≠ c → F.s.cut d = a.s.cut d)
    (hcutc : F.s.cut c = true → rf.loop.isSome ∧ rf.ended ≠ some .done)
    (hgave : ∀ d, d ≠ c → F.gave d = a.gave d) (htimes : Cuts F.s)
    (hwhen : ∀ d, F.s.when d ≤ F.s.pulses) (hruns : ∀ d, d ≠ c → F.s.runs d = a.s.runs d)
    (hrunsc : F.s.runs c = rf.n ∧ a.s.runs c ≤ rf.n)
    (howed : (a.s.runs c < rf.n ∧ F.landed = a.landed ∧ ((F.awaiting = a.awaiting ∧ F.gave c = none) ∨
      (F.awaiting = a.awaiting ++ [(c, rf)] ∧ rf.ended = some .pending ∧ (F.gave c).isSome))) ∨
      (F.landed = a.landed ∧ F.awaiting = a.awaiting ∧ (c, rf.n) ∉ owed a)) :
    After cs promise a c rk F rf where
  made := hm
  ran_c := by rw [hr]; simp
  ran d hd := by rw [hr, put_ne _ _ hd]
  reads := hreads
  after := Or.inl ha
  due d m hdc h := by rw [hd, put_ne _ _ hdc]; exact h
  fresh d h := by
    by_cases hdc : d = c
    · subst hdc; rw [hd] at h; simp at h
    · rw [hd, put_ne _ _ hdc] at h; exact Or.inl h
  looping d hdc h := by
    rw [hl d hdc] at h
    exact ⟨h, by rw [hd, put_ne _ _ hdc]⟩
  looping_c h := ⟨by rw [hd]; simp, hlc h⟩
  writers k w h := Or.inl (hw ▸ h)
  store k h := absurd (hst ▸ rfl) h
  follows := hfol
  fresh_c _ _ hc q hq := by rw [hst]; exact hseen hc q hq
  pending := hpend
  acts e v h := by
    rw [hacts] at h
    rcases List.mem_append.1 h with h | h
    · simp only [List.mem_filter, decide_eq_true_eq] at h
      exact Or.inl ⟨h.2, h.1⟩
    · obtain ⟨h1, h2⟩ := hX _ h
      exact Or.inr ⟨h1, h2⟩
  acts_keep e v hec h := by
    rw [hacts]; exact List.mem_append_left _ (by simp [h, hec])
  last := hlast
  computes := hcomp
  effects := heff
  failed := hfail
  cut := hcut
  cut_c := hcutc
  gave := hgave
  times := htimes
  when_le := hwhen
  runs := hruns
  runs_c := hrunsc
  owed := howed

-- a set, by an unflagged run: the causes and cuts as a change leaves them
theorem set_kept (cs : Nat → Comp K V) {s : Model.State K V} (c : Nat) (v : V) (h : Cuts s)
    (hw : ∀ d, s.when d ≤ s.pulses) (hf : ((s.ran c).bind (·.loop)) = none) :
    Cuts (set cs s c v) ∧ (set cs s c v).cut = s.cut ∧
    (∀ d, (set cs s c v).when d ≤ (set cs s c v).pulses) ∧ (set cs s c v).runs = s.runs ∧
    (set cs s c v).pulsing = s.pulsing := by
  have hs : Cuts (say s (.set c v)) := h.of_eq rfl rfl rfl rfl rfl rfl
  simp only [Model.set]
  split
  · rename_i k _
    have hst : Cuts (store (say s (.set c v)) k v) := hs.of_eq rfl rfl rfl rfl rfl rfl
    have kk := changed_kept cs hst [k] (some c)
    have hrc' : ∀ x, some c = some x → (((store (say s (.set c v)) k v).ran x).bind (·.loop)) = none := by
      intro x hx; cases hx; simpa [store, say] using hf
    exact ⟨kk.2.1, by rw [changed_cut cs hst [k] (some c) hrc']; rfl, kk.when_le (fun d => hw d),
      kk.1.runs, kk.1.pulsing⟩
  · exact ⟨hs, rfl, hw, rfl, rfl⟩

-- a set at a run's end, or a landing's: what it leaves (s4: the state before set, r4: the run)
theorem after_set (cs : Nat → Comp K V) (promise : V → Bool) {a F : State K V} {c rk : Nat}
    {s4 : Model.State K V} {r4 : Run K V} {v : V}
    (hcm : c < a.s.made) (hlc : a.s.looping c = false) (hie : iseffect (cs c) = false)
    (f_made : s4.made = a.s.made) (f_reads : s4.reads = put a.s.reads c (r4.seen.map (·.1)))
    (f_ran : s4.ran = put a.s.ran c (some r4)) (f_store : s4.store = a.s.store)
    (f_writers : s4.writers = a.s.writers) (f_last : s4.last = a.s.last)
    (f_looping : s4.looping = a.s.looping) (f_due : s4.due = put a.s.due c none)
    (f_after : s4.after = put a.s.after c none) (f_acts : s4.acts = a.s.acts.filter (fun x => x.1 ≠ c))
    (f_cut : ∀ d, d ≠ c → s4.cut d = a.s.cut d) (f_cutc : s4.cut c = false)
    (f_runs : ∀ d, d ≠ c → s4.runs d = a.s.runs d)
    (hflag : r4.loop = none) (hout : r4.out = some (.value v))
    (t4 : Cuts s4) (w4 : ∀ d, s4.when d ≤ s4.pulses)
    (hseen : ∀ q ∈ r4.seen, a.s.store q.1 = q.2)
    (hfol : ∃ o, follow (cs c).f r4.seen = some o ∧ (F.gave c = none → r4.out = some o) ∧
      ∀ p, F.gave c = some p → o = .value p ∧ promise p = true)
    (hs : F.s = finish { set cs s4 c v with last := put (set cs s4 c v).last c (some v) } c .done
      (some false) none none)
    (hgave : ∀ d, d ≠ c → F.gave d = a.gave d)
    (hrunsc : s4.runs c = r4.n ∧ a.s.runs c ≤ r4.n)
    (howed : (a.s.runs c < r4.n ∧ F.landed = a.landed ∧ ((F.awaiting = a.awaiting ∧ F.gave c = none) ∨
      (F.awaiting = a.awaiting ++ [(c, { r4 with ended := some .done })] ∧
        some Ended.done = some Ended.pending ∧ (F.gave c).isSome))) ∨
      (F.landed = a.landed ∧ F.awaiting = a.awaiting ∧ (c, r4.n) ∉ owed a)) :
    After cs promise a c rk F { r4 with ended := some .done } := by
  have m := set_moves cs s4 c v (by rw [f_ran]; simp [hflag])
  obtain ⟨k1, k2, k3, k4, _⟩ := set_kept cs c v t4 w4 (by rw [f_ran]; simp [hflag])
  generalize hs5 : set cs s4 c v = s5 at m k1 k2 k3 k4 hs
  have hr5 : s5.ran c = some r4 := by rw [m.ran, f_ran]; simp
  rw [finish_eq ({ s5 with last := put s5.last c (some v) }) c _ hr5] at hs
  exact {
    made := by simp [hs, m.made, f_made]
    ran_c := by simp [hs]
    ran := fun d hd => by simp [hs, m.ran, f_ran, put_ne _ _ hd]
    reads := by simp [hs, m.reads, f_reads]
    after := Or.inl (by simp [hs, m.after, f_after])
    due := fun d m' hd h => by
      have : s4.due d = some m' := by rw [f_due, put_ne _ _ hd]; exact h
      simp [hs, m.due d m' this]
    fresh := fun d h => by
      rcases m.fresh d (by simpa [hs] using h) with h | h
      · by_cases hd : d = c
        · subst hd; exact Or.inr hcm
        · rw [f_due, put_ne _ _ hd] at h; exact Or.inl h
      · exact Or.inr (f_made ▸ h)
    looping := fun d hd h => by
      obtain ⟨h1, h2⟩ := m.looping d (by simpa [hs] using h)
      exact ⟨by rw [f_looping] at h1; exact h1, by simp [hs, h2, f_due, put_ne _ _ hd]⟩
    looping_c := fun h => by
      obtain ⟨h1, _⟩ := m.looping c (by simpa [hs] using h)
      rw [f_looping, hlc] at h1; cases h1
    writers := fun k w h => by
      rcases m.writers k w (by simpa [hs] using h) with h | h
      · exact Or.inl (by rw [f_writers] at h; exact h)
      · by_cases hw : w = c
        · exact Or.inr (Or.inr hw)
        · rw [f_ran, put_ne _ _ hw] at h; exact Or.inr (Or.inl h)
    store := fun k h d hd hdc hr => by
      have h' : s5.store k ≠ s4.store k := by rw [f_store]; simpa [hs] using h
      rcases m.store k h' d (f_made ▸ hd) (by rw [f_reads, put_ne _ _ hdc]; exact hr) with h | h
      · exact Or.inl (by simpa [hs] using h)
      · exact Or.inr (by rw [f_looping] at h; exact h)
    follows := fun _ => hfol
    fresh_c := fun hdue _ _ q hq => by
      have hdue' : s5.due c = none := by simpa [hs] using hdue
      by_cases e : s5.store q.1 = s4.store q.1
      · simp only [hs]
        rw [e, f_store]; exact hseen q hq
      · exfalso
        rcases m.store q.1 e c (f_made ▸ hcm)
          (by rw [f_reads]; simp; exact ⟨q.2, hq⟩) with h | h
        · rw [hdue'] at h; cases h
        · rw [f_looping, hlc] at h; cases h
    pending := fun h => by simp at h
    acts := fun e w h => by
      have h' : (e, w) ∈ s4.acts := by rw [← m.acts]; simpa [hs] using h
      rw [f_acts] at h'
      simp only [List.mem_filter, decide_eq_true_eq] at h'
      exact Or.inl ⟨h'.2, h'.1⟩
    acts_keep := fun e w hec h => by
      have : (e, w) ∈ s4.acts := by rw [f_acts]; simp [h, hec]
      simpa [hs, m.acts] using this
    last := fun d hd => by simp [hs, put_ne _ _ hd, m.last, f_last]
    computes := fun _ _ => ⟨v, by simp [hout], v, by simp [hs], Or.inl rfl⟩
    effects := fun h => by rw [hie] at h; cases h
    failed := fun h => by simp at h
    cut := fun d hd => by simp [hs, k2, f_cut d hd, put_ne _ _ hd]
    cut_c := fun h => by simp [hs, k2, f_cutc] at h
    gave := hgave
    times := by
      rw [hs]
      exact k1.of_ran (by simp [say]) (by simp [say]) (by simp [say]) (by simp [say]) (by simp [say])
        (fun d h => by
          by_cases e : d = c
          · subst e; simp [hr5]
          · simpa [say, put_ne _ _ e] using h)
    when_le := by rw [hs]; simpa [say] using k3
    runs := fun d hd => by simp [hs, k4, f_runs d hd]
    runs_c := ⟨by simp [hs, k4, hrunsc.1], hrunsc.2⟩
    owed := by
      rcases howed with ⟨h1, h2, h3 | ⟨_, h4, _⟩⟩ | h
      · exact Or.inl ⟨h1, h2, Or.inl h3⟩
      · cases h4
      · exact Or.inr h }

-- a run step keeps the invariant (A2), in a pulse
theorem Good.run {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) (hA : ∀ c, nowrites (cs c).f) {c : Nat} (hc : (a.s.due c).isSome)
    (hpl : a.s.pulsing = true) (rk : Nat) : Good cs promise (run cs promise a c rk) := by
  obtain ⟨s3, o, seen, vals, st, hs, hl, hg, haw, e_ran, e_reads, e_store, e_made, e_writers, e_last,
    e_looping, e_due, e_after, e_acts, e_cut, e_runs, e_when, e_went, e_pulses, e_pulsing, -, -, hseen,
    hfol, hstop⟩ := run_spec cs promise a c rk (hA c)
  have hcm : c < a.s.made := g.due_made c hc
  have hlc : a.s.looping c = false := by
    cases h : a.s.looping c with
    | false => rfl
    | true => have := (g.looping c h).1; rw [this] at hc; cases hc
  have hr3 : s3.ran c = some (begun a.s c vals st seen) := by rw [e_ran]; simp
  have hd3 : s3.due c = none := by rw [e_due]; simp
  have t3 : Cuts s3 := by
    refine ⟨fun d hr hd => ?_, fun hp => by rw [e_pulsing, hpl] at hp; cases hp⟩
    by_cases e : d = c
    · subst e; rw [e_went]; simp
    · rw [e_went, put_ne _ _ e]
      rw [e_ran, put_ne _ _ e] at hr
      rw [e_when, put_ne _ _ e, e_pulses] at hd
      exact g.times.went d hr hd
  have w3 : ∀ d, s3.when d ≤ s3.pulses := by
    intro d; rw [e_when, e_pulses]
    by_cases e : d = c
    · subst e; simp
    · rw [put_ne _ _ e]; exact g.when_le d
  have hn : (begun a.s c vals st seen).n = a.s.runs c + 1 := rfl
  generalize hF : Async.run cs promise a c rk = F at hs hl hg haw
  cases st with
  | some w =>
    obtain ⟨h1, h2, h3, k, h4⟩ := hstop w rfl
    have hend : ending cs s3 c (hide promise o) = stop s3 c := by
      simp [ending, hr3, begun]
    rw [hend, stop_eq s3 c _ hr3 hd3] at hs
    rw [hend, stop_eq s3 c _ hr3 hd3] at haw
    simp only [Option.isSome_some, ite_true] at hg haw
    exact g.after hcm (rk := rk) (rf := { begun a.s c vals (some w) seen with ended := some .stopped }) {
      made := by simp [hs, e_made, begun]
      ran_c := by simp [hs]
      ran := fun d hd => by simp [hs, e_ran, put_ne _ _ hd, begun]
      reads := by simp [hs, e_reads, begun]
      after := Or.inr ⟨w, by simp [hs, e_after, put_put, begun], h2, h3,
        by have := g.writers_made k w h4; exact this, by simp [hs]⟩
      due := fun d m hd h => by simp [hs, e_due, put_ne _ _ hd, h, begun]
      fresh := fun d h => by
        by_cases hd : d = c
        · subst hd; exact Or.inr hcm
        · simp [hs, e_due, put_ne _ _ hd, begun] at h; exact Or.inl h
      looping := fun d hd h => by
        simp [hs, e_looping, begun] at h
        exact ⟨h, by simp [hs, e_due, put_ne _ _ hd, begun]⟩
      looping_c := fun h => by simp [hs, e_looping, hlc, begun] at h
      writers := fun k' w' h => Or.inl (by simpa [hs, e_writers] using h)
      store := fun k' h => absurd (by simp [hs, e_store, begun]) h
      follows := fun h => absurd rfl h
      fresh_c := fun h => by simp [hs, begun] at h
      pending := fun h => by simp [begun] at h
      acts := fun e v h => by
        simp only [hs, e_acts, List.mem_filter, decide_eq_true_eq] at h
        exact Or.inl ⟨h.2, h.1⟩
      acts_keep := fun e v hec h => by simp [hs, e_acts, h, hec, begun]
      last := fun d _ => by simp [hs, e_last, begun]
      computes := fun _ h => by simp [begun] at h
      effects := fun _ h => by simp [begun] at h
      failed := fun h => by simp [begun] at h
      cut := fun d hd => by simp [hs, e_cut, put_ne _ _ hd]
      cut_c := fun h => by simp [hs, e_cut] at h
      gave := fun d hd => by rw [hg, put_ne _ _ hd]
      times := by
        rw [hs]
        exact t3.of_ran rfl rfl rfl rfl rfl (fun d h => by
          by_cases e : d = c
          · subst e; simp [hr3]
          · simpa [put_ne _ _ e] using h)
      when_le := by rw [hs]; exact w3
      runs := fun d hd => by simp [hs, e_runs, put_ne _ _ hd]
      runs_c := ⟨by simp [hs, e_runs, begun], by simp [begun]⟩
      owed := Or.inl ⟨by simp [begun], hl, Or.inl ⟨haw, by rw [hg]; simp⟩⟩ }
  | none =>
    simp only [Option.isSome_none, Bool.false_eq_true, ite_false] at hg haw
    have hfo := hfol rfl
    simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
      ite_false] at hs haw
    -- the plain ends: the store, dues and afters left as at f's end
    have plain : ∀ (o' : Out V) (e : Ended) (eq : Option Bool) (th : Option (List Nat))
        (X : List (Nat × V)) (F' : Model.State K V),
        F' = finish { (edit s3 c fun r => { r with out := some o' }) with acts := s3.acts ++ X } c e
          eq none th → F.s = F' →
        e ≠ .stopped → (e = .pending → o' = .pending) →
        (∀ x ∈ X, x.1 = c ∧ iseffect (cs c) = true ∧ a.s.loop c = none ∧ e = .done ∧
          o' = .value x.2) →
        (iseffect (cs c) = false → e = .done → ∃ v, o' = .value v ∧ near (cs c).equal v (a.s.last c)) →
        (iseffect (cs c) = true → e = .done → ∃ v, o' = .value v ∧
          (near (cs c).equal v (a.s.last c) ∨ (c, v) ∈ X)) →
        (e = .failed → o' = .error ∨ ∃ v, o' = .value v ∧ same (cs c).equal v (a.s.last c) = none) →
        (given promise o = none → o' = o) →
        ((F.awaiting = a.awaiting ∧ given promise o = none) ∨
          (F.awaiting = a.awaiting ++ [(c, { begun a.s c vals none seen with out := some o', ended := some e })] ∧
            e = .pending ∧ (given promise o).isSome)) →
        Good cs promise F := by
      intro o' e eq th X F' hF' hFs hne hpe hX hcomp heff hfail hgo hawt
      have hr4 : ({ (edit s3 c fun r => { r with out := some o' }) with acts := s3.acts ++ X } :
          Model.State K V).ran c = some { begun a.s c vals none seen with out := some o' } := by
        simp [edit, hr3, begun]
      rw [finish_eq _ c _ hr4] at hF'
      subst hF'
      refine g.after hcm (after_plain (rk := rk)
          (rf := { begun a.s c vals none seen with out := some o', ended := some e })
          (by simp [hFs, e_made, edit, begun]) (by simp [hFs, edit, e_ran, put_put, begun])
        (by simp [hFs, e_reads, begun, edit]) (by simp [hFs, e_after, edit, begun])
        (by simp [hFs, e_due, edit, begun]) (by simp [hFs, e_store, edit, begun])
        (by simp [hFs, e_writers, edit, begun]) ?_ ?_ (by simp [hFs, e_last, edit, begun]) X
        (by simp [hFs, e_acts, edit, begun]) ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_)
      · intro d hd
        by_cases hlp : e = .looping
        · simp [hFs, hlp, put_ne _ _ hd, e_looping, edit, begun]
        · simp [hFs, hlp, e_looping, edit, begun]
      · intro h
        by_cases hlp : e = .looping
        · simp [hlp, edit, begun]
        · simp [hFs, hlp, e_looping, hlc, edit, begun] at h
      · intro x hx
        obtain ⟨h1, h2, h3, h4, h5⟩ := hX x hx
        exact ⟨h1, h2, by simp [begun, h3, edit], by simp [h4, edit, begun], by simp [h5, edit, begun]⟩
      · intro _ q hq; exact hseen q (by simpa [begun] using hq)
      · intro _
        refine ⟨o, by simpa [begun] using hfo, fun h => ?_, fun p h => ?_⟩
        · rw [hg] at h; simp at h; simp [hgo h, begun]
        · rw [hg] at h; simp at h
          cases o with
          | value v => simp only [given] at h; split at h <;> simp_all
          | error => simp [given] at h
          | pending => simp [given] at h
      · intro h; simp at h; simp [hpe h, edit, begun]
      · intro he h
        simp at h
        obtain ⟨v, h1, h2⟩ := hcomp he h
        exact ⟨v, by simp [h1, edit, begun], by simpa [hFs, e_last, edit] using h2⟩
      · intro he h
        simp at h
        obtain ⟨v, h1, h2⟩ := heff he h
        refine ⟨v, by simp [h1, edit, begun], ?_⟩
        rcases h2 with h2 | h2
        · exact Or.inl (by simpa [hFs, e_last, edit] using h2)
        · exact Or.inr (Or.inl (by simp [hFs, h2, edit, begun]))
      · intro h
        simp at h
        rcases hfail h with h1 | ⟨v, h1, h2⟩
        · exact Or.inl (by simp [h1])
        · exact Or.inr ⟨v, by simp [h1], by simpa [hFs, e_last, edit] using h2⟩
      · intro d hd; simp [hFs, e_cut, edit, put_ne _ _ hd]
      · intro h; simp [hFs, e_cut, edit] at h
      · intro d hd; rw [hg, put_ne _ _ hd]
      · rw [hFs]
        refine t3.of_ran ?_ ?_ ?_ ?_ ?_ (fun d h => ?_)
        all_goals (try (simp [finish, edit, say]; done))
        · by_cases ed : d = c
          · subst ed; simp [hr3]
          · simpa [finish, edit, say, hr3, put_ne _ _ ed] using h
      · intro d; rw [hFs]; have := w3 d; cases e <;> simpa [finish, edit, say, hr3] using this
      · intro d hd; simp [hFs, e_runs, edit, put_ne _ _ hd]
      · exact ⟨by simp [hFs, e_runs, edit, begun], by simp [begun]⟩
      · refine Or.inl ⟨by simp [begun], hl, ?_⟩
        rcases hawt with ⟨h1, h2⟩ | ⟨h1, h2, h3⟩
        · exact Or.inl ⟨h1, by rw [hg, h2]; simp⟩
        · exact Or.inr ⟨h1, by simp [h2], by rw [hg]; simpa using h3⟩
    cases o with
    | error =>
      simp only [hide, given] at hs hg haw
      refine plain .error .failed none none [] F.s ?_ rfl (by simp) (by simp) (by simp) (by simp)
        (by simp) (fun _ => Or.inl rfl) (fun _ => rfl) (Or.inl ⟨by rw [haw], rfl⟩)
      rw [hs]; simp only [List.append_nil]; rfl
    | pending =>
      simp only [hide, given] at hs hg haw
      refine plain .pending .pending none none [] F.s ?_ rfl (by simp) (fun _ => rfl) (by simp)
        (by simp) (by simp) (by simp) (fun _ => rfl) (Or.inl ⟨by rw [haw], rfl⟩)
      rw [hs]; simp only [List.append_nil]; rfl
    | value v =>
      by_cases hpv : promise v = true
      · -- a promise: the run ends pending, awaiting
        simp only [hide, given, hpv, ite_true] at hs hg haw
        refine plain .pending .pending none none [] F.s ?_ rfl (by simp) (fun _ => rfl) (by simp)
          (by simp) (by simp) (by simp) (by simp [given, hpv]) (Or.inr ⟨?_, rfl, by simp [given, hpv]⟩)
        · rw [hs]; simp only [List.append_nil]; rfl
        · rw [haw]
          have hr4 : (edit s3 c fun r => { r with out := some Out.pending }).ran c =
              some { begun a.s c vals none seen with out := some .pending } := by simp [edit, hr3, begun]
          rw [finish_eq _ c _ hr4]
          simp [begun]
      · have hpv' : promise v = false := by simpa using hpv
        simp only [hide, given, hpv', Bool.false_eq_true, ite_false] at hs hg haw
        have haw' : F.awaiting = a.awaiting := by rw [haw]
        have hgo : given promise (Out.value v) = none := by simp [given, hpv']
        simp only [result] at hs
        have hl4 : (edit s3 c fun r => { r with out := some (Out.value v) }).last c = a.s.last c := by
          simp [edit, e_last]
        rw [hl4] at hs
        have hflag : ((edit s3 c fun r => { r with out := some (Out.value v) }).ran c).bind (·.loop) =
            a.s.loop c := by simp [edit, hr3, begun]
        have hcut : (edit s3 c fun r => { r with out := some (Out.value v) }).cut c = false := by
          simp [edit, e_cut]
        cases hsm : same (cs c).equal v (a.s.last c) with
        | none =>
          rw [hsm] at hs
          refine plain (.value v) .failed none none [] F.s ?_ rfl (by simp) (by simp) (by simp)
            (by simp) (by simp) (fun _ => Or.inr ⟨v, rfl, hsm⟩) (fun _ => rfl) (Or.inl ⟨haw', hgo⟩)
          rw [hs]; simp only [List.append_nil]; rfl
        | some e =>
          simp only [hsm, hflag, hcut, Bool.or_false] at hs
          by_cases hlp : ((a.s.loop c).isSome && !e) = true
          · simp only [hlp, ite_true] at hs
            refine plain (.value v) .looping (some e) (a.s.loop c) [] F.s ?_ rfl (by simp) (by simp)
              (by simp) (by simp) (by simp) (by simp) (fun _ => rfl) (Or.inl ⟨haw', hgo⟩)
            rw [hs]; simp only [List.append_nil]; rfl
          · simp only [hlp, Bool.false_eq_true, ite_false] at hs
            have hnear : e = true → near (cs c).equal v (a.s.last c) := fun he =>
              near_of_same (he ▸ hsm)
            cases hk : (cs c).kind with
            | effect act =>
              have hie : iseffect (cs c) = true := by simp [iseffect, hk]
              simp only [hk] at hs
              cases e with
              | true =>
                simp only [ite_true] at hs
                refine plain (.value v) .done (some true) none [] F.s ?_ rfl (by simp) (by simp)
                  (by simp) (fun h => by rw [hie] at h; cases h)
                  (fun _ _ => ⟨v, rfl, Or.inl (hnear rfl)⟩) (by simp) (fun _ => rfl) (Or.inl ⟨haw', hgo⟩)
                rw [hs]; simp only [List.append_nil]; rfl
              | false =>
                simp only [Bool.false_eq_true, ite_false] at hs
                have hln : a.s.loop c = none := by
                  cases h : a.s.loop c with
                  | none => rfl
                  | some _ => simp [h] at hlp
                refine plain (.value v) .done (some false) none [(c, v)] F.s hs rfl (by simp) (by simp)
                  (fun x hx => by simp at hx; subst hx; exact ⟨rfl, hie, hln, rfl, rfl⟩)
                  (fun h => by rw [hie] at h; cases h)
                  (fun _ _ => ⟨v, rfl, Or.inr (by simp)⟩) (by simp) (fun _ => rfl) (Or.inl ⟨haw', hgo⟩)
            | compute to =>
              have hie : iseffect (cs c) = false := by simp [iseffect, hk]
              simp only [hk] at hs
              cases e with
              | true =>
                simp only [ite_true] at hs
                refine plain (.value v) .done (some true) none [] F.s ?_ rfl (by simp) (by simp)
                  (by simp) (fun _ _ => ⟨v, rfl, hnear rfl⟩)
                  (fun h => by rw [hie] at h; cases h) (by simp) (fun _ => rfl) (Or.inl ⟨haw', hgo⟩)
                rw [hs]; simp only [List.append_nil]; rfl
              | false =>
                simp only [Bool.false_eq_true, ite_false] at hs
                have hln : a.s.loop c = none := by
                  cases h : a.s.loop c with
                  | none => rfl
                  | some _ => simp [h] at hlp
                -- the set: what it changes is due, or was looping
                have hr4 : (edit s3 c fun r => { r with out := some (Out.value v) }).ran c =
                    some { begun a.s c vals none seen with out := some (.value v) } := by
                  simp [edit, hr3, begun]
                generalize hs4 : (edit s3 c fun r => { r with out := some (Out.value v) }) = s4
                  at hflag hcut hr4 hs
                have f_made : s4.made = a.s.made := by rw [← hs4]; simp [edit, e_made]
                have f_reads : s4.reads = put a.s.reads c (seen.map (·.1)) := by
                  rw [← hs4]; simp [edit, e_reads]
                have f_ran : s4.ran = put a.s.ran c
                    (some { begun a.s c vals none seen with out := some (.value v) }) := by
                  rw [← hs4]; simp [edit, e_ran, put_put, hr3]
                have f_store : s4.store = a.s.store := by rw [← hs4]; simp [edit, e_store]
                have f_writers : s4.writers = a.s.writers := by rw [← hs4]; simp [edit, e_writers]
                have f_last : s4.last = a.s.last := by rw [← hs4]; simp [edit, e_last]
                have f_looping : s4.looping = a.s.looping := by rw [← hs4]; simp [edit, e_looping]
                have f_due : s4.due = put a.s.due c none := by rw [← hs4]; simp [edit, e_due]
                have f_after : s4.after = put a.s.after c none := by rw [← hs4]; simp [edit, e_after]
                have f_acts : s4.acts = a.s.acts.filter (fun x => x.1 ≠ c) := by
                  rw [← hs4]; simp [edit, e_acts]
                have f_cut : s4.cut = put a.s.cut c false := by rw [← hs4]; simp [edit, e_cut]
                have f_runs : s4.runs = put a.s.runs c (a.s.runs c + 1) := by rw [← hs4]; simp [edit, e_runs]
                have t4 : Cuts s4 := by
                  rw [← hs4]
                  exact t3.of_ran rfl rfl rfl rfl rfl (fun d h => by
                    by_cases e : d = c
                    · subst e; simp [hr3]
                    · simpa [edit, put_ne _ _ e] using h)
                have w4 : ∀ d, s4.when d ≤ s4.pulses := by rw [← hs4]; exact w3
                have m := set_moves cs s4 c v (by rw [hflag, hln])
                obtain ⟨k1, k2, k3, k4, _⟩ := set_kept cs c v t4 w4 (by rw [hflag, hln])
                generalize hs5 : set cs s4 c v = s5 at m k1 k2 k3 k4 hs
                have hr5 : s5.ran c = some { begun a.s c vals none seen with out := some (.value v) } := by
                  rw [m.ran, f_ran]; simp
                rw [finish_eq ({ s5 with last := put s5.last c (some v) }) c _ hr5] at hs
                exact g.after hcm (rk := rk)
                  (rf := { begun a.s c vals none seen with out := some (.value v), ended := some .done }) {
                  made := by simp [hs, m.made, f_made]
                  ran_c := by simp [hs]
                  ran := fun d hd => by simp [hs, m.ran, f_ran, put_ne _ _ hd]
                  reads := by simp [hs, m.reads, f_reads, begun]
                  after := Or.inl (by simp [hs, m.after, f_after])
                  due := fun d m' hd h => by
                    have : s4.due d = some m' := by rw [f_due, put_ne _ _ hd]; exact h
                    simp [hs, m.due d m' this]
                  fresh := fun d h => by
                    rcases m.fresh d (by simpa [hs] using h) with h | h
                    · by_cases hd : d = c
                      · subst hd; exact Or.inr hcm
                      · rw [f_due, put_ne _ _ hd] at h; exact Or.inl h
                    · exact Or.inr (f_made ▸ h)
                  looping := fun d hd h => by
                    obtain ⟨h1, h2⟩ := m.looping d (by simpa [hs] using h)
                    exact ⟨by rw [f_looping] at h1; exact h1, by simp [hs, h2, f_due, put_ne _ _ hd]⟩
                  looping_c := fun h => by
                    obtain ⟨h1, _⟩ := m.looping c (by simpa [hs] using h)
                    rw [f_looping, hlc] at h1; cases h1
                  writers := fun k w h => by
                    rcases m.writers k w (by simpa [hs] using h) with h | h
                    · exact Or.inl (by rw [f_writers] at h; exact h)
                    · by_cases hw : w = c
                      · exact Or.inr (Or.inr hw)
                      · rw [f_ran, put_ne _ _ hw] at h; exact Or.inr (Or.inl h)
                  store := fun k h d hd hdc hr => by
                    have h' : s5.store k ≠ s4.store k := by rw [f_store]; simpa [hs] using h
                    rcases m.store k h' d (f_made ▸ hd) (by rw [f_reads, put_ne _ _ hdc]; exact hr)
                      with h | h
                    · exact Or.inl (by simpa [hs] using h)
                    · exact Or.inr (by rw [f_looping] at h; exact h)
                  follows := fun _ => ⟨.value v, by simpa [begun] using hfo,
                    fun _ => by simp, fun p h => by rw [hg] at h; simp at h⟩
                  fresh_c := fun hdue _ _ q hq => by
                    have hq' : q ∈ seen := by simpa [begun] using hq
                    have hdue' : s5.due c = none := by simpa [hs] using hdue
                    by_cases e : s5.store q.1 = s4.store q.1
                    · simp only [hs]
                      rw [e, f_store]; exact hseen q hq'
                    · exfalso
                      rcases m.store q.1 e c (f_made ▸ hcm)
                        (by rw [f_reads]; simp; exact ⟨q.2, hq'⟩) with h | h
                      · rw [hdue'] at h; cases h
                      · rw [f_looping, hlc] at h; cases h
                  pending := fun h => by simp at h
                  acts := fun e w h => by
                    have h' : (e, w) ∈ s4.acts := by rw [← m.acts]; simpa [hs] using h
                    rw [f_acts] at h'
                    simp only [List.mem_filter, decide_eq_true_eq] at h'
                    exact Or.inl ⟨h'.2, h'.1⟩
                  acts_keep := fun e w hec h => by
                    have : (e, w) ∈ s4.acts := by rw [f_acts]; simp [h, hec]
                    simpa [hs, m.acts] using this
                  last := fun d hd => by simp [hs, put_ne _ _ hd, m.last, f_last]
                  computes := fun _ _ => ⟨v, by simp, v, by simp [hs], Or.inl rfl⟩
                  effects := fun h => by rw [hie] at h; cases h
                  failed := fun h => by simp at h
                  cut := fun d hd => by simp [hs, k2, f_cut, put_ne _ _ hd]
                  cut_c := fun h => by simp [hs, k2, f_cut] at h
                  gave := fun d hd => by rw [hg, put_ne _ _ hd]
                  times := by
                    rw [hs]
                    exact k1.of_ran (by cases e : (Ended.done == Ended.looping) <;> simp [say])
                      (by simp [say]) (by simp [say]) (by simp [say]) (by simp [say])
                      (fun d h => by
                        by_cases e : d = c
                        · subst e; simp [hr5]
                        · simpa [say, put_ne _ _ e] using h)
                  when_le := by rw [hs]; simpa [say] using k3
                  runs := fun d hd => by simp [hs, k4, f_runs, put_ne _ _ hd]
                  runs_c := ⟨by simp [hs, k4, f_runs, begun], by simp [begun]⟩
                  owed := Or.inl ⟨by simp [begun], hl, Or.inl ⟨haw', by rw [hg]; simp⟩⟩ }

-- acts

-- an act's writes, each said changed by e unflagged: the causes and cuts as a change leaves them
theorem writes_kept (cs : Nat → Comp K V) (e : Nat) :
    ∀ (ws : List (K × V)) (s : Model.State K V), Cuts s → (∀ d, s.when d ≤ s.pulses) →
      ((s.ran e).bind (·.loop)) = none →
      let s' := ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s
      Cuts s' ∧ s'.cut = s.cut ∧ (∀ d, s'.when d ≤ s'.pulses) ∧ s'.runs = s.runs ∧ s'.ran = s.ran ∧
        s'.pulsing = s.pulsing ∧ s'.pulses = s.pulses
  | [], s, h1, h2, _ => ⟨h1, rfl, h2, rfl, rfl, rfl, rfl⟩
  | kv :: ws, s, h1, h2, h3 => by
    simp only [List.foldl_cons]
    have hst : Cuts (store s kv.1 kv.2) := h1.of_eq rfl rfl rfl rfl rfl rfl
    have hw : ∀ x, some e = some x → (((store s kv.1 kv.2).ran x).bind (·.loop)) = none := by
      intro x hx; cases hx; simpa [store] using h3
    have kk := changed_kept cs hst [kv.1] (some e)
    have hc := changed_cut cs hst [kv.1] (some e) hw
    obtain ⟨a1, a2, a3, a4, a5, a6, a7⟩ := writes_kept cs e ws
      (changed cs (store s kv.1 kv.2) [kv.1] (some e)) kk.2.1 (kk.when_le h2)
      (by rw [kk.1.ran]; simpa [store] using h3)
    exact ⟨a1, a2.trans (hc.trans rfl), a3, a4.trans kk.1.runs, a5.trans kk.1.ran,
      a6.trans kk.1.pulsing, a7.trans kk.1.pulses⟩

-- an act: its effect not due, it acts on its run's value; due, it is skipped
theorem Good.act {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {e : Nat} {v : V} {rest : List (Nat × V)} (hs : a.s.acts = (e, v) :: rest) :
    Good cs promise { a with s := act cs { a.s with acts := rest } e v } := by
  obtain ⟨he, r0, hr0, hl0, hd0, ho0⟩ := g.acts e v (by simp [hs])
  have hrest : ∀ x, x ∈ rest → x ∈ a.s.acts := fun x hx => by simp [hs, hx]
  simp only [Model.act]
  split
  · rename_i hdue
    exact {
      after_due := g.after_due, acyclic := g.acyclic, due_made := g.due_made,
      writers_made := g.writers_made, ran_made := g.ran_made, reads := g.reads,
      follows := g.follows, fresh := g.fresh, looping := g.looping, pending := g.pending,
      acts := fun e' v' h => g.acts e' v' (hrest _ h)
      computes := g.computes
      effects := fun e' r he' h hd => by
        obtain ⟨v', h1, h2⟩ := g.effects e' r he' h hd
        refine ⟨v', h1, ?_⟩
        by_cases ee : e' = e
        · subst ee; exact Or.inr (Or.inr hdue)
        · rcases h2 with h2 | h2 | h2
          · exact Or.inl h2
          · rw [hs] at h2
            rcases List.mem_cons.1 h2 with h2 | h2
            · cases h2; exact absurd rfl ee
            · exact Or.inr (Or.inl h2)
          · exact Or.inr (Or.inr h2)
      failed := g.failed, cut := g.cut, when_le := g.when_le,
      times := g.times.of_eq rfl rfl rfl rfl rfl rfl, runs := g.runs,
      owed_le := g.owed_le, nodup := g.nodup, owing := g.owing, handles := g.handles }
  · rename_i hdue
    have hk : ∃ g', (cs e).kind = .effect g' := by
      simp only [iseffect] at he; split at he
      · exact ⟨_, ‹_›⟩
      · cases he
    obtain ⟨act', hk⟩ := hk
    simp only [hk]
    generalize hs1 : say { a.s with acts := rest } (.act e v (a.s.last e)) = s1
    have e1 : s1.ran = a.s.ran := by rw [← hs1]; rfl
    have e2 : s1.acts = rest := by rw [← hs1]; rfl
    have e3 : s1.last = a.s.last := by rw [← hs1]; rfl
    have e4 : s1.due = a.s.due := by rw [← hs1]; rfl
    have t1 : Cuts s1 := by rw [← hs1]; exact g.times.of_eq rfl rfl rfl rfl rfl rfl
    have w1 : ∀ d, s1.when d ≤ s1.pulses := by rw [← hs1]; exact g.when_le
    have hfl : ((s1.ran e).bind (·.loop)) = none := by rw [e1, hr0]; simp [hl0]
    have m := writes_moves cs e (act' v (a.s.last e)) s1 hfl
    obtain ⟨k1, k2, k3, k4, k5, k6, k7⟩ := writes_kept cs e (act' v (a.s.last e)) s1 t1 w1 hfl
    generalize hs2 : (act' v (a.s.last e)).foldl
      (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1 = s2 at m k1 k2 k3 k4 k5 k6 k7
    have e5 : s1.cut = a.s.cut := by rw [← hs1]; rfl
    have e6 : s1.runs = a.s.runs := by rw [← hs1]; rfl
    exact {
      after_due := fun x w h => by
        simp only [say] at h ⊢; rw [m.after, ← hs1] at h
        obtain ⟨h1, h2⟩ := g.after_due x w h
        refine ⟨m.isSome (by rw [e4]; exact h1), ?_⟩
        rw [m.made, ← hs1]; exact h2
      acyclic := fun x h => by
        have ea : aft (say { s2 with last := put s2.last e (some v) } (.acts e (((s2.ran e).map (·.n)).getD 0))) = aft a.s := by
          funext a' b; simp [aft, say, m.after, ← hs1]
        exact g.acyclic x (ea ▸ h)
      due_made := fun x h => by
        simp only [say] at h ⊢
        rcases m.fresh x h with h | h
        · rw [m.made, ← hs1]; exact g.due_made x (by rw [← e4]; exact h)
        · rw [m.made]; exact h
      writers_made := fun k w h => by
        simp only [say] at h ⊢
        rcases m.writers k w h with h | h
        · rw [m.made, ← hs1]; exact g.writers_made k w (by rw [← hs1] at h; exact h)
        · rw [m.made, ← hs1]; exact g.ran_made w (by rw [e1] at h; exact h)
      ran_made := fun c h => by
        simp only [say] at h ⊢
        rw [m.made, ← hs1]; exact g.ran_made c (by rw [m.ran, e1] at h; exact h)
      reads := fun c => by simp only [say]; rw [m.reads, m.ran, e1, ← hs1]; exact g.reads c
      follows := fun c r h => by simp only [say] at h; exact g.follows c r (by rw [m.ran, e1] at h; exact h)
      fresh := fun c r h hd hst hc q hq => by
        simp only [say] at h hd hc ⊢
        have h' : a.s.ran c = some r := by rw [m.ran, e1] at h; exact h
        have hd' : a.s.due c = none := by
          cases ex : a.s.due c with
          | none => rfl
          | some x => rw [← e4] at ex; rw [m.due c x ex] at hd; cases hd
        have hc' : a.s.cut c = false := by rw [k2, e5] at hc; exact hc
        by_cases ee : s2.store q.1 = s1.store q.1
        · rw [ee, ← hs1]; exact g.fresh c r h' hd' hst hc' q hq
        · exfalso
          have hcm : c < s1.made := by rw [← hs1]; exact g.ran_made c (by simp [h'])
          have hr : q.1 ∈ s1.reads c := by
            rw [← hs1]; simp only [say]; rw [g.reads c, h']; simp only [Option.map_some, Option.getD_some]
            exact List.mem_map_of_mem hq
          rcases m.store q.1 ee c hcm hr with h1 | h1
          · rw [hd] at h1; cases h1
          · rw [← hs1] at h1
            obtain ⟨_, r', h2, h3⟩ := g.looping c h1
            rw [h'] at h2; cases h2
            rcases hst with h4 | h4 | h4 <;> rw [h4] at h3 <;> cases h3
      looping := fun c h => by
        simp only [say] at h ⊢
        obtain ⟨h1, h2⟩ := m.looping c h
        rw [← hs1] at h1
        obtain ⟨h3, r, h4, h5⟩ := g.looping c h1
        exact ⟨by rw [h2, e4]; exact h3, r, by rw [m.ran, e1]; exact h4, h5⟩
      pending := fun c r h => by simp only [say] at h; exact g.pending c r (by rw [m.ran, e1] at h; exact h)
      acts := fun e' v' h => by
        simp only [say] at h
        have h' : (e', v') ∈ rest := by rw [m.acts, e2] at h; exact h
        obtain ⟨h1, r, h2⟩ := g.acts e' v' (hrest _ h')
        exact ⟨h1, r, by simp only [say]; rw [m.ran, e1]; exact h2.1, h2.2⟩
      computes := fun c r hc h hd => by
        simp only [say] at h ⊢
        have hce : c ≠ e := by intro ce; subst ce; rw [he] at hc; cases hc
        obtain ⟨v', h1, h2⟩ := g.computes c r hc (by rw [m.ran, e1] at h; exact h) hd
        exact ⟨v', h1, by rw [put_ne _ _ hce, m.last, e3]; exact h2⟩
      effects := fun e' r he' h hd => by
        simp only [say] at h ⊢
        have h' : a.s.ran e' = some r := by rw [m.ran, e1] at h; exact h
        obtain ⟨v', h1, h2⟩ := g.effects e' r he' h' hd
        refine ⟨v', h1, ?_⟩
        by_cases ee : e' = e
        · subst ee
          rw [hr0] at h'; cases h'
          rw [ho0] at h1; cases h1
          exact Or.inl ⟨v, by simp, Or.inl rfl⟩
        · rcases h2 with h2 | h2 | h2
          · exact Or.inl (by rw [put_ne _ _ ee, m.last, e3]; exact h2)
          · rw [hs] at h2
            rcases List.mem_cons.1 h2 with h2 | h2
            · cases h2; exact absurd rfl ee
            · exact Or.inr (Or.inl (by rw [m.acts, e2]; exact h2))
          · exact Or.inr (Or.inr (m.isSome (by rw [e4]; exact h2)))
      failed := fun c r h hf => by
        simp only [say] at h ⊢
        have h' : a.s.ran c = some r := by rw [m.ran, e1] at h; exact h
        have hce : c ≠ e := by
          intro ce; subst ce; rw [hr0] at h'; cases h'; rw [hd0] at hf; cases hf
        have := g.failed c r h' hf
        rwa [put_ne _ _ hce, m.last, e3]
      cut := fun c h => by
        simp only [say] at h ⊢
        rw [k2, e5] at h; rw [m.ran, e1]; exact g.cut c h
      when_le := by simpa [say] using k3
      times := by
        simp only [say]
        exact k1.of_eq rfl rfl rfl rfl rfl rfl
      runs := fun c => by simp only [say]; rw [k4, e6, m.ran, e1]; exact g.runs c
      owed_le := fun x hx => by simp only [say]; rw [k4, e6]; exact g.owed_le x hx
      nodup := g.nodup
      owing := fun c r h hx => g.owing c r (by simp only [say] at h; rw [m.ran, e1] at h; exact h) hx
      handles := fun c r0 hx r h => g.handles c r0 hx r (by simp only [say] at h; rw [m.ran, e1] at h; exact h) }

-- landings

-- the first landed popped: what is owed loses it; its run, if the latest, was pending
theorem Good.pop {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {x : Nat × Nat × Out V} {rest : List (Nat × Nat × Out V)}
    (h : a.landed = x :: rest) :
    Good cs promise { a with landed := rest } ∧ (x.1, x.2.1) ∉ owed { a with landed := rest } ∧
      ∀ r, a.s.ran x.1 = some r → r.n = x.2.1 → r.ended = some .pending ∧ (a.gave x.1).isSome := by
  have pm : (owed a).Perm ((x.1, x.2.1) :: owed { a with landed := rest }) := by
    simp only [owed, h, List.map_cons]
    exact List.perm_middle
  have nd := pm.nodup_iff.1 g.nodup
  have sub : ∀ y, y ∈ owed { a with landed := rest } → y ∈ owed a :=
    fun y hy => pm.mem_iff.2 (List.mem_cons_of_mem _ hy)
  refine ⟨{
    after_due := g.after_due, acyclic := g.acyclic, due_made := g.due_made,
    writers_made := g.writers_made, ran_made := g.ran_made, reads := g.reads,
    follows := g.follows, fresh := g.fresh, looping := g.looping, pending := g.pending,
    acts := g.acts, computes := g.computes, effects := g.effects, failed := g.failed,
    cut := g.cut, when_le := g.when_le, times := g.times, runs := g.runs,
    owed_le := fun y hy => g.owed_le y (sub y hy)
    nodup := (List.nodup_cons.1 nd).2
    owing := fun c r hr hy => g.owing c r hr (sub _ hy)
    handles := g.handles }, (List.nodup_cons.1 nd).1, fun r hr hn => ?_⟩
  have : (x.1, r.n) ∈ owed a := by
    rw [hn]; exact pm.mem_iff.2 (List.mem_cons_self ..)
  exact g.owing x.1 r hr this

-- a landing: the run still c's latest and c not due, its outcome lands; else nowhere
theorem Good.land {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {c n : Nat} {o : Out V} (hno : (c, n) ∉ owed a)
    (hpend : ∀ r, a.s.ran c = some r → r.n = n → r.ended = some .pending ∧ (a.gave c).isSome) :
    Good cs promise (land cs a c n o) := by
  unfold Async.land
  split
  · rename_i hcond
    obtain ⟨h1, hdc⟩ := hcond
    obtain ⟨r, hr, hn⟩ : ∃ r, a.s.ran c = some r ∧ r.n = n := by
      cases e : a.s.ran c with
      | none => rw [e] at h1; cases h1
      | some r => rw [e] at h1; simp at h1; exact ⟨r, rfl, h1⟩
    subst hn
    obtain ⟨hpe, hgv⟩ := hpend r hr rfl
    obtain ⟨p, hp⟩ := Option.isSome_iff_exists.1 hgv
    obtain ⟨of, hfo, _, hfp⟩ := g.follows c r hr (by rw [hpe]; simp)
    obtain ⟨hof, hpp⟩ := hfp p hp
    have hcm : c < a.s.made := g.ran_made c (by simp [hr])
    have hlc : a.s.looping c = false := by
      cases h : a.s.looping c with
      | false => rfl
      | true =>
        obtain ⟨_, r', h2, h3⟩ := g.looping c h; rw [hr] at h2; cases h2; rw [hpe] at h3; cases h3
    have hac : a.s.after c = none := by
      cases h : a.s.after c with
      | none => rfl
      | some w => have := (g.after_due c w h).1; rw [hdc] at this; cases this
    have hreads : a.s.reads c = r.seen.map (·.1) := by rw [g.reads c, hr]; rfl
    have hnoact : a.s.acts.filter (fun x => x.1 ≠ c) = a.s.acts := by
      apply List.filter_eq_self.2
      intro x hx
      have := g.acts x.1 x.2 hx
      by_cases e : x.1 = c
      · obtain ⟨_, r', h2, _, h3, _⟩ := this
        rw [e, hr] at h2; cases h2; rw [hpe] at h3; cases h3
      · simp [e]
    have hseen : a.s.cut c = false → ∀ q ∈ r.seen, a.s.store q.1 = q.2 :=
      fun hc => g.fresh c r hr hdc (Or.inr (Or.inr hpe)) hc
    have hcutl : a.s.cut c = true → r.loop.isSome := by
      intro h; obtain ⟨r', h1, h2, _⟩ := g.cut c h; rw [hr] at h1; cases h1; exact h2
    have hrunsc : a.s.runs c = r.n := by have := g.runs c; rw [hr] at this; simpa using this.symm
    have hr1 : (edit a.s c fun r => { r with out := some o }).ran c = some { r with out := some o } := by
      simp [edit, hr]
    have hfol : ∃ o', follow (cs c).f r.seen = some o' ∧ (a.gave c = none → False) ∧
        ∀ p', a.gave c = some p' → o' = .value p' ∧ promise p' = true := by
      refine ⟨of, hfo, fun h => ?_, fun p' h => ?_⟩
      · rw [hp] at h; cases h
      · rw [hp] at h; cases h; exact ⟨hof, hpp⟩
    -- the plain ends
    have plain : ∀ (E : Ended) (eq : Option Bool) (th : Option (List Nat)) (X : List (Nat × V))
        (F' : Model.State K V),
        F' = finish { (edit a.s c fun r => { r with out := some o }) with acts := a.s.acts ++ X } c E
          eq none th →
        E ≠ .stopped → (E = .pending → o = .pending) →
        (∀ x ∈ X, x.1 = c ∧ iseffect (cs c) = true ∧ r.loop = none ∧ E = .done ∧ o = .value x.2) →
        (iseffect (cs c) = false → E = .done → ∃ v, o = .value v ∧ near (cs c).equal v (a.s.last c)) →
        (iseffect (cs c) = true → E = .done → ∃ v, o = .value v ∧
          (near (cs c).equal v (a.s.last c) ∨ (c, v) ∈ X)) →
        (E = .failed → o = .error ∨ ∃ v, o = .value v ∧ same (cs c).equal v (a.s.last c) = none) →
        (a.s.cut c = true → E ≠ .done) →
        Good cs promise { a with s := F' } := by
      intro E eq th X F' hF' hne hpe' hX hcomp heff hfail hcd
      have hr4 : ({ (edit a.s c fun r => { r with out := some o }) with acts := a.s.acts ++ X } :
          Model.State K V).ran c = some { r with out := some o } := by simp [edit, hr]
      rw [finish_eq _ c _ hr4] at hF'
      subst hF'
      refine g.after hcm (after_plain (rk := 0) (rf := { r with out := some o, ended := some E })
        (by simp [edit]) (by simp [edit, put_put]) (by simp [edit, put_self hreads])
        (by simp [edit, put_self hac]) (by simp [edit, put_self hdc]) (by simp [edit])
        (by simp [edit]) ?_ ?_ (by simp [edit]) X (by rw [hnoact]) ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_ ?_
        ?_ ?_ ?_ ?_ ⟨by simp [edit, hrunsc], by simp [hrunsc]⟩ (Or.inr ⟨rfl, rfl, hno⟩))
      · intro d hd
        by_cases hl : E = .looping
        · simp [hl, put_ne _ _ hd, edit]
        · simp [hl, edit]
      · intro h
        by_cases hl : E = .looping
        · simp [hl]
        · simp [hl, edit, hlc] at h
      · intro x hx
        obtain ⟨h1, h2, h3, h4, h5⟩ := hX x hx
        exact ⟨h1, h2, h3, by simp [h4], by simp [h5]⟩
      · intro hc q hq; exact hseen (by simpa [edit] using hc) q hq
      · intro _
        obtain ⟨o', h1, h2, h3⟩ := hfol
        exact ⟨o', h1, fun h => (h2 h).elim, h3⟩
      · intro h; simp at h; simp [hpe' h]
      · intro he h
        simp at h
        obtain ⟨v, h1, h2⟩ := hcomp he h
        exact ⟨v, by simp [h1], by simpa [edit] using h2⟩
      · intro he h
        simp at h
        obtain ⟨v, h1, h2⟩ := heff he h
        refine ⟨v, by simp [h1], ?_⟩
        rcases h2 with h2 | h2
        · exact Or.inl (by simpa [edit] using h2)
        · exact Or.inr (Or.inl (by simp [h2, edit]))
      · intro h
        simp at h
        rcases hfail h with h1 | ⟨v, h1, h2⟩
        · exact Or.inl (by simp [h1])
        · exact Or.inr ⟨v, by simp [h1], by simpa [edit] using h2⟩
      · intro d hd; simp [edit]
      · intro h
        have h' : a.s.cut c = true := by simpa [edit] using h
        exact ⟨by simpa using hcutl h', by simpa using hcd h'⟩
      · intro d _; rfl
      · exact g.times.of_ran (by cases E <;> simp [edit, say]) (by simp [edit, say]) (by simp [edit, say])
          (by simp [edit, say]) (by simp [edit, say]) (fun d h => by
            by_cases e : d = c
            · subst e; simp [hr]
            · simpa [edit, say, put_ne _ _ e] using h)
      · intro d; have := g.when_le d; cases E <;> simpa [edit, say] using this
      · intro d hd; simp [edit]
    cases o with
    | error =>
      refine plain .failed none none [] _ ?_ (by simp) (by simp) (by simp) (by simp) (by simp)
        (fun _ => Or.inl rfl) (by simp)
      simp only [List.append_nil]; rfl
    | pending =>
      refine plain .pending none none [] _ ?_ (by simp) (fun _ => rfl) (by simp) (by simp) (by simp)
        (by simp) (by simp)
      simp only [List.append_nil]; rfl
    | value v =>
      simp only [result]
      have hl4 : (edit a.s c fun r => { r with out := some (Out.value v) }).last c = a.s.last c := by
        simp [edit]
      rw [hl4]
      have hflag : ((edit a.s c fun r => { r with out := some (Out.value v) }).ran c).bind (·.loop) =
          r.loop := by simp [edit, hr]
      have hcut' : (edit a.s c fun r => { r with out := some (Out.value v) }).cut c = a.s.cut c := by
        simp [edit]
      cases hsm : same (cs c).equal v (a.s.last c) with
      | none =>
        simp only
        refine plain .failed none none [] _ ?_ (by simp) (by simp) (by simp) (by simp) (by simp)
          (fun _ => Or.inr ⟨v, rfl, hsm⟩) (by simp)
        simp only [List.append_nil]; rfl
      | some e =>
        simp only [hflag, hcut']
        by_cases hlp : (r.loop.isSome && (!e || a.s.cut c)) = true
        · simp only [hlp, ite_true]
          refine plain .looping (some e) r.loop [] _ ?_ (by simp) (by simp) (by simp) (by simp)
            (by simp) (by simp) (by simp)
          simp only [List.append_nil]; rfl
        · simp only [hlp, Bool.false_eq_true, ite_false]
          have hc0 : a.s.cut c = false := by
            cases h : a.s.cut c with
            | false => rfl
            | true => have := hcutl h; simp [this, h] at hlp
          have hnear : e = true → near (cs c).equal v (a.s.last c) := fun he =>
            near_of_same (he ▸ hsm)
          cases hk : (cs c).kind with
          | effect act =>
            have hie : iseffect (cs c) = true := by simp [iseffect, hk]
            simp only
            cases e with
            | true =>
              simp only [ite_true]
              refine plain .done (some true) none [] _ ?_ (by simp) (by simp) (by simp)
                (fun h => by rw [hie] at h; cases h)
                (fun _ _ => ⟨v, rfl, Or.inl (hnear rfl)⟩) (by simp) (fun h => by rw [hc0] at h; cases h)
              simp only [List.append_nil]; rfl
            | false =>
              simp only [Bool.false_eq_true, ite_false]
              have hln : r.loop = none := by
                cases h : r.loop with
                | none => rfl
                | some _ => simp [h] at hlp
              refine plain .done (some false) none [(c, v)] _ rfl (by simp) (by simp)
                (fun x hx => by simp at hx; subst hx; exact ⟨rfl, hie, hln, rfl, rfl⟩)
                (fun h => by rw [hie] at h; cases h)
                (fun _ _ => ⟨v, rfl, Or.inr (by simp)⟩) (by simp) (fun h => by rw [hc0] at h; cases h)
          | compute to =>
            have hie : iseffect (cs c) = false := by simp [iseffect, hk]
            simp only
            cases e with
            | true =>
              simp only [ite_true]
              refine plain .done (some true) none [] _ ?_ (by simp) (by simp) (by simp)
                (fun _ _ => ⟨v, rfl, hnear rfl⟩)
                (fun h => by rw [hie] at h; cases h) (by simp) (fun h => by rw [hc0] at h; cases h)
              simp only [List.append_nil]; rfl
            | false =>
              simp only [Bool.false_eq_true, ite_false]
              have hln : r.loop = none := by
                cases h : r.loop with
                | none => rfl
                | some _ => simp [h] at hlp
              refine g.after hcm (after_set cs promise (rk := 0) (s4 := edit a.s c fun r =>
                  { r with out := some (Out.value v) }) (r4 := { r with out := some (.value v) })
                hcm hlc hie (by simp [edit]) (by simp [edit, put_self hreads])
                (by simp [edit, hr]) (by simp [edit]) (by simp [edit]) (by simp [edit])
                (by simp [edit]) (by simp [edit, put_self hdc]) (by simp [edit, put_self hac])
                (by simp only [edit]; rw [hnoact]) (fun d _ => by simp [edit])
                (by simp [edit, hc0]) (fun d _ => by simp [edit]) (by simp [hln]) (by simp)
                (g.times.of_ran rfl rfl rfl rfl rfl (fun d h => by
                  by_cases e : d = c
                  · subst e; simp [hr]
                  · simpa [edit, put_ne _ _ e] using h))
                (by simpa [edit] using g.when_le) (hseen hc0) ?_ rfl (fun _ _ => rfl)
                ⟨by simp [edit, hrunsc], by simp [hrunsc]⟩ (Or.inr ⟨rfl, rfl, hno⟩))
              obtain ⟨o', h1, h2, h3⟩ := hfol
              exact ⟨o', h1, fun h => (h2 h).elim, h3⟩
  · exact g

-- pulsing: only begin and close move it

theorem mark_pulsing (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).pulsing = s.pulsing := by
  unfold mark Model.settle due causeof keep
  cases who <;> simp only <;> (repeat' split) <;> rfl

theorem changed_pulsing (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K) (who : Option Nat) :
    (changed cs s keys who).pulsing = s.pulsing := by
  simp only [changed]
  suffices h : ∀ (ks : List K) (s1 : Model.State K V) w t r,
      (ks.foldl (fun s k => tell (learn s k w) k t r) s1).pulsing = s1.pulsing by
    exact h _ _ _ _ _
  intro ks
  induction ks with
  | nil => intros; rfl
  | cons k ks ih =>
    intro s1 w t r
    simp only [List.foldl_cons]
    rw [ih]
    simp only [tell]
    suffices h2 : ∀ (ds : List Nat) (s2 : Model.State K V), (ds.foldl (fun s d => mark s d t r) s2).pulsing = s2.pulsing by
      rw [h2]; cases w <;> rfl
    intro ds
    induction ds with
    | nil => intros; rfl
    | cons d ds ih2 => intro s2; simp only [List.foldl_cons]; rw [ih2, mark_pulsing]

theorem exec_pulsing (cs : Nat → Comp K V) (c : Nat) : ∀ (p : Prog K V) (s : Model.State K V),
    (exec cs c s p).1.pulsing = s.pulsing
  | .value _, _ => rfl
  | .error, _ => rfl
  | .pending, _ => rfl
  | .read k next, s => by
    simp only [exec]
    split
    · rw [exec_pulsing]; rfl
    · split
      · rw [exec_pulsing]; rfl
      · split
        · rfl
        · rw [exec_pulsing]; rfl
  | .write k v next, s => by
    simp only [exec]; rw [exec_pulsing, changed_pulsing]; rfl

theorem finish_pulsing (s : Model.State K V) (c : Nat) e eq w th : (finish s c e eq w th).pulsing = s.pulsing := by
  unfold finish; split
  · rfl
  · simp only [say]; (repeat' split) <;> rfl

theorem set_pulsing (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (v : V) : (set cs s c v).pulsing = s.pulsing := by
  unfold Model.set; split
  · rw [changed_pulsing]; rfl
  · rfl

theorem result_pulsing (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (v : V) :
    (result cs s c v).pulsing = s.pulsing := by
  unfold result
  split
  · rw [finish_pulsing]
  · simp only
    split
    · rw [finish_pulsing]
    · split
      · split
        · rw [finish_pulsing]
        · rw [finish_pulsing]
      · split
        · rw [finish_pulsing]
        · rw [finish_pulsing]; simp only; rw [set_pulsing]

theorem ending_pulsing (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (o : Out V) :
    (ending cs s c o).pulsing = s.pulsing := by
  unfold ending
  split
  · unfold stop; split
    · rfl
    · rw [finish_pulsing]; split <;> rfl
  · simp only
    split
    · rw [finish_pulsing]; rfl
    · rw [finish_pulsing]; rfl
    · rw [result_pulsing]; rfl

theorem act_pulsing (cs : Nat → Comp K V) (s : Model.State K V) (e : Nat) (v : V) :
    (act cs s e v).pulsing = s.pulsing := by
  unfold act
  split
  · rfl
  · split
    · rfl
    · simp only [say]
      suffices h : ∀ (ws : List (K × V)) (s1 : Model.State K V),
          (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1).pulsing = s1.pulsing by
        rw [h]
      intro ws
      induction ws with
      | nil => intros; rfl
      | cons kv ws ih => intro s1; simp only [List.foldl_cons]; rw [ih, changed_pulsing]; rfl

theorem step_pulsing (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    {a a' : State K V} (h : step cs promise rank a = some a') : a'.s.pulsing = a.s.pulsing := by
  unfold step at h
  split at h
  · cases h
    unfold Async.land; split
    · simp only; split
      · rw [finish_pulsing]; rfl
      · rw [finish_pulsing]; rfl
      · rw [result_pulsing]; rfl
    · rfl
  · split at h
    · cases h
      simp only [run]
      rw [ending_pulsing]
      simp only
      rw [exec_pulsing]; rfl
    · cases h; rfl
  · rename_i hph
    obtain ⟨s', h1, h2⟩ := Option.map_eq_some_iff.1 h
    subst h2
    simp only
    unfold Model.step at h1
    rw [hph] at h1
    simp only at h1
    split at h1
    · cases h1; rw [act_pulsing]
    · split at h1
      · cases h1; rfl
      · cases h1


-- a step keeps the invariant (A2), in a pulse
theorem Good.step {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a a' : State K V} (g : Good cs promise a) (hA : ∀ c, nowrites (cs c).f)
    (hp : a.s.pulsing = true) (h : step cs promise rank a = some a') : Good cs promise a' := by
  unfold Async.step at h
  split at h
  · rename_i c n o rest _ hl
    cases h
    obtain ⟨g1, hno, hpend⟩ := g.pop hl
    exact g1.land hno hpend
  · split at h
    · rename_i c hc
      cases h
      have := (next_ready hc).1
      simp only [ready, Bool.and_eq_true] at this
      exact g.run hA this.1 hp _
    · cases h
      exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl) rfl rfl
        (g.times.of_eq rfl rfl rfl rfl rfl rfl) g.when_le
  · rename_i hph
    obtain ⟨s', h1, h2⟩ := Option.map_eq_some_iff.1 h
    subst h2
    unfold Model.step at h1
    split at h1
    · rename_i h'; rw [hph] at h'; cases h'
    · split at h1
      · rename_i x rest hx
        cases h1
        exact g.act hx
      · split at h1
        · cases h1
          exact g.moves (Moves.of_eq rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl) rfl rfl
            (g.times.of_eq rfl rfl rfl rfl rfl rfl) g.when_le
        · cases h1

-- the states the host, the environment and the pulses reach: Model's host steps; a pulse's begin,
-- steps and close; between pulses, a promise settling, and a change named by a tame handle
inductive Reach (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat) :
    State K V → Prop
  | empty : Reach cs promise rank Async.empty
  | make {a} : Reach cs promise rank a → Reach cs promise rank (make cs a)
  | write {a} (kvs : List (K × V)) : Reach cs promise rank a → Reach cs promise rank (write cs a kvs)
  | tell {a} (keys : List K) : Reach cs promise rank a →
      Reach cs promise rank { a with s := changed cs a.s keys none }
  | begin {a} : Reach cs promise rank a → Reach cs promise rank { a with s := Model.begin a.s }
  | step {a a'} : Reach cs promise rank a → a.s.pulsing = true → step cs promise rank a = some a' →
      Reach cs promise rank a'
  | close {a} : Reach cs promise rank a → step cs promise rank a = none →
      Reach cs promise rank { a with s := Model.close a.s }
  | settle {a} (i : Nat) (o : Out V) : Reach cs promise rank a → a.s.pulsing = false →
      Reach cs promise rank (settle a i o)
  | named {a} (i : Nat) (kvs : List (K × V)) : Reach cs promise rank a → a.s.pulsing = false →
      tame a i → Reach cs promise rank (named cs a i kvs)

theorem Reach.good {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a) : Good cs promise a := by
  induction h with
  | empty => exact Good.empty cs promise
  | make _ ih => exact ih.make
  | write kvs _ ih => exact ih.write kvs
  | tell keys _ ih => exact ih.tell keys
  | begin _ ih => exact ih.begin
  | step _ hp h ih => exact ih.step hA hp h
  | close _ _ ih => exact ih.close
  | settle i o _ _ ih => exact ih.settle i o
  | named i kvs _ hp ht ih => exact ih.named hp i kvs ht

-- a pulse, run to its end, reaches what it ends at
theorem steps_reach {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat} :
    ∀ (f : Nat) (a a' : State K V), Reach cs promise rank a → a.s.pulsing = true →
      steps cs promise rank f a = some a' → Reach cs promise rank a'
  | 0, _, _, _, _, h => by simp [steps] at h
  | f + 1, a, a', ha, hp, h => by
    simp only [steps] at h
    split at h
    · rename_i a1 h1
      exact steps_reach f a1 a' (.step ha hp h1) (by rw [step_pulsing cs promise rank h1]; exact hp) h
    · rename_i h1
      cases h
      exact .close ha h1

theorem pulse_reach {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {fuel : Nat} {a a' : State K V} (ha : Reach cs promise rank a)
    (h : pulse cs promise rank fuel a = some a') : Reach cs promise rank a' :=
  steps_reach fuel _ a' (.begin ha) (by simp [Model.begin]) h

-- Theorem 2 with promises

-- Lemma F: not due, done, failed or pending, its loop not cut: every key it read still holds what
-- it read
theorem fresh_reads {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a) {c : Nat} {r : Run K V}
    (hr : a.s.ran c = some r) (hd : a.s.due c = none) (hs : settled r) (hc : a.s.cut c = false) :
    ∀ q ∈ r.seen, a.s.store q.1 = q.2 :=
  (h.good hA).fresh c r hr hd hs hc

-- such a run is f from scratch on the store now: f gives what the run's f gave (its out, or the
-- promise it gave), reading the same keys, and the tracker holds those keys
theorem quiescence {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a) {c : Nat} {r : Run K V}
    (hr : a.s.ran c = some r) (hd : a.s.due c = none) (hs : settled r) (hc : a.s.cut c = false) :
    ∃ o, eval a.s.store (cs c).f = (o, r.seen) ∧ (a.gave c = none → r.out = some o) ∧
      (∀ p, a.gave c = some p → o = .value p ∧ promise p = true) ∧
      a.s.reads c = (eval a.s.store (cs c).f).2.map (·.1) := by
  have g := h.good hA
  have hns : r.ended ≠ some .stopped := by
    rcases hs with e | e | e <;> rw [e] <;> simp
  obtain ⟨o, hf, h1, h2⟩ := g.follows c r hr hns
  have he := eval_follow (st := a.s.store) _ _ _ hf (g.fresh c r hr hd hs hc)
  refine ⟨o, he, h1, h2, ?_⟩
  rw [he, g.reads c, hr]; rfl

-- a done run's loop was not cut
theorem done_uncut {cs : Nat → Comp K V} {promise : V → Bool} {a : State K V}
    (g : Good cs promise a) {c : Nat} {r : Run K V} (hr : a.s.ran c = some r)
    (hdone : r.ended = some .done) : a.s.cut c = false := by
  cases e : a.s.cut c with
  | false => rfl
  | true =>
    obtain ⟨r', h1, _, h2⟩ := g.cut c e
    rw [hr] at h1; cases h1; exact absurd hdone h2

-- (a) done, a compute, not due: its last is its value, or equal to it; that value is f's from
-- scratch on the store now, or, f having given a promise, f from scratch gives that same promise
-- (the same reads) and the value is what it landed with
theorem quiescence_done {cs : Nat → Comp K V} {promise : V → Bool}
    {rank : Model.State K V → Nat → Nat} {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a)
    {c : Nat} {r : Run K V} (hk : iseffect (cs c) = false) (hr : a.s.ran c = some r)
    (hd : a.s.due c = none) (hdone : r.ended = some .done) :
    ∃ v, r.out = some (.value v) ∧ near (cs c).equal v (a.s.last c) ∧
      (eval a.s.store (cs c).f).2 = r.seen ∧
      ((a.gave c = none ∧ (eval a.s.store (cs c).f).1 = .value v) ∨
        ∃ p, a.gave c = some p ∧ promise p = true ∧ (eval a.s.store (cs c).f).1 = .value p) := by
  have g := h.good hA
  obtain ⟨o, he, h1, h2, _⟩ := quiescence hA h hr hd (Or.inl hdone) (done_uncut g hr hdone)
  obtain ⟨v, hv, hn⟩ := g.computes c r hk hr hdone
  refine ⟨v, hv, hn, by rw [he], ?_⟩
  cases hg : a.gave c with
  | none => rw [h1 hg] at hv; cases hv; exact Or.inl ⟨rfl, by rw [he]⟩
  | some p =>
    obtain ⟨h3, h4⟩ := h2 p hg
    exact Or.inr ⟨p, rfl, h4, by rw [he, h3]⟩

-- when nothing is due: every compute done holds its value from scratch on the store (as above)
theorem quiescent {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a) (hq : ∀ d, a.s.due d = none) :
    ∀ c r, iseffect (cs c) = false → a.s.ran c = some r → r.ended = some .done →
      ∃ v, r.out = some (.value v) ∧ near (cs c).equal v (a.s.last c) ∧
        (eval a.s.store (cs c).f).2 = r.seen ∧
        ((a.gave c = none ∧ (eval a.s.store (cs c).f).1 = .value v) ∨
          ∃ p, a.gave c = some p ∧ promise p = true ∧ (eval a.s.store (cs c).f).1 = .value p) :=
  fun _ _ hk hr hdone => quiescence_done hA h hk hr (hq _) hdone

-- (c) pending, not due, its loop not cut: f from scratch gives PENDING, or the same promise again;
-- the same reads. what its key holds is pending_keeps's
theorem quiescence_pending {cs : Nat → Comp K V} {promise : V → Bool}
    {rank : Model.State K V → Nat → Nat} {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a)
    {c : Nat} {r : Run K V} (hr : a.s.ran c = some r) (hd : a.s.due c = none)
    (hp : r.ended = some .pending) (hc : a.s.cut c = false) :
    (eval a.s.store (cs c).f).2 = r.seen ∧
      ((a.gave c = none ∧ (eval a.s.store (cs c).f).1 = .pending) ∨
        ∃ p, a.gave c = some p ∧ promise p = true ∧ (eval a.s.store (cs c).f).1 = .value p) := by
  have g := h.good hA
  obtain ⟨o, he, h1, h2, _⟩ := quiescence hA h hr hd (Or.inr (Or.inr hp)) hc
  refine ⟨by rw [he], ?_⟩
  cases hg : a.gave c with
  | none =>
    have := h1 hg; rw [g.pending c r hr hp] at this; cases this
    exact Or.inl ⟨rfl, by rw [he]⟩
  | some p =>
    obtain ⟨h3, h4⟩ := h2 p hg
    exact Or.inr ⟨p, rfl, h4, by rw [he, h3]⟩

-- Theorem 3 with promises

-- an act is called with its effect's value from scratch on the store at the act: f gives it, or
-- gives the same promise (the same reads) that landed with it
theorem act_fresh {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a) {e : Nat} {v : V}
    {rest : List (Nat × V)} (ha : a.s.acts = (e, v) :: rest) (hd : a.s.due e = none) :
    ∃ r, a.s.ran e = some r ∧ r.out = some (.value v) ∧ (eval a.s.store (cs e).f).2 = r.seen ∧
      ((a.gave e = none ∧ (eval a.s.store (cs e).f).1 = .value v) ∨
        ∃ p, a.gave e = some p ∧ promise p = true ∧ (eval a.s.store (cs e).f).1 = .value p) := by
  have g := h.good hA
  obtain ⟨_, r, hr, _, hdone, ho⟩ := g.acts e v (by simp [ha])
  obtain ⟨o, he, h1, h2, _⟩ := quiescence hA h hr hd (Or.inl hdone) (done_uncut g hr hdone)
  refine ⟨r, hr, ho, by rw [he], ?_⟩
  cases hg : a.gave e with
  | none => rw [h1 hg] at ho; cases ho; exact Or.inl ⟨rfl, by rw [he]⟩
  | some p =>
    obtain ⟨h3, h4⟩ := h2 p hg
    exact Or.inr ⟨p, rfl, h4, by rw [he, h3]⟩

-- the act step: it calls act with that value; and at that moment every compute done and not due
-- holds its value from scratch on the same store (C8: no act sees a landed value mixed with
-- newer inputs; only a pending, due, failed or looping compute's key can be behind)
theorem step_acts {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a a' : State K V} (hA : A2 cs) (h : Reach cs promise rank a) {e : Nat} {v : V}
    {rest : List (Nat × V)} (hph : a.s.phase = .acts) (ha : a.s.acts = (e, v) :: rest)
    (hd : a.s.due e = none) (hs : step cs promise rank a = some a') :
    a' = { a with s := act cs { a.s with acts := rest } e v } ∧
      (∃ r, a.s.ran e = some r ∧ r.out = some (.value v) ∧ (eval a.s.store (cs e).f).2 = r.seen ∧
        ((a.gave e = none ∧ (eval a.s.store (cs e).f).1 = .value v) ∨
          ∃ p, a.gave e = some p ∧ promise p = true ∧ (eval a.s.store (cs e).f).1 = .value p)) ∧
      ∀ c r, iseffect (cs c) = false → a.s.ran c = some r → a.s.due c = none →
        r.ended = some .done → ∃ w, r.out = some (.value w) ∧ near (cs c).equal w (a.s.last c) ∧
          (eval a.s.store (cs c).f).2 = r.seen ∧
          ((a.gave c = none ∧ (eval a.s.store (cs c).f).1 = .value w) ∨
            ∃ p, a.gave c = some p ∧ promise p = true ∧ (eval a.s.store (cs c).f).1 = .value p) := by
  refine ⟨?_, act_fresh hA h ha hd, fun c r hk hr hdc hdone => quiescence_done hA h hk hr hdc hdone⟩
  simp only [Async.step, hph] at hs
  obtain ⟨s', h1, h2⟩ := Option.map_eq_some_iff.1 hs
  subst h2
  simp only [Model.step, hph, ha] at h1
  cases h1; simp only [hph]

theorem mark_ran (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).ran = s.ran := by
  unfold mark Model.settle due causeof keep
  cases who <;> simp only <;> (repeat' split) <;> rfl

theorem changed_ran (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K) (who : Option Nat) :
    (changed cs s keys who).ran = s.ran := by
  simp only [changed]
  suffices h : ∀ (ks : List K) (s1 : Model.State K V) w t r,
      (ks.foldl (fun s k => tell (learn s k w) k t r) s1).ran = s1.ran by
    exact h _ _ _ _ _
  intro ks
  induction ks with
  | nil => intros; rfl
  | cons k ks ih =>
    intro s1 w t r
    simp only [List.foldl_cons]
    rw [ih]
    simp only [tell]
    suffices h2 : ∀ (ds : List Nat) (s2 : Model.State K V),
        (ds.foldl (fun s d => mark s d t r) s2).ran = s2.ran by
      rw [h2]; cases w <;> rfl
    intro ds
    induction ds with
    | nil => intros; rfl
    | cons d ds ih2 => intro s2; simp only [List.foldl_cons]; rw [ih2, mark_ran]

theorem set_ran (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (v : V) :
    (set cs s c v).ran = s.ran := by
  unfold Model.set; split
  · rw [changed_ran]; rfl
  · rfl

theorem finish_ended (X : Model.State K V) (c : Nat) (e : Ended) (eq : Option Bool) (w : Option Nat)
    (th : Option (List Nat)) (h : (X.ran c).isSome) :
    ((finish X c e eq w th).ran c).bind (·.ended) = some e := by
  obtain ⟨r, hr⟩ := Option.isSome_iff_exists.1 h
  rw [finish_eq X c r hr]; simp

-- what a pending compute's key holds: a run that ends pending, or a landing that lands pending,
-- calls no set: the store and the lasts are as they were. so its key holds the value its last set
-- gave (when nothing else writes it), while its inputs may be newer
theorem pending_keeps (cs : Nat → Comp K V) (promise : V → Bool) (a : State K V) (c rk : Nat)
    (hp : nowrites (cs c).f)
    (hend : ((run cs promise a c rk).s.ran c).bind (·.ended) = some .pending) :
    (run cs promise a c rk).s.store = a.s.store ∧ (run cs promise a c rk).s.last = a.s.last := by
  obtain ⟨s3, o, seen, vals, st, hs, -, -, -, e_ran, -, e_store, -, -, e_last, -, e_due, -, -, -, -,
    -, -, -, -, -, -, -, -, -⟩ := run_spec cs promise a c rk hp
  rw [hs] at hend ⊢
  have hr3 : s3.ran c = some (begun a.s c vals st seen) := by rw [e_ran]; simp
  have hd3 : s3.due c = none := by rw [e_due]; simp
  have keep : ∀ (t : Model.State K V) (e : Ended) (eq : Option Bool) (w : Option Nat)
      (th : Option (List Nat)), t.store = a.s.store → t.last = a.s.last → (∃ r, t.ran c = some r) →
      (finish t c e eq w th).store = a.s.store ∧ (finish t c e eq w th).last = a.s.last := by
    intro t e eq w th h1 h2 ⟨r, h3⟩
    rw [finish_eq t c r h3]; exact ⟨h1, h2⟩
  cases st with
  | some w =>
    simp only [ending, hr3, begun, Option.bind_some, Option.isSome_some, ite_true] at hend ⊢
    rw [stop_eq s3 c _ hr3 hd3] at hend
    simp at hend
  | none =>
    simp only [ending, hr3, begun, Option.bind_some, Option.isSome_none, Bool.false_eq_true,
      ite_false] at hend ⊢
    have hr4 : ∀ o', ((edit s3 c fun r => { r with out := some o' }).ran c).isSome := by
      intro o'; simp [edit, hr3]
    generalize hide promise o = o' at hend ⊢
    cases o' with
    | error =>
      exact keep (edit s3 c fun r => { r with out := some Out.error }) _ _ _ _
        (by simp [edit, e_store]) (by simp [edit, e_last]) (Option.isSome_iff_exists.1 (hr4 _))
    | pending =>
      exact keep (edit s3 c fun r => { r with out := some Out.pending }) _ _ _ _
        (by simp [edit, e_store]) (by simp [edit, e_last]) (Option.isSome_iff_exists.1 (hr4 _))
    | value v =>
      exfalso
      simp only [result] at hend
      split at hend
      · rw [finish_ended _ _ _ _ _ _ (hr4 _)] at hend; cases hend
      · split at hend
        · rw [finish_ended _ _ _ _ _ _ (hr4 _)] at hend; cases hend
        · split at hend
          · split at hend
            · rw [finish_ended _ _ _ _ _ _ (hr4 _)] at hend; cases hend
            · rw [finish_ended _ _ _ _ _ _ (by simpa using hr4 _)] at hend; cases hend
          · split at hend
            · rw [finish_ended _ _ _ _ _ _ (hr4 _)] at hend; cases hend
            · rw [finish_ended _ _ _ _ _ _ (by simpa [set_ran] using hr4 _)] at hend; cases hend

-- and a landing of PENDING: the store and the lasts as they were
theorem land_keeps (cs : Nat → Comp K V) (a : State K V) (c n : Nat) :
    (land cs a c n .pending).s.store = a.s.store ∧ (land cs a c n .pending).s.last = a.s.last := by
  unfold Async.land; split
  · simp only
    cases hr : (edit a.s c fun r => { r with out := some Out.pending }).ran c with
    | none => simp only [finish, hr]; exact ⟨rfl, rfl⟩
    | some r => rw [finish_eq _ c r hr]; exact ⟨rfl, rfl⟩
  · exact ⟨rfl, rfl⟩

theorem due_kept (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    (due s d t who).kept = s.kept := by
  unfold due; split <;> rfl

theorem settle_kept (s : Model.State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : (Model.settle s d t who l fl).kept = s.kept := by
  unfold Model.settle
  split
  · split <;> rfl
  · dsimp only
    split
    · rfl
    · rw [due_kept]

-- causes live this pulse: every computation behind a kept cause, or behind a computation's own
-- cause of this pulse, went this pulse (causes.ts ran: it ran, or its run's cause was cut, since
-- the last close)
structure Live (s : Model.State K V) : Prop where
  kept : ∀ d, ∀ x ∈ s.kept d, ∀ y ∈ behind x, s.went y.of.1 = true
  cause : ∀ c, (s.ran c).isSome → s.when c = s.pulses → ∀ y ∈ behind (s.cause c), s.went y.of.1 = true

theorem Live.of {s s' : Model.State K V} (h : Live s) (e1 : s'.when = s.when)
    (e2 : s'.pulses = s.pulses) (e3 : ∀ y, s.went y = true → s'.went y = true) (e4 : s'.cause = s.cause)
    (e5 : ∀ c, (s'.ran c).isSome → (s.ran c).isSome) (e6 : ∀ d, ∀ x ∈ s'.kept d, x ∈ s.kept d) :
    Live s' :=
  ⟨fun d x hx y hy => e3 _ (h.kept d x (e6 d x hx) y hy),
    fun c hr hc y hy => by
      rw [e1, e2] at hc; rw [e4] at hy
      exact e3 _ (h.cause c (e5 c hr) hc y hy)⟩

-- causeOf's cause is live; the state after it too
theorem causeof_live {s : Model.State K V} (h : Live s) (c : Nat) (hc : (s.ran c).isSome) :
    Live (causeof s c).1 ∧ ∀ y ∈ behind (causeof s c).2, (causeof s c).1.went y.of.1 = true := by
  unfold causeof
  split
  · rename_i hw
    exact ⟨h, h.cause c hc hw⟩
  · refine ⟨⟨fun d x hx y hy => ?_, fun d hr hd y hy => ?_⟩, fun y hy => ?_⟩
    · have := h.kept d x hx y hy
      by_cases e : y.of.1 = c
      · simp [e]
      · simp [put_ne _ _ e, this]
    · by_cases e : d = c
      · subst e; simp [behind] at hy; subst hy; simp [Cause.of]
      · simp [put_ne _ _ e] at hd hy hr
        have := h.cause d hr hd y hy
        by_cases e' : y.of.1 = c
        · simp [e']
        · simp [put_ne _ _ e', this]
    · simp [behind] at hy; subst hy; simp [Cause.of]

theorem mark_live {s : Model.State K V} (h : Live s) (d t : Nat) (who : Option Nat)
    (hw : ∀ c, who = some c → (s.ran c).isSome) : Live (mark s d t who) := by
  cases who with
  | none =>
    obtain ⟨a, b, c, e, _⟩ := settle_calm s d t none none false
    exact h.of b a.pulses (fun y hy => by simp only [mark]; rw [c]; exact hy) e
      (fun x hx => by simp only [mark] at hx; rw [a.ran] at hx; exact hx)
      (fun x y hy => by simp only [mark] at hy; rw [settle_kept] at hy; exact hy)
  | some c =>
    simp only [mark]
    obtain ⟨h1, h2⟩ := causeof_live h c (hw c rfl)
    generalize causeof s c = p at h1 h2
    obtain ⟨s1, k⟩ := p
    simp only at h1 h2 ⊢
    have hk : Live (keep s1 d k) := by
      unfold keep; split
      · exact h1
      · refine ⟨fun d' x hx y hy => ?_, fun c hr hc y hy => h1.cause c hr hc y hy⟩
        by_cases e : d' = d
        · subst e; simp at hx
          rcases hx with hx | hx
          · exact h1.kept d' x hx y hy
          · subst hx; exact h2 y hy
        · simp [put_ne _ _ e] at hx; exact h1.kept d' x hx y hy
    generalize keep s1 d k = s2 at hk
    obtain ⟨a, b, c', e, _⟩ := settle_calm s2 d t (some c) (loopof s2 k d) (((s2.ran c).bind (·.loop)).isSome)
    exact hk.of b a.pulses (fun y hy => by rw [c']; exact hy) e (fun x hx => by rw [a.ran] at hx; exact hx)
      (fun x y hy => by rw [settle_kept] at hy; exact hy)

theorem changed_live (cs : Nat → Comp K V) {s : Model.State K V} (h : Live s) (keys : List K)
    (who : Option Nat) : Live (changed cs s keys who) := by
  simp only [changed]
  suffices hh : ∀ (ks : List K) (s1 : Model.State K V) w t r, Live s1 →
      (∀ c, r = some c → (s1.ran c).isSome) →
      Live (ks.foldl (fun s k => tell (learn s k w) k t r) s1) by
    refine hh keys _ _ _ _ (h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)) ?_
    intro c hc; simp only [runof, Option.filter_eq_some_iff] at hc; exact hc.2
  intro ks
  induction ks with
  | nil => intro s1 w t r h1 _; exact h1
  | cons k ks ih =>
    intro s1 w t r h1 hr
    simp only [List.foldl_cons]
    have hl : Live (learn s1 k w) := by
      cases w <;> exact h1.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
    have hlr : (learn s1 k w).ran = s1.ran := by cases w <;> rfl
    have ht := fold_inv (fun x => Live x ∧ x.ran = s1.ran) (fun s d => mark s d t r)
      (fun b d hb => ⟨mark_live hb.1 d _ _ (fun c hc => by rw [hb.2]; exact hr c hc),
        by rw [mark_ran]; exact hb.2⟩) (readers (learn s1 k w) k) _ ⟨hl, hlr⟩
    exact ih _ w t r ht.1 (fun c hc => by simp only [tell]; rw [ht.2]; exact hr c hc)

theorem mark_went (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    ∀ y, s.went y = true → (mark s d t who).went y = true := by
  intro y hy
  cases who with
  | none => simp only [mark]; rw [(settle_calm s d t none none false).2.2.1]; exact hy
  | some c =>
    simp only [mark]
    have h1 : ∀ y, s.went y = true → (causeof s c).1.went y = true := by
      intro y hy; unfold causeof; split
      · exact hy
      · by_cases e : y = c
        · subst e; simp
        · simp [put_ne _ _ e, hy]
    generalize causeof s c = p at h1
    obtain ⟨s1, k⟩ := p
    obtain ⟨kp, hk⟩ := keep_calm s1 d k
    simp only at h1 ⊢
    rw [hk, (settle_calm _ d t _ _ _).2.2.1]
    exact h1 y hy

theorem changed_went (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K) (who : Option Nat) :
    ∀ y, s.went y = true → (changed cs s keys who).went y = true := by
  intro y hy
  simp only [changed]
  suffices hh : ∀ (ks : List K) (s1 : Model.State K V) w t r, s1.went y = true →
      (ks.foldl (fun s k => tell (learn s k w) k t r) s1).went y = true from hh _ _ _ _ _ hy
  intro ks
  induction ks with
  | nil => intro s1 w t r h1; exact h1
  | cons k ks ih =>
    intro s1 w t r h1
    simp only [List.foldl_cons]
    apply ih
    simp only [tell]
    have hl : (learn s1 k w).went y = true := by cases w <;> exact h1
    exact fold_inv (β := Model.State K V) (fun x => x.went y = true) (fun s d => mark s d t r)
      (fun b d hb => mark_went b d t r y hb) (readers (learn s1 k w) k) (learn s1 k w) hl

theorem finish_live {s : Model.State K V} (h : Live s) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) : Live (finish s c e eq w th) := by
  cases hr : s.ran c with
  | none => simp [finish, hr]; exact h
  | some r =>
    rw [finish_eq s c r hr]
    refine h.of rfl rfl (fun _ h => h) rfl (fun d hd => ?_) (fun d x hx => ?_)
    · by_cases e' : d = c
      · subst e'; simp [hr]
      · simpa [put_ne _ _ e'] using hd
    · simp only at hx
      split at hx
      · by_cases e' : d = c
        · subst e'; simp at hx; exact hx.1
        · simpa [put_ne _ _ e'] using hx
      · exact hx

theorem set_live (cs : Nat → Comp K V) {s : Model.State K V} (h : Live s) (c : Nat) (v : V) :
    Live (set cs s c v) := by
  unfold Model.set; split
  · apply changed_live; exact h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
  · exact h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)

theorem result_live (cs : Nat → Comp K V) {s : Model.State K V} (h : Live s) (c : Nat) (v : V) :
    Live (result cs s c v) := by
  unfold result
  split
  · exact finish_live h _ _ _ _ _
  · simp only
    split
    · exact finish_live h _ _ _ _ _
    · split
      · split
        · exact finish_live h _ _ _ _ _
        · apply finish_live; exact h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
      · split
        · exact finish_live h _ _ _ _ _
        · apply finish_live
          exact (set_live cs h c v).of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)

theorem edit_live {s : Model.State K V} (h : Live s) (c : Nat) (g : Run K V → Run K V) :
    Live (edit s c g) :=
  h.of rfl rfl (fun _ h => h) rfl (fun d hd => by
    by_cases e : d = c
    · subst e; simpa [edit] using hd
    · simpa [edit, put_ne _ _ e] using hd) (fun _ _ h => h)

theorem ending_live (cs : Nat → Comp K V) {s : Model.State K V} (h : Live s) (c : Nat) (o : Out V) :
    Live (ending cs s c o) := by
  unfold ending
  split
  · unfold stop; split
    · exact h
    · apply finish_live
      split <;> exact h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
  · simp only
    split
    · exact finish_live (edit_live h _ _) _ _ _ _ _
    · exact finish_live (edit_live h _ _) _ _ _ _ _
    · exact result_live cs (edit_live h _ _) _ _

theorem mark_pulses (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).pulses = s.pulses := by
  unfold mark Model.settle due causeof keep
  cases who <;> simp only <;> (repeat' split) <;> rfl

theorem changed_pulses (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K) (who : Option Nat) :
    (changed cs s keys who).pulses = s.pulses := by
  simp only [changed]
  suffices h : ∀ (ks : List K) (s1 : Model.State K V) w t r,
      (ks.foldl (fun s k => tell (learn s k w) k t r) s1).pulses = s1.pulses by
    exact h _ _ _ _ _
  intro ks
  induction ks with
  | nil => intros; rfl
  | cons k ks ih =>
    intro s1 w t r
    simp only [List.foldl_cons]
    rw [ih]
    simp only [tell]
    rw [fold_inv (β := Model.State K V) (fun x => x.pulses = (learn s1 k w).pulses) (fun s d => mark s d t r)
      (fun b d hb => by rw [mark_pulses]; exact hb) _ _ rfl]
    cases w <;> rfl

-- a run keeps causes live (A2): its cause is of this run and the causes kept on it
theorem run_live (cs : Nat → Comp K V) (promise : V → Bool) {a : State K V} (h : Live a.s)
    (c rk : Nat) (hp : nowrites (cs c).f) : Live (run cs promise a c rk).s := by
  obtain ⟨s3, o, seen, vals, st, hs, -, -, -, e_ran, -, -, -, -, -, -, -, -, -, -, -, e_when, e_went,
    e_pulses, -, e_cause, e_kept, -, -, -⟩ := run_spec cs promise a c rk hp
  rw [hs]
  apply ending_live
  have hw : ∀ y, a.s.went y = true → s3.went y = true := by
    intro y hy; rw [e_went]; by_cases e : y = c
    · subst e; simp
    · simp [put_ne _ _ e, hy]
  refine ⟨fun d x hx y hy => ?_, fun d hr hd y hy => ?_⟩
  · rw [e_kept] at hx; exact hw _ (h.kept d x hx y hy)
  · rw [e_when, e_pulses] at hd
    rw [e_cause] at hy
    by_cases e : d = c
    · subst e
      simp only [put_same] at hy
      simp only [behind, List.mem_cons, List.mem_flatten, List.mem_map, List.mem_attach, true_and,
        Subtype.exists] at hy
      rcases hy with rfl | ⟨l, ⟨x, hx, rfl⟩, hy⟩
      · rw [e_went]; simp [Cause.of]
      · exact hw _ (h.kept d x hx y hy)
    · rw [put_ne _ _ e] at hd hy
      rw [e_ran, put_ne _ _ e] at hr
      exact hw _ (h.cause d hr hd y hy)

theorem land_live (cs : Nat → Comp K V) {a : State K V} (h : Live a.s) (c n : Nat) (o : Out V) :
    Live (land cs a c n o).s := by
  unfold Async.land; split
  · simp only; split
    · exact finish_live (edit_live h _ _) _ _ _ _ _
    · exact finish_live (edit_live h _ _) _ _ _ _ _
    · exact result_live cs (edit_live h _ _) _ _
  · exact h

theorem act_live (cs : Nat → Comp K V) {s : Model.State K V} (h : Live s) (e : Nat) (v : V) :
    Live (act cs s e v) := by
  unfold act
  split
  · exact h
  · split
    · exact h
    · simp only [say]
      have hf : ∀ (ws : List (K × V)) (s1 : Model.State K V), Live s1 →
          Live (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1) := by
        intro ws
        induction ws with
        | nil => intro s1 h1; exact h1
        | cons kv ws ih =>
          intro s1 h1; simp only [List.foldl_cons]
          apply ih; apply changed_live
          exact h1.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
      exact (hf _ _ (h.of (s' := say s (.act e v (s.last e))) rfl rfl (fun _ h => h) rfl (fun _ h => h)
        (fun _ _ h => h))).of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)

theorem step_live (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    {a a' : State K V} (hA : A2 cs) (h : Live a.s) (hs : step cs promise rank a = some a') :
    Live a'.s := by
  unfold Async.step at hs
  split at hs
  · rename_i c n o rest _ _
    cases hs; exact land_live cs (a := { a with landed := rest }) h _ _ _
  · split at hs
    · cases hs; exact run_live cs promise h _ _ (hA _)
    · cases hs; exact h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
  · rename_i hph
    obtain ⟨s', h1, h2⟩ := Option.map_eq_some_iff.1 hs
    subst h2
    unfold Model.step at h1
    split at h1
    · rename_i h'; rw [hph] at h'; cases h'
    · split at h1
      · rename_i x rest _
        cases h1
        exact act_live cs (s := { a.s with acts := rest })
          (h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)) _ _
      · split at h1
        · cases h1; exact h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
        · cases h1

theorem named_live (cs : Nat → Comp K V) {a : State K V} (h : Live a.s) (i : Nat)
    (kvs : List (K × V)) : Live (named cs a i kvs).s := by
  unfold Async.named
  split
  · exact h
  · rename_i c r _
    obtain ⟨st, h1, -⟩ := stores_shape a.s kvs
    simp only [h1]
    have hs : Live { a.s with store := st } := h.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
    split
    · exact changed_live cs hs _ _
    · have h1' : Live { a.s with store := st, ran := put a.s.ran c (some r), when := put a.s.when c (a.s.pulses + 1) } := by
        refine ⟨fun d x hx y hy => h.kept d x hx y hy, fun d hr hd y hy => ?_⟩
        by_cases e : d = c
        · subst e; simp at hd
        · simp [put_ne _ _ e] at hr hd hy
          exact h.cause d hr hd y hy
      have h2 := changed_live cs h1' (kvs.map (·.1)) (some c)
      have hw := changed_went cs { a.s with store := st, ran := put a.s.ran c (some r), when := put a.s.when c (a.s.pulses + 1) } (kvs.map (·.1)) (some c)
      have hr := changed_ran cs { a.s with store := st, ran := put a.s.ran c (some r), when := put a.s.when c (a.s.pulses + 1) } (kvs.map (·.1)) (some c)
      have hq := changed_pulses cs { a.s with store := st, ran := put a.s.ran c (some r), when := put a.s.when c (a.s.pulses + 1) } (kvs.map (·.1)) (some c)
      generalize changed cs { a.s with store := st, ran := put a.s.ran c (some r), when := put a.s.when c (a.s.pulses + 1) } (kvs.map (·.1)) (some c) = s2 at h2 hw hr hq
      refine ⟨fun d x hx y hy => h2.kept d x hx y hy, fun d hrd hd y hy => ?_⟩
      simp only at hrd hd hy
      simp only at hq
      by_cases e : d = c
      · subst e
        simp only [put_same] at hd hy
        rw [hq] at hd
        exact hw _ (h.cause d hrd hd y hy)
      · rw [put_ne _ _ e] at hd hy
        exact h2.cause d (by rw [hr]; simpa [put_ne _ _ e] using hrd) hd y hy

theorem Reach.live {cs : Nat → Comp K V} {promise : V → Bool} {rank : Model.State K V → Nat → Nat}
    {a : State K V} (hA : A2 cs) (h : Reach cs promise rank a) : Live a.s := by
  induction h with
  | empty => exact ⟨fun d x hx => by simp [Async.empty, Model.empty] at hx,
      fun c hr => by simp [Async.empty, Model.empty] at hr⟩
  | make _ ih =>
    simp only [Async.make, Model.make]
    apply mark_live _ _ _ _ (by simp)
    split <;> exact ih.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
  | write kvs _ ih =>
    simp only [Async.write, Model.write]
    apply changed_live
    obtain ⟨st, h1, _⟩ := stores_shape _ kvs
    rw [h1]; exact ih.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
  | tell keys _ ih => exact changed_live cs ih _ _
  | begin _ ih => exact ih.of rfl rfl (fun _ h => h) rfl (fun _ h => h) (fun _ _ h => h)
  | step _ _ h ih => exact step_live cs _ _ hA ih h
  | @close a ha _ ih =>
    have g := ha.good hA
    refine ⟨fun d x hx => by simp [Model.close] at hx, fun c _ hc => ?_⟩
    have := g.when_le c; simp [Model.close] at hc; omega
  | settle i o _ _ ih =>
    unfold Async.settle; split
    · exact ih
    · exact ih
  | named i kvs _ _ _ ih => exact named_live cs ih i kvs

-- Theorem 7 with promises (F7): a cause never reaches past its pulse. a mark by c's run, its cause
-- k from causeOf: if it finds a loop through d (flagged, or cut), d and every computation on the
-- loop went this pulse: each ran, or named a change (its run's cause cut), since the last close
theorem loop_went {s : Model.State K V} (h : Live s) {c : Nat} (hc : (s.ran c).isSome) (d : Nat)
    {l : List Nat} (hl : loopof (keep (causeof s c).1 d (causeof s c).2) (causeof s c).2 d = some l) :
    (keep (causeof s c).1 d (causeof s c).2).went d = true ∧ ∀ x ∈ l, (causeof s c).1.went x = true ∧
      ∃ y ∈ behind (causeof s c).2, y.of.1 = x ∧ on d y = true := by
  obtain ⟨_, h2⟩ := causeof_live h c hc
  obtain ⟨kp, hk⟩ := keep_calm (causeof s c).1 d (causeof s c).2
  rw [hk] at hl ⊢
  simp only [loopof] at hl
  split at hl
  · rename_i hw
    simp only [Bool.and_eq_true] at hw
    cases hl
    refine ⟨hw.1, fun x hx => ?_⟩
    simp only [through, List.mem_filter, List.mem_range, List.any_eq_true, Bool.and_eq_true,
      beq_iff_eq] at hx
    obtain ⟨_, y, hy, hyx, hyd⟩ := hx
    exact ⟨hyx ▸ h2 y hy, y, hy, hyx, hyd⟩
  · cases hl

-- what sets went: a change sets it only for the computation it names
theorem mark_went_only (s : Model.State K V) (d t : Nat) (who : Option Nat) (x : Nat)
    (hx : (mark s d t who).went x = true) : s.went x = true ∨ who = some x := by
  cases who with
  | none => simp only [mark] at hx; rw [(settle_calm s d t none none false).2.2.1] at hx; exact Or.inl hx
  | some c =>
    simp only [mark] at hx
    have h1 : (causeof s c).1.went x = true → s.went x = true ∨ c = x := by
      intro h; unfold causeof at h; split at h
      · exact Or.inl h
      · by_cases e : x = c
        · exact Or.inr e.symm
        · simp [put_ne _ _ e] at h; exact Or.inl h
    generalize causeof s c = p at h1 hx
    obtain ⟨s1, k⟩ := p
    obtain ⟨kp, hk⟩ := keep_calm s1 d k
    simp only at h1 hx
    rw [hk, (settle_calm _ d t _ _ _).2.2.1] at hx
    rcases h1 hx with h | h
    · exact Or.inl h
    · exact Or.inr (by rw [h])

theorem changed_went_only (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K)
    (who : Option Nat) (x : Nat) (hx : (changed cs s keys who).went x = true) :
    s.went x = true ∨ who = some x := by
  simp only [changed] at hx
  suffices hh : ∀ (ks : List K) (s1 : Model.State K V) w t r, (∀ c, r = some c → who = some c) →
      (ks.foldl (fun s k => tell (learn s k w) k t r) s1).went x = true →
      s1.went x = true ∨ who = some x by
    refine hh _ { s with tick := s.tick + 1 } _ _ _ ?_ hx
    intro c hc; simp only [runof, Option.filter_eq_some_iff] at hc; exact hc.1
  intro ks
  induction ks with
  | nil => intro s1 w t r _ h; exact Or.inl h
  | cons k ks ih =>
    intro s1 w t r hr h
    simp only [List.foldl_cons] at h
    rcases ih _ w t r hr h with h | h
    · simp only [tell] at h
      have := fold_inv (β := Model.State K V)
        (fun y => y.went x = true → (learn s1 k w).went x = true ∨ who = some x)
        (fun s d => mark s d t r)
        (fun b d hb hm => by
          rcases mark_went_only b d t _ x hm with h | h
          · exact hb h
          · exact Or.inr (hr x h)) (readers (learn s1 k w) k) (learn s1 k w) Or.inl h
      rcases this with h | h
      · exact Or.inl (by cases w <;> exact h)
      · exact Or.inr h
    · exact Or.inr h

theorem finish_went (s : Model.State K V) (c : Nat) (e : Ended) (eq : Option Bool) (w : Option Nat)
    (th : Option (List Nat)) : (finish s c e eq w th).went = s.went := by
  cases hr : s.ran c with
  | none => simp [finish, hr]
  | some r => rw [finish_eq s c r hr]

theorem set_went_only (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (v : V) (x : Nat)
    (hx : (set cs s c v).went x = true) : s.went x = true ∨ c = x := by
  unfold Model.set at hx; split at hx
  · rcases changed_went_only cs _ _ _ x hx with h | h
    · exact Or.inl h
    · cases h; exact Or.inr rfl
  · exact Or.inl hx

theorem result_went_only (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (v : V) (x : Nat)
    (hx : (result cs s c v).went x = true) : s.went x = true ∨ c = x := by
  unfold result at hx
  split at hx
  · rw [finish_went] at hx; exact Or.inl hx
  · simp only at hx
    split at hx
    · rw [finish_went] at hx; exact Or.inl hx
    · split at hx
      · rw [finish_went] at hx; left; split at hx <;> exact hx
      · split at hx
        · rw [finish_went] at hx; exact Or.inl hx
        · rw [finish_went] at hx
          exact set_went_only cs _ c _ x (by simpa using hx)

theorem ending_went_only (cs : Nat → Comp K V) (s : Model.State K V) (c : Nat) (o : Out V) (x : Nat)
    (hx : (ending cs s c o).went x = true) : s.went x = true ∨ c = x := by
  unfold ending at hx
  split at hx
  · unfold stop at hx; split at hx
    · exact Or.inl hx
    · rw [finish_went] at hx; left; split at hx <;> exact hx
  · simp only at hx
    split at hx
    · rw [finish_went] at hx; exact Or.inl hx
    · rw [finish_went] at hx; exact Or.inl hx
    · exact (result_went_only cs _ c _ x hx).imp_left (fun h => by simpa [edit] using h)

theorem act_went_only (cs : Nat → Comp K V) (s : Model.State K V) (e : Nat) (v : V) (x : Nat)
    (hx : (act cs s e v).went x = true) : s.went x = true ∨ e = x := by
  unfold act at hx
  split at hx
  · exact Or.inl hx
  · split at hx
    · exact Or.inl hx
    · simp only [say] at hx
      have hf : ∀ (ws : List (K × V)) (s1 : Model.State K V),
          (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1).went x = true →
          s1.went x = true ∨ e = x := by
        intro ws
        induction ws with
        | nil => intro s1 h; exact Or.inl h
        | cons kv ws ih =>
          intro s1 h; simp only [List.foldl_cons] at h
          rcases ih _ h with h | h
          · rcases changed_went_only cs _ _ _ x h with h | h
            · exact Or.inl h
            · cases h; exact Or.inr rfl
          · exact Or.inr h
      exact hf _ (say s (.act e v (s.last e))) hx

-- a step sets went only for the computation it lands, runs or acts
theorem step_went (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    {a a' : State K V} (hA : A2 cs) (hs : step cs promise rank a = some a') (x : Nat)
    (hx : a'.s.went x = true) :
    a.s.went x = true ∨ (∃ n o rest, a.landed = (x, n, o) :: rest) ∨ next rank a.s = some x ∨
      ∃ v rest, a.s.acts = (x, v) :: rest := by
  unfold Async.step at hs
  split at hs
  · rename_i c n o rest _ hl
    cases hs
    unfold Async.land at hx; split at hx
    · simp only at hx
      have : a.s.went x = true ∨ c = x := by
        split at hx
        · rw [finish_went] at hx; exact Or.inl hx
        · rw [finish_went] at hx; exact Or.inl hx
        · exact (result_went_only cs _ c _ x hx).imp_left (fun h => by simpa [edit] using h)
      rcases this with h | h
      · exact Or.inl h
      · subst h; exact Or.inr (Or.inl ⟨n, o, rest, hl⟩)
    · exact Or.inl hx
  · split at hs
    · rename_i c hc
      cases hs
      obtain ⟨s3, o, seen, vals, st, hs3, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, -, e_went,
        -, -, -, -, -, -, -⟩ := run_spec cs promise a c (rank a.s c) (hA c)
      rw [hs3] at hx
      rcases ending_went_only cs s3 c _ x hx with h | h
      · rw [e_went] at h
        by_cases e : x = c
        · subst e; exact Or.inr (Or.inr (Or.inl hc))
        · simp [put_ne _ _ e] at h; exact Or.inl h
      · subst h; exact Or.inr (Or.inr (Or.inl hc))
    · cases hs; exact Or.inl hx
  · rename_i hph
    obtain ⟨s', h1, h2⟩ := Option.map_eq_some_iff.1 hs
    subst h2
    unfold Model.step at h1
    split at h1
    · rename_i h'; rw [hph] at h'; cases h'
    · split at h1
      · rename_i y rest hy
        cases h1
        rcases act_went_only cs _ _ _ x hx with h | h
        · exact Or.inl h
        · subst h; exact Or.inr (Or.inr (Or.inr ⟨y.2, rest, hy⟩))
      · split at h1
        · cases h1; exact Or.inl hx
        · cases h1

-- between pulses: a promise settling sets no went; a change named by a handle, only its
-- computation's; the host's changes, none
theorem named_went (cs : Nat → Comp K V) (a : State K V) (i : Nat) (kvs : List (K × V)) (x : Nat)
    (hx : (named cs a i kvs).s.went x = true) :
    a.s.went x = true ∨ ∃ r, a.awaiting[i]? = some (x, r) := by
  unfold Async.named at hx
  split at hx
  · exact Or.inl hx
  · rename_i c r hi
    obtain ⟨st, h1, -⟩ := stores_shape a.s kvs
    simp only [h1] at hx
    split at hx
    · rcases changed_went_only cs _ _ _ x hx with h | h
      · exact Or.inl h
      · cases h; exact Or.inr ⟨r, hi⟩
    · rcases changed_went_only cs _ _ _ x hx with h | h
      · exact Or.inl h
      · cases h; exact Or.inr ⟨r, hi⟩

theorem tell_went (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K) :
    (changed cs s keys none).went = s.went := by
  funext x
  cases e : s.went x with
  | true => exact changed_went cs s keys none x e
  | false =>
    cases e' : (changed cs s keys none).went x with
    | false => rfl
    | true => rcases changed_went_only cs s keys none x e' with h | h
              · rw [e] at h; cases h
              · cases h

-- termination with landings

-- f with each promise it gives read as PENDING: what ending sees
def hidep (promise : V → Bool) : Prog K V → Prog K V
  | .value v => if promise v then .pending else .value v
  | .error => .error
  | .pending => .pending
  | .read k next => .read k fun x => hidep promise (next x)
  | .write k v next => .write k v (hidep promise next)

-- the computations with promises read as PENDING: the same pulse without async
def erase (cs : Nat → Comp K V) (promise : V → Bool) : Nat → Comp K V :=
  fun c => { cs c with f := hidep promise (cs c).f }

theorem changed_erase (cs : Nat → Comp K V) (promise : V → Bool) :
    changed (erase cs promise) = (changed cs : Model.State K V → List K → Option Nat → Model.State K V) := rfl

theorem exec_erase (cs : Nat → Comp K V) (promise : V → Bool) (c : Nat) :
    ∀ (p : Prog K V) (s : Model.State K V),
      exec (erase cs promise) c s (hidep promise p) = ((exec cs c s p).1, hide promise (exec cs c s p).2)
  | .value v, s => by
    simp only [hidep, exec]; split <;> simp [exec, hide, *]
  | .error, s => by simp [hidep, exec, hide]
  | .pending, s => by simp [hidep, exec, hide]
  | .read k next, s => by
    simp only [hidep, exec]
    split
    · exact exec_erase cs promise c _ _
    · split
      · exact exec_erase cs promise c _ _
      · split
        · simp [hide]
        · exact exec_erase cs promise c _ _
  | .write k v next, s => by
    simp only [hidep, exec]
    rw [changed_erase]
    exact exec_erase cs promise c _ _

theorem ending_erase (cs : Nat → Comp K V) (promise : V → Bool) (s : Model.State K V) (c : Nat)
    (o : Out V) : ending (erase cs promise) s c o = ending cs s c o := rfl

theorem act_erase (cs : Nat → Comp K V) (promise : V → Bool) (s : Model.State K V) (e : Nat) (v : V) :
    act (erase cs promise) s e v = act cs s e v := rfl

-- a run is Model's run of the erased computation
theorem run_erase (cs : Nat → Comp K V) (promise : V → Bool) (a : State K V) (c rk : Nat) :
    (run cs promise a c rk).s = first (erase cs promise) a.s c rk := by
  simp only [run, first]
  rw [show (erase cs promise c).f = hidep promise (cs c).f from rfl, exec_erase]
  rfl

theorem mark_phase (s : Model.State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).phase = s.phase := by
  unfold mark Model.settle due causeof keep
  cases who <;> simp only <;> (repeat' split) <;> rfl

theorem changed_phase (cs : Nat → Comp K V) (s : Model.State K V) (keys : List K) (who : Option Nat) :
    (changed cs s keys who).phase = s.phase := by
  simp only [changed]
  suffices h : ∀ (ks : List K) (s1 : Model.State K V) w t r,
      (ks.foldl (fun s k => tell (learn s k w) k t r) s1).phase = s1.phase by
    exact h _ _ _ _ _
  intro ks
  induction ks with
  | nil => intros; rfl
  | cons k ks ih =>
    intro s1 w t r
    simp only [List.foldl_cons]
    rw [ih]
    simp only [tell]
    rw [fold_inv (β := Model.State K V) (fun x => x.phase = (learn s1 k w).phase) (fun s d => mark s d t r)
      (fun b d hb => by rw [mark_phase]; exact hb) _ _ rfl]
    cases w <;> rfl

theorem finish_phase (s : Model.State K V) (c : Nat) (e : Ended) (eq : Option Bool) (w : Option Nat)
    (th : Option (List Nat)) : (finish s c e eq w th).phase = s.phase := by
  cases hr : s.ran c with
  | none => simp [finish, hr]
  | some r => rw [finish_eq s c r hr]

theorem land_phase (cs : Nat → Comp K V) (a : State K V) (c n : Nat) (o : Out V) :
    (land cs a c n o).s.phase = a.s.phase := by
  unfold Async.land; split
  · simp only; split
    · rw [finish_phase]; rfl
    · rw [finish_phase]; rfl
    · unfold result
      split
      · rw [finish_phase]; rfl
      · simp only
        split
        · rw [finish_phase]; rfl
        · split
          · rw [finish_phase]; split <;> rfl
          · split
            · rw [finish_phase]; rfl
            · rw [finish_phase]; simp only; unfold Model.set; split
              · rw [changed_phase]; rfl
              · rfl
  · rfl

-- with nothing landed, a step is Model's step of the erased computations
theorem step_sync (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    (a : State K V) (h : a.landed = []) :
    (step cs promise rank a).map (·.s) = Model.step (erase cs promise) rank a.s ∧
      ∀ a', step cs promise rank a = some a' → a'.landed = [] := by
  unfold Async.step Model.step
  rw [h]
  cases hph : a.s.phase with
  | runs =>
    simp only
    cases hn : next rank a.s with
    | some c =>
      refine ⟨by simp [run_erase], fun a' h' => ?_⟩
      cases h'; simp [run, h]
    | none => exact ⟨rfl, fun a' h' => by cases h'; rfl⟩
  | acts =>
    simp only
    refine ⟨?_, fun a' h' => ?_⟩
    · simp only [Option.map_map]
      split
      · rfl
      · split <;> rfl
    · obtain ⟨_, _, h2⟩ := Option.map_eq_some_iff.1 h'
      subst h2; rfl

theorem steps_sync (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat) :
    ∀ (f : Nat) (a : State K V), a.landed = [] →
      (steps cs promise rank f a).map (·.s) = Model.steps (erase cs promise) rank f a.s
  | 0, _, _ => rfl
  | f + 1, a, h => by
    obtain ⟨h1, h2⟩ := step_sync cs promise rank a h
    simp only [steps, Model.steps]
    cases e : step cs promise rank a with
    | none =>
      rw [e] at h1; simp only [Option.map_none] at h1
      rw [← h1]; rfl
    | some a' =>
      rw [e] at h1; simp only [Option.map_some] at h1
      rw [← h1]
      exact steps_sync cs promise rank f a' (h2 a' e)

-- a pulse's landings, each in turn: at most fuel of them
def lands (cs : Nat → Comp K V) : Nat → State K V → State K V
  | 0, a => a
  | k + 1, a => match a.landed with
    | [] => a
    | (c, n, o) :: rest => lands cs k (land cs { a with landed := rest } c n o)

theorem steps_lands (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat) :
    ∀ (k f : Nat) (a : State K V), a.s.phase = .runs → a.landed.length = k →
      steps cs promise rank (k + f) a = steps cs promise rank f (lands cs k a) ∧
        (lands cs k a).landed = []
  | 0, f, a, _, hk => ⟨by simp [lands], by simpa [lands] using List.length_eq_zero_iff.1 hk⟩
  | k + 1, f, a, hp, hk => by
    cases hl : a.landed with
    | nil => rw [hl] at hk; cases hk
    | cons x rest =>
      obtain ⟨c, n, o⟩ := x
      rw [hl] at hk
      have e : k + 1 + f = (k + f) + 1 := by omega
      rw [e]
      simp only [steps, lands, hl]
      have hs : step cs promise rank a = some (land cs { a with landed := rest } c n o) := by
        simp [Async.step, hp, hl]
      rw [hs]
      exact steps_lands cs promise rank k f _ (by rw [land_phase]; exact hp)
        (by simp only [List.length_cons, Nat.add_right_cancel_iff] at hk; unfold Async.land; split <;> exact hk)

-- termination with landings: a pulse is its landings, one step each at its start, then the pulse
-- of the same computations with each promise read as PENDING (Model's, from the state they leave):
-- it ends whenever that one does, within the landings' count more steps
theorem pulse_sync (cs : Nat → Comp K V) (promise : V → Bool) (rank : Model.State K V → Nat → Nat)
    (a : State K V) (f : Nat) :
    (pulse cs promise rank (a.landed.length + f) a).map (·.s) =
      Model.steps (erase cs promise) rank f
        (lands cs a.landed.length { a with s := Model.begin a.s }).s := by
  obtain ⟨h1, h2⟩ := steps_lands cs promise rank a.landed.length f { a with s := Model.begin a.s }
    (by simp [Model.begin]) rfl
  simp only [pulse]
  rw [h1]
  exact steps_sync cs promise rank f _ h2

end Model.Async

-- fidelity: the async scenarios (core/scheduler/conformance/scheduler 15, 36, 37, 39, 40)
namespace Model.Async.Check

open Model Model.Async

-- the harness's values, with strings and promises (named by a value)
inductive J where
  | null | num (n : Int) | str (s : String) | pair (a b : J) | prom (p : J)
  deriving DecidableEq, Repr

def J.int : Option J → Int
  | some (.num n) => n
  | _ => 0

def promise : J → Bool
  | .prom _ => true
  | _ => false

def rk (s : Model.State String J) : Nat → Nat := Model.Check.ranks s.made (edges s)
def jeq : J → J → Option Bool := fun a b => some (a == b)
def cmp (f : Prog String J) (to : String) : Comp String J :=
  { kind := .compute (some to), f, equal := jeq }
def eff (f : Prog String J) : Comp String J :=
  { kind := .effect fun _ _ => [], f, equal := jeq }
def go (cs : Nat → Comp String J) (a : Async.State String J) : Async.State String J :=
  (pulse cs promise rk 1000 a).getD a
def makes (cs : Nat → Comp String J) (n : Nat) (a : Async.State String J) : Async.State String J :=
  (List.range n).foldl (fun a _ => make cs a) a
def acted (a : Async.State String J) : List (Event J) :=
  ((observations a.s).filter fun e => match e.event with | .act .. => true | _ => false).map (·.event)

-- 15-async: pending until it settles; the result lands at the next pulse
def s15 : Nat → Comp String J
  | 0 => cmp (.value (.prom (.str "p"))) "c"
  | _ => eff (.read "c" fun x => .value (x.getD .null))
def a15 := go s15 (makes s15 2 empty)
def b15 := go s15 (settle a15 0 (.value (.num 5)))
#guard moments a15.s 0 == [.due 0 1 none, .due 1 2 none, .starts 0 1 0,
  .ends 0 1 .pending none none none, .starts 1 1 0, .ends 1 1 .done (some false) none none,
  .acts 1 1]
#guard a15.s.store "c" == none
#guard (settle a15 0 (.value (.num 5))).s.log == a15.s.log
#guard moments b15.s 1 == [.due 1 3 (some 0), .ends 0 1 .done (some false) none none,
  .starts 1 2 0, .ends 1 2 .done (some false) none none, .acts 1 2]
#guard acted b15 == [.act 1 .null none, .act 1 (.num 5) (some .null)]
#guard b15.s.store "c" == some (.num 5)

-- 36-async-due: settled while its compute is due again: lands nowhere; the next run's does (C8)
def s36 : Nat → Comp String J
  | 0 => cmp (.read "x" fun x => .value (.prom (x.getD .null))) "c"
  | _ => eff (.read "c" fun c => .read "x" fun x => .value (.pair (c.getD .null) (x.getD .null)))
def a36 := go s36 (makes s36 2 (write s36 empty [("x", .str "p1")]))
def b36 := go s36 (write s36 (settle a36 0 (.value (.num 10))) [("x", .str "p2")])
def c36 := go s36 (settle b36 0 (.value (.num 20)))
#guard acted a36 == [.act 1 (.pair .null (.str "p1")) none]
#guard b36.s.store "c" == none
#guard acted b36 == acted a36 ++ [.act 1 (.pair .null (.str "p2")) (some (.pair .null (.str "p1")))]
#guard !(moments b36.s 1).contains (.ends 0 1 .done (some false) none none)
#guard c36.s.store "c" == some (.num 20)
#guard acted c36 == acted b36 ++
  [.act 1 (.pair (.num 20) (.str "p2")) (some (.pair .null (.str "p2")))]

-- 37-async-cause: a pending run's cause ends with its pulse: no false loop, no change lost
def s37 : Nat → Comp String J
  | 0 => cmp (.read "c" fun _ => .value (.prom (.str "pa"))) "a"
  | 1 => cmp (.read "x" fun x => .read "flag" fun f =>
      if f = some (.num 1) then .read "e" fun e => .value (.num (J.int x + J.int e))
      else .value (.num (J.int x))) "c"
  | _ => cmp (.read "a" fun a => .value (a.getD .null)) "e"
def a37 := go s37 (makes s37 3 (write s37 empty [("x", .num 1), ("flag", .num 0)]))
-- "pa" names run 2's promise: the harness's map holds the latest
def b37 := go s37 (write s37 (settle a37 1 (.value (.num 20))) [("x", .num 2), ("flag", .num 1)])
#guard moments a37.s 0 == [.due 0 2 none, .due 1 3 none, .due 2 4 none, .starts 0 1 0,
  .ends 0 1 .pending none none none, .starts 1 1 0, .due 0 5 (some 1),
  .ends 1 1 .done (some false) none none, .starts 2 1 0, .ends 2 1 .done (some false) none none,
  .starts 0 2 0, .ends 0 2 .pending none none none]
#guard a37.s.store "c" == some (.num 1)
#guard moments b37.s 1 == [.due 1 7 none, .due 2 8 (some 0), .ends 0 2 .done (some false) none none,
  .starts 1 2 0, .ends 1 2 .stopped none (some 2) none, .starts 2 2 0,
  .ends 2 2 .done (some false) none none, .starts 1 3 0, .due 0 10 (some 1),
  .ends 1 3 .done (some false) none none, .starts 0 3 0, .ends 0 3 .pending none none none]
#guard (b37.s.store "e", b37.s.store "c") == (some (.num 20), some (.num 22))

-- 39-by-after-await: changed by a run's own read after an await: the writer learned, and its own
-- change a loop through it (named, then settled: the continuation)
def s39 : Nat → Comp String J
  | 0 => cmp (.read "k" fun k => .value (k.getD .null)) "b"
  | _ => cmp (.read "k" fun _ => .value (.prom (.str "p"))) "a"
def a39 := go s39 (makes s39 2 empty)
def b39 := named s39 a39 0 [("k", .num 1)]
def c39 := go s39 (settle b39 0 (.value (.num 1)))
def d39 := named s39 c39 0 [("k", .num 1)]
def e39 := go s39 (settle d39 0 (.value (.num 1)))
#guard (moments b39.s 1).drop (moments a39.s 1).length == [.due 0 4 (some 1), .due 1 4 (some 1)]
#guard moments c39.s 1 == [.due 0 4 (some 1), .due 1 4 (some 1), .starts 0 2 0,
  .ends 0 2 .stopped none (some 1) none, .starts 1 2 0, .ends 1 2 .pending none none none,
  .starts 0 3 1, .ends 0 3 .done (some false) none none]
#guard moments e39.s 2 == [.due 0 6 (some 1), .ends 1 2 .looping (some false) none (some [1]),
  .starts 0 4 1, .ends 0 4 .done (some true) none none]
#guard e39.s.store "a" == none
#guard moments (go s39 e39).s 3 == []

-- 40-pending-thrown: PENDING thrown ends pending, the last kept, no act; a promise rejected with
-- it lands pending
def f40 : Prog String J :=
  .read "x" fun x => if x = some (.num 0) then .pending else .read "x" fun y => .value (y.getD .null)
def s40 : Nat → Comp String J
  | 0 => cmp f40 "c"
  | 1 => eff f40
  | _ => cmp (.value (.prom (.str "pa"))) "a"
def a40 := go s40 (makes s40 2 (write s40 empty [("x", .num 1)]))
def b40 := go s40 (write s40 a40 [("x", .num 0)])
def c40 := go s40 (write s40 b40 [("x", .num 1)])
def d40 := go s40 (make s40 c40)
def e40 := go s40 (settle d40 0 .pending)
#guard a40.s.store "c" == some (.num 1) && acted a40 == [.act 1 (.num 1) none]
#guard moments b40.s 1 == [.due 0 5 none, .due 1 5 none, .starts 0 2 0,
  .ends 0 2 .pending none none none, .starts 1 2 0, .ends 1 2 .pending none none none]
#guard b40.s.store "c" == some (.num 1) && acted b40 == acted a40
#guard moments c40.s 2 == [.due 0 6 none, .due 1 6 none, .starts 0 3 0,
  .ends 0 3 .done (some true) none none, .starts 1 3 0, .ends 1 3 .done (some true) none none]
#guard acted c40 == acted a40
#guard moments e40.s 4 == [.ends 2 1 .pending none none none]
#guard e40.s.store "a" == none

-- a change after an await named by an older run's own read, that run flagged (not tame): its loop
-- mark on c is cut, though c's latest run (done) read the key. c is not due, and its last is not
-- its value now: Theorem 2 fails. the TS does the same (harness: f = if m = 1 then k + 1 else if c
-- = null then 1 else wait(p, write(k, 5)); pulse; write m := 1; pulse; resolve p; pulse: no moment,
-- c holds 1, k is 5)
def stale : Nat → Comp String J
  | _ => cmp (.read "m" fun m => if m = some (.num 1) then .read "k" fun k => .value (.num (J.int k + 1))
      else .read "c" fun c => if c = none then .value (.num 1) else .value (.prom (.str "p"))) "c"
def g1 := go stale (make stale empty)
def g2 := go stale (write stale g1 [("m", .num 1)])
def g3 := go stale (settle (named stale g2 0 [("k", .num 5)]) 0 (.value .null))
#guard moments g1.s 0 == [.due 0 1 none, .starts 0 1 0, .due 0 2 (some 0),
  .ends 0 1 .done (some false) none none, .starts 0 2 0, .ends 0 2 .pending none none none]
#guard moments g2.s 1 == [.due 0 3 none, .starts 0 3 0, .ends 0 3 .done (some true) none none]
-- not tame: the handle's run is not the latest, and flagged
#guard (g2.awaiting[0]?.map fun x => ((g2.s.ran x.1).map (·.n) != some x.2.n, x.2.loop.isSome)) ==
  some (true, true)
#guard moments g3.s 2 == []
#guard ((g3.s.ran 0).bind (·.ended), g3.s.due 0, g3.s.last 0, g3.s.store "k") ==
  (some .done, none, some (.num 1), some (.num 5))
#guard (eval g3.s.store (stale 0).f).1 == .value (.num 6)

-- a flagged run's own change after its await is cut (scenario 39); if its promise then rejects,
-- the run lands failed, its read stale: not due, and f from scratch now gives a promise. the same
-- in the TS (harness: f = do[read k, wait(p, do[write(k, run(read k) + 1), throw x])]; pulse;
-- resolve p; pulse; resolve p; pulse: a's run 2 failed, k is 2, it read 1)
def cutfail : Nat → Comp String J
  | _ => cmp (.read "k" fun _ => .value (.prom (.str "p"))) "a"
def h1 := go cutfail (make cutfail empty)
def h2 := go cutfail (settle (named cutfail h1 0 [("k", .num 1)]) 0 .error)
def h3 := go cutfail (settle (named cutfail h2 0 [("k", .num 2)]) 0 .error)
#guard moments h2.s 1 == [.due 0 2 (some 0), .starts 0 2 0, .ends 0 2 .pending none none none]
#guard moments h3.s 2 == [.ends 0 2 .failed none none none]
#guard ((h3.s.ran 0).bind (·.ended), h3.s.due 0, h3.s.cut 0) == (some .failed, none, true)
#guard ((h3.s.ran 0).map (·.seen), h3.s.store "k") == (some [("k", some (.num 1))], some (.num 2))
#guard (eval h3.s.store (cutfail 0).f).1 == .value (.prom (.str "p"))

end Model.Async.Check
