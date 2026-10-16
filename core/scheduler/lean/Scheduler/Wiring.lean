-- LLM generated working output
-- wiring: the model (Model.lean) to the proofs of the code's parts, so the model's abstractions
-- rest on them. on every reachable state (Quiescence.lean's Reach, A2):
--
-- 1. ranks. rank: rank.ts (Rank.lean) over the made, along the model's edges. ranked_reach:
--    Basic.lean's ranked holds; below: so next_below's hypothesis is discharged for it. (the
--    order's own ranks, mended, are 2's)
-- 2. order. view: order.ts's state seen from the model (each one's mark, 0 for none; after,
--    values, alive: the made). order.ts's ranks are its own now: made whole once (rank.ts, the
--    oracle ork: rkf over the made), then mended, only rising, so not rank.ts's of the model's
--    state. oranks: the ranks next ranks by. next_same: on any view keeping Order.lean's inv,
--    order.ts's next answers the model's next run with oranks (both least by (rank, mark, n));
--    oranks_ranked: those ranks are ranked over the model's edges (Order.next_ranked), so
--    Quiescence's theorems needing a ranked rank hold of them. acyclic_view, total_view: Lemma N
--    gives Order.lean's acyclicity. calls: the order states the scheduler's calls reach (set,
--    next and first's delete, delete, started, sees, waits), each with its precondition.
--    OReach: the model's states when each run is picked with the ranks of an order state driving
--    it (OReach.inv: Good, Sleeps, Vals). reach_order, next_reach: every such state has an order
--    state the calls reach that drives it (Drives: the view, inv, ticks, afters counting every
--    edge), and there order.ts's next is the model's, with ranked ranks. each step's calls:
--    a run (next; first: delete, waits(c, undefined), its wakes' sets, sees or waits and set),
--    an early effect's first run at its make (delete, then as a run), a going (delete, its
--    teardowns' marks, sees(c, []), waits(c, undefined)), marks (set)
-- 3. causes. Mirror: the model's causes on a heap of causes.ts's (Causes.lean), objects in the
--    order made, each labelled (computation, run); went is ranIn at the pulse, and a run holding a
--    given is of one held this pulse. reach_heap: every reachable state has one, reached by take,
--    run, keep, restore, clear and end with the callers' promises kept (Causes.reachable;
--    given_promise, keep_promise; restore's given back in the pulse it was taken in). a wake's
--    mark is from outside (no call); a going clears the going one's kept (clear); a make clears
--    the new one's (a new object's kept is empty). came_eq, loopof_eq: came is from, loopof is
--    loop; at each mark (mark_loop), at each read of a run (first_from), on every reachable state
--    (causes_reach). keep_heap: the model's skip by run is causes.ts's by object
--
-- assumed: A2 (no writes in runs, no going writes), as Quiescence.lean, wherever Reach or OReach
-- is used. next_same alone takes inv of its order state; reach_order discharges it
--
-- where this departs: computations are their n (Nat), order.ts's n is id; all() is range made
-- (rkf is blind to which univ holds the alive); alive is made (no dispose, so no gone, and
-- afters counts every edge, not only to the alive); a cause object is told by its label, one per
-- run among this pulse's objects (Mirror.inj). the calls are the scheduler's, in its order, but
-- `calls` records only that each was legal: OReach lets a run step use any driving order state
-- (the one the calls before built is one), not one made from the model's state
import Scheduler.Quiescence
import Scheduler.RankOrder
import Scheduler.Causes

set_option linter.unusedSectionVars false
set_option linter.unusedSimpArgs false

namespace Wiring

open Model Relation

variable {K V : Type} [DecidableEq K] [DecidableEq V]

/-! ## frames: what each step of the model leaves alone -/

theorem settle_shape (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : ∃ a b c e g, settle s d t who l fl =
      { s with cut := a, loop := b, looping := c, due := e, log := g } := by
  unfold settle
  split
  · cases who with
    | none => exact ⟨s.cut, s.loop, s.looping, s.due, s.log, rfl⟩
    | some c => exact ⟨_, s.loop, s.looping, s.due, s.log, rfl⟩
  · dsimp only
    split
    · exact ⟨s.cut, _, s.looping, s.due, s.log, rfl⟩
    · unfold Model.due; split
      · exact ⟨s.cut, _, _, s.due, s.log, rfl⟩
      · exact ⟨s.cut, _, _, _, _, rfl⟩

-- what the order's view, the ranks and the causes read, and the marks leave alone
structure Frame (s s' : State K V) : Prop where
  made : s'.made = s.made
  ran : s'.ran = s.ran
  values : s'.values = s.values
  runs : s'.runs = s.runs
  pulses : s'.pulses = s.pulses
  after : s'.after = s.after

theorem Frame.refl (s : State K V) : Frame s s := ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem Frame.trans {s s' s'' : State K V} (h1 : Frame s s') (h2 : Frame s' s'') : Frame s s'' :=
  ⟨h2.made.trans h1.made, h2.ran.trans h1.ran, h2.values.trans h1.values, h2.runs.trans h1.runs,
    h2.pulses.trans h1.pulses, h2.after.trans h1.after⟩

theorem settle_frame (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : Frame s (settle s d t who l fl) := by
  obtain ⟨a, b, c, e, g, h⟩ := settle_shape s d t who l fl
  rw [h]; exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem mark_frame (s : State K V) (d t : Nat) (who : Option Nat) : Frame s (mark s d t who) := by
  cases who with
  | none => simp only [mark]; exact settle_frame _ _ _ _ _ _
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    refine Frame.trans ?_ (settle_frame _ _ _ _ _ _)
    exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem marks_frame (t : Nat) (r : Option Nat) :
    ∀ (ds : List Nat) (s : State K V), Frame s (ds.foldl (fun s d => mark s d t r) s)
  | [], s => Frame.refl s
  | d :: ds, s => (mark_frame s d t r).trans (marks_frame t r ds _)

theorem tell_frame (s : State K V) (k : K) (t : Nat) (r : Option Nat) : Frame s (tell s k t r) :=
  marks_frame t r _ s

theorem changed_frame (cs : Nat → Comp K V) (s : State K V) (keys : List K) (who : Option Nat) :
    Frame s (changed cs s keys who) := by
  simp only [changed]
  generalize s.tick + 1 = t
  generalize runof { s with tick := t } who = r
  generalize (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have fold : ∀ (ks : List K) (s1 : State K V),
      Frame s1 (ks.foldl (fun s k => tell (learn s k w) k t r) s1) := by
    intro ks
    induction ks with
    | nil => intro s1; exact Frame.refl s1
    | cons k ks ih =>
      intro s1
      simp only [List.foldl_cons]
      have hl : Frame s1 (learn s1 k w) := by
        cases w <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
      exact (hl.trans (marks_frame t r _ _)).trans (ih _)
  refine Frame.trans ?_ (fold keys _)
  exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

/-! ## the writers a run read: a set, of made computations -/

-- nodup, and each below m
def okvals (m : Nat) (l : List Nat) : Prop := l.Nodup ∧ ∀ q ∈ l, q < m

theorem okvals_ins {m : Nat} {l : List Nat} {w : Nat} (h : okvals m l) (hw : w < m) :
    okvals m (ins w l) := by
  unfold ins
  split
  · exact h
  · refine ⟨List.nodup_append.2 ⟨h.1, by simp, ?_⟩, ?_⟩
    · intro a ha b hb; simp at hb; subst hb; intro e; subst e; contradiction
    · intro q hq; simp at hq; rcases hq with hq | rfl
      · exact h.2 q hq
      · exact hw

theorem okvals_mono {m m' : Nat} {l : List Nat} (h : okvals m l) (hm : m ≤ m') : okvals m' l :=
  ⟨h.1, fun q hq => Nat.lt_of_lt_of_le (h.2 q hq) hm⟩

-- wakes and untrack: frames
theorem wake_frame (cs : Nat → Comp K V) (s : State K V) (k : K) : Frame s (wake cs s k) := by
  obtain ⟨dy, sl, wr, tk, du, lp, lg, lgs, h⟩ := wake_shape cs s k
  rw [h]; exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem wakes_frame (cs : Nat → Comp K V) : ∀ (ws : List K) (s : State K V), Frame s (wakes cs s ws)
  | [], s => Frame.refl s
  | k :: ws, s => (wake_frame cs s k).trans (wakes_frame cs ws (wake cs s k))

theorem untrack_frame (cs : Nat → Comp K V) (s : State K V) (ks : List K) :
    Frame s (untrack cs s ks) := by
  obtain ⟨dy, h⟩ := untrack_shape cs ks s
  rw [h]; exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

-- a run (A2) keeps its record's writers a set of made ones (a wake's writer is made)
theorem exec_vals (cs : Nat → Comp K V) (c m : Nat) :
    ∀ (p : Prog K V), nowrites p → ∀ (s : State K V), s.made ≤ m →
    (∀ k w, s.writers k = some w → w < m) → (∀ x, (s.ran x).isSome → x < m) →
    (∀ r, s.ran c = some r → okvals m r.values) →
    ∀ r, (exec cs c s p).1.ran c = some r → okvals m r.values
  | .value _, _, s, _, _, _, h => by simpa [exec] using h
  | .error, _, s, _, _, _, h => by simpa [exec] using h
  | .pending, _, s, _, _, _, h => by simpa [exec] using h
  | .write .., hp, _, _, _, _, _ => absurd hp (by simp [nowrites])
  | .read k next, hp, s, hm, hw, hrm, h => by
    have hp' := fun x => (show nowrites (Prog.read k next) from hp) x
    simp only [exec]
    generalize hs1 : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) = s0
    have e0 : s0.writers = s.writers := by rw [← hs1]; rfl
    have m0 : s0.made = s.made := by rw [← hs1]; rfl
    have r0 : ∀ x, (s0.ran x).isSome → x < m := by
      intro x hx; rw [← hs1] at hx; simp only [edit] at hx
      by_cases e : x = c
      · subst e; simp at hx; exact hrm x (by simpa using hx)
      · rw [put_ne _ _ e] at hx; exact hrm x hx
    have h0 : ∀ r, s0.ran c = some r → okvals m r.values := by
      intro r hr
      rw [← hs1] at hr
      simp only [edit, put_same, Option.map_eq_some_iff] at hr
      obtain ⟨r0, hr0, rfl⟩ := hr
      exact h r0 hr0
    generalize hs1' : (if (!tracked s k) = true then wake cs s0 k else s0) = s1
    have mv : Moves s0 s1 := by
      rw [← hs1']; split
      · exact wake_moves cs s0 k
      · exact Moves.refl s0
    have m1 : s1.made = s.made := by rw [mv.made, m0]
    have w1 : ∀ k w, s1.writers k = some w → w < m := by
      intro k' w hk
      rcases mv.writers k' w hk with h' | h' | h'
      · rw [e0] at h'; exact hw k' w h'
      · exact r0 w h'
      · omega
    have rr1 : ∀ x, (s1.ran x).isSome → x < m := by intro x hx; rw [mv.ran] at hx; exact r0 x hx
    have h1 : ∀ r, s1.ran c = some r → okvals m r.values := by rw [mv.ran]; exact h0
    have go : ∀ (s2 : State K V), s2.made = s.made → (∀ k w, s2.writers k = some w → w < m) →
        (∀ x, (s2.ran x).isSome → x < m) →
        (∀ r, s2.ran c = some r → okvals m r.values) →
        ∀ r, (exec cs c s2 (next (s.store k))).1.ran c = some r → okvals m r.values :=
      fun s2 e2 w2 rr2 h2 => exec_vals cs c m (next (s.store k)) (hp' _) s2 (by rw [e2]; exact hm)
        w2 rr2 h2
    split
    · exact go s1 m1 w1 rr1 h1
    · rename_i w hwk
      split
      · exact go s1 m1 w1 rr1 h1
      · have hwm : w < m := w1 k w hwk
        generalize hs2 : edit s1 c (fun r => { r with values := ins w r.values }) = s2
        have e2 : s2.made = s.made := by rw [← hs2]; exact m1
        have w2 : ∀ k w, s2.writers k = some w → w < m := by rw [← hs2]; exact w1
        have rr2 : ∀ x, (s2.ran x).isSome → x < m := by
          intro x hx; rw [← hs2] at hx; simp only [edit] at hx
          by_cases e : x = c
          · subst e; simp at hx; exact rr1 x (by simpa using hx)
          · rw [put_ne _ _ e] at hx; exact rr1 x hx
        have h2 : ∀ r, s2.ran c = some r → okvals m r.values := by
          intro r hr
          rw [← hs2] at hr
          simp only [edit, put_same, Option.map_eq_some_iff] at hr
          obtain ⟨r0, hr0, rfl⟩ := hr
          exact okvals_ins (h1 r0 hr0) hwm
        split
        · intro r hr
          simp only [edit, put_same, Option.map_eq_some_iff] at hr
          obtain ⟨r0, hr0, rfl⟩ := hr
          exact h2 r0 hr0
        · exact go s2 e2 w2 rr2 h2

-- first, A2: start, f's run (its wakes W), its reads kept, untrack, and its end: the state the end
-- is told of is W but for c's run (f's), the reads and the dying; what it read the writers of are
-- made
theorem first_eq (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    (hw : ∀ k w, s.writers k = some w → w < s.made) (hrm : ∀ x, (s.ran x).isSome → x < s.made)
    (hc : c < s.made) :
    ∃ (o : Out V) (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat) (ws : List K)
      (X : State K V), first cs s c rk = ending cs X c o ∧
      X.ran = put s.ran c (some (begun s c vals st seen)) ∧
      { X with
        ran := (wakes cs (start s c rk) ws).ran, reads := (wakes cs (start s c rk) ws).reads,
        dying := (wakes cs (start s c rk) ws).dying } = wakes cs (start s c rk) ws ∧
      okvals s.made vals := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, ws, heq, -, -, -⟩ :=
    exec_spec cs c (cs c).f hp (start s c rk) _ h0 rfl
  have hv := exec_vals cs c s.made (cs c).f hp (start s c rk) (by simp [start, say])
    (by simpa [start, say] using hw)
    (by
      intro x hx
      by_cases e : x = c
      · subst e; exact hc
      · simp [start, say, put_ne _ _ e] at hx; exact hrm x (by simpa using hx))
    (by intro r hr; rw [h0] at hr; cases hr; exact ⟨List.nodup_nil, by simp [begun]⟩)
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq hv
  obtain ⟨s2, o⟩ := x
  simp only at heq hv
  have hv' := hv _ (by rw [heq]; exact put_same _ _ _)
  subst heq
  obtain ⟨dy, hU⟩ := untrack_shape cs _ _
  rw [hU]
  refine ⟨o, seen, vals, st, ws, _, rfl, ?_, rfl, hv'⟩
  simp [start, say, put_put, begun]

-- what first_eq's equation gives, field by field
theorem first_fields {X W : State K V}
    (h : { X with ran := W.ran, reads := W.reads, dying := W.dying } = W) :
    X.made = W.made ∧ X.due = W.due ∧ X.after = W.after ∧ X.values = W.values ∧
      X.writers = W.writers ∧ X.cause = W.cause ∧ X.when = W.when ∧ X.went = W.went ∧
      X.kept = W.kept ∧ X.runs = W.runs ∧ X.pulses = W.pulses :=
  ⟨by have := congrArg State.made h; exact this, by have := congrArg State.due h; exact this,
    by have := congrArg State.after h; exact this, by have := congrArg State.values h; exact this,
    by have := congrArg State.writers h; exact this, by have := congrArg State.cause h; exact this,
    by have := congrArg State.when h; exact this, by have := congrArg State.went h; exact this,
    by have := congrArg State.kept h; exact this, by have := congrArg State.runs h; exact this,
    by have := congrArg State.pulses h; exact this⟩

/-! ## Vals: what the values are, on every reachable state -/

-- each computation's values (order.ts p.values) and each run's: a set of made computations; none
-- for one not made
structure Vals (s : State K V) : Prop where
  out : ∀ p, s.made ≤ p → s.values p = []
  vals : ∀ p, okvals s.made (s.values p)
  runs : ∀ c r, s.ran c = some r → okvals s.made r.values

theorem Vals.of {s s' : State K V} (v : Vals s) (hm : s'.made = s.made)
    (hv : ∀ p, s'.values p = s.values p ∨
      (p < s.made ∧ ∃ r, s.ran p = some r ∧ s'.values p = r.values))
    (hr : ∀ c r, s'.ran c = some r → ∃ r0, s.ran c = some r0 ∧ r.values = r0.values) :
    Vals s' where
  out p hp := by
    rcases hv p with h | ⟨h, -⟩
    · rw [h]; exact v.out p (hm ▸ hp)
    · omega
  vals p := by
    rw [hm]
    rcases hv p with h | ⟨-, r, h1, h2⟩
    · rw [h]; exact v.vals p
    · rw [h2]; exact v.runs p r h1
  runs c r h := by
    obtain ⟨r0, h1, h2⟩ := hr c r h
    rw [hm, h2]; exact v.runs c r0 h1

theorem Vals.frame {s s' : State K V} (v : Vals s) (f : Frame s s') : Vals s' :=
  v.of f.made (fun p => Or.inl (by rw [f.values])) (fun c r h => ⟨r, by rw [← f.ran]; exact h, rfl⟩)

theorem Vals.finish {s : State K V} (v : Vals s) {c : Nat} (hc : c < s.made) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat)) :
    Vals (finish s c e eq w th) := by
  cases hr : s.ran c with
  | none => simp only [Model.finish, hr]; exact v
  | some r =>
    obtain ⟨_, _, -, hfin⟩ := finish_any s c r hr e eq w th
    rw [hfin]
    refine v.of rfl ?_ ?_
    · intro p
      by_cases hp : p = c
      · subst hp
        split
        · exact Or.inr ⟨hc, r, hr, by simp⟩
        · exact Or.inl rfl
      · split
        · exact Or.inl (put_ne _ _ hp)
        · exact Or.inl rfl
    · intro d r' h
      by_cases hd : d = c
      · subst hd; simp at h; subst h; exact ⟨r, hr, rfl⟩
      · simp only [put_ne _ _ hd] at h; exact ⟨r', h, rfl⟩

theorem Vals.stop {s : State K V} (v : Vals s) {c : Nat} (hc : c < s.made) : Vals (stop s c) := by
  cases hr : s.ran c with
  | none => simp only [Model.stop, hr]; exact v
  | some r =>
    simp only [Model.stop, hr]
    split <;> refine Vals.finish ?_ ?_ _ _ _ _
    · exact v.of rfl (fun _ => Or.inl rfl) (fun c r h => ⟨r, h, rfl⟩)
    · exact hc
    · exact v.of rfl (fun _ => Or.inl rfl) (fun c r h => ⟨r, h, rfl⟩)
    · exact hc

theorem set_frame (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V) :
    Frame s (set cs s c v) := by
  simp only [Model.set]
  split
  · refine Frame.trans ?_ (changed_frame cs _ _ _)
    exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  · exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem Vals.result {cs : Nat → Comp K V} {s : State K V} (v : Vals s) {c : Nat} (hc : c < s.made)
    (x : V) : Vals (result cs s c x) := by
  have f := set_frame cs s c x
  unfold Model.result
  dsimp only
  repeat' split
  all_goals refine Vals.finish ?_ ?_ _ _ _ _
  all_goals first
    | exact v
    | exact hc
    | exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
    | exact v.frame (f.trans ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩)
    | (show c < (set cs s c x).made; rw [f.made]; exact hc)

theorem Vals.ending {cs : Nat → Comp K V} {s : State K V} (v : Vals s) {c : Nat} (hc : c < s.made)
    (o : Out V) : Vals (ending cs s c o) := by
  unfold Model.ending
  split
  · exact v.stop hc
  · have v1 : Vals (edit s c fun r => { r with out := some o }) := by
      refine v.of rfl (fun _ => Or.inl rfl) ?_
      intro d r h
      simp only [edit] at h
      by_cases hd : d = c
      · subst hd; simp only [put_same, Option.map_eq_some_iff] at h
        obtain ⟨r0, h0, rfl⟩ := h; exact ⟨r0, h0, rfl⟩
      · rw [put_ne _ _ hd] at h; exact ⟨r, h, rfl⟩
    split
    · exact v1.finish hc _ _ _ _
    · exact v1.finish hc _ _ _ _
    · exact v1.result hc _

theorem Vals.first {cs : Nat → Comp K V} {s : State K V} (v : Vals s) (hA : A2 cs)
    (hw : ∀ k w, s.writers k = some w → w < s.made) (hrm : ∀ x, (s.ran x).isSome → x < s.made)
    {c : Nat} (hc : c < s.made) (rk : Nat) : Vals (first cs s c rk) := by
  obtain ⟨o, seen, vals, st, ws, X, h, e5, hX, hv⟩ := first_eq cs s c rk (hA c) hw hrm hc
  obtain ⟨e1, -, -, e4, -⟩ := first_fields hX
  have fW := wakes_frame cs ws (start s c rk)
  rw [fW.made] at e1; rw [fW.values] at e4
  simp only [start, say] at e1 e4
  rw [h]
  refine Vals.ending ?_ (by rw [e1]; exact hc) o
  refine ⟨?_, ?_, ?_⟩
  · intro p hp; rw [e4]; rw [e1] at hp; exact v.out p hp
  · intro p; rw [e4, e1]; exact v.vals p
  · intro d r hr
    rw [e1]
    rw [e5] at hr
    by_cases hd : d = c
    · subst hd; simp at hr; subst hr; exact hv
    · rw [put_ne _ _ hd] at hr; exact v.runs d r hr

theorem act_frame (cs : Nat → Comp K V) (s : State K V) (e : Nat) (x : V) :
    Frame s (act cs s e x) := by
  have fold : ∀ (ws : List (K × V)) (s1 : State K V),
      Frame s1 (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1) := by
    intro ws
    induction ws with
    | nil => intro s1; exact Frame.refl s1
    | cons kv ws ih =>
      intro s1
      simp only [List.foldl_cons]
      refine Frame.trans ?_ (ih _)
      refine Frame.trans ?_ (changed_frame cs _ _ _)
      exact ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  unfold Model.act
  dsimp only
  split
  · exact Frame.refl s
  · split
    · exact Frame.refl s
    · rename_i g _
      have h1 : Frame s (say s (Event.act e x (s.last e))) := ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
      have h2 := h1.trans (fold (g x (s.last e)) _)
      exact ⟨h2.made, h2.ran, h2.values, h2.runs, h2.pulses, h2.after⟩

-- a going: its teardowns' writes (changes), then no values, no run
theorem Vals.bury {cs : Nat → Comp K V} {s : State K V} (v : Vals s) (d : Nat) :
    Vals (bury cs s d) := by
  unfold Model.bury
  split
  · exact v
  · split
    · exact v
    · have hf : ∀ (ws : List (K × V)) (s1 : State K V), Vals s1 →
          Vals (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some d)) s1) := by
        intro ws
        induction ws with
        | nil => intro s1 h1; exact h1
        | cons kv ws ih =>
          intro s1 h1; simp only [List.foldl_cons]; apply ih
          exact (h1.frame (s' := store s1 kv.1 kv.2) ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩).frame
            (changed_frame ..)
      have h1 := hf (cs d).goes { s with due := put s.due d none }
        (v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩)
      simp only
      refine Vals.frame ?_ (untrack_frame ..)
      refine ⟨fun p hp => ?_, fun p => ?_, fun c r h => ?_⟩
      · by_cases e : p = d
        · subst e; simp
        · simp only [put_ne _ _ e]; exact h1.out p hp
      · by_cases e : p = d
        · subst e; simp only [put_same]; exact ⟨List.nodup_nil, by simp⟩
        · simp only [put_ne _ _ e]; exact h1.vals p
      · by_cases e : c = d
        · subst e; simp at h
        · simp only [put_ne _ _ e] at h; exact h1.runs c r h

theorem Vals.step {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s s' : State K V}
    (v : Vals s) (hA : A2 cs) (g : Core cs s) (h : step cs rk s = some s') : Vals s' := by
  unfold Model.step at h
  split at h
  · split at h
    · rename_i c hc
      cases h
      exact v.first hA g.writers_made g.ran_made (next_ready hc).2 _
    · cases h; exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  · split at h
    · cases h
      refine Vals.frame ?_ (act_frame _ _ _ _)
      exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
    · split at h
      · cases h
        refine Vals.frame ?_ (act_frame _ _ _ _)
        exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
      · split at h
        · cases h; exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
        · split at h
          · cases h
          · cases h; exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  · split at h
    · rename_i d rest _
      cases h
      exact Vals.bury (cs := cs) (v.frame (s' := { s with dying := rest }) ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩) _
    · cases h; exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem Vals.grow {cs : Nat → Comp K V} {s : State K V} (v : Vals s) : Vals (Model.grow cs s) := by
  have e : (Model.grow cs s).made = s.made + 1 ∧ (Model.grow cs s).values = s.values ∧
      (Model.grow cs s).ran = s.ran := by
    simp only [Model.grow]; split <;> exact ⟨rfl, rfl, rfl⟩
  refine ⟨?_, ?_, ?_⟩
  · intro p hp; rw [e.2.1]; exact v.out p (by omega)
  · intro p; rw [e.1, e.2.1]; exact okvals_mono (v.vals p) (by omega)
  · intro c r h; rw [e.1]; rw [e.2.2] at h; exact okvals_mono (v.runs c r h) (by omega)

theorem Vals.make {cs : Nat → Comp K V} {s : State K V} (v : Vals s) (hA : A2 cs) (g : Core cs s) :
    Vals (make cs s) := by
  have v1 := v.grow (cs := cs)
  have e : (Model.grow cs s).made = s.made + 1 ∧ (Model.grow cs s).ran = s.ran ∧
      (∀ k w, (Model.grow cs s).writers k = some w → w < s.made + 1) := by
    simp only [Model.grow]
    split
    · rename_i k _
      refine ⟨rfl, rfl, fun k' w h => ?_⟩
      by_cases e : k' = k
      · subst e; simp at h; omega
      · simp [put_ne _ _ e] at h; have := g.writers_made k' w h; omega
    · exact ⟨rfl, rfl, fun k w h => by have := g.writers_made k w h; omega⟩
  unfold Model.make
  dsimp only
  split
  · exact v1.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  · have v2 := v1.frame (mark_frame (Model.grow cs s) s.made (Model.grow cs s).tick none)
    have f2 := mark_frame (Model.grow cs s) s.made (Model.grow cs s).tick none
    split
    · have v3 := v2.first (c := s.made) hA
        (by
          intro k w h
          rw [show (mark (Model.grow cs s) s.made (Model.grow cs s).tick none).writers =
            (Model.grow cs s).writers by simp, f2.made, e.1] at *
          exact e.2.2 k w h)
        (by
          intro x hx; rw [f2.made, e.1]; rw [f2.ran, e.2.1] at hx
          have := g.ran_made x hx; omega)
        (by rw [f2.made, e.1]; omega) 0
      simp only [actnow]
      split
      · refine Vals.frame ?_ (act_frame ..)
        exact v3.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
      · exact v3
    · exact v2

theorem Vals.close {s : State K V} (v : Vals s) : Vals (close s) :=
  v.of rfl (fun _ => Or.inl rfl) (fun _ r h => ⟨r, h, rfl⟩)

-- on every reachable state (A2): the values are sets of made computations, none for one not made
theorem vals_reach {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rk s) : Vals s := by
  induction h with
  | empty =>
    exact ⟨fun _ _ => rfl, fun _ => ⟨List.nodup_nil, by simp [Model.empty]⟩,
      fun _ _ h => by simp [Model.empty] at h⟩
  | make hs ih => exact ih.make hA (hs.good hA).toCore
  | write kvs _ ih =>
    refine Vals.frame ?_ (changed_frame _ _ _ _)
    obtain ⟨st, e, -⟩ := stores_shape _ kvs
    rw [e]; exact ih.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  | tell keys _ ih => exact ih.frame (changed_frame ..)
  | begin _ ih => exact ih.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  | step hs h ih => exact ih.step hA (hs.good hA).toCore h
  | close _ _ ih => exact ih.close

/-! ## 1. the ranks: rank.ts's, over the model's edges -/

-- order.ts's ranks: rank.ts over the computations made, along the model's edges
def rank (s : State K V) (p : Nat) : Nat := (Rank.rank (List.range s.made) (edges s) p).getD 0

theorem edges_made (s : State K V) (p : Nat) : ∀ q ∈ edges s p, q < s.made := by
  intro q hq
  simp only [edges, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq] at hq
  exact hq.2.2

theorem edges_close (s : State K V) :
    ∀ p ∈ List.range s.made, ∀ q ∈ edges s p, q ∈ List.range s.made :=
  fun p _ q hq => List.mem_range.2 (edges_made s p q hq)

-- one not made has no edges
theorem edges_out {cs : Nat → Comp K V} {s : State K V} (v : Vals s) (g : Core cs s) {p : Nat}
    (hp : s.made ≤ p) : edges s p = [] := by
  have ha : s.after p = none := by
    cases e : s.after p with
    | none => rfl
    | some w => have := g.due_made p (g.after_due p w e).1; omega
  simp [edges, v.out p hp, ha]

-- with no edges out of what is not made, rank is ranked over the edges (Basic.lean)
theorem rank_ranked {s : State K V} (hout : ∀ p, s.made ≤ p → edges s p = []) :
    ranked (fun p q => q ∈ edges s p) (rank s) := by
  intro p q hq
  have hp : p < s.made := by
    refine Nat.lt_of_not_le fun hp => ?_
    rw [hout p hp] at hq; simp at hq
  obtain ⟨h1, h2⟩ := Rank.rank_ranked (edges_close s) p q ⟨List.mem_range.2 hp, hq⟩
  refine ⟨h1, fun hn => h2 fun ht => hn ?_⟩
  exact tg_mono (fun a b h => h.2) ht

-- 1: on every reachable state (A2, any rank), rank.ts's rank is ranked over the edges
theorem ranked_reach {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rk s) : ranked (fun p q => q ∈ edges s p) (rank s) :=
  rank_ranked fun _ hp => edges_out (vals_reach hA h) (h.good hA).toCore hp

-- so next_below's hypothesis is discharged: with rank.ts's ranks, below any due one there is a
-- ready one of no greater rank
theorem below {cs : Nat → Comp K V} {s : State K V} (hA : A2 cs) (h : Reach cs rank s) {p : Nat}
    (hp : (s.due p).isSome) : ∃ q, ready s q = true ∧ q < s.made ∧ rank s q ≤ rank s p :=
  next_below hA h.wide (ranked_reach hA h) hp

/-! ## 2. the order: Order.lean's state, viewed from the model -/

-- before is a strict total order on (rank, mark, n)
theorem before_irrefl (a : Nat × Nat × Nat) : ¬ Order.before a a := by
  simp only [Order.before]; omega

theorem before_trans {a b c : Nat × Nat × Nat} (h1 : Order.before a b) (h2 : Order.before b c) :
    Order.before a c := by
  simp only [Order.before] at *; omega

theorem before_total {a b : Nat × Nat × Nat} (h1 : ¬ Order.before a b) (h2 : ¬ Order.before b a) :
    a = b := by
  obtain ⟨a1, a2, a3⟩ := a
  obtain ⟨b1, b2, b3⟩ := b
  simp only [Order.before] at *
  have : a1 = b1 := by omega
  have : a2 = b2 := by omega
  have : a3 = b3 := by omega
  subst_vars; rfl

-- the model's next, its fold: the one kept is before no other it saw, by (rank, mark, n), the
-- list in the order made
theorem pick_least (key : Nat → Nat × Nat) :
    ∀ (l : List Nat) (init : Option Nat) (b : Nat), l.Pairwise (· < ·) →
      (∀ x, init = some x → ∀ p ∈ l, x < p) →
      l.foldl (fun best p => match best with
        | none => some p
        | some b =>
          if (key p).1 < (key b).1 || ((key p).1 == (key b).1 && (key p).2 < (key b).2) then some p
          else some b) init = some b →
      (∀ x, init = some x → ¬ Order.before ((key x).1, (key x).2, x) ((key b).1, (key b).2, b)) ∧
      ∀ q ∈ l, ¬ Order.before ((key q).1, (key q).2, q) ((key b).1, (key b).2, b)
  | [], init, b, _, _, h => by
    simp only [List.foldl_nil] at h
    subst h
    exact ⟨fun x hx => by cases hx; exact before_irrefl _, by simp⟩
  | p :: l, init, b, hs, hi, h => by
    simp only [List.foldl_cons] at h
    rw [List.pairwise_cons] at hs
    generalize hn : (match init with
      | none => some p
      | some b =>
        if (key p).1 < (key b).1 || ((key p).1 == (key b).1 && (key p).2 < (key b).2) then some p
        else some b) = init' at h
    have hi' : ∀ x, init' = some x → ∀ q ∈ l, x < q := by
      intro x hx q hq
      cases init with
      | none => cases hn; cases hx; exact hs.1 q hq
      | some y =>
        simp only at hn
        split at hn
        · cases hn; cases hx; exact hs.1 q hq
        · cases hn
          simp only [Option.some.injEq] at hx
          subst hx
          exact Nat.lt_trans (hi _ rfl p (by simp)) (hs.1 q hq)
    obtain ⟨ih1, ih2⟩ := pick_least key l init' b hs.2 hi' h
    refine ⟨?_, ?_⟩
    · intro x hx
      subst hx
      simp only at hn
      split at hn
      · rename_i hlt
        cases hn
        intro hb
        refine ih1 p rfl (before_trans ?_ hb)
        simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at hlt
        simp only [Order.before]; omega
      · cases hn; exact ih1 x rfl
    · intro q hq
      rcases List.mem_cons.1 hq with rfl | hq
      · cases init with
        | none => cases hn; exact ih1 q rfl
        | some y =>
          simp only at hn
          split at hn
          · cases hn; exact ih1 q rfl
          · rename_i hlt
            cases hn
            intro hb
            refine ih1 y rfl (before_trans ?_ hb)
            have hyq : y < q := hi y rfl q (by simp)
            simp only [Bool.or_eq_true, Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq,
              not_or, not_and] at hlt
            simp only [Order.before]; omega
      · exact ih2 q hq

-- a computation's mark: the tick it became due at (order.ts, at)
def stamp (s : State K V) (p : Nat) : Nat := (s.due p).getD 0

-- the model's next: ready, and before no other ready one by (rank, mark, n)
theorem next_least {rk : State K V → Nat → Nat} {s : State K V} {c : Nat}
    (h : next rk s = some c) :
    ready s c = true ∧ c < s.made ∧ ∀ q, ready s q = true → q < s.made →
      ¬ Order.before (rk s q, stamp s q, q) (rk s c, stamp s c, c) := by
  obtain ⟨h1, h2⟩ := next_ready h
  refine ⟨h1, h2, ?_⟩
  intro q hq hqm
  simp only [next] at h
  have hs : ((List.range s.made).filter (ready s)).Pairwise (· < ·) :=
    (List.pairwise_lt_range).filter _
  exact (pick_least _ _ none c hs (by simp) h).2 q (by simp [hq, hqm])

theorem next_none {rk : State K V → Nat → Nat} {s : State K V} (h : next rk s = none) :
    ∀ q, q < s.made → ready s q = false := by
  intro q hq
  cases e : ready s q with
  | false => rfl
  | true =>
    have : (next rk s).isSome := by
      simp only [next]
      exact pick_some _ _ none (Or.inr (List.ne_nil_of_mem (a := q) (by simp [hq, e])))
    rw [h] at this; cases this

-- order.ts's view of a model state: each one's mark (p.due; 0, not due), what each waits after,
-- the writers each last read (p.after, p.values), and the alive: the made
structure view (s : State K V) (o : Order.State Nat) : Prop where
  due : ∀ p, o.due p = (s.due p).getD 0
  after : o.after = s.after
  values : o.values = s.values
  alive : ∀ p, o.alive p = decide (p < s.made)

-- the model's marks are ticks: never 0 (scheduler.ts: ++tick)
def ticks (s : State K V) : Prop := ∀ p t, s.due p = some t → t ≠ 0

theorem due_iff {s : State K V} {o : Order.State Nat} (v : view s o) (ht : ticks s) (p : Nat) :
    (s.due p).isSome ↔ o.due p ≠ 0 := by
  rw [v.due]
  cases h : s.due p with
  | none => simp
  | some t => simp [ht p t h]

-- ready is order.ts's: due, and not waiting after a due one
theorem ready_iff {s : State K V} {o : Order.State Nat} (v : view s o) (ht : ticks s) (p : Nat) :
    ready s p = true ↔ o.due p ≠ 0 ∧ Order.waiting o p = false := by
  rw [← due_iff v ht]
  simp only [ready, Order.waiting, v.after, Bool.and_eq_true]
  cases s.after p with
  | none => simp
  | some q =>
    simp only [v.due]
    cases h : s.due q with
    | none => simp
    | some t => simp [ht q t h]

-- the oracle the order is given: rank.ts over the made (order.ts: all(), the live; rkf is blind to
-- which univ holds them)
def ork (s : State K V) : Order.Rk Nat := RankOrder.rkf (List.range s.made)

theorem all_view {s : State K V} {o : Order.State Nat} (v : view s o) :
    ∀ p, o.alive p = true → p ∈ List.range s.made :=
  fun p hp => List.mem_range.2 (by rw [v.alive] at hp; simpa using hp)

theorem sound_view {s : State K V} {o : Order.State Nat} (v : view s o) :
    Order.sound (ork s) o.alive :=
  RankOrder.rkf_sound _ (all_view v)

-- the ranks order.ts's next ranks by: made whole when there are none, else as mended (rising
-- only): the order's own, not rank.ts's of the model's state
def oranks (s : State K V) (o : Order.State Nat) : Nat → Nat :=
  Order.rankOf (Order.next id (ork s) (List.range s.made) o).2

-- order.ts's edges of the alive are the model's edges
theorem lk_view {s : State K V} {o : Order.State Nat} (v : view s o)
    (hout : ∀ p, s.made ≤ p → edges s p = []) (x y : Nat) :
    Order.lk o x y = true ↔ y ∈ edges s x := by
  by_cases hx : x < s.made
  · simp only [Order.lk, Order.link, Order.edge, v.alive, v.values, v.after, edges,
      List.mem_filter, List.mem_append, Option.mem_toList, Bool.and_eq_true, decide_eq_true_eq,
      Bool.or_eq_true, bne_iff_ne, ne_eq, hx, true_and]
    constructor
    · rintro ⟨⟨hne, hy⟩, h⟩
      refine ⟨?_, hne, hy⟩
      rcases h with h | h
      · exact Or.inl h
      · exact Or.inr (by simpa using h)
    · rintro ⟨h, hne, hy⟩
      refine ⟨⟨hne, hy⟩, ?_⟩
      rcases h with h | h
      · exact Or.inl h
      · exact Or.inr (by simpa using h)
  · rw [hout x (by omega)]
    simp [Order.lk, v.alive, hx]

-- the order's ranks (next's state) are ranked over the model's edges (Order.lean's next_ranked)
theorem oranks_ranked {s : State K V} {o : Order.State Nat} (v : view s o)
    (hi : Order.inv id o) (hout : ∀ p, s.made ≤ p → edges s p = []) :
    ranked (fun p q => q ∈ edges s p) (oranks s o) := by
  have h := (Order.next_ranked id hi (sound_view v) (all_view v)).1
  have e : (fun x y => Order.lk o x y = true) = (fun p q => q ∈ edges s p) := by
    funext x y; exact propext (lk_view v hout x y)
  rw [e] at h
  exact h

-- 2: order.ts's next, on any order state the model's view keeping what order keeps, answers what
-- the model's next does with the order's ranks: both the least ready one by (rank, mark, n), and
-- n is unique
theorem next_same {s : State K V} {o : Order.State Nat} (v : view s o) (ht : ticks s)
    (hi : Order.inv id o) :
    (Order.next id (ork s) (List.range s.made) o).1 =
      (next (fun _ => oranks s o) s).map fun p => (p, oranks s o p) := by
  have hk := sound_view v
  have hall' := all_view v
  have hmade : ∀ q, o.due q ≠ 0 → q < s.made := by
    intro q hq; have := hi.good.2.2.1 q hq; rw [v.alive] at this; simpa using this
  have hmark : ∀ q, stamp s q = o.due q := by intro q; simp [stamp, v.due]
  cases hb : (Order.next id (ork s) (List.range s.made) o).1 with
  | none =>
    cases hn : next (fun _ => oranks s o) s with
    | none => rfl
    | some c =>
      obtain ⟨h1, -, -⟩ := next_least hn
      obtain ⟨h2, h3⟩ := (ready_iff v ht c).1 h1
      have := Order.next_none id hi hk hall' hb c h2
      rw [h3] at this; cases this
  | some pk =>
    obtain ⟨p, k⟩ := pk
    obtain ⟨hd, hw, hk', hl⟩ := Order.next_least id hi hk hall' hb
    have hpr : ready s p = true := (ready_iff v ht p).2 ⟨hd, hw⟩
    have hpm := hmade p hd
    cases hn : next (fun _ => oranks s o) s with
    | none => have := next_none hn p hpm; rw [hpr] at this; cases this
    | some c =>
      obtain ⟨hc1, hc2, hc3⟩ := next_least hn
      obtain ⟨hcd, hcw⟩ := (ready_iff v ht c).1 hc1
      have a := hc3 p hpr hpm
      have b := hl c hcd hcw
      simp only [id] at b
      rw [hk'] at b
      rw [hmark p, hmark c] at a
      have e := before_total b a
      simp only [Prod.mk.injEq] at e
      obtain ⟨-, -, rfl⟩ := e
      simp [hk', oranks]

-- 2: order.ts's next is total on the model's view: after-chains acyclic (Lemma N), so with
-- anything due it gives a computation (Order.lean's next_total, its hypothesis discharged)
theorem acyclic_view {cs : Nat → Comp K V} {s : State K V} {o : Order.State Nat} (g : Core cs s)
    (v : view s o) : ∀ p, ¬ TransGen (Order.step o) p p := by
  intro p hp
  refine g.acyclic p (tg_mono ?_ hp)
  intro a b hab
  simp only [aft]; rw [← v.after]; exact hab.2.1

theorem total_view {cs : Nat → Comp K V} {s : State K V} {o : Order.State Nat} (g : Core cs s)
    (v : view s o) (ht : ticks s) (hi : Order.inv id o) {p : Nat} (hp : (s.due p).isSome) :
    ∃ q k, (Order.next id (ork s) (List.range s.made) o).1 = some (q, k) :=
  Order.next_total id hi (sound_view v) (all_view v) ⟨p, (due_iff v ht p).1 hp⟩ (acyclic_view g v)

-- afters counts every edge, to any computation: in Wiring nothing is disposed (no gone), so not
-- only to the alive (Order.counted)
def counts (o : Order.State Nat) : Prop :=
  ∀ q y, Order.cnt o q y = (if q ∈ o.values y then 1 else 0) + (if o.after y = some q then 1 else 0)

-- started only on fresh (scheduler.ts, make: order.started(c), c a new object): the one make makes
-- next is fresh in the view: not alive, after nothing, nothing after it, so counted by none
theorem started_fresh {cs : Nat → Comp K V} {s : State K V} {o : Order.State Nat} (g : Core cs s)
    (vs : Vals s) (v : view s o) (hc : counts o) : Order.fresh o s.made := by
  have nob : ∀ x, s.made ∉ s.values x ∧ s.after x ≠ some s.made := by
    intro x
    constructor
    · intro hm; have := (vs.vals x).2 _ hm; omega
    · intro e; have := (g.after_due x _ e).2; omega
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · simp [v.alive]
  · rw [v.values]; exact vs.out _ (Nat.le_refl _)
  · rw [v.after]
    cases e : s.after s.made with
    | none => rfl
    | some w => have := g.due_made _ (g.after_due _ _ e).1; omega
  · intro x; rw [v.values, v.after]; exact nob x
  · intro y; rw [hc, v.values, v.after]; simp [(nob y).1, (nob y).2]

-- a mark makes due only the one it marks; changed marks only readers, which are made
theorem settle_due (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : ∀ x, x ≠ d → (settle s d t who l fl).due x = s.due x := by
  intro x hx
  unfold settle
  split
  · cases who <;> rfl
  · dsimp only
    split
    · rfl
    · unfold Model.due
      split
      · rfl
      · simp [say, put_ne _ _ hx]

theorem mark_due (s : State K V) (d t : Nat) (who : Option Nat) :
    ∀ x, x ≠ d → (mark s d t who).due x = s.due x := by
  intro x hx
  cases who with
  | none => exact settle_due _ _ _ _ _ _ x hx
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    exact settle_due _ _ _ _ _ _ x hx

theorem readers_made {s : State K V} {k : K} {d : Nat} (h : d ∈ readers s k) : d < s.made := by
  simp only [readers, List.mem_filter, List.mem_range] at h
  exact h.1

/-! ## 2, all the way: the order the scheduler's calls drive is the model's view -/

-- the order states the scheduler's calls reach from createOrder, each call with Order.lean's
-- precondition: set on an alive one at a tick, started on a fresh one, sees without repeats.
-- next is followed by first's delete of what it gave (pulse: first(order.next())); an early
-- effect's first run and a going delete without a next
inductive calls : Order.State Nat → Prop
  | init : calls Order.init
  | set {o : Order.State Nat} {p m : Nat} : calls o → o.alive p = true → m ≠ 0 →
      calls (Order.set id o p m)
  | next {o : Order.State Nat} {p k : Nat} (u all : List Nat) : calls o →
      (Order.next id (RankOrder.rkf u) all o).1 = some (p, k) →
      calls (Order.delete (Order.next id (RankOrder.rkf u) all o).2 p)
  | delete {o : Order.State Nat} {p : Nat} : calls o → calls (Order.delete o p)
  | started {o : Order.State Nat} {p : Nat} : calls o → Order.fresh o p → calls (Order.started o p)
  | sees {o : Order.State Nat} {p : Nat} {l : List Nat} (u all : List Nat) : calls o → l.Nodup →
      calls (Order.sees id (RankOrder.rkf u) all o p l)
  | waits {o : Order.State Nat} {p : Nat} {q : Option Nat} (u all : List Nat) : calls o →
      calls (Order.waits id (RankOrder.rkf u) all o p q)

-- an order state driven by the model: its view, what order keeps, the model's marks ticks, and
-- afters counting every edge
structure Drives (s : State K V) (o : Order.State Nat) : Prop where
  view : view s o
  inv : Order.inv id o
  ticks : ticks s
  counts : counts o

theorem Drives.of_eq {s s' : State K V} {o : Order.State Nat} (D : Drives s o)
    (e1 : s'.made = s.made) (e2 : s'.due = s.due) (e3 : s'.after = s.after)
    (e4 : s'.values = s.values) : Drives s' o where
  view := ⟨fun p => by rw [e2]; exact D.view.due p, by rw [e3]; exact D.view.after,
    by rw [e4]; exact D.view.values, fun p => by rw [e1]; exact D.view.alive p⟩
  inv := D.inv
  ticks := by intro p t h; rw [e2] at h; exact D.ticks p t h
  counts := D.counts

theorem Drives.frame {s s' : State K V} {o : Order.State Nat} (D : Drives s o) (f : Frame s s')
    (e2 : s'.due = s.due) : Drives s' o := D.of_eq f.made e2 f.after f.values

theorem set_fields (o : Order.State Nat) (p m : Nat) :
    (Order.set id o p m).alive = o.alive ∧ (Order.set id o p m).after = o.after ∧
      (Order.set id o p m).values = o.values ∧ (Order.set id o p m).afters = o.afters ∧
      (Order.set id o p m).due = Order.update o.due p m := by
  unfold Order.set; dsimp only; split <;> exact ⟨rfl, rfl, rfl, rfl, rfl⟩

-- order.set(p, m), from a driven state, as the model's due puts p at m
theorem set_drives {s s' : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    {p m : Nat} (hp : p < s.made) (hm : m ≠ 0) (e1 : s'.made = s.made)
    (e2 : ∀ x, s'.due x = if x = p then some m else s.due x) (e3 : s'.after = s.after)
    (e4 : s'.values = s.values) : calls (Order.set id o p m) ∧ Drives s' (Order.set id o p m) := by
  have ha : o.alive p = true := by rw [D.view.alive]; simpa using hp
  obtain ⟨f1, f2, f3, f4, f5⟩ := set_fields o p m
  refine ⟨.set hc ha hm, ⟨?_, ?_, ?_, ?_⟩, Order.inv_set id D.inv ha hm, ?_, ?_⟩
  · intro x
    rw [f5, e2]
    by_cases hx : x = p
    · subst hx; simp
    · simp [hx, Order.update, D.view.due x]
  · rw [f2, e3]; exact D.view.after
  · rw [f3, e4]; exact D.view.values
  · intro x; rw [f1, e1]; exact D.view.alive x
  · intro x t h
    rw [e2] at h
    by_cases hx : x = p
    · subst hx; simp at h; rw [← h]; exact hm
    · simp [hx] at h; exact D.ticks x t h
  · intro q y
    rw [show Order.cnt (Order.set id o p m) q y = Order.cnt o q y by simp [Order.cnt, f4], f2, f3]
    exact D.counts q y

-- order.delete(p), as the model's due puts p at none: the view, the ticks, the counts
theorem delete_view {s s' : State K V} {o : Order.State Nat} (v : view s o) (ht : ticks s)
    (hcn : counts o) (p : Nat) (e1 : s'.made = s.made) (e2 : s'.due = put s.due p none)
    (e3 : s'.after = s.after) (e4 : s'.values = s.values) :
    view s' (Order.delete o p) ∧ ticks s' ∧ counts (Order.delete o p) := by
  have dd : (Order.delete o p).due = Order.update o.due p 0 := by
    unfold Order.delete; split
    · rename_i h; funext x; simp only [Order.update]; split
      · subst_vars; exact h
      · rfl
    · rfl
  have df : (Order.delete o p).alive = o.alive ∧ (Order.delete o p).values = o.values ∧
      (Order.delete o p).after = o.after ∧ (Order.delete o p).afters = o.afters := by
    unfold Order.delete; split <;> exact ⟨rfl, rfl, rfl, rfl⟩
  refine ⟨⟨?_, ?_, ?_, ?_⟩, ?_, ?_⟩
  · intro x; rw [dd, e2]
    by_cases hx : x = p
    · subst hx; simp
    · simp [Order.update, hx, put_ne _ _ hx, v.due x]
  · rw [df.2.2.1, e3]; exact v.after
  · rw [df.2.1, e4]; exact v.values
  · intro x; rw [df.1, e1]; exact v.alive x
  · intro x t h; rw [e2] at h
    by_cases hx : x = p
    · subst hx; simp at h
    · rw [put_ne _ _ hx] at h; exact ht x t h
  · intro q y
    rw [show Order.cnt (Order.delete o p) q y = Order.cnt o q y by simp [Order.cnt, df.2.2.2],
      df.2.1, df.2.2.1]
    exact hcn q y

theorem delete_drives {s s' : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    (p : Nat) (e1 : s'.made = s.made) (e2 : s'.due = put s.due p none) (e3 : s'.after = s.after)
    (e4 : s'.values = s.values) : calls (Order.delete o p) ∧ Drives s' (Order.delete o p) := by
  obtain ⟨v1, t1, c1⟩ := delete_view D.view D.ticks D.counts p e1 e2 e3 e4
  exact ⟨.delete hc, v1, Order.inv_delete id D.inv p, t1, c1⟩

theorem settle_due_d (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : (settle s d t who l fl).due d = s.due d ∨
      (s.due d = none ∧ (settle s d t who l fl).due d = some t) := by
  unfold settle
  split
  · cases who <;> exact Or.inl rfl
  · dsimp only
    split
    · exact Or.inl rfl
    · unfold Model.due
      split
      · exact Or.inl rfl
      · rename_i h
        right
        refine ⟨?_, by simp [say]⟩
        cases e : s.due d with
        | none => rfl
        | some _ => simp [e] at h

theorem mark_due_d (s : State K V) (d t : Nat) (who : Option Nat) :
    (mark s d t who).due d = s.due d ∨ (s.due d = none ∧ (mark s d t who).due d = some t) := by
  cases who with
  | none => exact settle_due_d _ _ _ _ _ _
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    simp only []
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    rw [hk]
    exact settle_due_d _ _ _ _ _ _

-- a mark at a tick: order.set(d, t) when d was not due and is now, else no call
theorem mark_order {s : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o) {d : Nat}
    (hd : d < s.made) (t : Nat) (ht : t ≠ 0) (who : Option Nat) :
    ∃ o', calls o' ∧ Drives (mark s d t who) o' := by
  have f := mark_frame s d t who
  rcases mark_due_d s d t who with e | ⟨-, e⟩
  · refine ⟨o, hc, D.of_eq f.made ?_ f.after f.values⟩
    funext x
    by_cases hx : x = d
    · subst hx; exact e
    · exact mark_due s d t who x hx
  · refine ⟨Order.set id o d t, set_drives (m := t) D hc hd ht f.made ?_ f.after f.values⟩
    intro x
    by_cases hx : x = d
    · subst hx; simp [e]
    · simp [hx, mark_due s d t who x hx]

theorem marks_order (t : Nat) (ht : t ≠ 0) (r : Option Nat) :
    ∀ (ds : List Nat) (s : State K V) (o : Order.State Nat), Drives s o → calls o →
      (∀ d ∈ ds, d < s.made) → ∃ o', calls o' ∧ Drives (ds.foldl (fun s d => mark s d t r) s) o'
  | [], s, o, D, hc, _ => ⟨o, hc, D⟩
  | d :: ds, s, o, D, hc, hd => by
    obtain ⟨o1, hc1, D1⟩ := mark_order D hc (hd d (by simp)) t ht r
    exact marks_order t ht r ds _ o1 D1 hc1
      (by rw [(mark_frame s d t r).made]; exact fun x hx => hd x (by simp [hx]))

theorem changed_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) (keys : List K) (who : Option Nat) :
    ∃ o', calls o' ∧ Drives (changed cs s keys who) o' := by
  simp only [changed]
  have ht0 : s.tick + 1 ≠ 0 := Nat.succ_ne_zero _
  generalize ht : s.tick + 1 = t at ht0
  have D0 : Drives { s with tick := t } o := D.of_eq rfl rfl rfl rfl
  generalize runof { s with tick := t } who = r
  generalize (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have fold : ∀ (ks : List K) (s1 : State K V) (o1 : Order.State Nat), Drives s1 o1 → calls o1 →
      ∃ o', calls o' ∧ Drives (ks.foldl (fun s k => tell (learn s k w) k t r) s1) o' := by
    intro ks
    induction ks with
    | nil => intro s1 o1 D1 hc1; exact ⟨o1, hc1, D1⟩
    | cons k ks ih =>
      intro s1 o1 D1 hc1
      simp only [List.foldl_cons]
      have Dl : Drives (learn s1 k w) o1 := by cases w <;> exact D1.of_eq rfl rfl rfl rfl
      obtain ⟨o2, hc2, D2⟩ := marks_order t ht0 r (readers (learn s1 k w) k) _ o1 Dl hc1
        (fun d hd => readers_made hd)
      exact ih _ o2 D2 hc2
  exact fold keys _ o D0 hc

-- a wake: its attended compute (made) marked at the next tick: order.set
theorem wake_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) (k : K) : ∃ o', calls o' ∧ Drives (wake cs s k) o' := by
  unfold wake
  cases ha : attending cs s.made k with
  | none => exact ⟨o, hc, D⟩
  | some a =>
    simp only
    split
    · exact mark_order (s := { s with
        asleep := put s.asleep a false, writers := put s.writers k (some a), tick := s.tick + 1 })
        (D.of_eq rfl rfl rfl rfl) hc
        (by simpa using attending_lt ha) _ (Nat.succ_ne_zero _) none
    · exact ⟨o, hc, D⟩

theorem wakes_order (cs : Nat → Comp K V) : ∀ (ws : List K) (s : State K V) (o : Order.State Nat),
    Drives s o → calls o → ∃ o', calls o' ∧ Drives (wakes cs s ws) o'
  | [], s, o, D, hc => ⟨o, hc, D⟩
  | k :: ws, s, o, D, hc => by
    obtain ⟨o1, hc1, D1⟩ := wake_order cs D hc k
    exact wakes_order cs ws _ o1 D1 hc1

-- sees keeps afters counting every edge
theorem counts_sees {o : Order.State Nat} {rk : Order.Rk Nat} {all : List Nat}
    (hi : Order.inv id o) (hc : counts o)
    (p : Nat) {l : List Nat} (hn : l.Nodup) : counts (Order.sees id rk all o p l) := by
  obtain ⟨a, vf, f, -, cn⟩ := Order.sees_eq id rk all o p l hn (hi.nodup p) hi.stamped
  intro q y
  rw [cn, vf, f]
  have h0 := hc q
  by_cases hy : y = p
  · subst hy
    simp only [Order.update_same, true_and]
    have := h0 y
    by_cases h1 : q ∈ l <;> by_cases h2 : q ∈ o.values y <;> simp [h1, h2] at this ⊢ <;> omega
  · simp only [hy, false_and, ↓reduceIte, Order.update_ne _ _ hy]; exact h0 y

-- waits keeps afters counting every edge
theorem counts_waits {o : Order.State Nat} {rk : Order.Rk Nat} {all : List Nat} (hc : counts o)
    (p : Nat) (w : Option Nat) : counts (Order.waits id rk all o p w) := by
  obtain ⟨a, vf, f, -, cn⟩ := Order.waits_eq id rk all o p w
  intro q y
  rw [cn, vf, f]
  have h0 := hc q
  by_cases hy : y = p
  · subst hy
    simp only [Order.update_same, true_and]
    have := h0 y
    by_cases h1 : w = some q <;> by_cases h2 : o.after y = some q <;> simp [h1, h2] at this ⊢ <;>
      omega
  · simp only [hy, false_and, ↓reduceIte, Order.update_ne _ _ hy]; exact h0 y

-- order.sees(c, l), as the model's values put c at l
theorem sees_drives {s s' : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    (c : Nat) {l : List Nat} (hn : l.Nodup) (e1 : s'.made = s.made) (e2 : s'.due = s.due)
    (e3 : s'.after = s.after) (e4 : s'.values = put s.values c l) :
    calls (Order.sees id (ork s) (List.range s.made) o c l) ∧
      Drives s' (Order.sees id (ork s) (List.range s.made) o c l) := by
  obtain ⟨a, vf, f, du, -⟩ := Order.sees_eq id (ork s) (List.range s.made) o c l hn
    (D.inv.nodup c) D.inv.stamped
  refine ⟨.sees _ _ hc hn, ⟨⟨?_, ?_, ?_, ?_⟩, ?_, ?_, counts_sees D.inv D.counts c hn⟩⟩
  · intro p; rw [du, e2]; exact D.view.due p
  · rw [f, e3]; exact D.view.after
  · rw [vf, e4, D.view.values]; funext x; simp only [Order.update, put]
  · intro p; rw [a, e1]; exact D.view.alive p
  · exact Order.inv_sees id D.inv (sound_view D.view) (all_view D.view) c hn
  · intro p t h; rw [e2] at h; exact D.ticks p t h

-- order.waits(c, q), as the model's after puts c at q
theorem waits_drives {s s' : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    (c : Nat) (q : Option Nat) (e1 : s'.made = s.made) (e2 : s'.due = s.due)
    (e3 : s'.after = put s.after c q) (e4 : s'.values = s.values) :
    calls (Order.waits id (ork s) (List.range s.made) o c q) ∧
      Drives s' (Order.waits id (ork s) (List.range s.made) o c q) := by
  obtain ⟨a, vf, f, du, -⟩ := Order.waits_eq id (ork s) (List.range s.made) o c q
  refine ⟨.waits _ _ hc, ⟨⟨?_, ?_, ?_, ?_⟩, ?_, ?_, counts_waits D.counts c q⟩⟩
  · intro p; rw [du, e2]; exact D.view.due p
  · rw [f, e3, D.view.after]; funext x; simp only [Order.update, put]
  · rw [vf, e4]; exact D.view.values
  · intro p; rw [a, e1]; exact D.view.alive p
  · exact Order.inv_waits id D.inv (sound_view D.view) (all_view D.view) c q
  · intro p t h; rw [e2] at h; exact D.ticks p t h

-- finish: order.sees(c, r.values) unless stopped
theorem finish_order {s : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    {c : Nat} (hv : ∀ r, s.ran c = some r → r.values.Nodup) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) :
    ∃ o', calls o' ∧ Drives (finish s c e eq w th) o' := by
  cases hrc : s.ran c with
  | none => simp only [Model.finish, hrc]; exact ⟨o, hc, D⟩
  | some r =>
    obtain ⟨e, _, -, hfin⟩ := finish_any s c r hrc e eq w th
    rw [hfin]
    by_cases hs : e = .stopped
    · subst hs; exact ⟨o, hc, D.of_eq rfl rfl rfl (by simp)⟩
    · obtain ⟨h1, h2⟩ := sees_drives (s' := { s with
        values := if e ≠ .stopped then put s.values c r.values else s.values,
        ran := put s.ran c (some { r with ended := some e }) }) D hc c (hv r hrc) rfl rfl rfl
        (by simp [hs])
      refine ⟨_, h1, ?_⟩
      exact h2.of_eq rfl rfl rfl rfl

theorem result_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) {c : Nat} (hv : ∀ r, s.ran c = some r → r.values.Nodup) (x : V) :
    ∃ o', calls o' ∧ Drives (result cs s c x) o' := by
  have f := set_frame cs s c x
  obtain ⟨o1, hc1, D1⟩ : ∃ o', calls o' ∧ Drives (set cs s c x) o' := by
    simp only [Model.set]
    split
    · refine changed_order cs ?_ hc _ _
      exact D.of_eq rfl rfl rfl rfl
    · exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
  unfold Model.result
  dsimp only
  repeat' split
  all_goals first
    | exact finish_order D hc hv _ _ _ _
    | (refine finish_order ?_ hc ?_ _ _ _ _
       · exact D.of_eq rfl rfl rfl rfl
       · exact hv)
    | (refine finish_order ?_ hc1 ?_ _ _ _ _
       · exact D1.of_eq rfl rfl rfl rfl
       · show ∀ r, (set cs s c x).ran c = some r → r.values.Nodup
         rw [f.ran]; exact hv)

-- a run's end: stop is order.waits(c, w) then order.set(c, mark); else finish
theorem ending_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) {c : Nat} (hcm : c < s.made) (hv : ∀ r, s.ran c = some r → r.values.Nodup)
    (hmk : ∀ r, s.ran c = some r → r.mark ≠ 0) (out : Out V) :
    ∃ o', calls o' ∧ Drives (ending cs s c out) o' := by
  unfold Model.ending
  split
  · unfold Model.stop
    split
    · exact ⟨o, hc, D⟩
    · rename_i r hr
      dsimp only
      obtain ⟨hcw, Dw⟩ := waits_drives (s' := { s with after := put s.after c r.stopped }) D hc c
        r.stopped rfl rfl rfl rfl
      have key : ∀ X : State K V, X.made = s.made → X.due = put s.due c (some r.mark) →
          X.after = put s.after c r.stopped → X.values = s.values →
          (∀ r', X.ran c = some r' → r'.values.Nodup) →
          ∃ o', calls o' ∧ Drives (finish X c .stopped none r.stopped none) o' := by
        intro X e1 e2 e3 e4 hX
        obtain ⟨hc2, D2⟩ := set_drives (m := r.mark) (s' := X) Dw hcw hcm (hmk r hr) e1
          (fun x => by rw [e2]; rfl) e3 e4
        exact finish_order D2 hc2 hX _ _ _ _
      split
      · exact key _ rfl rfl rfl rfl hv
      · exact key _ rfl rfl rfl rfl hv
  · have D1 : Drives (edit s c fun r => { r with out := some out }) o := D.of_eq rfl rfl rfl rfl
    have hv1 : ∀ r, (edit s c fun r => { r with out := some out }).ran c = some r →
        r.values.Nodup := by
      intro r hr'
      simp only [edit, put_same, Option.map_eq_some_iff] at hr'
      obtain ⟨r0, h0, rfl⟩ := hr'
      exact hv r0 h0
    split
    · exact finish_order D1 hc hv1 _ _ _ _
    · exact finish_order D1 hc hv1 _ _ _ _
    · exact result_order cs D1 hc hv1 _

-- a run of c, due and made, from o0 whose delete of c drives start's dues: first's
-- order.delete(c) and order.waits(c, undefined), its wakes' sets, and its end
theorem run_order (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {o0 : Order.State Nat}
    (v0 : view s o0) (ht : ticks s) (hcn : counts o0) {c : Nat}
    (hi1 : Order.inv id (Order.delete o0 c)) (hc1 : calls (Order.delete o0 c))
    (hw : ∀ k w, s.writers k = some w → w < s.made) (hrm : ∀ x, (s.ran x).isSome → x < s.made)
    (hcm : c < s.made) (hd : (s.due c).isSome) (rk : Nat) :
    ∃ o', calls o' ∧ Drives (first cs s c rk) o' := by
  obtain ⟨v1, t1, c1⟩ := delete_view (s' := { s with due := put s.due c none }) v0 ht hcn c rfl
    rfl rfl rfl
  have D1 : Drives { s with due := put s.due c none } (Order.delete o0 c) := ⟨v1, hi1, t1, c1⟩
  obtain ⟨hc2, D2⟩ := waits_drives (s' := start s c rk) D1 hc1 c none (by simp [start, say])
    (by simp [start, say]) (by simp [start, say]) (by simp [start, say])
  obtain ⟨o, seen, vals, st, ws, X, hf, e5, hX, hv⟩ := first_eq cs s c rk (hA c) hw hrm hcm
  obtain ⟨e1, e2, e3, e4, -⟩ := first_fields hX
  obtain ⟨o3, hc3, D3⟩ := wakes_order cs ws _ _ D2 hc2
  have fW := wakes_frame cs ws (start s c rk)
  have D4 : Drives X o3 := D3.of_eq e1 e2 e3 e4
  rw [fW.made] at e1
  simp only [start, say] at e1
  rw [hf]
  refine ending_order cs D4 hc3 (by rw [e1]; exact hcm) ?_ ?_ o
  · intro r hr
    rw [e5] at hr
    simp only [put_same, Option.some.injEq] at hr
    subst hr
    exact hv.1
  · intro r hr
    rw [e5] at hr
    simp only [put_same, Option.some.injEq] at hr
    subst hr
    obtain ⟨t, ht'⟩ := Option.isSome_iff_exists.1 hd
    simp [begun, ht', ht c t ht']

-- a run step: c = order.next() with its rank, then first's calls (run_order)
theorem first_order (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {o : Order.State Nat}
    (D : Drives s o) (hc : calls o) (g : Core cs s) {c : Nat}
    (hn : next (fun _ => oranks s o) s = some c) :
    (Order.next id (ork s) (List.range s.made) o).1 = some (c, oranks s o c) ∧
      ∃ o', calls o' ∧ Drives (first cs s c (oranks s o c)) o' := by
  have hns := next_same D.view D.ticks D.inv
  rw [hn] at hns
  simp only [Option.map_some] at hns
  refine ⟨hns, ?_⟩
  have hc2 : calls (Order.delete (Order.next id (ork s) (List.range s.made) o).2 c) :=
    calls.next (List.range s.made) (List.range s.made) hc hns
  obtain ⟨k1, k2, k3, k4, k5, g2⟩ := Order.inv_next id D.inv (sound_view D.view) (all_view D.view)
  simp only [hns] at g2
  generalize ho1 : (Order.next id (ork s) (List.range s.made) o).2 = o1 at k1 k2 k3 k4 k5 g2 hc2
  have v1 : view s o1 := ⟨fun p => by rw [k4]; exact D.view.due p, by rw [k3]; exact D.view.after,
    by rw [k2]; exact D.view.values, fun p => by rw [k1]; exact D.view.alive p⟩
  have hcn : counts o1 := by
    intro q y
    rw [show Order.cnt o1 q y = Order.cnt o q y by simp [Order.cnt, k5], k2, k3]
    exact D.counts q y
  have hd : (s.due c).isSome := (next_ready hn).1 |> fun h => by
    simp only [ready, Bool.and_eq_true] at h; exact h.1
  exact run_order cs hA v1 D.ticks hcn g2 hc2 g.writers_made g.ran_made (next_ready hn).2 hd _

-- an act: its writes' marks
theorem act_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) (e : Nat) (x : V) : ∃ o', calls o' ∧ Drives (act cs s e x) o' := by
  have fold : ∀ (ws : List (K × V)) (s1 : State K V) (o1 : Order.State Nat), Drives s1 o1 →
      calls o1 →
      ∃ o', calls o' ∧ Drives (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e))
        s1) o' := by
    intro ws
    induction ws with
    | nil => intro s1 o1 D1 hc1; exact ⟨o1, hc1, D1⟩
    | cons kv ws ih =>
      intro s1 o1 D1 hc1
      simp only [List.foldl_cons]
      obtain ⟨o2, hc2, D2⟩ := changed_order cs (s := store s1 kv.1 kv.2)
        (D1.of_eq rfl rfl rfl rfl) hc1 [kv.1] (some e)
      exact ih _ o2 D2 hc2
  unfold Model.act
  dsimp only
  split
  · exact ⟨o, hc, D⟩
  · split
    · exact ⟨o, hc, D⟩
    · rename_i g _
      obtain ⟨o1, hc1, D1⟩ := fold (g x (s.last e)) (say s (.act e x (s.last e))) o
        (D.of_eq rfl rfl rfl rfl) hc
      exact ⟨o1, hc1, D1.of_eq rfl rfl rfl rfl⟩

-- a going: order.delete(d), its teardowns' writes, order.sees(d, []), order.waits(d, undefined)
theorem bury_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) (d : Nat) : ∃ o', calls o' ∧ Drives (bury cs s d) o' := by
  unfold Model.bury
  split
  · exact ⟨o, hc, D⟩
  · split
    · exact ⟨o, hc, D⟩
    · obtain ⟨hc1, D1⟩ := delete_drives (s' := { s with due := put s.due d none }) D hc d rfl rfl
        rfl rfl
      have fold : ∀ (ws : List (K × V)) (s1 : State K V) (o1 : Order.State Nat), Drives s1 o1 →
          calls o1 → ∃ o', calls o' ∧
            Drives (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some d)) s1) o' := by
        intro ws
        induction ws with
        | nil => intro s1 o1 D1 hc1; exact ⟨o1, hc1, D1⟩
        | cons kv ws ih =>
          intro s1 o1 D1 hc1
          simp only [List.foldl_cons]
          obtain ⟨o2, hc2, D2⟩ := changed_order cs (s := store s1 kv.1 kv.2)
            (D1.of_eq rfl rfl rfl rfl) hc1 [kv.1] (some d)
          exact ih _ o2 D2 hc2
      obtain ⟨o2, hc2, D2⟩ := fold (cs d).goes _ _ D1 hc1
      simp only
      generalize (cs d).goes.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some d))
        { s with due := put s.due d none } = Y at D2 ⊢
      obtain ⟨hc3, D3⟩ := sees_drives (s' := { Y with values := put Y.values d [] }) D2 hc2 d
        List.nodup_nil rfl rfl rfl rfl
      obtain ⟨hc4, D4⟩ := waits_drives (s' := { Y with
        values := put Y.values d [], after := put Y.after d none }) D3 hc3 d none rfl rfl rfl rfl
      exact ⟨_, hc4, D4.of_eq (by simp) (by simp) (by simp) (by simp)⟩

-- make: order.started(c) on the new c (fresh), then (awake) its mark; an early effect's first run
-- (first's calls, after a delete) and act
theorem make_order (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {o : Order.State Nat}
    (D : Drives s o) (hc : calls o) (g : Core cs s) (hf : Order.fresh o s.made) :
    ∃ o', calls o' ∧ Drives (make cs s) o' := by
  have sa : (Order.started o s.made).alive = Order.update o.alive s.made true ∧
      (Order.started o s.made).values = o.values ∧ (Order.started o s.made).after = o.after ∧
      (Order.started o s.made).due = o.due ∧ (Order.started o s.made).afters = o.afters := by
    unfold Order.started; dsimp only; split <;> exact ⟨rfl, rfl, rfl, rfl, rfl⟩
  have eg : (Model.grow cs s).made = s.made + 1 ∧ (Model.grow cs s).due = s.due ∧
      (Model.grow cs s).after = s.after ∧ (Model.grow cs s).values = s.values ∧
      (Model.grow cs s).ran = s.ran ∧
      (∀ k w, (Model.grow cs s).writers k = some w → w < s.made + 1) := by
    simp only [Model.grow]
    split
    · rename_i k _
      refine ⟨rfl, rfl, rfl, rfl, rfl, fun k' w h => ?_⟩
      by_cases e : k' = k
      · subst e; simp at h; omega
      · simp [put_ne _ _ e] at h; have := g.writers_made k' w h; omega
    · exact ⟨rfl, rfl, rfl, rfl, rfl, fun k w h => by have := g.writers_made k w h; omega⟩
  have D1 : ∀ s1 : State K V, s1.made = s.made + 1 → s1.due = s.due → s1.after = s.after →
      s1.values = s.values → Drives s1 (Order.started o s.made) := by
    intro s1 e1 e2 e3 e4
    refine ⟨⟨?_, ?_, ?_, ?_⟩, Order.inv_started id D.inv hf, ?_, ?_⟩
    · intro p; rw [sa.2.2.2.1, e2]; exact D.view.due p
    · rw [sa.2.2.1, e3]; exact D.view.after
    · rw [sa.2.1, e4]; exact D.view.values
    · intro p
      rw [sa.1, e1]
      simp only [Order.update]
      split
      · rename_i h; subst h; simp
      · rename_i h; rw [D.view.alive]; simp only [decide_eq_decide]; omega
    · intro p t hp; rw [e2] at hp; exact D.ticks p t hp
    · intro q y
      rw [show Order.cnt (Order.started o s.made) q y = Order.cnt o q y by
        simp [Order.cnt, sa.2.2.2.2], sa.2.1, sa.2.2.1]
      exact D.counts q y
  have hc1 : calls (Order.started o s.made) := .started hc hf
  have Dg := D1 _ eg.1 eg.2.1 eg.2.2.1 eg.2.2.2.1
  unfold Model.make
  dsimp only
  split
  · exact ⟨_, hc1, Dg.of_eq rfl rfl rfl rfl⟩
  · obtain ⟨o2, hc2, D2⟩ := mark_order Dg hc1 (d := s.made) (by rw [eg.1]; omega)
      (Model.grow cs s).tick (by simp only [Model.grow]; split <;> simp) none
    have fm := mark_frame (Model.grow cs s) s.made (Model.grow cs s).tick none
    split
    · have hlt : s.made < (Model.grow cs s).made := by rw [eg.1]; omega
      have hd : ((mark (Model.grow cs s) s.made (Model.grow cs s).tick none).due s.made).isSome := by
        rcases (mark_moves (Model.grow cs s) s.made (Model.grow cs s).tick none hlt (by simp)).2
          with h | h
        · exact h
        · have e : (Model.grow cs s).looping = s.looping := by
            simp only [Model.grow]; split <;> rfl
          rw [e] at h
          obtain ⟨_, r, h1, _⟩ := g.looping s.made h
          have := g.ran_made s.made (by simp [h1]); omega
      obtain ⟨o3, hc3, D3⟩ := run_order cs hA D2.view D2.ticks D2.counts
        (Order.inv_delete id D2.inv s.made) (.delete hc2)
        (by
          intro k w h
          rw [mark_writers] at h; rw [fm.made, eg.1]; exact eg.2.2.2.2.2 k w h)
        (by
          intro x hx
          rw [fm.ran, eg.2.2.2.2.1] at hx; rw [fm.made, eg.1]
          have := g.ran_made x hx; omega)
        (by rw [fm.made]; exact hlt) hd 0
      simp only [actnow]
      split
      · refine act_order cs ?_ hc3 _ _
        exact D3.of_eq rfl rfl rfl rfl
      · exact ⟨o3, hc3, D3⟩
    · exact ⟨o2, hc2, D2⟩

-- a step of a pulse, with the order's ranks
theorem step_order (cs : Nat → Comp K V) (hA : A2 cs) {s s' : State K V} {o : Order.State Nat}
    (g : Core cs s) (D : Drives s o) (hc : calls o)
    (hs : step cs (fun _ => oranks s o) s = some s') : ∃ o', calls o' ∧ Drives s' o' := by
  unfold Model.step at hs
  split at hs
  · split at hs
    · rename_i c hn
      cases hs
      exact (first_order cs hA D hc g hn).2
    · cases hs; exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
  · split at hs
    · cases hs
      refine act_order cs ?_ hc _ _; exact D.of_eq rfl rfl rfl rfl
    · split at hs
      · cases hs
        refine act_order cs ?_ hc _ _; exact D.of_eq rfl rfl rfl rfl
      · split at hs
        · cases hs; exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
        · split at hs
          · cases hs
          · cases hs; exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
  · split at hs
    · cases hs
      refine bury_order cs ?_ hc _; exact D.of_eq rfl rfl rfl rfl
    · cases hs; exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩

theorem drives_init : Drives (empty : State K V) (Order.init : Order.State Nat) where
  view := ⟨fun p => by simp [Order.init, Model.empty], by rfl, by rfl,
    fun p => by simp [Order.init, Model.empty]⟩
  inv := Order.inv_init id
  ticks := fun p t h => by simp [Model.empty] at h
  counts := fun q y => by simp [Order.cnt, Order.init]

-- the states the host and the pulses reach when each run is picked by an order state the
-- scheduler's calls reach and that drives the model (Quiescence.lean's Reach, its ranks the
-- order's, not one function of the model's state: the order's ranks are mended, not made whole)
inductive OReach (cs : Nat → Comp K V) : State K V → Prop
  | empty : OReach cs empty
  | make {s} : OReach cs s → OReach cs (make cs s)
  | write {s} (kvs : List (K × V)) : OReach cs s → OReach cs (write cs s kvs)
  | tell {s} (keys : List K) : OReach cs s → OReach cs (changed cs s keys none)
  | begin {s} : OReach cs s → OReach cs (begin s)
  | step {s s'} (o : Order.State Nat) : OReach cs s → calls o → Drives s o →
      step cs (fun _ => oranks s o) s = some s' → OReach cs s'
  | close {s} (rk : State K V → Nat → Nat) : OReach cs s → step cs rk s = none →
      OReach cs (close s)

-- Quiescence.lean's invariant and the asleep's (A2) on these, and Vals
theorem OReach.inv {cs : Nat → Comp K V} {s : State K V} (hA : A2 cs) (h : OReach cs s) :
    Good cs s ∧ Sleeps s ∧ Vals s := by
  induction h with
  | empty =>
    exact ⟨Good.empty cs, Sleeps.empty, fun _ _ => rfl, fun _ => ⟨List.nodup_nil, by simp [Model.empty]⟩,
      fun _ _ h => by simp [Model.empty] at h⟩
  | make _ ih => exact ⟨ih.1.make hA, ih.2.1.make ih.1.toCore hA, ih.2.2.make hA ih.1.toCore⟩
  | write kvs _ ih =>
    obtain ⟨st, e, -⟩ := stores_shape _ kvs
    refine ⟨?_, ?_, ?_⟩
    · have := ih.1.told kvs none (by simp); exact this
    · unfold Model.write; refine Sleeps.changed ?_ _ _; rw [e]; exact ih.2.1.of_eq rfl rfl rfl rfl
    · unfold Model.write; refine Vals.frame ?_ (changed_frame _ _ _ _)
      rw [e]; exact ih.2.2.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  | tell keys _ ih => exact ⟨ih.1.tell keys none (by simp), ih.2.1.changed keys none,
      ih.2.2.frame (changed_frame ..)⟩
  | begin _ ih => exact ⟨ih.1.begin, ih.2.1.of_eq rfl rfl rfl rfl,
      ih.2.2.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩⟩
  | step o _ _ _ h ih => exact ⟨ih.1.step ih.2.1 hA h, ih.2.1.step hA h, ih.2.2.step hA ih.1.toCore h⟩
  | close _ _ _ ih => exact ⟨ih.1.close, ih.2.1.of_eq rfl rfl rfl rfl, ih.2.2.close⟩

-- 2, all the way: on every such state (A2), an order state reached from createOrder by the
-- scheduler's calls (each meeting Order.lean's precondition) is the model's view and keeps what
-- order keeps
theorem reach_order {cs : Nat → Comp K V} {s : State K V} (hA : A2 cs) (h : OReach cs s) :
    ∃ o, calls o ∧ Drives s o := by
  induction h with
  | empty => exact ⟨_, .init, drives_init⟩
  | @make s hs ih =>
    obtain ⟨o, hc, D⟩ := ih
    have I := hs.inv hA
    exact make_order cs hA D hc I.1.toCore (started_fresh I.1.toCore I.2.2 D.view D.counts)
  | write kvs _ ih =>
    obtain ⟨o, hc, D⟩ := ih
    obtain ⟨st, e, -⟩ := stores_shape _ kvs
    unfold Model.write
    rw [e]
    refine changed_order cs ?_ hc _ none
    exact D.of_eq rfl rfl rfl rfl
  | tell keys _ ih =>
    obtain ⟨o, hc, D⟩ := ih
    exact changed_order cs D hc keys none
  | begin _ ih =>
    obtain ⟨o, hc, D⟩ := ih
    exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
  | step o hs hc D h _ => exact step_order cs hA (hs.inv hA).1.toCore D hc h
  | close _ _ _ ih =>
    obtain ⟨o, hc, D⟩ := ih
    exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩

-- the headline of 2: on every such state, order.ts's next on an order the scheduler's calls drove
-- answers the model's next with the order's ranks, and those ranks are ranked over the model's
-- edges (Basic.lean: so next_below's hypothesis holds of them)
theorem next_reach {cs : Nat → Comp K V} {s : State K V} (hA : A2 cs) (h : OReach cs s) :
    ∃ o, calls o ∧ Drives s o ∧
      (Order.next id (ork s) (List.range s.made) o).1 =
        (next (fun _ => oranks s o) s).map (fun p => (p, oranks s o p)) ∧
      ranked (fun p q => q ∈ edges s p) (oranks s o) := by
  obtain ⟨o, hc, D⟩ := reach_order hA h
  have I := h.inv hA
  exact ⟨o, hc, D, next_same D.view D.ticks D.inv,
    oranks_ranked D.view D.inv fun _ hp => edges_out I.2.2 I.1.toCore hp⟩

/-! ## 3. causes: the model's cause values on Causes.lean's heap -/

-- plain: its runs by computation only (Model.lean); behind: a cause and every cause behind it

theorem plain_mk (o : Nat × Nat) (ps : List Why) : plain (.mk o ps) = .mk o.1 (ps.map plain) := by
  rw [plain]; simp

theorem plain_of (k : Why) : (plain k).of = k.of.1 := by
  cases k; rw [plain_mk]; rfl

-- what is behind a cause is the ancestry of its plain one (Causes.lean, anc)
theorem behind_anc : ∀ (k y : Why), y ∈ behind k → Causes.anc (plain k) (plain y)
  | .mk o ps, y, h => by
    simp only [behind, List.mem_cons, List.mem_flatten, List.mem_map] at h
    rcases h with rfl | ⟨l, ⟨⟨p, hp⟩, _, rfl⟩, hy⟩
    · exact .refl _
    · refine .step (p := plain p) ?_ (behind_anc p y hy)
      rw [plain_mk]
      exact List.mem_map_of_mem hp
termination_by k => sizeOf k
decreasing_by
  simp_wf
  have := List.sizeOf_lt_of_mem hp
  omega

theorem anc_behind {x z : Cause Nat} (ha : Causes.anc x z) :
    ∀ k : Why, x = plain k → ∃ y ∈ behind k, plain y = z := by
  induction ha with
  | refl x => intro k e; exact ⟨k, by cases k; simp [behind], e.symm⟩
  | step hp _ ih =>
    intro k e
    subst e
    obtain ⟨o, ps⟩ := k
    rw [plain_mk] at hp
    simp only [Cause.parents, List.mem_map] at hp
    obtain ⟨p, hp, rfl⟩ := hp
    obtain ⟨y, hy, e⟩ := ih p rfl
    refine ⟨y, ?_, e⟩
    simp only [behind, List.mem_cons, List.mem_flatten, List.mem_map]
    exact Or.inr ⟨behind p, ⟨⟨p, hp⟩, List.mem_attach _ _, rfl⟩, hy⟩

-- the heap extended: what was there stays
def ext (a b : Array (Made Nat)) : Prop := a.size ≤ b.size ∧ ∀ i, i < a.size → b[i]? = a[i]?

theorem ext_refl (a : Array (Made Nat)) : ext a a := ⟨Nat.le_refl _, fun _ _ => rfl⟩

theorem ext_trans {a b c : Array (Made Nat)} (h1 : ext a b) (h2 : ext b c) : ext a c :=
  ⟨Nat.le_trans h1.1 h2.1, fun i hi => (h2.2 i (Nat.lt_of_lt_of_le hi h1.1)).trans (h1.2 i hi)⟩

theorem ext_push (a : Array (Made Nat)) (m : Made Nat) : ext a (a.push m) :=
  ⟨by simp, fun i hi => by simp [Array.getElem?_push, Nat.ne_of_lt hi]⟩

theorem ps_ext {a b : Array (Made Nat)} (e : ext a b) {i : Nat} (hi : i < a.size) :
    Causes.ps b i = Causes.ps a i := by
  simp only [Causes.ps, e.2 i hi]

theorem ofs_ext {a b : Array (Made Nat)} (e : ext a b) {i : Nat} (hi : i < a.size) :
    Causes.ofs b i = Causes.ofs a i := by
  simp only [Causes.ofs, e.2 i hi]

-- an object's unfolding is the same on an extended heap
theorem tree_ext {a b : Array (Made Nat)} (e : ext a b) :
    ∀ (i : Nat) (hi : i < a.size), Causes.tree b i (Nat.lt_of_lt_of_le hi e.1) = Causes.tree a i hi := by
  intro i
  induction i using Nat.strongRecOn with
  | ind i ih =>
    intro hi
    rw [Causes.tree_eq, Causes.tree_eq]
    have h1 : b[i]'(Nat.lt_of_lt_of_le hi e.1) = a[i] := by
      have := e.2 i hi
      rw [Array.getElem?_eq_getElem hi, Array.getElem?_eq_getElem (Nat.lt_of_lt_of_le hi e.1)] at this
      exact Option.some.inj this
    have h2 : Causes.kids b i = Causes.kids a i := by
      simp only [Causes.kids, ps_ext e hi]
    rw [h1]
    congr 1
    rw [h2]
    refine List.map_congr_left fun p _ => ?_
    exact ih p.1 p.2 _

-- two lists related pointwise
inductive pairs {α β : Type} (R : α → β → Prop) : List α → List β → Prop
  | nil : pairs R [] []
  | cons {a b l1 l2} : R a b → pairs R l1 l2 → pairs R (a :: l1) (b :: l2)

theorem pairs.imp {α β : Type} {R S : α → β → Prop} (hrs : ∀ a b, R a b → S a b) :
    ∀ {l1 : List α} {l2 : List β}, pairs R l1 l2 → pairs S l1 l2
  | _, _, .nil => .nil
  | _, _, .cons h t => .cons (hrs _ _ h) (pairs.imp hrs t)

theorem pairs.append {α β : Type} {R : α → β → Prop} :
    ∀ {l1 : List α} {l2 : List β} {m1 : List α} {m2 : List β}, pairs R l1 l2 → pairs R m1 m2 →
      pairs R (l1 ++ m1) (l2 ++ m2)
  | _, _, _, _, .nil, h => h
  | _, _, _, _, .cons a t, h => .cons a (pairs.append t h)

theorem pairs.filter {α β : Type} {R : α → β → Prop} {p : α → Bool} {q : β → Bool}
    (hpq : ∀ a b, R a b → p a = q b) :
    ∀ {l1 : List α} {l2 : List β}, pairs R l1 l2 → pairs R (l1.filter p) (l2.filter q)
  | _, _, .nil => .nil
  | _, _, .cons (a := a) (b := b) h t => by
    simp only [List.filter_cons, hpq a b h]
    split
    · exact .cons h (pairs.filter hpq t)
    · exact pairs.filter hpq t

theorem pairs.exists {α β : Type} {R : α → β → Prop} {P : α → Prop} {Q : β → Prop}
    (hpq : ∀ a b, R a b → (P a ↔ Q b)) :
    ∀ {l1 : List α} {l2 : List β}, pairs R l1 l2 → ((∃ a ∈ l1, P a) ↔ (∃ b ∈ l2, Q b))
  | _, _, .nil => by simp
  | _, _, .cons h t => by
    simp only [List.mem_cons, exists_eq_or_imp]
    exact or_congr (hpq _ _ h) (pairs.exists hpq t)

-- the last of each: both none, or related
theorem pairs.last {α β : Type} {R : α → β → Prop} :
    ∀ {l1 : List α} {l2 : List β}, pairs R l1 l2 →
      (l1.getLast? = none ∧ l2.getLast? = none) ∨
        ∃ a b, l1.getLast? = some a ∧ l2.getLast? = some b ∧ R a b
  | _, _, .nil => .inl ⟨rfl, rfl⟩
  | _, _, .cons (a := a) (b := b) h t => by
    right
    rcases pairs.last t with ⟨e1, e2⟩ | ⟨a', b', e1, e2, h'⟩
    · exact ⟨a, b, by simp [List.getLast?_cons, e1], by simp [List.getLast?_cons, e2], h⟩
    · exact ⟨a', b', by simp [List.getLast?_cons, e1], by simp [List.getLast?_cons, e2], h'⟩

-- each of the second is related to one of the first
theorem pairs.right {α β : Type} {R : α → β → Prop} :
    ∀ {l1 : List α} {l2 : List β}, pairs R l1 l2 → ∀ b ∈ l2, ∃ a ∈ l1, R a b
  | _, _, .nil => by simp
  | _, _, .cons (a := a) h t => by
    intro b hb
    rcases List.mem_cons.1 hb with rfl | hb
    · exact ⟨a, List.mem_cons_self, h⟩
    · obtain ⟨a', ha', h'⟩ := pairs.right t b hb
      exact ⟨a', List.mem_cons_of_mem _ ha', h'⟩

theorem pairs.empty {α β : Type} {R : α → β → Prop} {l1 : List α} {l2 : List β} (h : pairs R l1 l2) :
    l1 = [] ↔ l2 = [] := by
  cases h <;> simp

-- object i of the heap stands for the model's cause k: made this pulse, unfolding to k's plain
-- one (Basic.lean's Cause, by computation), labelled with k's run (computation, run number)
def names (h : Causes Nat) (lab : Nat → Nat × Nat) (k : Why) (i : Nat) : Prop :=
  h.since ≤ i ∧ ∃ hi : i < h.heap.size, Causes.tree h.heap i hi = plain k ∧ lab i = k.of

-- (h, lab) grown to (h', lab'): the heap extended, since the same, the labels kept
structure grows (h : Causes Nat) (lab : Nat → Nat × Nat) (h' : Causes Nat)
    (lab' : Nat → Nat × Nat) : Prop where
  heap : ext h.heap h'.heap
  since : h'.since = h.since
  lab : ∀ i, i < h.heap.size → lab' i = lab i

theorem grows_refl (h : Causes Nat) (lab : Nat → Nat × Nat) : grows h lab h lab :=
  ⟨ext_refl _, rfl, fun _ _ => rfl⟩

theorem grows_trans {h h' h'' : Causes Nat} {lab lab' lab'' : Nat → Nat × Nat}
    (g1 : grows h lab h' lab') (g2 : grows h' lab' h'' lab'') : grows h lab h'' lab'' :=
  ⟨ext_trans g1.heap g2.heap, g2.since.trans g1.since,
    fun i hi => (g2.lab i (Nat.lt_of_lt_of_le hi g1.heap.1)).trans (g1.lab i hi)⟩

theorem names_grows {h h' : Causes Nat} {lab lab' : Nat → Nat × Nat} (g : grows h lab h' lab')
    {k : Why} {i : Nat} (n : names h lab k i) : names h' lab' k i := by
  obtain ⟨h1, hi, h2, h3⟩ := n
  refine ⟨g.since ▸ h1, Nat.lt_of_lt_of_le hi g.heap.1, ?_, (g.lab i hi).trans h3⟩
  rw [tree_ext g.heap i hi]; exact h2

theorem pairs_grows {h h' : Causes Nat} {lab lab' : Nat → Nat × Nat} (g : grows h lab h' lab')
    {l1 : List Why} {l2 : List Nat} (hl : pairs (names h lab) l1 l2) :
    pairs (names h' lab') l1 l2 :=
  hl.imp fun _ _ n => names_grows g n

-- the model's causes (cause, when, went, kept) against a heap h of causes.ts's, labelled by lab
structure Mirror (s : State K V) (h : Causes Nat) (lab : Nat → Nat × Nat) : Prop where
  -- causes.ts ranIn: the computations that ran this pulse
  ran : ∀ c, s.went c = true ↔ h.ranIn c = h.pulse
  -- a run given causes (first: taken from c.kept) is of one held this pulse: finish gives them
  -- back in the pulse they were taken in
  given : ∀ c r, s.ran c = some r → r.given ≠ [] → h.heldIn c = h.pulse
  -- every object is of a made computation
  made : ∀ i a, Causes.ofs h.heap i = some a → a < s.made
  -- a computation's cause, when of this pulse, is an object made this pulse
  cause : ∀ c, (s.ran c).isSome → s.when c = s.pulses → ∃ i, names h lab (s.cause c) i
  -- the kept causes are the kept objects, in the same order
  kept : ∀ t, pairs (names h lab) (s.kept t) (h.kept t)
  -- this pulse's objects: one per run, each of a run of this pulse
  inj : ∀ i j, h.since ≤ i → h.since ≤ j → i < h.heap.size → j < h.heap.size → lab i = lab j →
    i = j
  runs : ∀ i, h.since ≤ i → i < h.heap.size → (lab i).2 ≤ s.runs (lab i).1
  now : ∀ i, h.since ≤ i → i < h.heap.size → s.when (lab i).1 = s.pulses
  -- the model's own: when never ahead; a run numbered within runs; one with a run is made
  when : ∀ c, s.when c ≤ s.pulses
  run : ∀ c r, s.ran c = some r → r.n ≤ s.runs c
  ranmade : ∀ c, (s.ran c).isSome → c < s.made

-- causes.ts from: the model's came is from on the heap
theorem came_eq {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (ho : h.ok) (t c : Nat) : came s t c = Causes.from h t c := by
  apply Bool.eq_iff_iff.2
  rw [Causes.from_iff ho]
  simp only [came, Bool.and_eq_true, List.any_eq_true, R.ran]
  refine and_congr Iff.rfl ?_
  refine pairs.exists ?_ (R.kept t)
  intro k i ⟨_, hi, ht, _⟩
  simp only [on]
  constructor
  · intro hb; exact ⟨hi, ht ▸ hb⟩
  · rintro ⟨hi', hb⟩; exact ht ▸ hb

-- causes.ts loop: the model's loopof is loop on the heap, given the object standing for the cause
theorem loopof_eq {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (ho : h.ok) {k : Why} {i : Nat} (hn : names h lab k i) (t : Nat) :
    loopof s k t = Causes.loop id h (some i) t := by
  obtain ⟨-, hi, ht, -⟩ := hn
  have hiff := Causes.loop_some (n := id) (t := t) ho hi
  rw [ht, ← R.ran] at hiff
  unfold loopof
  split
  · rename_i hw
    simp only [Bool.and_eq_true] at hw
    have hne : Causes.loop id h (some i) t ≠ none := hiff.2 ⟨hw.1, hw.2⟩
    obtain ⟨l, hl⟩ := Option.ne_none_iff_exists'.1 hne
    rw [hl]
    obtain ⟨-, huniq⟩ := Causes.loop_exact (n := id) ho (fun a b e => e) hi hl
    congr 1
    refine huniq _ ((List.pairwise_lt_range).filter _) ?_
    intro a
    simp only [through, List.mem_filter, List.mem_range, List.any_eq_true, Bool.and_eq_true,
      beq_iff_eq, ht]
    constructor
    · rintro ⟨-, y, hy, rfl, hb⟩
      exact ⟨plain y, behind_anc k y hy, hb, plain_of y⟩
    · rintro ⟨z, hz, hb, rfl⟩
      obtain ⟨y, hy, rfl⟩ := anc_behind hz k rfl
      refine ⟨?_, y, hy, (plain_of y).symm, hb⟩
      rw [← ht] at hz
      obtain ⟨x, hx, -, e⟩ := Causes.tree_anc hz i hi rfl
      have := Causes.tree_of hx
      rw [← e] at this
      exact R.made x _ this
  · rename_i hw
    symm
    cases e : Causes.loop id h (some i) t with
    | none => rfl
    | some l =>
      have := hiff.1 (by simp [e])
      simp only [Bool.and_eq_true, not_and] at hw
      exact absurd this.2 (hw this.1)

/-! ### the simulation: each step of the model, on the heap, by causes.ts's calls -/

-- a state with the same causes, runs and pulses (made may grow)
theorem Mirror.of_eq {s s' : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (e1 : s.made ≤ s'.made) (e2 : ∀ c, (s'.ran c).map (fun r => (r.n, r.given)) =
      (s.ran c).map (fun r => (r.n, r.given)))
    (e3 : s'.runs = s.runs) (e4 : s'.pulses = s.pulses) (e5 : s'.cause = s.cause)
    (e6 : s'.when = s.when) (e7 : s'.went = s.went) (e8 : s'.kept = s.kept) : Mirror s' h lab := by
  have hs : ∀ c, (s'.ran c).isSome = (s.ran c).isSome := by
    intro c; have := congrArg Option.isSome (e2 c); simpa using this
  exact {
    ran := fun c => by rw [e7]; exact R.ran c
    given := fun c r hr hg => by
      have := e2 c
      rw [hr] at this
      obtain ⟨r0, h0, e⟩ := Option.map_eq_some_iff.1 this.symm
      have e' : r0.given = r.given := congrArg Prod.snd e
      exact R.given c r0 h0 (e' ▸ hg)
    made := fun i a h => Nat.lt_of_lt_of_le (R.made i a h) e1
    cause := fun c h1 h2 => by rw [e5]; rw [hs] at h1; rw [e6, e4] at h2; exact R.cause c h1 h2
    kept := fun t => by rw [e8]; exact R.kept t
    inj := R.inj
    runs := fun i h1 h2 => by rw [e3]; exact R.runs i h1 h2
    now := fun i h1 h2 => by rw [e6, e4]; exact R.now i h1 h2
    when := fun c => by rw [e6, e4]; exact R.when c
    run := fun c r h => by
      have := e2 c
      rw [h] at this
      obtain ⟨r0, h0, e⟩ := Option.map_eq_some_iff.1 this.symm
      have e' : r0.n = r.n := congrArg Prod.fst e
      rw [e3, ← e']; exact R.run c r0 h0
    ranmade := fun c h => Nat.lt_of_lt_of_le (R.ranmade c (hs c ▸ h)) e1 }

theorem Mirror.settle {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (d t : Nat) (who : Option Nat) (l : Option (List Nat)) (fl : Bool) :
    Mirror (settle s d t who l fl) h lab := by
  obtain ⟨a, b, c, e, g, hs⟩ := settle_shape s d t who l fl
  rw [hs]
  exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl

-- a wake: its marks are from outside (no cause): the heap as it was
theorem Mirror.wake {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (cs : Nat → Comp K V) (k : K) : Mirror (wake cs s k) h lab := by
  obtain ⟨dy, sl, wr, tk, du, lp, lg, lgs, e⟩ := wake_shape cs s k
  rw [e]; exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl

theorem Mirror.wakes {h : Causes Nat} {lab : Nat → Nat × Nat} (cs : Nat → Comp K V) :
    ∀ (ws : List K) (s : State K V), Mirror s h lab → Mirror (wakes cs s ws) h lab
  | [], _, R => R
  | k :: ws, s, R => Mirror.wakes cs ws (Model.wake cs s k) (R.wake cs k)

-- d's kept cleared (causes.ts: c.kept.length = 0), its run maybe dropped
theorem Mirror.clear {s s' : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat}
    (R : Mirror s h lab) (d : Nat) (e1 : s.made ≤ s'.made)
    (e2 : ∀ c r, s'.ran c = some r → s.ran c = some r) (e3 : s'.runs = s.runs)
    (e4 : s'.pulses = s.pulses) (e5 : s'.cause = s.cause) (e6 : s'.when = s.when)
    (e7 : s'.went = s.went) (e8 : s'.kept = put s.kept d []) : Mirror s' (Causes.clear h d) lab := by
  have hs : ∀ c, (s'.ran c).isSome → (s.ran c).isSome := by
    intro c hc
    obtain ⟨r, hr⟩ := Option.isSome_iff_exists.1 hc
    simp [e2 c r hr]
  exact {
    ran := fun c => by rw [e7]; exact R.ran c
    given := fun c r hr hg => R.given c r (e2 c r hr) hg
    made := fun i a h => Nat.lt_of_lt_of_le (R.made i a h) e1
    cause := fun c h1 h2 => by rw [e5]; rw [e6, e4] at h2; exact R.cause c (hs c h1) h2
    kept := fun t => by
      rw [e8]
      by_cases ht : t = d
      · subst ht; simp only [put_same, Causes.clear, Causes.upd_same]; exact .nil
      · rw [put_ne _ _ ht]
        simp only [Causes.clear, Causes.upd_ne _ _ ht]
        exact R.kept t
    inj := R.inj
    runs := fun i h1 h2 => by rw [e3]; exact R.runs i h1 h2
    now := fun i h1 h2 => by rw [e6, e4]; exact R.now i h1 h2
    when := fun c => by rw [e6, e4]; exact R.when c
    run := fun c r h => by rw [e3]; exact R.run c r (e2 c r h)
    ranmade := fun c h => Nat.lt_of_lt_of_le (R.ranmade c (hs c h)) e1 }

theorem grows_clear (h : Causes Nat) (lab : Nat → Nat × Nat) (d : Nat) :
    grows h lab (Causes.clear h d) lab :=
  ⟨ext_refl _, rfl, fun _ _ => rfl⟩

-- causeOf: c's cause; one from an earlier pulse is cut, a new object (causes.run(c, []))
theorem causeof_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} (hc : (s.ran c).isSome) :
    ∃ h' lab' i, Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (causeof s c).1 h' lab' ∧
      names h' lab' (causeof s c).2 i := by
  unfold causeof
  split
  · rename_i hw
    obtain ⟨i, hi⟩ := R.cause c hc hw
    exact ⟨h, lab, i, hr, grows_refl h lab, R, hi⟩
  · rename_i hw
    have hf := (Causes.reachable_ok hr).2
    obtain ⟨r, hrc⟩ := Option.isSome_iff_exists.1 hc
    have hcm := R.ranmade c hc
    generalize hn : ((s.ran c).map (·.n)).getD 0 = n
    have hn' : n = r.n := by rw [← hn, hrc]; rfl
    let h' := (Causes.run h c []).1
    let lab' := put lab h.heap.size (c, n)
    have hsz : h'.heap.size = h.heap.size + 1 := by simp [h', Causes.run]
    have g : grows h lab h' lab' :=
      ⟨ext_push _ _, rfl, fun i hi => put_ne _ _ (Nat.ne_of_lt hi)⟩
    -- labels of this pulse's old objects are not of c: c's cause is of an earlier pulse
    have hold : ∀ j, h.since ≤ j → j < h.heap.size → (lab j).1 ≠ c := by
      intro j h1 h2 e
      have := R.now j h1 h2
      rw [e] at this
      exact hw this
    have hnew : names h' lab' (.mk (c, n) []) h.heap.size := by
      refine ⟨hf.since, by omega, ?_, by simp [lab']; rfl⟩
      rw [Causes.tree_eq, plain_mk]
      have hk : Causes.kids h'.heap h.heap.size = [] := by
        simp [Causes.kids, h', Causes.run, Causes.ps_push]
      simp only [hk, List.map_nil]
      congr 1
      simp [h', Causes.run]
    refine ⟨h', lab', h.heap.size, .run hr (by simp), g, ?_, hnew⟩
    exact {
      ran := fun x => by
        show put s.went c true x = true ↔ Causes.upd h.ranIn c h.pulse x = h.pulse
        by_cases hx : x = c
        · subst hx; simp
        · rw [put_ne _ _ hx, Causes.upd_ne _ _ hx]; exact R.ran x
      given := R.given
      made := fun i a ha => by
        simp only [h', Causes.run, Causes.ofs_push] at ha
        split at ha
        · cases ha; exact hcm
        · exact R.made i a ha
      cause := fun x h1 h2 => by
        by_cases hx : x = c
        · subst hx; exact ⟨h.heap.size, by simpa using hnew⟩
        · simp only [put_ne _ _ hx] at h1 h2 ⊢
          obtain ⟨i, hi⟩ := R.cause x h1 h2
          exact ⟨i, names_grows g hi⟩
      kept := fun t => pairs_grows g (R.kept t)
      inj := fun i j h1 h2 h3 h4 e => by
        simp only [h', Causes.run] at h1 h2
        rw [hsz] at h3 h4
        by_cases hi : i = h.heap.size <;> by_cases hj : j = h.heap.size
        · rw [hi, hj]
        · subst hi
          have hj' : j < h.heap.size := by omega
          simp only [lab', put_same, put_ne _ _ hj] at e
          exact absurd (congrArg Prod.fst e).symm (hold j h2 hj')
        · subst hj
          have hi' : i < h.heap.size := by omega
          simp only [lab', put_same, put_ne _ _ hi] at e
          exact absurd (congrArg Prod.fst e) (hold i h1 hi')
        · simp only [lab', put_ne _ _ hi, put_ne _ _ hj] at e
          exact R.inj i j h1 h2 (by omega) (by omega) e
      runs := fun i h1 h2 => by
        simp only [h', Causes.run] at h1
        rw [hsz] at h2
        by_cases hi : i = h.heap.size
        · subst hi; simp only [lab', put_same]; rw [hn']; exact R.run c r hrc
        · simp only [lab', put_ne _ _ hi]; exact R.runs i h1 (by omega)
      now := fun i h1 h2 => by
        simp only [h', Causes.run] at h1
        rw [hsz] at h2
        by_cases hi : i = h.heap.size
        · subst hi; simp [lab']
        · simp only [lab', put_ne _ _ hi]
          by_cases e : (lab i).1 = c
          · rw [e]; simp
          · rw [put_ne _ _ e]; exact R.now i h1 (by omega)
      when := fun x => by
        by_cases hx : x = c
        · subst hx; simp
        · simp only [put_ne _ _ hx]; exact R.when x
      run := R.run
      ranmade := R.ranmade }

-- keep: a mark's cause kept on d (causes.keep(d, cause)). the model skips one whose run is the
-- last kept's, causes.ts one whose object is: the same, as this pulse's labels are one per run
theorem keep_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {k : Why} {i : Nat} (hn : names h lab k i) (d : Nat) :
    Causes.reachable (Causes.keep h d i) ∧ grows h lab (Causes.keep h d i) lab ∧
      Mirror (keep s d k) (Causes.keep h d i) lab := by
  obtain ⟨hs, hi, ht, hl⟩ := hn
  obtain ⟨f1, f2, f3, f4, f5⟩ := Causes.keep_frame h d i
  have g : grows h lab (Causes.keep h d i) lab := ⟨by rw [f1]; exact ext_refl _, f2, fun _ _ => rfl⟩
  refine ⟨.keep hr hs hi, g, ?_⟩
  -- the last kept on d: of k's run iff it is k's object
  have hiff : (s.kept d).getLast?.map (·.of) = some k.of ↔ (h.kept d).getLast? = some i := by
    rcases (R.kept d).last with ⟨e1, e2⟩ | ⟨x, j, e1, e2, hj1, hj2, -, hj3⟩
    · simp [e1, e2]
    · rw [e1, e2]
      simp only [Option.map_some, Option.some.injEq]
      constructor
      · intro e; exact R.inj j i hj1 hs hj2 hi (by rw [hj3, hl, e])
      · intro e; subst e; rw [← hj3, hl]
  have hk : ∀ t, pairs (names (Causes.keep h d i) lab) ((keep s d k).kept t)
      ((Causes.keep h d i).kept t) := by
    intro t
    rw [Causes.keep_kept]
    unfold Model.keep
    split
    · rename_i hany
      have : ¬(t = d ∧ (h.kept d).getLast? ≠ some i) := fun ⟨_, e⟩ => e (hiff.1 hany)
      rw [ite_eq_right this]; exact pairs_grows g (R.kept t)
    · rename_i hany
      have hne : (h.kept d).getLast? ≠ some i := fun e => hany (hiff.2 e)
      by_cases e : t = d
      · subst e
        rw [ite_eq_left ⟨rfl, hne⟩]
        simp only [put_same]
        exact pairs_grows g ((R.kept t).append (.cons ⟨hs, hi, ht, hl⟩ .nil))
      · rw [ite_eq_right (fun h' => e h'.1)]
        simp only [put_ne _ _ e]
        exact pairs_grows g (R.kept t)
  have hk' : ∀ t, (keep s d k).kept t = (keep s d k).kept t := fun _ => rfl
  have hframe : ∃ kp, keep s d k = { s with kept := kp } := keep_shape s d k
  obtain ⟨kp, hkp⟩ := hframe
  have hk2 := hk
  rw [hkp] at hk2
  rw [hkp]
  exact {
    ran := fun c => by rw [f4, f3]; exact R.ran c
    given := fun c r hr' hg => f5 c (R.given c r hr' hg)
    made := fun j a ha => R.made j a (by rw [f1] at ha; exact ha)
    cause := fun c h1 h2 => by
      obtain ⟨j, hj⟩ := R.cause c h1 h2
      exact ⟨j, names_grows g hj⟩
    kept := hk2
    inj := fun a b h1 h2 h3 h4 e => R.inj a b (f2 ▸ h1) (f2 ▸ h2) (f1 ▸ h3) (f1 ▸ h4) e
    runs := fun a h1 h2 => R.runs a (f2 ▸ h1) (f1 ▸ h2)
    now := fun a h1 h2 => R.now a (f2 ▸ h1) (f1 ▸ h2)
    when := R.when
    run := R.run
    ranmade := R.ranmade }

-- a mark (scheduler.ts mark): by a run, its cause (causeOf) kept on d; from outside, nothing
theorem mark_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) (d t : Nat) (who : Option Nat)
    (hw : ∀ c, who = some c → (s.ran c).isSome) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (mark s d t who) h' lab' := by
  cases who with
  | none => exact ⟨h, lab, hr, grows_refl h lab, by simp only [mark]; exact R.settle _ _ _ _ _⟩
  | some c =>
    obtain ⟨h1, lab1, i, hr1, g1, R1, hn1⟩ := causeof_heap R hr (hw c rfl)
    simp only [mark]
    generalize causeof s c = p at R1 hn1 ⊢
    obtain ⟨s1, k⟩ := p
    obtain ⟨hr2, g2, R2⟩ := keep_heap R1 hr1 hn1 d
    exact ⟨_, _, hr2, grows_trans g1 g2, R2.settle _ _ _ _ _⟩

-- 3, at each mark by a run: the loop the model takes (loopof, after keep) is causes.ts's loop of
-- the object standing for the mark's cause, on the heap made so far
theorem mark_loop {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} (hc : (s.ran c).isSome) (d : Nat) :
    ∃ h' lab' i, Causes.reachable h' ∧ Mirror (keep (causeof s c).1 d (causeof s c).2) h' lab' ∧
      names h' lab' (causeof s c).2 i ∧
      loopof (keep (causeof s c).1 d (causeof s c).2) (causeof s c).2 d =
        Causes.loop id h' (some i) d := by
  obtain ⟨h1, lab1, i, hr1, -, R1, hn1⟩ := causeof_heap R hr hc
  obtain ⟨hr2, g2, R2⟩ := keep_heap R1 hr1 hn1 d
  exact ⟨_, lab1, i, hr2, R2, names_grows g2 hn1,
    loopof_eq R2 (Causes.reachable_ok hr2).1 (names_grows g2 hn1) d⟩

-- the promise run's callers keep (scheduler.ts first: causes.run(c, given), given taken from
-- c.kept): the given are the objects c's kept causes stand for, each made, made this pulse
theorem given_promise {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) (c : Nat) :
    pairs (names h lab) (s.kept c) (h.kept c) ∧ ∀ g ∈ h.kept c, h.since ≤ g ∧ g < h.heap.size :=
  ⟨R.kept c, fun g hg => ⟨(Causes.reachable_ok hr).2.kept c g hg, (Causes.reachable_ok hr).1.kept c g hg⟩⟩

-- the promise keep's callers keep (scheduler.ts mark: causes.keep(d, causeOf(by))): causeOf's
-- answer stands for an object made, made this pulse; one of an earlier pulse is cut to a new one
theorem keep_promise {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} (hc : (s.ran c).isSome) :
    ∃ h' lab' i, Causes.reachable h' ∧ Mirror (causeof s c).1 h' lab' ∧
      names h' lab' (causeof s c).2 i ∧ h'.since ≤ i ∧ i < h'.heap.size := by
  obtain ⟨h', lab', i, hr', -, R', hn⟩ := causeof_heap R hr hc
  exact ⟨h', lab', i, hr', R', hn, hn.1, hn.2.1⟩

theorem marks_heap (t : Nat) (r : Option Nat) :
    ∀ (ds : List Nat) (s : State K V) (h : Causes Nat) (lab : Nat → Nat × Nat), Mirror s h lab →
      Causes.reachable h → (∀ c, r = some c → (s.ran c).isSome) →
      ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧
        Mirror (ds.foldl (fun s d => mark s d t r) s) h' lab'
  | [], s, h, lab, R, hr, _ => ⟨h, lab, hr, grows_refl h lab, R⟩
  | d :: ds, s, h, lab, R, hr, hw => by
    obtain ⟨h1, lab1, hr1, g1, R1⟩ := mark_heap R hr d t r hw
    have hw1 : ∀ c, r = some c → ((mark s d t r).ran c).isSome := by
      rw [(mark_frame s d t r).ran]; exact hw
    obtain ⟨h2, lab2, hr2, g2, R2⟩ := marks_heap t r ds _ h1 lab1 R1 hr1 hw1
    exact ⟨h2, lab2, hr2, grows_trans g1 g2, R2⟩

-- changed: each key's readers marked by the run named (by), or from outside
theorem changed_heap (cs : Nat → Comp K V) {s : State K V} {h : Causes Nat}
    {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h) (keys : List K)
    (who : Option Nat) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (changed cs s keys who) h' lab' := by
  simp only [changed]
  generalize ht : s.tick + 1 = t
  have R0 : Mirror { s with tick := t } h lab :=
    R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
  have hw0 : ∀ c, runof { s with tick := t } who = some c → (s.ran c).isSome := by
    intro c hc
    simp only [runof, Option.filter_eq_some_iff] at hc
    exact hc.2
  generalize runof { s with tick := t } who = r at hw0
  generalize (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have fold : ∀ (ks : List K) (s1 : State K V) (h1 : Causes Nat) (lab1 : Nat → Nat × Nat),
      Mirror s1 h1 lab1 → Causes.reachable h1 → s1.ran = s.ran →
      ∃ h' lab', Causes.reachable h' ∧ grows h1 lab1 h' lab' ∧
        Mirror (ks.foldl (fun s k => tell (learn s k w) k t r) s1) h' lab' := by
    intro ks
    induction ks with
    | nil => intro s1 h1 lab1 R1 hr1 _; exact ⟨h1, lab1, hr1, grows_refl _ _, R1⟩
    | cons k ks ih =>
      intro s1 h1 lab1 R1 hr1 e1
      simp only [List.foldl_cons]
      have Rl : Mirror (learn s1 k w) h1 lab1 := by
        cases w <;> exact R1.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
      have fl : (learn s1 k w).ran = s.ran := by cases w <;> exact e1
      obtain ⟨h2, lab2, hr2, g2, R2⟩ := marks_heap t r (readers (learn s1 k w) k) _ h1 lab1 Rl hr1
        (by rw [fl]; exact hw0)
      obtain ⟨h3, lab3, hr3, g3, R3⟩ := ih _ h2 lab2 R2 hr2
        (by rw [(marks_frame t r _ _).ran, fl])
      exact ⟨h3, lab3, hr3, grows_trans g2 g3, R3⟩
  exact fold keys _ h lab R0 hr rfl

-- a new object's parents, unfolded: the causes they stand for
theorem kids_map {n : Nat} (F : (j : Nat) → j < n → Cause Nat) :
    ∀ (g : List Why) (js : List Nat), pairs (fun k j => ∃ hj : j < n, F j hj = plain k) g js →
      ((js.filterMap fun p => if hp : p < n then some (⟨p, hp⟩ : Fin n) else none).map
        fun p => F p.1 p.2) = g.map plain
  | _, _, .nil => rfl
  | k :: g, j :: js, .cons ⟨hj, e⟩ t => by
    simp only [List.filterMap_cons, hj, dite_true, List.map_cons, e]
    rw [kids_map F g js t]

-- start: c's kept taken (first: given = c.kept, c.kept = []), a new run of c given it
-- (causes.run(c, given))
theorem start_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} (hc : c < s.made) (rk : Nat) :
    Causes.reachable (Causes.run (Causes.take h c).1 c (h.kept c)).1 ∧
      grows h lab (Causes.run (Causes.take h c).1 c (h.kept c)).1
        (put lab h.heap.size (c, s.runs c + 1)) ∧
      Mirror (start s c rk) (Causes.run (Causes.take h c).1 c (h.kept c)).1
        (put lab h.heap.size (c, s.runs c + 1)) ∧
      pairs (names (Causes.run (Causes.take h c).1 c (h.kept c)).1
        (put lab h.heap.size (c, s.runs c + 1))) (s.kept c) (h.kept c) := by
  obtain ⟨ho, hf⟩ := Causes.reachable_ok hr
  generalize hn : s.runs c + 1 = n
  let h' := (Causes.run (Causes.take h c).1 c (h.kept c)).1
  let lab' := put lab h.heap.size (c, n)
  have hsz : h'.heap.size = h.heap.size + 1 := by simp [h', Causes.run, Causes.take]
  have g : grows h lab h' lab' :=
    ⟨ext_push _ _, rfl, fun i hi => put_ne _ _ (Nat.ne_of_lt hi)⟩
  have hgiven : ∀ x ∈ h.kept c, (Causes.take h c).1.since ≤ x ∧ x < (Causes.take h c).1.heap.size :=
    fun x hx => ⟨hf.kept c x hx, ho.kept c x hx⟩
  have hold : ∀ j, h.since ≤ j → j < h.heap.size → lab j ≠ (c, n) := by
    intro j h1 h2 e
    have := R.runs j h1 h2
    rw [e] at this
    simp only at this
    omega
  have hk := pairs_grows g (R.kept c)
  have hnew : names h' lab' (.mk (c, n) (s.kept c)) h.heap.size := by
    refine ⟨hf.since, by omega, ?_, by simp [lab']; rfl⟩
    rw [Causes.tree_eq, plain_mk]
    have e1 : (h'.heap[h.heap.size]'(by omega)) = ⟨c, h.kept c⟩ := by
      simp [h', Causes.run, Causes.take]
    have e2 : Causes.ps h'.heap h.heap.size = h.kept c := by
      simp [h', Causes.run, Causes.take, Causes.ps_push]
    simp only [e1, Causes.kids, e2]
    congr 1
    refine kids_map (n := h.heap.size) (fun j hj => Causes.tree h'.heap j (by omega)) _ _ ?_
    refine (R.kept c).imp ?_
    intro k j ⟨_, hj, e⟩
    exact ⟨hj, by rw [tree_ext g.heap j hj]; exact e.1⟩
  refine ⟨.run (.take hr) hgiven, g, ?_, hk⟩
  exact {
    ran := fun x => by
      show put s.went c true x = true ↔
        Causes.upd h.ranIn c h.pulse x = h.pulse
      by_cases hx : x = c
      · subst hx; simp
      · rw [put_ne _ _ hx, Causes.upd_ne _ _ hx]; exact R.ran x
    given := fun x r h1 h2 => by
      show h.heldIn x = h.pulse
      simp only [start, say] at h1
      by_cases hx : x = c
      · subst hx
        simp only [put_same, Option.some.injEq] at h1
        subst h1
        exact ho.holding x (fun e => h2 ((R.kept x).empty.2 e))
      · rw [put_ne _ _ hx] at h1; exact R.given x r h1 h2
    made := fun i a ha => by
      simp only [h', Causes.run, Causes.take, Causes.ofs_push] at ha
      simp only [start, say]
      split at ha
      · cases ha; exact hc
      · exact R.made i a ha
    cause := fun x h1 h2 => by
      simp only [start, say] at h1 h2 ⊢
      by_cases hx : x = c
      · subst hx; rw [hn]; exact ⟨h.heap.size, by simpa using hnew⟩
      · simp only [put_ne _ _ hx] at h1 h2 ⊢
        obtain ⟨i, hi⟩ := R.cause x h1 h2
        exact ⟨i, names_grows g hi⟩
    kept := fun t => by
      show pairs (names h' lab') (put s.kept c [] t) (Causes.upd h.kept c [] t)
      by_cases ht : t = c
      · subst ht; simp only [put_same, Causes.upd_same]; exact .nil
      · rw [put_ne _ _ ht, Causes.upd_ne _ _ ht]; exact pairs_grows g (R.kept t)
    inj := fun i j h1 h2 h3 h4 e => by
      simp only [h', Causes.run, Causes.take] at h1 h2 h3 h4
      simp only [Array.size_push] at h3 h4
      by_cases hi : i = h.heap.size <;> by_cases hj : j = h.heap.size
      · rw [hi, hj]
      · subst hi
        simp only [lab', put_same, put_ne _ _ hj] at e
        exact absurd e.symm (hold j h2 (by omega))
      · subst hj
        simp only [lab', put_same, put_ne _ _ hi] at e
        exact absurd e (hold i h1 (by omega))
      · simp only [lab', put_ne _ _ hi, put_ne _ _ hj] at e
        exact R.inj i j h1 h2 (by omega) (by omega) e
    runs := fun i h1 h2 => by
      simp only [h', Causes.run, Causes.take] at h1 h2
      simp only [Array.size_push] at h2
      simp only [start, say]
      by_cases hi : i = h.heap.size
      · subst hi; simp [lab', hn]
      · simp only [lab', put_ne _ _ hi]
        have := R.runs i h1 (by omega)
        by_cases e : (lab i).1 = c
        · rw [e] at this ⊢; simp; omega
        · rw [put_ne _ _ e]; exact this
    now := fun i h1 h2 => by
      simp only [h', Causes.run, Causes.take] at h1 h2
      simp only [Array.size_push] at h2
      simp only [start, say]
      by_cases hi : i = h.heap.size
      · subst hi; simp [lab']
      · simp only [lab', put_ne _ _ hi]
        by_cases e : (lab i).1 = c
        · rw [e]; simp
        · rw [put_ne _ _ e]; exact R.now i h1 (by omega)
    when := fun x => by
      simp only [start, say]
      by_cases hx : x = c
      · subst hx; simp
      · simp only [put_ne _ _ hx]; exact R.when x
    run := fun x r h => by
      simp only [start, say] at h ⊢
      by_cases hx : x = c
      · subst hx; simp at h; subst h; simp [hn]
      · simp only [put_ne _ _ hx] at h ⊢; exact R.run x r h
    ranmade := fun x h => by
      simp only [start, say] at h ⊢
      by_cases hx : x = c
      · subst hx; exact hc
      · simp only [put_ne _ _ hx] at h; exact R.ranmade x h }

-- finish: not done, what the run was given goes back in front of c's kept (scheduler.ts finish:
-- c.kept = r.given.concat(c.kept)): causes' restore of their objects, in the pulse they were
-- taken in; done, nothing. either way the run gives its given up
theorem finish_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} {gs : List Nat}
    (hg : ∀ r, s.ran c = some r → pairs (names h lab) r.given gs) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat)) :
    ∃ h', Causes.reachable h' ∧ grows h lab h' lab ∧ Mirror (finish s c e eq w th) h' lab := by
  cases hrc : s.ran c with
  | none => simp only [Model.finish, hrc]; exact ⟨h, hr, grows_refl h lab, R⟩
  | some r =>
    obtain ⟨e, th', -, hfin⟩ := finish_any s c r hrc e eq w th
    rw [hfin]
    have hgr := hg r hrc
    have e2 : ∀ x,
        ((put s.ran c (some { r with
          ended := some e, given := [], loop := if e = .pending then r.loop else none })) x).map (·.n) = (s.ran x).map (·.n) := by
      intro x
      by_cases hx : x = c
      · subst hx; simp [hrc]
      · simp [put_ne _ _ hx]
    have hs : ∀ x, ((put s.ran c (some { r with
          ended := some e, given := [], loop := if e = .pending then r.loop else none })) x).isSome = (s.ran x).isSome := by
      intro x; have := congrArg Option.isSome (e2 x); simpa using this
    -- a heap with the same objects, pulse, runs and holds as h, the kept as given
    have mk : ∀ (h' : Causes Nat), h'.heap = h.heap → h'.since = h.since → h'.ranIn = h.ranIn →
        h'.pulse = h.pulse → h'.heldIn = h.heldIn →
        (∀ t, pairs (names h' lab)
          ((if e = .done then s.kept else put s.kept c (r.given ++ s.kept c)) t) (h'.kept t)) →
        Mirror { s with
          kept := if e = .done then s.kept else put s.kept c (r.given ++ s.kept c),
          looping := if e = .looping then put s.looping c true else s.looping,
          values := if e ≠ .stopped then put s.values c r.values else s.values,
          ran := put s.ran c (some { r with
            ended := some e, given := [], loop := if e = .pending then r.loop else none }),
          log := s.log ++ [⟨s.pulses, s.round, .ends c r.n e eq w th'⟩] } h' lab := by
      intro h' f1 f2 f3 f4 f5 hk
      exact {
        ran := fun x => by rw [f3, f4]; exact R.ran x
        given := fun x r' h1 h2 => by
          rw [f5, f4]
          by_cases hx : x = c
          · subst hx; simp at h1; rw [← h1] at h2; exact absurd rfl h2
          · simp only [put_ne _ _ hx] at h1; exact R.given x r' h1 h2
        made := fun i a ha => R.made i a (by rw [f1] at ha; exact ha)
        cause := fun x h1 h2 => by
          obtain ⟨i, hi⟩ := R.cause x ((hs x).symm ▸ h1) h2
          obtain ⟨a, b, c', d'⟩ := hi
          exact ⟨i, f2 ▸ a, f1 ▸ b, by simp only [f1]; exact c', d'⟩
        kept := hk
        inj := fun a b h1 h2 h3 h4 e' => R.inj a b (f2 ▸ h1) (f2 ▸ h2) (f1 ▸ h3) (f1 ▸ h4) e'
        runs := fun a h1 h2 => R.runs a (f2 ▸ h1) (f1 ▸ h2)
        now := fun a h1 h2 => R.now a (f2 ▸ h1) (f1 ▸ h2)
        when := R.when
        run := fun x r' h => by
          have := e2 x
          rw [show (put s.ran c (some { r with
              ended := some e, given := [], loop := if e = .pending then r.loop else none })) x = some r' from h,
            Option.map_some] at this
          obtain ⟨r0, h0, e'⟩ := Option.map_eq_some_iff.1 this.symm
          have e'' : r0.n = r'.n := e'
          rw [← e'']; exact R.run x r0 h0
        ranmade := fun x h => R.ranmade x ((hs x).symm ▸ h) }
    by_cases hd : e = .done
    · refine ⟨h, hr, grows_refl h lab, mk h rfl rfl rfl rfl rfl fun t => ?_⟩
      simp only [hd, ite_true]; exact R.kept t
    · have hgs : ∀ g ∈ gs, h.since ≤ g ∧ g < h.heap.size := by
        intro g hg'
        obtain ⟨x, -, hx1, hx2, -⟩ := hgr.right g hg'
        exact ⟨hx1, hx2⟩
      have hheld : gs ≠ [] → h.heldIn c = h.pulse := fun hne =>
        R.given c r hrc (fun e' => hne (hgr.empty.1 e'))
      refine ⟨Causes.restore h c gs, .restore hr hgs hheld, ⟨ext_refl _, rfl, fun _ _ => rfl⟩,
        mk _ rfl rfl rfl rfl rfl fun t => ?_⟩
      simp only [hd, ite_false]
      show pairs (names h lab) (put s.kept c (r.given ++ s.kept c) t)
        (Causes.upd h.kept c (gs ++ h.kept c) t)
      by_cases ht : t = c
      · subst ht; simp only [put_same, Causes.upd_same]; exact hgr.append (R.kept t)
      · rw [put_ne _ _ ht, Causes.upd_ne _ _ ht]; exact R.kept t

-- set (the harness's): its write said changed by c
theorem set_heap (cs : Nat → Comp K V) {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat}
    (R : Mirror s h lab) (hr : Causes.reachable h) (c : Nat) (v : V) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (set cs s c v) h' lab' := by
  have R1 : Mirror (say s (.set c v)) h lab :=
    R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
  simp only [Model.set]
  split
  · refine changed_heap cs ?_ hr _ _
    exact R1.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
  · exact ⟨h, lab, hr, grows_refl h lab, R1⟩

-- finish of a state with the same runs, after the heap grew
theorem finish_after {s X : State K V} {h h1 : Causes Nat} {lab lab1 : Nat → Nat × Nat}
    {c : Nat} {gone : List Nat} (hg : ∀ r, s.ran c = some r → pairs (names h lab) r.given gone)
    (R1 : Mirror X h1 lab1) (hr1 : Causes.reachable h1) (g1 : grows h lab h1 lab1)
    (e1 : X.ran = s.ran) (e : Ended) (eq : Option Bool) (w : Option Nat)
    (th : Option (List Nat)) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (finish X c e eq w th) h' lab' := by
  obtain ⟨h2, hr2, g2, R2⟩ := finish_heap R1 hr1 (gs := gone)
    (fun r hr => pairs_grows g1 (hg r (e1 ▸ hr))) e eq w th
  exact ⟨h2, lab1, hr2, grows_trans g1 g2, R2⟩

theorem result_heap (cs : Nat → Comp K V) {s : State K V} {h : Causes Nat}
    {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h) {c : Nat}
    {gone : List Nat} (hg : ∀ r, s.ran c = some r → pairs (names h lab) r.given gone) (x : V) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (result cs s c x) h' lab' := by
  obtain ⟨h1, lab1, hr1, g1, R1⟩ := set_heap cs R hr c x
  have f := set_frame cs s c x
  unfold Model.result
  dsimp only
  repeat' split
  all_goals first
    | exact finish_after hg R hr (grows_refl h lab) rfl _ _ _ _
    | (refine finish_after hg ?_ hr (grows_refl h lab) ?_ _ _ _ _
       · exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
       · rfl)
    | (refine finish_after hg ?_ hr1 g1 ?_ _ _ _ _
       · exact R1.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
       · exact f.ran)

theorem ending_heap (cs : Nat → Comp K V) {s : State K V} {h : Causes Nat}
    {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h) {c : Nat}
    {gone : List Nat} (hg : ∀ r, s.ran c = some r → pairs (names h lab) r.given gone) (o : Out V) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (ending cs s c o) h' lab' := by
  unfold Model.ending
  split
  · unfold Model.stop
    split
    · exact ⟨h, lab, hr, grows_refl h lab, R⟩
    · dsimp only
      split <;>
      · refine finish_after hg ?_ hr (grows_refl h lab) ?_ _ _ _ _
        · exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
        · rfl
  · have e2 : ∀ x, ((edit s c fun r => { r with out := some o }).ran x).map
        (fun r => (r.n, r.given)) = (s.ran x).map (fun r => (r.n, r.given)) := by
      intro x
      simp only [edit]
      by_cases hx : x = c
      · subst hx; simp only [put_same]; cases s.ran x <;> rfl
      · rw [put_ne _ _ hx]
    have R1 : Mirror (edit s c fun r => { r with out := some o }) h lab :=
      R.of_eq (Nat.le_refl _) e2 rfl rfl rfl rfl rfl rfl
    have hg1 : ∀ r, (edit s c fun r => { r with out := some o }).ran c = some r →
        pairs (names h lab) r.given gone := by
      intro r hr'
      simp only [edit, put_same, Option.map_eq_some_iff] at hr'
      obtain ⟨r0, h0, rfl⟩ := hr'
      exact hg r0 h0
    split
    · exact finish_after hg1 R1 hr (grows_refl h lab) rfl _ _ _ _
    · exact finish_after hg1 R1 hr (grows_refl h lab) rfl _ _ _ _
    · exact result_heap cs R1 hr hg1 _

-- a run (A2): c's kept taken, causes.run(c, given), its wakes (from outside), then its end
theorem first_heap (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {h : Causes Nat}
    {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h)
    (hw : ∀ k w, s.writers k = some w → w < s.made) (hrm : ∀ x, (s.ran x).isSome → x < s.made)
    {c : Nat} (hc : c < s.made) (rk : Nat) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (first cs s c rk) h' lab' := by
  obtain ⟨o, seen, vals, st, ws, X, hf, e5, hX, -⟩ := first_eq cs s c rk (hA c) hw hrm hc
  obtain ⟨e1, -, -, -, -, e6, e7, e8, e9, e10, e11⟩ := first_fields hX
  rw [hf]
  obtain ⟨hr1, g1, R1, hk⟩ := start_heap R hr hc rk
  have RW := Mirror.wakes cs ws _ R1
  have fW := wakes_frame cs ws (start s c rk)
  have R3 : Mirror X (Causes.run (Causes.take h c).1 c (h.kept c)).1
      (put lab h.heap.size (c, s.runs c + 1)) := by
    refine RW.of_eq (Nat.le_of_eq e1.symm) ?_ e10 e11 e6 e7 e8 e9
    intro x
    rw [e5, fW.ran]
    simp only [start, say]
    by_cases hx : x = c
    · subst hx; simp [begun]
    · simp [put_ne _ _ hx]
  have hg : ∀ r, X.ran c = some r →
      pairs (names (Causes.run (Causes.take h c).1 c (h.kept c)).1
        (put lab h.heap.size (c, s.runs c + 1))) r.given (h.kept c) := by
    intro r hr'
    rw [e5] at hr'
    simp only [put_same, Option.some.injEq] at hr'
    subst hr'
    exact hk
  obtain ⟨h2, lab2, hr2, g2, R2⟩ := ending_heap cs R3 hr1 hg o
  exact ⟨h2, lab2, hr2, grows_trans g1 g2, R2⟩

-- an act: its writes, each said changed by the effect
theorem act_heap (cs : Nat → Comp K V) {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat}
    (R : Mirror s h lab) (hr : Causes.reachable h) (e : Nat) (x : V) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (act cs s e x) h' lab' := by
  have fold : ∀ (ws : List (K × V)) (s1 : State K V) (h1 : Causes Nat)
      (lab1 : Nat → Nat × Nat), Mirror s1 h1 lab1 → Causes.reachable h1 →
      ∃ h' lab', Causes.reachable h' ∧ grows h1 lab1 h' lab' ∧
        Mirror (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1) h' lab' := by
    intro ws
    induction ws with
    | nil => intro s1 h1 lab1 R1 hr1; exact ⟨h1, lab1, hr1, grows_refl _ _, R1⟩
    | cons kv ws ih =>
      intro s1 h1 lab1 R1 hr1
      simp only [List.foldl_cons]
      obtain ⟨h2, lab2, hr2, g2, R2⟩ := changed_heap cs (s := store s1 kv.1 kv.2)
        (R1.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl) hr1 [kv.1] (some e)
      obtain ⟨h3, lab3, hr3, g3, R3⟩ := ih _ h2 lab2 R2 hr2
      exact ⟨h3, lab3, hr3, grows_trans g2 g3, R3⟩
  unfold Model.act
  dsimp only
  split
  · exact ⟨h, lab, hr, grows_refl h lab, R⟩
  · split
    · exact ⟨h, lab, hr, grows_refl h lab, R⟩
    · rename_i g _
      obtain ⟨h1, lab1, hr1, g1, R1⟩ := fold (g x (s.last e)) (say s (.act e x (s.last e))) h lab
        (R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl) hr
      exact ⟨h1, lab1, hr1, g1, R1.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl⟩

-- a going: order's delete aside, its teardowns' writes (changes named by it), then its kept
-- cleared (causes.ts: c.kept.length = 0) and its run dropped
theorem bury_heap (cs : Nat → Comp K V) {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat}
    (R : Mirror s h lab) (hr : Causes.reachable h) (d : Nat) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (bury cs s d) h' lab' := by
  have fold : ∀ (ws : List (K × V)) (s1 : State K V) (h1 : Causes Nat)
      (lab1 : Nat → Nat × Nat), Mirror s1 h1 lab1 → Causes.reachable h1 →
      ∃ h' lab', Causes.reachable h' ∧ grows h1 lab1 h' lab' ∧
        Mirror (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some d)) s1) h' lab' := by
    intro ws
    induction ws with
    | nil => intro s1 h1 lab1 R1 hr1; exact ⟨h1, lab1, hr1, grows_refl _ _, R1⟩
    | cons kv ws ih =>
      intro s1 h1 lab1 R1 hr1
      simp only [List.foldl_cons]
      obtain ⟨h2, lab2, hr2, g2, R2⟩ := changed_heap cs (s := store s1 kv.1 kv.2)
        (R1.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl) hr1 [kv.1] (some d)
      obtain ⟨h3, lab3, hr3, g3, R3⟩ := ih _ h2 lab2 R2 hr2
      exact ⟨h3, lab3, hr3, grows_trans g2 g3, R3⟩
  unfold Model.bury
  split
  · exact ⟨h, lab, hr, grows_refl h lab, R⟩
  · split
    · exact ⟨h, lab, hr, grows_refl h lab, R⟩
    · obtain ⟨h1, lab1, hr1, g1, R1⟩ := fold (cs d).goes { s with due := put s.due d none } h lab
        (R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl) hr
      simp only
      generalize (cs d).goes.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some d))
        { s with due := put s.due d none } = Y at R1 ⊢
      refine ⟨_, lab1, .clear hr1, grows_trans g1 (grows_clear h1 lab1 d), ?_⟩
      refine R1.clear d (by simp) (fun c r hc => ?_) (by simp) (by simp) (by simp) (by simp)
        (by simp) (by simp)
      by_cases e : c = d
      · subst e; simp at hc
      · simpa [put_ne _ _ e] using hc

-- a pulse's end: causes.end, every kept cleared, the pulse bumped; this pulse's objects old. no
-- run holds a given then (Core.given)
theorem close_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) (hg : ∀ c r, s.ran c = some r → r.given = []) :
    Causes.reachable (Causes.end h) ∧ Mirror (close s) (Causes.end h) lab := by
  have ho := (Causes.reachable_ok hr).1
  refine ⟨.end hr, ?_⟩
  exact {
    ran := fun c => by
      have := ho.ranIn c
      simp only [close, Causes.end, Bool.false_eq_true, false_iff]; omega
    given := fun c r h1 h2 => absurd (hg c r h1) h2
    made := R.made
    cause := fun c _ h2 => by
      have := R.when c
      simp only [close] at h2
      omega
    kept := fun t => by
      rw [Causes.end_kept ho t]
      exact .nil
    inj := fun i j h1 _ h3 _ _ => by simp only [Causes.end] at h1 h3; omega
    runs := fun i h1 h2 => by simp only [Causes.end] at h1 h2; omega
    now := fun i h1 h2 => by simp only [Causes.end] at h1 h2; omega
    when := fun c => by have := R.when c; simp only [close]; omega
    run := R.run
    ranmade := R.ranmade }

-- a step of a pulse: a run, an act (early or not), a going, or a phase change
theorem step_heap (cs : Nat → Comp K V) (hA : A2 cs) {rk : State K V → Nat → Nat}
    {s s' : State K V} (g : Core cs s) {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) (hs : step cs rk s = some s') :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror s' h' lab' := by
  have same : ∀ s1 : State K V, s1.made = s.made → s1.ran = s.ran → s1.runs = s.runs →
      s1.pulses = s.pulses → s1.cause = s.cause → s1.when = s.when → s1.went = s.went →
      s1.kept = s.kept → Mirror s1 h lab := by
    intro s1 e1 e2 e3 e4 e5 e6 e7 e8
    exact R.of_eq (by omega) (fun c => by rw [e2]) e3 e4 e5 e6 e7 e8
  unfold Model.step at hs
  split at hs
  · split at hs
    · rename_i c hc
      cases hs
      exact first_heap cs hA R hr g.writers_made g.ran_made (next_ready hc).2 _
    · cases hs
      exact ⟨h, lab, hr, grows_refl h lab, same _ rfl rfl rfl rfl rfl rfl rfl rfl⟩
  · split at hs
    · cases hs
      refine act_heap cs ?_ hr _ _; exact same _ rfl rfl rfl rfl rfl rfl rfl rfl
    · split at hs
      · cases hs
        refine act_heap cs ?_ hr _ _; exact same _ rfl rfl rfl rfl rfl rfl rfl rfl
      · split at hs
        · cases hs
          exact ⟨h, lab, hr, grows_refl h lab, same _ rfl rfl rfl rfl rfl rfl rfl rfl⟩
        · split at hs
          · cases hs
          · cases hs
            exact ⟨h, lab, hr, grows_refl h lab, same _ rfl rfl rfl rfl rfl rfl rfl rfl⟩
  · split at hs
    · cases hs
      refine bury_heap cs ?_ hr _; exact same _ rfl rfl rfl rfl rfl rfl rfl rfl
    · cases hs
      exact ⟨h, lab, hr, grows_refl h lab, same _ rfl rfl rfl rfl rfl rfl rfl rfl⟩

-- make: the new one's kept fresh (causes.ts: a new object, its kept empty), then (awake) its mark
-- from outside; an early effect's first run and its act
theorem make_heap (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} (g : Core cs s)
    {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (make cs s) h' lab' := by
  have eg : (Model.grow cs s).made = s.made + 1 ∧ (Model.grow cs s).ran = s.ran ∧
      (Model.grow cs s).kept = put s.kept s.made [] ∧
      (∀ k w, (Model.grow cs s).writers k = some w → w < s.made + 1) := by
    simp only [Model.grow]
    split
    · rename_i k _
      refine ⟨rfl, rfl, rfl, fun k' w h => ?_⟩
      by_cases e : k' = k
      · subst e; simp at h; omega
      · simp [put_ne _ _ e] at h; have := g.writers_made k' w h; omega
    · exact ⟨rfl, rfl, rfl, fun k w h => by have := g.writers_made k w h; omega⟩
  have R0 : Mirror (Model.grow cs s) (Causes.clear h s.made) lab := by
    refine R.clear s.made (by rw [eg.1]; omega) (fun c r hc => by rw [eg.2.1] at hc; exact hc)
      ?_ ?_ ?_ ?_ ?_ eg.2.2.1
    all_goals simp only [Model.grow]; split <;> rfl
  have hr0 : Causes.reachable (Causes.clear h s.made) := .clear hr
  have g0 := grows_clear h lab s.made
  unfold Model.make
  dsimp only
  split
  · exact ⟨_, _, hr0, g0, R0.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl⟩
  · obtain ⟨h2, lab2, hr2, g2, R2⟩ := mark_heap R0 hr0 s.made (Model.grow cs s).tick none (by simp)
    have fm := mark_frame (Model.grow cs s) s.made (Model.grow cs s).tick none
    split
    · obtain ⟨h3, lab3, hr3, g3, R3⟩ := first_heap cs hA R2 hr2 (c := s.made)
        (by
          intro k w hk
          rw [mark_writers] at hk; rw [fm.made, eg.1]; exact eg.2.2.2 k w hk)
        (by
          intro x hx
          rw [fm.ran, eg.2.1] at hx; rw [fm.made, eg.1]
          have := g.ran_made x hx; omega)
        (by rw [fm.made, eg.1]; omega) 0
      simp only [actnow]
      split
      · rename_i x _
        obtain ⟨h4, lab4, hr4, g4, R4⟩ := act_heap cs (s := { first cs (mark (Model.grow cs s) s.made
          (Model.grow cs s).tick none) s.made 0 with
            earlies := (first cs (mark (Model.grow cs s) s.made (Model.grow cs s).tick none) s.made
              0).earlies.filter (·.1 ≠ s.made) })
          (R3.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl) hr3 s.made x.2
        exact ⟨h4, lab4, hr4, grows_trans g0 (grows_trans g2 (grows_trans g3 g4)), R4⟩
      · exact ⟨h3, lab3, hr3, grows_trans g0 (grows_trans g2 g3), R3⟩
    · exact ⟨h2, lab2, hr2, grows_trans g0 g2, R2⟩

theorem forget {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat}
    (e : ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror s h' lab') :
    ∃ h' lab', Causes.reachable h' ∧ Mirror s h' lab' :=
  let ⟨h', lab', hr, _, R⟩ := e; ⟨h', lab', hr, R⟩

-- 3: every reachable state (A2) has a heap of causes.ts's, reached by its calls with the callers'
-- promises kept (Causes.reachable), that the model's causes stand on (Mirror)
theorem reach_heap {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rk s) : ∃ hc lab, Causes.reachable hc ∧ Mirror s hc lab := by
  induction h with
  | empty =>
    refine ⟨Causes.create, fun _ => (0, 0), .create, ?_⟩
    exact {
      ran := fun c => by simp [Model.empty, Causes.create]
      given := fun c r h => by simp [Model.empty] at h
      made := fun i a h => by simp [Causes.create, Causes.ofs] at h
      cause := fun c h1 _ => by simp [Model.empty] at h1
      kept := fun t => by simp only [Model.empty, Causes.create]; exact .nil
      inj := fun i j _ _ h3 _ _ => by simp [Causes.create] at h3
      runs := fun i _ h2 => by simp [Causes.create] at h2
      now := fun i _ h2 => by simp [Causes.create] at h2
      when := fun c => by simp [Model.empty]
      run := fun c r h => by simp [Model.empty] at h
      ranmade := fun c h => by simp [Model.empty] at h }
  | @make s hs ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    exact forget (make_heap cs hA (hs.good hA).toCore R hr)
  | write kvs _ ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    obtain ⟨st, e, -⟩ := stores_shape _ kvs
    unfold Model.write
    rw [e]
    refine forget (lab := lab) (changed_heap cs ?_ hr _ none)
    exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
  | tell keys _ ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    obtain ⟨h', lab', hr', -, R'⟩ := changed_heap cs R hr keys none
    exact ⟨h', lab', hr', R'⟩
  | begin _ ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    exact ⟨hc, lab, hr, R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl⟩
  | step hs h ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    obtain ⟨h', lab', hr', -, R'⟩ := step_heap cs hA (hs.good hA).toCore R hr h
    exact ⟨h', lab', hr', R'⟩
  | close hs _ ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    obtain ⟨hr', R'⟩ := close_heap R hr (hs.good hA).given
    exact ⟨_, lab, hr', R'⟩

-- 3: on every reachable state (A2), on the heap the scheduler's calls built: the model's came is
-- causes.ts's from, and the loop of each computation's current cause is causes.ts's loop
theorem causes_reach {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rk s) :
    ∃ hc lab, Causes.reachable hc ∧ Mirror s hc lab ∧ (∀ t c, came s t c = Causes.from hc t c) ∧
      ∀ c, (s.ran c).isSome → s.when c = s.pulses → ∃ i, names hc lab (s.cause c) i ∧
        ∀ t, loopof s (s.cause c) t = Causes.loop id hc (some i) t := by
  obtain ⟨hc, lab, hr, R⟩ := reach_heap hA h
  have ho := (Causes.reachable_ok hr).1
  refine ⟨hc, lab, hr, R, came_eq R ho, ?_⟩
  intro c h1 h2
  obtain ⟨i, hi⟩ := R.cause c h1 h2
  exact ⟨i, hi, fun t => loopof_eq R ho hi t⟩

-- a run with causes.ts's from in place of the model's came (Model.lean, exec)
def execf (fr : Nat → Nat → Bool) (cs : Nat → Comp K V) (c : Nat) :
    State K V → Prog K V → State K V × Out V
  | s, .value v => (s, .value v)
  | s, .error => (s, .error)
  | s, .pending => (s, .pending)
  | s, .read k next =>
    let x := s.store k
    let fresh := !tracked s k
    let s := { s with reads := put s.reads c (s.reads c ++ [k]) }
    let s := edit s c fun r => { r with seen := r.seen ++ [(k, x)] }
    let s := if fresh then wake cs s k else s
    match s.writers k with
    | none => execf fr cs c s (next x)
    | some w =>
      if w = c then execf fr cs c s (next x)
      else
        let s := edit s c fun r => { r with values := ins w r.values }
        if (s.due w).isSome && !waits s w c && !fr w c then
          (edit s c fun r => { r with stopped := some w }, .error)
        else execf fr cs c s (next x)
  | s, .write k v next => execf fr cs c (changed cs (store s k v) [k] (some c)) next

-- a run (A2) reads no cause it changes: at every read, came is what it was at the run's start
theorem exec_execf (cs : Nat → Comp K V) (c : Nat) (fr : Nat → Nat → Bool) :
    ∀ (p : Prog K V), nowrites p → ∀ (s : State K V), (∀ w, came s w c = fr w c) →
      exec cs c s p = execf fr cs c s p
  | .value _, _, _, _ => rfl
  | .error, _, _, _ => rfl
  | .pending, _, _, _ => rfl
  | .write .., hp, _, _ => absurd hp (by simp [nowrites])
  | .read k next, hp, s, hf => by
    have hp' := fun x => (show nowrites (Prog.read k next) from hp) x
    have same : ∀ (s' : State K V), s'.went = s.went → s'.kept = s.kept →
        ∀ w, came s' w c = fr w c := by
      intro s' e1 e2 w; rw [← hf w]; simp only [came, e1, e2]
    simp only [exec, execf]
    generalize hs1 : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) = s1
    have h0 : ∀ w, came s1 w c = fr w c := same s1 (by rw [← hs1]; rfl) (by rw [← hs1]; rfl)
    generalize hs1' : (if (!tracked s k) = true then wake cs s1 k else s1) = s1'
    have ew : s1'.went = s1.went ∧ s1'.kept = s1.kept := by
      rw [← hs1']; split
      · obtain ⟨dy, sl, wr, tk, du, lp, lg, lgs, e⟩ := wake_shape cs s1 k
        rw [e]; exact ⟨rfl, rfl⟩
      · exact ⟨rfl, rfl⟩
    have h1 : ∀ w, came s1' w c = fr w c := by
      intro w; rw [← h0 w]; simp only [came, ew.1, ew.2]
    clear hs1'
    cases hw : s1'.writers k with
    | none => exact exec_execf cs c fr _ (hp' _) s1' h1
    | some w =>
      dsimp only
      split
      · exact exec_execf cs c fr _ (hp' _) s1' h1
      · generalize hs2 : edit s1' c (fun r => { r with values := ins w r.values }) = s2
        have h2 : ∀ w, came s2 w c = fr w c := by
          intro w'; rw [← h1 w']; rw [← hs2]; rfl
        rw [h2 w]
        split
        · rfl
        · exact exec_execf cs c fr _ (hp' _) s2 h2

-- 3, at each read of a run: the model's came is causes.ts's from on the heap (A2), from first's
-- start on
theorem first_from (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {h : Causes Nat}
    {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h) {c : Nat}
    (hc : c < s.made) (rk : Nat) :
    ∃ h' lab', Causes.reachable h' ∧ Mirror (start s c rk) h' lab' ∧
      exec cs c (start s c rk) (cs c).f = execf (Causes.from h') cs c (start s c rk) (cs c).f := by
  obtain ⟨hr1, -, R1, -⟩ := start_heap R hr hc rk
  exact ⟨_, _, hr1, R1, exec_execf cs c _ (cs c).f (hA c) _
    (fun w => came_eq R1 (Causes.reachable_ok hr1).1 w c)⟩

end Wiring
