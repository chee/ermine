-- LLM generated working output
-- order.ts in Lean: the heap, next, set, and the ranks: made whole once (rank.ts is rk), then
-- mended where an edge changed, only ever rising; a cycle ranked again where it is (local).
--
-- proved:
--   the heap: push_perm, push_heap, pop_perm, pop_heap, pop_least (pop gives a least entry)
--   what order keeps (inv: good, ok, counted, nodup, stamped) from init (inv_init) through set,
--     delete, next with first's delete, started, sees, waits, gone: inv_set, inv_delete, inv_next,
--     inv_started, inv_sees, inv_waits, inv_gone. ok: whenever ranks are there, every one fine
--     (along lk no rank rises, one leaving a component falls: Basic.lean's ranked, ranked_of) and
--     every one on a cycle a member
--   local_inv: when what is not fine, and every cycle not of the members, reaches start, local
--     leaves every one fine and the cycles' members (the region is closed under what is after,
--     its components the whole graph's; floors keep the edges leaving it falling)
--   go_inv, mend_inv: mend's loop keeps what is not fine in the work and reaching begun, begun's
--     out of the work strict, every cycle a member's or through begun; done, nothing on a cycle
--     through begun, so all ok (end_ok). edit_inv, inv_gone: a path an edit or a going loses went
--     through p, so p was a member, and local ranks it again; else nothing is lost
--   next: next_least (due, not waiting, at its rank in next's state, least by (rank, mark, n)),
--     next_none, next_ranked (next's ranks ranked over lk, and the ranks before when there),
--     scan_spec; totality (lemma N's core): total, next_total
--
-- the model, and where it departs from order.ts:
--   - arrays are Lists; the heap's three arrays side by side are one list of entries; (i - 1) >> 1
--     is (i - 1) / 2; an edge of the heap is index j + 1 to j / 2
--   - push's and pop's while loops are up and down, recursive, with the code's hole: heap[i] is
--     written, the entry to place goes in last. pop on an empty heap gives none
--   - next's while loop is scan, recursive; its for loops are folds; best! on undefined throws:
--     next gives none. all() is all, a List given to next, sees, waits and gone
--   - mend's loop is go, its stack a list with its top first (js: an array, its top last); its fuel
--     is the steps left (limit + 1): out of steps with work left, no ranks, as the code. begun is
--     the work mend is given (a Set: membership only)
--   - local's region: rounds of grow over all till none (close), not the code's stack: the same
--     set when all holds every alive one; no repeats (eraseDups, a Set). local pushes the due in
--     the region's order, not rank.ts's map's: the same entries
--   - a computation's fields are functions (update sets one); p.afters, a Map in the order its keys
--     came, is a list of pairs (put, del, get), undefined none; order's ranked is count; members, a
--     Set, is a function
--   - sees' stamp loops: tag stamps each of a list at once (the loop setting a field on each)
--   - p.n, p.state: n, alive (only "alive" is read). started makes p alive and gone not alive: the
--     scheduler sets state in make and dispose just before, with no order call between
--   - rank.ts is rk (Rk): a function of the region (or the alive), its edges and a floor; ranks
--     gives no floor (the code's floor absent: a max with 0). RankOrder.lean's rkf is rank.ts over
--     univ, blind to the order of univ (rankf_same). all() holds every alive one (live), so ranks
--     ranks each, and count is the alive in all (a Set: no repeats)
--   - order.rank(p) (ranks, then rankOf) is not modeled: the scheduler does not call it
--
-- assumed, as hypotheses where used:
--   - set: p alive (the scheduler's due and stop check it), a mark not 0 (ticks start at 1)
--   - started: fresh p (make: a new object, nothing holds it)
--   - sees: next without repeats (the scheduler's seen: one entry per writer per run)
--   - next, sees, waits, gone: all holds every alive one
--   - next_total: following after through the due has no cycle (Quiescence.lean, Lemma N)
--   - of rk: sound on the alive (ranked along its edges, at least its floor). RankOrder.lean proves
--     it of rank.ts (rkf_sound)

import Scheduler.Basic

namespace Order

/-! ## the heap -/

section heap

variable {E : Type}

-- what less must be for a heap: a strict weak order. order.ts's less is one (lexicographic)
structure weak (less : E → E → Bool) : Prop where
  irrefl : ∀ a, less a a = false
  asymm : ∀ a b, less a b = true → less b a = false
  trans : ∀ a b c, less a b = false → less b c = false → less a c = false

-- no entry is less than its parent, (i - 1) >> 1 (order.ts, the heap)
def heap (less : E → E → Bool) (h : List E) : Prop :=
  ∀ j x y, h[j + 1]? = some x → h[j / 2]? = some y → less x y = false

-- push's loop: a hole at i, e to go in it (order.ts, push)
def up (less : E → E → Bool) (e : E) (h : List E) (i : Nat) : List E :=
  if _hi : i = 0 then h.set 0 e else
  match h[(i - 1) / 2]? with
  | some x => if less e x then up less e (h.set i x) ((i - 1) / 2) else h.set i e
  | none => h.set i e
termination_by i
decreasing_by omega

-- order.ts, push
def push (less : E → E → Bool) (h : List E) (e : E) : List E :=
  up less e (h ++ [e]) h.length

-- the smaller child of i and where it is: c, or c + 1 when it is less (order.ts, pop)
def child (less : E → E → Bool) (h : List E) (i : Nat) : Option (Nat × E) :=
  match h[2 * i + 1]?, h[2 * i + 2]? with
  | none, _ => none
  | some a, none => some (2 * i + 1, a)
  | some a, some b => if less b a then some (2 * i + 2, b) else some (2 * i + 1, a)

theorem child_some {less : E → E → Bool} {h : List E} {i c : Nat} {y : E}
    (hc : child less h i = some (c, y)) :
    h[c]? = some y ∧ (c = 2 * i + 1 ∨ c = 2 * i + 2) := by
  unfold child at hc
  split at hc
  · simp at hc
  · simp at hc; obtain ⟨rfl, rfl⟩ := hc; simp_all
  · split at hc <;> simp at hc <;> obtain ⟨rfl, rfl⟩ := hc <;> simp_all

-- pop's loop: a hole at i, last to go in it (order.ts, pop)
def down (less : E → E → Bool) (x : E) (h : List E) (i : Nat) : List E :=
  match _hc : child less h i with
  | none => h.set i x
  | some (c, y) => if less y x then down less x (h.set i y) c else h.set i x
termination_by h.length - i
decreasing_by
  have ⟨h1, h2⟩ := child_some _hc
  have : c < h.length := by
    rcases (List.getElem?_eq_some_iff.mp h1) with ⟨hl, _⟩; exact hl
  simp only [List.length_set]; omega

-- the top, and the heap without it (order.ts, pop)
def pop (less : E → E → Bool) (h : List E) : Option E × List E :=
  match h.getLast? with
  | none => (none, h)
  | some last =>
    let rest := h.dropLast
    (h[0]?, if rest.length = 0 then rest else down less last rest 0)

-- swapping the hole with a place: a permutation
theorem swap {h : List E} {i u : Nat} {x e : E} (hi : i < h.length) (hu : h[u]? = some x)
    (hne : u ≠ i) : ((h.set i x).set u e).Perm (h.set i e) := by
  have hul : u < h.length := (List.getElem?_eq_some_iff.mp hu).1
  have p := List.set_set_perm (as := h.set i e) (i := i) (j := u) (by simpa using hi)
    (by simpa using hul)
  have h1 : (h.set i e)[u]'(by simpa using hul) = x := by
    rw [List.getElem_set]; simp [Ne.symm hne]
    exact (List.getElem?_eq_some_iff.mp hu).2
  have h2 : (h.set i e)[i]'(by simpa using hi) = e := by simp
  rw [h1, h2, List.set_set] at p
  exact p

theorem up_perm {less : E → E → Bool} {e : E} :
    ∀ (i : Nat) (h : List E), i < h.length → (up less e h i).Perm (h.set i e) := by
  intro i
  induction i using Nat.strongRecOn with
  | ind i ih =>
    intro h hi
    rw [up]
    split
    · subst_vars; exact List.Perm.refl _
    · split
      · rename_i x hx
        split
        · have hu : (i - 1) / 2 < i := by omega
          exact (ih _ hu (h.set i x) (by simp; omega)).trans (swap hi hx (by omega))
        · exact List.Perm.refl _
      · exact List.Perm.refl _

theorem push_perm {less : E → E → Bool} {h : List E} {e : E} :
    (push less h e).Perm (h ++ [e]) := by
  unfold push
  have := up_perm (less := less) (e := e) h.length (h ++ [e]) (by simp)
  simpa using this

-- up's promise, the hole at i filled: every edge holds but the hole's own, and the hole's
-- children are not less than its parent
def upok (less : E → E → Bool) (a : List E) (i : Nat) : Prop :=
  (∀ j x y, j + 1 ≠ i → a[j + 1]? = some x → a[j / 2]? = some y → less x y = false) ∧
  (∀ j x y, i ≠ 0 → j / 2 = i → a[j + 1]? = some x → a[(i - 1) / 2]? = some y →
    less x y = false)

theorem up_step {less : E → E → Bool} (w : weak less) {e x : E} {h : List E} {i : Nat}
    (hi0 : i ≠ 0) (hi : i < h.length) (hx : h[(i - 1) / 2]? = some x) (hl : less e x = true)
    (ok : upok less (h.set i e) i) :
    upok less ((h.set i x).set ((i - 1) / 2) e) ((i - 1) / 2) := by
  have ex := w.asymm _ _ hl
  obtain ⟨ok1, ok2⟩ := ok
  constructor
  · intro j x' y' hj hx' hy'
    simp only [List.getElem?_set, List.length_set] at hx' hy' ok1 ok2
    by_cases a : j + 1 = i
    · grind
    · grind [w.trans]
  · intro j x' y' hu0 hj hx' hy'
    have hg := ok1 ((i - 1) / 2 - 1)
    rw [show (i - 1) / 2 - 1 + 1 = (i - 1) / 2 by omega] at hg
    have hj1 := ok1 j
    rw [hj] at hj1
    have := w.trans x' x y'
    by_cases a : j + 1 = i
    · grind
    · grind

theorem up_heap {less : E → E → Bool} (w : weak less) {e : E} :
    ∀ (i : Nat) (h : List E), i < h.length → upok less (h.set i e) i →
      heap less (up less e h i) := by
  intro i
  induction i using Nat.strongRecOn with
  | ind i ih =>
    intro h hi ok
    rw [up]
    split
    · subst_vars; intro j x y hx hy; exact ok.1 j x y (by omega) hx hy
    · rename_i hi0
      split
      · rename_i x hx
        split
        · rename_i hl
          exact ih _ (by omega) (h.set i x) (by simp; omega) (up_step w hi0 hi hx hl ok)
        · rename_i hl
          intro j x' y' hx' hy'
          by_cases a : j + 1 = i
          · subst a; grind
          · exact ok.1 j x' y' a hx' hy'
      · rename_i hn
        exfalso
        have : (i - 1) / 2 < h.length := by omega
        simp [List.getElem?_eq_getElem this] at hn

theorem push_heap {less : E → E → Bool} (w : weak less) {h : List E} {e : E}
    (hh : heap less h) : heap less (push less h e) := by
  unfold push
  apply up_heap w _ _ (by simp)
  simp only [List.set_append_right _ _ (Nat.le_refl _), Nat.sub_self, List.set_cons_zero]
  constructor
  · intro j x y hj hx hy
    have hj' : j + 1 < h.length := by
      have := (List.getElem?_eq_some_iff.mp hx).1; simp at this; omega
    rw [List.getElem?_append_left hj'] at hx
    rw [List.getElem?_append_left (by omega)] at hy
    exact hh j x y hx hy
  · intro j x y _ hj hx
    have := (List.getElem?_eq_some_iff.mp hx).1; simp at this; omega

theorem child_least {less : E → E → Bool} (w : weak less) {h : List E} {i c : Nat} {y : E}
    (hc : child less h i = some (c, y)) :
    ∀ j z, j / 2 = i → h[j + 1]? = some z → less z y = false := by
  intro j z hj hz
  have : j = 2 * i ∨ j = 2 * i + 1 := by omega
  unfold child at hc
  split at hc
  · simp at hc
  · rename_i a ha hb
    simp at hc; obtain ⟨rfl, rfl⟩ := hc
    rcases this with rfl | rfl
    · rw [ha] at hz; cases hz; exact w.irrefl _
    · rw [hb] at hz; cases hz
  · rename_i a b ha hb
    rcases this with rfl | rfl
    · rw [ha] at hz; cases hz
      split at hc <;> simp at hc <;> obtain ⟨rfl, rfl⟩ := hc
      · exact w.asymm _ _ ‹_›
      · exact w.irrefl _
    · rw [hb] at hz; cases hz
      split at hc <;> simp at hc <;> obtain ⟨rfl, rfl⟩ := hc
      · exact w.irrefl _
      · simpa using ‹¬less z a = true›

theorem child_none {less : E → E → Bool} {h : List E} {i : Nat}
    (hc : child less h i = none) : ∀ j, j / 2 = i → h[j + 1]? = none := by
  intro j hj
  have : j = 2 * i ∨ j = 2 * i + 1 := by omega
  unfold child at hc
  split at hc
  · rename_i ha
    have hl : h.length ≤ 2 * i + 1 := by
      rcases Nat.lt_or_ge (2 * i + 1) h.length with l | l
      · simp [List.getElem?_eq_getElem l] at ha
      · exact l
    rcases this with rfl | rfl <;> simp <;> omega
  · simp at hc
  · split at hc <;> simp at hc

theorem down_perm {less : E → E → Bool} {x : E} (h : List E) (i : Nat) :
    i < h.length → (down less x h i).Perm (h.set i x) := by
  fun_induction down less x h i with
  | case1 => intro _; exact List.Perm.refl _
  | case2 h i c y hc _ ih =>
    intro hi
    obtain ⟨hy, hcc⟩ := child_some hc
    have hcl : c < h.length := (List.getElem?_eq_some_iff.mp hy).1
    exact (ih (by simpa using hcl)).trans (swap hi hy (by omega))
  | case3 => intro _; exact List.Perm.refl _

-- down's promise, the hole at i filled: every edge holds but those down from the hole, and the
-- hole's children are not less than its parent
def downok (less : E → E → Bool) (a : List E) (i : Nat) : Prop :=
  (∀ j x y, j / 2 ≠ i → a[j + 1]? = some x → a[j / 2]? = some y → less x y = false) ∧
  (∀ j x y, i ≠ 0 → j / 2 = i → a[j + 1]? = some x → a[(i - 1) / 2]? = some y →
    less x y = false)

theorem down_step {less : E → E → Bool} (w : weak less) {x y : E} {h : List E} {i c : Nat}
    (hc : child less h i = some (c, y)) (hl : less y x = true) (hi : i < h.length)
    (ok : downok less (h.set i x) i) :
    downok less ((h.set i y).set c x) c := by
  obtain ⟨hy, hcc⟩ := child_some hc
  have least := child_least w hc
  have yx := w.asymm _ _ hl
  obtain ⟨ok1, ok2⟩ := ok
  constructor
  · intro j x' y' hj hx' hy'
    by_cases a : j + 1 = c
    · grind
    · by_cases b : j / 2 = i
      · have := least j x'
        grind
      · by_cases d : j + 1 = i
        · have := ok2 (c - 1) x' y'
          rw [show c - 1 + 1 = c by omega, show (c - 1) / 2 = i by omega] at this
          grind
        · have := ok1 j x' y' b
          grind
  · intro j x' y' hc0 hj hx' hy'
    have := ok1 j x' y
    rw [show (c - 1) / 2 = i by omega] at hy'
    grind

theorem down_heap {less : E → E → Bool} (w : weak less) {x : E} (h : List E) (i : Nat) :
    i < h.length → downok less (h.set i x) i → heap less (down less x h i) := by
  fun_induction down less x h i with
  | case1 h i hc =>
    intro hi ok j x' y' hx' hy'
    by_cases b : j / 2 = i
    · have := child_none hc j b
      grind
    · exact ok.1 j x' y' b hx' hy'
  | case2 h i c y hc hl ih =>
    intro hi ok
    obtain ⟨hy, _⟩ := child_some hc
    have hcl : c < h.length := (List.getElem?_eq_some_iff.mp hy).1
    exact ih (by simpa using hcl) (down_step w hc hl hi ok)
  | case3 h i c y hc hl =>
    intro hi ok j x' y' hx' hy'
    by_cases b : j / 2 = i
    · have := child_least w hc j x'
      have := w.trans x' y x
      grind
    · exact ok.1 j x' y' b hx' hy'

-- the top of a heap is not greater than anything in it
theorem heap_top {less : E → E → Bool} (w : weak less) {h : List E} {t : E}
    (hh : heap less h) (ht : h[0]? = some t) :
    ∀ (k : Nat) (z : E), h[k]? = some z → less z t = false := by
  intro k
  induction k using Nat.strongRecOn with
  | ind k ih =>
    intro z hz
    match k with
    | 0 => rw [ht] at hz; cases hz; exact w.irrefl _
    | j + 1 =>
      have hl : j + 1 < h.length := (List.getElem?_eq_some_iff.mp hz).1
      have hp : j / 2 < h.length := by omega
      have hy : h[j / 2]? = some h[j / 2] := List.getElem?_eq_getElem hp
      exact w.trans _ _ _ (hh j z _ hz hy) (ih (j / 2) (by omega) _ hy)

theorem pop_perm {less : E → E → Bool} {h h' : List E} {t : E}
    (hp : pop less h = (some t, h')) : (t :: h').Perm h := by
  unfold pop at hp
  split at hp
  · simp at hp
  · rename_i last hl
    obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.mp hl
    simp only [List.dropLast_concat] at hp
    split at hp
    · rename_i h0
      simp at h0; subst h0
      simp at hp; obtain ⟨rfl, rfl⟩ := hp; exact List.Perm.refl _
    · rename_i h0
      obtain ⟨r, rs, rfl⟩ : ∃ r rs, ys = r :: rs := by
        cases ys with
        | nil => simp at h0
        | cons r rs => exact ⟨r, rs, rfl⟩
      simp at hp; obtain ⟨rfl, rfl⟩ := hp
      have := down_perm (less := less) (x := last) (r :: rs) 0 (by simp)
      simp only [List.set_cons_zero] at this
      refine (List.Perm.cons _ this).trans ?_
      simp only [List.cons_append]
      refine List.Perm.cons _ ?_
      exact List.perm_append_comm (l₁ := [last])

theorem pop_none {less : E → E → Bool} {h h' : List E}
    (hp : pop less h = (none, h')) : h = [] := by
  unfold pop at hp
  split at hp
  · simpa using ‹h.getLast? = none›
  · rename_i last hl
    obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.mp hl
    cases ys <;> simp at hp

theorem pop_length {less : E → E → Bool} {h h' : List E} {t : E}
    (hp : pop less h = (some t, h')) : h'.length < h.length := by
  have := (pop_perm hp).length_eq
  simp at this; omega

theorem pop_heap {less : E → E → Bool} (w : weak less) {h : List E}
    (hh : heap less h) : heap less (pop less h).2 := by
  unfold pop
  split
  · exact hh
  · rename_i last hl
    obtain ⟨ys, rfl⟩ := List.getLast?_eq_some_iff.mp hl
    simp only [List.dropLast_concat]
    split
    · intro j x y hx; simp_all
    · rename_i h0
      apply down_heap w _ _ (by omega)
      constructor
      · intro j x y hj hx hy
        have hj0 : j + 1 ≠ 0 := by omega
        have hj1 : j / 2 ≠ 0 := hj
        simp only [List.getElem?_set, Ne.symm hj0, Ne.symm hj1, ite_false] at hx hy
        have hl1 : j + 1 < ys.length := (List.getElem?_eq_some_iff.mp hx).1
        rw [← List.getElem?_append_left (l₂ := [last]) hl1] at hx
        rw [← List.getElem?_append_left (l₂ := [last]) (by omega)] at hy
        exact hh j x y hx hy
      · intro _ _ _ h; exact absurd rfl h

theorem pop_least {less : E → E → Bool} (w : weak less) {h h' : List E} {t : E}
    (hh : heap less h) (hp : pop less h = (some t, h')) : ∀ z ∈ h, less z t = false := by
  have ht : h[0]? = some t := by
    unfold pop at hp
    split at hp
    · simp at hp
    · simp at hp; exact hp.1
  intro z hz
  obtain ⟨k, hk, rfl⟩ := List.getElem_of_mem hz
  exact heap_top w hh ht k _ (List.getElem?_eq_getElem hk)

end heap
/-! ## the due, the entries, less -/

section order

variable {α : Type} [DecidableEq α]

-- order.ts, Entry
structure Entry (α : Type) where
  p : α
  rank : Nat
  mark : Nat
deriving DecidableEq

-- order.ts, less: by rank, then mark, then the order made (n, p.n)
def less (n : α → Nat) (a b : Entry α) : Bool :=
  if a.rank ≠ b.rank then a.rank < b.rank
  else if a.mark ≠ b.mark then a.mark < b.mark
  else n a.p < n b.p

omit [DecidableEq α] in
theorem less_weak (n : α → Nat) : weak (less n (α := α)) where
  irrefl a := by simp [less]
  asymm a b h := by
    simp only [less] at *
    grind
  trans a b c := by
    simp only [less]
    grind

-- (rank, mark, n) of one before another's
def before (a b : Nat × Nat × Nat) : Prop :=
  a.1 < b.1 ∨ (a.1 = b.1 ∧ (a.2.1 < b.2.1 ∨ (a.2.1 = b.2.1 ∧ a.2.2 < b.2.2)))

omit [DecidableEq α] in
theorem less_false {n : α → Nat} {a b : Entry α} :
    less n a b = false ↔ ¬ before (a.rank, a.mark, n a.p) (b.rank, b.mark, n b.p) := by
  simp only [less, before]
  grind

-- due.get (order.ts, at; has is get's isSome)
def get : List (α × Nat) → α → Option Nat
  | [], _ => none
  | (q, m) :: d, p => if q = p then some m else get d p

-- due.set: in place when there, else at the end (a Map's set)
def put (d : List (α × Nat)) (p : α) (m : Nat) : List (α × Nat) :=
  if d.any (fun x => x.1 = p) then d.map (fun x => if x.1 = p then (p, m) else x)
  else d ++ [(p, m)]

-- due.delete
def del (d : List (α × Nat)) (p : α) : List (α × Nat) :=
  d.filter (fun x => x.1 ≠ p)

theorem get_mem {d : List (α × Nat)} {p : α} {m : Nat} (h : get d p = some m) : (p, m) ∈ d := by
  induction d with
  | nil => simp [get] at h
  | cons x d ih =>
    obtain ⟨q, k⟩ := x
    simp only [get] at h
    split at h
    · cases h; subst_vars; simp
    · exact List.mem_cons_of_mem _ (ih h)

theorem get_put {d : List (α × Nat)} {p q : α} {m : Nat} :
    get (put d p m) q = if p = q then some m else get d q := by
  unfold put
  split
  · rename_i hany
    induction d with
    | nil => simp at hany
    | cons x d ih =>
      obtain ⟨r, k⟩ := x
      simp only [List.map_cons, get]
      by_cases hr : r = p
      · subst hr
        by_cases hq : r = q
        · simp [hq]
        · simp only [ite_true, hq, ite_false]
          clear ih hany
          induction d with
          | nil => simp [get]
          | cons x d ih =>
            obtain ⟨t, j⟩ := x
            simp only [List.map_cons, get]
            by_cases ht : t = r
            · subst ht; simp [hq, ih]
            · simp [ht, ih]
      · simp only [hr, ite_false]
        simp [hr] at hany
        rw [ih (by simpa using hany)]
        by_cases hq : r = q <;> by_cases hp : p = q <;> simp_all
  · rename_i hany
    induction d with
    | nil => simp [get]
    | cons x d ih =>
      obtain ⟨r, k⟩ := x
      simp at hany
      simp only [List.cons_append, get]
      have hr : r ≠ p := hany.1
      rw [ih (by simpa using hany.2)]
      by_cases hq : r = q <;> by_cases hp : p = q <;> simp_all

theorem get_del {d : List (α × Nat)} {p q : α} :
    get (del d p) q = if p = q then none else get d q := by
  unfold del
  induction d with
  | nil => simp [get]
  | cons x d ih =>
    obtain ⟨r, k⟩ := x
    by_cases hr : r = p
    · subst hr
      simp only [ne_eq, not_true_eq_false, decide_false, Bool.false_eq_true,
        not_false_eq_true, List.filter_cons_of_neg, get]
      rw [ih]; split <;> simp_all
    · simp only [ne_eq, hr, not_false_eq_true, decide_true, List.filter_cons_of_pos, get]
      rw [ih]; split <;> split <;> simp_all

end order

/-! ## the order: its state and its calls -/

section state

variable {α : Type} [DecidableEq α]

-- f, with b at a (a field set on one object)
def update {β : Type} (f : α → β) (a : α) (b : β) : α → β := fun x => if x = a then b else f x

-- order's state, and the fields of the computations it reads and writes (order.ts, createOrder)
structure State (α : Type) where
  -- createOrder's own: how many are due; the making now (0: none) and the last; how many the
  -- making ranks (the code's ranked); the members of a component of more than one (a Set); the
  -- stamps given; the heap
  dues : Nat
  making : Nat
  made : Nat
  count : Nat
  members : α → Bool
  stamps : Nat
  heap : List (Entry α)
  -- the scheduler's: p.state === "alive", p.values, p.after
  alive : α → Bool
  values : α → List α
  after : α → Option α
  -- order's own, on each (Ordered): p.due, p.rank, p.ranked, p.afters (a Map in the order its
  -- keys came; undefined is none), p.stamp
  due : α → Nat
  rank : α → Nat
  ranked : α → Nat
  afters : α → Option (List (α × Nat))
  stamp : α → Nat

-- an edge: to another computation, alive (order.ts, edge)
def edge (s : State α) (p q : α) : Bool := q ≠ p && s.alive q

-- what p is after, as a relation (order.ts, edges)
def link (s : State α) (p q : α) : Bool :=
  edge s p q && (q ∈ s.values p || s.after p = some q)

-- order.ts, edges
def edges (s : State α) (p : α) : List α :=
  (s.values p).filter (edge s p) ++ ((s.after p).filter (edge s p)).toList

-- order.ts, rankOf: good while ranked is the making now
def rankOf (s : State α) (p : α) : Nat := if s.ranked p = s.making then s.rank p else 0

-- mend's k: one past the most of what x is after; after nothing, 0 (order.ts, mend)
def top (s : State α) (x : α) : Nat :=
  let k := (s.values x).foldl (fun k q => if edge s x q then max k (rankOf s q + 1) else k) 0
  match s.after x with
  | some a => if edge s x a then max k (rankOf s a + 1) else k
  | none => k

-- how many edges y is after q by, as q.afters counts them (m.get(y) ?? 0)
def cnt (s : State α) (q y : α) : Nat := ((s.afters q).bind fun m => get m y).getD 0

-- p is after q by one more edge (order.ts, link)
def tie (s : State α) (p q : α) : State α :=
  let m := (s.afters q).getD []
  { s with afters := update s.afters q (some (put m p ((get m p).getD 0 + 1))) }

-- p is after q by one less (order.ts, unlink)
def untie (s : State α) (p q : α) : State α :=
  match s.afters q with
  | none => s
  | some m =>
    let k := (get m p).getD 0 - 1
    { s with afters := update s.afters q (some (if k > 0 then put m p k else del m p)) }

-- a Map's keys, in the order they came; undefined: none
def keys (m : Option (List (α × Nat))) : List α := (m.getD []).map Prod.fst

-- order.ts's rank.ts: over the alive B, edges by L, each at least F's (rank's floor); a rank
abbrev Rk (α : Type) := (α → Bool) → (α → α → Bool) → (α → Nat) → α → Nat

-- what is after x, alive among its afters' keys, not yet in R (local's loop, a round of it)
def grow (s : State α) (all R : List α) : List α :=
  all.filter fun y => s.alive y && decide (y ∉ R) && R.any fun x => decide (y ∈ keys (s.afters x))

omit [DecidableEq α] in
theorem filter_le {l : List α} {p q : α → Bool} (h : ∀ x ∈ l, p x = true → q x = true) :
    (l.filter p).length ≤ (l.filter q).length := by
  induction l with
  | nil => simp
  | cons a l ih =>
    have ih := ih fun x hx => h x (List.mem_cons_of_mem _ hx)
    have ha := h a List.mem_cons_self
    simp only [List.filter_cons]
    cases hpa : p a <;> cases hqa : q a <;> simp only [hpa, hqa] at ha ⊢ <;>
      simp only [Bool.false_eq_true, ↓reduceIte, List.length_cons] <;> first | omega | simp at ha

omit [DecidableEq α] in
theorem filter_lt {l : List α} {p q : α → Bool} (h : ∀ x ∈ l, p x = true → q x = true) {y : α}
    (hy : y ∈ l) (hq : q y = true) (hp : p y = false) :
    (l.filter p).length < (l.filter q).length := by
  induction l with
  | nil => cases hy
  | cons a l ih =>
    have h' := fun x hx => h x (List.mem_cons_of_mem _ hx)
    have ha := h a List.mem_cons_self
    simp only [List.filter_cons]
    rcases List.mem_cons.1 hy with rfl | hy
    · have := filter_le h'
      simp only [hp, hq, Bool.false_eq_true, ↓reduceIte, List.length_cons]; omega
    · have := ih h' hy
      cases hpa : p a <;> cases hqa : q a <;> simp only [hpa, hqa] at ha ⊢ <;>
        simp only [Bool.false_eq_true, ↓reduceIte, List.length_cons] <;> first | omega | simp at ha

-- start and everything after it, alive: rounds of grow till none (order.ts, local's stack loop:
-- the same set, found in rounds over all)
def close (s : State α) (all R : List α) : List α :=
  if grow s all R = [] then R else close s all (R ++ grow s all R)
termination_by (all.filter fun y => decide (y ∉ R)).length
decreasing_by
  obtain ⟨y, hy⟩ := List.exists_mem_of_ne_nil _ ‹_›
  simp only [grow, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq] at hy
  apply filter_lt (y := y) _ hy.1 (by simp [hy.2.1.2])
  · simp [grow, List.mem_filter, hy.1, hy.2.1.1, hy.2.1.2, hy.2.2]
  · intro x _ hx; simp only [List.mem_append, not_or, decide_eq_true_eq] at hx ⊢; exact hx.1

-- local's region, no repeats (a Set)
def region (s : State α) (all start : List α) : List α :=
  (close s all (start.filter s.alive)).eraseDups

-- local's floor: one past the most of what p is after outside R (order.ts, local)
def floorOf (s : State α) (R : List α) (p : α) : Nat :=
  (edges s p).foldl (fun k q => if q ∈ R then k else max k (rankOf s q + 1)) 0

-- local's inner: an edge inside R
def inner (s : State α) (R : List α) (p q : α) : Bool :=
  decide (p ∈ R) && link s p q && decide (q ∈ R)

variable (n : α → Nat)

-- order.ts, local: the region ranked again by rank.ts (rk) over its own edges above its floors;
-- each newly ranked counted, each due one pushed at its new rank (in the region's order, not
-- rank.ts's map's: the same entries), its members found again
def «local» (rk : Rk α) (all : List α) (s : State α) (start : List α) : State α :=
  let R := region s all start
  let r := rk (fun p => decide (p ∈ R)) (inner s R) (floorOf s R)
  { s with
    count := s.count + (R.filter fun p => s.ranked p ≠ s.making).length,
    rank := fun p => if p ∈ R then r p else s.rank p,
    ranked := fun p => if p ∈ R then s.making else s.ranked p,
    members := fun p => if p ∈ R then
        (R.any fun q => inner s R p q && r q == r p) || (R.any fun q => inner s R q p && r q == r p)
      else s.members p,
    heap := R.foldl (fun h p => if s.due p ≠ 0 then push (less n) h ⟨p, r p, s.due p⟩ else h)
      s.heap }

-- the heap made again from the due, in all()'s order (order.ts, remake)
def remake (all : List α) (s : State α) : State α :=
  { s with heap := all.foldl (fun h p =>
      if s.due p ≠ 0 then push (less n) h ⟨p, rankOf s p, s.due p⟩ else h) [] }

-- order.ts, ranks: none now, the ranks made whole (rank.ts is rk, no floor), the members found
-- (both ends of an edge between equal ranks), the heap remade
def ranks (rk : Rk α) (all : List α) (s : State α) : State α :=
  if s.making ≠ 0 then s else
  let m := s.made + 1
  let r := rk s.alive (link s) fun _ => 0
  remake n all { s with
    making := m, made := m, count := (all.filter s.alive).length,
    rank := fun p => if s.alive p then r p else s.rank p,
    ranked := fun p => if s.alive p then m else s.ranked p,
    members := fun p => (s.alive p && (edges s p).any fun q => r q == r p) ||
      all.any fun q => s.alive q && decide (p ∈ edges s q) && r q == r p }

-- mend's loop, a stack (its top first), fuel the steps left: a cycle's member, ranked again
-- from the work and begun on (local); one at or past its k, skipped; else it rises to its k, goes
-- in the heap again when due, and what is after it is pushed, unless one of begun is among them
-- (a cycle made now: local from begun). out of steps: made whole at the next (order.ts, mend)
def go (rk : Rk α) (all begun : List α) : Nat → State α → List α → State α
  | _, s, [] => s
  | 0, s, _ :: _ => { s with making := 0 }
  | f + 1, s, x :: rest =>
    if s.alive x = false then go rk all begun f s rest
    else if s.members x then «local» n rk all s (x :: rest ++ begun)
    else if top s x ≤ rankOf s x then go rk all begun f s rest
    else
      let t : State α := { s with
        rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
        heap := if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩ else s.heap }
      if (keys (s.afters x)).any (fun y => decide (y ∈ begun)) then «local» n rk all t begun
      else go rk all begun f t ((keys (s.afters x)).reverse ++ rest)

-- order.ts, mend: no ranks, nothing; else at most a whole making's steps, begun the work
def mend (rk : Rk α) (all : List α) (s : State α) (work : List α) : State α :=
  if s.making = 0 then s else go n rk all work (4 * s.count + 64 + 1) s work

-- a turn of sees' loops: q, unless its stamp is g, tied or untied (op) by p; the flag set on an
-- edge (order.ts, sees)
def loop (op : State α → α → α → State α) (p : α) (g : Nat) (r : State α × Bool) (q : α) :
    State α × Bool :=
  if r.1.stamp q = g then r else (op r.1 p q, r.2 || edge r.1 p q)

-- each of l stamped g, the stamps given now g (order.ts, sees: ++stamps, then the loop)
def tag (s : State α) (l : List α) (g : Nat) : State α :=
  { s with stamps := g, stamp := fun q => if q ∈ l then g else s.stamp q }

-- order.ts, sees: p.values becomes next. the same, in the same order: nothing else. else the old
-- not in next unlinked, the next not in old linked (told apart by stamps), and p mended when an
-- edge changed
def sees (rk : Rk α) (all : List α) (s : State α) (p : α) (next : List α) : State α :=
  let old := s.values p
  let s := { s with values := update s.values p next }
  if old = next then s else
  let r := old.foldl (loop untie p (s.stamps + 1)) (tag s next (s.stamps + 1), false)
  let r := next.foldl (loop tie p (r.1.stamps + 1)) (tag r.1 old (r.1.stamps + 1), r.2)
  if r.2 then mend n rk all r.1 [p] else r.1

-- order.ts, waits: p.after becomes q; p mended when an edge changed
def waits (rk : Rk α) (all : List α) (s : State α) (p : α) (q : Option α) : State α :=
  if s.after p = q then s else
  let r : State α × Bool := match s.after p with
    | some a => (untie s p a, edge s p a)
    | none => (s, false)
  let s := { r.1 with after := update r.1.after p q }
  let r : State α × Bool := match q with
    | some b => (tie s p b, r.2 || edge s p b)
    | none => (s, r.2)
  if r.2 then mend n rk all r.1 [p] else r.1

-- gone's middle: p's edges unlinked, after nothing (order.ts, gone)
def forget (s : State α) (p : α) : State α :=
  let s := (s.values p).foldl (fun s q => untie s p q) s
  let s := { s with values := update s.values p [] }
  let s := match s.after p with
    | some a => untie s p a
    | none => s
  { s with after := update s.after p none }

-- order.ts, gone: not due, after nothing, out of the ranks, out of the members; what was after
-- it keeps its rank, but a cycle's member's afters are ranked again (local). the model makes p
-- not alive here (dispose: state "disposing", just before)
def gone (rk : Rk α) (all : List α) (s : State α) (p : α) : State α :=
  let s := { s with
    alive := update s.alive p false, due := update s.due p 0,
    dues := if s.due p ≠ 0 then s.dues - 1 else s.dues }
  let s := forget s p
  let s := { s with
    count := if s.ranked p = s.making ∧ s.making ≠ 0 then s.count - 1 else s.count,
    ranked := update s.ranked p 0 }
  let m := s.afters p
  let was := s.members p
  let s := { s with afters := update s.afters p none, members := update s.members p false }
  match m with
  | some m => if was then «local» n rk all s (keys (some m)) else s
  | none => s

-- order.ts, started: with ranks, p is ranked 0. the model makes p alive here (make: state
-- "alive")
def started (s : State α) (p : α) : State α :=
  let s := { s with alive := update s.alive p true }
  if s.making = 0 then s else
  { s with rank := update s.rank p 0, ranked := update s.ranked p s.making, count := s.count + 1 }

-- order.ts, set: due at mark; with ranks, its entry pushed at its rank
def set (s : State α) (p : α) (m : Nat) : State α :=
  let s := { s with dues := if s.due p = 0 then s.dues + 1 else s.dues, due := update s.due p m }
  if s.making ≠ 0 then { s with heap := push (less n) s.heap ⟨p, rankOf s p, m⟩ } else s

-- order.ts, delete
def delete (s : State α) (p : α) : State α :=
  if s.due p = 0 then s else { s with dues := s.dues - 1, due := update s.due p 0 }

-- p.after && p.after.due !== 0 (order.ts, next)
def waiting (s : State α) (p : α) : Bool :=
  match s.after p with
  | some a => s.due a ≠ 0
  | none => false

-- an entry not stale: its computation due at its mark, and at its rank (order.ts, next)
def current (s : State α) (e : Entry α) : Bool := s.due e.p = e.mark && rankOf s e.p = e.rank

-- next's while loop: pop till an entry current and not waiting; the waiting put aside. what it
-- gives: the best, the heap, the waiting (order.ts, next)
def scan (s : State α) (h w : List (Entry α)) :
    Option (Entry α) × List (Entry α) × List (Entry α) :=
  match _hp : pop (less n) h with
  | (none, _) => (none, h, w)
  | (some e, h') =>
    if current s e = false then scan s h' w
    else if waiting s e.p then scan s h' (w ++ [e])
    else (some e, h', w)
termination_by h.length
decreasing_by all_goals exact pop_length _hp

-- next up to its loop: the ranks (made whole if none), and the heap remade when stale entries
-- pass four times the due (order.ts, next)
def ready (rk : Rk α) (all : List α) (s : State α) : State α :=
  let s := ranks n rk all s
  if s.heap.length > 4 * s.dues + 64 then remake n all s else s

-- order.ts, next: the computation and its rank; none where best! throws. the waiting go back in
def next (rk : Rk α) (all : List α) (s : State α) :
    Option (α × Nat) × State α :=
  let s := ready n rk all s
  let l := scan n s s.heap []
  (l.1.map fun e => (e.p, e.rank), { s with heap := l.2.2.foldl (push (less n)) l.2.1 })

end state

/-! ## pieces: fields, top, the counts -/

section pieces

variable {α : Type} [DecidableEq α]

@[simp] theorem update_same {β : Type} (f : α → β) (a : α) (b : β) : update f a b a = b := by
  simp [update]

theorem update_ne {β : Type} (f : α → β) {a x : α} (b : β) (h : x ≠ a) : update f a b x = f x := by
  simp [update, h]

theorem update_self {β : Type} (f : α → β) (a : α) : update f a (f a) = f := by
  funext x; simp only [update]; split <;> simp_all

theorem edge_eq {s t : State α} (h : s.alive = t.alive) : edge s = edge t := by
  funext p q; simp [edge, h]

theorem link_alive (s : State α) (x y : α) (h : link s x y = true) : s.alive y = true := by
  simp only [link, edge, Bool.and_eq_true, decide_eq_true_eq] at h
  exact h.1.2

theorem link_ne (s : State α) {x y : α} (h : link s x y = true) : y ≠ x := by
  simp only [link, edge, Bool.and_eq_true, decide_eq_true_eq] at h
  exact h.1.1

-- link reads the alive, values and after only
theorem link_eq {s t : State α} (ha : t.alive = s.alive) (hv : t.values = s.values)
    (hf : t.after = s.after) : link t = link s := by
  funext x y; simp [link, edge, ha, hv, hf]

theorem mem_edges {s : State α} {p q : α} : q ∈ edges s p ↔ link s p q = true := by
  cases ha : s.after p with
  | none => simp [edges, link, ha, and_comm]
  | some a =>
    simp only [edges, link, ha, Option.filter_some, List.mem_append, List.mem_filter,
      Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq, Option.some.injEq]
    split <;> rename_i h <;> simp only [Option.toList_some, Option.toList_none,
      List.mem_singleton, List.not_mem_nil, or_false] <;> constructor
    · rintro (⟨h1, h2⟩ | rfl)
      · exact ⟨h2, .inl h1⟩
      · exact ⟨h, .inr rfl⟩
    · rintro ⟨h1, h2 | rfl⟩
      · exact .inl ⟨h2, h1⟩
      · exact .inr rfl
    · rintro ⟨h1, h2⟩; exact ⟨h2, .inl h1⟩
    · rintro ⟨h1, h2 | rfl⟩
      · exact ⟨h2, h1⟩
      · exact absurd h1 h

-- the fold of max over l from i: at least i and each g q, at most a bound of them, i or a g q
theorem fmax_ge {β : Type} (g : β → Nat) : ∀ (l : List β) (i : Nat),
    i ≤ l.foldl (fun k q => max k (g q)) i ∧ ∀ q ∈ l, g q ≤ l.foldl (fun k q => max k (g q)) i
  | [], i => by simp
  | a :: l, i => by
    simp only [List.foldl_cons, List.mem_cons]
    obtain ⟨h1, h2⟩ := fmax_ge g l (max i (g a))
    refine ⟨by omega, ?_⟩
    rintro q (rfl | hq)
    · omega
    · exact h2 q hq

theorem fmax_le {β : Type} (g : β → Nat) {m : Nat} : ∀ (l : List β) (i : Nat), i ≤ m →
    (∀ q ∈ l, g q ≤ m) → l.foldl (fun k q => max k (g q)) i ≤ m
  | [], i, hi, _ => by simpa using hi
  | a :: l, i, hi, h => by
    simp only [List.foldl_cons]
    exact fmax_le g l _ (by have := h a (by simp); omega) (fun q hq => h q (by simp [hq]))

theorem fmax_cases {β : Type} (g : β → Nat) : ∀ (l : List β) (i : Nat),
    l.foldl (fun k q => max k (g q)) i = i ∨ ∃ q ∈ l, l.foldl (fun k q => max k (g q)) i = g q
  | [], i => by simp
  | a :: l, i => by
    simp only [List.foldl_cons, List.mem_cons]
    rcases fmax_cases g l (max i (g a)) with h | ⟨q, hq, h⟩
    · rw [h]
      by_cases hia : g a ≤ i
      · left; omega
      · right; exact ⟨a, .inl rfl, by omega⟩
    · right; exact ⟨q, .inr hq, h⟩

-- top is the fold over edges (order.ts: the loop over values, then after, each kept by edge)
theorem top_eq (s : State α) (x : α) :
    top s x = (edges s x).foldl (fun k q => max k (rankOf s q + 1)) 0 := by
  simp only [top, edges, List.foldl_append, List.foldl_filter]
  cases s.after x with
  | none => simp
  | some a =>
    simp only [Option.filter_some]
    split <;> simp_all

theorem top_ge {s : State α} {x q : α} (h : link s x q = true) : rankOf s q + 1 ≤ top s x := by
  rw [top_eq]; exact (fmax_ge (fun q => rankOf s q + 1) _ 0).2 q (mem_edges.2 h)

theorem top_le {s : State α} {x : α} {m : Nat} (h : ∀ q, link s x q = true → rankOf s q + 1 ≤ m) :
    top s x ≤ m := by
  rw [top_eq]; exact fmax_le (fun q => rankOf s q + 1) _ 0 (Nat.zero_le _) (fun q hq => h q (mem_edges.1 hq))

theorem top_cases (s : State α) (x : α) :
    top s x = 0 ∨ ∃ q, link s x q = true ∧ top s x = rankOf s q + 1 := by
  rw [top_eq]
  rcases fmax_cases (fun q => rankOf s q + 1) (edges s x) 0 with h | ⟨q, hq, h⟩
  · exact .inl h
  · exact .inr ⟨q, mem_edges.1 hq, h⟩

-- top reads x's links and their ranks only
theorem top_congr {s t : State α} {x : α} (hl : ∀ q, link t x q = link s x q)
    (hr : ∀ q, link s x q = true → rankOf t q = rankOf s q) : top t x = top s x := by
  apply Nat.le_antisymm
  · exact top_le fun q h => by rw [hl] at h; rw [hr q h]; exact top_ge h
  · exact top_le fun q h => by rw [← hr q h]; exact top_ge (by rw [hl]; exact h)

-- r x is one past the most of what x is after along L; after nothing, 0
def tops (L : α → α → Bool) (r : α → Nat) (x : α) : Prop :=
  (∀ y, L x y = true → r y < r x) ∧ (r x = 0 ∨ ∃ y, L x y = true ∧ r x = r y + 1)

theorem top_iff {s : State α} {x : α} : rankOf s x = top s x ↔ tops (link s) (rankOf s) x := by
  constructor
  · intro h
    refine ⟨fun y hy => by have := top_ge hy; omega, ?_⟩
    rcases top_cases s x with e | ⟨y, hy, e⟩
    · exact .inl (by omega)
    · exact .inr ⟨y, hy, by omega⟩
  · rintro ⟨h1, h2⟩
    apply Nat.le_antisymm
    · rcases h2 with e | ⟨y, hy, e⟩
      · omega
      · have := top_ge hy; omega
    · exact top_le fun q hq => h1 q hq

-- the counts

theorem tie_cnt (s : State α) (p q q' y : α) :
    cnt (tie s p q) q' y = cnt s q' y + if q' = q ∧ y = p then 1 else 0 := by
  simp only [cnt, tie, update]
  by_cases h1 : q' = q
  · subst h1
    simp only [ite_true, Option.bind_some, get_put, true_and]
    cases ha : s.afters q' with
    | none => by_cases h2 : p = y <;> simp [h2, Eq.comm (a := y), get]
    | some m => by_cases h2 : p = y <;> simp [h2, Eq.comm (a := y)]
  · simp [h1]

theorem untie_cnt (s : State α) (p q q' y : α) :
    cnt (untie s p q) q' y = if q' = q ∧ y = p then cnt s q' y - 1 else cnt s q' y := by
  unfold untie
  cases ha : s.afters q with
  | none =>
    simp only
    by_cases h1 : q' = q
    · subst h1; simp [cnt, ha]
    · simp [h1]
  | some m =>
    simp only [cnt, update]
    by_cases h1 : q' = q
    · subst h1
      simp only [ite_true, Option.bind_some, ha, true_and]
      split
      · rw [get_put]; by_cases h2 : p = y
        · subst h2; simp
        · simp [h2, Ne.symm h2]
      · rw [get_del]; by_cases h2 : p = y
        · subst h2; simp; omega
        · simp [h2, Ne.symm h2]
    · simp [h1]

theorem untie_eq (s : State α) (p q : α) : ∃ af, untie s p q = { s with afters := af } := by
  unfold untie
  cases s.afters q with
  | none => exact ⟨s.afters, rfl⟩
  | some m => exact ⟨_, rfl⟩

-- counted by one or more: among q's afters' keys
theorem cnt_keys {s : State α} {q y : α} (h : cnt s q y ≠ 0) : y ∈ keys (s.afters q) := by
  unfold cnt at h
  cases ha : s.afters q with
  | none => simp [ha] at h
  | some m =>
    rw [ha] at h
    cases hg : get m y with
    | none => simp [hg] at h
    | some c => exact List.mem_map.2 ⟨(y, c), get_mem hg, rfl⟩

end pieces

section pushes

variable {E β : Type}

theorem pushall_perm {less : E → E → Bool} :
    ∀ (l : List E) (h : List E), (l.foldl (push less) h).Perm (h ++ l)
  | [], h => by simp
  | x :: l, h => by
    simp only [List.foldl_cons]
    refine (pushall_perm l _).trans ?_
    refine ((push_perm (less := less) (h := h) (e := x)).append_right l).trans ?_
    simp

theorem pushall_heap {less : E → E → Bool} (w : weak less) :
    ∀ (l : List E) (h : List E), heap less h → heap less (l.foldl (push less) h)
  | [], _, hh => hh
  | x :: l, h, hh => by
    simp only [List.foldl_cons]
    exact pushall_heap w l _ (push_heap w hh)

-- remake's loop: each one P holds of pushed
theorem pushif_mem {less : E → E → Bool} (P : β → Prop) [DecidablePred P] (f : β → E) {e : E} :
    ∀ (l : List β) (h : List E), e ∈ l.foldl (fun h x => if P x then push less h (f x) else h) h ↔
      e ∈ h ∨ ∃ x ∈ l, P x ∧ e = f x
  | [], h => by simp
  | x :: l, h => by
    simp only [List.foldl_cons]
    rw [pushif_mem P f l]
    have step : e ∈ (if P x then push less h (f x) else h) ↔ e ∈ h ∨ (P x ∧ e = f x) := by
      split
      · rename_i hx
        rw [push_perm.mem_iff]
        simp [hx]
      · rename_i hx
        simp [hx]
    rw [step]
    constructor
    · rintro ((h1 | ⟨h2, h3⟩) | ⟨y, hy, h4⟩)
      · exact .inl h1
      · exact .inr ⟨x, List.mem_cons_self, h2, h3⟩
      · exact .inr ⟨y, List.mem_cons_of_mem _ hy, h4⟩
    · rintro (h1 | ⟨y, hy, h2⟩)
      · exact .inl (.inl h1)
      · rcases List.mem_cons.1 hy with rfl | hy
        · exact .inl (.inr h2)
        · exact .inr ⟨y, hy, h2⟩

theorem pushif_heap {less : E → E → Bool} (w : weak less) (P : β → Prop) [DecidablePred P]
    (f : β → E) : ∀ (l : List β) (h : List E), heap less h →
      heap less (l.foldl (fun h x => if P x then push less h (f x) else h) h)
  | [], _, hh => hh
  | x :: l, h, hh => by
    simp only [List.foldl_cons]
    apply pushif_heap w P f l
    split
    · exact push_heap w hh
    · exact hh

end pushes

/-! ## paths -/

section paths

variable {β : Type} {e e' : β → β → Prop}

theorem tg_mono (h : ∀ a b, e a b → e' a b) {a b : β} (t : Relation.TransGen e a b) :
    Relation.TransGen e' a b := by
  induction t with
  | single x => exact .single (h _ _ x)
  | tail _ x ih => exact .tail ih (h _ _ x)

-- a path's first step, and the rest
theorem tg_head {a b : β} (h : Relation.TransGen e a b) :
    ∃ c, e a c ∧ (c = b ∨ Relation.TransGen e c b) := by
  induction h with
  | single h => exact ⟨_, h, .inl rfl⟩
  | tail _ h2 ih =>
    obtain ⟨c, h1, h3⟩ := ih
    refine ⟨c, h1, .inr ?_⟩
    rcases h3 with rfl | h3
    · exact .single h2
    · exact .tail h3 h2

-- equal, or a path
def reaches (e : β → β → Prop) (a b : β) : Prop := a = b ∨ Relation.TransGen e a b

theorem reaches_cons {a b c : β} (h1 : e a b) (h2 : reaches e b c) : reaches e a c := by
  rcases h2 with rfl | h2
  · exact .inr (.single h1)
  · exact .inr (Relation.TransGen.trans (.single h1) h2)

theorem reaches_trans {a b c : β} (h1 : reaches e a b) (h2 : reaches e b c) : reaches e a c := by
  rcases h1 with rfl | h1
  · exact h2
  · rcases h2 with rfl | h2
    · exact .inr h1
    · exact .inr (h1.trans h2)

-- e and e' the same but out of p: a path of e is one of e', or reaches p first (along e')
theorem cut (p : β) (he : ∀ a c, e a c → a ≠ p → e' a c) {a b : β}
    (h : Relation.TransGen e a b) : reaches e' a p ∨ Relation.TransGen e' a b := by
  induction h with
  | single h =>
    rename_i c
    by_cases ha : a = p
    · exact .inl (.inl ha)
    · exact .inr (.single (he _ _ h ha))
  | tail _ h ih =>
    rename_i b' c _
    rcases ih with ih | ih
    · exact .inl ih
    · by_cases hb : b' = p
      · subst hb; exact .inl (.inr ih)
      · exact .inr (.tail ih (he _ _ h hb))

-- so a path to p reaches it along e'
theorem hit (p : β) (he : ∀ a c, e a c → a ≠ p → e' a c) {a : β} (h : reaches e a p) :
    reaches e' a p := by
  rcases h with rfl | h
  · exact .inl rfl
  · rcases cut p he h with h | h
    · exact h
    · exact .inr h

-- a path of e is one of e', or goes through p: reaches p, then on from p along e
theorem split (p : β) (he : ∀ a c, e a c → a ≠ p → e' a c) (he' : ∀ a c, e' a c → a ≠ p → e a c)
    {a b : β} (h : Relation.TransGen e a b) :
    Relation.TransGen e' a b ∨ (reaches e a p ∧ Relation.TransGen e p b) := by
  induction h with
  | single h =>
    rename_i c
    by_cases ha : a = p
    · subst ha; exact .inr ⟨.inl rfl, .single h⟩
    · exact .inl (.single (he _ _ h ha))
  | tail _ h ih =>
    rename_i b' c _
    rcases ih with ih | ⟨r, t⟩
    · by_cases hb : b' = p
      · subst hb
        exact .inr ⟨hit _ he' (.inr ih), .single h⟩
      · exact .inl (.tail ih (he _ _ h hb))
    · exact .inr ⟨r, .tail t h⟩

-- e' within e but for p, nothing going to p along e': a path of e from one other than p is one of
-- e', or reaches p first along e' (its last step one of e) and goes on from p
theorem thru (p : β) (he : ∀ a c, e a c → a ≠ p → c ≠ p → e' a c) (hp : ∀ a, ¬ e' a p) {a b : β}
    (h : Relation.TransGen e a b) (ha : a ≠ p) :
    Relation.TransGen e' a b ∨ ((∃ z, reaches e' a z ∧ e z p) ∧ reaches e p b) := by
  induction h with
  | single h =>
    rename_i c
    by_cases hc : c = p
    · subst hc; exact .inr ⟨⟨a, .inl rfl, h⟩, .inl rfl⟩
    · exact .inl (.single (he _ _ h ha hc))
  | tail _ h ih =>
    rename_i b' c _
    rcases ih with ih | ⟨w, r⟩
    · have hb' : b' ≠ p := by
        rintro rfl
        cases ih with
        | single h' => exact hp _ h'
        | tail _ h' => exact hp _ h'
      by_cases hc : c = p
      · subst hc; exact .inr ⟨⟨b', .inr ih, h⟩, .inl rfl⟩
      · exact .inl (.tail ih (he _ _ h hb' hc))
    · exact .inr ⟨w, reaches_trans r (.inr (.single h))⟩

end paths

/-! ## the promises, and mend -/

section mend

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- the heap's promise: a heap, of marks not 0; the due alive; with ranks, every due p's entry at
-- its mark and its rank now (stale entries are skipped by next, so any may stay)
def good (s : State α) : Prop :=
  heap (less n) s.heap ∧ (∀ e ∈ s.heap, e.mark ≠ 0) ∧ (∀ p, s.due p ≠ 0 → s.alive p = true) ∧
  (s.making ≠ 0 → ∀ p, s.due p ≠ 0 → (⟨p, rankOf s p, s.due p⟩ : Entry α) ∈ s.heap)

-- afters counts what is after each alive one: by its values, and by after (order.ts, link)
def counted (s : State α) : Prop :=
  ∀ q, s.alive q = true → ∀ y, cnt s q y =
    (if q ∈ s.values y then 1 else 0) + (if s.after y = some q then 1 else 0)

-- an edge of an alive one: what the ranks are ranked over
def lk (s : State α) (x y : α) : Bool := s.alive x && link s x y

-- a path along lk
def path (s : State α) : α → α → Prop := Relation.TransGen fun a b => lk s a b = true

-- x's edges as Basic.lean's ranked wants them: none to a rank above, one leaving x's component to
-- one below
def fine (s : State α) (x : α) : Prop :=
  ∀ y, lk s x y = true → rankOf s y ≤ rankOf s x ∧ (¬ path s y x → rankOf s y < rankOf s x)

-- with ranks: every one fine, and every one on a cycle a member
def ok (s : State α) : Prop :=
  s.making ≠ 0 → (∀ x, fine s x) ∧ ∀ x, path s x x → s.members x = true

-- what order keeps: the heap's promise, the ranks ranked (and the cycles' members), afters counted,
-- values without repeats, stamps not ahead of the count
structure inv (s : State α) : Prop where
  good : good n s
  ok : ok s
  counted : counted s
  nodup : ∀ x, (s.values x).Nodup
  stamped : ∀ q, s.stamp q ≤ s.stamps

-- what order needs of rank.ts (as rk), on any B among the alive A, L going among B: along L no
-- rank rises, one leaving a component falls; and each at least its floor. RankOrder.lean proves
-- both of rank.ts (rkf_sound)
structure sound (rk : Rk α) (A : α → Bool) : Prop where
  ranked : ∀ (B : α → Bool) (L : α → α → Bool) (F : α → Nat), (∀ x, B x = true → A x = true) →
    (∀ x y, L x y = true → B y = true) → ∀ x y, B x = true → L x y = true →
      rk B L F y ≤ rk B L F x ∧
        (¬ Relation.TransGen (fun a b => L a b = true) y x → rk B L F y < rk B L F x)
  floor : ∀ (B : α → Bool) (L : α → α → Bool) (F : α → Nat), (∀ x, B x = true → A x = true) →
    (∀ x y, L x y = true → B y = true) → ∀ x, B x = true → F x ≤ rk B L F x

-- along L the ranks never rise
omit [DecidableEq α] in
theorem sound_path {rk : Rk α} {A B : α → Bool} {L : α → α → Bool} {F : α → Nat}
    (hk : sound rk A) (hB : ∀ x, B x = true → A x = true) (hc : ∀ x y, L x y = true → B y = true)
    {a b : α} (ha : B a = true) (h : Relation.TransGen (fun a b => L a b = true) a b) :
    rk B L F b ≤ rk B L F a := by
  induction h with
  | single h => exact (hk.ranked B L F hB hc _ _ ha h).1
  | tail t h ih =>
    rename_i b' c
    have hb : B b' = true := by
      rcases tg_head t with ⟨_, _, rfl | t'⟩
      · exact hc _ _ ‹_›
      · obtain ⟨d, hd⟩ : ∃ d, L d b' = true := by
          cases t' with
          | single h' => exact ⟨_, h'⟩
          | tail _ h' => exact ⟨_, h'⟩
        exact hc _ _ hd
    exact Nat.le_trans (hk.ranked B L F hB hc _ _ hb h).1 ih

-- so the ranks are Basic.lean's ranked over lk
theorem ranked_of {s : State α} (h : ok s) (hm : s.making ≠ 0) :
    _root_.ranked (fun x y => lk s x y = true) (rankOf s) :=
  fun x y hxy => (h hm).1 x y hxy

theorem lk_eq {s t : State α} (ha : t.alive = s.alive) (hv : t.values = s.values)
    (hf : t.after = s.after) : lk t = lk s := by
  funext x y; simp [lk, link_eq ha hv hf, ha]

theorem lk_link {s : State α} {x y : α} (h : lk s x y = true) : link s x y = true := by
  simp only [lk, Bool.and_eq_true] at h; exact h.2

theorem lk_alive {s : State α} {x y : α} (h : lk s x y = true) :
    s.alive x = true ∧ s.alive y = true := by
  simp only [lk, Bool.and_eq_true] at h; exact ⟨h.1, link_alive s x y h.2⟩

theorem lk_ne {s : State α} {x y : α} (h : lk s x y = true) : y ≠ x := link_ne s (lk_link h)

theorem path_alive {s : State α} {x y : α} (h : path s x y) :
    s.alive x = true ∧ s.alive y = true := by
  obtain ⟨c, hc, _⟩ := tg_head h
  refine ⟨(lk_alive hc).1, ?_⟩
  cases h with
  | single h => exact (lk_alive h).2
  | tail _ h => exact (lk_alive h).2

theorem not_fine {s : State α} {x : α} (h : ¬ fine s x) : s.alive x = true := by
  cases hx : s.alive x with
  | true => rfl
  | false => exact absurd (fun y hy => by simp [lk, hx] at hy) h

theorem fine_of {s : State α} {x : α} (h : ∀ y, lk s x y = true → rankOf s y < rankOf s x) :
    fine s x := fun y hy => ⟨Nat.le_of_lt (h y hy), fun _ => h y hy⟩

-- along a path of the fine the ranks never rise
theorem fine_path {s : State α} (hf : ∀ x, fine s x) {a b : α} (h : path s a b) :
    rankOf s b ≤ rankOf s a := by
  induction h with
  | single h => exact (hf _ _ h).1
  | tail _ h ih => exact Nat.le_trans (hf _ _ h).1 ih

-- one after x, among x's afters' keys
theorem link_keys {s : State α} (hc : counted s) {x y : α} (h : link s y x = true) :
    y ∈ keys (s.afters x) := by
  apply cnt_keys
  rw [hc x (link_alive s y x h) y]
  simp only [link, Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq] at h
  rcases h.2 with h2 | h2 <;> simp [h2]

/-! the region -/

theorem close_spec (s : State α) (all : List α) : ∀ (k : Nat) (R : List α),
    (all.filter fun y => decide (y ∉ R)).length < k → (∀ y ∈ R, s.alive y = true) →
    (∀ y ∈ R, y ∈ close s all R) ∧ (∀ y ∈ close s all R, s.alive y = true) ∧
      ∀ x ∈ close s all R, ∀ y ∈ all, s.alive y = true → y ∈ keys (s.afters x) →
        y ∈ close s all R := by
  intro k
  induction k with
  | zero => intro R h; exact absurd h (Nat.not_lt_zero _)
  | succ k ih =>
    intro R hk hR
    rw [close]
    split
    · rename_i hg
      refine ⟨fun y hy => hy, hR, fun x hx y hy ha hk' => ?_⟩
      refine Classical.byContradiction fun hn => ?_
      have : y ∈ grow s all R := by
        simp only [grow, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq, List.any_eq_true]
        exact ⟨hy, ⟨ha, hn⟩, x, hx, hk'⟩
      rw [hg] at this; cases this
    · rename_i hg
      obtain ⟨y, hy⟩ := List.exists_mem_of_ne_nil _ hg
      have hy' := hy
      simp only [grow, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq] at hy'
      have lt : (all.filter fun z => decide (z ∉ R ++ grow s all R)).length <
          (all.filter fun z => decide (z ∉ R)).length := by
        apply filter_lt (y := y) _ hy'.1 (by simp [hy'.2.1.2])
        · simp [hy]
        · intro x _ hx; simp only [List.mem_append, not_or, decide_eq_true_eq] at hx ⊢; exact hx.1
      have hR' : ∀ z ∈ R ++ grow s all R, s.alive z = true := by
        intro z hz
        rcases List.mem_append.1 hz with hz | hz
        · exact hR z hz
        · simp only [grow, List.mem_filter, Bool.and_eq_true] at hz; exact hz.2.1.1
      obtain ⟨i1, i2, i3⟩ := ih (R ++ grow s all R) (by omega) hR'
      exact ⟨fun z hz => i1 z (List.mem_append_left _ hz), i2, i3⟩

theorem region_spec (s : State α) (all start : List α) :
    (∀ y ∈ start, s.alive y = true → y ∈ region s all start) ∧
      (∀ y ∈ region s all start, s.alive y = true) ∧
      ∀ x ∈ region s all start, ∀ y ∈ all, s.alive y = true → y ∈ keys (s.afters x) →
        y ∈ region s all start := by
  obtain ⟨i1, i2, i3⟩ := close_spec s all _ (start.filter s.alive) (Nat.lt_succ_self _)
    (fun y hy => (List.mem_filter.1 hy).2)
  refine ⟨fun y hy ha => ?_, fun y hy => i2 y (List.mem_eraseDups.1 hy), fun x hx y hy ha hk => ?_⟩
  · exact List.mem_eraseDups.2 (i1 y (List.mem_filter.2 ⟨hy, ha⟩))
  · exact List.mem_eraseDups.2 (i3 x (List.mem_eraseDups.1 hx) y hy ha hk)

-- what is after one of the region, alive, is in it
theorem region_back {s : State α} {all start : List α} (hc : counted s)
    (hall : ∀ p, s.alive p = true → p ∈ all) {x y : α} (hx : x ∈ region s all start)
    (h : lk s y x = true) : y ∈ region s all start := by
  obtain ⟨-, i2, i3⟩ := region_spec s all start
  have ha := lk_alive h
  exact i3 x hx y (hall y ha.1) ha.1 (link_keys hc (lk_link h))

theorem region_reach {s : State α} {all start : List α} (hc : counted s)
    (hall : ∀ p, s.alive p = true → p ∈ all) {x b : α} (hb : b ∈ start) (hx : s.alive x = true)
    (h : reaches (fun a b => lk s a b = true) x b) : x ∈ region s all start := by
  obtain ⟨i1, -, -⟩ := region_spec s all start
  rcases h with rfl | h
  · exact i1 x hb hx
  · have hbr : b ∈ region s all start := i1 b hb (path_alive h).2
    suffices ∀ c, path s x c → c ∈ region s all start → x ∈ region s all start from this b h hbr
    intro c hp
    induction hp with
    | single h => exact fun hc' => region_back hc hall hc' h
    | tail _ h ih => exact fun hc' => ih (region_back hc hall hc' h)

-- a path to one of the region is one along its inner edges
theorem region_inner {s : State α} {all start : List α} (hc : counted s)
    (hall : ∀ p, s.alive p = true → p ∈ all) {a b : α} (h : path s a b)
    (hb : b ∈ region s all start) :
    Relation.TransGen (fun x y => inner s (region s all start) x y = true) a b := by
  induction h with
  | single h =>
    have ha := region_back hc hall hb h
    exact .single (by simp [inner, ha, hb, lk_link h])
  | tail _ h ih =>
    have hb' := region_back hc hall hb h
    exact .tail (ih hb') (by simp [inner, hb', hb, lk_link h])

theorem floor_ge (s : State α) (R : List α) {p q : α} (h : link s p q = true) (hq : q ∉ R) :
    rankOf s q + 1 ≤ floorOf s R p := by
  have e : floorOf s R p =
      (edges s p).foldl (fun k q => max k (if q ∈ R then 0 else rankOf s q + 1)) 0 := by
    unfold floorOf
    congr 1
    funext k q
    split <;> simp
  rw [e]
  have := (fmax_ge (fun q => if q ∈ R then 0 else rankOf s q + 1) (edges s p) 0).2 q
    (mem_edges.2 h)
  simpa [hq] using this

/-! local -/

theorem local_eq (rk : Rk α) (all : List α) (s : State α) (start : List α) :
    ∃ cn rk' rd mb hp, «local» n rk all s start =
      { s with count := cn, rank := rk', ranked := rd, members := mb, heap := hp } :=
  ⟨_, _, _, _, _, rfl⟩

-- local: when everything not fine, and every cycle not of the members, reaches start, the ranks
-- are fine and the cycles members after, the heap's promise kept
theorem local_inv {rk : Rk α} {all : List α} {s : State α} {start : List α}
    (hk : sound rk s.alive) (hall : ∀ p, s.alive p = true → p ∈ all) (hg : good n s)
    (hc : counted s)
    (hV : s.making ≠ 0 → ∀ x, ¬ fine s x →
      ∃ b ∈ start, reaches (fun a b => lk s a b = true) x b)
    (hC : s.making ≠ 0 → ∀ x, path s x x → s.members x = true ∨
      ∃ b ∈ start, reaches (fun a b => lk s a b = true) x b) :
    good n («local» n rk all s start) ∧ ok («local» n rk all s start) := by
  obtain ⟨-, rA, -⟩ := region_spec s all start
  generalize hR : region s all start = R at rA
  have back : ∀ {x y}, x ∈ R → lk s y x = true → y ∈ R := fun hx h =>
    hR ▸ region_back hc hall (hR ▸ hx) h
  have reachR : ∀ {x b}, b ∈ start → s.alive x = true →
      reaches (fun a b => lk s a b = true) x b → x ∈ R := fun hb hx h =>
    hR ▸ region_reach hc hall hb hx h
  have innerR : ∀ {a b}, path s a b → b ∈ R →
      Relation.TransGen (fun x y => inner s R x y = true) a b := fun h hb =>
    hR ▸ region_inner hc hall h (hR ▸ hb)
  let B := fun p => decide (p ∈ R)
  have hB : ∀ x, B x = true → s.alive x = true := fun x hx => rA x (by simpa [B] using hx)
  have hcL : ∀ x y, inner s R x y = true → B y = true := by
    intro x y h; simp only [inner, Bool.and_eq_true, decide_eq_true_eq] at h; simp [B, h.2]
  generalize hr : rk B (inner s R) (floorOf s R) = r
  have rk1 := hk.ranked B (inner s R) (floorOf s R) hB hcL
  have rk2 := hk.floor B (inner s R) (floorOf s R) hB hcL
  rw [hr] at rk1 rk2
  have innerlk : ∀ a b, inner s R a b = true → lk s a b = true := by
    intro a b h
    simp only [inner, Bool.and_eq_true, decide_eq_true_eq] at h
    simp [lk, rA a h.1.1, h.1.2]
  have rpath : ∀ {a b}, a ∈ R → Relation.TransGen (fun x y => inner s R x y = true) a b →
      r b ≤ r a := by
    intro a b ha h
    rw [← hr]; exact sound_path hk hB hcL (by simp [B, ha]) h
  have ht : «local» n rk all s start = { s with
      count := s.count + (R.filter fun p => s.ranked p ≠ s.making).length,
      rank := fun p => if p ∈ R then r p else s.rank p,
      ranked := fun p => if p ∈ R then s.making else s.ranked p,
      members := fun p => if p ∈ R then
          (R.any fun q => inner s R p q && r q == r p) ||
            (R.any fun q => inner s R q p && r q == r p)
        else s.members p,
      heap := R.foldl (fun h p => if s.due p ≠ 0 then push (less n) h ⟨p, r p, s.due p⟩ else h)
        s.heap } := by
    unfold «local»; rw [hR]; subst hr; rfl
  rw [ht]
  generalize hu : ({ s with
      count := s.count + (R.filter fun p => s.ranked p ≠ s.making).length,
      rank := fun p => if p ∈ R then r p else s.rank p,
      ranked := fun p => if p ∈ R then s.making else s.ranked p,
      members := fun p => if p ∈ R then
          (R.any fun q => inner s R p q && r q == r p) ||
            (R.any fun q => inner s R q p && r q == r p)
        else s.members p,
      heap := R.foldl (fun h p => if s.due p ≠ 0 then push (less n) h ⟨p, r p, s.due p⟩ else h)
        s.heap } : State α) = t
  have tm : t.making = s.making := by rw [← hu]
  have tl : lk t = lk s := by rw [← hu]; exact lk_eq rfl rfl rfl
  have tp : path t = path s := by unfold path; rw [tl]
  have tr : ∀ p, rankOf t p = if p ∈ R then r p else rankOf s p := by
    intro p; rw [← hu]; by_cases hp : p ∈ R <;> simp [rankOf, hp]
  have tmb : ∀ p, p ∉ R → t.members p = s.members p := by
    intro p hp; rw [← hu]; simp [hp]
  have theap : ∀ e, e ∈ t.heap ↔ e ∈ s.heap ∨ ∃ p ∈ R, s.due p ≠ 0 ∧ e = ⟨p, r p, s.due p⟩ := by
    intro e; rw [← hu]
    exact pushif_mem (less := less n) (fun p => s.due p ≠ 0) (fun p => ⟨p, r p, s.due p⟩) R s.heap
  obtain ⟨g1, g2, g3, g4⟩ := hg
  refine ⟨⟨?_, ?_, ?_, ?_⟩, ?_⟩
  · rw [← hu]
    exact pushif_heap (less_weak n) (fun p => s.due p ≠ 0) (fun p => ⟨p, r p, s.due p⟩) R s.heap g1
  · intro e he
    rcases (theap e).1 he with he | ⟨p, -, hp, rfl⟩
    · exact g2 e he
    · exact hp
  · intro p hp; rw [← hu] at hp ⊢; exact g3 p hp
  · intro hm p hp
    have hp' : s.due p ≠ 0 := by rw [← hu] at hp; exact hp
    have hd : t.due p = s.due p := by rw [← hu]
    rw [hd, tr]
    by_cases hpR : p ∈ R
    · simp only [hpR, ↓reduceIte]; exact (theap _).2 (.inr ⟨p, hpR, hp', rfl⟩)
    · simp only [hpR, ↓reduceIte]; exact (theap _).2 (.inl (g4 (by rwa [← tm]) p hp'))
  · intro hm
    have hm' : s.making ≠ 0 := by rwa [← tm]
    refine ⟨fun x => ?_, fun x hx => ?_⟩
    · intro y hy
      rw [tl] at hy
      rw [tp, tr, tr]
      by_cases hxR : x ∈ R
      · simp only [hxR, ↓reduceIte]
        by_cases hyR : y ∈ R
        · simp only [hyR, ↓reduceIte]
          have hi : inner s R x y = true := by simp [inner, hxR, hyR, lk_link hy]
          obtain ⟨h1, h2⟩ := rk1 x y (by simp [B, hxR]) hi
          exact ⟨h1, fun hn => h2 fun t' => hn (tg_mono innerlk t')⟩
        · simp only [hyR, ↓reduceIte]
          have := floor_ge s R (lk_link hy) hyR
          have := rk2 x (by simp [B, hxR])
          exact ⟨by omega, fun _ => by omega⟩
      · have hyR : y ∉ R := fun hyR => hxR (back hyR hy)
        simp only [hxR, hyR, ↓reduceIte]
        refine Classical.byContradiction fun hn => ?_
        have hf : ¬ fine s x := fun hf => hn (hf y hy)
        obtain ⟨b, hb, hr'⟩ := hV hm' x hf
        exact hxR (reachR hb (not_fine hf) hr')
    · rw [tp] at hx
      by_cases hxR : x ∈ R
      · obtain ⟨c, hxc, hc'⟩ := tg_head hx
        rcases hc' with rfl | hcx
        · exact absurd rfl (lk_ne hxc)
        · have hcR : c ∈ R := by
            obtain ⟨d, hd, -⟩ := tg_head (innerR hcx hxR)
            simp only [inner, Bool.and_eq_true, decide_eq_true_eq] at hd
            exact hd.1.1
          have hi : inner s R x c = true := by simp [inner, hxR, hcR, lk_link hxc]
          have e1 := (rk1 x c (by simp [B, hxR]) hi).1
          have e2 := rpath hcR (innerR hcx hxR)
          rw [← hu]
          simp only [hxR, ↓reduceIte, Bool.or_eq_true, List.any_eq_true, Bool.and_eq_true,
            beq_iff_eq]
          exact .inl ⟨c, hcR, hi, by omega⟩
      · rw [tmb x hxR]
        rcases hC hm' x hx with h | ⟨b, hb, hr'⟩
        · exact h
        · exact absurd (reachR hb (path_alive hx).1 hr') hxR

/-! mend -/

theorem go_eq (rk : Rk α) (all begun : List α) : ∀ (f : Nat) (s : State α) (work : List α),
    ∃ mk cn rk' rd mb hp, go n rk all begun f s work =
      { s with making := mk, count := cn, rank := rk', ranked := rd, members := mb, heap := hp } ∧
      (mk = 0 ∨ mk = s.making) := by
  intro f
  induction f with
  | zero =>
    intro s work
    cases work with
    | nil => exact ⟨s.making, s.count, s.rank, s.ranked, s.members, s.heap, by simp only [go],
        .inr rfl⟩
    | cons x rest => exact ⟨0, s.count, s.rank, s.ranked, s.members, s.heap, by simp only [go],
        .inl rfl⟩
  | succ f ih =>
    intro s work
    cases work with
    | nil => exact ⟨s.making, s.count, s.rank, s.ranked, s.members, s.heap, by simp only [go],
        .inr rfl⟩
    | cons x rest =>
      simp only [go]
      split
      · exact ih s rest
      · split
        · obtain ⟨cn, rk', rd, mb, hp, e⟩ := local_eq n rk all s (x :: rest ++ begun)
          exact ⟨s.making, cn, rk', rd, mb, hp, e, .inr rfl⟩
        · split
          · exact ih s rest
          · split
            · obtain ⟨cn, rk', rd, mb, hp, e⟩ := local_eq n rk all { s with
                rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
                heap := if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩
                  else s.heap } begun
              exact ⟨s.making, cn, rk', rd, mb, hp, by rw [e], .inr rfl⟩
            · obtain ⟨mk, cn, rk', rd, mb, hp, e, h⟩ := ih { s with
                rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
                heap := if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩
                  else s.heap } ((keys (s.afters x)).reverse ++ rest)
              exact ⟨mk, cn, rk', rd, mb, hp, by rw [e], h⟩

-- one rank set: x's, to top s x
theorem set_rank (s : State α) (x : α) (h : List (Entry α)) :
    let t := { s with
      rank := update s.rank x (top s x), ranked := update s.ranked x s.making, heap := h }
    rankOf t x = top s x ∧ (∀ q, q ≠ x → rankOf t q = rankOf s q) ∧ link t = link s ∧
      top t x = top s x := by
  intro t
  have h1 : rankOf t x = top s x := by simp [t, rankOf]
  have h2 : ∀ q, q ≠ x → rankOf t q = rankOf s q := by
    intro q hq; simp [t, rankOf, update_ne _ _ hq]
  have h3 : link t = link s := link_eq rfl rfl rfl
  refine ⟨h1, h2, h3, top_congr (fun q => by rw [h3]) (fun q hq => h2 q (link_ne s hq))⟩

-- x risen: the heap's promise kept
theorem raise_good {s : State α} {x : α} (hg : good n s) :
    good n { s with
      rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
      heap := if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩ else s.heap } := by
  obtain ⟨g1, g2, g3, g4⟩ := hg
  generalize hh : (if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩
    else s.heap) = h
  obtain ⟨t1, t2, -, -⟩ := set_rank s x h
  have sub : ∀ e ∈ s.heap, e ∈ h := by
    intro e he; rw [← hh]; split
    · rw [push_perm.mem_iff]; exact List.mem_append_left _ he
    · exact he
  refine ⟨?_, ?_, g3, ?_⟩
  · rw [← hh]; split
    · exact push_heap (less_weak n) g1
    · exact g1
  · intro e he
    rw [← hh] at he; split at he
    · rw [push_perm.mem_iff] at he
      rcases List.mem_append.1 he with he | he
      · exact g2 e he
      · simp at he; subst he; assumption
    · exact g2 e he
  · intro hm p hp
    by_cases hpx : p = x
    · subst hpx
      rw [t1]
      show (⟨p, top s p, s.due p⟩ : Entry α) ∈ h
      rw [← hh]; split
      · rw [push_perm.mem_iff]; simp
      · contradiction
    · rw [t2 p hpx]; exact sub _ (g4 hm p hp)

-- mend done: every one fine, begun's strict, so no cycle through them: ranks and members right
theorem end_ok {s : State α} {begun : List α} (hf : ∀ x, fine s x)
    (hS : ∀ b ∈ begun, ∀ y, lk s b y = true → rankOf s y < rankOf s b)
    (hC : ∀ x, path s x x → s.members x = true ∨ ∃ b ∈ begun, path s x b ∧ path s b x) : ok s := by
  intro _
  refine ⟨hf, fun x hx => ?_⟩
  rcases hC x hx with h | ⟨b, hb, h1, h2⟩
  · exact h
  · exfalso
    obtain ⟨c, hbc, hc⟩ := tg_head (h2.trans h1)
    rcases hc with rfl | hcb
    · exact lk_ne hbc rfl
    · have := fine_path hf hcb
      have := hS b hb c hbc
      omega

-- mend's loop: everything not fine in the work and reaching begun; begun's out of the work
-- strict; every cycle a member's or through begun. after: the ranks right, or none
theorem go_inv {rk : Rk α} {all begun : List α} : ∀ (f : Nat) (s : State α) (work : List α),
    sound rk s.alive → (∀ p, s.alive p = true → p ∈ all) → good n s → counted s →
    s.making ≠ 0 →
    (∀ x, ¬ fine s x → x ∈ work ∧ ∃ b ∈ begun, reaches (fun a b => lk s a b = true) x b) →
    (∀ b ∈ begun, b ∉ work → ∀ y, lk s b y = true → rankOf s y < rankOf s b) →
    (∀ x, path s x x → s.members x = true ∨ ∃ b ∈ begun, path s x b ∧ path s b x) →
    good n (go n rk all begun f s work) ∧ ok (go n rk all begun f s work) := by
  intro f
  induction f with
  | zero =>
    intro s work hk hall hg hc hm hV hS hC
    cases work with
    | nil =>
      simp only [go]
      exact ⟨hg, end_ok (fun x => Classical.byContradiction fun h => by simpa using (hV x h).1)
        (fun b hb y hy => hS b hb (by simp) y hy) hC⟩
    | cons x rest =>
      simp only [go]
      exact ⟨⟨hg.1, hg.2.1, hg.2.2.1, fun h => absurd rfl h⟩, fun h => absurd rfl h⟩
  | succ f ih =>
    intro s work hk hall hg hc hm hV hS hC
    cases work with
    | nil =>
      simp only [go]
      exact ⟨hg, end_ok (fun x => Classical.byContradiction fun h => by simpa using (hV x h).1)
        (fun b hb y hy => hS b hb (by simp) y hy) hC⟩
    | cons x rest =>
      simp only [go]
      -- x fine with every edge strict: out of the work for good
      have strict_rest : (∀ y, lk s x y = true → rankOf s y < rankOf s x) →
          (∀ x', ¬ fine s x' → x' ∈ rest ∧ ∃ b ∈ begun, reaches (fun a b => lk s a b = true) x' b) ∧
          (∀ b ∈ begun, b ∉ rest → ∀ y, lk s b y = true → rankOf s y < rankOf s b) := by
        intro hx
        refine ⟨fun x' hx' => ?_, fun b hb hbr y hy => ?_⟩
        · obtain ⟨hw, hr⟩ := hV x' hx'
          rcases List.mem_cons.1 hw with rfl | hw
          · exact absurd (fine_of hx) hx'
          · exact ⟨hw, hr⟩
        · by_cases hbx : b = x
          · subst hbx; exact hx y hy
          · exact hS b hb (by simp [hbx, hbr]) y hy
      split
      · rename_i hax
        obtain ⟨h1, h2⟩ := strict_rest (fun y hy => by rw [(lk_alive hy).1] at hax; cases hax)
        exact ih s rest hk hall hg hc hm h1 h2 hC
      · rename_i hax
        split
        · exact local_inv n hk hall hg hc
            (fun _ x' hx' => by
              obtain ⟨-, b, hb, hr⟩ := hV x' hx'
              exact ⟨b, List.mem_cons_of_mem _ (List.mem_append_right _ hb), hr⟩)
            (fun _ x' hx' => by
              rcases hC x' hx' with h | ⟨b, hb, h1, -⟩
              · exact .inl h
              · exact .inr ⟨b, List.mem_cons_of_mem _ (List.mem_append_right _ hb), .inr h1⟩)
        · rename_i hmx
          split
          · rename_i htop
            obtain ⟨h1, h2⟩ := strict_rest (fun y hy => by
              have := top_ge (lk_link hy); omega)
            exact ih s rest hk hall hg hc hm h1 h2 hC
          · rename_i htop
            have hxa : s.alive x = true := by simpa using hax
            have hxm : s.members x = false := by simpa using hmx
            -- x reaches begun: not fine, or on a cycle through begun
            have hxr : ∃ b ∈ begun, reaches (fun a b => lk s a b = true) x b := by
              by_cases hfx : fine s x
              · rcases top_cases s x with e | ⟨q, hq, e⟩
                · omega
                · have hlq : lk s x q = true := by simp [lk, hxa, hq]
                  obtain ⟨f1, f2⟩ := hfx q hlq
                  have hqx : path s q x := Classical.byContradiction fun hn => by
                    have := f2 hn; omega
                  rcases hC x (Relation.TransGen.trans (.single hlq) hqx) with h | ⟨b, hb, h1, -⟩
                  · rw [hxm] at h; cases h
                  · exact ⟨b, hb, .inr h1⟩
              · exact (hV x hfx).2
            generalize hh : (if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩
              else s.heap) = h
            generalize ht : ({ s with
              rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
              heap := h } : State α) = t
            obtain ⟨t1, t2, t3, -⟩ := set_rank s x h
            rw [ht] at t1 t2 t3
            have tl : lk t = lk s := by rw [← ht]; exact lk_eq rfl rfl rfl
            have tp : path t = path s := by unfold path; rw [tl]
            have ta : t.alive = s.alive := by rw [← ht]
            have tm : t.making = s.making := by rw [← ht]
            have tmb : t.members = s.members := by rw [← ht]
            have tc : counted t := by rw [← ht]; exact hc
            have tg : good n t := by rw [← ht, ← hh]; exact raise_good n hg
            have F1 : ∀ y, lk t x y = true → rankOf t y < rankOf t x := by
              intro y hy; rw [tl] at hy
              rw [t1, t2 y (lk_ne hy)]
              have := top_ge (lk_link hy); omega
            have F2 : ∀ x', x' ≠ x → lk s x' x = false → fine s x' → fine t x' := by
              intro x' hx' hn hf y hy
              rw [tl] at hy
              have hyx : y ≠ x := by rintro rfl; rw [hn] at hy; cases hy
              rw [t2 y hyx, t2 x' hx', tp]
              exact hf y hy
            have hk' : sound rk t.alive := by rw [ta]; exact hk
            have hall' : ∀ p, t.alive p = true → p ∈ all := by rw [ta]; exact hall
            split
            · rename_i hhit
              exact local_inv n hk' hall' tg tc
                (fun _ x' hx' => by
                  rw [tl]
                  by_cases h1 : x' = x
                  · subst h1; exact absurd (fine_of F1) hx'
                  · cases h2 : lk s x' x with
                    | true =>
                      obtain ⟨b, hb, hr⟩ := hxr
                      exact ⟨b, hb, reaches_cons h2 hr⟩
                    | false =>
                      exact (hV x' fun hf => hx' (F2 x' h1 h2 hf)).2)
                (fun _ x' hx' => by
                  rw [tp] at hx'
                  rw [tmb, tl]
                  rcases hC x' hx' with h | ⟨b, hb, h1, -⟩
                  · exact .inl h
                  · exact .inr ⟨b, hb, .inr h1⟩)
            · rename_i hhit
              have nob : ∀ y ∈ keys (s.afters x), y ∉ begun := by
                intro y hy hb
                exact hhit (List.any_eq_true.2 ⟨y, hy, by simp [hb]⟩)
              apply ih t _ hk' hall' tg tc (by rw [tm]; exact hm)
              · intro x' hx'
                rw [tl]
                by_cases h1 : x' = x
                · subst h1; exact absurd (fine_of F1) hx'
                · cases h2 : lk s x' x with
                  | true =>
                    obtain ⟨b, hb, hr⟩ := hxr
                    exact ⟨List.mem_append_left _ (List.mem_reverse.2 (link_keys hc (lk_link h2))),
                      b, hb, reaches_cons h2 hr⟩
                  | false =>
                    obtain ⟨hw, hr⟩ := hV x' fun hf => hx' (F2 x' h1 h2 hf)
                    rcases List.mem_cons.1 hw with rfl | hw
                    · exact absurd rfl h1
                    · exact ⟨List.mem_append_right _ hw, hr⟩
              · intro b hb hbw y hy
                by_cases hbx : b = x
                · subst hbx; exact F1 y hy
                · rw [tl] at hy
                  have hbr : b ∉ rest := fun h => hbw (List.mem_append_right _ h)
                  have hyx : y ≠ x := by
                    rintro rfl
                    exact nob b (link_keys hc (lk_link hy)) hb
                  rw [t2 y hyx, t2 b hbx]
                  exact hS b hb (by simp [hbx, hbr]) y hy
              · intro x' hx'
                rw [tp] at hx'
                rw [tmb, tp]
                exact hC x' hx'

theorem mend_eq (rk : Rk α) (all : List α) (s : State α) (work : List α) :
    ∃ mk cn rk' rd mb hp, mend n rk all s work =
      { s with making := mk, count := cn, rank := rk', ranked := rd, members := mb, heap := hp } ∧
      (mk = 0 ∨ mk = s.making) := by
  unfold mend
  split
  · exact ⟨s.making, s.count, s.rank, s.ranked, s.members, s.heap, rfl, .inr rfl⟩
  · exact go_eq n rk all work _ s work

-- mend: everything not fine in the work and reaching it, every cycle a member's or through the
-- work: the ranks right after, or none
theorem mend_inv {rk : Rk α} {all : List α} {s : State α} {work : List α}
    (hk : sound rk s.alive) (hall : ∀ p, s.alive p = true → p ∈ all) (hg : good n s)
    (hc : counted s)
    (hV : s.making ≠ 0 → ∀ x, ¬ fine s x →
      x ∈ work ∧ ∃ b ∈ work, reaches (fun a b => lk s a b = true) x b)
    (hC : s.making ≠ 0 → ∀ x, path s x x → s.members x = true ∨
      ∃ b ∈ work, path s x b ∧ path s b x) :
    good n (mend n rk all s work) ∧ ok (mend n rk all s work) := by
  unfold mend
  split
  · rename_i hm; exact ⟨hg, fun h => absurd hm h⟩
  · rename_i hm
    exact go_inv n _ s work hk hall hg hc hm (hV hm) (fun b hb hbw => absurd hb hbw) (hC hm)

-- a cycle's member mended: ranked again from it (local)
theorem mend_member {rk : Rk α} {all : List α} {s : State α} {p : α} (hm : s.making ≠ 0)
    (ha : s.alive p = true) (hp : s.members p = true) :
    mend n rk all s [p] = «local» n rk all s [p, p] := by
  unfold mend
  simp only [hm, ↓reduceIte]
  show go n rk all [p] (4 * s.count + 64 + 1) s [p] = _
  simp only [go, ha, hp, ↓reduceIte]
  rfl

end mend

/-! ## sees and waits: an edge of p changed, p mended -/

section edits

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- a loop of sees: only afters change; the counts of p at each one not skipped moved by f, once;
-- the flag: an edge at one not skipped
theorem loop_spec (op : State α → α → α → State α) (f : Nat → Nat) (p : α) (g : Nat)
    (hop : ∀ s q, ∃ af, op s p q = { s with afters := af })
    (hcnt : ∀ s q q' y, cnt (op s p q) q' y =
      if q' = q ∧ y = p then f (cnt s q' y) else cnt s q' y) :
    ∀ (l : List α) (s : State α) (b : Bool), l.Nodup →
      (∃ af, (l.foldl (loop op p g) (s, b)).1 = { s with afters := af }) ∧
      (∀ q' y, cnt (l.foldl (loop op p g) (s, b)).1 q' y =
        if y = p ∧ q' ∈ l ∧ s.stamp q' ≠ g then f (cnt s q' y) else cnt s q' y) ∧
      (l.foldl (loop op p g) (s, b)).2 =
        (b || l.any fun q => decide (s.stamp q ≠ g) && edge s p q)
  | [], s, b, _ => ⟨⟨s.afters, rfl⟩, fun q' y => by simp, by simp⟩
  | a :: l, s, b, hl => by
    have ha : a ∉ l := (List.nodup_cons.1 hl).1
    simp only [List.foldl_cons]
    obtain ⟨af1, s1e, c1, b1e⟩ : ∃ af1, (loop op p g (s, b) a).1 = { s with afters := af1 } ∧
        (∀ q' y, cnt (loop op p g (s, b) a).1 q' y =
          if q' = a ∧ y = p ∧ s.stamp a ≠ g then f (cnt s q' y) else cnt s q' y) ∧
        (loop op p g (s, b) a).2 = (b || (decide (s.stamp a ≠ g) && edge s p a)) := by
      unfold loop
      by_cases hs : s.stamp a = g
      · simp only [hs, ↓reduceIte]
        exact ⟨s.afters, rfl, fun q' y => by simp, by simp⟩
      · simp only [hs, ↓reduceIte]
        obtain ⟨af, e⟩ := hop s a
        refine ⟨af, e, fun q' y => ?_, by simp [hs]⟩
        rw [hcnt]; by_cases h1 : q' = a <;> by_cases h2 : y = p <;> simp [h1, h2, hs]
    generalize hr1 : loop op p g (s, b) a = r1 at s1e c1 b1e
    obtain ⟨s1, b1⟩ := r1
    simp only at s1e c1 b1e
    obtain ⟨i1, i2, i3⟩ := loop_spec op f p g hop hcnt l s1 b1 (List.nodup_cons.1 hl).2
    have st1 : s1.stamp = s.stamp := by rw [s1e]
    have ed1 : edge s1 = edge s := edge_eq (by rw [s1e])
    refine ⟨?_, ?_, ?_⟩
    · obtain ⟨af, e⟩ := i1; rw [e, s1e]; exact ⟨af, rfl⟩
    · intro q' y
      rw [i2, st1, c1]
      by_cases h1 : q' = a
      · subst h1; simp [ha]
      · simp [h1]
    · rw [i3, b1e, st1, ed1]; simp [Bool.or_assoc]

theorem tie_spec (p : α) : ∀ s q q' y, cnt (tie s p q) q' y =
    if q' = q ∧ y = p then (cnt s q' y + 1) else cnt s q' y := by
  intro s q q' y; rw [tie_cnt]; split <;> simp

theorem untie_spec (p : α) : ∀ s q q' y, cnt (untie s p q) q' y =
    if q' = q ∧ y = p then (cnt s q' y - 1) else cnt s q' y := untie_cnt (p := p)

-- sees up to mend: values, afters and the stamps changed, the counts by the difference, and
-- whether an edge changed
theorem sees_shape (rk : Rk α) (all : List α) (s : State α) (p : α) (next : List α)
    (hn : next.Nodup)
    (hv : (s.values p).Nodup) (hst : ∀ q, s.stamp q ≤ s.stamps) :
    ∃ (af : α → Option (List (α × Nat))) (st : α → Nat) (k : Nat) (b : Bool),
      sees n rk all s p next = (if b = true then mend n rk all
        { s with values := update s.values p next, afters := af, stamp := st, stamps := k } [p]
        else { s with values := update s.values p next, afters := af, stamp := st, stamps := k }) ∧
      (∀ q, st q ≤ k) ∧
      (∀ q y, cnt { s with afters := af } q y =
        if y = p ∧ q ∈ next ∧ q ∉ s.values p then cnt s q y + 1
        else if y = p ∧ q ∈ s.values p ∧ q ∉ next then cnt s q y - 1 else cnt s q y) ∧
      (b = false → ∀ q, edge s p q = true → (q ∈ s.values p ↔ q ∈ next)) := by
  unfold sees
  dsimp only
  split
  · rename_i he
    refine ⟨s.afters, s.stamp, s.stamps, false, ?_, hst, fun q y => ?_, fun _ q _ => by rw [he]⟩
    · simp
    · rw [he]; simp
  · rename_i hne
    generalize hg : s.stamps + 1 = g
    generalize hs2 : tag { s with values := update s.values p next } next g = s2
    obtain ⟨a1, c1, b1⟩ := loop_spec untie (· - 1) p g (untie_eq · p) (untie_spec p)
      (s.values p) s2 false hv
    generalize hr : (s.values p).foldl (loop untie p g) (s2, false) = r at a1 c1 b1
    obtain ⟨r1, rb⟩ := r
    simp only at a1 c1 b1
    obtain ⟨af1, e1⟩ := a1
    generalize hs3 : tag r1 (s.values p) (r1.stamps + 1) = s3
    obtain ⟨a2, c2, b2⟩ := loop_spec tie (· + 1) p (r1.stamps + 1) (fun s q => ⟨_, rfl⟩)
      (tie_spec p) next s3 rb hn
    generalize hr' : next.foldl (loop tie p (r1.stamps + 1)) (s3, rb) = r' at a2 c2 b2
    obtain ⟨t, tb⟩ := r'
    simp only at a2 c2 b2
    obtain ⟨af2, e2⟩ := a2
    have r1st : r1.stamps = g := by rw [e1, ← hs2]; rfl
    have s2sp : s2.stamp = fun q => if q ∈ next then g else s.stamp q := by rw [← hs2]; rfl
    have r1sp : r1.stamp = fun q => if q ∈ next then g else s.stamp q := by rw [e1, ← s2sp]
    have s3sp : s3.stamp = fun q => if q ∈ s.values p then g + 1 else
        if q ∈ next then g else s.stamp q := by
      rw [← hs3]
      show (fun q => if q ∈ s.values p then r1.stamps + 1 else r1.stamp q) = _
      rw [r1st, r1sp]
    have hlt : ∀ q, s.stamp q < g := fun q => by have := hst q; omega
    have ed2 : edge s2 = edge s := edge_eq (by rw [← hs2]; rfl)
    have ed3 : edge s3 = edge s := edge_eq (by rw [← hs3, e1, ← hs2]; rfl)
    have ht : t = { s with
        values := update s.values p next, afters := af2, stamp := s3.stamp, stamps := g + 1 } := by
      rw [e2, ← hs3, e1, ← hs2, ← hg]; rfl
    refine ⟨af2, s3.stamp, g + 1, tb, ?_, ?_, ?_, ?_⟩
    · show (if tb = true then mend n rk all t [p] else t) = _
      rw [← ht]
    · intro q; rw [s3sp]; simp only; split
      · omega
      · split
        · omega
        · have := hlt q; omega
    · intro q y
      have h3 : cnt { s with afters := af2 } q y = cnt t q y := by rw [e2]; rfl
      have h2 : cnt s3 q y = cnt r1 q y := by rw [← hs3]; rfl
      have h1 : cnt s2 q y = cnt s q y := by rw [← hs2]; rfl
      rw [h3, c2, h2, c1, h1, s3sp, s2sp, r1st]
      have := hlt q
      by_cases hy : y = p
      · rw [hy]
        by_cases hq1 : q ∈ next <;> by_cases hq2 : q ∈ s.values p <;> simp [hq1, hq2] <;> omega
      · simp [hy]
    · intro hb q hq
      rw [b2, b1, ed3, ed2, s3sp, s2sp] at hb
      simp only [Bool.or_eq_false_iff, Bool.false_or, List.any_eq_false, Bool.and_eq_true,
        decide_eq_true_eq, not_and] at hb
      obtain ⟨hb1, hb2⟩ := hb
      constructor
      · intro hm
        by_cases hn' : q ∈ next
        · exact hn'
        · exact absurd hq (hb1 q hm (by simp [hn']; have := hlt q; omega))
      · intro hm
        by_cases hn' : q ∈ s.values p
        · exact hn'
        · exact absurd hq (hb2 q hm (by simp [hn', hm, r1st]))

end edits

section edits2

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- waits up to mend: after and afters changed, the counts by the difference, and whether an edge
-- changed
theorem waits_shape (rk : Rk α) (all : List α) (s : State α) (p : α) (q : Option α) :
    ∃ (af : α → Option (List (α × Nat))) (b : Bool),
      waits n rk all s p q = (if b = true then mend n rk all
        { s with after := update s.after p q, afters := af } [p]
        else { s with after := update s.after p q, afters := af }) ∧
      (∀ x y, cnt { s with afters := af } x y =
        if y = p ∧ q = some x ∧ s.after p ≠ some x then cnt s x y + 1
        else if y = p ∧ s.after p = some x ∧ q ≠ some x then cnt s x y - 1 else cnt s x y) ∧
      (b = false → ∀ y, edge s p y = true → (s.after p = some y ↔ q = some y)) := by
  unfold waits
  split
  · rename_i he
    refine ⟨s.afters, false, ?_, fun x y => ?_, fun _ y _ => by rw [he]⟩
    · simp only [Bool.false_eq_true, ↓reduceIte]
      rw [← he, update_self]
    · rw [he]; simp
  · rename_i hne
    cases ha : s.after p with
    | none =>
      cases q with
      | none => exact absurd ha hne
      | some b =>
        refine ⟨(tie { s with after := update s.after p (some b) } p b).afters, edge s p b, ?_,
          fun x y => ?_, fun hb y hy => ?_⟩
        · simp only [Bool.false_or]; rfl
        · show cnt (tie { s with after := update s.after p (some b) } p b) x y = _
          rw [tie_cnt]
          by_cases h1 : x = b
          · subst h1; by_cases h2 : y = p <;> simp [h2, cnt]
          · have h1' : b ≠ x := Ne.symm h1
            by_cases h2 : y = p <;> simp [h1, h1', h2, cnt]
        · simp only [reduceCtorEq, false_iff, Option.some.injEq]
          rintro rfl; rw [hb] at hy; cases hy
    | some a =>
      obtain ⟨af1, e1⟩ := untie_eq s p a
      cases q with
      | none =>
        refine ⟨af1, edge s p a, ?_, fun x y => ?_, fun hb y hy => ?_⟩
        · simp only; rw [e1]
        · show cnt { s with afters := af1 } x y = _
          rw [← e1, untie_cnt]
          by_cases h1 : x = a
          · subst h1; by_cases h2 : y = p <;> simp [h2]
          · have h1' : a ≠ x := Ne.symm h1
            by_cases h2 : y = p <;> simp [h1, h1', h2]
        · simp only [Option.some.injEq, reduceCtorEq, iff_false]
          rintro rfl; rw [hb] at hy; cases hy
      | some b =>
        have hab : a ≠ b := fun e => hne (by rw [ha, e])
        refine ⟨(tie { s with after := update s.after p (some b), afters := af1 } p b).afters,
          edge s p a || edge s p b, ?_, fun x y => ?_, fun hb y hy => ?_⟩
        · simp only; rw [e1]
          rfl
        · show cnt (tie { s with after := update s.after p (some b), afters := af1 } p b) x y = _
          rw [tie_cnt]
          have h0 : cnt { s with after := update s.after p (some b), afters := af1 } x y =
              cnt (untie s p a) x y := by rw [e1]; rfl
          rw [h0, untie_cnt]
          by_cases h1 : x = a
          · subst h1; by_cases h2 : y = p <;> simp [h2, hab, Ne.symm hab]
          · have h1' : a ≠ x := Ne.symm h1
            by_cases h3 : x = b
            · subst h3; by_cases h2 : y = p <;> simp [h2, h1, h1']
            · have h3' : b ≠ x := Ne.symm h3
              simp [h1, h3, h1', h3']
        · simp only [Bool.or_eq_false_iff] at hb
          simp only [Option.some.injEq]
          constructor
          · rintro rfl; rw [hb.1] at hy; cases hy
          · rintro rfl; rw [hb.2] at hy; cases hy

-- an edit of p's edges (sees, waits) up to mend: s with p's values or after changed, the counts
-- kept true, b whether an edge changed. so the edit, mended when b, keeps what order keeps
theorem edit_inv {rk : Rk α} {all : List α} {s t : State α} {p : α} {b : Bool}
    (h : inv n s) (hk : sound rk s.alive) (hall : ∀ q, s.alive q = true → q ∈ all)
    (e1 : t.alive = s.alive) (e2 : t.due = s.due) (e3 : t.heap = s.heap)
    (e4 : t.making = s.making) (e5 : t.members = s.members) (e6 : t.rank = s.rank)
    (e7 : t.ranked = s.ranked)
    (hx : ∀ x, x ≠ p → t.values x = s.values x ∧ t.after x = s.after x)
    (hc : counted t) (hd : ∀ x, (t.values x).Nodup) (hs : ∀ q, t.stamp q ≤ t.stamps)
    (hb : b = false → link t p = link s p) :
    inv n (if b = true then mend n rk all t [p] else t) := by
  have hr : rankOf t = rankOf s := by funext x; simp [rankOf, e4, e6, e7]
  have hl : ∀ x, x ≠ p → lk t x = lk s x := by
    intro x hxp; funext y; simp [lk, link, edge, e1, (hx x hxp).1, (hx x hxp).2]
  have ag : ∀ a c, lk s a c = true → a ≠ p → lk t a c = true := fun a c h ha => by
    rw [hl a ha]; exact h
  have ag' : ∀ a c, lk t a c = true → a ≠ p → lk s a c = true := fun a c h ha => by
    rw [← hl a ha]; exact h
  obtain ⟨g1, g2, g3, g4⟩ := h.good
  have gt : good n t := by
    refine ⟨by rw [e3]; exact g1, by rw [e3]; exact g2, fun q hq => ?_, fun hm q hq => ?_⟩
    · rw [e1]; exact g3 q (by rw [← e2]; exact hq)
    · rw [e3, hr, e2]; exact g4 (by rw [← e4]; exact hm) q (by rw [← e2]; exact hq)
  have hk' : sound rk t.alive := by rw [e1]; exact hk
  have hall' : ∀ q, t.alive q = true → q ∈ all := by rw [e1]; exact hall
  -- after the mend: the computations as t has them
  have keep : ∀ u : State α, (∃ mk cn rk' rd mb hp, u =
      { t with making := mk, count := cn, rank := rk', ranked := rd, members := mb, heap := hp }) →
      good n u → ok u → inv n u := by
    rintro u ⟨mk, cn, rk', rd, mb, hp, rfl⟩ gu ou
    exact ⟨gu, ou, hc, hd, hs⟩
  cases b with
  | false =>
    simp only [Bool.false_eq_true, ↓reduceIte]
    have hL : lk t = lk s := by
      funext x; by_cases hxp : x = p
      · subst hxp; funext y; simp [lk, hb rfl, e1]
      · exact hl x hxp
    have hP : path t = path s := by unfold path; rw [hL]
    refine ⟨gt, fun hm => ?_, hc, hd, hs⟩
    obtain ⟨o1, o2⟩ := h.ok (by rwa [← e4])
    refine ⟨fun x y hy => ?_, fun x hx => ?_⟩
    · rw [hL] at hy; rw [hr, hP]; exact o1 x y hy
    · rw [hP] at hx; rw [e5]; exact o2 x hx
  | true =>
    simp only [↓reduceIte]
    by_cases hm : t.making = 0
    · have e : mend n rk all t [p] = t := by unfold mend; simp only [hm, ↓reduceIte]
      rw [e]; exact ⟨gt, fun h' => absurd hm h', hc, hd, hs⟩
    have hm' : s.making ≠ 0 := by rwa [← e4]
    obtain ⟨o1, o2⟩ := h.ok hm'
    -- one other than p not fine has lost a path through p: it reaches p, and p was on a cycle
    have lost : ∀ x, x ≠ p → fine t x ∨
        (reaches (fun a b => lk t a b = true) x p ∧ path s p p) := by
      intro x hxp
      by_cases hE : reaches (fun a b => lk t a b = true) x p ∧ path s p p
      · exact .inr hE
      · left
        intro y hy
        have hy' : lk s x y = true := ag' x y hy hxp
        obtain ⟨f1, f2⟩ := o1 x y hy'
        rw [hr]
        refine ⟨f1, fun hn => f2 fun hyx => hE ?_⟩
        rcases split p ag ag' hyx with h1 | ⟨h1, h2⟩
        · exact absurd h1 hn
        · have hpy : path s p y := Relation.TransGen.trans h2 (.single hy')
          refine ⟨reaches_cons hy (hit p ag h1), ?_⟩
          rcases h1 with h1 | h1
          · exact h1 ▸ hpy
          · exact hpy.trans h1
    -- a cycle of t: one of s, or through p
    have cyc : ∀ x, path t x x → path s x x ∨
        (reaches (fun a b => lk t a b = true) x p ∧ path t p x) := by
      intro x hx
      rcases split p ag' ag hx with h1 | h1
      · exact .inl h1
      · exact .inr h1
    by_cases hmem : t.alive p = true ∧ t.members p = true
    · rw [mend_member n hm hmem.1 hmem.2]
      obtain ⟨cn, rk', rd, mb, hp, e⟩ := local_eq n rk all t [p, p]
      obtain ⟨gu, ou⟩ := local_inv n (start := [p, p]) hk' hall' gt hc
        (fun _ x hx => by
          by_cases hxp : x = p
          · exact ⟨p, by simp, .inl hxp⟩
          · rcases lost x hxp with h1 | ⟨h1, -⟩
            · exact absurd h1 hx
            · exact ⟨p, by simp, h1⟩)
        (fun _ x hx => by
          rcases cyc x hx with h1 | ⟨h1, -⟩
          · rw [e5]; exact .inl (o2 x h1)
          · exact .inr ⟨p, by simp, h1⟩)
      exact keep _ ⟨t.making, cn, rk', rd, mb, hp, e⟩ gu ou
    · obtain ⟨mk, cn, rk', rd, mb, hp, e, -⟩ := mend_eq n rk all t [p]
      obtain ⟨gu, ou⟩ := mend_inv n (work := [p]) hk' hall' gt hc
        (fun _ x hx => by
          by_cases hxp : x = p
          · exact ⟨by simp [hxp], p, by simp, .inl hxp⟩
          · rcases lost x hxp with h1 | ⟨-, h2⟩
            · exact absurd h1 hx
            · exfalso
              exact hmem ⟨by rw [e1]; exact (path_alive h2).1, by rw [e5]; exact o2 p h2⟩)
        (fun _ x hx => by
          rcases cyc x hx with h1 | ⟨h1, h2⟩
          · rw [e5]; exact .inl (o2 x h1)
          · refine .inr ⟨p, by simp, ?_, h2⟩
            rcases h1 with rfl | h1
            · exact h2
            · exact h1)
      exact keep _ ⟨mk, cn, rk', rd, mb, hp, e⟩ gu ou

-- sees keeps what order keeps (next: no repeats, as the scheduler's seen gives)
theorem inv_sees {rk : Rk α} {all : List α} {s : State α} (h : inv n s) (hk : sound rk s.alive)
    (hall : ∀ q, s.alive q = true → q ∈ all) (p : α) {next : List α} (hn : next.Nodup) :
    inv n (sees n rk all s p next) := by
  obtain ⟨af, st, k, b, e, hsk, hcnt, hb⟩ := sees_shape n rk all s p next hn (h.nodup p) h.stamped
  rw [e]
  refine edit_inv n h hk hall rfl rfl rfl rfl rfl rfl rfl
    (fun x hxp => ⟨update_ne _ _ hxp, rfl⟩) ?_ ?_ hsk ?_
  · intro q hq y
    have h0 := h.counted q hq y
    show cnt { s with afters := af } q y = _
    rw [hcnt]
    simp only
    by_cases hy : y = p
    · rw [hy] at h0 ⊢
      simp only [update_same, true_and]
      by_cases h1 : q ∈ next <;> by_cases h2 : q ∈ s.values p <;> simp [h1, h2] at h0 ⊢ <;> omega
    · simp only [hy, false_and, ↓reduceIte, update_ne _ _ hy]; exact h0
  · intro x; by_cases hxp : x = p
    · subst hxp; simpa using hn
    · simp only [update_ne _ _ hxp]; exact h.nodup x
  · intro hb0
    funext y
    show (edge s p y && (decide (y ∈ update s.values p next p) || s.after p = some y)) =
      (edge s p y && (decide (y ∈ s.values p) || s.after p = some y))
    rw [update_same]
    cases he : edge s p y with
    | false => rfl
    | true =>
      have := hb hb0 y he
      simp only [Bool.true_and]
      by_cases h1 : y ∈ s.values p <;> simp_all

-- waits keeps what order keeps
theorem inv_waits {rk : Rk α} {all : List α} {s : State α} (h : inv n s) (hk : sound rk s.alive)
    (hall : ∀ q, s.alive q = true → q ∈ all) (p : α) (q : Option α) :
    inv n (waits n rk all s p q) := by
  obtain ⟨af, b, e, hcnt, hb⟩ := waits_shape n rk all s p q
  rw [e]
  refine edit_inv n h hk hall rfl rfl rfl rfl rfl rfl rfl
    (fun x hxp => ⟨rfl, update_ne _ _ hxp⟩) ?_ h.nodup h.stamped ?_
  · intro x hx' y
    have h0 := h.counted x hx' y
    show cnt { s with afters := af } x y = _
    rw [hcnt]
    simp only
    by_cases hy : y = p
    · rw [hy] at h0 ⊢
      simp only [update_same, true_and]
      by_cases h1 : q = some x <;> by_cases h2 : s.after p = some x <;> simp [h1, h2] at h0 ⊢ <;>
        omega
    · simp only [hy, false_and, ↓reduceIte, update_ne _ _ hy]; exact h0
  · intro hb0
    funext y
    show (edge s p y && (decide (y ∈ s.values p) || decide (update s.after p q p = some y))) =
      (edge s p y && (decide (y ∈ s.values p) || decide (s.after p = some y)))
    rw [update_same]
    cases he : edge s p y with
    | false => rfl
    | true =>
      have := hb hb0 y he
      simp only [Bool.true_and]
      by_cases h1 : s.after p = some y <;> simp_all

-- what sees changes of the computations: values at p, and afters by the difference
theorem sees_eq (rk : Rk α) (all : List α) (s : State α) (p : α) (next : List α)
    (hn : next.Nodup) (hv : (s.values p).Nodup) (hst : ∀ q, s.stamp q ≤ s.stamps) :
    (sees n rk all s p next).alive = s.alive ∧
      (sees n rk all s p next).values = update s.values p next ∧
      (sees n rk all s p next).after = s.after ∧ (sees n rk all s p next).due = s.due ∧
      ∀ q y, cnt (sees n rk all s p next) q y =
        if y = p ∧ q ∈ next ∧ q ∉ s.values p then cnt s q y + 1
        else if y = p ∧ q ∈ s.values p ∧ q ∉ next then cnt s q y - 1 else cnt s q y := by
  obtain ⟨af, st, k, b, e, -, hcnt, -⟩ := sees_shape n rk all s p next hn hv hst
  rw [e]
  have key : ∀ u : State α, u.afters = af → u.alive = s.alive →
      u.values = update s.values p next → u.after = s.after → u.due = s.due →
      u.alive = s.alive ∧ u.values = update s.values p next ∧ u.after = s.after ∧
        u.due = s.due ∧ ∀ q y, cnt u q y =
          if y = p ∧ q ∈ next ∧ q ∉ s.values p then cnt s q y + 1
          else if y = p ∧ q ∈ s.values p ∧ q ∉ next then cnt s q y - 1 else cnt s q y := by
    intro u h1 h2 h3 h4 h5
    refine ⟨h2, h3, h4, h5, fun q y => ?_⟩
    rw [← hcnt]; simp [cnt, h1]
  split
  · obtain ⟨mk, cn, rk', rd, mb, hp, eu, -⟩ := mend_eq n rk all
      { s with values := update s.values p next, afters := af, stamp := st, stamps := k } [p]
    rw [eu]; exact key _ rfl rfl rfl rfl rfl
  · exact key _ rfl rfl rfl rfl rfl

-- what waits changes of the computations: after at p, and afters by the difference
theorem waits_eq (rk : Rk α) (all : List α) (s : State α) (p : α) (q : Option α) :
    (waits n rk all s p q).alive = s.alive ∧ (waits n rk all s p q).values = s.values ∧
      (waits n rk all s p q).after = update s.after p q ∧ (waits n rk all s p q).due = s.due ∧
      ∀ x y, cnt (waits n rk all s p q) x y =
        if y = p ∧ q = some x ∧ s.after p ≠ some x then cnt s x y + 1
        else if y = p ∧ s.after p = some x ∧ q ≠ some x then cnt s x y - 1 else cnt s x y := by
  obtain ⟨af, b, e, hcnt, -⟩ := waits_shape n rk all s p q
  rw [e]
  have key : ∀ u : State α, u.afters = af → u.alive = s.alive → u.values = s.values →
      u.after = update s.after p q → u.due = s.due →
      u.alive = s.alive ∧ u.values = s.values ∧ u.after = update s.after p q ∧
        u.due = s.due ∧ ∀ x y, cnt u x y =
          if y = p ∧ q = some x ∧ s.after p ≠ some x then cnt s x y + 1
          else if y = p ∧ s.after p = some x ∧ q ≠ some x then cnt s x y - 1 else cnt s x y := by
    intro u h1 h2 h3 h4 h5
    refine ⟨h2, h3, h4, h5, fun x y => ?_⟩
    rw [← hcnt]; simp [cnt, h1]
  split
  · obtain ⟨mk, cn, rk', rd, mb, hp, eu, -⟩ := mend_eq n rk all
      { s with after := update s.after p q, afters := af } [p]
    rw [eu]; exact key _ rfl rfl rfl rfl rfl
  · exact key _ rfl rfl rfl rfl rfl

end edits2

/-! ## started, gone, set, delete -/

section calls

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- p is new (scheduler.ts, make: a new object): not alive, after nothing, nothing after it, its
-- afters counting none (undefined)
def fresh (s : State α) (p : α) : Prop :=
  s.alive p = false ∧ s.values p = [] ∧ s.after p = none ∧
    (∀ x, p ∉ s.values x ∧ s.after x ≠ some p) ∧ ∀ y, cnt s p y = 0

-- order.ts, createOrder: nothing due, no heap, no ranks, no computation yet
def init : State α :=
  { dues := 0, making := 0, made := 0, count := 0, members := fun _ => false, stamps := 0,
    heap := [],
    alive := fun _ => false, values := fun _ => [], after := fun _ => none, due := fun _ => 0,
    rank := fun _ => 0, ranked := fun _ => 0, afters := fun _ => none, stamp := fun _ => 0 }

theorem inv_init : inv n (init (α := α)) := by
  refine ⟨⟨?_, ?_, ?_, ?_⟩, ?_, ?_, ?_, ?_⟩
  · intro j x y hx; simp [init] at hx
  · intro e he; simp [init] at he
  · intro p hp; simp [init] at hp
  · intro hm; exact absurd rfl hm
  · intro hm; exact absurd rfl hm
  · intro q hq; simp [init] at hq
  · intro x; exact List.nodup_nil
  · intro q; exact Nat.le_refl _

theorem inv_started {s : State α} (h : inv n s) {p : α} (hp : fresh s p) :
    inv n (started s p) := by
  obtain ⟨ha, hv, hf, hn, haf⟩ := hp
  have outp : ∀ y, link s p y = false := by intro y; simp [link, hv, hf]
  -- both branches: alive grows by p; the ranks of others kept
  have key : ∀ t : State α, t.alive = update s.alive p true → t.values = s.values →
      t.after = s.after → t.afters = s.afters → t.due = s.due → t.dues = s.dues →
      t.heap = s.heap → t.making = s.making → t.members = s.members → t.stamps = s.stamps →
      t.stamp = s.stamp → (∀ q, q ≠ p → rankOf t q = rankOf s q) → inv n t := by
    intro t a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 hr
    have hl : link t = link s := by
      funext x y
      simp only [link, edge, a1, a2, a3, update]
      by_cases hy : y = p
      · subst hy; simp [(hn x).1, (hn x).2]
      · simp [hy]
    have hL : lk t = lk s := by
      funext x y
      by_cases hx : x = p
      · subst hx; simp [lk, hl, outp, ha]
      · simp [lk, hl, a1, update_ne _ _ hx]
    have hP : path t = path s := by unfold path; rw [hL]
    have hdp : s.due p = 0 := by
      by_cases hd : s.due p = 0
      · exact hd
      · have := h.good.2.2.1 p hd; rw [ha] at this; cases this
    obtain ⟨g1, g2, g3, g4⟩ := h.good
    refine ⟨⟨by rw [a7]; exact g1, by rw [a7]; exact g2, ?_, ?_⟩, ?_, ?_, ?_, ?_⟩
    · intro q hq; rw [a1]; simp only [update]; split
      · rfl
      · exact g3 q (by rw [← a5]; exact hq)
    · intro hm q hq
      have hqp : q ≠ p := by rintro rfl; rw [a5, hdp] at hq; exact hq rfl
      rw [a7, hr q hqp, a5]; exact g4 (by rw [← a8]; exact hm) q (by rw [← a5]; exact hq)
    · intro hm
      obtain ⟨o1, o2⟩ := h.ok (by rw [← a8]; exact hm)
      refine ⟨fun x y hy => ?_, fun x hx => ?_⟩
      · rw [hL] at hy
        have hxp : x ≠ p := by rintro rfl; simp [lk, ha] at hy
        have hyp : y ≠ p := by
          rintro rfl; have := lk_link hy; simp [link, (hn x).1, (hn x).2] at this
        rw [hr x hxp, hr y hyp, hP]; exact o1 x y hy
      · rw [hP] at hx; rw [a9]; exact o2 x hx
    · intro q hq y
      show cnt t q y = _
      have hc : cnt t q y = cnt s q y := by simp [cnt, a4]
      rw [hc, a2, a3]
      by_cases hqp : q = p
      · subst hqp
        simp [haf y, (hn y).1, (hn y).2]
      · have hqa : s.alive q = true := by rw [a1] at hq; simpa [update, hqp] using hq
        exact h.counted q hqa y
    · rw [a2]; exact h.nodup
    · rw [a10, a11]; exact h.stamped
  unfold started
  dsimp only
  split
  · exact key _ rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl (fun q _ => rfl)
  · refine key _ rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl ?_
    intro q hqp; simp [rankOf, update_ne _ _ hqp]

-- set keeps what order keeps, for an alive p at a mark not 0 (the scheduler's ticks start at 1)
theorem inv_set {s : State α} (h : inv n s) {p : α} (ha : s.alive p = true) {m : Nat}
    (hm : m ≠ 0) : inv n (set n s p m) := by
  obtain ⟨⟨g1, g2, g3, g4⟩, ho, hc, hd, hs⟩ := h
  have g3' : ∀ q, update s.due p m q ≠ 0 → s.alive q = true := by
    intro q hq
    by_cases hqp : q = p
    · subst hqp; exact ha
    · rw [update_ne _ _ hqp] at hq; exact g3 q hq
  unfold set
  dsimp only
  split
  · rename_i hmk
    refine ⟨⟨push_heap (less_weak n) g1, ?_, g3', fun _ q hq => ?_⟩, ho, hc, hd, hs⟩
    · intro e he
      rw [push_perm.mem_iff] at he
      rcases List.mem_append.1 he with he | he
      · exact g2 e he
      · simp at he; subst he; exact hm
    · rw [push_perm.mem_iff]
      by_cases hqp : q = p
      · subst hqp; simp [rankOf]
      · have e : update s.due p m q = s.due q := update_ne _ _ hqp
        have hq' : s.due q ≠ 0 := by rw [← e]; exact hq
        show (⟨q, rankOf s q, update s.due p m q⟩ : Entry α) ∈ s.heap ++ _
        rw [e]; exact List.mem_append_left _ (g4 hmk q hq')
  · rename_i hmk
    exact ⟨⟨g1, g2, g3', fun h' => absurd (by simpa using hmk) h'⟩, ho, hc, hd, hs⟩

-- delete keeps what order keeps
theorem inv_delete {s : State α} (h : inv n s) (p : α) : inv n (delete s p) := by
  obtain ⟨⟨g1, g2, g3, g4⟩, ho, hc, hd, hs⟩ := h
  unfold delete
  split
  · exact ⟨⟨g1, g2, g3, g4⟩, ho, hc, hd, hs⟩
  · refine ⟨⟨g1, g2, ?_, ?_⟩, ho, hc, hd, hs⟩
    · intro q hq
      have hq' : update s.due p 0 q ≠ 0 := hq
      by_cases hqp : q = p
      · subst hqp; simp at hq'
      · rw [update_ne _ _ hqp] at hq'; exact g3 q hq'
    · intro hm q hq
      have hq' : update s.due p 0 q ≠ 0 := hq
      by_cases hqp : q = p
      · subst hqp; simp at hq'
      · have e : update s.due p 0 q = s.due q := update_ne _ _ hqp
        rw [e] at hq'
        show (⟨q, rankOf s q, update s.due p 0 q⟩ : Entry α) ∈ s.heap
        rw [e]; exact g4 hm q hq'

end calls

section goes

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- gone's first loop: only afters change; each one of l counts p once less
theorem unties_spec (p : α) : ∀ (l : List α) (s : State α), l.Nodup →
    (∃ af, l.foldl (fun s q => untie s p q) s = { s with afters := af }) ∧
    ∀ q y, cnt (l.foldl (fun s q => untie s p q) s) q y =
      if y = p ∧ q ∈ l then cnt s q y - 1 else cnt s q y
  | [], s, _ => ⟨⟨s.afters, rfl⟩, fun q y => by simp⟩
  | a :: l, s, hl => by
    have ha : a ∉ l := (List.nodup_cons.1 hl).1
    simp only [List.foldl_cons]
    obtain ⟨af1, e1⟩ := untie_eq s p a
    obtain ⟨⟨af, e⟩, c⟩ := unties_spec p l (untie s p a) (List.nodup_cons.1 hl).2
    refine ⟨⟨af, by rw [e, e1]⟩, fun q y => ?_⟩
    rw [c, untie_cnt]
    by_cases h1 : q = a
    · subst h1; by_cases h2 : y = p <;> simp [h2, ha]
    · by_cases h2 : y = p <;> simp [h1, h2]

-- forget: p after nothing; the counts of what p was after, one less for each edge
theorem forget_spec (s : State α) (p : α) (hv : (s.values p).Nodup) :
    ∃ af, forget s p = { s with
        values := update s.values p [], after := update s.after p none, afters := af } ∧
      ∀ q y, cnt { s with afters := af } q y = if y = p then
        cnt s q p - (if q ∈ s.values p then 1 else 0) - (if s.after p = some q then 1 else 0)
        else cnt s q y := by
  obtain ⟨⟨af3, e3⟩, c3⟩ := unties_spec p (s.values p) s hv
  unfold forget
  dsimp only
  rw [e3]
  dsimp only
  have c3' : ∀ q y, cnt { s with afters := af3 } q y =
      if y = p ∧ q ∈ s.values p then cnt s q y - 1 else cnt s q y := by
    intro q y; rw [← c3, e3]
  cases ha : s.after p with
  | none =>
    refine ⟨af3, rfl, fun q y => ?_⟩
    rw [c3']
    by_cases hy : y = p
    · subst hy; by_cases hq : q ∈ s.values y <;> simp [hq]
    · simp [hy]
  | some a =>
    obtain ⟨af5, e5⟩ := untie_eq { s with values := update s.values p [], afters := af3 } p a
    dsimp only
    simp only [e5]
    refine ⟨af5, rfl, fun q y => ?_⟩
    have h5 : cnt { s with afters := af5 } q y =
        cnt (untie { s with values := update s.values p [], afters := af3 } p a) q y := by
      rw [e5]; rfl
    rw [h5, untie_cnt]
    have h3 : cnt { s with values := update s.values p [], afters := af3 } q y =
        cnt { s with afters := af3 } q y := rfl
    rw [h3, c3']
    by_cases hy : y = p
    · subst hy
      by_cases hq : q ∈ s.values y <;> by_cases hqa : q = a
      · subst hqa; simp [hq]
      · simp [hq, hqa, Ne.symm hqa]
      · subst hqa; simp [hq]
      · simp [hq, hqa, Ne.symm hqa]
    · simp [hy]

theorem gone_shape (rk : Rk α) (all : List α) (s : State α) (p : α) (hv : (s.values p).Nodup) :
    ∃ (af : α → Option (List (α × Nat))) (cn d : Nat),
      gone n rk all s p = (match af p with
        | some m => if s.members p then «local» n rk all { s with
            alive := update s.alive p false, due := update s.due p 0, dues := d,
            values := update s.values p [], after := update s.after p none, count := cn,
            ranked := update s.ranked p 0, afters := update af p none,
            members := update s.members p false } (keys (some m))
          else { s with
            alive := update s.alive p false, due := update s.due p 0, dues := d,
            values := update s.values p [], after := update s.after p none, count := cn,
            ranked := update s.ranked p 0, afters := update af p none,
            members := update s.members p false }
        | none => { s with
            alive := update s.alive p false, due := update s.due p 0, dues := d,
            values := update s.values p [], after := update s.after p none, count := cn,
            ranked := update s.ranked p 0, afters := update af p none,
            members := update s.members p false }) ∧
      ∀ q y, cnt { s with afters := af } q y = if y = p then
        cnt s q p - (if q ∈ s.values p then 1 else 0) - (if s.after p = some q then 1 else 0)
        else cnt s q y := by
  obtain ⟨af, e, c⟩ := forget_spec { s with
    alive := update s.alive p false, due := update s.due p 0,
    dues := if s.due p ≠ 0 then s.dues - 1 else s.dues } p hv
  refine ⟨af, if s.ranked p = s.making ∧ s.making ≠ 0 then s.count - 1 else s.count,
    if s.due p ≠ 0 then s.dues - 1 else s.dues, ?_, fun q y => c q y⟩
  unfold gone
  dsimp only
  rw [e]

-- gone keeps what order keeps: a path lost went through p, so p was a cycle's member, and its
-- afters are ranked again
theorem inv_gone {rk : Rk α} {all : List α} {s : State α} (h : inv n s) (p : α)
    (hk : sound rk (update s.alive p false))
    (hall : ∀ q, update s.alive p false q = true → q ∈ all) :
    inv n (gone n rk all s p) := by
  obtain ⟨af, cn, d, e, hcnt⟩ := gone_shape n rk all s p (h.nodup p)
  rw [e]
  generalize htt : ({ s with
    alive := update s.alive p false, due := update s.due p 0, dues := d,
    values := update s.values p [], after := update s.after p none, count := cn,
    ranked := update s.ranked p 0, afters := update af p none,
    members := update s.members p false } : State α) = t
  have ta : t.alive = update s.alive p false := by rw [← htt]
  have tm : t.making = s.making := by rw [← htt]
  have tmb : t.members = update s.members p false := by rw [← htt]
  have hr : ∀ q, q ≠ p → rankOf t q = rankOf s q := by
    intro q hq; rw [← htt]; simp [rankOf, update_ne _ _ hq]
  have hap : t.alive p = false := by rw [ta]; simp
  have hal : ∀ x, t.alive x = true → x ≠ p ∧ s.alive x = true := by
    intro x hx
    have hxp : x ≠ p := by rintro rfl; rw [hap] at hx; cases hx
    rw [ta, update_ne _ _ hxp] at hx; exact ⟨hxp, hx⟩
  have hlt : ∀ x y, x ≠ p → y ≠ p → link t x y = link s x y := by
    intro x y hx hy; rw [← htt]; simp [link, edge, update_ne _ _ hx, update_ne _ _ hy]
  have hl0 : ∀ x, link t x p = false := by
    intro x; rw [← htt]; simp [link, edge]
  -- lk of t: lk of s away from p
  have hlk : ∀ a b, lk t a b = true → lk s a b = true ∧ a ≠ p ∧ b ≠ p := by
    intro a b hab
    obtain ⟨ha, hb⟩ := lk_alive hab
    obtain ⟨hap', has⟩ := hal a ha
    obtain ⟨hbp, -⟩ := hal b hb
    refine ⟨?_, hap', hbp⟩
    have := lk_link hab
    rw [hlt a b hap' hbp] at this
    simp [lk, has, this]
  have hlk' : ∀ a b, lk s a b = true → a ≠ p → b ≠ p → lk t a b = true := by
    intro a b hab ha hb
    have := lk_link hab
    rw [← hlt a b ha hb] at this
    simp [lk, ta, update_ne _ _ ha, (lk_alive hab).1, this]
  have nop : ∀ a, ¬ lk t a p = true := fun a hab => (hlk a p hab).2.2 rfl
  have hP : ∀ a b, path t a b → path s a b := fun a b => tg_mono fun a b h => (hlk a b h).1
  -- one after p: among p's afters' keys
  have hin : ∀ x, link s x p = true → x ∈ keys (af p) := by
    intro x hx
    have hxp : x ≠ p := fun e => link_ne s hx e.symm
    have h0 := h.counted p (link_alive s x p hx) x
    have h1 := hcnt p x
    rw [ite_eq_right_iff.2 (fun h => absurd h hxp)] at h1
    apply cnt_keys (s := { s with afters := af })
    rw [h1, h0]
    simp only [link, Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq] at hx
    rcases hx.2 with h2 | h2 <;> simp [h2]
  obtain ⟨g1, g2, g3, g4⟩ := h.good
  have gt : good n t := by
    refine ⟨by rw [← htt]; exact g1, by rw [← htt]; exact g2, fun q hq => ?_, fun hm q hq => ?_⟩
    · have hq' : update s.due p 0 q ≠ 0 := by rw [← htt] at hq; exact hq
      have hqp : q ≠ p := by rintro rfl; simp at hq'
      rw [update_ne _ _ hqp] at hq'
      rw [ta, update_ne _ _ hqp]; exact g3 q hq'
    · have hq' : update s.due p 0 q ≠ 0 := by rw [← htt] at hq; exact hq
      have hqp : q ≠ p := by rintro rfl; simp at hq'
      rw [update_ne _ _ hqp] at hq'
      rw [hr q hqp]
      have := g4 (by rw [← tm]; exact hm) q hq'
      rw [← htt]
      show (⟨q, rankOf s q, update s.due p 0 q⟩ : Entry α) ∈ s.heap
      rw [update_ne _ _ hqp]; exact this
  have ct : counted t := by
    intro q hq y
    obtain ⟨hqp, hqa⟩ := hal q hq
    have e1 : cnt t q y = cnt { s with afters := af } q y := by
      rw [← htt]; simp [cnt, update_ne _ _ hqp]
    rw [e1, hcnt]
    have h0 := h.counted q hqa
    have tv : t.values = update s.values p [] := by rw [← htt]
    have tf : t.after = update s.after p none := by rw [← htt]
    rw [tv, tf]
    by_cases hy : y = p
    · rw [hy, h0 p]; simp
    · simp only [hy, ↓reduceIte, update_ne _ _ hy]; exact h0 y
  have dt : ∀ x, (t.values x).Nodup := by
    intro x; rw [← htt]; simp only [update]; split
    · exact List.nodup_nil
    · exact h.nodup x
  have st : ∀ q, t.stamp q ≤ t.stamps := by rw [← htt]; exact h.stamped
  have hk' : sound rk t.alive := by rw [ta]; exact hk
  have hall' : ∀ q, t.alive q = true → q ∈ all := by rw [ta]; exact hall
  -- one not fine: it lost a path through p; it reaches one of p's afters' keys, and p was on a
  -- cycle
  have lost : s.making ≠ 0 → ∀ x, ¬ fine t x →
      (∃ z ∈ keys (af p), reaches (fun a b => lk t a b = true) x z) ∧ path s p p := by
    intro hm x hx
    obtain ⟨o1, -⟩ := h.ok hm
    refine Classical.byContradiction fun hE => hx fun y hy => ?_
    obtain ⟨hy', hxp, hyp⟩ := hlk x y hy
    obtain ⟨f1, f2⟩ := o1 x y hy'
    rw [hr x hxp, hr y hyp]
    refine ⟨f1, fun hn => f2 fun hyx => ?_⟩
    rcases thru p (fun a c h ha hc => hlk' a c h ha hc) nop hyx hyp with h1 | ⟨⟨z, hz, hzp⟩, h2⟩
    · exact hn h1
    · exfalso
      refine hE ⟨⟨z, hin z (lk_link hzp), reaches_cons hy hz⟩, ?_⟩
      have hyz : reaches (fun a b => lk s a b = true) y z := by
        rcases hz with rfl | hz
        · exact .inl rfl
        · exact .inr (tg_mono (fun a b h => (hlk a b h).1) hz)
      have hyp' : path s y p := by
        rcases hyz with rfl | hyz
        · exact .single hzp
        · exact .tail hyz hzp
      rcases h2 with rfl | h2
      · exact Relation.TransGen.trans (.single hy') hyp'
      · exact h2.trans (Relation.TransGen.trans (.single hy') hyp')
  have cyc : s.making ≠ 0 → ∀ x, path t x x → t.members x = true := by
    intro hm x hx
    obtain ⟨-, o2⟩ := h.ok hm
    obtain ⟨hxp, -⟩ := hal x (path_alive hx).1
    rw [tmb, update_ne _ _ hxp]
    exact o2 x (hP x x hx)
  -- t itself, when nothing reaches p's afters or p was no member
  have plain : (∀ hm : s.making ≠ 0, ∀ x, ¬ fine t x → False) → inv n t := by
    intro hf
    refine ⟨gt, fun hm => ?_, ct, dt, st⟩
    have hm' : s.making ≠ 0 := by rwa [← tm]
    exact ⟨fun x => Classical.byContradiction (hf hm' x), cyc hm'⟩
  cases hm : af p with
  | none =>
    simp only
    apply plain
    intro hm' x hx
    obtain ⟨⟨z, hz, -⟩, -⟩ := lost hm' x hx
    rw [hm] at hz; simp [keys] at hz
  | some m =>
    simp only
    split
    · rename_i hmem
      obtain ⟨cn', rk', rd, mb, hp, e'⟩ := local_eq n rk all t (keys (some m))
      obtain ⟨gu, ou⟩ := local_inv n (start := keys (some m)) hk' hall' gt ct
        (fun hm' x hx => by
          obtain ⟨⟨z, hz, hr'⟩, -⟩ := lost (by rwa [← tm]) x hx
          rw [hm] at hz
          exact ⟨z, hz, hr'⟩)
        (fun hm' x hx => .inl (cyc (by rwa [← tm]) x hx))
      rw [e']
      exact ⟨by rw [← e']; exact gu, by rw [← e']; exact ou, ct, dt, st⟩
    · rename_i hmem
      apply plain
      intro hm' x hx
      obtain ⟨-, hpp⟩ := lost hm' x hx
      exact hmem ((h.ok hm').2 p hpp)

end goes

/-! ## next -/


section next

variable {α : Type} [DecidableEq α] (n : α → Nat)

omit [DecidableEq α] in
-- remake: a heap of every due one in all, at its rank now
theorem remake_good (all : List α) {s : State α} (hd : ∀ p, s.due p ≠ 0 → s.alive p = true)
    (hall : ∀ p, s.alive p = true → p ∈ all) : good n (remake n all s) := by
  have hm : ∀ e, e ∈ (remake n all s).heap ↔ ∃ p ∈ all, s.due p ≠ 0 ∧
      e = ⟨p, rankOf s p, s.due p⟩ := by
    intro e
    show e ∈ all.foldl _ [] ↔ _
    rw [pushif_mem (less := less n) (fun p => s.due p ≠ 0) (fun p => ⟨p, rankOf s p, s.due p⟩)]
    simp
  refine ⟨?_, ?_, hd, fun _ p hp => (hm _).2 ⟨p, hall p (hd p hp), hp, rfl⟩⟩
  · show heap (less n) (all.foldl _ [])
    exact pushif_heap (less_weak n) (fun p => s.due p ≠ 0) _ all [] (by intro j x y hx; simp at hx)
  · intro e he
    obtain ⟨p, -, hp, rfl⟩ := (hm e).1 he
    exact hp

-- a path along link from an alive one is one along lk
theorem link_path {s : State α} {a b : α} (h : Relation.TransGen (fun x y => link s x y = true) a b)
    (ha : s.alive a = true) : path s a b := by
  induction h with
  | single h => exact .single (by simp [lk, ha, h])
  | tail _ h ih => exact .tail ih (by simp [lk, (path_alive ih).2, h])

-- ranks: made whole when none, so there after; what order keeps, kept; ranks there kept
theorem ranks_inv {rk : Rk α} {s : State α} (h : inv n s) (hk : sound rk s.alive) {all : List α}
    (hall : ∀ p, s.alive p = true → p ∈ all) :
    let t := ranks n rk all s
    t.making ≠ 0 ∧ inv n t ∧ t.alive = s.alive ∧ t.values = s.values ∧ t.after = s.after ∧
      t.due = s.due ∧ t.afters = s.afters ∧ (s.making ≠ 0 → rankOf t = rankOf s) := by
  intro t
  unfold t ranks
  split
  · rename_i hm; exact ⟨hm, h, rfl, rfl, rfl, rfl, rfl, fun _ => rfl⟩
  · rename_i hm
    dsimp only
    generalize hr : rk s.alive (link s) (fun _ => 0) = r
    have rk1 := hk.ranked s.alive (link s) (fun _ => 0) (fun _ h => h) (link_alive s)
    rw [hr] at rk1
    generalize hu : ({ s with
      making := s.made + 1, made := s.made + 1, count := (all.filter s.alive).length,
      rank := fun p => if s.alive p then r p else s.rank p,
      ranked := fun p => if s.alive p then s.made + 1 else s.ranked p,
      members := fun p => (s.alive p && (edges s p).any fun q => r q == r p) ||
        all.any fun q => s.alive q && decide (p ∈ edges s q) && r q == r p } : State α) = u
    have hl : lk u = lk s := by rw [← hu]; exact lk_eq rfl rfl rfl
    have hP : path u = path s := by unfold path; rw [hl]
    have hro : ∀ p, s.alive p = true → rankOf u p = r p := by
      intro p hp; rw [← hu]; simp [rankOf, hp]
    have ua : u.alive = s.alive := by rw [← hu]
    have um : u.making = s.made + 1 := by rw [← hu]
    have fu : ∀ x, fine u x := by
      intro x y hy
      rw [hl] at hy
      obtain ⟨hxa, hya⟩ := lk_alive hy
      rw [hro x hxa, hro y hya, hP]
      obtain ⟨f1, f2⟩ := rk1 x y hxa (lk_link hy)
      exact ⟨f1, fun hn => f2 fun t' => hn (link_path t' hya)⟩
    have ou : ok u := by
      intro _
      refine ⟨fu, fun x hx => ?_⟩
      rw [hP] at hx
      obtain ⟨c, hxc, hc⟩ := tg_head hx
      rcases hc with rfl | hcx
      · exact absurd rfl (lk_ne hxc)
      · obtain ⟨hxa, hca⟩ := lk_alive hxc
        have e1 := (fu x c (by rw [hl]; exact hxc)).1
        have e2 := fine_path fu (show path u c x by rw [hP]; exact hcx)
        rw [hro x hxa, hro c hca] at e1 e2
        rw [← hu]
        simp only [hxa, Bool.true_and, Bool.or_eq_true, List.any_eq_true, beq_iff_eq]
        exact .inl ⟨c, mem_edges.2 (lk_link hxc), by omega⟩
    have gu : good n (remake n all u) := by
      refine remake_good n all (fun p hp => ?_) (fun p hp => ?_)
      · have : u.due = s.due := by rw [← hu]
        rw [ua]; exact h.good.2.2.1 p (by rw [← this]; exact hp)
      · exact hall p (by rw [← ua]; exact hp)
    refine ⟨by show u.making ≠ 0; rw [um]; omega, ⟨gu, ou, ?_, ?_, ?_⟩, ?_, ?_, ?_, ?_, ?_,
      fun h' => absurd h' hm⟩
    all_goals first
      | (show counted u; rw [← hu]; exact h.counted)
      | (show ∀ x, (u.values x).Nodup; rw [← hu]; exact h.nodup)
      | (show ∀ q, u.stamp q ≤ u.stamps; rw [← hu]; exact h.stamped)
      | (show u.alive = s.alive; exact ua)
      | (show u.values = s.values; rw [← hu])
      | (show u.after = s.after; rw [← hu])
      | (show u.due = s.due; rw [← hu])
      | (show u.afters = s.afters; rw [← hu])

-- next up to its loop: ranks there, what order keeps kept, the computations untouched, ranks there
-- kept
theorem ready_inv {rk : Rk α} {s : State α} (h : inv n s) (hk : sound rk s.alive) {all : List α}
    (hall : ∀ p, s.alive p = true → p ∈ all) :
    let t := ready n rk all s
    t.making ≠ 0 ∧ inv n t ∧ t.alive = s.alive ∧ t.values = s.values ∧ t.after = s.after ∧
      t.due = s.due ∧ t.afters = s.afters ∧ (s.making ≠ 0 → rankOf t = rankOf s) := by
  obtain ⟨m1, i1, a1, v1, f1, d1, af1, r1⟩ := ranks_inv n h hk hall
  intro t
  unfold t ready
  dsimp only
  generalize ranks n rk all s = u at m1 i1 a1 v1 f1 d1 af1 r1
  split
  · refine ⟨m1, ⟨?_, i1.ok, i1.counted, i1.nodup, i1.stamped⟩, a1, v1, f1, d1, af1, r1⟩
    exact remake_good n all i1.good.2.2.1 (fun p hp => hall p (by rw [← a1]; exact hp))
  · exact ⟨m1, i1, a1, v1, f1, d1, af1, r1⟩

-- next's state: ready's ranks, and the heap
theorem next_rank (rk : Rk α) (all : List α) (s : State α) :
    rankOf (next n rk all s).2 = rankOf (ready n rk all s) := rfl

theorem pop_mem {E : Type} {less : E → E → Bool} {h h' : List E} {t e : E}
    (hp : pop less h = (some t, h')) : e ∈ h ↔ e = t ∨ e ∈ h' := by
  rw [← (pop_perm hp).mem_iff]; simp

omit [DecidableEq α] in
theorem scan_spec (s : State α) (h w : List (Entry α)) (b : Option (Entry α))
    (h' w' : List (Entry α)) :
    scan n s h w = (b, h', w') → heap (less n) h →
    heap (less n) h' ∧
    (∀ e ∈ h, e ∈ h' ∨ e ∈ w' ∨ b = some e ∨ current s e = false) ∧
    (∀ e ∈ w, e ∈ w') ∧
    (∀ e ∈ h', e ∈ h) ∧
    (∀ e ∈ w', e ∈ h ∨ e ∈ w) ∧
    (∀ x, b = some x → x ∈ h ∧ current s x = true ∧ waiting s x.p = false ∧
      ∀ e ∈ h, current s e = true → waiting s e.p = false → less n e x = false) ∧
    (b = none → ∀ e ∈ h, current s e = true → waiting s e.p = true) := by
  fun_induction scan n s h w with
  | case1 h w h0 hp =>
    intro he _
    simp only [Prod.mk.injEq] at he
    obtain ⟨rfl, rfl, rfl⟩ := he
    have := pop_none hp; subst this
    simp_all
  | case2 h w t hp' hp hs ih =>
    intro he hh
    have hh' : heap (less n) hp' := by
      have := pop_heap (less_weak n) hh; rw [hp] at this; exact this
    obtain ⟨i1, i2, i3, i4, i5, i6, i7⟩ := ih he hh'
    refine ⟨i1, ?_, i3, ?_, ?_, ?_, ?_⟩
    · intro e he
      rcases (pop_mem hp).mp he with rfl | he
      · exact Or.inr (Or.inr (Or.inr hs))
      · exact i2 e he
    · intro e he; exact (pop_mem hp).mpr (Or.inr (i4 e he))
    · intro e he
      rcases i5 e he with he | he
      · exact Or.inl ((pop_mem hp).mpr (Or.inr he))
      · exact Or.inr he
    · intro x hx
      obtain ⟨j1, j2, j3, j4⟩ := i6 x hx
      refine ⟨(pop_mem hp).mpr (Or.inr j1), j2, j3, ?_⟩
      intro e he hd hw
      rcases (pop_mem hp).mp he with rfl | he
      · rw [hs] at hd; cases hd
      · exact j4 e he hd hw
    · intro hb e he hd
      rcases (pop_mem hp).mp he with rfl | he
      · rw [hs] at hd; cases hd
      · exact i7 hb e he hd
  | case3 h w t hp' hp hs hwt ih =>
    intro he hh
    have hh' : heap (less n) hp' := by
      have := pop_heap (less_weak n) hh; rw [hp] at this; exact this
    obtain ⟨i1, i2, i3, i4, i5, i6, i7⟩ := ih he hh'
    refine ⟨i1, ?_, ?_, ?_, ?_, ?_, ?_⟩
    · intro e he
      rcases (pop_mem hp).mp he with rfl | he
      · exact Or.inr (Or.inl (i3 e (by simp)))
      · exact i2 e he
    · intro e he; exact i3 e (by simp [he])
    · intro e he; exact (pop_mem hp).mpr (Or.inr (i4 e he))
    · intro e he
      rcases i5 e he with he | he
      · exact Or.inl ((pop_mem hp).mpr (Or.inr he))
      · simp at he
        rcases he with he | rfl
        · exact Or.inr he
        · exact Or.inl ((pop_mem hp).mpr (Or.inl rfl))
    · intro x hx
      obtain ⟨j1, j2, j3, j4⟩ := i6 x hx
      refine ⟨(pop_mem hp).mpr (Or.inr j1), j2, j3, ?_⟩
      intro e he hd hw
      rcases (pop_mem hp).mp he with rfl | he
      · rw [hwt] at hw; cases hw
      · exact j4 e he hd hw
    · intro hb e he hd
      rcases (pop_mem hp).mp he with rfl | he
      · exact hwt
      · exact i7 hb e he hd
  | case4 h w t hp' hp hs hwt =>
    intro he hh
    simp only [Prod.mk.injEq] at he
    obtain ⟨rfl, rfl, rfl⟩ := he
    have hh' : heap (less n) hp' := by
      have := pop_heap (less_weak n) hh; rw [hp] at this; exact this
    refine ⟨hh', ?_, fun e he => he, fun e he => (pop_mem hp).mpr (Or.inr he),
      fun e he => Or.inr he, ?_, ?_⟩
    · intro e he
      rcases (pop_mem hp).mp he with rfl | he
      · exact Or.inr (Or.inr (Or.inl rfl))
      · exact Or.inl he
    · intro x hx
      cases hx
      refine ⟨(pop_mem hp).mpr (Or.inl rfl), by simpa using hs, by simpa using hwt, ?_⟩
      intro e he _ _
      exact pop_least (less_weak n) hh hp e he
    · intro hb; cases hb

omit [DecidableEq α] in
theorem waiting_eq {s t : State α} (h1 : t.after = s.after) (h2 : t.due = s.due) :
    waiting t = waiting s := by
  funext p; simp [waiting, h1, h2]

omit [DecidableEq α] in
-- the entry of a due one at its rank now is current
theorem current_entry (s : State α) (p : α) : current s ⟨p, rankOf s p, s.due p⟩ = true := by
  simp [current]

-- next's choice: due, not waiting after a due one, at its rank now, which is rank.ts's over the
-- edges now; and before no other such by (rank, mark, n)
theorem next_least {rk : Rk α} {s : State α} (h : inv n s) (hk : sound rk s.alive) {all : List α}
    (hall : ∀ p, s.alive p = true → p ∈ all) {p : α} {k : Nat}
    (hb : (next n rk all s).1 = some (p, k)) :
    s.due p ≠ 0 ∧ waiting s p = false ∧ k = rankOf (next n rk all s).2 p ∧
      ∀ q, s.due q ≠ 0 → waiting s q = false →
        ¬ before (rankOf (next n rk all s).2 q, s.due q, n q) (k, s.due p, n p) := by
  obtain ⟨m1, i1, a1, v1, f1, d1, -⟩ := ready_inv n h hk hall
  rw [next_rank]
  generalize ht : ready n rk all s = t at m1 i1 a1 v1 f1 d1
  have hw : waiting t = waiting s := waiting_eq f1 d1
  unfold next at hb
  rw [ht] at hb
  simp only at hb
  generalize hs : scan n t t.heap [] = l at hb
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨-, -, -, -, -, i6, -⟩ := scan_spec n t _ _ _ _ _ hs i1.good.1
  cases b with
  | none => simp at hb
  | some x =>
    simp only [Option.map_some, Option.some.injEq, Prod.mk.injEq] at hb
    obtain ⟨rfl, rfl⟩ := hb
    obtain ⟨j1, j2, j3, j4⟩ := i6 x rfl
    simp only [current, Bool.and_eq_true, decide_eq_true_eq] at j2
    obtain ⟨jd, jr⟩ := j2
    have hd : s.due x.p ≠ 0 := by rw [← d1, jd]; exact i1.good.2.1 x j1
    refine ⟨hd, by rw [← hw]; exact j3, jr.symm, ?_⟩
    intro q hq hwq
    have he := i1.good.2.2.2 m1 q (by rw [d1]; exact hq)
    have := j4 _ he (current_entry t q) (by rw [hw]; exact hwq)
    rw [less_false] at this
    simp only at this
    rw [d1, ← jd, d1] at this
    exact this

-- next gives none only when every due one waits after a due one
theorem next_none {rk : Rk α} {s : State α} (h : inv n s) (hk : sound rk s.alive) {all : List α}
    (hall : ∀ p, s.alive p = true → p ∈ all) (hb : (next n rk all s).1 = none) :
    ∀ q, s.due q ≠ 0 → waiting s q = true := by
  obtain ⟨m1, i1, -, -, f1, d1, -⟩ := ready_inv n h hk hall
  generalize ht : ready n rk all s = t at m1 i1 f1 d1
  have hw : waiting t = waiting s := waiting_eq f1 d1
  unfold next at hb
  rw [ht] at hb
  simp only at hb
  generalize hs : scan n t t.heap [] = l at hb
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨-, -, -, -, -, -, i7⟩ := scan_spec n t _ _ _ _ _ hs i1.good.1
  cases b with
  | some x => simp at hb
  | none =>
    intro q hq
    have he := i1.good.2.2.2 m1 q (by rw [d1]; exact hq)
    rw [← hw]; exact i7 rfl _ he (current_entry t q)

-- the ranks next ranks by: Basic.lean's ranked over lk (next changes no edge), and the ranks of
-- before when there were any
theorem next_ranked {rk : Rk α} {s : State α} (h : inv n s) (hk : sound rk s.alive)
    {all : List α} (hall : ∀ p, s.alive p = true → p ∈ all) :
    _root_.ranked (fun x y => lk s x y = true) (rankOf (next n rk all s).2) ∧
      (s.making ≠ 0 → rankOf (next n rk all s).2 = rankOf s) := by
  obtain ⟨m1, i1, a1, v1, f1, -, -, r1⟩ := ready_inv n h hk hall
  rw [next_rank]
  refine ⟨?_, r1⟩
  have := ranked_of i1.ok m1
  rwa [lk_eq a1 v1 f1] at this

-- next keeps what order keeps: the waiting pushed back, the best gone until the scheduler
-- deletes it (first: order.delete); the computations untouched
theorem inv_next {rk : Rk α} {s : State α} (h : inv n s) (hk : sound rk s.alive) {all : List α}
    (hall : ∀ p, s.alive p = true → p ∈ all) :
    let o := next n rk all s
    o.2.alive = s.alive ∧ o.2.values = s.values ∧ o.2.after = s.after ∧ o.2.due = s.due ∧
      o.2.afters = s.afters ∧
      match o.1 with
      | some (p, _) => inv n (delete o.2 p)
      | none => inv n o.2 := by
  obtain ⟨m1, i1, a1, v1, f1, d1, af1, -⟩ := ready_inv n h hk hall
  intro o
  unfold o next
  dsimp only
  generalize ht : ready n rk all s = t at m1 i1 a1 v1 f1 d1 af1
  generalize hs : scan n t t.heap [] = l
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨i1', i2, -, i4, i5, i6, -⟩ := scan_spec n t _ _ _ _ _ hs i1.good.1
  refine ⟨a1, v1, f1, d1, af1, ?_⟩
  have hfin : ∀ e, e ∈ w'.foldl (push (less n)) h' ↔ e ∈ h' ∨ e ∈ w' := by
    intro e; rw [(pushall_perm w' h').mem_iff]; simp
  have back : ∀ e, e ∈ w'.foldl (push (less n)) h' → e ∈ t.heap := by
    intro e he
    rcases (hfin e).mp he with he | he
    · exact i4 e he
    · rcases i5 e he with he | he
      · exact he
      · simp at he
  have hh := pushall_heap (less_weak n) w' h' i1'
  obtain ⟨⟨g1, g2, g3, g4⟩, r1, c1, n1, s1⟩ := i1
  have keep : ∀ q, t.due q ≠ 0 → b ≠ some ⟨q, rankOf t q, t.due q⟩ →
      (⟨q, rankOf t q, t.due q⟩ : Entry α) ∈ w'.foldl (push (less n)) h' := by
    intro q hq hbq
    rcases i2 _ (g4 m1 q hq) with e | e | e | e
    · exact (hfin _).2 (.inl e)
    · exact (hfin _).2 (.inr e)
    · exact absurd e hbq
    · rw [current_entry] at e; cases e
  cases b with
  | some x =>
    simp only [Option.map_some]
    obtain ⟨j1, j2, -, -⟩ := i6 x rfl
    simp only [current, Bool.and_eq_true, decide_eq_true_eq] at j2
    have hdx : t.due x.p ≠ 0 := by rw [j2.1]; exact g2 x j1
    unfold delete
    dsimp only
    rw [ite_eq_right_iff.2 (fun e => absurd e hdx)]
    refine ⟨⟨hh, fun e he => g2 e (back e he), fun q hq => ?_, fun _ q hq => ?_⟩, r1, c1, n1, s1⟩
    · have hq' : update t.due x.p 0 q ≠ 0 := hq
      have hqx : q ≠ x.p := by rintro rfl; simp at hq'
      rw [update_ne _ _ hqx] at hq'; exact g3 q hq'
    · have hq' : update t.due x.p 0 q ≠ 0 := hq
      have hqx : q ≠ x.p := by rintro rfl; simp at hq'
      have e : update t.due x.p 0 q = t.due q := update_ne _ _ hqx
      rw [e] at hq'
      show (⟨q, rankOf t q, update t.due x.p 0 q⟩ : Entry α) ∈ _
      rw [e]
      exact keep q hq' (by rintro ⟨⟩; exact hqx rfl)
  | none =>
    simp only [Option.map_none]
    exact ⟨⟨hh, fun e he => g2 e (back e he), g3, fun _ q hq => keep q hq (by simp)⟩, r1, c1, n1,
      s1⟩

end next

/-! ## next is total (lemma N's core) -/

section total

variable {α : Type} [DecidableEq α]

-- following after through the due: p due, after q, q due
def step (s : State α) (p q : α) : Prop := s.due p ≠ 0 ∧ s.after p = some q ∧ s.due q ≠ 0

omit [DecidableEq α] in
theorem waiting_true {s : State α} {p : α} (h : waiting s p = true) :
    ∃ q, s.after p = some q ∧ s.due q ≠ 0 := by
  unfold waiting at h
  split at h
  · exact ⟨_, ‹_›, by simpa using h⟩
  · cases h

omit [DecidableEq α] in
-- the walk along after from x, seen the due before it on the walk: it ends at a due one not
-- waiting, within as many steps as all holds (all holds every due one)
theorem walk {s : State α} {all : List α} (hall : ∀ p, s.due p ≠ 0 → p ∈ all)
    (acyclic : ∀ p, ¬ Relation.TransGen (step s) p p) :
    ∀ (k : Nat) (x : α) (seen : List α), all.length ≤ seen.length + k →
      seen.Nodup → (∀ y ∈ seen, s.due y ≠ 0) →
      (∀ y ∈ seen, Relation.TransGen (step s) y x) → s.due x ≠ 0 →
      ∃ p, s.due p ≠ 0 ∧ waiting s p = false := by
  intro k
  induction k with
  | zero =>
    intro x seen hk hnd hdue hreach hx
    cases hw : waiting s x with
    | false => exact ⟨x, hx, hw⟩
    | true =>
      exfalso
      have hxs : x ∉ seen := fun h => acyclic x (hreach x h)
      have hsub : (x :: seen) ⊆ all := by
        intro y hy
        rcases List.mem_cons.mp hy with rfl | hy
        · exact hall y hx
        · exact hall y (hdue y hy)
      have := List.Nodup.length_le_of_subset (List.nodup_cons.mpr ⟨hxs, hnd⟩) hsub
      simp only [List.length_cons] at this; omega
  | succ k ih =>
    intro x seen hk hnd hdue hreach hx
    cases hw : waiting s x with
    | false => exact ⟨x, hx, hw⟩
    | true =>
      obtain ⟨y, hy, hyd⟩ := waiting_true hw
      have hst : step s x y := ⟨hx, hy, hyd⟩
      have hxs : x ∉ seen := fun h => acyclic x (hreach x h)
      refine ih y (x :: seen) (by simp only [List.length_cons]; omega)
        (List.nodup_cons.mpr ⟨hxs, hnd⟩) ?_ ?_ hyd
      · intro z hz
        rcases List.mem_cons.mp hz with rfl | hz
        · exact hx
        · exact hdue z hz
      · intro z hz
        rcases List.mem_cons.mp hz with rfl | hz
        · exact .single hst
        · exact .tail (hreach z hz) hst

omit [DecidableEq α] in
-- some due one is not waiting after a due one, when one is due and following after through the
-- due has no cycle
theorem total {s : State α} {all : List α} (hall : ∀ p, s.due p ≠ 0 → p ∈ all)
    (hne : ∃ p, s.due p ≠ 0) (acyclic : ∀ p, ¬ Relation.TransGen (step s) p p) :
    ∃ p, s.due p ≠ 0 ∧ waiting s p = false := by
  obtain ⟨p, hp⟩ := hne
  exact walk hall acyclic all.length p [] (by simp) List.nodup_nil (by simp) (by simp) hp

-- so best! is defined: next gives a computation whenever one is due, given no after cycle
theorem next_total (n : α → Nat) {rk : Rk α} {s : State α}
    (h : inv n s) (hk : sound rk s.alive) {all : List α}
    (hall : ∀ p, s.alive p = true → p ∈ all) (hne : ∃ p, s.due p ≠ 0)
    (acyclic : ∀ p, ¬ Relation.TransGen (step s) p p) :
    ∃ p k, (next n rk all s).1 = some (p, k) := by
  cases hb : (next n rk all s).1 with
  | some x => exact ⟨x.1, x.2, rfl⟩
  | none =>
    obtain ⟨p, hp, hw⟩ := total (fun q hq => hall q (h.good.2.2.1 q hq)) hne acyclic
    have := next_none n h hk hall hb p hp
    rw [hw] at this; cases this

end total

end Order
