-- LLM generated working output
-- wiring: the model (Model.lean) to the proofs of the code's parts, so the model's abstractions
-- rest on them. on every reachable state (Quiescence.lean's Reach, A2):
--
-- 1. ranks. rank: rank.ts (Rank.lean) over the made, along the model's edges. ranked_reach:
--    Basic.lean's ranked holds; below: so next_below's hypothesis is discharged
-- 2. order. view: order.ts's state seen from the model (due with marks, after, values, alive: the
--    made). next_same: on any view with Order.lean's good and its cache right, order.ts's next
--    answers the model's next, with its rank (both least by (rank, mark, n)). acyclic_view,
--    total_view: Lemma N gives Order.lean's acyclicity. calls: the order states the scheduler's
--    calls reach, each call with its precondition (set on alive, started on fresh, sees nodup).
--    reach_order, next_reach: every reachable state has one it drives (Drives: the view, good,
--    right, heap alive), and there order.ts's next is the model's
-- 3. causes. Mirror: the model's causes on a heap of causes.ts's (Causes.lean), objects in the
--    order made, each labelled (computation, run). reach_heap: every reachable state has one,
--    reached by run, keep, drop and end with the callers' promises kept (Causes.reachable;
--    given_promise, keep_promise). came_eq, loopof_eq: came is from, loopof is loop; at each mark
--    (mark_loop), at each read of a run (first_from), on every reachable state (causes_reach)
--
-- assumed: A2 (no writes in runs), as Quiescence.lean, wherever Reach is used. next_same alone
-- takes good and right of its order state; reach_order discharges them
--
-- where this departs: computations are their n (Nat), order.ts's n is id; all() is range made,
-- and rank.ts is blind to which univ holds the alive (rk_univ); alive is made (no dispose, so no
-- gone); a cause object is told by its label, one per run among this pulse's objects (Mirror.inj)
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

-- a run (A2) keeps its record's writers a set of made ones
theorem exec_vals (cs : Nat → Comp K V) (c m : Nat) :
    ∀ (p : Prog K V), nowrites p → ∀ (s : State K V),
    (∀ k w, s.writers k = some w → w < m) →
    (∀ r, s.ran c = some r → okvals m r.values) →
    ∀ r, (exec cs c s p).1.ran c = some r → okvals m r.values
  | .value _, _, s, _, h => by simpa [exec] using h
  | .error, _, s, _, h => by simpa [exec] using h
  | .pending, _, s, _, h => by simpa [exec] using h
  | .write .., hp, _, _, _ => absurd hp (by simp [nowrites])
  | .read k next, hp, s, hw, h => by
    have hp' := fun x => (show nowrites (Prog.read k next) from hp) x
    simp only [exec]
    generalize hs1 : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) = s1
    have e1 : s1.writers = s.writers := by rw [← hs1]; rfl
    have h1 : ∀ r, s1.ran c = some r → okvals m r.values := by
      intro r hr
      rw [← hs1] at hr
      simp only [edit, put_same, Option.map_eq_some_iff] at hr
      obtain ⟨r0, hr0, rfl⟩ := hr
      exact h r0 hr0
    have go : ∀ (s2 : State K V), s2.writers = s.writers →
        (∀ r, s2.ran c = some r → okvals m r.values) →
        ∀ r, (exec cs c s2 (next (s.store k))).1.ran c = some r → okvals m r.values :=
      fun s2 w2 h2 => exec_vals cs c m (next (s.store k)) (hp' _) s2 (by rw [w2]; exact hw) h2
    rw [e1]
    split
    · exact go s1 e1 h1
    · rename_i w hwk
      split
      · exact go s1 e1 h1
      · have hwm : w < m := hw k w hwk
        generalize hs2 : edit s1 c (fun r => { r with values := ins w r.values }) = s2
        have w2 : s2.writers = s.writers := by rw [← hs2]; exact e1
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
        · exact go s2 w2 h2

-- first, A2: start, f's run, and its end, with what f read and the writers it read
theorem first_eq (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    (hw : ∀ k w, s.writers k = some w → w < s.made) :
    ∃ (o : Out V) (seen : List (K × Option V)) (vals : List Nat) (st : Option Nat),
      first cs s c rk = ending cs { start s c rk with
          ran := put s.ran c (some (begun s c vals st seen)),
          reads := put s.reads c (seen.map (·.1)) } c o ∧
      okvals s.made vals := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, heq, -, -, -⟩ :=
    exec_spec cs c (cs c).f hp (start s c rk) _ h0 rfl
  have hv := exec_vals cs c s.made (cs c).f hp (start s c rk) (by simpa [start, say] using hw)
    (by intro r hr; rw [h0] at hr; cases hr; exact ⟨List.nodup_nil, by simp [begun]⟩)
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq hv
  obtain ⟨s2, o⟩ := x
  simp only at heq hv
  subst heq
  refine ⟨o, seen, vals, st, ?_, ?_⟩
  · congr 1
    simp [start, say, put_put, begun]
  · have hh := hv _ (put_same _ _ _)
    exact hh

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
    rw [finish_eq s c r hr]
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
    (hw : ∀ k w, s.writers k = some w → w < s.made) {c : Nat} (hc : c < s.made) (rk : Nat) :
    Vals (first cs s c rk) := by
  obtain ⟨o, seen, vals, st, h, hv⟩ := first_eq cs s c rk (hA c) hw
  rw [h]
  refine Vals.ending ?_ (by simp [start, say, hc]) o
  refine ⟨?_, ?_, ?_⟩
  · intro p hp; simp [start, say] at hp ⊢; exact v.out p hp
  · intro p; simp only [start, say]; exact v.vals p
  · intro d r h
    dsimp only at h ⊢
    simp only [start, say]
    by_cases hd : d = c
    · subst hd; simp at h; subst h; exact hv
    · rw [put_ne _ _ hd] at h; exact v.runs d r h

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

theorem Vals.step {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s s' : State K V}
    (v : Vals s) (hA : A2 cs) (g : Core cs s) (h : step cs rk s = some s') : Vals s' := by
  unfold Model.step at h
  split at h
  · split at h
    · rename_i c hc
      cases h
      exact v.first hA g.writers_made (next_ready hc).2 _
    · cases h; exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
  · split at h
    · cases h
      refine Vals.frame ?_ (act_frame _ _ _ _)
      exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
    · split at h
      · cases h; exact v.frame ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩
      · cases h

theorem Vals.make {cs : Nat → Comp K V} {s : State K V} (v : Vals s) : Vals (make cs s) := by
  unfold Model.make
  dsimp only
  have hv : ∀ (s1 : State K V), s1.made = s.made + 1 → s1.values = s.values → s1.ran = s.ran →
      Vals s1 := by
    intro s1 e1 e2 e3
    refine ⟨?_, ?_, ?_⟩
    · intro p hp; rw [e2]; exact v.out p (by omega)
    · intro p; rw [e1, e2]; exact okvals_mono (v.vals p) (by omega)
    · intro c r h; rw [e1]; rw [e3] at h; exact okvals_mono (v.runs c r h) (by omega)
  refine Vals.frame ?_ (mark_frame _ _ _ _)
  split <;> exact hv _ rfl rfl rfl

theorem Vals.close {s : State K V} (v : Vals s) : Vals (close s) :=
  v.of rfl (fun _ => Or.inl rfl) (fun _ r h => ⟨r, h, rfl⟩)

-- on every reachable state (A2): the values are sets of made computations, none for one not made
theorem vals_reach {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (h : Reach cs rk s) : Vals s := by
  induction h with
  | empty =>
    exact ⟨fun _ _ => rfl, fun _ => ⟨List.nodup_nil, by simp [Model.empty]⟩,
      fun _ _ h => by simp [Model.empty] at h⟩
  | make _ ih => exact ih.make
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
  next_below hA h (ranked_reach hA h) hp

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

-- order.ts's view of a model state: the due with their marks (a Map's get), what each waits
-- after, the writers each last read (p.after, p.values), and the alive: the made
structure view (s : State K V) (o : Order.State Nat) : Prop where
  due : ∀ p, Order.get o.due p = s.due p
  after : o.after = s.after
  values : o.values = s.values
  alive : ∀ p, o.alive p = decide (p < s.made)

-- ready is order.ts's: due, and not waiting after a due one
theorem ready_iff {s : State K V} {o : Order.State Nat} (v : view s o) (p : Nat) :
    ready s p = true ↔ (Order.get o.due p).isSome ∧ Order.waiting o.due o.after p = false := by
  simp only [ready, Order.waiting, v.due, v.after, Bool.and_eq_true]
  cases s.after p with
  | none => simp
  | some q => cases s.due q <;> simp

-- the order's ranks are the model's: rank.ts over the same edges, made from any univ holding the
-- made (order.ts: all(), the live)
theorem rank_view {s : State K V} {o : Order.State Nat} (v : view s o) {univ : List Nat}
    (hu : ∀ p, p < s.made → p ∈ univ) (p : Nat) :
    RankOrder.rk univ o.alive (Order.link o) p = rank s p := by
  unfold RankOrder.rk rank
  refine RankOrder.rank_same (RankOrder.rk_close (Order.link_alive o)) (edges_close s) ?_ p
  intro a b
  simp only [List.mem_filter, Order.link, Order.edge, v.alive, v.values, v.after, List.mem_range,
    edges, List.mem_append, Option.mem_toList, Bool.and_eq_true, decide_eq_true_eq,
    Bool.or_eq_true, bne_iff_ne, ne_eq]
  constructor
  · rintro ⟨⟨-, ha⟩, -, ⟨hb, hm⟩, h⟩
    exact ⟨ha, by rcases h with h | h <;> simp_all, hb, hm⟩
  · rintro ⟨ha, h, hb, hm⟩
    refine ⟨⟨hu a ha, ha⟩, hu b hm, ⟨hb, hm⟩, ?_⟩
    rcases h with h | h
    · exact Or.inl h
    · exact Or.inr (by simp_all)

-- 2: order.ts's next, on any order state the model's view with its promise (good) and its cache
-- right, answers what the model's next does, with the same rank. both are the least ready one by
-- (rank, mark, n), and n is unique
theorem next_same {s : State K V} {o : Order.State Nat} (v : view s o) (hg : Order.good id o)
    {univ : List Nat} (hr : Order.right (RankOrder.rk univ) o) (hu : ∀ p, p < s.made → p ∈ univ) :
    (Order.next id (RankOrder.rk univ) o).1 = (next rank s).map fun p => (p, rank s p) := by
  have hrk : ∀ q m, Order.get o.due q = some m →
      ((Order.ready id (RankOrder.rk univ) o).2 q).getD 0 = rank s q := by
    intro q m hq
    rw [Order.ready_made id _ hr]
    simp only [Order.made, hg.2.1 q m hq, ite_true, Option.getD_some]
    exact rank_view v hu q
  have hmade : ∀ q m, Order.get o.due q = some m → q < s.made := by
    intro q m hq
    have := hg.2.1 q m hq
    rw [v.alive] at this
    simpa using this
  have hmark : ∀ q m, Order.get o.due q = some m → stamp s q = m := by
    intro q m hq
    simp [stamp, ← v.due q, hq]
  cases hb : (Order.next id (RankOrder.rk univ) o).1 with
  | none =>
    cases hn : next rank s with
    | none => rfl
    | some c =>
      obtain ⟨h1, -, -⟩ := next_least hn
      obtain ⟨h2, h3⟩ := (ready_iff v c).1 h1
      obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h2
      have := Order.next_none id _ hg hb c m hm
      rw [h3] at this; cases this
  | some pk =>
    obtain ⟨p, k⟩ := pk
    obtain ⟨m, hm, hw, hk, hl⟩ := Order.next_best id _ hg hb
    have hpr : ready s p = true := (ready_iff v p).2 ⟨by simp [hm], hw⟩
    have hpm := hmade p m hm
    cases hn : next rank s with
    | none => have := next_none hn p hpm; rw [hpr] at this; cases this
    | some c =>
      obtain ⟨hc1, hc2, hc3⟩ := next_least hn
      obtain ⟨hcd, hcw⟩ := (ready_iff v c).1 hc1
      obtain ⟨mc, hmc⟩ := Option.isSome_iff_exists.1 hcd
      have a := hc3 p hpr hpm
      have b := hl c mc hmc hcw
      rw [hrk c mc hmc] at b
      rw [hk, hrk p m hm] at b ⊢
      rw [hmark p m hm] at a
      rw [hmark c mc hmc] at a
      have e := before_total b a
      simp only [id, Prod.mk.injEq] at e
      obtain ⟨-, -, rfl⟩ := e
      rfl

-- 2: order.ts's next is total on the model's view: after-chains acyclic (Lemma N), so with
-- anything due it gives a computation (Order.lean's next_total, its hypothesis discharged)
theorem acyclic_view {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    {o : Order.State Nat} (hA : A2 cs) (h : Reach cs rk s) (v : view s o) :
    ∀ p, ¬ TransGen (Order.step o.due o.after) p p := by
  intro p hp
  refine (lemma_n hA h).1 p (tg_mono ?_ hp)
  intro a b hab
  simp only [aft]; rw [← v.after]; exact hab.2.1

theorem total_view {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    {o : Order.State Nat} (hA : A2 cs) (h : Reach cs rk s) (v : view s o) (hg : Order.good id o)
    (rk' : (Nat → Bool) → (Nat → Nat → Bool) → Nat → Nat) {p : Nat} (hp : (s.due p).isSome) :
    ∃ q k, (Order.next id rk' o).1 = some (q, k) := by
  refine Order.next_total id rk' hg ?_ (acyclic_view hA h v)
  intro e
  have := v.due p
  rw [e] at this
  simp [Order.get] at this
  rw [← this] at hp; cases hp

/-! ### the heap's entries alive, and started on a fresh one -/

section live

variable {α : Type} [DecidableEq α]

-- every heap entry is of an alive computation: kept by every order call but gone, which the model
-- never makes (no dispose)
def live (o : Order.State α) : Prop := ∀ e ∈ o.heap, o.alive e.p = true

theorem get_some {d : List (α × Nat)} {x : α × Nat} (h : x ∈ d) : (Order.get d x.1).isSome := by
  induction d with
  | nil => simp at h
  | cons y d ih =>
    obtain ⟨q, m⟩ := y
    simp only [Order.get]
    split
    · rfl
    · rcases List.mem_cons.1 h with rfl | h
      · rename_i hq; exact absurd rfl hq
      · exact ih h

theorem live_set (n : α → Nat) {o : Order.State α} (hl : live o) {p : α} (ha : o.alive p = true)
    (m : Nat) : live (Order.set n o p m) := by
  unfold Order.set
  split
  · exact hl
  · intro e he
    simp only at he ⊢
    rw [Order.push_perm.mem_iff] at he
    rcases List.mem_append.1 he with he | he
    · exact hl e he
    · simp at he; subst he; exact ha

theorem live_delete {o : Order.State α} (hl : live o) (p : α) : live (Order.delete o p) := hl

theorem live_started {o : Order.State α} (hl : live o) (p : α) : live (Order.started o p) := by
  intro e he
  simp only [Order.started, Order.update]
  split
  · rfl
  · exact hl e he

theorem live_sees (n : α → Nat) {o : Order.State α} (hl : live o) (p : α) (l : List α) :
    live (Order.sees o p l) := by
  obtain ⟨a, -, -, -, h, -⟩ := Order.sees_fields n o p l
  intro e he; rw [a]; rw [h] at he; exact hl e he

theorem live_waits (n : α → Nat) {o : Order.State α} (hl : live o) (p : α) (q : Option α) :
    live (Order.waits o p q) := by
  obtain ⟨a, -, -, -, h, -⟩ := Order.waits_fields n o p q
  intro e he; rw [a]; rw [h] at he; exact hl e he

theorem ready_entries (n : α → Nat) (rk : (α → Bool) → (α → α → Bool) → α → Nat) (o : Order.State α) :
    ∀ e ∈ (Order.ready n rk o).1.heap, e ∈ o.heap ∨ ∃ x ∈ o.due, e.p = x.1 := by
  have h1 : (Order.ranks rk o).1.heap = o.heap ∧ (Order.ranks rk o).1.due = o.due := by
    unfold Order.ranks; split <;> exact ⟨rfl, rfl⟩
  intro e he
  unfold Order.ready at he
  simp only at he
  split at he
  · right
    obtain ⟨x, hx, rfl⟩ := (Order.remake_mem n).1 he
    exact ⟨x, h1.2 ▸ hx, rfl⟩
  · left; exact h1.1 ▸ he

theorem live_next (n : α → Nat) (rk : (α → Bool) → (α → α → Bool) → α → Nat) {o : Order.State α}
    (hg : Order.good n o) (hl : live o) : live (Order.next n rk o).2 := by
  obtain ⟨-, -, rh, -, -, -, ralive, -, -, -⟩ := Order.ready_spec n rk hg
  unfold Order.next
  simp only
  generalize hs : Order.scan n (Order.ready n rk o).1.due (Order.ready n rk o).1.after
    (Order.ready n rk o).1.heap [] = l
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨-, -, -, i4, i5, -, -⟩ := Order.scan_spec n _ _ _ _ _ hs rh
  intro e he
  simp only at he ⊢
  rw [(Order.pushall_perm w' h').mem_iff] at he
  rw [ralive]
  have hr : e ∈ (Order.ready n rk o).1.heap := by
    rcases List.mem_append.1 he with he | he
    · exact i4 e he
    · rcases i5 e he with he | he
      · exact he
      · simp at he
  rcases ready_entries n rk o e hr with h | ⟨x, hx, hp⟩
  · exact hl e h
  · rw [hp]
    obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 (get_some hx)
    exact hg.2.1 _ m hm

end live

-- started only on fresh (scheduler.ts, make: order.started(c), c a new object): on a reachable
-- state, the one make makes next is fresh in the view: not alive, after nothing, named by none,
-- not due, and (the heap's entries alive) in no entry
theorem started_fresh {cs : Nat → Comp K V} {rk : State K V → Nat → Nat} {s : State K V}
    {o : Order.State Nat} (hA : A2 cs) (h : Reach cs rk s) (v : view s o) (hl : live o) :
    Order.fresh o s.made := by
  have g := (h.good hA).toCore
  have vs := vals_reach hA h
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
  · simp [v.alive]
  · rw [v.values]; exact vs.out _ (Nat.le_refl _)
  · rw [v.after]
    cases e : s.after s.made with
    | none => rfl
    | some w => have := g.due_made _ (g.after_due _ _ e).1; omega
  · intro x
    constructor
    · rw [v.values]; intro hm; have := (vs.vals x).2 _ hm; omega
    · rw [v.after]; intro e; have := (g.after_due x _ e).2; omega
  · rw [v.due]
    cases e : s.due s.made with
    | none => rfl
    | some _ => have := g.due_made s.made (by simp [e]); omega
  · intro e he hp
    have := hl e he
    rw [v.alive, hp] at this
    simp at this

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

-- rank.ts's ranks are blind to which univ holds the alive (order.ts: all(), the live)
theorem rk_univ {u1 u2 : List Nat} {A : Nat → Bool} {L : Nat → Nat → Bool}
    (hL : ∀ x y, L x y = true → A y = true) (h1 : ∀ p, A p = true → p ∈ u1)
    (h2 : ∀ p, A p = true → p ∈ u2) : RankOrder.rk u1 A L = RankOrder.rk u2 A L := by
  funext p
  unfold RankOrder.rk
  refine RankOrder.rank_same (RankOrder.rk_close hL) (RankOrder.rk_close hL) ?_ p
  intro a b
  simp only [List.mem_filter]
  constructor
  · rintro ⟨⟨-, ha⟩, -, hb⟩; exact ⟨⟨h2 a ha, ha⟩, h2 b (hL a b hb), hb⟩
  · rintro ⟨⟨-, ha⟩, -, hb⟩; exact ⟨⟨h1 a ha, ha⟩, h1 b (hL a b hb), hb⟩

theorem right_univ {o : Order.State Nat} {u1 u2 : List Nat} (hr : Order.right (RankOrder.rk u1) o)
    (h1 : ∀ p, o.alive p = true → p ∈ u1) (h2 : ∀ p, o.alive p = true → p ∈ u2) :
    Order.right (RankOrder.rk u2) o := by
  intro r hc
  rw [hr r hc]
  unfold Order.made
  rw [rk_univ (Order.link_alive o) h1 h2]

-- the order states the scheduler's calls reach from createOrder, each call with Order.lean's
-- precondition: set on an alive one, started on a fresh one, sees with no duplicates. next is
-- followed by first's delete of what it gave (pulse: first(order.next()))
inductive calls : Order.State Nat → Prop
  | init : calls Order.init
  | set {o : Order.State Nat} {p m : Nat} : calls o → o.alive p = true → calls (Order.set id o p m)
  | next {o : Order.State Nat} {p k : Nat} (u : List Nat) : calls o →
      (Order.next id (RankOrder.rk u) o).1 = some (p, k) →
      calls (Order.delete (Order.next id (RankOrder.rk u) o).2 p)
  | started {o : Order.State Nat} {p : Nat} : calls o → Order.fresh o p → calls (Order.started o p)
  | sees {o : Order.State Nat} {p : Nat} {l : List Nat} : calls o → l.Nodup →
      calls (Order.sees o p l)
  | waits {o : Order.State Nat} {p : Nat} {q : Option Nat} : calls o → calls (Order.waits o p q)

-- an order state driven by the model: its view, its promise (good), its cache right for rank.ts
-- over the made, its heap's entries alive
structure Drives (s : State K V) (o : Order.State Nat) : Prop where
  view : view s o
  good : Order.good id o
  right : Order.right (RankOrder.rk (List.range s.made)) o
  live : live o

theorem Drives.of_eq {s s' : State K V} {o : Order.State Nat} (D : Drives s o)
    (e1 : s'.made = s.made) (e2 : s'.due = s.due) (e3 : s'.after = s.after)
    (e4 : s'.values = s.values) : Drives s' o where
  view := ⟨fun p => by rw [e2]; exact D.view.due p, by rw [e3]; exact D.view.after,
    by rw [e4]; exact D.view.values, fun p => by rw [e1]; exact D.view.alive p⟩
  good := D.good
  right := by rw [e1]; exact D.right
  live := D.live

theorem set_due (o : Order.State Nat) (p m : Nat) :
    (Order.set id o p m).due = Order.put o.due p m := by
  unfold Order.set; split <;> rfl

theorem set_fields (o : Order.State Nat) (p m : Nat) :
    (Order.set id o p m).alive = o.alive ∧ (Order.set id o p m).after = o.after ∧
      (Order.set id o p m).values = o.values ∧ (Order.set id o p m).cache = o.cache := by
  unfold Order.set; split <;> exact ⟨rfl, rfl, rfl, rfl⟩

theorem set_right {o : Order.State Nat} {rk : (Nat → Bool) → (Nat → Nat → Bool) → Nat → Nat}
    (hr : Order.right rk o) (p m : Nat) : Order.right rk (Order.set id o p m) := by
  unfold Order.set; split <;> exact hr

-- order.set(p, m), from a driven state, as the model's due puts p at m
theorem set_drives {s s' : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    {p m : Nat} (hp : p < s.made) (e1 : s'.made = s.made)
    (e2 : ∀ x, s'.due x = if x = p then some m else s.due x) (e3 : s'.after = s.after)
    (e4 : s'.values = s.values) : calls (Order.set id o p m) ∧ Drives s' (Order.set id o p m) := by
  have ha : o.alive p = true := by rw [D.view.alive]; simpa using hp
  obtain ⟨f1, f2, f3, -⟩ := set_fields o p m
  refine ⟨.set hc ha, ⟨?_, ?_, ?_, ?_⟩, Order.set_good id D.good ha, ?_, live_set id D.live ha m⟩
  · intro x
    rw [set_due, Order.get_put, e2, D.view.due x]
    by_cases hx : x = p
    · subst hx; simp
    · simp [hx, Ne.symm hx]
  · rw [f2, e3]; exact D.view.after
  · rw [f3, e4]; exact D.view.values
  · intro x; rw [f1, e1]; exact D.view.alive x
  · rw [e1]; exact set_right D.right p m

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

-- a mark: order.set(d, t) when d was not due and is now, else no call
theorem mark_order {s : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o) {d : Nat}
    (hd : d < s.made) (t : Nat) (who : Option Nat) :
    ∃ o', calls o' ∧ Drives (mark s d t who) o' := by
  have f := mark_frame s d t who
  rcases mark_due_d s d t who with e | ⟨-, e⟩
  · refine ⟨o, hc, D.of_eq f.made ?_ f.after f.values⟩
    funext x
    by_cases hx : x = d
    · subst hx; exact e
    · exact mark_due s d t who x hx
  · refine ⟨Order.set id o d t, set_drives (m := t) D hc hd f.made ?_ f.after f.values⟩
    intro x
    by_cases hx : x = d
    · subst hx; simp [e]
    · simp [hx, mark_due s d t who x hx]

theorem marks_order (t : Nat) (r : Option Nat) :
    ∀ (ds : List Nat) (s : State K V) (o : Order.State Nat), Drives s o → calls o →
      (∀ d ∈ ds, d < s.made) → ∃ o', calls o' ∧ Drives (ds.foldl (fun s d => mark s d t r) s) o'
  | [], s, o, D, hc, _ => ⟨o, hc, D⟩
  | d :: ds, s, o, D, hc, hd => by
    obtain ⟨o1, hc1, D1⟩ := mark_order D hc (hd d (by simp)) t r
    exact marks_order t r ds _ o1 D1 hc1
      (by rw [(mark_frame s d t r).made]; exact fun x hx => hd x (by simp [hx]))

theorem changed_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) (keys : List K) (who : Option Nat) :
    ∃ o', calls o' ∧ Drives (changed cs s keys who) o' := by
  simp only [changed]
  generalize ht : s.tick + 1 = t
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
      obtain ⟨o2, hc2, D2⟩ := marks_order t r (readers (learn s1 k w) k) _ o1 Dl hc1
        (fun d hd => readers_made hd)
      exact ih _ o2 D2 hc2
  exact fold keys _ o D0 hc

-- make: order.started(c) on the new c (fresh), then its mark
theorem make_order (cs : Nat → Comp K V) {s : State K V} {o : Order.State Nat} (D : Drives s o)
    (hc : calls o) (hf : Order.fresh o s.made) : ∃ o', calls o' ∧ Drives (make cs s) o' := by
  have D1 : ∀ s1 : State K V, s1.made = s.made + 1 → s1.due = s.due → s1.after = s.after →
      s1.values = s.values → Drives s1 (Order.started o s.made) := by
    intro s1 e1 e2 e3 e4
    refine ⟨⟨?_, ?_, ?_, ?_⟩, Order.started_good id D.good hf, ?_, live_started D.live _⟩
    · intro p; rw [e2]; exact D.view.due p
    · rw [e3]; exact D.view.after
    · rw [e4]; exact D.view.values
    · intro p
      simp only [Order.started, Order.update, e1]
      split
      · rename_i h; subst h; simp
      · rename_i h; rw [D.view.alive]; simp only [decide_eq_decide]; omega
    · rw [e1]
      refine Order.started_right _ (RankOrder.rk_reach _) hf (right_univ D.right ?_ ?_)
      · intro p hp; rw [D.view.alive] at hp; simpa using hp
      · intro p hp; rw [D.view.alive] at hp; simp at hp ⊢; omega
  unfold Model.make
  dsimp only
  split
  · refine mark_order ?_ (.started hc hf) (by simp) _ _
    exact D1 _ rfl rfl rfl rfl
  · refine mark_order ?_ (.started hc hf) (by simp) _ _
    exact D1 _ rfl rfl rfl rfl

-- finish: order.sees(c, r.values) unless stopped
theorem finish_order {s : State K V} {o : Order.State Nat} (D : Drives s o) (hc : calls o)
    {c : Nat} (hv : ∀ r, s.ran c = some r → r.values.Nodup) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) :
    ∃ o', calls o' ∧ Drives (finish s c e eq w th) o' := by
  cases hrc : s.ran c with
  | none => simp only [Model.finish, hrc]; exact ⟨o, hc, D⟩
  | some r =>
    rw [finish_eq s c r hrc]
    by_cases hs : e = .stopped
    · subst hs; exact ⟨o, hc, D.of_eq rfl rfl rfl (by simp)⟩
    · obtain ⟨a, vf, f, du, -, -, gd⟩ := Order.sees_fields id o c r.values
      refine ⟨Order.sees o c r.values, .sees hc (hv r hrc), ⟨⟨?_, ?_, ?_, ?_⟩, gd D.good, ?_,
        live_sees id D.live c r.values⟩⟩
      · intro p; rw [du]; exact D.view.due p
      · rw [f]; exact D.view.after
      · rw [vf]; simp only [hs, ne_eq, not_false_eq_true, ite_true]; rw [D.view.values]; rfl
      · intro p; rw [a]; exact D.view.alive p
      · exact Order.sees_right _ o c r.values D.right

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
    (out : Out V) : ∃ o', calls o' ∧ Drives (ending cs s c out) o' := by
  unfold Model.ending
  split
  · unfold Model.stop
    split
    · exact ⟨o, hc, D⟩
    · rename_i r hr
      dsimp only
      obtain ⟨a, vf, f, du, -, -, gd⟩ := Order.waits_fields id o c r.stopped
      have Dw : Drives { s with after := put s.after c r.stopped } (Order.waits o c r.stopped) :=
        ⟨⟨fun p => by rw [du]; exact D.view.due p, by rw [f, D.view.after]; rfl,
          by rw [vf]; exact D.view.values, fun p => by rw [a]; exact D.view.alive p⟩,
          gd D.good, Order.waits_right _ o c r.stopped D.right, live_waits id D.live c r.stopped⟩
      have key : ∀ X : State K V, X.made = s.made → X.due = put s.due c (some r.mark) →
          X.after = put s.after c r.stopped → X.values = s.values →
          (∀ r', X.ran c = some r' → r'.values.Nodup) →
          ∃ o', calls o' ∧ Drives (finish X c .stopped none r.stopped none) o' := by
        intro X e1 e2 e3 e4 hX
        obtain ⟨hc2, D2⟩ := set_drives (m := r.mark) (s' := X) Dw (.waits hc) hcm e1
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

-- a run: c = order.next(), then first's order.delete(c), order.waits(c, undefined), and its end
theorem first_order (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {o : Order.State Nat}
    (D : Drives s o) (hc : calls o) (hw : ∀ k w, s.writers k = some w → w < s.made) {c : Nat}
    (hn : next rank s = some c) :
    (Order.next id (RankOrder.rk (List.range s.made)) o).1 = some (c, rank s c) ∧
      ∃ o', calls o' ∧ Drives (first cs s c (rank s c)) o' := by
  have hns := next_same D.view D.good D.right (fun p hp => List.mem_range.2 hp)
  rw [hn] at hns
  simp only [Option.map_some] at hns
  refine ⟨hns, ?_⟩
  have hc2 : calls (Order.delete (Order.next id (RankOrder.rk (List.range s.made)) o).2 c) :=
    .next _ hc hns
  generalize hrk : RankOrder.rk (List.range s.made) = rk at hns hc2
  have r0 : Order.right rk o := by rw [← hrk]; exact D.right
  have g2 : Order.good id (Order.delete (Order.next id rk o).2 c) := by
    have := Order.next_good id rk D.good
    rw [hns] at this
    exact this
  have r1 := Order.next_right id rk D.good r0
  obtain ⟨k1, k2, k3, k4, -⟩ := Order.next_keeps id rk D.good
  generalize ho1 : (Order.next id rk o).2 = o1 at g2 r1 k1 k2 k3 k4 hc2
  obtain ⟨a, vf, f, du, -, -, gd⟩ := Order.waits_fields id (Order.delete o1 c) c none
  have hc3 : calls (Order.waits (Order.delete o1 c) c none) := .waits hc2
  have D3 : Drives (start s c (rank s c)) (Order.waits (Order.delete o1 c) c none) := by
    refine ⟨⟨?_, ?_, ?_, ?_⟩, gd g2, ?_, ?_⟩
    · intro x
      rw [du]
      simp only [Order.delete, Order.get_del, start, say]
      rw [k1, D.view.due x]
      by_cases hx : x = c
      · subst hx; simp
      · simp [hx, Ne.symm hx]
    · rw [f]
      simp only [Order.delete, start, say]
      rw [k3, D.view.after]; rfl
    · rw [vf]; simp only [Order.delete, start, say]; rw [k4]; exact D.view.values
    · intro x; rw [a]; simp only [Order.delete, start, say]; rw [k2]; exact D.view.alive x
    · simp only [start, say]; rw [hrk]
      exact Order.waits_right _ _ c none r1
    · exact live_waits id (live_delete (ho1 ▸ live_next id rk D.good D.live) c) c none
  obtain ⟨out, seen, vals, st, hf, hv⟩ := first_eq cs s c (rank s c) (hA c) hw
  rw [hf]
  refine ending_order cs ?_ hc3 (by simpa [start, say] using (next_ready hn).2) ?_ out
  · exact D3.of_eq rfl rfl rfl rfl
  · intro r hr
    simp only [put_same, Option.some.injEq] at hr
    subst hr
    exact hv.1

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

-- a step of a pulse, with rank.ts's ranks
theorem step_order (cs : Nat → Comp K V) (hA : A2 cs) {s s' : State K V} {o : Order.State Nat}
    (g : Core cs s) (D : Drives s o) (hc : calls o) (hs : step cs rank s = some s') :
    ∃ o', calls o' ∧ Drives s' o' := by
  unfold Model.step at hs
  split at hs
  · split at hs
    · rename_i c hn
      cases hs
      exact (first_order cs hA D hc g.writers_made hn).2
    · cases hs; exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
  · split at hs
    · cases hs
      refine act_order cs ?_ hc _ _
      exact D.of_eq rfl rfl rfl rfl
    · split at hs
      · cases hs; exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩
      · cases hs

theorem drives_init : Drives (empty : State K V) (Order.init : Order.State Nat) where
  view := ⟨fun p => by simp [Order.init, Order.get, Model.empty], by rfl, by rfl,
    fun p => by simp [Order.init, Model.empty]⟩
  good := (Order.inv_init id (RankOrder.rk []) []).1
  right := fun r h => by simp [Order.init] at h
  live := fun e h => by simp [Order.init] at h

-- 2, all the way: on every reachable state (A2, rank.ts's ranks), order.ts's state, reached from
-- createOrder by the scheduler's calls (each meeting Order.lean's precondition), is the model's
-- view, keeps its promise and its cache right; so its next is the model's next (next_same)
theorem reach_order {cs : Nat → Comp K V} {s : State K V} (hA : A2 cs) (h : Reach cs rank s) :
    ∃ o, calls o ∧ Drives s o := by
  induction h with
  | empty => exact ⟨_, .init, drives_init⟩
  | @make s hs ih =>
    obtain ⟨o, hc, D⟩ := ih
    exact make_order cs D hc (started_fresh hA hs D.view D.live)
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
  | step hs h ih =>
    obtain ⟨o, hc, D⟩ := ih
    exact step_order cs hA (hs.good hA).toCore D hc h
  | close _ _ ih =>
    obtain ⟨o, hc, D⟩ := ih
    exact ⟨o, hc, D.of_eq rfl rfl rfl rfl⟩

-- the headline of 2: on every reachable state, order.ts's next on the order the scheduler drove
-- answers the model's next, with its rank
theorem next_reach {cs : Nat → Comp K V} {s : State K V} (hA : A2 cs) (h : Reach cs rank s) :
    ∃ o, calls o ∧ Drives s o ∧
      (Order.next id (RankOrder.rk (List.range s.made)) o).1 = (next rank s).map fun p => (p, rank s p) := by
  obtain ⟨o, hc, D⟩ := reach_order hA h
  exact ⟨o, hc, D, next_same D.view D.good D.right (fun p hp => List.mem_range.2 hp)⟩

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
  -- causes.ts ran: the computations that ran this pulse
  ran : ∀ c, s.went c = true ↔ c ∈ h.ran
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
    (e1 : s.made ≤ s'.made) (e2 : ∀ c, (s'.ran c).map (·.n) = (s.ran c).map (·.n))
    (e3 : s'.runs = s.runs) (e4 : s'.pulses = s.pulses) (e5 : s'.cause = s.cause)
    (e6 : s'.when = s.when) (e7 : s'.went = s.went) (e8 : s'.kept = s.kept) : Mirror s' h lab := by
  have hs : ∀ c, (s'.ran c).isSome = (s.ran c).isSome := by
    intro c; have := congrArg Option.isSome (e2 c); simpa using this
  exact {
    ran := fun c => by rw [e7]; exact R.ran c
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
      have e' : r0.n = r.n := e
      rw [e3, ← e']; exact R.run c r0 h0
    ranmade := fun c h => Nat.lt_of_lt_of_le (R.ranmade c (hs c ▸ h)) e1 }

theorem Mirror.settle {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (d t : Nat) (who : Option Nat) (l : Option (List Nat)) (fl : Bool) :
    Mirror (settle s d t who l fl) h lab := by
  obtain ⟨a, b, c, e, g, hs⟩ := settle_shape s d t who l fl
  rw [hs]
  exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl

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
        simp only [h', Causes.run, Causes.mem_add]
        by_cases hx : x = c
        · subst hx; simp
        · simp [put_ne _ _ hx, R.ran x, hx]
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

-- keep: a mark's cause kept on d (causes.keep(d, cause)): the model's keep, by run, is keep's add,
-- by object, as the labels of this pulse's objects are one per run
theorem keep_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {k : Why} {i : Nat} (hn : names h lab k i) (d : Nat) :
    Causes.reachable (Causes.keep h d i) ∧ grows h lab (Causes.keep h d i) lab ∧
      Mirror (keep s d k) (Causes.keep h d i) lab := by
  obtain ⟨hs, hi, ht, hl⟩ := hn
  refine ⟨.keep hr hs hi, ⟨ext_refl _, rfl, fun _ _ => rfl⟩, ?_⟩
  have hiff : ((s.kept d).any fun x => x.of == k.of) = true ↔ i ∈ h.kept d := by
    rw [List.any_eq_true]
    have := pairs.exists (P := fun x : Why => x.of = k.of) (Q := fun j => j = i) ?_ (R.kept d)
    · simp only [beq_iff_eq]
      rw [this]
      simp
    · rintro x j ⟨hj1, hj2, -, hj3⟩
      constructor
      · intro e
        exact R.inj j i hj1 hs hj2 hi (by rw [hj3, hl, e])
      · intro e; subst e; rw [← hj3, hl]
  unfold Model.keep
  split
  · rename_i hany
    have hin := hiff.1 hany
    exact {
      ran := R.ran
      made := R.made
      cause := R.cause
      inj := R.inj
      runs := R.runs
      now := R.now
      when := R.when
      run := R.run
      ranmade := R.ranmade
      kept := fun t => by
        simp only [Causes.keep]
        split
        · rename_i e; subst e; simp only [Causes.add, hin, ite_true]; exact R.kept t
        · exact R.kept t }
  · rename_i hany
    have hin : i ∉ h.kept d := fun h' => hany (hiff.2 h')
    exact {
      ran := R.ran
      made := R.made
      cause := R.cause
      inj := R.inj
      runs := R.runs
      now := R.now
      when := R.when
      run := R.run
      ranmade := R.ranmade
      kept := fun t => by
        simp only [Causes.keep]
        split
        · rename_i e; subst e
          simp only [Causes.add, hin, ite_false, put_same]
          exact (R.kept t).append (.cons ⟨hs, hi, ht, hl⟩ .nil)
        · rename_i e
          simp only [put_ne _ _ e]
          exact R.kept t }

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
  obtain ⟨hr2, -, R2⟩ := keep_heap R1 hr1 hn1 d
  exact ⟨_, lab1, i, hr2, R2, hn1, loopof_eq R2 (Causes.reachable_ok hr2).1 hn1 d⟩

-- the promise run's callers keep (scheduler.ts first: causes.run(c, [...c.kept])): the given are
-- the objects c's kept causes stand for, each made, made this pulse
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

-- start: a new run of c, given the causes kept (causes.run(c, given))
theorem start_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} (hc : c < s.made) (rk : Nat) :
    Causes.reachable (Causes.run h c (h.kept c)).1 ∧
      grows h lab (Causes.run h c (h.kept c)).1 (put lab h.heap.size (c, s.runs c + 1)) ∧
      Mirror (start s c rk) (Causes.run h c (h.kept c)).1 (put lab h.heap.size (c, s.runs c + 1)) ∧
      pairs (names (Causes.run h c (h.kept c)).1 (put lab h.heap.size (c, s.runs c + 1)))
        (s.kept c) (h.kept c) := by
  obtain ⟨ho, hf⟩ := Causes.reachable_ok hr
  generalize hn : s.runs c + 1 = n
  let h' := (Causes.run h c (h.kept c)).1
  let lab' := put lab h.heap.size (c, n)
  have hsz : h'.heap.size = h.heap.size + 1 := by simp [h', Causes.run]
  have g : grows h lab h' lab' :=
    ⟨ext_push _ _, rfl, fun i hi => put_ne _ _ (Nat.ne_of_lt hi)⟩
  have hgiven : ∀ x ∈ h.kept c, h.since ≤ x ∧ x < h.heap.size :=
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
    have e1 : (h'.heap[h.heap.size]'(by omega)) = ⟨c, h.kept c⟩ := by simp [h', Causes.run]
    have e2 : Causes.ps h'.heap h.heap.size = h.kept c := by
      simp [h', Causes.run, Causes.ps_push]
    simp only [e1, Causes.kids, e2]
    congr 1
    refine kids_map (n := h.heap.size) (fun j hj => Causes.tree h'.heap j (by omega)) _ _ ?_
    refine (R.kept c).imp ?_
    intro k j ⟨_, hj, e⟩
    exact ⟨hj, by rw [tree_ext g.heap j hj]; exact e.1⟩
  refine ⟨.run hr hgiven, g, ?_, hk⟩
  exact {
    ran := fun x => by
      simp only [start, say, Causes.run, Causes.mem_add]
      by_cases hx : x = c
      · subst hx; simp
      · simp [put_ne _ _ hx, R.ran x, hx]
    made := fun i a ha => by
      simp only [Causes.run, Causes.ofs_push] at ha
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
    kept := fun t => pairs_grows g (R.kept t)
    inj := fun i j h1 h2 h3 h4 e => by
      simp only [Causes.run] at h1 h2 h3 h4
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
      simp only [Causes.run] at h1 h2
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
      simp only [Causes.run] at h1 h2
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

-- finish: done, the causes the run was given dropped from c's kept (scheduler.ts finish: for k of
-- r.given c.kept.delete(k)): causes.drop of their objects
theorem finish_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) {c : Nat} {gone : List Nat}
    (hg : ∀ r, s.ran c = some r → pairs (names h lab) r.given gone) (e : Ended)
    (eq : Option Bool) (w : Option Nat) (th : Option (List Nat)) :
    ∃ h', Causes.reachable h' ∧ grows h lab h' lab ∧ Mirror (finish s c e eq w th) h' lab := by
  cases hrc : s.ran c with
  | none => simp only [Model.finish, hrc]; exact ⟨h, hr, grows_refl h lab, R⟩
  | some r =>
    rw [finish_eq s c r hrc]
    have e2 : ∀ x, ((put s.ran c (some { r with ended := some e })) x).map (·.n) =
        (s.ran x).map (·.n) := by
      intro x
      by_cases hx : x = c
      · subst hx; simp [hrc]
      · simp [put_ne _ _ hx]
    by_cases hd : e = .done
    · subst hd
      refine ⟨Causes.drop h c gone, .drop hr, ⟨ext_refl _, rfl, fun _ _ => rfl⟩, ?_⟩
      have hgr := hg r hrc
      have hf : pairs (names h lab)
          ((s.kept c).filter fun k => !(r.given.any fun g => g.of == k.of))
          ((h.kept c).filter (· ∉ gone)) := by
        refine pairs.filter ?_ (R.kept c)
        rintro k j ⟨hj1, hj2, -, hj3⟩
        have := pairs.exists (P := fun g : Why => g.of = k.of) (Q := fun j' => j' = j) ?_ hgr
        · apply Bool.eq_iff_iff.2
          simp only [Bool.not_eq_true', List.any_eq_false, beq_iff_eq, decide_eq_true_eq]
          constructor
          · intro hn hj
            obtain ⟨g', hg', e'⟩ := this.2 ⟨j, hj, rfl⟩
            exact hn g' hg' e'
          · intro hn g' hg' e'
            obtain ⟨j', hj', rfl⟩ := this.1 ⟨g', hg', e'⟩
            exact hn hj'
        · rintro g' j' ⟨hj1', hj2', -, hj3'⟩
          constructor
          · intro e'; exact R.inj j' j hj1' hj1 hj2' hj2 (by rw [hj3', hj3, e'])
          · intro e'; subst e'; rw [← hj3', hj3]
      exact {
        ran := R.ran
        made := R.made
        cause := fun x h1 h2 => by
          have h1' : (s.ran x).isSome := by
            have := congrArg Option.isSome (e2 x); simp at this; rw [← this]; exact h1
          exact R.cause x h1' h2
        inj := R.inj
        runs := R.runs
        now := R.now
        when := R.when
        run := fun x r' h => by
          have := e2 x
          have h' : (put s.ran c (some { r with ended := some .done })) x = some r' := h
          rw [h', Option.map_some] at this
          obtain ⟨r0, h0, e⟩ := Option.map_eq_some_iff.1 this.symm
          have e' : r0.n = r'.n := e
          rw [← e']; exact R.run x r0 h0
        ranmade := fun x h => by
          have h1' : (s.ran x).isSome := by
            have := congrArg Option.isSome (e2 x); simp at this; rw [← this]; exact h
          exact R.ranmade x h1'
        kept := fun t => by
          simp only [Causes.drop, ite_true]
          by_cases ht : t = c
          · subst ht; simp only [put_same, ite_true]; exact hf
          · simp only [put_ne _ _ ht, ht, ite_false]; exact R.kept t }
    · refine ⟨h, hr, grows_refl h lab, ?_⟩
      exact R.of_eq (Nat.le_refl _) e2 rfl rfl rfl rfl rfl (by simp [hd])

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
  obtain ⟨h2, hr2, g2, R2⟩ := finish_heap R1 hr1 (gone := gone)
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
  · have e2 : ∀ x, ((edit s c fun r => { r with out := some o }).ran x).map (·.n) =
        (s.ran x).map (·.n) := by
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

-- a run (A2): causes.run(c, c.kept), then its end
theorem first_heap (cs : Nat → Comp K V) (hA : A2 cs) {s : State K V} {h : Causes Nat}
    {lab : Nat → Nat × Nat} (R : Mirror s h lab) (hr : Causes.reachable h)
    (hw : ∀ k w, s.writers k = some w → w < s.made) {c : Nat} (hc : c < s.made) (rk : Nat) :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror (first cs s c rk) h' lab' := by
  obtain ⟨o, seen, vals, st, hf, -⟩ := first_eq cs s c rk (hA c) hw
  rw [hf]
  obtain ⟨hr1, g1, R1, hk⟩ := start_heap R hr hc rk
  have R3 : Mirror { start s c rk with
      ran := put s.ran c (some (begun s c vals st seen)),
      reads := put s.reads c (seen.map (·.1)) } (Causes.run h c (h.kept c)).1
      (put lab h.heap.size (c, s.runs c + 1)) := by
    refine R1.of_eq (Nat.le_refl _) ?_ rfl rfl rfl rfl rfl rfl
    intro x
    simp only [start, say]
    by_cases hx : x = c
    · subst hx; simp [begun]
    · simp [put_ne _ _ hx]
  have hg : ∀ r, ({ start s c rk with
      ran := put s.ran c (some (begun s c vals st seen)),
      reads := put s.reads c (seen.map (·.1)) } : State K V).ran c = some r →
      pairs (names (Causes.run h c (h.kept c)).1 (put lab h.heap.size (c, s.runs c + 1))) r.given
        (h.kept c) := by
    intro r hr'
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

-- a pulse's end: causes.end, every kept cleared, ran forgotten; this pulse's objects old
theorem close_heap {s : State K V} {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) : Causes.reachable (Causes.end h) ∧ Mirror (close s) (Causes.end h) lab := by
  have ho := (Causes.reachable_ok hr).1
  refine ⟨.end hr, ?_⟩
  exact {
    ran := fun c => by simp [close, Causes.end]
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

-- a step of a pulse: a run, an act, or a phase change
theorem step_heap (cs : Nat → Comp K V) (hA : A2 cs) {rk : State K V → Nat → Nat}
    {s s' : State K V} (g : Core cs s) {h : Causes Nat} {lab : Nat → Nat × Nat} (R : Mirror s h lab)
    (hr : Causes.reachable h) (hs : step cs rk s = some s') :
    ∃ h' lab', Causes.reachable h' ∧ grows h lab h' lab' ∧ Mirror s' h' lab' := by
  unfold Model.step at hs
  split at hs
  · split at hs
    · rename_i c hc
      cases hs
      exact first_heap cs hA R hr g.writers_made (next_ready hc).2 _
    · cases hs
      exact ⟨h, lab, hr, grows_refl h lab, R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl⟩
  · split at hs
    · cases hs
      refine act_heap cs ?_ hr _ _
      exact R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
    · split at hs
      · cases hs
        exact ⟨h, lab, hr, grows_refl h lab, R.of_eq (Nat.le_refl _) (fun _ => rfl) rfl rfl rfl rfl rfl rfl⟩
      · cases hs

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
      made := fun i a h => by simp [Causes.create, Causes.ofs] at h
      cause := fun c h1 _ => by simp [Model.empty] at h1
      kept := fun t => by simp only [Model.empty, Causes.create]; exact .nil
      inj := fun i j _ _ h3 _ _ => by simp [Causes.create] at h3
      runs := fun i _ h2 => by simp [Causes.create] at h2
      now := fun i _ h2 => by simp [Causes.create] at h2
      when := fun c => by simp [Model.empty]
      run := fun c r h => by simp [Model.empty] at h
      ranmade := fun c h => by simp [Model.empty] at h }
  | make _ ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    unfold Model.make
    dsimp only
    split <;>
    · refine forget (lab := lab) (mark_heap ?_ hr _ _ none (by simp))
      exact R.of_eq (by simp) (fun _ => rfl) rfl rfl rfl rfl rfl rfl
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
  | close _ _ ih =>
    obtain ⟨hc, lab, hr, R⟩ := ih
    obtain ⟨hr', R'⟩ := close_heap R hr
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
    let s := { s with reads := put s.reads c (s.reads c ++ [k]) }
    let s := edit s c fun r => { r with seen := r.seen ++ [(k, x)] }
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
    have h1 : ∀ w, came s1 w c = fr w c := same s1 (by rw [← hs1]; rfl) (by rw [← hs1]; rfl)
    cases hw : s1.writers k with
    | none => exact exec_execf cs c fr _ (hp' _) s1 h1
    | some w =>
      dsimp only
      split
      · exact exec_execf cs c fr _ (hp' _) s1 h1
      · generalize hs2 : edit s1 c (fun r => { r with values := ins w r.values }) = s2
        have h2 : ∀ w, came s2 w c = fr w c :=
          same s2 (by rw [← hs2, ← hs1]; rfl) (by rw [← hs2, ← hs1]; rfl)
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
