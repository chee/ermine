-- LLM generated working output
-- order.ts in Lean: the heap, next, set, and the rank cache.
--
-- proved:
--   the heap: push_perm, push_heap, pop_perm, pop_heap, pop_least (pop gives a least entry)
--   next: next_best, next_least (due, not waiting, least by (rank, mark, n)), next_none,
--     next_good (the promise kept, with first's delete), set_good, delete_good
--   totality (lemma N's core): total, next_total
--   the cache: inv (good, right, counted) holds at init and is kept by set, delete, next,
--     started, sees, waits, gone. right: rankOf, when there, is the ranks of the edges now
--
-- the model, and where it departs from order.ts:
--   - arrays are Lists; (i - 1) >> 1 is (i - 1) / 2; an edge of the heap is index j + 1 to j / 2
--   - push's and pop's while loops are up and down, recursive, with the code's hole: heap[i] is
--     written, the entry to place goes in last. pop on an empty heap gives none (code: undefined)
--   - next's while loop is scan, recursive; its for loops over due and waiting are folds
--   - best! on undefined throws; next gives none
--   - Maps are functions to Option. due is a list of pairs in insertion order, set in place or
--     at the end, delete a filter; due.size is its length (the same while keys are distinct,
--     which put and del keep; only the remake's threshold reads it)
--   - a Map's identity: heapRanks is Held: none, the cache itself (rankOf's own Map, so
--     started's set and gone's delete show through), or an old Map (rankOf dropped since).
--     heapRanks !== rank is held ≠ cache: the same, given held = cache only while rankOf is there
--     (good)
--   - p.n, p.state, p.values, p.after: n, alive (only "alive" is read), values (a List; a Set,
--     nodup in counted), after. started makes p alive and gone makes p not alive: the scheduler
--     sets state in make and dispose just before, with no order call between
--   - rank.ts is rk: a function of the alive and of link, so blind to all()'s order (Tarjan's
--     ranks are). assumed: reach rk (Rank.lean's to prove)
--   - named: a function, 0 for absent; name clamps at 0, as the code deletes
--   - the computations are finitely many: world lists each once (only for counting names)
--
-- assumed, as hypotheses where used:
--   - set: p alive (the scheduler's mark and stop check it)
--   - started: fresh p (make: a new object, nothing holds it)
--   - sees: next nodup (a Set)
--   - next_total: following after through the due has no cycle (Model.lean's to prove)
--   - reach rk, world univ

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

/-! ## the order: its state, set, delete, next -/

section state

variable {α : Type} [DecidableEq α]

-- what heapRanks is: nothing, the cache itself (the same Map as rankOf), or a Map the cache was
-- before it was dropped (order.ts, heapRanks)
inductive Held (α : Type) where
  | none
  | cache
  | old (m : α → Option Nat)

-- order's state, and the fields of the computations it reads and writes (order.ts, createOrder)
structure State (α : Type) where
  due : List (α × Nat)
  heap : List (Entry α)
  held : Held α
  -- rankOf
  cache : Option (α → Option Nat)
  named : α → Nat
  -- p.state === "alive", p.values, p.after
  alive : α → Bool
  values : α → List α
  after : α → Option α

-- heapRanks, as a Map (order.ts, heapRanks)
def heapranks (s : State α) : Option (α → Option Nat) :=
  match s.held with
  | .none => none
  | .cache => s.cache
  | .old m => some m

-- an edge: to another computation, alive (order.ts, edge)
def edge (s : State α) (p q : α) : Bool := q ≠ p && s.alive q

-- what p is after, as a relation (order.ts, edges)
def link (s : State α) (p q : α) : Bool :=
  edge s p q && (q ∈ s.values p || s.after p = some q)

-- the ranks made again: of the alive, along link (order.ts, ranks; rank.ts is rk)
def made (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) : α → Option Nat :=
  fun p => if s.alive p then some (rk s.alive (link s) p) else none

-- order.ts, ranks
def ranks (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) :
    State α × (α → Option Nat) :=
  match s.cache with
  | some r => (s, r)
  | none => ({ s with cache := some (made rk s) }, made rk s)

-- rankOf = undefined (order.ts, sees, waits, gone). heapRanks, if it was the cache, keeps
-- the Map
def drop (s : State α) : State α :=
  { s with
    cache := none
    held := match s.held, s.cache with
      | .cache, some m => .old m
      | h, _ => h }

variable (n : α → Nat)

-- { p, rank: r.get(p) ?? 0, mark } (order.ts, set, next)
def entry (r : α → Option Nat) (p : α) (m : Nat) : Entry α := ⟨p, (r p).getD 0, m⟩

-- order.ts, set
def set (s : State α) (p : α) (m : Nat) : State α :=
  match heapranks s with
  | none => { s with due := put s.due p m }
  | some r => { s with due := put s.due p m, heap := push (less n) s.heap (entry r p m) }

-- order.ts, delete
def delete (s : State α) (p : α) : State α := { s with due := del s.due p }

-- e.p.after && due.has(e.p.after) (order.ts, next)
def waiting (due : List (α × Nat)) (after : α → Option α) (p : α) : Bool :=
  match after p with
  | some a => (get due a).isSome
  | none => false

-- next's while loop: pop till an entry due at its mark and not waiting; the waiting put aside.
-- what it gives: the best, the heap, the waiting (order.ts, next)
def scan (due : List (α × Nat)) (after : α → Option α) (h w : List (Entry α)) :
    Option (Entry α) × List (Entry α) × List (Entry α) :=
  match _hp : pop (less n) h with
  | (none, _) => (none, h, w)
  | (some e, h') =>
    if get due e.p ≠ some e.mark then scan due after h' w
    else if waiting due after e.p then scan due after h' (w ++ [e])
    else (some e, h', w)
termination_by h.length
decreasing_by all_goals exact pop_length _hp

-- next's remake: the due pushed, each with its rank in r (order.ts, next)
def remake (r : α → Option Nat) (due : List (α × Nat)) : List (Entry α) :=
  due.foldl (fun h x => push (less n) h (entry r x.1 x.2)) []

-- heapRanks !== rank || heap.length > 4 * due.size + 64 (order.ts, next)
def stale (s : State α) : Bool :=
  match s.held with
  | .cache => s.heap.length > 4 * s.due.length + 64
  | _ => true

-- next up to its loop: the ranks (made again if dropped), and the heap remade when stale
-- (order.ts, next)
def ready (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) :
    State α × (α → Option Nat) :=
  let r := (ranks rk s).2
  let s := (ranks rk s).1
  (if stale s then { s with held := .cache, heap := remake n r s.due } else s, r)

-- order.ts, next: the computation and its rank; none where best! throws. the waiting go back in
def next (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) :
    Option (α × Nat) × State α :=
  let s := (ready n rk s).1
  let l := scan n s.due s.after s.heap []
  (l.1.map (fun e => (e.p, e.rank)), { s with heap := l.2.2.foldl (push (less n)) l.2.1 })

theorem pop_mem {less : E → E → Bool} {h h' : List E} {t e : E}
    (hp : pop less h = (some t, h')) : e ∈ h ↔ e = t ∨ e ∈ h' := by
  rw [← (pop_perm hp).mem_iff]; simp

theorem scan_spec {due : List (α × Nat)} {after : α → Option α} (h w : List (Entry α))
    (b : Option (Entry α)) (h' w' : List (Entry α)) :
    scan n due after h w = (b, h', w') → heap (less n) h →
    heap (less n) h' ∧
    (∀ e ∈ h, e ∈ h' ∨ e ∈ w' ∨ b = some e ∨ get due e.p ≠ some e.mark) ∧
    (∀ e ∈ w, e ∈ w') ∧
    (∀ e ∈ h', e ∈ h) ∧
    (∀ e ∈ w', e ∈ h ∨ e ∈ w) ∧
    (∀ x, b = some x → x ∈ h ∧ get due x.p = some x.mark ∧ waiting due after x.p = false ∧
      ∀ e ∈ h, get due e.p = some e.mark → waiting due after e.p = false → less n e x = false) ∧
    (b = none → ∀ e ∈ h, get due e.p = some e.mark → waiting due after e.p = true) := by
  fun_induction scan n due after h w with
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
      · exact absurd hd hs
      · exact j4 e he hd hw
    · intro hb e he hd
      rcases (pop_mem hp).mp he with rfl | he
      · exact absurd hd hs
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

-- the heap's promise: a heap; the due alive; and with heapRanks the cache, every due p has its
-- entry, and every entry of an alive p has p's rank
def good (s : State α) : Prop :=
  heap (less n) s.heap ∧
  (∀ p m, get s.due p = some m → s.alive p = true) ∧
  (s.held = .cache → ∃ r, s.cache = some r ∧
    (∀ p m, get s.due p = some m → entry r p m ∈ s.heap) ∧
    (∀ e ∈ s.heap, s.alive e.p = true → e.rank = (r e.p).getD 0))

end state

section pushes

variable {E β : Type}

theorem pushes_perm {less : E → E → Bool} (f : β → E) :
    ∀ (l : List β) (h : List E), (l.foldl (fun h x => push less h (f x)) h).Perm (h ++ l.map f)
  | [], h => by simp
  | x :: l, h => by
    simp only [List.foldl_cons, List.map_cons]
    refine (pushes_perm f l _).trans ?_
    refine ((push_perm (less := less) (h := h) (e := f x)).append_right (l.map f)).trans ?_
    simp

theorem pushes_heap {less : E → E → Bool} (w : weak less) (f : β → E) :
    ∀ (l : List β) (h : List E), heap less h → heap less (l.foldl (fun h x => push less h (f x)) h)
  | [], _, hh => hh
  | x :: l, h, hh => by
    simp only [List.foldl_cons]
    exact pushes_heap w f l _ (push_heap w hh)

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

end pushes

section next

variable {α : Type} [DecidableEq α] (n : α → Nat)

omit [DecidableEq α] in
theorem remake_heap (r : α → Option Nat) (due : List (α × Nat)) : heap (less n) (remake n r due) :=
  pushes_heap (less_weak n) _ due [] (by intro j x y hx; simp at hx)

omit [DecidableEq α] in
theorem remake_mem {r : α → Option Nat} {due : List (α × Nat)} {e : Entry α} :
    e ∈ remake n r due ↔ ∃ x ∈ due, e = entry r x.1 x.2 := by
  unfold remake
  rw [(pushes_perm _ due []).mem_iff]
  simp [eq_comm]

-- what ready gives: the cache r, held as heapRanks; a heap with every due p's entry; every entry
-- of an alive p with p's rank in r; the due and the computations untouched
theorem ready_spec (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s : State α} (hs : good n s) :
    let t := ready n rk s
    t.1.held = .cache ∧ t.1.cache = some t.2 ∧ heap (less n) t.1.heap ∧
    (∀ p m, get t.1.due p = some m → entry t.2 p m ∈ t.1.heap) ∧
    (∀ e ∈ t.1.heap, t.1.alive e.p = true → e.rank = (t.2 e.p).getD 0) ∧
    t.1.due = s.due ∧ t.1.alive = s.alive ∧ t.1.after = s.after ∧ t.1.values = s.values ∧
    t.1.named = s.named := by
  obtain ⟨g1, g2, g3⟩ := hs
  have remade : ∀ (t : State α) (r : α → Option Nat), t.cache = some r →
      let u := { t with held := .cache, heap := remake n r t.due }
      u.held = .cache ∧ u.cache = some r ∧ heap (less n) u.heap ∧
      (∀ p m, get u.due p = some m → entry r p m ∈ u.heap) ∧
      (∀ e ∈ u.heap, u.alive e.p = true → e.rank = (r e.p).getD 0) := by
    intro t r hc
    refine ⟨rfl, hc, remake_heap n r t.due, ?_, ?_⟩
    · intro p m hp
      exact (remake_mem n).mpr ⟨(p, m), get_mem hp, rfl⟩
    · intro e he _
      obtain ⟨x, _, rfl⟩ := (remake_mem n).mp he
      rfl
  unfold ready ranks
  cases hc : s.cache with
  | some r =>
    simp only
    split
    · have := remade s r hc
      exact ⟨this.1, this.2.1, this.2.2.1, this.2.2.2.1, this.2.2.2.2, rfl, rfl, rfl, rfl, rfl⟩
    · rename_i hst
      have hh : s.held = .cache := by
        unfold stale at hst; split at hst <;> simp_all
      obtain ⟨r', hr', i1, i2⟩ := g3 hh
      rw [hc] at hr'; cases hr'
      exact ⟨hh, hc, g1, i1, i2, rfl, rfl, rfl, rfl, rfl⟩
  | none =>
    simp only
    have hst : stale { s with cache := some (made rk s) } = true := by
      unfold stale
      split
      · rename_i hh
        obtain ⟨r', hr', _⟩ := g3 hh
        rw [hc] at hr'; cases hr'
      · rfl
    rw [ite_eq_left hst]
    have := remade { s with cache := some (made rk s) } (made rk s) rfl
    exact ⟨this.1, this.2.1, this.2.2.1, this.2.2.2.1, this.2.2.2.2, rfl, rfl, rfl, rfl, rfl⟩

-- next's choice: due, not waiting after a due one, with its rank now; and before no other such
-- by (rank, mark, n)
theorem next_best (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s : State α} (hs : good n s)
    {p : α} {k : Nat} (hb : (next n rk s).1 = some (p, k)) :
    let r := (ready n rk s).2
    ∃ m, get s.due p = some m ∧ waiting s.due s.after p = false ∧ k = (r p).getD 0 ∧
      ∀ q mq, get s.due q = some mq → waiting s.due s.after q = false →
        ¬ before ((r q).getD 0, mq, n q) (k, m, n p) := by
  intro r
  obtain ⟨_, _, rh, r1, r2, rdue, ralive, rafter, -, -⟩ := ready_spec n rk hs
  unfold next at hb
  simp only at hb
  generalize hl : scan n (ready n rk s).1.due (ready n rk s).1.after (ready n rk s).1.heap [] = l
    at hb
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨_, _, _, _, _, i6, _⟩ := scan_spec n _ _ _ _ _ hl rh
  cases b with
  | none => simp at hb
  | some x =>
    simp only [Option.map_some, Option.some.injEq, Prod.mk.injEq] at hb
    obtain ⟨rfl, rfl⟩ := hb
    obtain ⟨j1, j2, j3, j4⟩ := i6 x rfl
    rw [rdue] at j2; rw [rdue, rafter] at j3 j4
    have halive : (ready n rk s).1.alive x.p = true := by
      rw [ralive]; exact hs.2.1 _ _ j2
    refine ⟨x.mark, j2, j3, r2 x j1 halive, ?_⟩
    intro q mq hq hw
    have hq' : get (ready n rk s).1.due q = some mq := by rw [rdue]; exact hq
    have := j4 _ (r1 q mq hq') hq hw
    have hx : x.rank = (r x.p).getD 0 := r2 x j1 halive
    rw [less_false] at this
    simpa [entry] using this

-- next gives none only when every due computation waits after a due one
theorem next_none (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s : State α} (hs : good n s)
    (hb : (next n rk s).1 = none) :
    ∀ q m, get s.due q = some m → waiting s.due s.after q = true := by
  obtain ⟨_, _, rh, r1, _, rdue, _, rafter, -, -⟩ := ready_spec n rk hs
  unfold next at hb
  simp only at hb
  generalize hl : scan n (ready n rk s).1.due (ready n rk s).1.after (ready n rk s).1.heap [] = l
    at hb
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨_, _, _, _, _, _, i7⟩ := scan_spec n _ _ _ _ _ hl rh
  cases b with
  | some x => simp at hb
  | none =>
    intro q m hq
    have hq' : get (ready n rk s).1.due q = some m := by rw [rdue]; exact hq
    have := i7 rfl _ (r1 q m hq') hq'
    rw [rdue, rafter] at this
    exact this

-- next keeps the due and the computations
theorem next_keeps (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s : State α} (hs : good n s) :
    let t := (next n rk s).2
    t.due = s.due ∧ t.alive = s.alive ∧ t.after = s.after ∧ t.values = s.values ∧
      t.named = s.named := by
  obtain ⟨_, _, _, _, _, rdue, ralive, rafter, rvalues, rnamed⟩ := ready_spec n rk hs
  exact ⟨rdue, ralive, rafter, rvalues, rnamed⟩

-- next keeps the promise: stale entries dropped, the waiting pushed back, the best gone until the
-- scheduler deletes its computation (first: order.delete)
theorem next_good (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s : State α} (hs : good n s) :
    match (next n rk s).1 with
    | some (p, _) => good n (delete (next n rk s).2 p)
    | none => good n (next n rk s).2 := by
  obtain ⟨rh0, rc, rh, r1, r2, rdue, ralive, -, -, -⟩ := ready_spec n rk hs
  have dalive := hs.2.1
  unfold next
  simp only
  generalize hl : scan n (ready n rk s).1.due (ready n rk s).1.after (ready n rk s).1.heap [] = l
  obtain ⟨b, h', w'⟩ := l
  obtain ⟨i1, i2, _, i4, i5, i6, _⟩ := scan_spec n _ _ _ _ _ hl rh
  have hfin : ∀ e, e ∈ w'.foldl (push (less n)) h' ↔ e ∈ h' ∨ e ∈ w' := by
    intro e; rw [(pushall_perm w' h').mem_iff]; simp
  have hheap : heap (less n) (w'.foldl (push (less n)) h') := pushall_heap (less_weak n) w' h' i1
  have back : ∀ e, e ∈ w'.foldl (push (less n)) h' → e ∈ (ready n rk s).1.heap := by
    intro e he
    rcases (hfin e).mp he with he | he
    · exact i4 e he
    · rcases i5 e he with he | he
      · exact he
      · simp at he
  cases b with
  | some x =>
    simp only [Option.map_some]
    obtain ⟨j1, j2, _, _⟩ := i6 x rfl
    refine ⟨hheap, ?_, ?_⟩
    · intro q m hq
      simp only [delete, get_del] at hq
      split at hq
      · cases hq
      · rw [rdue] at hq; rw [ralive]; exact dalive q m hq
    · intro _
      refine ⟨(ready n rk s).2, rc, ?_, ?_⟩
      · intro q m hq
        simp only [delete, get_del] at hq
        split at hq
        · cases hq
        · rename_i hne
          have he := r1 q m hq
          rcases i2 _ he with h1 | h1 | h1 | h1
          · exact (hfin _).mpr (Or.inl h1)
          · exact (hfin _).mpr (Or.inr h1)
          · cases h1; exact absurd rfl hne
          · exact absurd hq (by simpa [entry] using h1)
      · intro e he ha
        exact r2 e (back e he) ha
  | none =>
    simp only [Option.map_none]
    refine ⟨hheap, ?_, ?_⟩
    · intro q m hq; rw [rdue] at hq; rw [ralive]; exact dalive q m hq
    · intro _
      refine ⟨(ready n rk s).2, rc, ?_, ?_⟩
      · intro q m hq
        have he := r1 q m hq
        rcases i2 _ he with h1 | h1 | h1 | h1
        · exact (hfin _).mpr (Or.inl h1)
        · exact (hfin _).mpr (Or.inr h1)
        · cases h1
        · exact absurd hq (by simpa [entry] using h1)
      · intro e he ha
        exact r2 e (back e he) ha

-- set keeps the promise, for an alive p (the scheduler sets only those): with heapRanks, the
-- entry is pushed with p's rank in it
theorem set_good {s : State α} (hs : good n s) {p : α} {m : Nat} (ha : s.alive p = true) :
    good n (set n s p m) := by
  obtain ⟨g1, g2, g3⟩ := hs
  unfold set
  split
  · rename_i hr
    refine ⟨g1, ?_, ?_⟩
    · intro q k hq; simp only [get_put] at hq; split at hq
      · subst_vars; exact ha
      · exact g2 q k hq
    · intro hh
      unfold heapranks at hr; rw [hh] at hr
      obtain ⟨r, hc, _⟩ := g3 hh
      rw [hc] at hr; cases hr
  · rename_i r hr
    refine ⟨push_heap (less_weak n) g1, ?_, ?_⟩
    · intro q k hq; simp only [get_put] at hq; split at hq
      · subst_vars; exact ha
      · exact g2 q k hq
    · intro hh
      have hh' : s.held = .cache := hh
      obtain ⟨r', hc, i1, i2⟩ := g3 hh'
      have hrr : r = r' := by
        unfold heapranks at hr; rw [hh', hc] at hr; exact (Option.some.inj hr).symm
      subst hrr
      refine ⟨r, hc, ?_, ?_⟩
      · intro q k hq
        rw [(push_perm).mem_iff]
        simp only [get_put] at hq
        split at hq
        · cases hq; subst_vars; simp
        · exact List.mem_append_left _ (i1 q k hq)
      · intro e he hae
        rw [(push_perm).mem_iff] at he
        rcases List.mem_append.mp he with he | he
        · exact i2 e he hae
        · simp at he; subst he; rfl

-- delete keeps the promise
theorem delete_good {s : State α} (hs : good n s) (p : α) : good n (delete s p) := by
  obtain ⟨g1, g2, g3⟩ := hs
  refine ⟨g1, ?_, ?_⟩
  · intro q k hq; simp only [delete, get_del] at hq; split at hq
    · cases hq
    · exact g2 q k hq
  · intro hh
    obtain ⟨r, hc, i1, i2⟩ := g3 hh
    refine ⟨r, hc, ?_, i2⟩
    intro q k hq; simp only [delete, get_del] at hq; split at hq
    · cases hq
    · exact i1 q k hq

end next

/-! ## next is total (lemma N's core) -/

section total

variable {α : Type} [DecidableEq α]

-- following after through the due: p due, after q, q due
def step (due : List (α × Nat)) (after : α → Option α) (p q : α) : Prop :=
  (get due p).isSome ∧ after p = some q ∧ (get due q).isSome

theorem waiting_true {due : List (α × Nat)} {after : α → Option α} {p : α}
    (h : waiting due after p = true) : ∃ q, after p = some q ∧ (get due q).isSome := by
  unfold waiting at h
  split at h
  · exact ⟨_, ‹_›, h⟩
  · cases h

-- the walk along after from x, seen the due before it on the walk: it ends at a due computation
-- not waiting, within as many steps as there are due
theorem walk {due : List (α × Nat)} {after : α → Option α}
    (acyclic : ∀ p, ¬ Relation.TransGen (step due after) p p) :
    ∀ (k : Nat) (x : α) (seen : List α), (due.map Prod.fst).length ≤ seen.length + k →
      seen.Nodup → (∀ s ∈ seen, (get due s).isSome) →
      (∀ s ∈ seen, Relation.TransGen (step due after) s x) → (get due x).isSome →
      ∃ p m, get due p = some m ∧ waiting due after p = false := by
  intro k
  induction k with
  | zero =>
    intro x seen hk hnd hdue hreach hx
    cases hw : waiting due after x with
    | false =>
      obtain ⟨m, hm⟩ := Option.isSome_iff_exists.mp hx
      exact ⟨x, m, hm, hw⟩
    | true =>
      exfalso
      have hxs : x ∉ seen := fun h => acyclic x (hreach x h)
      have hsub : (x :: seen) ⊆ due.map Prod.fst := by
        intro s hs
        have : (get due s).isSome := by
          rcases List.mem_cons.mp hs with rfl | hs
          · exact hx
          · exact hdue s hs
        obtain ⟨m, hm⟩ := Option.isSome_iff_exists.mp this
        exact List.mem_map.mpr ⟨(s, m), get_mem hm, rfl⟩
      have := List.Nodup.length_le_of_subset (List.nodup_cons.mpr ⟨hxs, hnd⟩) hsub
      simp only [List.length_map, List.length_cons] at this hk; omega
  | succ k ih =>
    intro x seen hk hnd hdue hreach hx
    cases hw : waiting due after x with
    | false =>
      obtain ⟨m, hm⟩ := Option.isSome_iff_exists.mp hx
      exact ⟨x, m, hm, hw⟩
    | true =>
      obtain ⟨y, hy, hyd⟩ := waiting_true hw
      have hst : step due after x y := ⟨hx, hy, hyd⟩
      have hxs : x ∉ seen := fun h => acyclic x (hreach x h)
      refine ih y (x :: seen) (by simp only [List.length_map, List.length_cons] at hk ⊢; omega) (List.nodup_cons.mpr ⟨hxs, hnd⟩) ?_ ?_ hyd
      · intro s hs
        rcases List.mem_cons.mp hs with rfl | hs
        · exact hx
        · exact hdue s hs
      · intro s hs
        rcases List.mem_cons.mp hs with rfl | hs
        · exact .single hst
        · exact .tail (hreach s hs) hst

-- some due computation is not waiting after a due one, when anything is due and following after
-- through the due has no cycle
theorem total {due : List (α × Nat)} {after : α → Option α} (hne : due ≠ [])
    (acyclic : ∀ p, ¬ Relation.TransGen (step due after) p p) :
    ∃ p m, get due p = some m ∧ waiting due after p = false := by
  obtain ⟨⟨p, m⟩, rest, rfl⟩ : ∃ x rest, due = x :: rest := by
    cases due with
    | nil => exact absurd rfl hne
    | cons x rest => exact ⟨x, rest, rfl⟩
  refine walk acyclic (((p, m) :: rest).map Prod.fst).length p [] (by simp) List.nodup_nil
    (by simp) (by simp) ?_
  simp [get]

-- so best! is defined: next gives a computation whenever anything is due, given no after cycle
theorem next_total (n : α → Nat) (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s : State α}
    (hs : good n s) (hne : s.due ≠ [])
    (acyclic : ∀ p, ¬ Relation.TransGen (step s.due s.after) p p) :
    ∃ p k, (next n rk s).1 = some (p, k) := by
  cases hb : (next n rk s).1 with
  | some x => exact ⟨x.1, x.2, rfl⟩
  | none =>
    obtain ⟨p, m, hp, hw⟩ := total hne acyclic
    have := next_none n rk hs hb p m hp
    rw [hw] at this; cases this

end total

/-! ## the rank cache: started, sees, waits, gone -/

section cache

variable {α : Type} [DecidableEq α]

-- f, with b at a (a property set on an object)
def update {β : Type} (f : α → β) (a : α) (b : β) : α → β := fun x => if x = a then b else f x

-- order.ts, name: q named d more times; none at 0 or below
def name (s : State α) (q : α) (d : Int) : State α :=
  { s with named := update s.named q ((s.named q + d).toNat) }

-- a turn of sees' and waits' loops: q named d more times by p, the cache dropped when p to q is
-- an edge (order.ts, sees, waits)
def touch (p : α) (d : Int) (s : State α) (q : α) : State α :=
  let s := name s q d
  if edge s p q then drop s else s

-- order.ts, started: rankOf?.set(p, 0). the model makes p alive here (make: state "alive")
def started (s : State α) (p : α) : State α :=
  { s with alive := update s.alive p true, cache := s.cache.map (fun r => update r p (some 0)) }

-- order.ts, sees: p.values becomes next
def sees (s : State α) (p : α) (next : List α) : State α :=
  let old := s.values p
  let s := old.foldl (fun s q => if q ∈ next then s else touch p (-1) s q) s
  let s := next.foldl (fun s q => if q ∈ old then s else touch p 1 s q) s
  { s with values := update s.values p next }

-- order.ts, waits: p.after becomes q
def waits (s : State α) (p : α) (q : Option α) : State α :=
  if s.after p = q then s else
  let s := match s.after p with
    | some a => touch p (-1) s a
    | none => s
  let s := { s with after := update s.after p q }
  match q with
  | some b => touch p 1 s b
  | none => s

-- gone's end: p named by none of its values and its after, after nothing (order.ts, gone)
def forget (s : State α) (p : α) : State α :=
  let s := (s.values p).foldl (fun s q => name s q (-1)) s
  let s := { s with values := update s.values p [] }
  let s := match s.after p with
    | some a => name s a (-1)
    | none => s
  { s with after := update s.after p none }

-- order.ts, gone: not due, out of the ranks, after nothing. the model makes p not alive here
-- (dispose: state "disposing", just before)
def gone (s : State α) (p : α) : State α :=
  let s := { s with alive := update s.alive p false }
  let s := if s.named p > 0 then drop s else s
  forget { s with cache := s.cache.map (fun r => update r p none), due := del s.due p } p

/-! ### frames: what each step leaves alone -/

theorem name_eq (s : State α) (q : α) (d : Int) :
    name s q d = { s with named := (name s q d).named } := rfl

theorem names_eq (d : Int) : ∀ (l : List α) (s : State α),
    l.foldl (fun s q => name s q d) s = { s with named := (l.foldl (fun s q => name s q d) s).named }
  | [], s => rfl
  | a :: l, s => by
    simp only [List.foldl_cons]
    rw [names_eq d l (name s a d)]
    rfl

theorem names_named (d : Int) : ∀ (l : List α) (s : State α), l.Nodup → ∀ x,
    (l.foldl (fun s q => name s q d) s).named x =
      if x ∈ l then ((s.named x : Int) + d).toNat else s.named x
  | [], s, _, x => by simp
  | a :: l, s, hn, x => by
    simp only [List.foldl_cons]
    rw [names_named d l (name s a d) (List.nodup_cons.mp hn).2 x]
    have ha := (List.nodup_cons.mp hn).1
    simp only [name, update, List.mem_cons]
    by_cases hx : x = a
    · subst hx; simp [ha]
    · simp [hx]

theorem edge_eq {s t : State α} (h : s.alive = t.alive) : edge s = edge t := by
  funext p q; simp [edge, h]

-- a turn: named by d, the cache dropped on an edge, nothing else
theorem touch_fields (p : α) (d : Int) (s : State α) (q : α) :
    let t := touch p d s q
    t.alive = s.alive ∧ t.values = s.values ∧ t.after = s.after ∧ t.due = s.due ∧
    t.heap = s.heap ∧ t.named = update s.named q ((s.named q + d).toNat) ∧
    t.cache = (if edge s p q then none else s.cache) ∧
    (edge s p q = false → t.held = s.held) := by
  have he : edge (name s q d) p q = edge s p q := rfl
  simp only [touch, he]
  cases h : edge s p q <;> simp [name, drop]

theorem drop_good (n : α → Nat) {s : State α} (hs : good n s) : good n (drop s) := by
  obtain ⟨g1, g2, g3⟩ := hs
  refine ⟨g1, g2, ?_⟩
  intro hh
  simp only [drop] at hh
  split at hh
  · cases hh
  · rename_i h c hne
    exfalso
    obtain ⟨r, hr, _⟩ := g3 hh
    exact hne r hh hr

theorem touch_good (n : α → Nat) {s : State α} (hs : good n s) (p : α) (d : Int) (q : α) :
    good n (touch p d s q) := by
  simp only [touch]
  split
  · exact drop_good n hs
  · exact hs

-- sees' and waits' loops: the computations and the due untouched, the cache dropped when any turn
-- is on an edge, the promise kept
theorem touches (n : α → Nat) (p : α) (d : Int) (skip : List α) : ∀ (l : List α) (s : State α),
    let t := l.foldl (fun s q => if q ∈ skip then s else touch p d s q) s
    t.alive = s.alive ∧ t.values = s.values ∧ t.after = s.after ∧ t.due = s.due ∧
    t.heap = s.heap ∧
    t.cache = (if l.any (fun q => q ∉ skip && edge s p q) then none else s.cache) ∧
    (good n s → good n t)
  | [], s => by simp
  | a :: l, s => by
    simp only [List.foldl_cons]
    generalize hs1 : (if a ∈ skip then s else touch p d s a) = s1
    have f1 : s1.alive = s.alive ∧ s1.values = s.values ∧ s1.after = s.after ∧ s1.due = s.due ∧
        s1.heap = s.heap ∧ s1.cache = (if a ∉ skip ∧ edge s p a then none else s.cache) ∧
        (good n s → good n s1) := by
      subst hs1
      split
      · simp_all
      · obtain ⟨t1, t2, t3, t4, t5, -, t7, -⟩ := touch_fields p d s a
        refine ⟨t1, t2, t3, t4, t5, ?_, fun hg => touch_good n hg p d a⟩
        rw [t7]; simp_all
    obtain ⟨i1, i2, i3, i4, i5, i6, i7⟩ := touches n p d skip l s1
    have he : edge s1 = edge s := edge_eq f1.1
    refine ⟨i1.trans f1.1, i2.trans f1.2.1, i3.trans f1.2.2.1, i4.trans f1.2.2.2.1,
      i5.trans f1.2.2.2.2.1, ?_, fun hg => i7 (f1.2.2.2.2.2.2 hg)⟩
    rw [i6, f1.2.2.2.2.2.1, he]
    simp only [List.any_cons]
    by_cases ha : a ∈ skip <;> by_cases hea : edge s p a = true <;> simp_all

theorem touches_named (p : α) (d : Int) (skip : List α) : ∀ (l : List α) (s : State α), l.Nodup →
    ∀ x, (l.foldl (fun s q => if q ∈ skip then s else touch p d s q) s).named x =
      if x ∈ l ∧ x ∉ skip then ((s.named x : Int) + d).toNat else s.named x
  | [], s, _, x => by simp
  | a :: l, s, hn, x => by
    simp only [List.foldl_cons]
    rw [touches_named p d skip l _ (List.nodup_cons.mp hn).2 x]
    have ha := (List.nodup_cons.mp hn).1
    have h1 : ∀ y, (if a ∈ skip then s else touch p d s a).named y =
        if y = a ∧ a ∉ skip then ((s.named a : Int) + d).toNat else s.named y := by
      intro y
      split
      · rename_i hs; simp [hs]
      · rename_i hs
        rw [(touch_fields p d s a).2.2.2.2.2.1]
        by_cases hy : y = a
        · subst hy; simp [hs, update]
        · simp [hy, update]
    rw [h1]
    by_cases hx : x = a
    · subst hx; simp [ha]
    · simp [hx]

/-! ### sees -/

theorem sees_fields (n : α → Nat) (s : State α) (p : α) (next : List α) :
    let t := sees s p next
    t.alive = s.alive ∧ t.values = update s.values p next ∧ t.after = s.after ∧
    t.due = s.due ∧ t.heap = s.heap ∧
    (t.cache = none ∨
      (t.cache = s.cache ∧ ∀ q, edge s p q = true → (q ∈ s.values p ↔ q ∈ next))) ∧
    (good n s → good n t) := by
  simp only [sees]
  generalize hs1 : (s.values p).foldl
    (fun s q => if q ∈ next then s else touch p (-1) s q) s = s1
  obtain ⟨a1, v1, f1, d1, h1, c1, g1⟩ := touches n p (-1) next (s.values p) s
  rw [hs1] at a1 v1 f1 d1 h1 c1 g1
  obtain ⟨a2, v2, f2, d2, h2, c2, g2⟩ := touches n p 1 (s.values p) next s1
  have he : edge s1 = edge s := edge_eq a1
  refine ⟨a2.trans a1, by rw [v2, v1], f2.trans f1, d2.trans d1, h2.trans h1, ?_,
    fun hg => g2 (g1 hg)⟩
  rw [c2, he, c1]
  by_cases k1 : (s.values p).any (fun q => q ∉ next && edge s p q) = true
  · left; rw [ite_eq_left k1]; split <;> rfl
  · by_cases k2 : next.any (fun q => q ∉ s.values p && edge s p q) = true
    · left; rw [ite_eq_left k2]
    · right
      simp only [k1, k2, Bool.false_eq_true, ite_false, true_and]
      intro q hq
      simp only [List.any_eq_true, Bool.and_eq_true, decide_eq_true_eq, not_exists,
        not_and] at k1 k2
      constructor
      · intro hv; exact Decidable.byContradiction fun hn => k1 q hv hn hq
      · intro hn; exact Decidable.byContradiction fun hv => k2 q hn hv hq

theorem sees_named (s : State α) (p : α) (next : List α) (hv : (s.values p).Nodup)
    (hn : next.Nodup) (x : α) :
    (sees s p next).named x =
      if x ∈ s.values p ∧ x ∉ next then s.named x - 1
      else if x ∈ next ∧ x ∉ s.values p then s.named x + 1 else s.named x := by
  simp only [sees]
  rw [touches_named p 1 (s.values p) next _ hn x, touches_named p (-1) next (s.values p) s hv x]
  by_cases h1 : x ∈ s.values p <;> by_cases h2 : x ∈ next <;> simp [h1, h2] <;> omega

-- the cache, when there, is the ranks made now (order.ts, rankOf)
def right (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) : Prop :=
  ∀ r, s.cache = some r → r = made rk s

theorem made_eq (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s t : State α}
    (ha : t.alive = s.alive) (hl : link t = link s) : made rk t = made rk s := by
  unfold made; rw [ha, hl]

theorem sees_right (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) (p : α)
    (next : List α) (hr : right rk s) : right rk (sees s p next) := by
  intro r hc
  obtain ⟨f1, f2, f3, -, -, f6, -⟩ := sees_fields (fun _ => 0) s p next
  rcases f6 with h | ⟨h, hl⟩
  · rw [h] at hc; cases hc
  · rw [h] at hc
    rw [hr r hc]
    refine (made_eq rk f1 ?_).symm
    funext x y
    simp only [link, f2, f3, update]
    have hee : edge (sees s p next) = edge s := edge_eq f1
    rw [hee]
    by_cases hx : x = p
    · subst hx
      cases he : edge s x y
      · simp
      · simp [hl y he]
    · simp [hx]

/-! ### waits -/

theorem waits_fields (n : α → Nat) (s : State α) (p : α) (q : Option α) :
    let t := waits s p q
    t.alive = s.alive ∧ t.values = s.values ∧ t.after = update s.after p q ∧
    t.due = s.due ∧ t.heap = s.heap ∧
    (t.cache = none ∨
      (t.cache = s.cache ∧ ∀ y, edge s p y = true → (s.after p = some y ↔ q = some y))) ∧
    (good n s → good n t) := by
  simp only [waits]
  split
  · rename_i heq
    refine ⟨rfl, rfl, ?_, rfl, rfl, Or.inr ⟨rfl, fun y _ => by rw [heq]⟩, id⟩
    funext x; simp only [update]; split <;> simp_all
  · rename_i hne
    -- the old after's turn
    have s1f : ∀ (s1 : State α), s1 = (match s.after p with
        | some a => touch p (-1) s a
        | none => s) →
        s1.alive = s.alive ∧ s1.values = s.values ∧ s1.after = s.after ∧ s1.due = s.due ∧
        s1.heap = s.heap ∧ (s1.cache = none ∨
          (s1.cache = s.cache ∧ ∀ a, s.after p = some a → edge s p a = false)) ∧
        (good n s → good n s1) := by
      intro s1 h1
      cases ha : s.after p with
      | none =>
        rw [ha] at h1; subst h1
        exact ⟨rfl, rfl, rfl, rfl, rfl, Or.inr ⟨rfl, fun a h => by cases h⟩, id⟩
      | some a =>
        rw [ha] at h1; subst h1
        obtain ⟨t1, t2, t3, t4, t5, -, t7, -⟩ := touch_fields p (-1) s a
        refine ⟨t1, t2, t3, t4, t5, ?_, fun hg => touch_good n hg p (-1) a⟩
        rw [t7]
        cases he : edge s p a
        · right; refine ⟨by simp, ?_⟩
          intro b hb; cases hb; exact he
        · left; simp
    generalize hs1 : (match s.after p with
        | some a => touch p (-1) s a
        | none => s) = s1
    obtain ⟨a1, v1, f1, d1, h1, c1, g1⟩ := s1f s1 hs1.symm
    have he1 : edge s1 = edge s := edge_eq a1
    cases q with
    | none =>
      refine ⟨a1, v1, by rw [f1], d1, h1, ?_, g1⟩
      rcases c1 with c | ⟨c, k⟩
      · left; exact c
      · right; refine ⟨c, ?_⟩
        intro y hy
        constructor
        · intro hy'; rw [k y hy'] at hy; cases hy
        · intro h; cases h
    | some b =>
      simp only
      obtain ⟨t1, t2, t3, t4, t5, -, t7, -⟩ :=
        touch_fields p 1 { s1 with after := update s1.after p (some b) } b
      refine ⟨t1.trans a1, t2.trans v1, by rw [t3, f1], t4.trans d1, t5.trans h1, ?_,
        fun hg => touch_good n
          (show good n { s1 with after := update s1.after p (some b) } from g1 hg) p 1 b⟩
      rw [t7]
      have he2 : edge { s1 with after := update s1.after p (some b) } = edge s := he1
      rw [he2]
      cases hb : edge s p b
      · simp only [Bool.false_eq_true, ite_false]
        rcases c1 with c | ⟨c, k⟩
        · left; exact c
        · right; refine ⟨c, ?_⟩
          intro y hy
          constructor
          · intro hy'; rw [k y hy'] at hy; cases hy
          · intro h; cases h; rw [hb] at hy; cases hy
      · left; simp

theorem waits_named (s : State α) (p : α) (q : Option α) (hne : s.after p ≠ q) (x : α) :
    (waits s p q).named x =
      (if q = some x then 1 else 0) +
        (if s.after p = some x then s.named x - 1 else s.named x) := by
  simp only [waits, hne, ite_false]
  have h1 : ∀ y, (match s.after p with
      | some a => touch p (-1) s a
      | none => s).named y = if s.after p = some y then s.named y - 1 else s.named y := by
    intro y
    cases ha : s.after p with
    | none => simp
    | some a =>
      simp only [(touch_fields p (-1) s a).2.2.2.2.2.1, update, Option.some.injEq]
      by_cases hy : y = a
      · subst hy; simp; omega
      · simp [hy, Ne.symm hy]
  cases q with
  | none => simp [h1]
  | some b =>
    simp only
    rw [(touch_fields p 1 _ b).2.2.2.2.2.1]
    simp only [update, Option.some.injEq]
    by_cases hx : x = b
    · subst hx; simp only [ite_true, h1]; omega
    · simp [hx, Ne.symm hx, h1]

theorem waits_right (rk : (α → Bool) → (α → α → Bool) → α → Nat) (s : State α) (p : α)
    (q : Option α) (hr : right rk s) : right rk (waits s p q) := by
  intro r hc
  obtain ⟨f1, f2, f3, -, -, f6, -⟩ := waits_fields (fun _ => 0) s p q
  rcases f6 with h | ⟨h, hl⟩
  · rw [h] at hc; cases hc
  · rw [h] at hc
    rw [hr r hc]
    refine (made_eq rk f1 ?_).symm
    funext x y
    simp only [link, f2, f3, update]
    have hee : edge (waits s p q) = edge s := edge_eq f1
    rw [hee]
    by_cases hx : x = p
    · subst hx
      cases he : edge s x y
      · simp
      · simp [hl y he]
    · simp [hx]

/-! ### named counts -/

-- the computations, each once: the model's world is finite
def world (univ : List α) : Prop := ∀ x, univ.count x = 1

-- how many are after q: have it in their values, or wait after it (order.ts, named)
def count (univ : List α) (s : State α) (q : α) : Nat :=
  univ.countP (fun x => q ∈ s.values x) + univ.countP (fun x => s.after x = some q)

-- named holds the counts (order.ts, named), and values are sets
def counted (univ : List α) (s : State α) : Prop :=
  (∀ q, s.named q = count univ s q) ∧ ∀ x, (s.values x).Nodup

theorem countp_update {P P' : α → Bool} {p : α} (h : ∀ x, x ≠ p → P' x = P x) :
    ∀ l : List α, l.countP P' + l.count p * (if P p then 1 else 0) =
      l.countP P + l.count p * (if P' p then 1 else 0)
  | [] => by simp
  | x :: l => by
    have ih := countp_update h l
    simp only [List.countP_cons, List.count_cons]
    by_cases hx : x = p
    · subst hx
      cases hP : P x <;> cases hP' : P' x <;> simp_all <;> omega
    · rw [h x hx]
      have : (x == p) = false := by simp [hx]
      simp only [this, Bool.false_eq_true, ite_false, Nat.add_zero]
      omega

theorem world_update {univ : List α} (hu : world univ) {P P' : α → Bool} {p : α}
    (h : ∀ x, x ≠ p → P' x = P x) :
    univ.countP P' + (if P p then 1 else 0) = univ.countP P + (if P' p then 1 else 0) := by
  have := countp_update h univ
  rw [hu p] at this
  simpa using this

-- named nothing: nobody has q in its values or waits after it
theorem count_zero {univ : List α} (hu : world univ) {s : State α} {q : α}
    (h : count univ s q = 0) : ∀ x, q ∉ s.values x ∧ s.after x ≠ some q := by
  intro x
  have hx : x ∈ univ := List.count_pos_iff.mp (by rw [hu x]; omega)
  unfold count at h
  have h1 : univ.countP (fun x => q ∈ s.values x) = 0 := by omega
  have h2 : univ.countP (fun x => s.after x = some q) = 0 := by omega
  rw [List.countP_eq_zero] at h1 h2
  exact ⟨by simpa using h1 x hx, by simpa using h2 x hx⟩

theorem sees_counted {univ : List α} (hu : world univ) {s : State α} (hc : counted univ s)
    (p : α) {next : List α} (hn : next.Nodup) : counted univ (sees s p next) := by
  obtain ⟨f1, f2, f3, -⟩ := sees_fields (fun _ => 0) s p next
  obtain ⟨c1, c2⟩ := hc
  refine ⟨?_, ?_⟩
  · intro x
    rw [sees_named s p next (c2 p) hn x, c1 x]
    unfold count
    rw [f2, f3]
    have := world_update hu (P := fun y => x ∈ s.values y)
      (P' := fun y => x ∈ update s.values p next y) (p := p)
      (by intro y hy; simp [update, hy])
    have hp : update s.values p next p = next := by simp [update]
    simp only [hp] at this
    by_cases h1 : x ∈ s.values p <;> by_cases h2 : x ∈ next <;> simp [h1, h2] at this ⊢ <;> omega
  · intro x; rw [f2]; simp only [update]; split
    · exact hn
    · exact c2 x

theorem waits_counted {univ : List α} (hu : world univ) {s : State α} (hc : counted univ s)
    (p : α) (q : Option α) : counted univ (waits s p q) := by
  obtain ⟨f1, f2, f3, -⟩ := waits_fields (fun _ => 0) s p q
  obtain ⟨c1, c2⟩ := hc
  refine ⟨?_, by rw [f2]; exact c2⟩
  intro x
  by_cases hne : s.after p = q
  · have : waits s p q = s := by simp [waits, hne]
    rw [this]; exact c1 x
  rw [waits_named s p q hne x, c1 x]
  unfold count
  rw [f2, f3]
  have := world_update hu (P := fun y => s.after y = some x)
    (P' := fun y => update s.after p q y = some x) (p := p)
    (by intro y hy; simp [update, hy])
  have hp : update s.after p q p = q := by simp [update]
  simp only [hp] at this
  by_cases h1 : s.after p = some x <;> by_cases h2 : q = some x
  · exact absurd (h1.trans h2.symm) hne
  all_goals simp [h1, h2] at this ⊢; omega

/-! ### started and gone -/

-- what the cache needs of the ranks (rank.ts, as rk): a rank depends only on what is reachable. so
-- one made linked to by none and linking to none is 0, and changes no other rank; and one going
-- linked to by none changes no other rank. links go only to the alive
structure reach (rk : (α → Bool) → (α → α → Bool) → α → Nat) : Prop where
  start : ∀ (A : α → Bool) (L : α → α → Bool) (p : α), A p = false → (∀ x, L x p = false) →
    (∀ y, L p y = false) → (∀ x y, L x y = true → A y = true) →
    rk (update A p true) L p = 0 ∧ ∀ q, A q = true → rk (update A p true) L q = rk A L q
  gone : ∀ (A : α → Bool) (L L' : α → α → Bool) (p : α), (∀ x, L x p = false) →
    (∀ x y, x ≠ p → L' x y = L x y) → (∀ y, L' p y = false) →
    (∀ x y, L x y = true → A y = true) →
    ∀ q, q ≠ p → A q = true → rk (update A p false) L' q = rk A L q

-- p is new (scheduler.ts, make): not alive, after nothing, named by none, not due, in no entry
def fresh (s : State α) (p : α) : Prop :=
  s.alive p = false ∧ s.values p = [] ∧ s.after p = none ∧
  (∀ x, p ∉ s.values x ∧ s.after x ≠ some p) ∧ get s.due p = none ∧ ∀ e ∈ s.heap, e.p ≠ p

theorem link_alive (s : State α) (x y : α) (h : link s x y = true) : s.alive y = true := by
  simp only [link, edge, Bool.and_eq_true, decide_eq_true_eq] at h
  exact h.1.2

section names
variable (d : Int) (l : List α) (s : State α)
@[simp] theorem names_due : (l.foldl (fun s q => name s q d) s).due = s.due := by
  rw [names_eq]
@[simp] theorem names_heap : (l.foldl (fun s q => name s q d) s).heap = s.heap := by
  rw [names_eq]
@[simp] theorem names_held : (l.foldl (fun s q => name s q d) s).held = s.held := by
  rw [names_eq]
@[simp] theorem names_cache : (l.foldl (fun s q => name s q d) s).cache = s.cache := by
  rw [names_eq]
@[simp] theorem names_alive : (l.foldl (fun s q => name s q d) s).alive = s.alive := by
  rw [names_eq]
@[simp] theorem names_values : (l.foldl (fun s q => name s q d) s).values = s.values := by
  rw [names_eq]
@[simp] theorem names_after : (l.foldl (fun s q => name s q d) s).after = s.after := by
  rw [names_eq]
@[simp] theorem name_due (q : α) : (name s q d).due = s.due := rfl
@[simp] theorem name_heap (q : α) : (name s q d).heap = s.heap := rfl
@[simp] theorem name_held (q : α) : (name s q d).held = s.held := rfl
@[simp] theorem name_cache (q : α) : (name s q d).cache = s.cache := rfl
@[simp] theorem name_alive (q : α) : (name s q d).alive = s.alive := rfl
@[simp] theorem name_values (q : α) : (name s q d).values = s.values := rfl
@[simp] theorem name_after (q : α) : (name s q d).after = s.after := rfl
@[simp] theorem name_named (q : α) :
    (name s q d).named = update s.named q ((s.named q + d).toNat) := rfl
end names

section forget
variable (t : State α) (p : α)
theorem forget_eq : forget t p = { t with
    values := update t.values p [], after := update t.after p none
    named := (forget t p).named } := by
  cases ha : t.after p <;> simp [forget, ha]
@[simp] theorem forget_due : (forget t p).due = t.due := by rw [forget_eq]
@[simp] theorem forget_heap : (forget t p).heap = t.heap := by rw [forget_eq]
@[simp] theorem forget_held : (forget t p).held = t.held := by rw [forget_eq]
@[simp] theorem forget_cache : (forget t p).cache = t.cache := by rw [forget_eq]
@[simp] theorem forget_alive : (forget t p).alive = t.alive := by rw [forget_eq]
@[simp] theorem forget_values : (forget t p).values = update t.values p [] := by rw [forget_eq]
@[simp] theorem forget_after : (forget t p).after = update t.after p none := by rw [forget_eq]
end forget

theorem gone_fields (s : State α) (p : α) :
    let t := gone s p
    t.alive = update s.alive p false ∧ t.values = update s.values p [] ∧
    t.after = update s.after p none ∧ t.due = del s.due p ∧ t.heap = s.heap ∧
    t.cache = (if s.named p > 0 then none else s.cache).map (fun r => update r p none) ∧
    t.held = (if s.named p > 0 then (drop s).held else s.held) := by
  by_cases hn : s.named p > 0 <;> simp [gone, hn, drop]

theorem forget_named (t : State α) (p : α) (hv : (t.values p).Nodup) (x : α) :
    (forget t p).named x =
      (if t.after p = some x then (if x ∈ t.values p then t.named x - 1 else t.named x) - 1
        else if x ∈ t.values p then t.named x - 1 else t.named x) := by
  have hf : ((t.values p).foldl (fun s q => name s q (-1)) t).named x =
      if x ∈ t.values p then t.named x - 1 else t.named x := by
    rw [names_named (-1) _ _ hv x]
    split <;> omega
  cases ha : t.after p with
  | none =>
    simp [forget, ha]
    exact hf
  | some a =>
    simp only [forget, names_after, ha, name_named, update, Option.some.injEq]
    by_cases hx : x = a
    · subst hx; simp only [ite_true]; rw [hf]; split <;> omega
    · simp only [hx, ite_false, Ne.symm hx]; exact hf

theorem gone_named (s : State α) (p : α) (hv : (s.values p).Nodup) (x : α) :
    (gone s p).named x =
      (if s.after p = some x then (if x ∈ s.values p then s.named x - 1 else s.named x) - 1
        else if x ∈ s.values p then s.named x - 1 else s.named x) := by
  unfold gone
  simp only
  rw [forget_named _ p (by split <;> simpa [drop] using hv) x]
  split <;> rfl

theorem made_fields (rk : (α → Bool) → (α → α → Bool) → α → Nat) {s t : State α}
    (ha : t.alive = s.alive) (hv : t.values = s.values) (hf : t.after = s.after) :
    made rk t = made rk s := by
  apply made_eq rk ha
  funext x y; simp only [link, edge, ha, hv, hf]

theorem started_good (n : α → Nat) {s : State α} (hs : good n s) {p : α} (hp : fresh s p) :
    good n (started s p) := by
  obtain ⟨g1, g2, g3⟩ := hs
  obtain ⟨-, -, -, -, hd, he⟩ := hp
  refine ⟨g1, ?_, ?_⟩
  · intro q m hq
    simp only [started, update]
    split
    · rfl
    · exact g2 q m hq
  · intro hh
    obtain ⟨r, hc, i1, i2⟩ := g3 hh
    refine ⟨update r p (some 0), by simp [started, hc], ?_, ?_⟩
    · intro q m hq
      have hqp : q ≠ p := by
        rintro rfl; have : get s.due q = some m := hq; rw [hd] at this; cases this
      have : entry (update r p (some 0)) q m = entry r q m := by simp [entry, update, hqp]
      rw [this]; exact i1 q m hq
    · intro e hm ha
      have hep := he e hm
      simp only [started, update, hep, ite_false] at ha ⊢
      exact i2 e hm ha

theorem started_right (rk : (α → Bool) → (α → α → Bool) → α → Nat) (hk : reach rk)
    {s : State α} {p : α} (hp : fresh s p) (hr : right rk s) : right rk (started s p) := by
  obtain ⟨ha, hv, hf, hn, -, -⟩ := hp
  intro r' hc
  simp only [started] at hc
  cases hc0 : s.cache with
  | none => rw [hc0] at hc; cases hc
  | some r =>
    rw [hc0] at hc; simp only [Option.map_some, Option.some.injEq] at hc; subst hc
    rw [hr r hc0]
    have hl : link (started s p) = link s := by
      funext x y
      simp only [link, edge, started, update]
      by_cases hy : y = p
      · subst hy; simp [(hn x).1, (hn x).2]
      · simp only [hy, ↓reduceIte]; rfl
    have hk1 := hk.start s.alive (link s) p ha
      (by intro x; simp [link, (hn x).1, (hn x).2])
      (by intro y; simp [link, hv, hf])
      (link_alive s)
    funext q
    unfold made
    rw [hl]
    simp only [started]
    by_cases hq : q = p
    · subst hq; simp [update, hk1.1]
    · simp only [update, hq, ite_false]
      split
      · rename_i hqa; rw [hk1.2 q hqa]
      · rfl

theorem started_counted {univ : List α} {s : State α} (hc : counted univ s) (p : α) :
    counted univ (started s p) := hc

theorem gone_good (n : α → Nat) {s : State α} (hs : good n s) (p : α) : good n (gone s p) := by
  obtain ⟨f1, -, -, f4, f5, f6, f7⟩ := gone_fields s p
  have hd := drop_good n hs
  obtain ⟨g1, g2, g3⟩ := hs
  refine ⟨by rw [f5]; exact g1, ?_, ?_⟩
  · intro q m hq
    rw [f4, get_del] at hq
    split at hq
    · cases hq
    · rename_i hqp; rw [f1]; simp only [update, Ne.symm hqp, ite_false]; exact g2 q m hq
  · intro hh
    rw [f7] at hh
    split at hh
    · rename_i hpos
      exfalso
      obtain ⟨r, hr, _⟩ := hd.2.2 hh
      simp [drop] at hr
    · rename_i hpos
      obtain ⟨r, hc, i1, i2⟩ := g3 hh
      refine ⟨update r p none, by rw [f6]; simp [hpos, hc], ?_, ?_⟩
      · intro q m hq
        rw [f4, get_del] at hq
        split at hq
        · cases hq
        · rename_i hqp
          have : entry (update r p none) q m = entry r q m := by
            simp [entry, update, Ne.symm hqp]
          rw [this, f5]; exact i1 q m hq
      · intro e hm ha
        rw [f5] at hm
        rw [f1] at ha
        have hep : e.p ≠ p := by intro h; simp [update, h] at ha
        simp only [update, hep, ite_false] at ha ⊢
        exact i2 e hm ha

theorem gone_right (rk : (α → Bool) → (α → α → Bool) → α → Nat) (hk : reach rk)
    {univ : List α} (hu : world univ) {s : State α} (hc : counted univ s) (p : α)
    (hr : right rk s) : right rk (gone s p) := by
  obtain ⟨f1, f2, f3, -, -, f6, -⟩ := gone_fields s p
  intro r' hr'
  rw [f6] at hr'
  split at hr'
  · cases hr'
  · rename_i hpos
    cases hc0 : s.cache with
    | none => rw [hc0] at hr'; cases hr'
    | some r =>
      rw [hc0] at hr'; simp only [Option.map_some, Option.some.injEq] at hr'; subst hr'
      rw [hr r hc0]
      have h0 : count univ s p = 0 := by rw [← hc.1 p]; omega
      have hn := count_zero hu h0
      have hlp : ∀ x, link s x p = false := by intro x; simp [link, (hn x).1, (hn x).2]
      have hk1 := hk.gone s.alive (link s) (link (gone s p)) p hlp
        (by
          intro x y hx
          simp only [link, edge, f1, f2, f3, update, hx, ite_false]
          by_cases hy : y = p
          · subst hy; simp [(hn x).1, (hn x).2]
          · simp [hy])
        (by intro y; simp [link, f2, f3, update])
        (link_alive s)
      funext q
      unfold made
      rw [f1]
      by_cases hq : q = p
      · subst hq; simp [update]
      · simp only [update, hq, ite_false]
        split
        · rename_i hqa; rw [hk1 q hq hqa]
        · rfl

theorem gone_counted {univ : List α} (hu : world univ) {s : State α} (hc : counted univ s)
    (p : α) : counted univ (gone s p) := by
  obtain ⟨f1, f2, f3, -⟩ := gone_fields s p
  obtain ⟨c1, c2⟩ := hc
  refine ⟨?_, ?_⟩
  · intro x
    rw [gone_named s p (c2 p) x, c1 x]
    unfold count
    rw [f2, f3]
    have hV := world_update hu (P := fun y => x ∈ s.values y)
      (P' := fun y => x ∈ update s.values p [] y) (p := p)
      (by intro y hy; simp [update, hy])
    have hA := world_update hu (P := fun y => s.after y = some x)
      (P' := fun y => update s.after p none y = some x) (p := p)
      (by intro y hy; simp [update, hy])
    have hp1 : update s.values p [] p = [] := by simp [update]
    have hp2 : update s.after p none p = none := by simp [update]
    simp only [hp1, hp2] at hV hA
    by_cases h1 : x ∈ s.values p <;> by_cases h2 : s.after p = some x <;>
      simp [h1, h2] at hV hA ⊢ <;> omega
  · intro x; rw [f2]; simp only [update]; split
    · exact List.nodup_nil
    · exact c2 x

end cache

/-! ## all together: what order keeps, step by step -/

section keeps

variable {α : Type} [DecidableEq α] (n : α → Nat) (rk : (α → Bool) → (α → α → Bool) → α → Nat)
  (univ : List α)

-- the heap's promise, the cache right, named counting
def inv (s : State α) : Prop := good n s ∧ right rk s ∧ counted univ s

-- order.ts, createOrder: nothing due, no heap, no ranks, no computation yet
def init : State α :=
  { due := [], heap := [], held := .none, cache := none, named := fun _ => 0,
    alive := fun _ => false, values := fun _ => [], after := fun _ => none }

theorem inv_init : inv n rk univ (init (α := α)) := by
  refine ⟨⟨?_, ?_, ?_⟩, ?_, ?_, ?_⟩
  · intro j x y hx; simp [init] at hx
  · intro p m hp; simp [init, get] at hp
  · intro hh; cases hh
  · intro r hr; cases hr
  · intro q; simp [count, init]
  · intro x; exact List.nodup_nil

theorem next_right {s : State α} (hs : good n s) (hr : right rk s) :
    right rk (next n rk s).2 := by
  obtain ⟨-, rc, -, -, -, -, ralive, rafter, rvalues, -⟩ := ready_spec n rk hs
  intro r' hc
  have h1 : (next n rk s).2.cache = (ready n rk s).1.cache := rfl
  rw [h1, rc] at hc; cases hc
  have hm : made rk (next n rk s).2 = made rk s := made_fields rk ralive rvalues rafter
  rw [hm]
  show (ranks rk s).2 = made rk s
  unfold ranks
  cases hc0 : s.cache with
  | none => rfl
  | some r => exact hr r hc0

theorem inv_set {s : State α} (h : inv n rk univ s) {p : α} (ha : s.alive p = true) (m : Nat) :
    inv n rk univ (set n s p m) := by
  obtain ⟨g, r, c⟩ := h
  refine ⟨set_good n g ha, ?_, ?_⟩
  · unfold set; split <;> exact r
  · unfold set; split <;> exact c

theorem inv_delete {s : State α} (h : inv n rk univ s) (p : α) :
    inv n rk univ (delete s p) :=
  ⟨delete_good n h.1 p, h.2.1, h.2.2⟩

-- next, and the delete of what it gives (first)
theorem inv_next {s : State α} (h : inv n rk univ s) :
    match (next n rk s).1 with
    | some (p, _) => inv n rk univ (delete (next n rk s).2 p)
    | none => inv n rk univ (next n rk s).2 := by
  obtain ⟨g, r, c⟩ := h
  have hg := next_good n rk g
  have hr := next_right n rk g r
  have hc : counted univ (next n rk s).2 := by
    obtain ⟨-, -, -, -, -, -, -, rafter, rvalues, rnamed⟩ := ready_spec n rk g
    have e1 : (next n rk s).2.named = s.named := rnamed
    have e2 : (next n rk s).2.values = s.values := rvalues
    have e3 : (next n rk s).2.after = s.after := rafter
    refine ⟨fun q => ?_, fun x => ?_⟩
    · rw [e1, c.1 q]; unfold count; rw [e2, e3]
    · rw [e2]; exact c.2 x
  revert hg
  split
  · intro hg; exact ⟨hg, hr, hc⟩
  · intro hg; exact ⟨hg, hr, hc⟩

theorem inv_started (hk : reach rk) {s : State α} (h : inv n rk univ s) {p : α}
    (hp : fresh s p) : inv n rk univ (started s p) :=
  ⟨started_good n h.1 hp, started_right rk hk hp h.2.1, started_counted h.2.2 p⟩

theorem inv_sees (hu : world univ) {s : State α} (h : inv n rk univ s) (p : α) {next : List α}
    (hn : next.Nodup) : inv n rk univ (sees s p next) :=
  ⟨(sees_fields n s p next).2.2.2.2.2.2 h.1, sees_right rk s p next h.2.1,
    sees_counted hu h.2.2 p hn⟩

theorem inv_waits (hu : world univ) {s : State α} (h : inv n rk univ s) (p : α) (q : Option α) :
    inv n rk univ (waits s p q) :=
  ⟨(waits_fields n s p q).2.2.2.2.2.2 h.1, waits_right rk s p q h.2.1,
    waits_counted hu h.2.2 p q⟩

theorem inv_gone (hk : reach rk) (hu : world univ) {s : State α} (h : inv n rk univ s) (p : α) :
    inv n rk univ (gone s p) :=
  ⟨gone_good n h.1 p, gone_right rk hk hu h.2.2 p h.2.1, gone_counted hu h.2.2 p⟩

-- with the cache right, the ranks next uses are the ranks of the edges now
theorem ready_made {s : State α} (hr : right rk s) : (ready n rk s).2 = made rk s := by
  show (ranks rk s).2 = made rk s
  unfold ranks
  cases hc0 : s.cache with
  | none => rfl
  | some r => exact hr r hc0

-- next's choice, in the ranks of the edges now (rk of the alive, along link): due, not waiting
-- after a due one, and before no other such by (rank, mark, n)
theorem next_least {s : State α} (h : inv n rk univ s) {p : α} {k : Nat}
    (hb : (next n rk s).1 = some (p, k)) :
    ∃ m, get s.due p = some m ∧ waiting s.due s.after p = false ∧
      k = rk s.alive (link s) p ∧
      ∀ q mq, get s.due q = some mq → waiting s.due s.after q = false →
        ¬ before (rk s.alive (link s) q, mq, n q) (k, m, n p) := by
  obtain ⟨m, hm, hw, hk, hl⟩ := next_best n rk h.1 hb
  have hrm := ready_made n rk h.2.1
  have rank_of : ∀ q mq, get s.due q = some mq →
      ((ready n rk s).2 q).getD 0 = rk s.alive (link s) q := by
    intro q mq hq
    rw [hrm]; simp [made, h.1.2.1 q mq hq]
  refine ⟨m, hm, hw, by rw [hk, rank_of p m hm], ?_⟩
  intro q mq hq hwq
  have := hl q mq hq hwq
  rwa [rank_of q mq hq] at this

end keeps

end Order
