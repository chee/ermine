-- LLM generated working output
-- causes.ts in Lean: run, keep, loop, from and end over a heap of cause objects, with
-- loop's and from's while loops as written (a stack, seen, on), and the scheduler's own writes of
-- t.kept (take, restore, clear). proved, for any state with ok: loop_some (1), loop_list and
-- loop_exact (2), from_iff (3), end_ran, end_held and end_kept (4); with fresh too, loop_chain (5,
-- Theorem 7). reachable_ok: ok and fresh hold of every state reached by steps whose arguments keep
-- the callers' promises below. keep_frame, keep_kept: what keep leaves and keeps.
-- ran and holding are pulse numbers (ranIn, heldIn: ran or held when equal to pulse); ok says one
-- holding a cause is held this pulse, so end, clearing the held, empties every kept
--
-- abstractions, and where this departs from causes.ts:
-- - identity: a Cause object is its id, its index in heap, given by run in the order made. js's
--   seen and on are sets of objects by identity; here sets of ids. tree unfolds an id to Basic's
--   Cause, the value back reads; shared objects unfold to equal subtrees. the answers are stated
--   of tree, so they do not depend on sharing
-- - fields on each computation (t.kept, t.ranIn, t.heldIn, t.n) are functions: kept : α → List Nat,
--   ranIn, heldIn : α → Nat, n : α → Nat. holding is a list (js: an array, pushed once a pulse)
-- - kept may repeat a cause, not at once (keep's skip looks at the last only)
-- - a stack is a list, its top first (js: an array, its top last)
-- - a walk skips an id off the heap; under ok there is none (every parent is made first)
-- - loop maps on to computations by filterMap ofs: ofs is none only off the heap, never
-- - [...new Set(l)] is uniq (each once, where it first came); js's sort is List.mergeSort, both
--   stable; with distinct n there is one sorted order (sorted_unique)
-- - loop's c is Option Nat: none is undefined
-- - since: a ghost, heap.size at the last end, so "made this pulse" is "id ≥ since"; not in the code
-- - take, restore, clear: the scheduler's own writes of t.kept (scheduler.ts: first's given = c.kept,
--   c.kept = []; finish's c.kept = r.given.concat(c.kept); a disposal's c.kept.length = 0). not
--   causes.ts; here so ok holds across them
-- - what callers promise, not checked by causes.ts (reachable's hypotheses): run's given, keep's c
--   and restore's given are causes made (id < heap.size, for ok) and made this pulse (id ≥ since, for
--   fresh: scheduler.ts, first gives c.kept and mark keeps causeOf(by)); restore puts given back in
--   the pulse it was taken in (t held then, for ok: so end clears it)
import Scheduler.Basic

set_option linter.unusedSectionVars false

-- a cause object: its computation, and its parents by id (causes.ts, Cause)
structure Made (α : Type) where
  of : α
  parents : List Nat

-- createCauses's closure, with each computation's fields kept, ranIn and heldIn (causes.ts,
-- createCauses)
structure Causes (α : Type) where
  heap : Array (Made α)  -- every cause made, its id its index
  pulse : Nat
  holding : List α
  kept : α → List Nat
  ranIn : α → Nat
  heldIn : α → Nat
  since : Nat  -- ghost: heap.size at the last end

namespace Causes

variable {α : Type} [DecidableEq α]

-- a field set on one computation
def upd {β : Type} (f : α → β) (a : α) (b : β) : α → β := fun x => if x = a then b else f x

@[simp] theorem upd_same {β : Type} (f : α → β) (a : α) (b : β) : upd f a b a = b := by simp [upd]

theorem upd_ne {β : Type} (f : α → β) {a x : α} (b : β) (h : x ≠ a) : upd f a b x = f x := by
  simp [upd, h]

-- x.parents
def ps (h : Array (Made α)) (x : Nat) : List Nat :=
  match h[x]? with
  | some m => m.parents
  | none => []

-- x.of
def ofs (h : Array (Made α)) (x : Nat) : Option α := h[x]?.map Made.of

-- [...new Set(l)]: each once, where it first came
def uniq {β : Type} [DecidableEq β] : List β → List β
  | [] => []
  | a :: l => a :: (uniq l).filter (· ≠ a)

-- ids below n not seen: the walks' measure
def unseen (n : Nat) (seen : List Nat) : Nat := (List.range n).countP (fun i => i ∉ seen)

-- the parents left to visit, and one for each frame: the walk's second measure
def weight (h : Array (Made α)) : List (Nat × Nat) → Nat
  | [] => 0
  | (x, k) :: rest => ((ps h x).length - k + 1) + weight h rest

theorem countP_lt {β : Type} {p q : β → Bool} : ∀ {l : List β}, (∀ i ∈ l, q i → p i) →
    (∃ i ∈ l, p i ∧ ¬ q i) → l.countP q < l.countP p
  | [], _, ⟨_, hi, _⟩ => by simp at hi
  | a :: l, hle, ⟨i, hi, hp, hq⟩ => by
    simp only [List.countP_cons]
    have hm : l.countP q ≤ l.countP p :=
      List.countP_mono_left (fun x hx => hle x (List.mem_cons_of_mem _ hx))
    rcases List.mem_cons.mp hi with rfl | hi
    · simp [hp, hq]; omega
    · have := countP_lt (fun x hx => hle x (List.mem_cons_of_mem _ hx)) ⟨i, hi, hp, hq⟩
      have := hle a (by simp)
      by_cases ha : q a <;> by_cases hb : p a <;> simp_all <;> omega

theorem unseen_lt {n q : Nat} {seen : List Nat} (hq : q < n) (hs : q ∉ seen) :
    unseen n (q :: seen) < unseen n seen := by
  unfold unseen
  apply countP_lt
  · intro i _ h; simp at h ⊢; exact h.2
  · exact ⟨q, by simp [hq], by simp [hs], by simp⟩

-- causes.ts, loop's while: frames [cause, next parent], top first. each cause goes on after its
-- parents, when it is of t or a parent is on
def walk (h : Array (Made α)) (t : α) : List (Nat × Nat) → List Nat → List Nat → List Nat
  | [], _, on => on
  | (x, k) :: rest, seen, on =>
    if hk : k < (ps h x).length then
      if (ps h x)[k] ∈ seen then walk h t ((x, k + 1) :: rest) seen on
      else if (ps h x)[k] < h.size then
        walk h t (((ps h x)[k], 0) :: (x, k + 1) :: rest) ((ps h x)[k] :: seen) on
      else walk h t ((x, k + 1) :: rest) seen on
    else if ofs h x = some t ∨ ∃ q ∈ ps h x, q ∈ on then walk h t rest seen (on ++ [x])
    else walk h t rest seen on
termination_by stack seen => (unseen h.size seen, weight h stack)
decreasing_by
  all_goals simp_wf
  all_goals first
    | (apply Prod.Lex.right; simp only [weight]; omega)
    | (apply Prod.Lex.left; apply unseen_lt <;> assumption)

-- causes.ts, from's while: a stack of ids, top first
def search (h : Array (Made α)) (c : α) : List Nat → List Nat → Bool
  | [], _ => false
  | x :: rest, seen =>
    if x ∈ seen then search h c rest seen
    else if x < h.size then
      if ofs h x = some c then true
      else search h c ((ps h x).reverse ++ rest) (x :: seen)
    else search h c rest seen
termination_by stack seen => (unseen h.size seen, stack.length)
decreasing_by
  all_goals simp_wf
  all_goals first
    | (apply Prod.Lex.right; omega)
    | (apply Prod.Lex.left; apply unseen_lt <;> assumption)


-- createCauses: nothing made, nothing ran or held, nothing kept; the first pulse is 1
def create : Causes α := ⟨#[], 1, [], fun _ => [], fun _ => 0, fun _ => 0, 0⟩

-- causes.ts, run: a run of t, caused by what caused each mark it was given (`given`, a keyword
-- here, so parents); answers its id
def run (s : Causes α) (t : α) (parents : List Nat) : Causes α × Nat :=
  ({ s with heap := s.heap.push ⟨t, parents⟩, ranIn := upd s.ranIn t s.pulse }, s.heap.size)

-- causes.ts, keep: a mark's cause, kept on t until the pulse's end. the same cause again at once:
-- once
def keep (s : Causes α) (t : α) (c : Nat) : Causes α :=
  if (s.kept t).getLast? = some c then s
  else
    let s := { s with kept := upd s.kept t (s.kept t ++ [c]) }
    if s.heldIn t = s.pulse then s
    else { s with heldIn := upd s.heldIn t s.pulse, holding := s.holding ++ [t] }

-- causes.ts, loop: a loop through t, c came out of a run of t in this pulse; its computations
def loop (n : α → Nat) (s : Causes α) (c : Option Nat) (t : α) : Option (List α) :=
  match c with
  | none => none
  | some c =>
    if s.ranIn t ≠ s.pulse then none
    else
      let on := walk s.heap t [(c, 0)] [c] []
      if c ∉ on then none
      else some ((uniq (on.filterMap (ofs s.heap))).mergeSort (fun a b => n a ≤ n b))

-- causes.ts, from: a mark kept on t came out of a run of c in this pulse
def «from» (s : Causes α) (t c : α) : Bool :=
  if s.ranIn c ≠ s.pulse then false else search s.heap c (s.kept t).reverse []

-- causes.ts, end: the pulse's end, causes and runs forgotten
def «end» (s : Causes α) : Causes α :=
  { s with kept := fun u => if u ∈ s.holding then [] else s.kept u,
           holding := [], pulse := s.pulse + 1, since := s.heap.size }

-- scheduler.ts first: given = c.kept, c.kept = [] (the state, and given)
def take (s : Causes α) (t : α) : Causes α × List Nat :=
  ({ s with kept := upd s.kept t [] }, s.kept t)

-- scheduler.ts finish, a run not done: c.kept = r.given.concat(c.kept)
def restore (s : Causes α) (t : α) (gs : List Nat) : Causes α :=
  { s with kept := upd s.kept t (gs ++ s.kept t) }

-- scheduler.ts drop (a disposal): c.kept.length = 0
def clear (s : Causes α) (t : α) : Causes α :=
  { s with kept := upd s.kept t [] }


/-! the heap, and Basic's Cause -/

-- the heap's objects point back: a parent is made before its child
def wf (h : Array (Made α)) : Prop := ∀ x, ∀ q ∈ ps h x, q < x

-- j is i, or reached from i through parents
inductive reach (h : Array (Made α)) : Nat → Nat → Prop
  | refl (i : Nat) : reach h i i
  | step {i q j : Nat} : q ∈ ps h i → reach h q j → reach h i j

-- back on the heap: i reaches a run of t
def back (h : Array (Made α)) (t : α) (i : Nat) : Prop := ∃ j, reach h i j ∧ ofs h j = some t

-- the parents of i made before it, carrying that (all of them, under wf)
def kids (h : Array (Made α)) (i : Nat) : List (Fin i) :=
  (ps h i).filterMap fun p => if hp : p < i then some ⟨p, hp⟩ else none

-- the object with id i, unfolded to Basic's Cause
def tree (h : Array (Made α)) (i : Nat) (hi : i < h.size) : Cause α :=
  .mk h[i].of ((kids h i).map fun p => tree h p.1 (Nat.lt_trans p.2 hi))
termination_by i
decreasing_by exact p.2

-- y is x, or in the ancestry of one of x's parents
inductive anc : Cause α → Cause α → Prop
  | refl (x : Cause α) : anc x x
  | step {x p y : Cause α} : p ∈ x.parents → anc p y → anc x y

-- a path of causes from x to y through parents, every cause on it P
inductive chain (h : Array (Made α)) (P : Nat → Prop) : Nat → Nat → Prop
  | here {x : Nat} : P x → chain h P x x
  | next {x q y : Nat} : P x → q ∈ ps h x → chain h P q y → chain h P x y

/-! invariants of a state -/

-- what every reachable state keeps: objects point back, kept causes are made, a computation
-- holding causes is held this pulse, one held this pulse is in holding, no pulse ahead
structure ok (s : Causes α) : Prop where
  wf : wf s.heap
  kept : ∀ u, ∀ k ∈ s.kept u, k < s.heap.size
  holding : ∀ u, s.kept u ≠ [] → s.heldIn u = s.pulse
  held : ∀ u, s.heldIn u = s.pulse → u ∈ s.holding
  ranIn : ∀ u, s.ranIn u ≤ s.pulse
  heldIn : ∀ u, s.heldIn u ≤ s.pulse

-- what callers giving only this pulse's causes keep (scheduler.ts, causeOf): a cause made this
-- pulse has parents made this pulse and its computation ran this pulse; kept causes are this
-- pulse's
structure fresh (s : Causes α) : Prop where
  since : s.since ≤ s.heap.size
  back : ∀ x, s.since ≤ x → ∀ q ∈ ps s.heap x, s.since ≤ q
  ran : ∀ x a, s.since ≤ x → ofs s.heap x = some a → s.ranIn a = s.pulse
  kept : ∀ u, ∀ k ∈ s.kept u, s.since ≤ k
/-! lemmas on the heap -/

theorem reach_tail {h : Array (Made α)} {c x q : Nat} (hr : reach h c x) (hq : q ∈ ps h x) :
    reach h c q := by
  induction hr with
  | refl => exact .step hq (.refl q)
  | step hp _ ih => exact .step hp (ih hq)

theorem reach_trans {h : Array (Made α)} {a b c : Nat} (h1 : reach h a b) (h2 : reach h b c) :
    reach h a c := by
  induction h1 with
  | refl => exact h2
  | step hp _ ih => exact .step hp (ih h2)

-- under wf, what c reaches is made no later
theorem reach_le {h : Array (Made α)} (hw : wf h) {c x : Nat} (hr : reach h c x) : x ≤ c := by
  induction hr with
  | refl => exact Nat.le_refl _
  | step hq _ ih => have := hw _ _ hq; omega

theorem back_iff {h : Array (Made α)} {t : α} {x : Nat} :
    back h t x ↔ ofs h x = some t ∨ ∃ q ∈ ps h x, back h t q := by
  constructor
  · rintro ⟨j, hr, hj⟩
    cases hr with
    | refl => exact .inl hj
    | step hq hr => exact .inr ⟨_, hq, j, hr, hj⟩
  · rintro (hx | ⟨q, hq, j, hr, hj⟩)
    · exact ⟨x, .refl x, hx⟩
    · exact ⟨j, .step hq hr, hj⟩

theorem ofs_lt {h : Array (Made α)} {x : Nat} {a : α} (hx : ofs h x = some a) : x < h.size := by
  unfold ofs at hx
  rcases Nat.lt_or_ge x h.size with h1 | h1
  · exact h1
  · rw [Array.getElem?_eq_none h1] at hx; simp at hx

theorem ofs_get {h : Array (Made α)} {x : Nat} (hx : x < h.size) : ofs h x = some h[x].of := by
  simp [ofs, hx]

theorem ps_get {h : Array (Made α)} {x : Nat} (hx : x < h.size) : ps h x = h[x].parents := by
  simp [ps, hx]

theorem ps_push {h : Array (Made α)} {m : Made α} {x : Nat} :
    ps (h.push m) x = if x = h.size then m.parents else ps h x := by
  by_cases hx : x = h.size <;> simp [ps, Array.getElem?_push, hx]

theorem ofs_push {h : Array (Made α)} {m : Made α} {x : Nat} :
    ofs (h.push m) x = if x = h.size then some m.of else ofs h x := by
  by_cases hx : x = h.size <;> simp [ofs, Array.getElem?_push, hx]


theorem mem_uniq {β : Type} [DecidableEq β] {a : β} : ∀ {l : List β}, a ∈ uniq l ↔ a ∈ l
  | [] => by simp [uniq]
  | b :: l => by
    simp only [uniq, List.mem_cons, List.mem_filter, mem_uniq]
    by_cases hab : a = b <;> simp [hab]

theorem nodup_uniq {β : Type} [DecidableEq β] : ∀ {l : List β}, (uniq l).Nodup
  | [] => by simp [uniq]
  | b :: l => by
    simp only [uniq, List.nodup_cons, List.mem_filter]
    exact ⟨by simp, nodup_uniq.filter _⟩

/-! loop's walk -/

-- what loop's while keeps, walking from c: seen is reached from c and made; the stack is a chain
-- down through parents, so its ids fall toward the top; a frame's visited parents are seen; seen
-- off the stack is done: closed under parents, and on iff back
structure inv (h : Array (Made α)) (t : α) (c : Nat) (stack : List (Nat × Nat))
    (seen on : List Nat) : Prop where
  start : c ∈ seen
  stacked : ∀ f ∈ stack, f.1 ∈ seen
  reached : ∀ x ∈ seen, reach h c x
  made : ∀ x ∈ seen, x < h.size
  order : (stack.map Prod.fst).Pairwise (· < ·)
  next : ∀ f ∈ stack, ∀ q ∈ (ps h f.1).take f.2, q ∈ seen
  closed : ∀ x ∈ seen, x ∉ stack.map Prod.fst → ∀ q ∈ ps h x,
    q ∈ seen ∧ q ∉ stack.map Prod.fst
  on : ∀ x, x ∈ on ↔ x ∈ seen ∧ x ∉ stack.map Prod.fst ∧ back h t x

theorem inv_start {h : Array (Made α)} {t : α} {c : Nat} (hc : c < h.size) :
    inv h t c [(c, 0)] [c] [] where
  start := by simp
  stacked := by simp
  reached := by simp; exact .refl c
  made := by simp [hc]
  order := by simp
  next := by simp
  closed := by simp
  on := by simp

theorem inv_nil {h : Array (Made α)} {t : α} {c : Nat} {seen on : List Nat}
    (hi : inv h t c [] seen on) (y : Nat) : y ∈ on ↔ reach h c y ∧ back h t y := by
  have hs : ∀ a b, reach h a b → a ∈ seen → b ∈ seen := by
    intro a b hr
    induction hr with
    | refl => exact id
    | step hq _ ih => exact fun ha => ih (hi.closed _ ha (by simp) _ hq).1
  rw [hi.on y]
  simp only [List.map_nil, List.not_mem_nil, not_false_eq_true, true_and]
  exact ⟨fun ⟨h1, h2⟩ => ⟨hi.reached y h1, h2⟩, fun ⟨h1, h2⟩ => ⟨hs c y h1 hi.start, h2⟩⟩

theorem inv_pop {h : Array (Made α)} {t : α} {c x k : Nat} {rest : List (Nat × Nat)}
    {seen on on' : List Nat} (hw : wf h) (hi : inv h t c ((x, k) :: rest) seen on)
    (hk : ¬ k < (ps h x).length)
    (hon : ∀ y, y ∈ on' ↔ y ∈ on ∨ (y = x ∧ (ofs h x = some t ∨ ∃ q ∈ ps h x, q ∈ on))) :
    inv h t c rest seen on' := by
  have hall : ∀ q ∈ ps h x, q ∈ seen := by
    intro q hq
    exact hi.next (x, k) (by simp) q
      (by show q ∈ (ps h x).take k; rw [List.take_of_length_le (by omega)]; exact hq)
  have hord := hi.order
  simp only [List.map_cons, List.pairwise_cons] at hord
  have hxr : ∀ y ∈ rest.map Prod.fst, x < y := hord.1
  have hlt : ∀ q ∈ ps h x, q < x := hw x
  have hqr : ∀ q ∈ ps h x, q ∉ rest.map Prod.fst := fun q hq hm => by
    have := hxr q hm; have := hlt q hq; omega
  have hxon : x ∉ on := fun hm => ((hi.on x).1 hm).2.1 (by simp)
  refine ⟨hi.start, fun f hf => hi.stacked f (by simp [hf]), hi.reached, hi.made, hord.2,
    fun f hf => hi.next f (by simp [hf]), ?_, ?_⟩
  · intro y hy hyr q hq
    by_cases hyx : y = x
    · subst hyx; exact ⟨hall q hq, hqr q hq⟩
    · have := hi.closed y hy (by simp [hyx, hyr]) q hq
      exact ⟨this.1, fun hm => this.2 (by simp [hm])⟩
  · intro y
    rw [hon y]
    by_cases hyx : y = x
    · subst hyx
      have hxs : y ∈ seen := hi.stacked (y, k) (by simp)
      have hyr : y ∉ rest.map Prod.fst := fun hm => by have := hxr y hm; omega
      simp only [hxon, false_or, true_and, hxs, hyr, not_false_eq_true]
      rw [back_iff (x := y)]
      constructor
      · rintro (h1 | ⟨q, hq, hqon⟩)
        · exact .inl h1
        · exact .inr ⟨q, hq, ((hi.on q).1 hqon).2.2⟩
      · rintro (h1 | ⟨q, hq, hb⟩)
        · exact .inl h1
        · refine .inr ⟨q, hq, (hi.on q).2 ⟨hall q hq, ?_, hb⟩⟩
          simp only [List.map_cons, List.mem_cons, not_or]
          exact ⟨fun e => by have := hlt q hq; omega, hqr q hq⟩
    · simp only [hyx, false_and, or_false]
      rw [hi.on y]
      simp [hyx]

theorem inv_next {h : Array (Made α)} {t : α} {c x k q : Nat} {rest : List (Nat × Nat)}
    {seen on : List Nat} (hi : inv h t c ((x, k) :: rest) seen on)
    (htake : ∀ y ∈ (ps h x).take (k + 1), y ∈ (ps h x).take k ∨ y = q) (hq : q ∈ seen) :
    inv h t c ((x, k + 1) :: rest) seen on := by
  have hm : ((x, k + 1) :: rest).map Prod.fst = ((x, k) :: rest).map Prod.fst := by simp
  refine ⟨hi.start, ?_, hi.reached, hi.made, hm ▸ hi.order, ?_, ?_, ?_⟩
  · intro f hf
    simp only [List.mem_cons] at hf
    rcases hf with rfl | hf
    · exact hi.stacked (x, k) (by simp)
    · exact hi.stacked f (by simp [hf])
  · intro f hf y hy
    simp only [List.mem_cons] at hf
    rcases hf with rfl | hf
    · rcases htake y hy with hy | rfl
      · exact hi.next (x, k) (by simp) y hy
      · exact hq
    · exact hi.next f (by simp [hf]) y hy
  · rw [hm]; exact hi.closed
  · rw [hm]; exact hi.on

theorem inv_push {h : Array (Made α)} {t : α} {c x k q : Nat} {rest : List (Nat × Nat)}
    {seen on : List Nat} (hw : wf h) (hi : inv h t c ((x, k) :: rest) seen on)
    (hqm : q ∈ ps h x)
    (htake : ∀ y ∈ (ps h x).take (k + 1), y ∈ (ps h x).take k ∨ y = q) (hq : q ∉ seen) :
    inv h t c ((q, 0) :: (x, k + 1) :: rest) (q :: seen) on := by
  have hxs : x ∈ seen := hi.stacked (x, k) (by simp)
  have hqx : q < x := hw x q hqm
  have hord := hi.order
  simp only [List.map_cons, List.pairwise_cons] at hord
  refine ⟨List.mem_cons_of_mem _ hi.start, ?_, ?_, ?_, ?_, ?_, ?_, ?_⟩
  · intro f hf
    simp only [List.mem_cons] at hf
    rcases hf with rfl | rfl | hf
    · simp
    · exact List.mem_cons_of_mem _ hxs
    · exact List.mem_cons_of_mem _ (hi.stacked f (by simp [hf]))
  · intro y hy
    simp only [List.mem_cons] at hy
    rcases hy with rfl | hy
    · exact reach_tail (hi.reached x hxs) hqm
    · exact hi.reached y hy
  · intro y hy
    simp only [List.mem_cons] at hy
    rcases hy with rfl | hy
    · have := hi.made x hxs; omega
    · exact hi.made y hy
  · simp only [List.map_cons, List.pairwise_cons, List.mem_cons]
    refine ⟨?_, hord.1, hord.2⟩
    rintro a (rfl | ha)
    · exact hqx
    · have := hord.1 a ha; omega
  · intro f hf y hy
    simp only [List.mem_cons] at hf
    rcases hf with rfl | rfl | hf
    · simp at hy
    · rcases htake y hy with hy | rfl
      · exact List.mem_cons_of_mem _ (hi.next (x, k) (by simp) y hy)
      · simp
    · exact List.mem_cons_of_mem _ (hi.next f (by simp [hf]) y hy)
  · intro y hy hyn p hp
    simp only [List.map_cons, List.mem_cons, not_or] at hyn
    have hy' : y ∈ seen := by
      simp only [List.mem_cons] at hy
      rcases hy with rfl | hy
      · exact absurd rfl hyn.1
      · exact hy
    have := hi.closed y hy' (by simp [hyn.2.1, hyn.2.2]) p hp
    refine ⟨List.mem_cons_of_mem _ this.1, ?_⟩
    simp only [List.map_cons, List.mem_cons, not_or]
    refine ⟨fun e => hq (e ▸ this.1), ?_⟩
    have h2 := this.2
    simp only [List.map_cons, List.mem_cons, not_or] at h2
    exact h2
  · intro y
    rw [hi.on y]
    by_cases hyq : y = q
    · subst hyq; simp [hq]
    · simp [hyq]

theorem walk_spec {h : Array (Made α)} {t : α} {c : Nat} (hw : wf h)
    (stack : List (Nat × Nat)) (seen on : List Nat) (hi : inv h t c stack seen on) (y : Nat) :
    y ∈ walk h t stack seen on ↔ reach h c y ∧ back h t y := by
  have htake : ∀ (l : List Nat) (k : Nat) (hk : k < l.length),
      ∀ y ∈ l.take (k + 1), y ∈ l.take k ∨ y = l[k] := by
    intro l k hk y hy
    rw [List.take_succ_eq_append_getElem hk] at hy
    rcases List.mem_append.mp hy with hy | hy
    · exact .inl hy
    · exact .inr (List.mem_singleton.mp hy)
  fun_induction walk h t stack seen on
  case case1 => exact inv_nil hi y
  case case2 x k rest seen on hk hq ih =>
    exact ih (inv_next hi (htake _ k hk) hq)
  case case3 x k rest seen on hk hq _ ih =>
    exact ih (inv_push hw hi (List.getElem_mem hk) (htake _ k hk) hq)
  case case4 x k rest seen on hk _ hn _ =>
    have hxs : x ∈ seen := hi.stacked (x, k) (by simp)
    have := hi.made x hxs
    have := hw x _ (List.getElem_mem hk)
    omega
  case case5 x k rest seen on hk hc ih =>
    exact ih (inv_pop hw hi hk (fun y => by simp [hc]))
  case case6 x k rest seen on hk hc ih =>
    exact ih (inv_pop hw hi hk (fun y => by simp only [hc, and_false, or_false]))

/-! from's search -/

-- what from's while keeps, searching from the kept causes K for a run of c: seen and the stack are
-- reached from K and made; K is seen or stacked; seen is closed into seen and the stack; none
-- seen is of c
structure sinv (h : Array (Made α)) (c : α) (K stack seen : List Nat) : Prop where
  seenfrom : ∀ x ∈ seen, ∃ k ∈ K, reach h k x
  stackfrom : ∀ x ∈ stack, ∃ k ∈ K, reach h k x
  made : ∀ x ∈ stack, x < h.size
  start : ∀ k ∈ K, k ∈ seen ∨ k ∈ stack
  closed : ∀ x ∈ seen, ∀ q ∈ ps h x, q ∈ seen ∨ q ∈ stack
  none : ∀ x ∈ seen, ofs h x ≠ some c

theorem search_spec {h : Array (Made α)} {c : α} {K : List Nat} (hw : wf h)
    (stack seen : List Nat) (hi : sinv h c K stack seen) :
    search h c stack seen = true ↔ ∃ k ∈ K, back h c k := by
  fun_induction search h c stack seen
  case case1 seen =>
    simp only [Bool.false_eq_true, false_iff, not_exists, not_and]
    have hs : ∀ a b, reach h a b → a ∈ seen → b ∈ seen := by
      intro a b hr
      induction hr with
      | refl => exact id
      | step hq _ ih => exact fun ha => ih (by simpa using hi.closed _ ha _ hq)
    rintro k hk ⟨j, hr, hj⟩
    have hks : k ∈ seen := by simpa using hi.start k hk
    exact hi.none j (hs k j hr hks) hj
  case case2 x rest seen hx ih =>
    refine ih ⟨hi.seenfrom, fun y hy => hi.stackfrom y (by simp [hy]),
      fun y hy => hi.made y (by simp [hy]), ?_, ?_, hi.none⟩
    · intro k hk
      rcases hi.start k hk with h1 | h1
      · exact .inl h1
      · simp only [List.mem_cons] at h1
        rcases h1 with rfl | h1
        · exact .inl hx
        · exact .inr h1
    · intro y hy q hq
      rcases hi.closed y hy q hq with h1 | h1
      · exact .inl h1
      · simp only [List.mem_cons] at h1
        rcases h1 with rfl | h1
        · exact .inl hx
        · exact .inr h1
  case case3 x rest seen _ _ hc =>
    simp only [true_iff]
    obtain ⟨k, hk, hr⟩ := hi.stackfrom x (by simp)
    exact ⟨k, hk, x, hr, hc⟩
  case case4 x rest seen hx hs hc ih =>
    refine ih ⟨?_, ?_, ?_, ?_, ?_, ?_⟩
    · intro y hy
      simp only [List.mem_cons] at hy
      rcases hy with rfl | hy
      · exact hi.stackfrom y (by simp)
      · exact hi.seenfrom y hy
    · intro y hy
      simp only [List.mem_append, List.mem_reverse] at hy
      rcases hy with hy | hy
      · obtain ⟨k, hk, hr⟩ := hi.stackfrom x (by simp)
        exact ⟨k, hk, reach_tail hr hy⟩
      · exact hi.stackfrom y (by simp [hy])
    · intro y hy
      simp only [List.mem_append, List.mem_reverse] at hy
      rcases hy with hy | hy
      · have := hw x y hy; omega
      · exact hi.made y (by simp [hy])
    · intro k hk
      rcases hi.start k hk with h1 | h1
      · exact .inl (List.mem_cons_of_mem _ h1)
      · simp only [List.mem_cons] at h1
        rcases h1 with rfl | h1
        · exact .inl (by simp)
        · exact .inr (by simp [h1])
    · intro y hy q hq
      simp only [List.mem_cons] at hy
      rcases hy with rfl | hy
      · exact .inr (by simp [hq])
      · rcases hi.closed y hy q hq with h1 | h1
        · exact .inl (List.mem_cons_of_mem _ h1)
        · simp only [List.mem_cons] at h1
          rcases h1 with rfl | h1
          · exact .inl (by simp)
          · exact .inr (by simp [h1])
    · intro y hy
      simp only [List.mem_cons] at hy
      rcases hy with rfl | hy
      · exact hc
      · exact hi.none y hy
  case case5 x rest seen _ hs _ =>
    exact absurd (hi.made x (by simp)) hs

/-! Basic's Cause: tree and anc against the heap -/

theorem mem_kids {h : Array (Made α)} {i : Nat} {p : Fin i} : p ∈ kids h i ↔ p.1 ∈ ps h i := by
  unfold kids
  simp only [List.mem_filterMap]
  constructor
  · rintro ⟨a, ha, hs⟩
    split at hs
    · cases hs; exact ha
    · cases hs
  · intro hp
    exact ⟨p.1, hp, by simp⟩

theorem tree_eq {h : Array (Made α)} {i : Nat} {hi : i < h.size} :
    tree h i hi = .mk h[i].of ((kids h i).map fun p => tree h p.1 (Nat.lt_trans p.2 hi)) := by
  rw [tree]

-- under wf, Basic's back of the unfolded cause is back on the heap
theorem back_tree {h : Array (Made α)} {t : α} (hw : wf h) :
    ∀ (i : Nat) (hi : i < h.size), Cause.back t (tree h i hi) = true ↔ back h t i := by
  intro i
  induction i using Nat.strongRecOn with
  | ind i ih =>
    intro hi
    rw [tree_eq, back_iff, ofs_get hi]
    simp [Cause.back]
    apply or_congr Iff.rfl
    constructor
    · rintro ⟨p, hp, hb⟩
      exact ⟨p.1, mem_kids.mp hp, (ih p.1 p.2 _).mp hb⟩
    · rintro ⟨q, hq, hb⟩
      have hqi : q < i := hw i q hq
      exact ⟨⟨q, hqi⟩, mem_kids.mpr hq, (ih q hqi _).mpr hb⟩

-- under wf, what c reaches unfolds into the ancestry of c's tree
theorem anc_tree {h : Array (Made α)} (hw : wf h) {c x : Nat} (hr : reach h c x) :
    ∀ (hc : c < h.size) (hx : x < h.size), anc (tree h c hc) (tree h x hx) := by
  induction hr with
  | refl => intro _ _; exact .refl _
  | @step i q j hq _ ih =>
    intro hc hx
    have hqi : q < i := hw i q hq
    refine .step (p := tree h q (Nat.lt_trans hqi hc)) ?_ (ih _ hx)
    rw [tree_eq]
    simp only [Cause.parents, List.mem_map]
    exact ⟨⟨q, hqi⟩, mem_kids.mpr hq, rfl⟩

-- and the ancestry of c's tree is the unfolding of what c reaches
theorem tree_anc {h : Array (Made α)} {z y : Cause α} (ha : anc z y) :
    ∀ (c : Nat) (hc : c < h.size), z = tree h c hc →
      ∃ x, ∃ hx : x < h.size, reach h c x ∧ y = tree h x hx := by
  induction ha with
  | refl => intro c hc e; exact ⟨c, hc, .refl c, e⟩
  | step hp _ ih =>
    intro c hc e
    subst e
    rw [tree_eq] at hp
    simp only [Cause.parents, List.mem_map] at hp
    obtain ⟨q, hq, rfl⟩ := hp
    obtain ⟨x, hx, hr, rfl⟩ := ih q.1 _ rfl
    exact ⟨x, hx, .step (mem_kids.mp hq) hr, rfl⟩

theorem tree_of {h : Array (Made α)} {x : Nat} (hx : x < h.size) :
    ofs h x = some (tree h x hx).of := by
  rw [ofs_get hx, tree_eq]; rfl


/-! invariants kept by each step -/

theorem ok_create : ok (create : Causes α) where
  wf := by intro x q hq; simp [create, ps] at hq
  kept := by simp [create]
  holding := by simp [create]
  held := by simp [create]
  ranIn := by simp [create]
  heldIn := by simp [create]

theorem ok_run {s : Causes α} {t : α} {parents : List Nat} (ho : ok s)
    (hp : ∀ g ∈ parents, g < s.heap.size) : ok (s.run t parents).1 where
  wf := by
    intro x q hq
    simp only [run, ps_push] at hq
    split at hq
    · rename_i hx; rw [hx]; exact hp q hq
    · exact ho.wf x q hq
  kept := by
    intro u k hk
    simp only [run, Array.size_push] at hk ⊢
    have := ho.kept u k hk; omega
  holding := ho.holding
  held := ho.held
  ranIn := by
    intro u
    simp only [run, upd]
    split
    · exact Nat.le_refl _
    · exact ho.ranIn u
  heldIn := ho.heldIn

theorem ok_keep {s : Causes α} {t : α} {c : Nat} (ho : ok s) (hc : c < s.heap.size) :
    ok (s.keep t c) := by
  unfold keep
  split
  · exact ho
  · dsimp only
    have hk : ∀ u, ∀ k ∈ upd s.kept t (s.kept t ++ [c]) u, k < s.heap.size := by
      intro u k hk
      by_cases hu : u = t
      · subst hu
        simp only [upd_same, List.mem_append, List.mem_singleton] at hk
        rcases hk with hk | rfl
        · exact ho.kept u k hk
        · exact hc
      · rw [upd_ne _ _ hu] at hk; exact ho.kept u k hk
    split
    · rename_i hh
      exact {
        wf := ho.wf
        kept := hk
        holding := by
          intro u hu
          by_cases e : u = t
          · subst e; exact hh
          · dsimp only at hu ⊢; rw [upd_ne _ _ e] at hu; exact ho.holding u hu
        held := ho.held
        ranIn := ho.ranIn
        heldIn := ho.heldIn }
    · exact {
        wf := ho.wf
        kept := hk
        holding := by
          intro u hu
          by_cases e : u = t
          · subst e; simp
          · dsimp only at hu ⊢; rw [upd_ne _ _ e] at hu ⊢; exact ho.holding u hu
        held := by
          intro u hu
          by_cases e : u = t
          · subst e; simp
          · dsimp only at hu ⊢; rw [upd_ne _ _ e] at hu; exact List.mem_append_left _ (ho.held u hu)
        ranIn := ho.ranIn
        heldIn := by
          intro u
          by_cases e : u = t
          · subst e; simp
          · dsimp only; rw [upd_ne _ _ e]; exact ho.heldIn u }

-- 4, all of it: under ok, end empties every kept
theorem end_kept {s : Causes α} (ho : ok s) (u : α) : («end» s).kept u = [] := by
  simp only [«end»]
  split
  · rfl
  · rename_i hu
    by_cases hk : s.kept u = []
    · exact hk
    · exact absurd (ho.held u (ho.holding u hk)) hu

theorem ok_end {s : Causes α} (ho : ok s) : ok («end» s) where
  wf := ho.wf
  kept := by intro u k hk; rw [end_kept ho] at hk; simp at hk
  holding := by intro u hu; exact absurd (end_kept ho u) hu
  held := by
    intro u hu
    have := ho.heldIn u
    simp only [«end»] at hu; omega
  ranIn := by intro u; have := ho.ranIn u; simp only [«end»]; omega
  heldIn := by intro u; have := ho.heldIn u; simp only [«end»]; omega

theorem ok_take {s : Causes α} {t : α} (ho : ok s) : ok (s.take t).1 where
  wf := ho.wf
  kept := by
    intro u k hk
    simp only [take, upd] at hk
    split at hk
    · simp at hk
    · exact ho.kept u k hk
  holding := by
    intro u hu
    simp only [take, upd] at hu
    split at hu
    · exact absurd rfl hu
    · exact ho.holding u hu
  held := ho.held
  ranIn := ho.ranIn
  heldIn := ho.heldIn

theorem ok_restore {s : Causes α} {t : α} {gs : List Nat} (ho : ok s)
    (hg : ∀ g ∈ gs, g < s.heap.size) (hh : gs ≠ [] → s.heldIn t = s.pulse) :
    ok (s.restore t gs) where
  wf := ho.wf
  kept := by
    intro u k hk
    simp only [restore, upd] at hk
    split at hk
    · rename_i e; subst e
      rcases List.mem_append.mp hk with hk | hk
      · exact hg k hk
      · exact ho.kept u k hk
    · exact ho.kept u k hk
  holding := by
    intro u hu
    simp only [restore, upd] at hu
    split at hu
    · rename_i e; subst e
      by_cases hn : gs = []
      · subst hn; exact ho.holding u (by simpa using hu)
      · exact hh hn
    · exact ho.holding u hu
  held := ho.held
  ranIn := ho.ranIn
  heldIn := ho.heldIn

theorem ok_clear {s : Causes α} {t : α} (ho : ok s) : ok (s.clear t) := ok_take (t := t) ho

theorem fresh_create : fresh (create : Causes α) where
  since := by simp [create]
  back := by intro x _ q hq; simp [create, ps] at hq
  ran := by intro x a _ hx; simp [create, ofs] at hx
  kept := by simp [create]

theorem fresh_run {s : Causes α} {t : α} {parents : List Nat} (hf : fresh s)
    (hp : ∀ g ∈ parents, s.since ≤ g) : fresh (s.run t parents).1 where
  since := by simp only [run, Array.size_push]; have := hf.since; omega
  back := by
    intro x hx q hq
    simp only [run, ps_push] at hq ⊢
    split at hq
    · exact hp q hq
    · exact hf.back x hx q hq
  ran := by
    intro x a hx ha
    simp only [run, ofs_push, upd] at ha ⊢
    split at ha
    · cases ha; simp
    · split
      · rfl
      · exact hf.ran x a hx ha
  kept := hf.kept

theorem fresh_keep {s : Causes α} {t : α} {c : Nat} (hf : fresh s) (hc : s.since ≤ c) :
    fresh (s.keep t c) := by
  have hk : ∀ u, ∀ k ∈ upd s.kept t (s.kept t ++ [c]) u, s.since ≤ k := by
    intro u k hk
    by_cases hu : u = t
    · subst hu
      simp only [upd_same, List.mem_append, List.mem_singleton] at hk
      rcases hk with hk | rfl
      · exact hf.kept u k hk
      · exact hc
    · rw [upd_ne _ _ hu] at hk; exact hf.kept u k hk
  unfold keep
  split
  · exact hf
  · dsimp only
    split
    · exact ⟨hf.since, hf.back, hf.ran, hk⟩
    · exact ⟨hf.since, hf.back, hf.ran, hk⟩

theorem fresh_end {s : Causes α} (ho : ok s) : fresh («end» s) where
  since := Nat.le_refl _
  back := by
    intro x hx q hq
    simp only [«end»] at hx hq
    simp [ps, Array.getElem?_eq_none hx] at hq
  ran := by
    intro x a hx ha
    simp only [«end»] at hx ha
    simp [ofs, Array.getElem?_eq_none hx] at ha
  kept := by intro u k hk; rw [end_kept ho] at hk; simp at hk

theorem fresh_take {s : Causes α} {t : α} (hf : fresh s) : fresh (s.take t).1 where
  since := hf.since
  back := hf.back
  ran := hf.ran
  kept := by
    intro u k hk
    simp only [take, upd] at hk
    split at hk
    · simp at hk
    · exact hf.kept u k hk

theorem fresh_restore {s : Causes α} {t : α} {gs : List Nat} (hf : fresh s)
    (hg : ∀ g ∈ gs, s.since ≤ g) : fresh (s.restore t gs) where
  since := hf.since
  back := hf.back
  ran := hf.ran
  kept := by
    intro u k hk
    simp only [restore, upd] at hk
    split at hk
    · rename_i e; subst e
      rcases List.mem_append.mp hk with hk | hk
      · exact hg k hk
      · exact hf.kept u k hk
    · exact hf.kept u k hk

theorem fresh_clear {s : Causes α} {t : α} (hf : fresh s) : fresh (s.clear t) :=
  fresh_take (t := t) hf

-- the states the scheduler drives causes.ts through: what it gives run, keep and restore is made
-- this pulse (scheduler.ts: first gives c.kept; mark keeps causeOf(by), cut to this pulse), and
-- restore gives back in the pulse the given was taken in (finish, in first's pulse or at once
-- after an await: c held then, if it gave anything)
inductive reachable : Causes α → Prop
  | create : reachable create
  | run {s : Causes α} {t : α} {parents : List Nat} : reachable s →
      (∀ g ∈ parents, s.since ≤ g ∧ g < s.heap.size) → reachable (s.run t parents).1
  | keep {s : Causes α} {t : α} {c : Nat} : reachable s → s.since ≤ c → c < s.heap.size →
      reachable (s.keep t c)
  | «end» {s : Causes α} : reachable s → reachable («end» s)
  | take {s : Causes α} {t : α} : reachable s → reachable (s.take t).1
  | restore {s : Causes α} {t : α} {gs : List Nat} : reachable s →
      (∀ g ∈ gs, s.since ≤ g ∧ g < s.heap.size) → (gs ≠ [] → s.heldIn t = s.pulse) →
      reachable (s.restore t gs)
  | clear {s : Causes α} {t : α} : reachable s → reachable (s.clear t)

theorem reachable_ok {s : Causes α} (hr : reachable s) : ok s ∧ fresh s := by
  induction hr with
  | create => exact ⟨ok_create, fresh_create⟩
  | run _ hp ih =>
    exact ⟨ok_run ih.1 fun g hg => (hp g hg).2, fresh_run ih.2 fun g hg => (hp g hg).1⟩
  | keep _ h1 h2 ih => exact ⟨ok_keep ih.1 h2, fresh_keep ih.2 h1⟩
  | «end» _ ih => exact ⟨ok_end ih.1, fresh_end ih.1⟩
  | take _ ih => exact ⟨ok_take ih.1, fresh_take ih.2⟩
  | restore _ hg hh ih =>
    exact ⟨ok_restore ih.1 (fun g h => (hg g h).2) hh, fresh_restore ih.2 (fun g h => (hg g h).1)⟩
  | clear _ ih => exact ⟨ok_clear ih.1, fresh_clear ih.2⟩
/-! what loop, from and end answer -/

theorem loop_none (n : α → Nat) (s : Causes α) (t : α) : loop n s none t = none := rfl

-- loop's on: the causes c reaches that are back to a run of t
theorem loop_on {s : Causes α} {t : α} {c : Nat} (ho : ok s) (hc : c < s.heap.size) (y : Nat) :
    y ∈ walk s.heap t [(c, 0)] [c] [] ↔ reach s.heap c y ∧ back s.heap t y :=
  walk_spec ho.wf _ _ _ (inv_start hc) y

-- 1. loop answers iff t ran this pulse and c is back to a run of t
theorem loop_some {n : α → Nat} {s : Causes α} {t : α} {c : Nat} (ho : ok s)
    (hc : c < s.heap.size) :
    loop n s (some c) t ≠ none ↔ s.ranIn t = s.pulse ∧ Cause.back t (tree s.heap c hc) = true := by
  rw [back_tree ho.wf, ← (loop_on ho hc c).trans (and_iff_right (.refl c))]
  simp only [loop]
  by_cases ht : s.ranIn t = s.pulse <;> by_cases hon : c ∈ walk s.heap t [(c, 0)] [c] [] <;> simp [ht, hon]

-- 2, on the heap: loop's list is the computations of the causes c reaches that are back to a
-- run of t, each once, sorted by n
theorem loop_ids {n : α → Nat} {s : Causes α} {t : α} {c : Nat} {l : List α} (ho : ok s)
    (hc : c < s.heap.size) (hl : loop n s (some c) t = some l) :
    (∀ a, a ∈ l ↔ ∃ x, reach s.heap c x ∧ back s.heap t x ∧ ofs s.heap x = some a) ∧
    l.Nodup ∧ l.Pairwise (fun a b => n a ≤ n b) := by
  simp only [loop] at hl
  split at hl
  · cases hl
  · split at hl
    · cases hl
    · injection hl with hl
      subst hl
      refine ⟨?_, ?_, ?_⟩
      · intro a
        simp only [List.mem_mergeSort, mem_uniq, List.mem_filterMap, loop_on ho hc]
        constructor
        · rintro ⟨x, ⟨h1, h2⟩, h3⟩; exact ⟨x, h1, h2, h3⟩
        · rintro ⟨x, h1, h2, h3⟩; exact ⟨x, ⟨h1, h2⟩, h3⟩
      · exact (List.mergeSort_perm _ _).nodup_iff.mpr nodup_uniq
      · have := List.pairwise_mergeSort (le := fun a b => decide (n a ≤ n b))
          (fun a b c h1 h2 => by simp at *; omega) (fun a b => by simp; omega)
          (uniq (List.filterMap (ofs s.heap) (walk s.heap t [(c, 0)] [c] [])))
        simpa using this

-- 2: loop's list is the computations of the causes x in the ancestry of c with back t x, each
-- once, sorted by n
theorem loop_list {n : α → Nat} {s : Causes α} {t : α} {c : Nat} {l : List α} (ho : ok s)
    (hc : c < s.heap.size) (hl : loop n s (some c) t = some l) :
    (∀ a, a ∈ l ↔ ∃ y, anc (tree s.heap c hc) y ∧ Cause.back t y = true ∧ y.of = a) ∧
    l.Nodup ∧ l.Pairwise (fun a b => n a ≤ n b) := by
  obtain ⟨hm, hn, hp⟩ := loop_ids ho hc hl
  refine ⟨fun a => ?_, hn, hp⟩
  rw [hm a]
  constructor
  · rintro ⟨x, hr, hb, hx⟩
    have hxs := ofs_lt hx
    refine ⟨tree s.heap x hxs, anc_tree ho.wf hr hc hxs, (back_tree ho.wf x hxs).mpr hb, ?_⟩
    rw [tree_of hxs] at hx
    exact Option.some.inj hx
  · rintro ⟨y, ha, hb, rfl⟩
    obtain ⟨x, hx, hr, rfl⟩ := tree_anc ha c hc rfl
    exact ⟨x, hr, (back_tree ho.wf x hx).mp hb, tree_of hx⟩

-- strictly sorted by n, a list is its members
theorem sorted_unique {n : α → Nat} : ∀ {l l' : List α}, l.Pairwise (fun a b => n a < n b) →
    l'.Pairwise (fun a b => n a < n b) → (∀ a, a ∈ l ↔ a ∈ l') → l = l'
  | [], [], _, _, _ => rfl
  | [], b :: _, _, _, hm => absurd ((hm b).mpr (by simp)) (by simp)
  | a :: _, [], _, _, hm => absurd ((hm a).mp (by simp)) (by simp)
  | a :: l, b :: l', h1, h2, hm => by
    rw [List.pairwise_cons] at h1 h2
    have hab : a = b := by
      rcases List.mem_cons.mp ((hm a).mp (by simp)) with e | ha
      · exact e
      · rcases List.mem_cons.mp ((hm b).mpr (by simp)) with e | hb
        · exact e.symm
        · have := h1.1 b hb; have := h2.1 a ha; omega
    subst hab
    have hrest : ∀ x, x ∈ l ↔ x ∈ l' := by
      intro x
      constructor
      · intro hx
        have hne : x ≠ a := fun e => by subst e; have := h1.1 x hx; omega
        rcases List.mem_cons.mp ((hm x).mp (by simp [hx])) with e | h
        · exact absurd e hne
        · exact h
      · intro hx
        have hne : x ≠ a := fun e => by subst e; have := h2.1 x hx; omega
        rcases List.mem_cons.mp ((hm x).mpr (by simp [hx])) with e | h
        · exact absurd e hne
        · exact h
    rw [sorted_unique h1.2 h2.2 hrest]

-- 2, exactly: with distinct n, loop's list is strictly sorted, so the one list with its members
theorem loop_exact {n : α → Nat} {s : Causes α} {t : α} {c : Nat} {l : List α} (ho : ok s)
    (hn : ∀ a b, n a = n b → a = b) (hc : c < s.heap.size) (hl : loop n s (some c) t = some l) :
    l.Pairwise (fun a b => n a < n b) ∧
    ∀ l' : List α, l'.Pairwise (fun a b => n a < n b) →
      (∀ a, a ∈ l' ↔ ∃ y, anc (tree s.heap c hc) y ∧ Cause.back t y = true ∧ y.of = a) →
      l' = l := by
  obtain ⟨hm, hd, hp⟩ := loop_list ho hc hl
  have hs : l.Pairwise (fun a b => n a < n b) := by
    have := hp.and hd
    exact this.imp fun ⟨h1, h2⟩ => Nat.lt_of_le_of_ne h1 (fun e => h2 (hn _ _ e))
  exact ⟨hs, fun l' hs' hm' => sorted_unique hs' hs (fun a => (hm' a).trans (hm a).symm)⟩

-- 3. from: c ran this pulse, and a cause kept on t is back to a run of c
theorem from_iff {s : Causes α} {t c : α} (ho : ok s) :
    «from» s t c = true ↔
      s.ranIn c = s.pulse ∧ ∃ k ∈ s.kept t, ∃ hk : k < s.heap.size, Cause.back c (tree s.heap k hk) = true := by
  have hi : sinv s.heap c (s.kept t) (s.kept t).reverse [] :=
    ⟨by simp, fun x hx => ⟨x, List.mem_reverse.mp hx, .refl x⟩,
      fun x hx => ho.kept t x (List.mem_reverse.mp hx), fun k hk => .inr (List.mem_reverse.mpr hk),
      by simp, by simp⟩
  unfold «from»
  by_cases hc : s.ranIn c = s.pulse
  · simp only [hc, ne_eq, not_true_eq_false, ↓reduceIte, true_and]
    rw [search_spec ho.wf _ _ hi]
    constructor
    · rintro ⟨k, hk, hb⟩
      have hks := ho.kept t k hk
      exact ⟨k, hk, hks, (back_tree ho.wf k hks).mpr hb⟩
    · rintro ⟨k, hk, hks, hb⟩
      exact ⟨k, hk, (back_tree ho.wf k hks).mp hb⟩
  · simp [hc]

-- 4. end: nothing ran in the next pulse, holding empty
theorem end_ran {s : Causes α} (ho : ok s) :
    (∀ u, («end» s).ranIn u ≠ («end» s).pulse) ∧ («end» s).holding = [] := by
  refine ⟨fun u => ?_, rfl⟩
  have := ho.ranIn u
  simp only [«end»]; omega

-- 4. end empties the kept of every computation keep touched since the last end
theorem end_held (s : Causes α) : ∀ u ∈ s.holding, («end» s).kept u = [] := by
  intro u hu; simp [«end», hu]

-- keep touches t: it is held till the end
theorem keep_holds {s : Causes α} (ho : ok s) (t : α) (c : Nat) :
    (s.keep t c).heldIn t = (s.keep t c).pulse ∧ t ∈ (s.keep t c).holding := by
  unfold keep
  split
  · rename_i hl
    have hne : s.kept t ≠ [] := by intro e; rw [e] at hl; simp at hl
    exact ⟨ho.holding t hne, ho.held t (ho.holding t hne)⟩
  · dsimp only
    split
    · rename_i hh; exact ⟨hh, ho.held t hh⟩
    · simp

-- what keep leaves: the heap, since, the pulse and ranIn; one held this pulse stays held
theorem keep_frame (s : Causes α) (t : α) (c : Nat) :
    (s.keep t c).heap = s.heap ∧ (s.keep t c).since = s.since ∧ (s.keep t c).pulse = s.pulse ∧
    (s.keep t c).ranIn = s.ranIn ∧
    (∀ u, s.heldIn u = s.pulse → (s.keep t c).heldIn u = (s.keep t c).pulse) := by
  unfold keep
  split
  · exact ⟨rfl, rfl, rfl, rfl, fun _ h => h⟩
  · dsimp only
    split
    · exact ⟨rfl, rfl, rfl, rfl, fun _ h => h⟩
    · refine ⟨rfl, rfl, rfl, rfl, fun u h => ?_⟩
      by_cases e : u = t
      · subst e; simp
      · simp only [upd_ne _ _ e]; exact h

-- what keep keeps: c at the end of t's kept, unless it is there last already
theorem keep_kept (s : Causes α) (t : α) (c : Nat) (u : α) :
    (s.keep t c).kept u =
      if u = t ∧ (s.kept t).getLast? ≠ some c then s.kept t ++ [c] else s.kept u := by
  unfold keep
  split
  · rename_i h; simp [h]
  · rename_i h
    dsimp only
    split <;> (by_cases e : u = t <;> simp [e, h, upd_ne])

/-! Theorem 7: a loop is a causal cycle in this pulse -/

theorem chain_of {h : Array (Made α)} {P : Nat → Prop} {y j : Nat} (hr : reach h y j)
    (hp : ∀ z, reach h y z → reach h z j → P z) : chain h P y j := by
  induction hr with
  | refl i => exact .here (hp i (.refl i) (.refl i))
  | @step i q j hq hqj ih =>
    exact .next (hp i (.refl i) (.step hq hqj)) hq
      (ih fun z h1 h2 => hp z (.step hq h1) h2)

theorem reach_since {s : Causes α} (hf : fresh s) {c z : Nat} (hs : s.since ≤ c)
    (hr : reach s.heap c z) : s.since ≤ z := by
  induction hr with
  | refl => exact hs
  | step hq _ ih => exact ih (hf.back _ hs _ hq)

theorem chain_last {h : Array (Made α)} {P : Nat → Prop} {x y : Nat} (hc : chain h P x y) :
    P y := by
  induction hc with
  | here hp => exact hp
  | next _ _ _ ih => exact ih

-- for a cause made this pulse, loop's ran check is implied: back to a run of t means t ran
theorem back_ran {s : Causes α} {t : α} {c : Nat} (hf : fresh s) (hs : s.since ≤ c)
    (hb : back s.heap t c) : s.ranIn t = s.pulse := by
  obtain ⟨j, hr, hj⟩ := hb
  exact hf.ran j t (reach_since hf hs hr) hj

-- 5. Theorem 7, of causes: a mark on t by c (made this pulse) that loop answers is a chain of
-- causes from c back to a run of t, every cause on it made this pulse and of a computation in
-- loop's list
theorem loop_chain {n : α → Nat} {s : Causes α} {t : α} {c : Nat} {l : List α} (ho : ok s)
    (hf : fresh s) (hc : c < s.heap.size) (hs : s.since ≤ c)
    (hl : loop n s (some c) t = some l) :
    s.ranIn t = s.pulse ∧ ∃ x, ofs s.heap x = some t ∧ s.since ≤ x ∧
      chain s.heap (fun y => s.since ≤ y ∧ ∃ a ∈ l, ofs s.heap y = some a) c x := by
  have hsome : loop n s (some c) t ≠ none := by simp [hl]
  obtain ⟨ht, hb⟩ := (loop_some ho hc).mp hsome
  obtain ⟨j, hr, hj⟩ := (back_tree ho.wf c hc).mp hb
  have hch : chain s.heap (fun y => s.since ≤ y ∧ ∃ a ∈ l, ofs s.heap y = some a) c j := by
    refine chain_of hr fun z h1 h2 => ⟨reach_since hf hs h1, ?_⟩
    have hz : z < s.heap.size := Nat.lt_of_le_of_lt (reach_le ho.wf h1) hc
    exact ⟨(tree s.heap z hz).of,
      (loop_ids ho hc hl).1 _ |>.mpr ⟨z, h1, ⟨j, h2, hj⟩, tree_of hz⟩, tree_of hz⟩
  exact ⟨ht, j, hj, (chain_last hch).1, hch⟩

end Causes
