-- LLM generated working output
-- rank.ts as Order.lean's rk, and Order.reach (start, gone) for it.
--
-- proved:
--   height_unique: two heights of the same edges agree. a height: ranked (Basic.lean), and each
--     rank 0 or one more than the rank of a node it reaches: the longest path in the condensation
--   rank_height: rank.ts's ranks (Rank.rank, getD 0) are a height of its edges. ranked is
--     Rank.lean's rank_ranked; the rest is tight, carried through visit as Rank.lean's wf is
--   rank_same: so rank.ts's ranks depend on the edges alone: not on all's order, its duplicates,
--     or the order of edges(p)
--   rk_reach: Order.reach (rk univ), for any univ
--   rk_tall: Order.tall (rk univ) on alive ones univ holds: with no link between equal ranks each
--     rank is one past the most of what it is after (mend's k); ranks that are so are rk's
--   Check: order.ts's ranks made whole, mended as they fall and rise, given up on a cycle
--
-- model, and where it departs from order.ts:
--   - rk univ A L p: Rank.rank with all = univ.filter A, edges p = univ.filter (L p), getD 0 for
--     the code's `?? 0`. order.ts gives [...all()].filter(alive), and edges p as p.values then
--     p.after, each kept by edge: the same members in another order, maybe with duplicates.
--     rank_same makes the difference nothing
--   - Rank.lean's close (edges stay in all) comes from reach's own hypothesis: links go only to
--     the alive
import Scheduler.Rank
import Scheduler.Order

set_option linter.unusedSectionVars false

namespace RankOrder

open Rank

variable {α : Type} [DecidableEq α]

/-! ## heights -/

-- a height of e: ranked (Basic.lean), and each rank 0 or one more than one it reaches
def height (e : α → α → Prop) (r : α → Nat) : Prop :=
  ranked e r ∧ ∀ x, r x = 0 ∨ ∃ y, Relation.TransGen e x y ∧ r x = r y + 1

-- along a path the rank never rises
theorem path_le {e : α → α → Prop} {r : α → Nat} (d : ranked e r) {a b : α}
    (h : Relation.TransGen e a b) : r b ≤ r a := by
  induction h with
  | single h => exact (d _ _ h).1
  | tail _ h ih => exact Nat.le_trans (d _ _ h).1 ih

-- along a path that does not come back the rank falls
theorem fall {e : α → α → Prop} {r : α → Nat} (d : ranked e r) {a b : α}
    (h : Relation.TransGen e a b) (n : ¬ Relation.TransGen e b a) : r b < r a := by
  induction h with
  | single h => exact (d _ _ h).2 n
  | @tail b c hab hbc ih =>
    by_cases cb : Relation.TransGen e c b
    · have : ¬ Relation.TransGen e b a := fun ba => n (cb.trans ba)
      exact Nat.lt_of_le_of_lt (d _ _ hbc).1 (ih this)
    · exact Nat.lt_of_lt_of_le ((d _ _ hbc).2 cb) (path_le d hab)

-- a height is below every ranked function
theorem height_le {e : α → α → Prop} {r1 r2 : α → Nat} (h1 : height e r1) (d2 : ranked e r2)
    (x : α) : r1 x ≤ r2 x := by
  rcases h1.2 x with h | ⟨y, hxy, h⟩
  · omega
  · have ih := height_le h1 d2 y
    have n : ¬ Relation.TransGen e y x := fun yx => by have := path_le h1.1 yx; omega
    have := fall d2 hxy n
    omega
termination_by r1 x
decreasing_by omega

-- the edges fix the height
theorem height_unique {e : α → α → Prop} {r1 r2 : α → Nat} (h1 : height e r1)
    (h2 : height e r2) : r1 = r2 :=
  funext fun x => Nat.le_antisymm (height_le h1 h2.1 x) (height_le h2 h1.1 x)

/-! ## rank.ts's ranks are a height -/

-- score's inner loop: r stays or is one more than a rank it reads
theorem inner_max (out : α → Option Nat) (members : List α) : ∀ (qs : List α) (r0 r : Nat),
    qs.foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) (some r0) = some r →
    r = r0 ∨ ∃ q ∈ qs, q ∉ members ∧ ∃ o, out q = some o ∧ r = o + 1
  | [], r0, r, h => by simp at h; exact Or.inl h.symm
  | q :: qs, r0, r, h => by
    simp only [List.foldl_cons] at h
    by_cases hq : q ∈ members
    · simp only [hq, ↓reduceIte] at h
      rcases inner_max out members qs r0 r h with e | ⟨q', m, h1, h2⟩
      · exact Or.inl e
      · exact Or.inr ⟨q', List.mem_cons_of_mem _ m, h1, h2⟩
    · cases ho : out q with
      | none =>
        simp only [hq, ho, ↓reduceIte, Option.bind_some, Option.map_none] at h
        rw [inner_none] at h; cases h
      | some o =>
        simp only [hq, ho, ↓reduceIte, Option.bind_some, Option.map_some] at h
        rcases inner_max out members qs _ r h with e | ⟨q', m, h1, h2⟩
        · by_cases le : o + 1 ≤ r0
          · exact Or.inl (by omega)
          · exact Or.inr ⟨q, List.mem_cons_self, hq, o, ho, by omega⟩
        · exact Or.inr ⟨q', List.mem_cons_of_mem _ m, h1, h2⟩

theorem outer_max (edges : α → List α) (out : α → Option Nat) (members : List α) :
    ∀ (xs : List α) (r0 r : Nat),
    xs.foldl (fun r x => (edges x).foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) r) (some r0) = some r →
    r = r0 ∨ ∃ x ∈ xs, ∃ q ∈ edges x, q ∉ members ∧ ∃ o, out q = some o ∧ r = o + 1
  | [], r0, r, h => by simp at h; exact Or.inl h.symm
  | x :: xs, r0, r, h => by
    simp only [List.foldl_cons] at h
    cases h1 : (edges x).foldl (fun r q => if q ∈ members then r else
        r.bind fun r => (out q).map fun o => max r (o + 1)) (some r0) with
    | none => rw [h1, outer_none] at h; cases h
    | some r1 =>
      rw [h1] at h
      rcases outer_max edges out members xs r1 r h with e | ⟨x', m, q, hq, h2⟩
      · rcases inner_max out members (edges x) r0 r1 h1 with e' | ⟨q, hq, h3⟩
        · exact Or.inl (by omega)
        · exact Or.inr ⟨x, List.mem_cons_self, q, hq, by rw [e]; exact h3⟩
      · exact Or.inr ⟨x', List.mem_cons_of_mem _ m, q, hq, h2⟩

-- r is 0, or one more than the rank an edge leaving the members goes to (Math.max)
theorem score_max (edges : α → List α) (out : α → Option Nat) (members : List α) {r : Nat}
    (h : score edges out members = some r) :
    r = 0 ∨ ∃ x ∈ members, ∃ q ∈ edges x, q ∉ members ∧ ∃ o, out q = some o ∧ r = o + 1 :=
  outer_max edges out members members 0 r h

variable {all : List α} {edges : α → List α}

-- each rank set is 0, or one more than the rank of a node it reaches
def tight (all : List α) (edges : α → List α) (s : state α) : Prop :=
  ∀ x r, s.out x = some r → r = 0 ∨
    ∃ y o, Relation.TransGen (edge all edges) x y ∧ s.out y = some o ∧ r = o + 1

-- popping keeps it: Rank.lean's pop_post, again, for the score
theorem pop_tight {f : Nat} {s0 t : state α} {p : α} {G : List α} (w0 : wf all edges s0 G)
    (hp0 : s0.index p = none) (I : inv all edges f s0 p G (edges p) t)
    (h : t.index p = some (t.low p)) (T : tight all edges t) :
    tight all edges (finish edges p t) := by
  have w := I.good
  obtain ⟨M, hM, hM0⟩ := I.stack
  have nd := w.nodup
  rw [hM, List.nodup_append] at nd
  have pM : p ∉ M := fun m => nd.2.2 p m p List.mem_cons_self rfl
  obtain ⟨C, hC⟩ : ∃ C, C = M ++ [p] := ⟨_, rfl⟩
  have hpop : pop p t.stack = (C, s0.stack) := by rw [hM, hC]; exact pop_eq p s0.stack M pM
  have memC : ∀ x, x ∈ C ↔ x ∈ M ∨ x = p := by intro x; simp [hC]
  have hC0 : ∀ x ∈ C, s0.index x = none := by
    intro x hx; rcases (memC x).1 hx with hx | rfl
    · exact hM0 x hx
    · exact hp0
  have hstk : ∀ x, x ∈ t.stack ↔ x ∈ C ∨ x ∈ s0.stack := by
    intro x; rw [hM, memC]; simp [or_assoc]
  have hCon : ∀ x ∈ C, t.on x = true := fun x hx => (w.onstack x).2 ((hstk x).2 (Or.inl hx))
  have s0i : ∀ y ∈ s0.stack, ∃ j, s0.index y = some j :=
    fun y hy => Option.ne_none_iff_exists'.1 (w0.onseen y ((w0.onstack y).2 hy))
  have hdis : ∀ x ∈ C, x ∉ s0.stack := by
    intro x hx hs; obtain ⟨j, hj⟩ := s0i x hs; rw [hC0 x hx] at hj; cases hj
  have notG : ∀ x ∈ C, x ∉ G := by
    intro x hx hg; exact hdis x hx ((w0.onstack x).1 (w0.gray x hg))
  have hlow : t.low p = s0.next := by rw [I.seen] at h; exact (Option.some.inj h).symm
  have K0 : ∀ x ∈ C, ∀ y ∈ edges x, y ∉ s0.stack := by
    intro x hx y hy hys
    obtain ⟨j, hj⟩ := s0i y hys
    have jlt := w0.below y j hj
    have tj := I.index y j hj
    have : t.low p ≤ j := by
      by_cases xp : x = p
      · subst xp; exact I.xdone y j hy hys tj
      · exact I.xedge x y j (hCon x hx) (hC0 x hx) xp hy hys tj
    omega
  have K1 : ∀ x ∈ C, ∀ y ∈ edges x, y ∉ C → t.out y ≠ none := by
    intro x hx y hy hyC
    have yi : t.index y ≠ none := by
      by_cases xp : x = p
      · subst xp; exact I.done y hy
      · exact w.black x (w.onseen x (hCon x hx)) (by simp [xp, notG x hx]) y hy
    rcases w.cover y yi with hy' | hy'
    · rcases (hstk y).1 ((w.onstack y).1 hy') with h' | h'
      · exact absurd h' hyC
      · exact absurd h' (K0 x hx y hy)
    · exact hy'
  have K2 : ∀ y ∈ C, reach all edges y p := by
    intro y hy
    obtain ⟨g, hg, r⟩ := w.back y (hCon y hy)
    rcases List.mem_cons.1 hg with rfl | hg
    · exact r
    · exfalso
      have gs : g ∈ s0.stack := (w0.onstack g).1 (w0.gray g hg)
      have gout : t.out g = none := w.onout g ((w.onstack g).2 ((hstk g).2 (Or.inr gs)))
      rcases r with rfl | r
      · exact hdis y hy gs
      · obtain ⟨a, b, ha, hb, eab, rb⟩ := exit (P := fun x => x ∈ C) r hy
          (fun hgC => hdis g hgC gs)
        exact closed w (K1 a ha b eab.2 hb) rb gout
  have K3 : ∀ x ∈ C, reach all edges p x :=
    fun x hx => I.reached x (hC0 x hx) (w.onseen x (hCon x hx))
  obtain ⟨r, hr, -⟩ := score_some t.out C K1
  have hfin : finish edges p t =
      { t with
        stack := s0.stack
        on := fun x => if x ∈ C then false else t.on x
        out := fun x => if x ∈ C then some r else t.out x } := by
    simp [finish, h, hpop, hr]
  rw [hfin]
  have outC : ∀ x, t.out x ≠ none → x ∉ C := by
    intro x ho hx; exact ho (w.onout x (hCon x hx))
  intro x r' hx
  dsimp only at hx ⊢
  by_cases hxC : x ∈ C
  · simp only [hxC, ↓reduceIte, Option.some.injEq] at hx
    subst hx
    rcases score_max edges t.out C hr with e | ⟨m, hm, y, hy, hyC, o, ho, e⟩
    · exact Or.inl e
    · refine Or.inr ⟨y, o, ?_, by simp [hyC, ho], e⟩
      have ma : m ∈ all := w.inall m (w.onseen m (hCon m hm))
      rcases reach_trans (K2 x hxC) (K3 m hm) with rfl | r
      · exact .single ⟨ma, hy⟩
      · exact .tail r ⟨ma, hy⟩
  · simp only [hxC, ↓reduceIte] at hx
    rcases T x r' hx with e | ⟨y, o, hxy, ho, e⟩
    · exact Or.inl e
    · have hyC := outC y (by simp [ho])
      exact Or.inr ⟨y, o, hxy, by simp [hyC, ho], e⟩

-- p's loop keeps it
theorem loop_tight {f : Nat} {s0 : state α} {p : α} {G : List α}
    (IH : ∀ q s G, wf all edges s G → s.index q = none → q ∈ all → count s.index all < f →
      tight all edges s → tight all edges (visit edges f q s))
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) (pa : p ∈ all) (hp0 : s0.index p = none) :
    ∀ (rest done : List α) (s : state α), (∀ q ∈ rest, q ∈ edges p) →
      inv all edges f s0 p G done s → tight all edges s →
      tight all edges (loop (visit edges f) p rest s)
  | [], _, s, _, _, T => by simpa [loop] using T
  | q :: qs, done, s, hr, I, T => by
    have hqe := hr q List.mem_cons_self
    have hr' : ∀ q ∈ qs, q ∈ edges p := fun q' m => hr q' (List.mem_cons_of_mem _ m)
    cases hq : s.index q with
    | none =>
      simp only [loop, hq]
      have P := visit_spec close f q s (p :: G) I.good hq (close p pa q hqe) I.fuel
      have T' := IH q s (p :: G) I.good hq (close p pa q hqe) I.fuel T
      exact loop_tight IH close pa hp0 qs _ _ hr' (child_inv I P hq hqe pa hp0) T'
    | some i =>
      cases hon : s.on q with
      | true =>
        simp only [loop, hq, hon, ↓reduceIte]
        exact loop_tight IH close pa hp0 qs _ _ hr' (onq_inv I hq hon hqe pa hp0) T
      | false =>
        simp only [loop, hq, hon]
        exact loop_tight IH close pa hp0 qs _ _ hr' (offq_inv I hq hon) T

-- visit keeps it
theorem visit_tight (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    ∀ (f : Nat) (q : α) (s : state α) (G : List α), wf all edges s G → s.index q = none →
      q ∈ all → count s.index all < f → tight all edges s → tight all edges (visit edges f q s)
  | 0, _, _, _, _, _, _, hf, _ => absurd hf (Nat.not_lt_zero _)
  | f + 1, p, s, G, w, hp, pa, hf, T => by
    have I := loop_inv (visit_spec close f) close pa hp (edges p) [] (push p s) (fun _ h => h)
      (push_inv w hp pa hf)
    simp only [List.nil_append] at I
    have T1 : tight all edges (push p s) := T
    have T2 := loop_tight (visit_tight close f) close pa hp (edges p) [] (push p s)
      (fun _ h => h) (push_inv w hp pa hf) T1
    simp only [visit]
    generalize loop (visit edges f) p (edges p) (push p s) = t at I T2 ⊢
    by_cases h : t.index p = some (t.low p)
    · exact pop_tight w hp I h T2
    · have e : finish edges p t = t := by simp [finish, h]
      rw [e]; exact T2

-- rank's for keeps it
theorem run_tight (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    ∀ (xs : List α) (s : state α), (∀ x ∈ xs, x ∈ all) → wf all edges s [] →
      tight all edges s →
      tight all edges (xs.foldl (fun s p => if s.index p = none then
        visit edges (all.length + 1) p s else s) s)
  | [], _, _, _, T => T
  | x :: xs, s, hxs, w, T => by
    simp only [List.foldl_cons]
    have hxs' : ∀ y ∈ xs, y ∈ all := fun y m => hxs y (List.mem_cons_of_mem _ m)
    by_cases hx : s.index x = none
    · simp only [hx, ↓reduceIte]
      have := count_length s.index all
      have xa := hxs x List.mem_cons_self
      have P := visit_spec close (all.length + 1) x s [] w hx xa (by omega)
      exact run_tight close xs _ hxs' P.good
        (visit_tight close (all.length + 1) x s [] w hx xa (by omega) T)
    · simp only [hx, ↓reduceIte]; exact run_tight close xs s hxs' w T

-- rank.ts's ranks are a height of its edges
theorem rank_height
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    height (fun p q => p ∈ all ∧ q ∈ edges p) (fun x => (rank all edges x).getD 0) := by
  refine ⟨rank_ranked close, ?_⟩
  have T : tight all edges (run all edges) :=
    run_tight close all init (fun _ h => h) init_wf (by intro x r h; simp [init] at h)
  intro x
  simp only [rank]
  cases hx : (run all edges).out x with
  | none => exact Or.inl rfl
  | some r =>
    rcases T x r hx with e | ⟨y, o, hxy, ho, e⟩
    · exact Or.inl (by simp [e])
    · exact Or.inr ⟨y, hxy, by simp [ho, e]⟩

-- so rank.ts's ranks depend on the edges alone: not on all's order, its duplicates, or the
-- order of edges(p) (order.ts: [...all()] and p.values)
theorem rank_same {all1 all2 : List α} {edges1 edges2 : α → List α}
    (close1 : ∀ p ∈ all1, ∀ q ∈ edges1 p, q ∈ all1) (close2 : ∀ p ∈ all2, ∀ q ∈ edges2 p, q ∈ all2)
    (he : ∀ p q, (p ∈ all1 ∧ q ∈ edges1 p) ↔ (p ∈ all2 ∧ q ∈ edges2 p)) (x : α) :
    (rank all1 edges1 x).getD 0 = (rank all2 edges2 x).getD 0 := by
  have e : (fun p q => p ∈ all1 ∧ q ∈ edges1 p) = (fun p q => p ∈ all2 ∧ q ∈ edges2 p) :=
    funext fun p => funext fun q => propext (he p q)
  have h1 := rank_height close1
  rw [e] at h1
  exact congrFun (height_unique h1 (rank_height close2)) x

/-! ## Order.lean's rk -/

-- order.ts's ranks: rank.ts over the alive, edges by link; univ lists the computations
def rk (univ : List α) (A : α → Bool) (L : α → α → Bool) (p : α) : Nat :=
  (rank (univ.filter A) (fun p => univ.filter (L p)) p).getD 0

theorem rk_close {univ : List α} {A : α → Bool} {L : α → α → Bool}
    (hc : ∀ x y, L x y = true → A y = true) :
    ∀ p ∈ univ.filter A, ∀ q ∈ univ.filter (L p), q ∈ univ.filter A := by
  intro p _ q hq
  simp only [List.mem_filter] at hq ⊢
  exact ⟨hq.1, hc p q hq.2⟩

theorem rk_height {univ : List α} {A : α → Bool} {L : α → α → Bool}
    (hc : ∀ x y, L x y = true → A y = true) :
    height (fun p q => p ∈ univ.filter A ∧ q ∈ univ.filter (L p)) (rk univ A L) :=
  rank_height (rk_close hc)

theorem first {e : α → α → Prop} {a b : α} (h : Relation.TransGen e a b) : ∃ c, e a c := by
  induction h with
  | single h => exact ⟨_, h⟩
  | tail _ _ ih => exact ih

theorem last {e : α → α → Prop} {a b : α} (h : Relation.TransGen e a b) : ∃ c, e c b := by
  cases h with
  | single h => exact ⟨_, h⟩
  | tail _ h => exact ⟨_, h⟩

-- a node with no edge out has height 0
theorem height_zero {e : α → α → Prop} {r : α → Nat} (h : height e r) {p : α}
    (hp : ∀ y, ¬ e p y) : r p = 0 := by
  rcases h.2 p with h | ⟨y, hy, _⟩
  · exact h
  · obtain ⟨c, hc⟩ := first hy; exact absurd hc (hp c)

-- what Order.lean assumes of rk
theorem rk_reach (univ : List α) : Order.reach (rk univ) where
  start := by
    intro A L p hA hin hout hc
    have hc' : ∀ x y, L x y = true → Order.update A p true y = true := by
      intro x y h; simp only [Order.update]; split
      · rfl
      · exact hc x y h
    -- p has no edges, so making it alive changes no edge
    have he : (fun x y => x ∈ univ.filter (Order.update A p true) ∧ y ∈ univ.filter (L x)) =
        (fun x y => x ∈ univ.filter A ∧ y ∈ univ.filter (L x)) := by
      funext x y
      apply propext
      simp only [List.mem_filter, Order.update]
      by_cases hx : x = p
      · subst hx; simp [hout]
      · simp [hx]
    have h1 := rk_height (univ := univ) hc'
    rw [he] at h1
    have eq := height_unique h1 (rk_height (univ := univ) hc)
    refine ⟨?_, fun q _ => congrFun eq q⟩
    rw [congrFun eq p]
    apply height_zero (rk_height (univ := univ) hc)
    intro y ⟨hp, _⟩
    simp [List.mem_filter, hA] at hp
  gone := by
    intro A L L' p hin hL' hL'p hc q hqp _
    have hc' : ∀ x y, L' x y = true → Order.update A p false y = true := by
      intro x y h
      by_cases hx : x = p
      · subst hx; rw [hL'p] at h; cases h
      · rw [hL' x y hx] at h
        have yp : y ≠ p := by rintro rfl; rw [hin] at h; cases h
        simp only [Order.update, yp, ↓reduceIte]; exact hc x y h
    let e := fun x y => x ∈ univ.filter A ∧ y ∈ univ.filter (L x)
    let e' := fun x y => x ∈ univ.filter (Order.update A p false) ∧ y ∈ univ.filter (L' x)
    have ee : ∀ x y, e' x y ↔ x ≠ p ∧ e x y := by
      intro x y
      simp only [e, e', List.mem_filter, Order.update]
      by_cases hx : x = p
      · subst hx; simp [hL'p]
      · simp [hx, hL' x y hx]
    have nop : ∀ x, ¬ e x p := by
      intro x ⟨_, h⟩; simp [List.mem_filter, hin] at h
    have endp : ∀ {a b}, Relation.TransGen e a b → b ≠ p := by
      intro a b h hb; subst hb; obtain ⟨c, hc⟩ := last h; exact nop c hc
    -- a path of e from a node other than p is one of e'
    have lift : ∀ {a b}, Relation.TransGen e a b → a ≠ p → Relation.TransGen e' a b := by
      intro a b h ha
      induction h with
      | single h => exact .single ((ee _ _).2 ⟨ha, h⟩)
      | tail h1 h2 ih => exact .tail ih ((ee _ _).2 ⟨endp h1, h2⟩)
    have H := rk_height (univ := univ) hc
    let r := fun x => if x = p then 0 else rk univ A L x
    have hr : height e' r := by
      refine ⟨?_, ?_⟩
      · intro x y exy
        obtain ⟨xp, exy⟩ := (ee x y).1 exy
        have yp : y ≠ p := fun yp => nop x (yp ▸ exy)
        simp only [r, xp, yp, ↓reduceIte]
        exact ⟨(H.1 x y exy).1, fun n => (H.1 x y exy).2 (fun t => n (lift t yp))⟩
      · intro x
        by_cases xp : x = p
        · exact Or.inl (by simp [r, xp])
        · rcases H.2 x with h | ⟨y, hxy, h⟩
          · exact Or.inl (by simp [r, xp, h])
          · exact Or.inr ⟨y, lift hxy xp, by simp [r, xp, endp hxy, h]⟩
    have eq := height_unique (rk_height (univ := univ) hc') hr
    rw [congrFun eq q]
    simp [r, hqp]

-- a path's first step, and the rest
theorem head {e : α → α → Prop} {a b : α} (h : Relation.TransGen e a b) :
    ∃ c, e a c ∧ (c = b ∨ Relation.TransGen e c b) := by
  induction h with
  | single h => exact ⟨_, h, .inl rfl⟩
  | tail _ h2 ih =>
    obtain ⟨c, h1, h3⟩ := ih
    refine ⟨c, h1, .inr ?_⟩
    rcases h3 with rfl | h3
    · exact .single h2
    · exact .tail h3 h2

-- what Order.lean's mend needs of rk, on alive ones univ holds: with no link between equal ranks,
-- each is one past the most of what it is after; and ranks that are so are rk's (height_unique)
theorem rk_tall (univ : List α) {A : α → Bool} (hu : ∀ x, A x = true → x ∈ univ) :
    Order.tall (rk univ) A where
  fix := by
    intro L hc hne x hx
    have H := rk_height (univ := univ) hc
    have e_of : ∀ y z, A y = true → L y z = true →
        y ∈ univ.filter A ∧ z ∈ univ.filter (L y) := by
      intro y z hy hz
      exact ⟨List.mem_filter.2 ⟨hu y hy, hy⟩, List.mem_filter.2 ⟨hu z (hc y z hz), hz⟩⟩
    have lt : ∀ y, L x y = true → rk univ A L y < rk univ A L x := by
      intro y hy
      have := (H.1 x y (e_of x y hx hy)).1
      have := hne x y hx hy
      omega
    refine ⟨lt, ?_⟩
    rcases H.2 x with h0 | ⟨y, hxy, e⟩
    · exact .inl h0
    · obtain ⟨c, hc1, hc2⟩ := head hxy
      have hLc : L x c = true := (List.mem_filter.1 hc1.2).2
      have h1 := lt c hLc
      have h2 : rk univ A L y ≤ rk univ A L c := by
        rcases hc2 with rfl | hc2
        · exact Nat.le_refl _
        · exact path_le H.1 hc2
      exact .inr ⟨c, hLc, by omega⟩
  unique := by
    intro L r hc ht x hx
    let r' := fun y => if A y = true then r y else 0
    have hr : height (fun p q => p ∈ univ.filter A ∧ q ∈ univ.filter (L p)) r' := by
      refine ⟨?_, ?_⟩
      · intro p q ⟨hp, hq⟩
        have hpa : A p = true := (List.mem_filter.1 hp).2
        have hLq : L p q = true := (List.mem_filter.1 hq).2
        have hqa : A q = true := hc p q hLq
        have := (ht p hpa).1 q hLq
        simp only [r', hpa, hqa, ↓reduceIte]
        exact ⟨Nat.le_of_lt this, fun _ => this⟩
      · intro y
        by_cases hy : A y = true
        · rcases (ht y hy).2 with h0 | ⟨z, hz, e⟩
          · exact .inl (by simp [r', hy, h0])
          · have hza : A z = true := hc y z hz
            refine .inr ⟨z, .single ⟨List.mem_filter.2 ⟨hu y hy, hy⟩,
              List.mem_filter.2 ⟨hu z hza, hz⟩⟩, ?_⟩
            simp [r', hy, hza, e]
        · exact .inl (by simp [r', hy])
    have eq := height_unique (rk_height (univ := univ) hc) hr
    rw [congrFun eq x]
    simp [r', hx]

/-! ## Check: order.ts's ranks mended, run on three computations -/

namespace Check

open Order

-- 2 after 1 after 0
def rk3 := rk (List.range 3)
def s0 : State Nat := started (started (started init 0) 1) 2
def s1 := sees id (sees id s0 1 [0]) 2 [1]
-- made whole at the first next
def s2 := (next id rk3 (List.range 3) (set id s1 0 1)).2
#guard (s2.making, rankOf s2 0, rankOf s2 1, rankOf s2 2) == (1, 0, 1, 2)
-- 1 after nothing: 1 and 2 fall, mended to rank.ts's (54-rank-falls's shape)
def s3 := sees id s2 1 []
#guard (s3.making, rankOf s3 1, rankOf s3 2) == (1, 0, 1)
#guard (List.range 3).all fun p => rankOf s3 p == rk3 s3.alive (link s3) p
-- 0 after 2: 0 rises
def s4 := sees id s3 0 [2]
#guard (s4.making, rankOf s4 0) == (1, 2)
#guard (List.range 3).all fun p => rankOf s4 p == rk3 s4.alive (link s4) p
-- 1 after 0: a cycle; mending gives up, the next makes the ranks whole and sees the cycle
def s5 := sees id s4 1 [0]
#guard s5.making == 0
def s6 := (next id rk3 (List.range 3) (set id s5 1 2)).2
#guard s6.cyclic && (List.range 3).all fun p => rankOf s6 p == rk3 s6.alive (link s6) p

end Check

end RankOrder
