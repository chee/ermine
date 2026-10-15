-- LLM generated working output
-- order.ts in Lean: the heap, next, set, and the ranks: made whole once (rank.ts is rk), then
-- mended where an edge changed.
--
-- proved:
--   the heap: push_perm, push_heap, pop_perm, pop_heap, pop_least (pop gives a least entry)
--   mend: go_fix, mend_fix (each alive one not in the work at its k stays so; out, no ranks, or
--     every alive one at its k: one past the most of what it is after), go_good, mend_good
--   what order keeps (inv: good, right, fixed, counted, nodup, stamped) from init (inv_init)
--     through set, delete, next with first's delete, started, sees, waits, gone: inv_set,
--     inv_delete, inv_next, inv_started, inv_sees, inv_waits, inv_gone. right: whenever ranks are
--     there, each alive one's is rk's over the edges now. through mend: edit_inv (sees, waits) and
--     inv_gone, by mend_fix and right_of_fix (ranks each at its k are rk's: tall.unique); a whole
--     making with no cycle is at its k (ranks_inv, tall.fix)
--   next: next_least (due, not waiting, at rk's rank now, least by (rank, mark, n)), next_none,
--     scan_spec; totality (lemma N's core): total, next_total
--
-- the model, and where it departs from order.ts:
--   - arrays are Lists; the heap's three arrays side by side are one list of entries; (i - 1) >> 1
--     is (i - 1) / 2; an edge of the heap is index j + 1 to j / 2
--   - push's and pop's while loops are up and down, recursive, with the code's hole: heap[i] is
--     written, the entry to place goes in last. pop on an empty heap gives none
--   - next's while loop is scan, recursive; its for loops are folds; best! on undefined throws:
--     next gives none. all() is all, a List given to next
--   - mend's loop is go, its stack a list with its top first (js: an array, its top last); its fuel
--     is the steps left (limit + 1): out of steps with work left, no ranks, as the code
--   - a computation's fields are functions (update sets one); p.afters, a Map in the order its keys
--     came, is a list of pairs (put, del, get), undefined none; order's ranked is count
--   - sees' stamp loops: tag stamps each of a list at once (the loop setting a field on each)
--   - p.n, p.state: n, alive (only "alive" is read). started makes p alive and gone not alive: the
--     scheduler sets state in make and dispose just before, with no order call between
--   - rank.ts is rk: a function of the alive and of link (blind to all()'s order: RankOrder.lean,
--     rank_same). all() holds every alive one (live), so ranks ranks each alive one, its cycle
--     check sees them all, and count is the alive in all (a Set: no repeats)
--   - order.rank(p) (ranks, then rankOf) is not modeled: the scheduler does not call it
--
-- assumed, as hypotheses where used:
--   - set: p alive (the scheduler's due and stop check it), a mark not 0 (ticks start at 1)
--   - started: fresh p (make: a new object, nothing holds it)
--   - sees: next without repeats (the scheduler's seen: one entry per writer per run)
--   - next: all holds every alive one
--   - next_total: following after through the due has no cycle (Quiescence.lean, Lemma N)
--   - of rk: reach (started and gone keep the others' ranks) and tall on the alive (fix, unique).
--     RankOrder.lean proves both of rank.ts

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
  -- making ranks (the code's ranked); whether it has a cycle; the stamps given; the heap
  dues : Nat
  making : Nat
  made : Nat
  count : Nat
  cyclic : Bool
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

variable (n : α → Nat)

-- the heap made again from the due, in all()'s order (order.ts, remake)
def remake (all : List α) (s : State α) : State α :=
  { s with heap := all.foldl (fun h p =>
      if s.due p ≠ 0 then push (less n) h ⟨p, rankOf s p, s.due p⟩ else h) [] }

-- order.ts, ranks: none now, the ranks made whole (rank.ts is rk), a cycle looked for (an edge
-- between equal ranks), the heap remade
def ranks (rk : (α → Bool) → (α → α → Bool) → α → Nat) (all : List α) (s : State α) :
    State α :=
  if s.making ≠ 0 then s else
  let m := s.made + 1
  let r := rk s.alive (link s)
  remake n all { s with
    making := m, made := m, count := (all.filter s.alive).length,
    rank := fun p => if s.alive p then r p else s.rank p,
    ranked := fun p => if s.alive p then m else s.ranked p,
    cyclic := all.any fun p => s.alive p && (edges s p).any fun q => r q == r p }

-- mend's loop, a stack (its top first), fuel the steps left: each x takes its rank again from
-- its edges; one that changes goes in the heap again when due, and what is after it is pushed.
-- out of steps, or a rank past the count: made whole at the next (order.ts, mend)
def go : Nat → State α → List α → State α
  | _, s, [] => s
  | 0, s, _ :: _ => { s with making := 0 }
  | f + 1, s, x :: rest =>
    if s.alive x = false then go f s rest
    else if rankOf s x = top s x then go f s rest
    else if top s x > s.count then { s with making := 0 }
    else
      go f { s with
        rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
        heap := if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩ else s.heap }
        ((keys (s.afters x)).reverse ++ rest)

-- order.ts, mend: no ranks, nothing; a cycle, made whole at the next; else at most a whole
-- making's steps
def mend (s : State α) (work : List α) : State α :=
  if s.making = 0 then s
  else if s.cyclic then { s with making := 0 }
  else go n (4 * s.count + 64 + 1) s work

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
def sees (s : State α) (p : α) (next : List α) : State α :=
  let old := s.values p
  let s := { s with values := update s.values p next }
  if old = next then s else
  let r := old.foldl (loop untie p (s.stamps + 1)) (tag s next (s.stamps + 1), false)
  let r := next.foldl (loop tie p (r.1.stamps + 1)) (tag r.1 old (r.1.stamps + 1), r.2)
  if r.2 then mend n r.1 [p] else r.1

-- order.ts, waits: p.after becomes q; p mended when an edge changed
def waits (s : State α) (p : α) (q : Option α) : State α :=
  if s.after p = q then s else
  let r : State α × Bool := match s.after p with
    | some a => (untie s p a, edge s p a)
    | none => (s, false)
  let s := { r.1 with after := update r.1.after p q }
  let r : State α × Bool := match q with
    | some b => (tie s p b, r.2 || edge s p b)
    | none => (s, r.2)
  if r.2 then mend n r.1 [p] else r.1

-- gone's middle: p's edges unlinked, after nothing (order.ts, gone)
def forget (s : State α) (p : α) : State α :=
  let s := (s.values p).foldl (fun s q => untie s p q) s
  let s := { s with values := update s.values p [] }
  let s := match s.after p with
    | some a => untie s p a
    | none => s
  { s with after := update s.after p none }

-- order.ts, gone: not due, after nothing, out of the ranks; what was after it mended. the model
-- makes p not alive here (dispose: state "disposing", just before)
def gone (s : State α) (p : α) : State α :=
  let s := { s with
    alive := update s.alive p false, due := update s.due p 0,
    dues := if s.due p ≠ 0 then s.dues - 1 else s.dues }
  let s := forget s p
  let s := { s with
    count := if s.ranked p = s.making ∧ s.making ≠ 0 then s.count - 1 else s.count,
    ranked := update s.ranked p 0 }
  let m := s.afters p
  let s := { s with afters := update s.afters p none }
  match m with
  | some m => mend n s (keys (some m)).reverse
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
def ready (rk : (α → Bool) → (α → α → Bool) → α → Nat) (all : List α) (s : State α) : State α :=
  let s := ranks n rk all s
  if s.heap.length > 4 * s.dues + 64 then remake n all s else s

-- order.ts, next: the computation and its rank; none where best! throws. the waiting go back in
def next (rk : (α → Bool) → (α → α → Bool) → α → Nat) (all : List α) (s : State α) :
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

-- with ranks and no cycle at their making: each rank mend's k, one past the most of what it is
-- after
def fixed (s : State α) : Prop :=
  s.making ≠ 0 → s.cyclic = false → ∀ x, s.alive x = true → rankOf s x = top s x

-- what one after x is, among x's afters' keys
theorem link_keys {s : State α} (hc : counted s) {x y : α} (h : link s y x = true) :
    y ∈ keys (s.afters x) := by
  apply cnt_keys
  rw [hc x (link_alive s y x h) y]
  simp only [link, Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq] at h
  rcases h.2 with h2 | h2 <;> simp [h2]

theorem go_eq : ∀ (f : Nat) (s : State α) (work : List α), ∃ mk rk rd hp,
    go n f s work = { s with making := mk, rank := rk, ranked := rd, heap := hp } ∧
      (mk = 0 ∨ mk = s.making) := by
  intro f
  induction f with
  | zero =>
    intro s work
    cases work with
    | nil => exact ⟨s.making, s.rank, s.ranked, s.heap, by simp only [go], .inr rfl⟩
    | cons x rest => exact ⟨0, s.rank, s.ranked, s.heap, by simp only [go], .inl rfl⟩
  | succ f ih =>
    intro s work
    cases work with
    | nil => exact ⟨s.making, s.rank, s.ranked, s.heap, by simp only [go], .inr rfl⟩
    | cons x rest =>
      simp only [go]
      split
      · exact ih s rest
      · split
        · exact ih s rest
        · split
          · exact ⟨0, s.rank, s.ranked, s.heap, rfl, .inl rfl⟩
          · obtain ⟨mk, rk, rd, hp, e, h⟩ := ih _ _
            exact ⟨mk, rk, rd, hp, e, h⟩

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

-- mend's loop: each alive one in the work or at its k stays so; out, each alive one at its k
theorem go_fix : ∀ (f : Nat) (s : State α) (work : List α), counted s →
    (∀ x, s.alive x = true → x ∈ work ∨ rankOf s x = top s x) →
    (go n f s work).making = 0 ∨ ((go n f s work).making = s.making ∧
      ∀ x, s.alive x = true → rankOf (go n f s work) x = top (go n f s work) x) := by
  intro f
  induction f with
  | zero =>
    intro s work _ hw
    cases work with
    | nil =>
      right; refine ⟨rfl, fun x hx => ?_⟩
      have e : go n 0 s [] = s := by simp only [go]
      rw [e]; simpa using hw x hx
    | cons x rest => left; simp [go]
  | succ f ih =>
    intro s work hc hw
    cases work with
    | nil =>
      right; refine ⟨rfl, fun x hx => ?_⟩
      have e : go n (f + 1) s [] = s := by simp only [go]
      rw [e]; simpa using hw x hx
    | cons x rest =>
      simp only [go]
      have hrest : (s.alive x = false ∨ rankOf s x = top s x) →
          ∀ y, s.alive y = true → y ∈ rest ∨ rankOf s y = top s y := by
        intro hx y hy
        rcases hw y hy with h | h
        · rcases List.mem_cons.1 h with rfl | h
          · rcases hx with hx | hx
            · rw [hx] at hy; cases hy
            · exact .inr hx
          · exact .inl h
        · exact .inr h
      split
      · exact ih s rest hc (hrest (.inl ‹_›))
      · split
        · exact ih s rest hc (hrest (.inr ‹_›))
        · split
          · left; rfl
          · rename_i hx hr _
            generalize hh : (if s.due x ≠ 0 then push (less n) s.heap ⟨x, top s x, s.due x⟩
              else s.heap) = h
            obtain ⟨t1, t2, t3, t4⟩ := set_rank s x h
            have := ih { s with
                rank := update s.rank x (top s x), ranked := update s.ranked x s.making,
                heap := h }
              ((keys (s.afters x)).reverse ++ rest) hc ?_
            · exact this
            · intro y hy
              by_cases hyx : y = x
              · subst hyx; right; rw [t1, t4]
              · by_cases hl : link s y x = true
                · left; exact List.mem_append_left _ (List.mem_reverse.2 (link_keys hc hl))
                · rcases hw y hy with h1 | h1
                  · rcases List.mem_cons.1 h1 with rfl | h1
                    · exact absurd rfl hyx
                    · exact .inl (List.mem_append_right _ h1)
                  · right
                    rw [t2 y hyx, h1]
                    refine (top_congr (fun q => by rw [t3]) (fun q hq => t2 q ?_)).symm
                    rintro rfl; exact hl hq

theorem go_good : ∀ (f : Nat) (s : State α) (work : List α), good n s → good n (go n f s work) := by
  intro f
  induction f with
  | zero =>
    intro s work hg
    cases work with
    | nil => simpa [go] using hg
    | cons x rest =>
      simp only [go]
      exact ⟨hg.1, hg.2.1, hg.2.2.1, fun h => absurd rfl h⟩
  | succ f ih =>
    intro s work hg
    cases work with
    | nil => simpa [go] using hg
    | cons x rest =>
      simp only [go]
      split
      · exact ih s rest hg
      · split
        · exact ih s rest hg
        · split
          · exact ⟨hg.1, hg.2.1, hg.2.2.1, fun h => absurd rfl h⟩
          · apply ih
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

theorem mend_eq (s : State α) (work : List α) : ∃ mk rk rd hp,
    mend n s work = { s with making := mk, rank := rk, ranked := rd, heap := hp } ∧
      (mk = 0 ∨ mk = s.making) := by
  unfold mend
  split
  · exact ⟨s.making, s.rank, s.ranked, s.heap, rfl, .inr rfl⟩
  · split
    · exact ⟨0, s.rank, s.ranked, s.heap, rfl, .inl rfl⟩
    · exact go_eq n _ s work

-- mend: with ranks and no cycle, the alive not in the work at their k: out, no ranks, or every
-- alive one at its k
theorem mend_fix (s : State α) (work : List α) (hc : counted s)
    (hw : s.making ≠ 0 → s.cyclic = false →
      ∀ x, s.alive x = true → x ∈ work ∨ rankOf s x = top s x) :
    (mend n s work).making = 0 ∨ ((mend n s work).making = s.making ∧ s.cyclic = false ∧
      ∀ x, s.alive x = true → rankOf (mend n s work) x = top (mend n s work) x) := by
  unfold mend
  split
  · left; assumption
  · split
    · left; rfl
    · rename_i hm hcy
      have hcy' : s.cyclic = false := by simpa using hcy
      rcases go_fix n _ s work hc (hw hm hcy') with h | ⟨h1, h2⟩
      · exact .inl h
      · exact .inr ⟨h1, hcy', h2⟩

theorem mend_good (s : State α) (work : List α) (hg : good n s) : good n (mend n s work) := by
  unfold mend
  split
  · exact hg
  · split
    · exact ⟨hg.1, hg.2.1, hg.2.2.1, fun h => absurd rfl h⟩
    · exact go_good n _ s work hg

end mend

/-! ## sees and waits: an edge of p changed, p mended -/

section edits

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- what mend needs of the ranks (rank.ts, as rk) on the alive A, links going among them: with no
-- link between equal ranks, each rank is one past the most of what it is after (fix); and ranks
-- that are so are rk's (unique). RankOrder.lean proves both of rank.ts (a height is unique)
structure tall (rk : (α → Bool) → (α → α → Bool) → α → Nat) (A : α → Bool) : Prop where
  fix : ∀ L : α → α → Bool, (∀ x y, L x y = true → A y = true) →
    (∀ x y, A x = true → L x y = true → rk A L y ≠ rk A L x) →
    ∀ x, A x = true → tops L (rk A L) x
  unique : ∀ (L : α → α → Bool) (r : α → Nat), (∀ x y, L x y = true → A y = true) →
    (∀ x, A x = true → tops L r x) → ∀ x, A x = true → rk A L x = r x

-- the ranks, when there, are rank.ts's over the edges now (order.ts: rankOf, as rank.ts would make
-- them)
def right (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) : Prop :=
  s.making ≠ 0 → ∀ x, s.alive x = true → rankOf s x = rk s.alive (link s) x

-- each at its k: so rank.ts's
theorem right_of_fix {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α}
    (hk : tall rk s.alive) (h : ∀ x, s.alive x = true → rankOf s x = top s x) :
    ∀ x, s.alive x = true → rankOf s x = rk s.alive (link s) x :=
  fun x hx => (hk.unique (link s) (rankOf s) (link_alive s)
    (fun y hy => top_iff.1 (h y hy)) x hx).symm

-- what order keeps, all of it: the heap's promise, the ranks right (and at their k with no
-- cycle), afters counted, values without repeats, stamps not ahead of the count
structure inv (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) : Prop where
  good : good n s
  right : right rk s
  fixed : fixed s
  counted : counted s
  nodup : ∀ x, (s.values x).Nodup
  stamped : ∀ q, s.stamp q ≤ s.stamps

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
theorem sees_shape (s : State α) (p : α) (next : List α) (hn : next.Nodup)
    (hv : (s.values p).Nodup) (hst : ∀ q, s.stamp q ≤ s.stamps) :
    ∃ (af : α → Option (List (α × Nat))) (st : α → Nat) (k : Nat) (b : Bool),
      sees n s p next = (if b = true then mend n
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
    · show (if tb = true then mend n t [p] else t) = _
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
theorem waits_shape (s : State α) (p : α) (q : Option α) :
    ∃ (af : α → Option (List (α × Nat))) (b : Bool),
      waits n s p q = (if b = true then mend n
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
theorem edit_inv {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s t : State α} {p : α} {b : Bool}
    (h : inv n rk s) (hk : tall rk s.alive)
    (e1 : t.alive = s.alive) (e2 : t.due = s.due) (e3 : t.heap = s.heap)
    (e4 : t.making = s.making) (e5 : t.cyclic = s.cyclic) (e6 : t.rank = s.rank)
    (e7 : t.ranked = s.ranked)
    (hx : ∀ x, x ≠ p → t.values x = s.values x ∧ t.after x = s.after x)
    (hc : counted t) (hd : ∀ x, (t.values x).Nodup) (hs : ∀ q, t.stamp q ≤ t.stamps)
    (hb : b = false → link t p = link s p) :
    inv n rk (if b = true then mend n t [p] else t) := by
  have hr : rankOf t = rankOf s := by funext x; simp [rankOf, e4, e6, e7]
  have hl : ∀ x, x ≠ p → link t x = link s x := by
    intro x hxp; funext y; simp [link, edge, e1, (hx x hxp).1, (hx x hxp).2]
  have htop : ∀ x, x ≠ p → top t x = top s x := fun x hxp =>
    top_congr (fun y => by rw [hl x hxp]) (fun y _ => by rw [hr])
  obtain ⟨g1, g2, g3, g4⟩ := h.good
  have gt : good n t := by
    refine ⟨by rw [e3]; exact g1, by rw [e3]; exact g2, fun q hq => ?_, fun hm q hq => ?_⟩
    · rw [e1]; exact g3 q (by rw [← e2]; exact hq)
    · rw [e3, hr, e2]; exact g4 (by rw [← e4]; exact hm) q (by rw [← e2]; exact hq)
  cases b with
  | false =>
    simp only [Bool.false_eq_true, ↓reduceIte]
    have hL : link t = link s := by
      funext x; by_cases hxp : x = p
      · subst hxp; exact hb rfl
      · exact hl x hxp
    refine ⟨gt, ?_, ?_, hc, hd, hs⟩
    · intro hm x hx'
      rw [hr, hL, e1]
      exact h.right (by rw [← e4]; exact hm) x (by rw [← e1]; exact hx')
    · intro hm hcy x hx'
      rw [hr]
      have ht : top t x = top s x := by
        by_cases hxp : x = p
        · subst hxp
          exact top_congr (fun y => by rw [hb rfl]) (fun y _ => by rw [hr])
        · exact htop x hxp
      rw [ht]
      exact h.fixed (by rw [← e4]; exact hm) (by rw [← e5]; exact hcy) x (by rw [← e1]; exact hx')
  | true =>
    simp only [↓reduceIte]
    obtain ⟨mk, rk', rd, hp, eu, -⟩ := mend_eq n t [p]
    have fx := mend_fix n t [p] hc (by
      intro hm hcy x hx'
      by_cases hxp : x = p
      · exact .inl (by simp [hxp])
      · right
        rw [hr, htop x hxp]
        exact h.fixed (by rw [← e4]; exact hm) (by rw [← e5]; exact hcy) x (by rw [← e1]; exact hx'))
    have gd := mend_good n t [p] gt
    have ea : (mend n t [p]).alive = t.alive := by rw [eu]
    refine ⟨gd, ?_, ?_, ?_, ?_, ?_⟩
    · intro hm x hx'
      rcases fx with f0 | ⟨-, -, f2⟩
      · exact absurd f0 hm
      · refine right_of_fix (by rw [ea, e1]; exact hk) (fun y hy => f2 y (by rw [← ea]; exact hy))
          x hx'
    · intro hm _ x hx'
      rcases fx with f0 | ⟨-, -, f2⟩
      · exact absurd f0 hm
      · exact f2 x (by rw [← ea]; exact hx')
    · rw [eu]; exact hc
    · rw [eu]; exact hd
    · rw [eu]; exact hs

-- sees keeps what order keeps (next: no repeats, as the scheduler's seen gives)
theorem inv_sees {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) (p : α) {next : List α} (hn : next.Nodup) :
    inv n rk (sees n s p next) := by
  obtain ⟨af, st, k, b, e, hsk, hcnt, hb⟩ := sees_shape n s p next hn (h.nodup p) h.stamped
  rw [e]
  refine edit_inv n h hk rfl rfl rfl rfl rfl rfl rfl
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
theorem inv_waits {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) (p : α) (q : Option α) : inv n rk (waits n s p q) := by
  obtain ⟨af, b, e, hcnt, hb⟩ := waits_shape n s p q
  rw [e]
  refine edit_inv n h hk rfl rfl rfl rfl rfl rfl rfl
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
theorem sees_eq (s : State α) (p : α) (next : List α) (hn : next.Nodup)
    (hv : (s.values p).Nodup) (hst : ∀ q, s.stamp q ≤ s.stamps) :
    (sees n s p next).alive = s.alive ∧ (sees n s p next).values = update s.values p next ∧
      (sees n s p next).after = s.after ∧ (sees n s p next).due = s.due ∧
      ∀ q y, cnt (sees n s p next) q y =
        if y = p ∧ q ∈ next ∧ q ∉ s.values p then cnt s q y + 1
        else if y = p ∧ q ∈ s.values p ∧ q ∉ next then cnt s q y - 1 else cnt s q y := by
  obtain ⟨af, st, k, b, e, -, hcnt, -⟩ := sees_shape n s p next hn hv hst
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
  · obtain ⟨mk, rk', rd, hp, eu, -⟩ := mend_eq n
      { s with values := update s.values p next, afters := af, stamp := st, stamps := k } [p]
    rw [eu]; exact key _ rfl rfl rfl rfl rfl
  · exact key _ rfl rfl rfl rfl rfl

-- what waits changes of the computations: after at p, and afters by the difference
theorem waits_eq (s : State α) (p : α) (q : Option α) :
    (waits n s p q).alive = s.alive ∧ (waits n s p q).values = s.values ∧
      (waits n s p q).after = update s.after p q ∧ (waits n s p q).due = s.due ∧
      ∀ x y, cnt (waits n s p q) x y =
        if y = p ∧ q = some x ∧ s.after p ≠ some x then cnt s x y + 1
        else if y = p ∧ s.after p = some x ∧ q ≠ some x then cnt s x y - 1 else cnt s x y := by
  obtain ⟨af, b, e, hcnt, -⟩ := waits_shape n s p q
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
  · obtain ⟨mk, rk', rd, hp, eu, -⟩ := mend_eq n
      { s with after := update s.after p q, afters := af } [p]
    rw [eu]; exact key _ rfl rfl rfl rfl rfl
  · exact key _ rfl rfl rfl rfl rfl

end edits2

/-! ## started, gone, set, delete -/

section calls

variable {α : Type} [DecidableEq α] (n : α → Nat)

-- what the ranks need of rank.ts (as rk) for started and gone: a rank depends only on what is
-- reachable. so one made linked to by none and linking to none is 0, and changes no other rank;
-- and one going linked to by none changes no other rank. links go only to the alive
structure reach (rk : (α → Bool) → (α → α → Bool) → α → Nat) : Prop where
  start : ∀ (A : α → Bool) (L : α → α → Bool) (p : α), A p = false → (∀ x, L x p = false) →
    (∀ y, L p y = false) → (∀ x y, L x y = true → A y = true) →
    rk (update A p true) L p = 0 ∧ ∀ q, A q = true → rk (update A p true) L q = rk A L q
  gone : ∀ (A : α → Bool) (L L' : α → α → Bool) (p : α), (∀ x, L x p = false) →
    (∀ x y, x ≠ p → L' x y = L x y) → (∀ y, L' p y = false) →
    (∀ x y, L x y = true → A y = true) →
    ∀ q, q ≠ p → A q = true → rk (update A p false) L' q = rk A L q

-- p is new (scheduler.ts, make: a new object): not alive, after nothing, nothing after it, its
-- afters counting none (undefined)
def fresh (s : State α) (p : α) : Prop :=
  s.alive p = false ∧ s.values p = [] ∧ s.after p = none ∧
    (∀ x, p ∉ s.values x ∧ s.after x ≠ some p) ∧ ∀ y, cnt s p y = 0

-- order.ts, createOrder: nothing due, no heap, no ranks, no computation yet
def init : State α :=
  { dues := 0, making := 0, made := 0, count := 0, cyclic := false, stamps := 0, heap := [],
    alive := fun _ => false, values := fun _ => [], after := fun _ => none, due := fun _ => 0,
    rank := fun _ => 0, ranked := fun _ => 0, afters := fun _ => none, stamp := fun _ => 0 }

theorem inv_init (rk : (α → Bool) → (α → α → Bool) → α → Nat) : inv n rk (init (α := α)) := by
  refine ⟨⟨?_, ?_, ?_, ?_⟩, ?_, ?_, ?_, ?_, ?_⟩
  · intro j x y hx; simp [init] at hx
  · intro e he; simp [init] at he
  · intro p hp; simp [init] at hp
  · intro hm; exact absurd rfl hm
  · intro hm; exact absurd rfl hm
  · intro hm; exact absurd rfl hm
  · intro q hq; simp [init] at hq
  · intro x; exact List.nodup_nil
  · intro q; exact Nat.le_refl _

theorem inv_started {rk : (α → Bool) → (α → α → Bool) → α → Nat} (hk : reach rk) {s : State α}
    (h : inv n rk s) {p : α} (hp : fresh s p) : inv n rk (started s p) := by
  obtain ⟨ha, hv, hf, hn, haf⟩ := hp
  have nop : ∀ x, link s x p = false := by
    intro x; simp [link, (hn x).1, (hn x).2]
  have outp : ∀ y, link s p y = false := by intro y; simp [link, hv, hf]
  -- both branches: alive grows by p; the ranks of others kept
  have key : ∀ t : State α, t.alive = update s.alive p true → t.values = s.values →
      t.after = s.after → t.afters = s.afters → t.due = s.due → t.dues = s.dues →
      t.heap = s.heap → t.making = s.making → t.cyclic = s.cyclic → t.stamps = s.stamps →
      t.stamp = s.stamp → (∀ q, q ≠ p → rankOf t q = rankOf s q) →
      (t.making ≠ 0 → rankOf t p = 0) → inv n rk t := by
    intro t a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 hr hr0
    have hl : link t = link s := by
      funext x y
      simp only [link, edge, a1, a2, a3, update]
      by_cases hy : y = p
      · subst hy; simp [(hn x).1, (hn x).2]
      · simp [hy]
    have htop : ∀ x, x ≠ p → top t x = top s x := by
      intro x _
      refine top_congr (fun y => by rw [hl]) (fun y hy => hr y ?_)
      rintro rfl; rw [nop] at hy; cases hy
    have hdp : s.due p = 0 := by
      by_cases hd : s.due p = 0
      · exact hd
      · have := h.good.2.2.1 p hd; rw [ha] at this; cases this
    obtain ⟨g1, g2, g3, g4⟩ := h.good
    refine ⟨⟨by rw [a7]; exact g1, by rw [a7]; exact g2, ?_, ?_⟩, ?_, ?_, ?_, ?_, ?_⟩
    · intro q hq; rw [a1]; simp only [update]; split
      · rfl
      · exact g3 q (by rw [← a5]; exact hq)
    · intro hm q hq
      have hqp : q ≠ p := by rintro rfl; rw [a5, hdp] at hq; exact hq rfl
      rw [a7, hr q hqp, a5]; exact g4 (by rw [← a8]; exact hm) q (by rw [← a5]; exact hq)
    · intro hm x hx
      rw [hl, a1]
      have hk1 := hk.start s.alive (link s) p ha nop outp (link_alive s)
      by_cases hxp : x = p
      · subst hxp; rw [hr0 hm, hk1.1]
      · have hxa : s.alive x = true := by rw [a1] at hx; simpa [update, hxp] using hx
        rw [hr x hxp, hk1.2 x hxa]
        exact h.right (by rw [← a8]; exact hm) x hxa
    · intro hm hcy x hx
      by_cases hxp : x = p
      · subst hxp
        rw [hr0 hm]
        have : top t x ≤ 0 := top_le fun q hq => by rw [hl, outp] at hq; cases hq
        omega
      · have hxa : s.alive x = true := by rw [a1] at hx; simpa [update, hxp] using hx
        rw [hr x hxp, htop x hxp]
        exact h.fixed (by rw [← a8]; exact hm) (by rw [← a9]; exact hcy) x hxa
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
      (fun hm => absurd ‹_› hm)
  · refine key _ rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl rfl ?_ ?_
    · intro q hqp; simp [rankOf, update_ne _ _ hqp]
    · intro _; simp [rankOf]

-- set keeps what order keeps, for an alive p at a mark not 0 (the scheduler's ticks start at 1)
theorem inv_set {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    {p : α} (ha : s.alive p = true) {m : Nat} (hm : m ≠ 0) : inv n rk (set n s p m) := by
  obtain ⟨⟨g1, g2, g3, g4⟩, hr, hf, hc, hd, hs⟩ := h
  have g3' : ∀ q, update s.due p m q ≠ 0 → s.alive q = true := by
    intro q hq
    by_cases hqp : q = p
    · subst hqp; exact ha
    · rw [update_ne _ _ hqp] at hq; exact g3 q hq
  unfold set
  dsimp only
  split
  · rename_i hmk
    refine ⟨⟨push_heap (less_weak n) g1, ?_, g3', fun _ q hq => ?_⟩, hr, hf, hc, hd, hs⟩
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
    exact ⟨⟨g1, g2, g3', fun h' => absurd (by simpa using hmk) h'⟩, hr, hf, hc, hd, hs⟩

-- delete keeps what order keeps
theorem inv_delete {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (p : α) : inv n rk (delete s p) := by
  obtain ⟨⟨g1, g2, g3, g4⟩, hr, hf, hc, hd, hs⟩ := h
  unfold delete
  split
  · exact ⟨⟨g1, g2, g3, g4⟩, hr, hf, hc, hd, hs⟩
  · refine ⟨⟨g1, g2, ?_, ?_⟩, hr, hf, hc, hd, hs⟩
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

theorem gone_shape (s : State α) (p : α) (hv : (s.values p).Nodup) :
    ∃ (af : α → Option (List (α × Nat))) (cn d : Nat),
      gone n s p = (match af p with
        | some m => mend n { s with
            alive := update s.alive p false, due := update s.due p 0, dues := d,
            values := update s.values p [], after := update s.after p none, count := cn,
            ranked := update s.ranked p 0, afters := update af p none } (keys (some m)).reverse
        | none => { s with
            alive := update s.alive p false, due := update s.due p 0, dues := d,
            values := update s.values p [], after := update s.after p none, count := cn,
            ranked := update s.ranked p 0, afters := update af p none }) ∧
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

-- gone keeps what order keeps
theorem inv_gone {rk : (α → Bool) → (α → α → Bool) → α → Nat} (hk : reach rk) {s : State α}
    (h : inv n rk s) (p : α) (ht : tall rk (update s.alive p false)) :
    inv n rk (gone n s p) := by
  obtain ⟨af, cn, d, e, hcnt⟩ := gone_shape n s p (h.nodup p)
  rw [e]
  generalize htt : ({ s with
    alive := update s.alive p false, due := update s.due p 0, dues := d,
    values := update s.values p [], after := update s.after p none, count := cn,
    ranked := update s.ranked p 0, afters := update af p none } : State α) = t
  have ta : t.alive = update s.alive p false := by rw [← htt]
  have tm : t.making = s.making := by rw [← htt]
  have tc : t.cyclic = s.cyclic := by rw [← htt]
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
  have hlp : ∀ y, link t p y = false := by
    intro y; rw [← htt]; simp [link]
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
  have htop : ∀ x, x ≠ p → link s x p = false → top t x = top s x := by
    intro x hx hn
    refine top_congr (fun y => ?_) (fun y hy => hr y ?_)
    · by_cases hy : y = p
      · subst hy; rw [hl0, hn]
      · exact hlt x y hx hy
    · rintro rfl; rw [hn] at hy; cases hy
  have pre : t.making ≠ 0 → t.cyclic = false → ∀ x, t.alive x = true →
      link s x p = true ∨ rankOf t x = top t x := by
    intro hm hcy x hx
    obtain ⟨hxp, hxa⟩ := hal x hx
    cases hn : link s x p with
    | true => exact .inl rfl
    | false =>
      right
      rw [hr x hxp, htop x hxp hn]
      exact h.fixed (by rw [← tm]; exact hm) (by rw [← tc]; exact hcy) x hxa
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
  cases hm : af p with
  | none =>
    simp only
    have nop : ∀ x, link s x p = false := by
      intro x; cases hx : link s x p with
      | false => rfl
      | true => have := hin x hx; rw [hm] at this; simp [keys] at this
    refine ⟨gt, ?_, ?_, ct, dt, st⟩
    · intro hmk x hx
      obtain ⟨hxp, hxa⟩ := hal x hx
      rw [hr x hxp, ta]
      have hk1 := hk.gone s.alive (link s) (link t) p nop
        (fun x y hxp' => by
          by_cases hy : y = p
          · subst hy; rw [hl0, nop]
          · exact hlt x y hxp' hy)
        hlp (link_alive s) x hxp hxa
      rw [hk1]
      exact h.right (by rw [← tm]; exact hmk) x hxa
    · intro hmk hcy x hx
      rcases pre hmk hcy x hx with h1 | h1
      · rw [nop] at h1; cases h1
      · exact h1
  | some m =>
    simp only
    obtain ⟨mk, rk', rd, hp, eu, -⟩ := mend_eq n t (keys (some m)).reverse
    have fx := mend_fix n t (keys (some m)).reverse ct (by
      intro hmk hcy x hx
      rcases pre hmk hcy x hx with h1 | h1
      · left; have := hin x h1; rw [hm] at this; exact List.mem_reverse.2 this
      · exact .inr h1)
    have gd := mend_good n t (keys (some m)).reverse gt
    have ea : (mend n t (keys (some m)).reverse).alive = t.alive := by rw [eu]
    refine ⟨gd, ?_, ?_, ?_, ?_, ?_⟩
    · intro hmk x hx
      rcases fx with f0 | ⟨-, -, f2⟩
      · exact absurd f0 hmk
      · exact right_of_fix (by rw [ea, ta]; exact ht) (fun y hy => f2 y (by rw [← ea]; exact hy))
          x hx
    · intro hmk _ x hx
      rcases fx with f0 | ⟨-, -, f2⟩
      · exact absurd f0 hmk
      · exact f2 x (by rw [← ea]; exact hx)
    · rw [eu]; exact ct
    · rw [eu]; exact dt
    · rw [eu]; exact st

end goes

/-! ## next -/

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

-- ranks: made whole when none, so there after; what order keeps, kept
theorem ranks_inv {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) {all : List α} (hall : ∀ p, s.alive p = true → p ∈ all) :
    let t := ranks n rk all s
    t.making ≠ 0 ∧ inv n rk t ∧ t.alive = s.alive ∧ t.values = s.values ∧ t.after = s.after ∧
      t.due = s.due ∧ t.afters = s.afters := by
  intro t
  unfold t ranks
  split
  · rename_i hm; exact ⟨hm, h, rfl, rfl, rfl, rfl, rfl⟩
  · rename_i hm
    dsimp only
    generalize hr : rk s.alive (link s) = r
    generalize hu : ({ s with
      making := s.made + 1, made := s.made + 1, count := (all.filter s.alive).length,
      rank := fun p => if s.alive p then r p else s.rank p,
      ranked := fun p => if s.alive p then s.made + 1 else s.ranked p,
      cyclic := all.any fun p => s.alive p && (edges s p).any fun q => r q == r p } : State α) = u
    have hl : link u = link s := by rw [← hu]; exact link_eq rfl rfl rfl
    have hro : ∀ p, s.alive p = true → rankOf u p = r p := by
      intro p hp; rw [← hu]; simp [rankOf, hp]
    have ua : u.alive = s.alive := by rw [← hu]
    have um : u.making = s.made + 1 := by rw [← hu]
    have ru : right rk (remake n all u) := by
      intro _ x hx
      have hx' : s.alive x = true := by rw [← ua]; exact hx
      show rankOf u x = rk u.alive (link u) x
      rw [ua, hl, hr]; exact hro x hx'
    have fu : fixed (remake n all u) := by
      intro _ hcy x hx
      show rankOf u x = top u x
      replace hx : s.alive x = true := by rw [← ua]; exact hx
      have hcy' : (all.any fun p => s.alive p && (edges s p).any fun q => r q == r p) = false := by
        rw [← hcy, ← hu]; rfl
      have hne : ∀ x y, s.alive x = true → link s x y = true → rk s.alive (link s) y ≠
          rk s.alive (link s) x := by
        intro x y hx hy e
        rw [List.any_eq_false] at hcy'
        have := hcy' x (hall x hx)
        rw [hr] at e
        simp only [hx, Bool.true_and, List.any_eq_true, beq_iff_eq] at this
        exact this ⟨y, mem_edges.2 hy, e⟩
      obtain ⟨t1, t2⟩ := hk.fix (link s) (link_alive s) hne x hx
      rw [hr] at t1 t2
      apply top_iff.2
      rw [hl]
      refine ⟨fun y hy => ?_, ?_⟩
      · rw [hro y (link_alive s x y hy), hro x hx]; exact t1 y hy
      · rcases t2 with e | ⟨y, hy, e⟩
        · left; rw [hro x hx]; exact e
        · right; refine ⟨y, hy, ?_⟩; rw [hro x hx, hro y (link_alive s x y hy)]; exact e
    have gu : good n (remake n all u) := by
      refine remake_good n all (fun p hp => ?_) (fun p hp => ?_)
      · have : u.due = s.due := by rw [← hu]
        rw [ua]; exact h.good.2.2.1 p (by rw [← this]; exact hp)
      · exact hall p (by rw [← ua]; exact hp)
    refine ⟨by show u.making ≠ 0; rw [um]; omega, ⟨gu, ru, fu, ?_, ?_, ?_⟩, ?_, ?_, ?_, ?_, ?_⟩
    all_goals first
      | (show counted u; rw [← hu]; exact h.counted)
      | (show ∀ x, (u.values x).Nodup; rw [← hu]; exact h.nodup)
      | (show ∀ q, u.stamp q ≤ u.stamps; rw [← hu]; exact h.stamped)
      | (show u.alive = s.alive; exact ua)
      | (show u.values = s.values; rw [← hu])
      | (show u.after = s.after; rw [← hu])
      | (show u.due = s.due; rw [← hu])
      | (show u.afters = s.afters; rw [← hu])

-- next up to its loop: ranks there, what order keeps kept, the computations untouched
theorem ready_inv {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) {all : List α} (hall : ∀ p, s.alive p = true → p ∈ all) :
    let t := ready n rk all s
    t.making ≠ 0 ∧ inv n rk t ∧ t.alive = s.alive ∧ t.values = s.values ∧ t.after = s.after ∧
      t.due = s.due ∧ t.afters = s.afters := by
  obtain ⟨m1, i1, a1, v1, f1, d1, af1⟩ := ranks_inv n h hk hall
  intro t
  unfold t ready
  dsimp only
  generalize ranks n rk all s = u at m1 i1 a1 v1 f1 d1 af1
  split
  · refine ⟨m1, ⟨?_, i1.right, i1.fixed, i1.counted, i1.nodup, i1.stamped⟩, a1, v1, f1, d1, af1⟩
    exact remake_good n all i1.good.2.2.1 (fun p hp => hall p (by rw [← a1]; exact hp))
  · exact ⟨m1, i1, a1, v1, f1, d1, af1⟩

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
theorem next_least {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) {all : List α} (hall : ∀ p, s.alive p = true → p ∈ all) {p : α}
    {k : Nat} (hb : (next n rk all s).1 = some (p, k)) :
    s.due p ≠ 0 ∧ waiting s p = false ∧ k = rk s.alive (link s) p ∧
      ∀ q, s.due q ≠ 0 → waiting s q = false →
        ¬ before (rk s.alive (link s) q, s.due q, n q) (k, s.due p, n p) := by
  obtain ⟨m1, i1, a1, v1, f1, d1, -⟩ := ready_inv n h hk hall
  generalize ht : ready n rk all s = t at m1 i1 a1 v1 f1 d1
  have hw : waiting t = waiting s := waiting_eq f1 d1
  have hl : link t = link s := link_eq a1 v1 f1
  have hrk : ∀ q, s.alive q = true → rankOf t q = rk s.alive (link s) q := by
    intro q hq; rw [i1.right m1 q (by rw [a1]; exact hq), a1, hl]
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
    have ha : s.alive x.p = true := h.good.2.2.1 _ hd
    refine ⟨hd, by rw [← hw]; exact j3, by rw [← jr, hrk _ ha], ?_⟩
    intro q hq hwq
    have he := i1.good.2.2.2 m1 q (by rw [d1]; exact hq)
    have := j4 _ he (current_entry t q) (by rw [hw]; exact hwq)
    rw [less_false] at this
    simp only at this
    rw [hrk q (h.good.2.2.1 q hq), d1, ← jr, hrk _ ha, ← jd, d1] at this
    rw [← jr, hrk _ ha]
    exact this

-- next gives none only when every due one waits after a due one
theorem next_none {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) {all : List α} (hall : ∀ p, s.alive p = true → p ∈ all)
    (hb : (next n rk all s).1 = none) : ∀ q, s.due q ≠ 0 → waiting s q = true := by
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

-- next keeps what order keeps: the waiting pushed back, the best gone until the scheduler
-- deletes it (first: order.delete); the computations untouched
theorem inv_next {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α} (h : inv n rk s)
    (hk : tall rk s.alive) {all : List α} (hall : ∀ p, s.alive p = true → p ∈ all) :
    let o := next n rk all s
    o.2.alive = s.alive ∧ o.2.values = s.values ∧ o.2.after = s.after ∧ o.2.due = s.due ∧
      o.2.afters = s.afters ∧
      match o.1 with
      | some (p, _) => inv n rk (delete o.2 p)
      | none => inv n rk o.2 := by
  obtain ⟨m1, i1, a1, v1, f1, d1, af1⟩ := ready_inv n h hk hall
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
  obtain ⟨⟨g1, g2, g3, g4⟩, r1, x1, c1, n1, s1⟩ := i1
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
    refine ⟨⟨hh, fun e he => g2 e (back e he), fun q hq => ?_, fun _ q hq => ?_⟩, r1, x1, c1, n1,
      s1⟩
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
    exact ⟨⟨hh, fun e he => g2 e (back e he), g3, fun _ q hq => keep q hq (by simp)⟩, r1, x1,
      c1, n1, s1⟩

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
theorem next_total (n : α → Nat) {rk : (α → Bool) → (α → α → Bool) → α → Nat} {s : State α}
    (h : inv n rk s) (hk : tall rk s.alive) {all : List α}
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
