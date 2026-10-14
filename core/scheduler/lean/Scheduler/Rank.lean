-- LLM generated working output
-- rank.ts in lean: tarjan's components, each ranked as it is popped. for edges that stay in all:
-- ranks_all: every node of all gets a rank, no `out.get(q)!` misses, and the fuel is enough;
-- rank_ranked: Basic.lean's ranked (lemma R); rank_cycle: mutually reachable nodes share a rank.
--
-- model, and where it departs from rank.ts:
-- - all is a list (the code: any iterable; order.ts gives an array). duplicates are fine
-- - edges is a function α → List α giving the same list each call (the code calls edges(x) twice,
--   in visit and in the ranking loop; order.ts's edges reads nothing rank changes)
-- - nodes compare by DecidableEq (the code: ===, and Map and Set keys)
-- - maps and sets are functions: index, out : α → Option Nat (has is ≠ none), on : α → Bool;
--   low : α → Nat, read only where set (the code's low.get(_)!)
-- - numbers are Nat (the code: floats; here all small integers)
-- - visit has fuel; at 0 it sets cut and stops. run gives all.length + 1: ranks_all shows cut
--   stays false, so no visit is cut short
-- - `out.get(q)! + 1` on a missing rank is NaN in the code, kept through Math.max; here score is
--   none and finish sets nan (score_none and score_some: exactly then). ranks_all: nan stays false
-- - the do-while's pops, on.delete and out.set are each done at once: pop, then on and out over
--   the members
-- - pop on a stack without p (the code: stack.pop()! is undefined and the do-while never ends)
--   returns what it popped; never reached (pop_eq)
-- - order.ts reads the ranks with `?? 0`; the theorems with getD 0
--
-- the proof never shows the groups popped are the components: wf (between steps), post (what
-- visit q leaves) and inv (visit p's loop) carry just enough for 1-3. close, the one hypothesis:
-- an edge of a node of all goes into all (order.ts: all and every edge target are the alive).
import Scheduler.Basic

set_option linter.unusedSectionVars false

namespace Rank

variable {α : Type} [DecidableEq α]

-- a map with one key set (Map.set, Set.add)
def put {β : Type} (f : α → β) (a : α) (b : β) : α → β := fun x => if x = a then b else f x

@[simp] theorem put_same {β : Type} (f : α → β) (a : α) (b : β) : put f a b a = b := by simp [put]

theorem put_ne {β : Type} (f : α → β) {a x : α} (b : β) (h : x ≠ a) : put f a b x = f x := by
  simp [put, h]

-- rank.ts's locals: index, low, on, stack, next, out
structure state (α : Type) where
  index : α → Option Nat
  low : α → Nat
  on : α → Bool
  stack : List α
  next : Nat
  out : α → Option Nat
  nan : Bool -- an `out.get(q)! + 1` found no rank: NaN in the code
  cut : Bool -- a visit ran out of fuel

-- all empty (rank.ts, rank's first lines)
def init : state α := ⟨fun _ => none, fun _ => 0, fun _ => false, [], 0, fun _ => none, false, false⟩

-- index p, low p, push p, on p (rank.ts, visit's first lines)
def push (p : α) (s : state α) : state α :=
  { s with index := put s.index p (some s.next), low := put s.low p s.next, next := s.next + 1,
           stack := p :: s.stack, on := put s.on p true }

-- p's edges, go being visit (rank.ts, visit's for over edges(p))
def loop (go : α → state α → state α) (p : α) : List α → state α → state α
  | [], s => s
  | q :: qs, s =>
    match s.index q with
    | none =>
      let t := go q s
      loop go p qs { t with low := put t.low p (min (t.low p) (t.low q)) }
    | some i =>
      if s.on q then loop go p qs { s with low := put s.low p (min (s.low p) i) }
      else loop go p qs s

-- pop until p: the members, top first, and the rest (rank.ts, visit's do-while)
def pop (p : α) : List α → List α × List α
  | [] => ([], [])
  | m :: rest => if m = p then ([m], rest) else (m :: (pop p rest).1, (pop p rest).2)

-- r: 1 + the most rank an edge leaving the members goes to, else 0; none where a rank is missing
-- (rank.ts, the loop over members)
def score (edges : α → List α) (out : α → Option Nat) (members : List α) : Option Nat :=
  members.foldl (fun r x => (edges x).foldl (fun r q => if q ∈ members then r else
    r.bind fun r => (out q).map fun o => max r (o + 1)) r) (some 0)

-- if p is its component's root, pop the component and rank it (rank.ts, visit's last lines)
def finish (edges : α → List α) (p : α) (t : state α) : state α :=
  if t.index p ≠ some (t.low p) then t else
    match score edges t.out (pop p t.stack).1 with
    | none =>
      { t with
        stack := (pop p t.stack).2
        on := fun x => if x ∈ (pop p t.stack).1 then false else t.on x
        nan := true }
    | some r =>
      { t with
        stack := (pop p t.stack).2
        on := fun x => if x ∈ (pop p t.stack).1 then false else t.on x
        out := fun x => if x ∈ (pop p t.stack).1 then some r else t.out x }

-- rank.ts, visit, with fuel
def visit (edges : α → List α) : Nat → α → state α → state α
  | 0, _, s => { s with cut := true }
  | f + 1, p, s => finish edges p (loop (visit edges f) p (edges p) (push p s))

-- visit each node of all not yet indexed (rank.ts, rank's for)
def run (all : List α) (edges : α → List α) : state α :=
  all.foldl (fun s p => if s.index p = none then visit edges (all.length + 1) p s else s) init

-- rank.ts, rank: the ranks
def rank (all : List α) (edges : α → List α) : α → Option Nat := (run all edges).out

/-! ## proofs -/

section proofs

variable (all : List α) (edges : α → List α)

-- an edge of the graph rank is given: Basic.lean's ranked is over it
def edge (p q : α) : Prop := p ∈ all ∧ q ∈ edges p

-- a path of edges, maybe empty
def reach (a b : α) : Prop := a = b ∨ Relation.TransGen (edge all edges) a b

variable {all edges}

theorem reach_refl (a : α) : reach all edges a a := Or.inl rfl

theorem reach_trans {a b c : α} (h1 : reach all edges a b) (h2 : reach all edges b c) :
    reach all edges a c := by
  rcases h1 with rfl | h1
  · exact h2
  · rcases h2 with rfl | h2
    · exact Or.inr h1
    · exact Or.inr (h1.trans h2)

theorem reach_edge {a b : α} (h : edge all edges a b) : reach all edges a b :=
  Or.inr (.single h)

-- an edge and a path back make a cycle
theorem cycle {x y : α} (h : edge all edges x y) (r : reach all edges y x) :
    Relation.TransGen (edge all edges) y x := by
  rcases r with rfl | r
  · exact .single h
  · exact r

-- a path from inside a set to outside it leaves it by some edge
theorem exit {P : α → Prop} {a b : α} (h : Relation.TransGen (edge all edges) a b) (ha : P a)
    (hb : ¬ P b) : ∃ x y, P x ∧ ¬ P y ∧ edge all edges x y ∧ reach all edges y b := by
  induction h with
  | single e => exact ⟨_, _, ha, hb, e, reach_refl _⟩
  | @tail c d _ e ih =>
    by_cases hc : P c
    · exact ⟨c, d, hc, hb, e, reach_refl _⟩
    · obtain ⟨x, y, hx, hy, exy, r⟩ := ih hc
      exact ⟨x, y, hx, hy, exy, reach_trans r (reach_edge e)⟩

-- nodes of all not yet indexed: the fuel a visit needs
def count (index : α → Option Nat) : List α → Nat
  | [] => 0
  | x :: xs => (if index x = none then 1 else 0) + count index xs

-- fewer not indexed as more are
theorem count_le {s t : α → Option Nat} (h : ∀ x, t x = none → s x = none) :
    ∀ l : List α, count t l ≤ count s l
  | [] => by simp [count]
  | x :: xs => by
    have := count_le h xs
    simp only [count]
    by_cases ht : t x = none
    · simp [ht, h x ht]; omega
    · simp only [ht, ↓reduceIte]; split <;> omega

-- one fewer once p of all is indexed
theorem count_lt {s t : α → Option Nat} (h : ∀ x, t x = none → s x = none) {p : α}
    (hs : s p = none) (ht : t p ≠ none) : ∀ {l : List α}, p ∈ l → count t l < count s l
  | x :: xs, hm => by
    simp only [count]
    rcases List.mem_cons.1 hm with rfl | hm
    · have := count_le h xs; simp [hs, ht]; omega
    · have := count_lt h hs ht hm
      by_cases ht' : t x = none
      · simp [ht', h x ht']; omega
      · simp only [ht', ↓reduceIte]; split <;> omega

-- so all.length + 1 is enough fuel
theorem count_length (s : α → Option Nat) : ∀ l : List α, count s l ≤ l.length
  | [] => by simp [count]
  | x :: xs => by have := count_length s xs; simp only [count, List.length_cons]; split <;> omega

-- with p once on the stack, pop takes down to p
theorem pop_eq (p : α) (rest : List α) :
    ∀ M : List α, p ∉ M → pop p (M ++ p :: rest) = (M ++ [p], rest)
  | [], _ => by simp [pop]
  | m :: M, h => by
    have hm : m ≠ p := fun e => h (e ▸ List.mem_cons_self)
    have := pop_eq p rest M (fun e => h (List.mem_cons_of_mem _ e))
    simp [pop, hm, this]


-- the ranking pass, given every edge leaving the members goes to a ranked node
-- score's inner loop, over one member's edges
theorem score_inner (out : α → Option Nat) (members : List α) :
    ∀ (qs : List α) (r0 : Nat), (∀ q ∈ qs, q ∉ members → out q ≠ none) →
    ∃ r, qs.foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) (some r0) = some r ∧ r0 ≤ r ∧
      ∀ q ∈ qs, q ∉ members → ∀ o, out q = some o → o + 1 ≤ r
  | [], r0, _ => ⟨r0, rfl, Nat.le_refl _, by simp⟩
  | q :: qs, r0, h => by
    simp only [List.foldl_cons]
    have h' := fun q' m => h q' (List.mem_cons_of_mem q m)
    by_cases hq : q ∈ members
    · simp only [hq, ↓reduceIte]
      obtain ⟨r, e, le, b⟩ := score_inner out members qs r0 h'
      refine ⟨r, e, le, ?_⟩
      intro q' m hq' o ho
      rcases List.mem_cons.1 m with rfl | m
      · exact absurd hq hq'
      · exact b q' m hq' o ho
    · obtain ⟨o, ho⟩ := Option.ne_none_iff_exists'.1 (h q List.mem_cons_self hq)
      simp only [hq, ↓reduceIte, ho, Option.bind_some, Option.map_some]
      obtain ⟨r, e, le, b⟩ := score_inner out members qs (max r0 (o + 1)) h'
      refine ⟨r, e, by omega, ?_⟩
      intro q' m hq' o' ho'
      rcases List.mem_cons.1 m with rfl | m
      · rw [ho] at ho'; cases ho'; omega
      · exact b q' m hq' o' ho'

-- score's outer loop, over the members
theorem score_outer (out : α → Option Nat) (members : List α) :
    ∀ (xs : List α) (r0 : Nat), (∀ x ∈ xs, ∀ q ∈ edges x, q ∉ members → out q ≠ none) →
    ∃ r, xs.foldl (fun r x => (edges x).foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) r) (some r0) = some r ∧ r0 ≤ r ∧
      ∀ x ∈ xs, ∀ q ∈ edges x, q ∉ members → ∀ o, out q = some o → o + 1 ≤ r
  | [], r0, _ => ⟨r0, rfl, Nat.le_refl _, by simp⟩
  | x :: xs, r0, h => by
    simp only [List.foldl_cons]
    obtain ⟨r1, e1, le1, b1⟩ := score_inner out members (edges x) r0 (h x List.mem_cons_self)
    rw [e1]
    obtain ⟨r, e, le, b⟩ := score_outer out members xs r1 (fun x' m => h x' (List.mem_cons_of_mem x m))
    refine ⟨r, e, by omega, ?_⟩
    intro x' m q hq hq' o ho
    rcases List.mem_cons.1 m with rfl | m
    · have := b1 q hq hq' o ho; omega
    · exact b x' m q hq hq' o ho

-- the `!` never fails when every edge leaving the members is ranked; then r is above each
theorem score_some (out : α → Option Nat) (members : List α)
    (h : ∀ x ∈ members, ∀ q ∈ edges x, q ∉ members → out q ≠ none) :
    ∃ r, score edges out members = some r ∧
      ∀ x ∈ members, ∀ q ∈ edges x, q ∉ members → ∀ o, out q = some o → o + 1 ≤ r := by
  obtain ⟨r, e, _, b⟩ := score_outer out members members 0 h
  exact ⟨r, e, b⟩

-- once NaN, always NaN
theorem inner_none (out : α → Option Nat) (members : List α) : ∀ qs : List α,
    qs.foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) none = none
  | [] => rfl
  | q :: qs => by
    simp only [List.foldl_cons, Option.bind_none, ite_self]; exact inner_none out members qs

-- a missing rank makes NaN
theorem inner_hit (out : α → Option Nat) (members : List α) {q : α} (hqm : q ∉ members)
    (ho : out q = none) : ∀ (qs : List α) (r : Option Nat), q ∈ qs →
    qs.foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) r = none
  | q' :: qs, r, m => by
    simp only [List.foldl_cons]
    rcases List.mem_cons.1 m with rfl | m
    · have : (if q ∈ members then r else r.bind fun r => (out q).map fun o => max r (o + 1)) = none := by
        cases r <;> simp [hqm, ho]
      rw [this]; exact inner_none out members qs
    · exact inner_hit out members hqm ho qs _ m

theorem outer_none (out : α → Option Nat) (members : List α) : ∀ xs : List α,
    xs.foldl (fun r x => (edges x).foldl (fun r q => if q ∈ members then r else
      r.bind fun r => (out q).map fun o => max r (o + 1)) r) none = none
  | [] => rfl
  | x :: xs => by
    simp only [List.foldl_cons]; rw [inner_none]; exact outer_none out members xs

-- a `!` on a missing rank makes score none: nan is set exactly when a `!` would fail
theorem score_none (out : α → Option Nat) (members : List α) {x q : α} (hx : x ∈ members)
    (hq : q ∈ edges x) (hqm : q ∉ members) (ho : out q = none) :
    score edges out members = none := by
  suffices ∀ (xs : List α) (r : Option Nat), x ∈ xs →
      xs.foldl (fun r x => (edges x).foldl (fun r q => if q ∈ members then r else
        r.bind fun r => (out q).map fun o => max r (o + 1)) r) r = none from this members _ hx
  intro xs
  induction xs with
  | nil => intro _ m; cases m
  | cons x' xs ih =>
    intro r m
    simp only [List.foldl_cons]
    rcases List.mem_cons.1 m with rfl | m
    · rw [inner_hit out members hqm ho _ _ hq]; exact outer_none out members xs
    · exact ih _ m

variable (all edges)

-- what holds between steps; G: the gray nodes, whose visits are running, innermost first
structure wf (s : state α) (G : List α) : Prop where
  inall : ∀ x, s.index x ≠ none → x ∈ all
  onstack : ∀ x, s.on x = true ↔ x ∈ s.stack
  nodup : s.stack.Nodup
  onseen : ∀ x, s.on x = true → s.index x ≠ none
  outseen : ∀ x, s.out x ≠ none → s.index x ≠ none
  onout : ∀ x, s.on x = true → s.out x = none
  cover : ∀ x, s.index x ≠ none → s.on x = true ∨ s.out x ≠ none
  -- a finished node's edges are all indexed
  black : ∀ x, s.index x ≠ none → x ∉ G → ∀ y ∈ edges x, s.index y ≠ none
  gray : ∀ g ∈ G, s.on g = true
  below : ∀ x i, s.index x = some i → i < s.next
  -- lemma R so far: a ranked node's edges are ranked, lower, or the same and on a cycle with it
  ranked : ∀ x y rx, s.out x = some rx → y ∈ edges x → ∃ ry, s.out y = some ry ∧
    (ry < rx ∨ (ry = rx ∧ Relation.TransGen (edge all edges) y x))
  -- each node on the stack reaches a gray one
  back : ∀ x, s.on x = true → ∃ g ∈ G, reach all edges x g
  nan : s.nan = false
  cut : s.cut = false

-- what visit q leaves: t from s, under the gray G of its caller
structure post (s t : state α) (q : α) (G : List α) : Prop where
  good : wf all edges t G
  seen : t.index q = some s.next
  index : ∀ x i, s.index x = some i → t.index x = some i
  low : ∀ x, s.index x ≠ none → t.low x = s.low x
  out : ∀ x r, s.out x = some r → t.out x = some r
  next : s.next < t.next
  fresh : ∀ x i, s.index x = none → t.index x = some i → s.next ≤ i
  stack : ∃ N, t.stack = N ++ s.stack ∧ ∀ x ∈ N, s.index x = none
  -- low q is at most the index of anything below on the stack that a new node has an edge to
  xedge : ∀ x y j, t.on x = true → s.index x = none → y ∈ edges x → y ∈ s.stack →
    t.index y = some j → t.low q ≤ j
  wit : t.low q = s.next ∨ ∃ z, t.on z = true ∧ t.index z = some (t.low q) ∧ reach all edges q z
  reached : ∀ x, s.index x = none → t.index x ≠ none → reach all edges q x

-- visit p's loop: s0 before p was pushed, s now, done the edges of p looked at; f the fuel left
structure inv (f : Nat) (s0 : state α) (p : α) (G done : List α) (s : state α) : Prop where
  good : wf all edges s (p :: G)
  seen : s.index p = some s0.next
  index : ∀ x i, s0.index x = some i → s.index x = some i
  low : ∀ x, s0.index x ≠ none → s.low x = s0.low x
  out : ∀ x r, s0.out x = some r → s.out x = some r
  next : s0.next < s.next
  fresh : ∀ x i, s0.index x = none → s.index x = some i → s0.next ≤ i
  stack : ∃ M, s.stack = M ++ p :: s0.stack ∧ ∀ x ∈ M, s0.index x = none
  lowp : s.low p ≤ s0.next
  wit : ∃ z, s.on z = true ∧ s.index z = some (s.low p) ∧ reach all edges p z
  xedge : ∀ x y j, s.on x = true → s0.index x = none → x ≠ p → y ∈ edges x → y ∈ s0.stack →
    s.index y = some j → s.low p ≤ j
  xdone : ∀ y j, y ∈ done → y ∈ s0.stack → s.index y = some j → s.low p ≤ j
  done : ∀ y ∈ done, s.index y ≠ none
  reached : ∀ x, s0.index x = none → s.index x ≠ none → reach all edges p x
  fuel : count s.index all < f

variable {all edges}


-- after p is pushed
theorem push_inv {f : Nat} {s0 : state α} {p : α} {G : List α} (w : wf all edges s0 G)
    (hp : s0.index p = none) (pa : p ∈ all) (hf : count s0.index all < f + 1) :
    inv all edges f s0 p G [] (push p s0) := by
  have hpo : s0.on p = false := by
    cases h : s0.on p
    · rfl
    · exact absurd hp (w.onseen p h)
  have hps : p ∉ s0.stack := fun m => by rw [← w.onstack] at m; simp [hpo] at m
  have ne : ∀ x, s0.index x ≠ none → x ≠ p := fun x h e => h (e ▸ hp)
  refine {
    good := ?_, seen := by simp [push], index := ?_, low := ?_, out := fun x r h => h,
    next := by simp [push], fresh := ?_, stack := ⟨[], by simp [push], by simp⟩,
    lowp := by simp [push], wit := ⟨p, by simp [push], by simp [push], reach_refl p⟩,
    xedge := ?_, xdone := by simp, done := by simp, reached := ?_, fuel := ?_ }
  · exact {
      inall := by
        intro x hx
        by_cases h : x = p
        · exact h ▸ pa
        · simp only [push, put, h, ↓reduceIte] at hx; exact w.inall x hx
      onstack := by
        intro x
        by_cases h : x = p
        · simp [push, put, h]
        · simp [push, put, h, w.onstack]
      nodup := List.nodup_cons.2 ⟨hps, w.nodup⟩
      onseen := by
        intro x hx
        by_cases h : x = p
        · simp [push, put, h]
        · simp only [push, put, h, ↓reduceIte] at hx ⊢; exact w.onseen x hx
      outseen := by
        intro x hx
        by_cases h : x = p
        · simp [push, put, h]
        · simp only [push, put, h, ↓reduceIte] at hx ⊢; exact w.outseen x hx
      onout := by
        intro x hx
        by_cases h : x = p
        · subst h; cases ho : s0.out x
          · simp [push, ho]
          · exact absurd hp (w.outseen x (by simp [ho]))
        · simp only [push, put, h, ↓reduceIte] at hx ⊢; exact w.onout x hx
      cover := by
        intro x hx
        by_cases h : x = p
        · simp [push, put, h]
        · simp only [push, put, h, ↓reduceIte] at hx ⊢; exact w.cover x hx
      black := by
        intro x hx hxg y hy
        simp only [List.mem_cons, not_or] at hxg
        simp only [push, put, hxg.1, ↓reduceIte] at hx ⊢
        have := w.black x hx hxg.2 y hy
        split <;> simp_all
      gray := by
        intro g hg
        by_cases h : g = p
        · simp [push, put, h]
        · simp only [push, put, h, ↓reduceIte]
          exact w.gray g (by simpa [h] using hg)
      below := by
        intro x i hx
        by_cases h : x = p
        · simp [push, put, h] at hx ⊢; omega
        · simp only [push, put, h, ↓reduceIte] at hx ⊢; have := w.below x i hx; omega
      ranked := fun x y rx h hy => w.ranked x y rx h hy
      back := by
        intro x hx
        by_cases h : x = p
        · exact ⟨p, List.mem_cons_self, h ▸ reach_refl x⟩
        · simp only [push, put, h, ↓reduceIte] at hx
          obtain ⟨g, hg, r⟩ := w.back x hx
          exact ⟨g, List.mem_cons_of_mem _ hg, r⟩
      nan := w.nan
      cut := w.cut }
  · intro x i hx
    simp only [push, put, ne x (by simp [hx]), ↓reduceIte]; exact hx
  · intro x hx
    simp only [push, put, ne x hx, ↓reduceIte]
  · intro x i hx hx'
    by_cases h : x = p
    · simp [push, put, h] at hx'; omega
    · simp only [push, put, h, ↓reduceIte] at hx'; simp [hx] at hx'
  · intro x y j hx hx0 hxp
    simp only [push, put, hxp, ↓reduceIte] at hx
    exact absurd hx0 (w.onseen x hx)
  · intro x hx0 hx
    by_cases h : x = p
    · exact h ▸ reach_refl x
    · simp only [push, put, h, ↓reduceIte] at hx; exact absurd hx0 hx
  · have := count_lt (s := s0.index) (t := (push p s0).index)
      (by intro x hx; by_cases h : x = p
          · simp [push, put, h] at hx
          · simpa [push, put, h] using hx) hp (by simp [push]) pa
    omega


-- an index once set stays
theorem keep {s t : α → Option Nat} (h : ∀ x i, s x = some i → t x = some i) {x : α}
    (hx : s x ≠ none) : t x ≠ none := by
  obtain ⟨i, hi⟩ := Option.ne_none_iff_exists'.1 hx; simp [h x i hi]

theorem keep' {s t : α → Option Nat} (h : ∀ x i, s x = some i → t x = some i) {x : α}
    (hx : t x = none) : s x = none := by
  cases hs : s x with
  | none => rfl
  | some i => rw [h x i hs] at hx; cases hx

-- wf does not look at low
theorem wf_low {t : state α} {G : List α} (l : α → Nat) (w : wf all edges t G) :
    wf all edges { t with low := l } G :=
  ⟨w.1, w.2, w.3, w.4, w.5, w.6, w.7, w.8, w.9, w.10, w.11, w.12, w.13, w.14⟩

-- after visit q of an edge p → q, q not yet indexed
theorem child_inv {f : Nat} {s0 s t : state α} {p q : α} {G done : List α}
    (I : inv all edges f s0 p G done s) (P : post all edges s t q (p :: G))
    (hq : s.index q = none) (hqe : q ∈ edges p) (pa : p ∈ all) (hp0 : s0.index p = none) :
    inv all edges f s0 p G (done ++ [q]) { t with low := put t.low p (min (t.low p) (t.low q)) } := by
  have hps : s.index p ≠ none := by simp [I.seen]
  have hqp : q ≠ p := fun e => hps (e ▸ hq)
  have tlp : t.low p = s.low p := P.low p hps
  obtain ⟨M, hM, hM0⟩ := I.stack
  obtain ⟨N, hN, hN0⟩ := P.stack
  have sub : ∀ y, y ∈ s0.stack → y ∈ s.stack := by intro y hy; rw [hM]; simp [hy]
  have sts : ∀ y, y ∈ s.stack → y ∈ t.stack := by intro y hy; rw [hN]; simp [hy]
  have ion : ∀ y, y ∈ s.stack → ∃ j, s.index y = some j := by
    intro y hy; exact Option.ne_none_iff_exists'.1 (I.good.onseen y ((I.good.onstack y).2 hy))
  have lp : put t.low p (min (t.low p) (t.low q)) p = min (s.low p) (t.low q) := by
    rw [put_same, tlp]
  refine {
    good := wf_low _ P.good, seen := P.index p _ I.seen,
    index := fun x i h => P.index x i (I.index x i h),
    low := ?_, out := fun x r h => P.out x r (I.out x r h), next := Nat.lt_trans I.next P.next,
    fresh := ?_, stack := ?_, lowp := ?_, wit := ?_, xedge := ?_, xdone := ?_, done := ?_,
    reached := ?_, fuel := ?_ }
  · intro x hx
    have xp : x ≠ p := fun e => hx (e ▸ hp0)
    show put t.low p _ x = s0.low x
    rw [put_ne _ _ xp, P.low x (keep I.index hx), I.low x hx]
  · intro x i hx0 hx
    cases hs : s.index x with
    | none => have := P.fresh x i hs hx; have := I.next; omega
    | some i' =>
      have := P.index x i' hs
      have e : i = i' := by rw [show t.index x = some i from hx] at this; cases this; rfl
      exact e ▸ I.fresh x i' hx0 hs
  · refine ⟨N ++ M, by show t.stack = _; rw [hN, hM]; simp, ?_⟩
    intro x hx
    rcases List.mem_append.1 hx with hx | hx
    · exact keep' I.index (hN0 x hx)
    · exact hM0 x hx
  · show put t.low p _ p ≤ s0.next
    rw [lp]; have := I.lowp; omega
  · show ∃ z, t.on z = true ∧ t.index z = some (put t.low p _ p) ∧ reach all edges p z
    rw [lp]
    by_cases lt : t.low q < s.low p
    · rcases P.wit with e | ⟨z, hz, hzi, rz⟩
      · have := I.lowp; have := I.next; omega
      · exact ⟨z, hz, by rw [hzi]; congr 1; omega, reach_trans (reach_edge ⟨pa, hqe⟩) rz⟩
    · obtain ⟨z, hz, hzi, rz⟩ := I.wit
      refine ⟨z, ?_, by rw [P.index z _ hzi]; congr 1; omega, rz⟩
      exact (P.good.onstack z).2 (sts z ((I.good.onstack z).1 hz))
  · intro x y j hx hx0 hxp hy hys hyj
    show put t.low p _ p ≤ j
    rw [lp]
    obtain ⟨j0, hj0⟩ := ion y (sub y hys)
    have e : j = j0 := by
      have := P.index y j0 hj0; rw [show t.index y = some j from hyj] at this; cases this; rfl
    cases hsx : s.index x with
    | none => have := P.xedge x y j hx hsx hy (sub y hys) hyj; omega
    | some i =>
      have son : s.on x = true := by
        rcases I.good.cover x (by simp [hsx]) with h | h
        · exact h
        · obtain ⟨r, hr⟩ := Option.ne_none_iff_exists'.1 h
          have := P.good.onout x hx; rw [P.out x r hr] at this; cases this
      have := I.xedge x y j0 son hx0 hxp hy hys hj0; omega
  · intro y j hy hys hyj
    show put t.low p _ p ≤ j
    rw [lp]
    rcases List.mem_append.1 hy with hy | hy
    · obtain ⟨j0, hj0⟩ := ion y (sub y hys)
      have e : j = j0 := by
        have := P.index y j0 hj0; rw [show t.index y = some j from hyj] at this; cases this; rfl
      have := I.xdone y j0 hy hys hj0; omega
    · simp at hy; subst hy
      obtain ⟨j0, hj0⟩ := ion y (sub y hys); rw [hq] at hj0; cases hj0
  · intro y hy
    rcases List.mem_append.1 hy with hy | hy
    · exact keep P.index (I.done y hy)
    · simp at hy; subst hy; show t.index y ≠ none; simp [P.seen]
  · intro x hx0 hx
    cases hs : s.index x with
    | none => exact reach_trans (reach_edge ⟨pa, hqe⟩) (P.reached x hs hx)
    | some i => exact I.reached x hx0 (by simp [hs])
  · have := count_le (s := s.index) (t := t.index) (fun x h => keep' P.index h) all
    have := I.fuel
    show count t.index all < f
    omega


-- an edge p → q, q indexed and on the stack
theorem onq_inv {f : Nat} {s0 s : state α} {p q : α} {G done : List α} {i : Nat}
    (I : inv all edges f s0 p G done s) (hq : s.index q = some i) (hon : s.on q = true)
    (hqe : q ∈ edges p) (pa : p ∈ all) (hp0 : s0.index p = none) :
    inv all edges f s0 p G (done ++ [q]) { s with low := put s.low p (min (s.low p) i) } := by
  have lp : put s.low p (min (s.low p) i) p = min (s.low p) i := put_same _ _ _
  refine {
    good := wf_low _ I.good, seen := I.seen, index := I.index, low := ?_, out := I.out,
    next := I.next, fresh := I.fresh, stack := I.stack, lowp := ?_, wit := ?_, xedge := ?_,
    xdone := ?_, done := ?_, reached := I.reached, fuel := I.fuel }
  · intro x hx
    have xp : x ≠ p := fun e => hx (e ▸ hp0)
    show put s.low p _ x = s0.low x
    rw [put_ne _ _ xp, I.low x hx]
  · show put s.low p _ p ≤ s0.next
    rw [lp]; have := I.lowp; omega
  · show ∃ z, s.on z = true ∧ s.index z = some (put s.low p _ p) ∧ reach all edges p z
    rw [lp]
    by_cases lt : i < s.low p
    · exact ⟨q, hon, by rw [hq]; congr 1; omega, reach_edge ⟨pa, hqe⟩⟩
    · obtain ⟨z, hz, hzi, rz⟩ := I.wit
      exact ⟨z, hz, by rw [hzi]; congr 1; omega, rz⟩
  · intro x y j hx hx0 hxp hy hys hyj
    show put s.low p _ p ≤ j
    rw [lp]; have := I.xedge x y j hx hx0 hxp hy hys hyj; omega
  · intro y j hy hys hyj
    show put s.low p _ p ≤ j
    rw [lp]
    rcases List.mem_append.1 hy with hy | hy
    · have := I.xdone y j hy hys hyj; omega
    · simp at hy; subst hy; rw [hq] at hyj; cases hyj; omega
  · intro y hy
    rcases List.mem_append.1 hy with hy | hy
    · exact I.done y hy
    · simp at hy; subst hy; show s.index y ≠ none; simp [hq]

-- an edge p → q, q indexed and off the stack: ranked already
theorem offq_inv {f : Nat} {s0 s : state α} {p q : α} {G done : List α} {i : Nat}
    (I : inv all edges f s0 p G done s) (hq : s.index q = some i) (hon : s.on q = false) :
    inv all edges f s0 p G (done ++ [q]) s := by
  obtain ⟨M, hM, _⟩ := I.stack
  refine { I with xdone := ?_, done := ?_ }
  · intro y j hy hys hyj
    rcases List.mem_append.1 hy with hy | hy
    · exact I.xdone y j hy hys hyj
    · simp at hy; subst hy
      have : y ∈ s.stack := by rw [hM]; simp [hys]
      rw [← I.good.onstack, hon] at this; cases this
  · intro y hy
    rcases List.mem_append.1 hy with hy | hy
    · exact I.done y hy
    · simp at hy; subst hy; simp [hq]

-- p's loop over its edges, given what visit does with less fuel
theorem loop_inv {f : Nat} {s0 : state α} {p : α} {G : List α}
    (IH : ∀ q s G, wf all edges s G → s.index q = none → q ∈ all → count s.index all < f →
      post all edges s (visit edges f q s) q G)
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) (pa : p ∈ all) (hp0 : s0.index p = none) :
    ∀ (rest done : List α) (s : state α), (∀ q ∈ rest, q ∈ edges p) →
      inv all edges f s0 p G done s →
      inv all edges f s0 p G (done ++ rest) (loop (visit edges f) p rest s)
  | [], done, s, _, I => by simpa [loop] using I
  | q :: qs, done, s, hr, I => by
    have hqe := hr q List.mem_cons_self
    have hr' : ∀ q ∈ qs, q ∈ edges p := fun q' m => hr q' (List.mem_cons_of_mem _ m)
    rw [show done ++ q :: qs = (done ++ [q]) ++ qs by simp]
    cases hq : s.index q with
    | none =>
      simp only [loop, hq]
      have P := IH q s (p :: G) I.good hq (close p pa q hqe) I.fuel
      exact loop_inv IH close pa hp0 qs _ _ hr' (child_inv I P hq hqe pa hp0)
    | some i =>
      cases hon : s.on q with
      | true =>
        simp only [loop, hq, hon, ↓reduceIte]
        exact loop_inv IH close pa hp0 qs _ _ hr' (onq_inv I hq hon hqe pa hp0)
      | false =>
        simp only [loop, hq, hon]
        exact loop_inv IH close pa hp0 qs _ _ hr' (offq_inv I hq hon)


-- the ranked are closed under paths
theorem closed {s : state α} {G : List α} (w : wf all edges s G) {a b : α} (ha : s.out a ≠ none)
    (r : reach all edges a b) : s.out b ≠ none := by
  rcases r with rfl | r
  · exact ha
  · induction r with
    | single e =>
      obtain ⟨ra, hra⟩ := Option.ne_none_iff_exists'.1 ha
      obtain ⟨ry, hry, _⟩ := w.ranked _ _ ra hra e.2; simp [hry]
    | tail _ e ih =>
      obtain ⟨ra, hra⟩ := Option.ne_none_iff_exists'.1 ih
      obtain ⟨ry, hry, _⟩ := w.ranked _ _ ra hra e.2; simp [hry]

-- p is not its component's root: it stays on the stack
theorem stay_post {f : Nat} {s0 t : state α} {p : α} {G : List α} (w0 : wf all edges s0 G)
    (hp0 : s0.index p = none) (I : inv all edges f s0 p G (edges p) t)
    (h : t.index p ≠ some (t.low p)) : post all edges s0 t p G := by
  have hlt : t.low p < s0.next := by
    have := I.lowp; rw [I.seen] at h
    have : s0.next ≠ t.low p := fun e => h (by rw [e])
    omega
  obtain ⟨M, hM, hM0⟩ := I.stack
  have up : ∃ g ∈ G, reach all edges p g := by
    obtain ⟨z, hz, hzi, rz⟩ := I.wit
    have hzs := (I.good.onstack z).1 hz
    rw [hM] at hzs
    by_cases zs : z ∈ s0.stack
    · obtain ⟨g, hg, rg⟩ := w0.back z ((w0.onstack z).2 zs)
      exact ⟨g, hg, reach_trans rz rg⟩
    · have z0 : s0.index z = none := by
        simp only [List.mem_append, List.mem_cons] at hzs
        rcases hzs with hzs | rfl | hzs
        · exact hM0 z hzs
        · exact hp0
        · exact absurd hzs zs
      have := I.fresh z _ z0 hzi; omega
  refine {
    good := ?_, seen := I.seen, index := I.index, low := I.low, out := I.out, next := I.next,
    fresh := I.fresh, stack := ⟨M ++ [p], by rw [hM]; simp, ?_⟩, xedge := ?_, wit := Or.inr I.wit,
    reached := I.reached }
  · have w := I.good
    exact {
      inall := w.inall, onstack := w.onstack, nodup := w.nodup, onseen := w.onseen,
      outseen := w.outseen, onout := w.onout, cover := w.cover
      black := by
        intro x hx hxg y hy
        by_cases xp : x = p
        · subst xp; exact I.done y hy
        · exact w.black x hx (by simp [xp, hxg]) y hy
      gray := fun g hg => w.gray g (List.mem_cons_of_mem _ hg)
      below := w.below, ranked := w.ranked
      back := by
        intro x hx
        obtain ⟨g, hg, r⟩ := w.back x hx
        rcases List.mem_cons.1 hg with rfl | hg
        · obtain ⟨g', hg', r'⟩ := up; exact ⟨g', hg', reach_trans r r'⟩
        · exact ⟨g, hg, r⟩
      nan := w.nan, cut := w.cut }
  · intro x hx
    simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at hx
    rcases hx with hx | rfl
    · exact hM0 x hx
    · exact hp0
  · intro x y j hx hx0 hy hys hyj
    by_cases xp : x = p
    · subst xp; exact I.xdone y j hy hys hyj
    · exact I.xedge x y j hx hx0 xp hy hys hyj

-- p is its component's root: the component is popped and ranked
theorem pop_post {f : Nat} {s0 t : state α} {p : α} {G : List α} (w0 : wf all edges s0 G)
    (hp0 : s0.index p = none) (I : inv all edges f s0 p G (edges p) t)
    (h : t.index p = some (t.low p)) : post all edges s0 (finish edges p t) p G := by
  have w := I.good
  have hlow : t.low p = s0.next := by rw [I.seen] at h; exact (Option.some.inj h).symm
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
  -- no edge from the component goes down the stack below p
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
  -- so each edge leaving it goes to a ranked node
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
  -- each member reaches p
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
  -- and p reaches each member
  have K3 : ∀ x ∈ C, reach all edges p x :=
    fun x hx => I.reached x (hC0 x hx) (w.onseen x (hCon x hx))
  obtain ⟨r, hr, hb⟩ := score_some t.out C K1
  have hfin : finish edges p t =
      { t with
        stack := s0.stack
        on := fun x => if x ∈ C then false else t.on x
        out := fun x => if x ∈ C then some r else t.out x } := by
    simp [finish, h, hpop, hr]
  rw [hfin]
  have uon : ∀ x, (if x ∈ C then false else t.on x) = true ↔ x ∈ s0.stack := by
    intro x
    by_cases hx : x ∈ C
    · simp only [hx, ↓reduceIte, Bool.false_eq_true, false_iff]; exact hdis x hx
    · simp only [hx, ↓reduceIte, w.onstack, hstk, false_or]
  have outC : ∀ x, t.out x ≠ none → x ∉ C := by
    intro x ho hx; exact ho (w.onout x (hCon x hx))
  refine {
    good := ?_, seen := I.seen, index := I.index, low := I.low, out := ?_, next := I.next,
    fresh := I.fresh, stack := ⟨[], by simp, by simp⟩, xedge := ?_, wit := Or.inl hlow,
    reached := I.reached }
  · exact {
      inall := w.inall
      onstack := uon
      nodup := w0.nodup
      onseen := by
        intro x hx
        dsimp only at hx ⊢
        by_cases hxC : x ∈ C
        · simp [hxC] at hx
        · simp only [hxC, ↓reduceIte] at hx; exact w.onseen x hx
      outseen := by
        intro x hx
        dsimp only at hx ⊢
        by_cases hxC : x ∈ C
        · exact w.onseen x (hCon x hxC)
        · simp only [hxC, ↓reduceIte] at hx; exact w.outseen x hx
      onout := by
        intro x hx
        dsimp only at hx ⊢
        by_cases hxC : x ∈ C
        · simp [hxC] at hx
        · simp only [hxC, ↓reduceIte] at hx ⊢; exact w.onout x hx
      cover := by
        intro x hx
        dsimp only at hx ⊢
        by_cases hxC : x ∈ C
        · simp [hxC]
        · simp only [hxC, ↓reduceIte]; exact w.cover x hx
      black := by
        intro x hx hxg y hy
        by_cases xp : x = p
        · subst xp; exact I.done y hy
        · exact w.black x hx (by simp [xp, hxg]) y hy
      gray := fun g hg => (uon g).2 ((w0.onstack g).1 (w0.gray g hg))
      below := w.below
      ranked := by
        intro x y rx hx hy
        dsimp only at hx ⊢
        by_cases hxC : x ∈ C
        · simp only [hxC, ↓reduceIte, Option.some.injEq] at hx
          subst hx
          by_cases hyC : y ∈ C
          · refine ⟨r, by simp [hyC], Or.inr ⟨rfl, ?_⟩⟩
            exact cycle ⟨w.inall x (w.onseen x (hCon x hxC)), hy⟩
              (reach_trans (K2 y hyC) (K3 x hxC))
          · obtain ⟨o, ho⟩ := Option.ne_none_iff_exists'.1 (K1 x hxC y hy hyC)
            have := hb x hxC y hy hyC o ho
            exact ⟨o, by simp [hyC, ho], Or.inl (by omega)⟩
        · simp only [hxC, ↓reduceIte] at hx
          obtain ⟨ry, hry, hor⟩ := w.ranked x y rx hx hy
          have hyC := outC y (by simp [hry])
          exact ⟨ry, by simp [hyC, hry], hor⟩
      back := by
        intro x hx
        exact w0.back x ((w0.onstack x).2 ((uon x).1 hx))
      nan := w.nan, cut := w.cut }
  · intro x r' hx
    have := I.out x r' hx
    have hxC := outC x (by simp [this])
    simp [hxC, this]
  · intro x y j hx hx0
    have := (uon x).1 hx
    obtain ⟨j', hj'⟩ := s0i x this
    rw [hx0] at hj'; cases hj'


-- visit q keeps wf and leaves post, given fuel above the nodes not yet indexed
theorem visit_spec
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    ∀ (f : Nat) (q : α) (s : state α) (G : List α), wf all edges s G → s.index q = none →
      q ∈ all → count s.index all < f → post all edges s (visit edges f q s) q G
  | 0, _, _, _, _, _, _, hf => absurd hf (Nat.not_lt_zero _)
  | f + 1, p, s, G, w, hp, pa, hf => by
    have I := loop_inv (visit_spec close f) close pa hp (edges p) [] (push p s) (fun _ h => h)
      (push_inv w hp pa hf)
    simp only [List.nil_append] at I
    simp only [visit]
    generalize loop (visit edges f) p (edges p) (push p s) = t at I ⊢
    by_cases h : t.index p = some (t.low p)
    · exact pop_post w hp I h
    · have e : finish edges p t = t := by simp [finish, h]
      rw [e]; exact stay_post w hp I h

-- rank's start
theorem init_wf : wf all edges (init : state α) [] := {
  inall := by simp [init], onstack := by simp [init], nodup := List.nodup_nil,
  onseen := by simp [init], outseen := by simp [init], onout := by simp [init],
  cover := by simp [init], black := by simp [init], gray := by simp,
  below := by simp [init], ranked := by simp [init], back := by simp [init],
  nan := rfl, cut := rfl }

-- rank's for: each node visited or skipped, wf kept, all indexed
theorem run_spec
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    ∀ (xs : List α) (s : state α), (∀ x ∈ xs, x ∈ all) → wf all edges s [] →
      wf all edges (xs.foldl (fun s p => if s.index p = none then
        visit edges (all.length + 1) p s else s) s) [] ∧
      (∀ x, s.index x ≠ none → (xs.foldl (fun s p => if s.index p = none then
        visit edges (all.length + 1) p s else s) s).index x ≠ none) ∧
      ∀ x ∈ xs, (xs.foldl (fun s p => if s.index p = none then
        visit edges (all.length + 1) p s else s) s).index x ≠ none
  | [], s, _, w => ⟨w, fun _ h => h, by simp⟩
  | x :: xs, s, hxs, w => by
    simp only [List.foldl_cons]
    have hxs' : ∀ y ∈ xs, y ∈ all := fun y m => hxs y (List.mem_cons_of_mem _ m)
    have step : wf all edges (if s.index x = none then visit edges (all.length + 1) x s else s) [] ∧
        (∀ y, s.index y ≠ none →
          (if s.index x = none then visit edges (all.length + 1) x s else s).index y ≠ none) ∧
        (if s.index x = none then visit edges (all.length + 1) x s else s).index x ≠ none := by
      by_cases hx : s.index x = none
      · simp only [hx, ↓reduceIte]
        have := count_length s.index all
        have P := visit_spec close (all.length + 1) x s [] w hx (hxs x List.mem_cons_self)
          (by omega)
        exact ⟨P.good, fun y h => keep P.index h, by simp [P.seen]⟩
      · simp only [hx, ↓reduceIte]; exact ⟨w, fun _ h => h, hx⟩
    obtain ⟨w', fr, hx⟩ := step
    obtain ⟨w'', fr', hall⟩ := run_spec close xs _ hxs' w'
    refine ⟨w'', fun y h => fr' y (fr y h), ?_⟩
    intro y m
    rcases List.mem_cons.1 m with rfl | m
    · exact fr' y hx
    · exact hall y m

-- after rank's for: nothing on the stack, all indexed
theorem run_wf
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    wf all edges (run all edges) [] ∧ ∀ x ∈ all, (run all edges).index x ≠ none := by
  have := run_spec close all init (fun _ h => h) init_wf
  exact ⟨this.1, this.2.2⟩

/-! ## the theorems -/

-- 1. every node of all gets a rank; no `out.get(q)! + 1` found a node unranked; the fuel was enough
theorem ranks_all
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    (∀ x ∈ all, rank all edges x ≠ none) ∧ (run all edges).nan = false ∧
      (run all edges).cut = false := by
  obtain ⟨w, hall⟩ := run_wf close
  refine ⟨?_, w.nan, w.cut⟩
  intro x hx
  rcases w.cover x (hall x hx) with h | h
  · obtain ⟨g, hg, _⟩ := w.back x h; simp at hg
  · exact h

-- 2. lemma R: along an edge the rank never rises; leaving a component it falls
theorem rank_ranked
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) :
    ranked (fun p q => p ∈ all ∧ q ∈ edges p) (fun x => (rank all edges x).getD 0) := by
  obtain ⟨w, _⟩ := run_wf close
  intro p q ⟨pa, hq⟩
  obtain ⟨rp, hrp⟩ := Option.ne_none_iff_exists'.1 ((ranks_all close).1 p pa)
  obtain ⟨rq, hrq, hor⟩ := w.ranked p q rp hrp hq
  simp only [rank] at hrp ⊢
  simp only [hrp, hrq, Option.getD_some]
  rcases hor with lt | ⟨eq, tr⟩
  · exact ⟨Nat.le_of_lt lt, fun _ => lt⟩
  · exact ⟨Nat.le_of_eq eq, fun n => absurd tr n⟩

-- along a path the rank never rises
theorem rank_path
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) {p q : α}
    (h : Relation.TransGen (fun p q => p ∈ all ∧ q ∈ edges p) p q) :
    (rank all edges q).getD 0 ≤ (rank all edges p).getD 0 := by
  induction h with
  | single e => exact (rank_ranked close _ _ e).1
  | tail _ e ih => exact Nat.le_trans (rank_ranked close _ _ e).1 ih

-- a path starts in all
theorem path_start {p q : α} (h : Relation.TransGen (fun p q => p ∈ all ∧ q ∈ edges p) p q) :
    p ∈ all := by
  induction h with
  | single e => exact e.1
  | tail _ _ ih => exact ih

-- 3. mutually reachable nodes share a rank
theorem rank_cycle
    -- assumed: every edge of a node of all goes into all
    (close : ∀ p ∈ all, ∀ q ∈ edges p, q ∈ all) {p q : α}
    (h1 : Relation.TransGen (fun p q => p ∈ all ∧ q ∈ edges p) p q)
    (h2 : Relation.TransGen (fun p q => p ∈ all ∧ q ∈ edges p) q p) :
    rank all edges p = rank all edges q := by
  obtain ⟨rp, hrp⟩ := Option.ne_none_iff_exists'.1 ((ranks_all close).1 p (path_start h1))
  obtain ⟨rq, hrq⟩ := Option.ne_none_iff_exists'.1 ((ranks_all close).1 q (path_start h2))
  have a := rank_path close h1
  have b := rank_path close h2
  rw [hrp, hrq] at a b ⊢
  simp only [Option.getD_some] at a b
  congr 1; omega

end proofs

end Rank
