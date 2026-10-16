-- LLM generated working output
-- termination on the model (Model.lean): proof.md §3 (Theorem 1) and §7.2 (Theorem 1′), as the code
-- is now (§13: F1, F4, N2, changed(keys, by)). every pulse from a reachable state (Quiescence.lean,
-- Reach: the host's changes from outside) ends, with fuel bounds:
-- - termination, termination_bound (Theorem 1): H acyclic among the made, writes in runs or not.
--   H is static: feeds, c to d when c may write (its f, its set's key, its act, make's key) a key
--   d's f may read. the measure: a due one weighs cost n (height), plus under n (height) for each
--   computation not yet waiting after it (a stop spends one), a queued act owed n (height), and the
--   phase. bound n a: n made, a acts queued. acyclic_of_height: H checked by a height
-- - cycles, cycles_bound (Theorem 1′): A2, H cyclic or not. a potential in place of §7.2's P_A
--   counting: budget, each due unflagged z at worth n (level z), level z the room its next run
--   leaves (how many of the first n a mark from it would find free: not z, not both ran this pulse
--   and behind a cause kept on z), and each queued act at deed n (its cause's room). a run whose
--   set or act is called is unflagged, its free marks land one level down: the budget falls. every
--   other step leaves it and lowers quiet (dues, with a credit per computation not waiting after
--   each; the phase). gauge = budget * big + quiet
-- - Causal (Reach.causal): kept causes, and the given of a run going on (taken from its kept),
--   are this pulse's, the latest run's is its computation's cause: so keep's test by run (.of)
--   against the last kept never skips a different cause. at a close no run holds a given
--   (Core.given)
--
-- attended computes and goings: a pulse's `.goes` phase (bury the dying, then the acts phase
-- again) is a loop of its own. Theorem 1 holds with them (wakes, sleeps, goings), given Quiet (no
-- going writes): idle (the asleep and the dying) and gm (goings left) make the measure
-- lexicographic, steps_end. termination_bound, cycles and cycles_bound are proved with no
-- attended computes (Unattended): Causal does not survive a going (bury drops a run whose cause
-- may be kept on others), and the bound's count of steps has no term for wakes
--
-- what loops: going writes. Model.Check, endless: two attended computes a, b; r reads x, then a if
-- x is even, else b; a's going writes x := 2, b's x := 1. A2 holds and H is acyclic (no feeds edge
-- goes back: a and b read nothing, r writes r), yet each going's write moves r to the other key,
-- waking the other, which goes at the next pulse end: the pulse never ends (the model at fuel
-- 3000; the TS the same, scratch: 200 runs). causes miss it: a wake is from outside, and a
-- going's write is named by the going one, whose cause does not reach back to r's run. so the
-- scheduler needs a guard: e.g. one gone this pulse is not woken again until the next, or a cap
-- on goings or wakes per pulse; carrying the reader's cause into the wake is not enough (gone's
-- and teardowns' writes are from outside the reader's run)
--
-- assumed (hypotheses where used): Theorem 1: H acyclic among the made (among s.made (feeds cs))
-- and Quiet; Theorem 1′ and the bounds: A2 (no f writes in its run, Quiet) and Unattended. all:
-- the host's changes name no computation (Reach), and Model.lean's departures (no make in a pulse:
-- A6; sync: A8; f, set, act return: A1)
--
-- §7.2's step 1 against the code now: under A2 every mark comes from a set or an act, each inside
-- a step of its own, so a cause marked on y is still kept at y's next run (which takes it as its
-- given; a run not done puts it back). F4 drops marks of flagged runs: none under A2. N2 (came) only
-- keeps runs from stopping; stops are paid by quiet whichever stop. so step 1 holds in the model;
-- the proof here does not go through it. finish_keeps: a run not done, its given back, leaves the
-- budget no higher (more kept, less room)
--
-- writes in runs (no A2) for cycles: not proved. where the budget breaks: a flagged run's writes
-- mark free; a run that writes, then stops, gets its own term back, its writes' marks already
-- made. a search on the TS (scratch, writes before reads so runs write and then stop, 240 small
-- systems, 7 pulses each) found no pulse that did not end
import Scheduler.Quiescence

namespace Model

open Relation

set_option linter.unusedSectionVars false
set_option linter.unusedSimpArgs false

variable {K V : Type} [DecidableEq K] [DecidableEq V]

-- sums

-- the sum of f over 0 .. n - 1
def tot (n : Nat) (f : Nat → Nat) : Nat :=
  match n with
  | 0 => 0
  | n + 1 => tot n f + f n

theorem tot_le {n : Nat} {f g : Nat → Nat} (h : ∀ d, d < n → f d ≤ g d) : tot n f ≤ tot n g := by
  induction n with
  | zero => simp [tot]
  | succ n ih =>
    simp only [tot]
    have := ih (fun d hd => h d (by omega))
    have := h n (by omega)
    omega

theorem tot_add (n : Nat) (f g : Nat → Nat) : tot n (fun d => f d + g d) = tot n f + tot n g := by
  induction n with
  | zero => simp [tot]
  | succ n ih => simp only [tot, ih]; omega

theorem tot_zero (n : Nat) : tot n (fun _ => 0) = 0 := by
  induction n with
  | zero => rfl
  | succ n ih => simp [tot, ih]

theorem tot_one {n c : Nat} (x : Nat) (hc : c < n) : tot n (fun d => if d = c then x else 0) = x := by
  induction n with
  | zero => omega
  | succ n ih =>
    simp only [tot]
    by_cases h : c = n
    · subst h
      have : tot c (fun d => if d = c then x else 0) = 0 := by
        have := tot_le (n := c) (f := fun d => if d = c then x else 0) (g := fun _ => 0)
          (fun d hd => by simp [show d ≠ c by omega])
        have h0 := tot_zero c
        omega
      simp [this]
    · rw [ih (by omega)]; simp [Ne.symm h]

theorem tot_const {n x : Nat} {f : Nat → Nat} (h : ∀ d, d < n → f d ≤ x) : tot n f ≤ n * x := by
  induction n with
  | zero => simp [tot]
  | succ n ih =>
    simp only [tot]
    have := ih (fun d hd => h d (by omega))
    have := h n (by omega)
    rw [Nat.succ_mul]; omega

theorem tot_cong {n : Nat} {f g : Nat → Nat} (h : ∀ d, d < n → f d = g d) : tot n f = tot n g :=
  Nat.le_antisymm (tot_le fun d hd => Nat.le_of_eq (h d hd)) (tot_le fun d hd => Nat.le_of_eq (h d hd).symm)

theorem tot_mono_n {n m : Nat} (f : Nat → Nat) (h : n ≤ m) : tot n f ≤ tot m f := by
  induction m with
  | zero => have : n = 0 := by omega
            subst this; exact Nat.le_refl _
  | succ m ih =>
    by_cases e : n = m + 1
    · subst e; exact Nat.le_refl _
    · simp only [tot]; have := ih (by omega); omega

-- a sum over a list, pointwise less
theorem sum_le {α : Type} {f g : α → Nat} : ∀ {l : List α}, (∀ a ∈ l, f a ≤ g a) →
    (l.map f).sum ≤ (l.map g).sum
  | [], _ => by simp
  | a :: l, h => by
    simp only [List.map_cons, List.sum_cons]
    have := h a (by simp)
    have := sum_le (l := l) (fun x hx => h x (by simp [hx]))
    omega

theorem sum_filter {α : Type} (f : α → Nat) (p : α → Bool) : ∀ (l : List α),
    ((l.filter p).map f).sum ≤ (l.map f).sum
  | [] => by simp
  | a :: l => by
    have := sum_filter f p l
    by_cases h : p a <;> simp [List.filter_cons, h] <;> omega

-- H, from the code: what may be read and written

-- the keys f may read, on some path: Prog.reads (Model.lean)

-- the keys f may write in its run, on some path
def Prog.writes : Prog K V → K → Prop
  | .value _, _ => False
  | .error, _ => False
  | .pending, _ => False
  | .read _ next, x => ∃ v, (next v).writes x
  | .write k _ next, x => k = x ∨ next.writes x

-- the keys a computation may write (its run, its set, its act), or make's key: what it may be the
-- writer of
def Comp.writes (c : Comp K V) (k : K) : Prop :=
  c.f.writes k ∨ c.key = some k ∨ match c.kind with
    | .compute to => to = some k
    | .effect act => ∃ v p, k ∈ (act v p).map (·.1)

-- H (proof.md §3): c feeds d when c may write, or be the writer of, a key d may read
def feeds (cs : Nat → Comp K V) (c d : Nat) : Prop := ∃ k, (cs c).writes k ∧ (cs d).f.reads k

-- r among the first n
def among (n : Nat) (r : Nat → Nat → Prop) (a b : Nat) : Prop := a < n ∧ b < n ∧ r a b

-- the height of c: how many of the first n it reaches along H among them
open Classical in
noncomputable def height (cs : Nat → Comp K V) (n c : Nat) : Nat :=
  ((List.range n).filter fun x => decide (TransGen (among n (feeds cs)) c x)).length

theorem filter_lt {β : Type} {p q : β → Bool} : ∀ {l : List β}, (∀ i ∈ l, q i → p i) →
    (∃ i ∈ l, p i ∧ ¬ q i) → (l.filter q).length < (l.filter p).length
  | [], _, ⟨_, hi, _⟩ => by simp at hi
  | a :: l, hle, ⟨i, hi, hp, hq⟩ => by
    have hm : (l.filter q).length ≤ (l.filter p).length := by
      rw [← List.countP_eq_length_filter, ← List.countP_eq_length_filter]
      exact List.countP_mono_left (fun x hx => hle x (List.mem_cons_of_mem _ hx))
    rcases List.mem_cons.mp hi with rfl | hi
    · simp [List.filter_cons, hp, hq]; omega
    · have := filter_lt (fun x hx => hle x (List.mem_cons_of_mem _ hx)) ⟨i, hi, hp, hq⟩
      have := hle a (by simp)
      by_cases ha : q a <;> by_cases hb : p a <;> simp_all [List.filter_cons] <;> omega

-- along H the height falls, H acyclic
theorem height_lt {cs : Nat → Comp K V} {n c d : Nat}
    (hac : ∀ x, ¬TransGen (among n (feeds cs)) x x) (h : feeds cs c d) (hc : c < n) (hd : d < n) :
    height cs n d < height cs n c := by
  have h' : among n (feeds cs) c d := ⟨hc, hd, h⟩
  unfold height
  apply filter_lt
  · intro i _ hi
    simp only [decide_eq_true_eq] at hi ⊢
    exact TransGen.trans (.single h') hi
  · exact ⟨d, List.mem_range.2 hd, by simp [TransGen.single h'], by simp [hac d]⟩

theorem height_le (cs : Nat → Comp K V) (n c : Nat) : height cs n c ≤ n := by
  unfold height
  exact Nat.le_trans (List.length_filter_le _ _) (by simp)

-- marks: what a change leaves as it was

-- s' is s but for what a change touches: the tick, writers, causes, flags, dues and log (and the
-- store: a write's)
structure Same (s s' : State K V) : Prop where
  made : s'.made = s.made
  reads : s'.reads = s.reads
  values : s'.values = s.values
  after : s'.after = s.after
  ran : s'.ran = s.ran
  runs : s'.runs = s.runs
  acts : s'.acts = s.acts
  last : s'.last = s.last
  pulses : s'.pulses = s.pulses
  phase : s'.phase = s.phase
  earlies : s'.earlies = s.earlies
  asleep : s'.asleep = s.asleep

theorem Same.refl (s : State K V) : Same s s :=
  ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem Same.trans {s s' s'' : State K V} (a : Same s s') (b : Same s' s'') : Same s s'' :=
  ⟨b.1.trans a.1, b.2.trans a.2, b.3.trans a.3, b.4.trans a.4, b.5.trans a.5, b.6.trans a.6,
    b.7.trans a.7, b.8.trans a.8, b.9.trans a.9, b.10.trans a.10, b.11.trans a.11, b.12.trans a.12⟩

-- dues only grow, the new ones F; a writer learned, w of k, is G k w
structure Moved (F : Nat → Prop) (G : K → Nat → Prop) (s s' : State K V) : Prop where
  due : ∀ d m, s.due d = some m → s'.due d = some m
  fresh : ∀ d, (s'.due d).isSome → (s.due d).isSome ∨ F d
  writers : ∀ k w, s'.writers k = some w → s.writers k = some w ∨ G k w

theorem Moved.refl (F : Nat → Prop) (G : K → Nat → Prop) (s : State K V) : Moved F G s s :=
  ⟨fun _ _ h => h, fun _ h => Or.inl h, fun _ _ h => Or.inl h⟩

theorem Moved.trans {F : Nat → Prop} {G : K → Nat → Prop} {s s' s'' : State K V}
    (a : Moved F G s s') (b : Moved F G s' s'') : Moved F G s s'' where
  due d m h := b.due d m (a.due d m h)
  fresh d h := by
    rcases b.fresh d h with h | h
    · exact a.fresh d h
    · exact Or.inr h
  writers k w h := by
    rcases b.writers k w h with h | h
    · exact a.writers k w h
    · exact Or.inr h

theorem Moved.mono {F F' : Nat → Prop} {G G' : K → Nat → Prop} {s s' : State K V}
    (a : Moved F G s s') (hF : ∀ d, F d → F' d) (hG : ∀ k w, G k w → G' k w) : Moved F' G' s s' where
  due := a.due
  fresh d h := (a.fresh d h).imp_right (hF d)
  writers k w h := (a.writers k w h).imp_right (hG k w)

theorem Moved.of_eq {F : Nat → Prop} {G : K → Nat → Prop} {s s' : State K V}
    (e1 : s'.due = s.due) (e2 : s'.writers = s.writers) : Moved F G s s' :=
  ⟨fun _ _ h => e1 ▸ h, fun _ h => Or.inl (e1 ▸ h), fun _ _ h => Or.inl (e2 ▸ h)⟩

theorem Moved.isSome {F : Nat → Prop} {G : K → Nat → Prop} {s s' : State K V}
    (a : Moved F G s s') {d : Nat} (h : (s.due d).isSome) : (s'.due d).isSome := by
  obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h
  simp [a.due d m hm]

theorem due_same (s : State K V) (d t : Nat) (who : Option Nat) :
    Same s (due s d t who) ∧ (due s d t who).writers = s.writers ∧
    Moved (· = d) (fun _ _ => False) s (due s d t who) := by
  unfold due
  split
  · exact ⟨Same.refl s, rfl, Moved.refl _ _ s⟩
  · refine ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, ?_, ?_, ?_⟩
    · intro x m h
      by_cases hx : x = d
      · subst hx; rename_i h'; simp [h] at h'
      · simp [say, put_ne _ _ hx, h]
    · intro x h
      by_cases hx : x = d
      · exact Or.inr hx
      · simp [say, put_ne _ _ hx] at h; exact Or.inl h
    · intro k w h; simp [say] at h; exact Or.inl h

theorem settle_same (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat))
    (fl : Bool) : Same s (settle s d t who l fl) ∧ (settle s d t who l fl).writers = s.writers ∧
    Moved (· = d) (fun _ _ => False) s (settle s d t who l fl) := by
  unfold settle
  split
  · split
    · exact ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, Moved.of_eq rfl rfl⟩
    · exact ⟨Same.refl s, rfl, Moved.refl _ _ s⟩
  · dsimp only
    split
    · exact ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, Moved.of_eq rfl rfl⟩
    · obtain ⟨a, b, c⟩ := due_same { s with loop := put s.loop d l, looping := put s.looping d false }
        d t who
      exact ⟨Same.trans (s' := { s with loop := put s.loop d l, looping := put s.looping d false })
        ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ a, b,
        Moved.trans (s' := { s with loop := put s.loop d l, looping := put s.looping d false })
          (Moved.of_eq rfl rfl) c⟩

theorem mark_same (s : State K V) (d t : Nat) (who : Option Nat) :
    Same s (mark s d t who) ∧ (mark s d t who).writers = s.writers ∧
    Moved (· = d) (fun _ _ => False) s (mark s d t who) := by
  cases who with
  | none => exact settle_same s d t none none false
  | some c =>
    simp only [mark]
    obtain ⟨a, b, g, k, hc⟩ := causeof_shape s c
    rw [hc]
    obtain ⟨kp, hk⟩ := keep_shape { s with cause := a, when := b, went := g } d k
    simp only [hk]
    obtain ⟨h1, h2, h3⟩ := settle_same { s with cause := a, when := b, went := g, kept := kp } d t
      (some c) (loopof { s with cause := a, when := b, went := g, kept := kp } k d)
      (((s.ran c).bind (·.loop)).isSome)
    exact ⟨Same.trans (s' := { s with cause := a, when := b, went := g, kept := kp })
      ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ h1, h2,
      ⟨fun x m h => h3.due x m h, fun x h => h3.fresh x h, fun k w h => h3.writers k w h⟩⟩

theorem marks_same (t : Nat) (r : Option Nat) : ∀ (ds : List Nat) (s : State K V),
    Same s (ds.foldl (fun s d => mark s d t r) s) ∧
    (ds.foldl (fun s d => mark s d t r) s).writers = s.writers ∧
    Moved (· ∈ ds) (fun _ _ => False) s (ds.foldl (fun s d => mark s d t r) s)
  | [], s => ⟨Same.refl s, rfl, Moved.refl _ _ s⟩
  | d :: ds, s => by
    simp only [List.foldl_cons]
    obtain ⟨a1, b1, c1⟩ := mark_same s d t r
    obtain ⟨a2, b2, c2⟩ := marks_same t r ds (mark s d t r)
    exact ⟨a1.trans a2, b2.trans b1, Moved.trans (c1.mono (fun x h => by simp [h]) (fun _ _ h => h))
      (c2.mono (fun x h => by simp [h]) (fun _ _ h => h))⟩

-- what changed marks: each key's readers, the reads as they were; a writer learned is the compute
-- named
theorem changed_same (cs : Nat → Comp K V) (s : State K V) (keys : List K) (who : Option Nat) :
    Same s (changed cs s keys who) ∧
    Moved (fun d => d < s.made ∧ ∃ k ∈ keys, k ∈ s.reads d)
      (fun k c => k ∈ keys ∧ who = some c ∧ ∃ to, (cs c).kind = .compute to) s
      (changed cs s keys who) := by
  simp only [changed]
  generalize ht : s.tick + 1 = t
  generalize hs0 : ({ s with tick := t } : State K V) = s0
  have m0 : Same s s0 := by subst hs0; exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
  have m0' : Moved (fun d => d < s.made ∧ ∃ k ∈ keys, k ∈ s.reads d)
      (fun k c => k ∈ keys ∧ who = some c ∧ ∃ to, (cs c).kind = .compute to) s s0 := by
    subst hs0; exact Moved.of_eq rfl rfl
  generalize hr : runof s0 who = r
  have hr1 : ∀ c, r = some c → who = some c := by
    intro c hc; subst hr; exact (Option.filter_eq_some_iff.1 hc).1
  generalize hwr : (r.filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have hw1 : ∀ c, w = some c → who = some c ∧ ∃ to, (cs c).kind = .compute to := by
    intro c hc; subst hwr
    obtain ⟨h1, h2⟩ := Option.filter_eq_some_iff.1 hc
    refine ⟨hr1 c h1, ?_⟩
    split at h2
    · exact ⟨_, ‹_›⟩
    · cases h2
  have fold : ∀ (ks : List K) (s1 : State K V), Same s s1 → (∀ k ∈ ks, k ∈ keys) →
      Same s (ks.foldl (fun s k => tell (learn s k w) k t r) s1) ∧
      Moved (fun d => d < s.made ∧ ∃ k ∈ keys, k ∈ s.reads d)
        (fun k c => k ∈ keys ∧ who = some c ∧ ∃ to, (cs c).kind = .compute to) s1
        (ks.foldl (fun s k => tell (learn s k w) k t r) s1) := by
    intro ks
    induction ks with
    | nil => intro s1 h _; exact ⟨h, Moved.refl _ _ s1⟩
    | cons k ks ih =>
      intro s1 h1 hks
      simp only [List.foldl_cons]
      -- learn
      have l1 : Same s1 (learn s1 k w) := by
        cases w <;> exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
      have l2 : ∀ k' x, (learn s1 k w).writers k' = some x →
          s1.writers k' = some x ∨ (k' = k ∧ w = some x) := by
        intro k' x h
        cases w with
        | none => exact Or.inl h
        | some c =>
          by_cases e : k' = k
          · subst e; simp [learn] at h; exact Or.inr ⟨rfl, by rw [h]⟩
          · simp [learn, put_ne _ _ e] at h; exact Or.inl h
      have l3 : (learn s1 k w).due = s1.due := by cases w <;> rfl
      -- tell
      obtain ⟨a2, b2, c2⟩ := marks_same t r (readers (learn s1 k w) k) (learn s1 k w)
      obtain ⟨a3, c3⟩ := ih _ ((h1.trans l1).trans a2) (fun k hk => hks k (by simp [hk]))
      refine ⟨a3, Moved.trans ?_ c3⟩
      refine ⟨fun d m h => c2.due d m (by rw [l3]; exact h), fun d h => ?_, fun k' x h => ?_⟩
      · rcases c2.fresh d h with h | h
        · exact Or.inl (by rw [← l3]; exact h)
        · right
          simp only [readers, List.mem_filter, List.mem_range, decide_eq_true_eq] at h
          have e1 := (h1.trans l1).made
          have e2 := (h1.trans l1).reads
          rw [e1, e2] at h
          exact ⟨h.1, k, hks k (by simp), h.2⟩
      · have h : (learn s1 k w).writers k' = some x := by rw [← b2]; exact h
        rcases l2 k' x h with h | ⟨rfl, hw⟩
        · exact Or.inl h
        · exact Or.inr ⟨hks k' (by simp), hw1 x hw⟩
  obtain ⟨a, m⟩ := fold keys s0 m0 (fun k hk => hk)
  exact ⟨a, m0'.trans m⟩

-- Theorem 1: what holds with writes in runs

-- what the host and the pulses keep, writes in runs or not: Lemma N's afters; the tracker and the
-- writers within H's reads and writes
structure Base (cs : Nat → Comp K V) (s : State K V) : Prop where
  after_due : ∀ x w, s.after x = some w → (s.due x).isSome ∧ w < s.made
  acyclic : ∀ x, ¬TransGen (aft s) x x
  due_made : ∀ x, (s.due x).isSome → x < s.made
  tracked : ∀ d k, k ∈ s.reads d → (cs d).f.reads k
  learned : ∀ k w, s.writers k = some w → (cs w).writes k
  acts_made : ∀ a ∈ queue s, a.1 < s.made
  -- the asleep: not due, reading nothing (Quiet: no going writes)
  asleep_due : ∀ c, s.asleep c = true → s.due c = none
  asleep_reads : ∀ c, s.asleep c = true → s.reads c = []
  reads_made : ∀ c, s.reads c ≠ [] → c < s.made

-- what a run leaves as it was
structure Fixed (s s' : State K V) : Prop where
  made : s'.made = s.made
  after : s'.after = s.after
  acts : s'.acts = s.acts
  phase : s'.phase = s.phase
  last : s'.last = s.last
  earlies : s'.earlies = s.earlies

theorem Fixed.refl (s : State K V) : Fixed s s := ⟨rfl, rfl, rfl, rfl, rfl, rfl⟩

theorem Fixed.trans {s s' s'' : State K V} (a : Fixed s s') (b : Fixed s' s'') : Fixed s s'' :=
  ⟨b.1.trans a.1, b.2.trans a.2, b.3.trans a.3, b.4.trans a.4, b.5.trans a.5, b.6.trans a.6⟩

theorem Same.fixed {s s' : State K V} (a : Same s s') : Fixed s s' :=
  ⟨a.made, a.after, a.acts, a.phase, a.last, a.earlies⟩

-- a change of keys c may write, said by c: what it marks is fed by c; what it learns, c may write
theorem changed_feeds (cs : Nat → Comp K V) (s : State K V) (keys : List K) (c : Nat)
    (hk : ∀ k ∈ keys, (cs c).writes k) (ht : ∀ d k, k ∈ s.reads d → (cs d).f.reads k) :
    Same s (changed cs s keys (some c)) ∧
    Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s
      (changed cs s keys (some c)) := by
  obtain ⟨a, m⟩ := changed_same cs s keys (some c)
  refine ⟨a, m.mono ?_ ?_⟩
  · rintro d ⟨hd, k, hk1, hk2⟩
    exact ⟨hd, k, hk k hk1, ht d k hk2⟩
  · rintro k w ⟨hk1, hw, _⟩
    cases hw
    exact ⟨rfl, hk k hk1⟩

-- a wake: the attended compute of k, asleep, is due from outside and k's writer; the asleep reading
-- nothing, so no mark of a run's reaches them
theorem wake_base (cs : Nat → Comp K V) (s : State K V) (k : K) :
    Fixed s (wake cs s k) ∧ (wake cs s k).ran = s.ran ∧ (wake cs s k).reads = s.reads ∧
    Moved (fun d => d < s.made ∧ s.asleep d = true) (fun k w => (cs w).writes k ∧ s.asleep w = true)
      s (wake cs s k) ∧
    (∀ d, (wake cs s k).asleep d = true → s.asleep d = true ∧ (wake cs s k).due d = s.due d) := by
  unfold wake
  cases ha : attending cs s.made k with
  | none => exact ⟨Fixed.refl s, rfl, rfl, Moved.refl _ _ s, fun d h => ⟨h, rfl⟩⟩
  | some a =>
    simp only
    split
    · rename_i hasl
      have hlt := attending_lt ha
      have hka : (cs a).key = some k := by
        have := List.mem_of_getLast? ha
        simp at this; exact this.2.2
      generalize hs2 : ({ s with
        asleep := put s.asleep a false, writers := put s.writers k (some a),
        tick := s.tick + 1 } : State K V) = s2
      obtain ⟨a1, wr, m⟩ := mark_same s2 a (s.tick + 1) none
      refine ⟨by rw [← hs2] at a1 ⊢; exact ⟨a1.made, a1.after, a1.acts, a1.phase, a1.last, a1.earlies⟩,
        by rw [a1.ran, ← hs2], by rw [a1.reads, ← hs2], ⟨fun d n h => ?_, fun d h => ?_, fun k' w h => ?_⟩,
        fun d h => ?_⟩
      · exact m.due d n (by rw [← hs2]; exact h)
      · rcases m.fresh d h with h | h
        · exact Or.inl (by rw [← hs2] at h; exact h)
        · subst h; exact Or.inr ⟨hlt, hasl⟩
      · rw [wr, ← hs2] at h
        by_cases hk : k' = k
        · subst hk; simp at h; subst h; exact Or.inr ⟨Or.inr (Or.inl hka), hasl⟩
        · simp [put_ne _ _ hk] at h; exact Or.inl h
      · rw [a1.asleep, ← hs2] at h
        have hda : d ≠ a := by intro e; subst e; simp at h
        simp [put_ne _ _ hda] at h
        refine ⟨h, ?_⟩
        have := m.fresh d
        cases e : (mark s2 a (s.tick + 1) none).due d with
        | none =>
          cases e2 : s.due d with
          | none => rfl
          | some x => have := m.due d x (by rw [← hs2]; exact e2); rw [e] at this; cases this
        | some x =>
          rcases m.fresh d (by simp [e]) with h2 | h2
          · obtain ⟨y, hy⟩ := Option.isSome_iff_exists.1 h2
            have := m.due d y hy; rw [e] at this
            rw [← hs2] at hy; rw [hy, this]
          · exact absurd h2 hda
    · exact ⟨Fixed.refl s, rfl, rfl, Moved.refl _ _ s, fun d h => ⟨h, rfl⟩⟩

-- a run, writes in it or not: what it marks is fed by c, or was asleep (woken); a stop is on a due
-- writer fed into c, c not on its after-chain; what it read, f may read. c awake, the asleep
-- reading nothing: what stays asleep is as due as before, and only c's reads move
theorem exec_base (cs : Nat → Comp K V) (c : Nat) : ∀ (p : Prog K V) (s : State K V),
    (∀ k, p.reads k → (cs c).f.reads k) → (∀ k, p.writes k → (cs c).f.writes k) →
    (∀ d k, k ∈ s.reads d → (cs d).f.reads k) → (∀ k w, s.writers k = some w → (cs w).writes k) →
    (∀ r, s.ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1) →
    (∀ d, s.asleep d = true → s.reads d = []) → s.asleep c = false →
    Fixed s (exec cs c s p).1 ∧
    (∀ d, d ≠ c → (exec cs c s p).1.ran d = s.ran d) ∧
    ((s.ran c).isSome → ((exec cs c s p).1.ran c).isSome) ∧
    Moved (fun d => d < s.made ∧ (feeds cs c d ∨ s.asleep d = true))
      (fun k w => (w = c ∧ (cs c).writes k) ∨ ((cs w).writes k ∧ s.asleep w = true)) s
      (exec cs c s p).1 ∧
    (∀ d k, k ∈ (exec cs c s p).1.reads d → (cs d).f.reads k) ∧
    (∀ k w, (exec cs c s p).1.writers k = some w → (cs w).writes k) ∧
    (∀ w, ((exec cs c s p).1.ran c).bind (·.stopped) = some w →
      ((exec cs c s p).1.due w).isSome ∧ waits s w c = false ∧ w ≠ c ∧ feeds cs w c) ∧
    (∀ r, (exec cs c s p).1.ran c = some r → ∀ q ∈ r.seen, (cs c).f.reads q.1) ∧
    (∀ d, (exec cs c s p).1.asleep d = true → s.asleep d = true ∧
      (exec cs c s p).1.due d = s.due d) ∧
    (∀ d, d ≠ c → (exec cs c s p).1.reads d = s.reads d)
  | .value _, s, _, _, ht, hl, hs, _, _ => ⟨Fixed.refl s, fun _ _ => rfl, id, Moved.refl _ _ s, ht, hl,
      fun w h => by
        cases e : s.ran c with
        | none => simp [exec, e] at h
        | some r => simp [exec, e, (hs r e).1] at h,
      fun r h => (hs r h).2, fun _ h => ⟨h, rfl⟩, fun _ _ => rfl⟩
  | .error, s, _, _, ht, hl, hs, _, _ => ⟨Fixed.refl s, fun _ _ => rfl, id, Moved.refl _ _ s, ht, hl,
      fun w h => by
        cases e : s.ran c with
        | none => simp [exec, e] at h
        | some r => simp [exec, e, (hs r e).1] at h,
      fun r h => (hs r h).2, fun _ h => ⟨h, rfl⟩, fun _ _ => rfl⟩
  | .pending, s, _, _, ht, hl, hs, _, _ => ⟨Fixed.refl s, fun _ _ => rfl, id, Moved.refl _ _ s, ht, hl,
      fun w h => by
        cases e : s.ran c with
        | none => simp [exec, e] at h
        | some r => simp [exec, e, (hs r e).1] at h,
      fun r h => (hs r h).2, fun _ h => ⟨h, rfl⟩, fun _ _ => rfl⟩
  | .write k v next, s, hr, hw, ht, hl, hs, hsr, hzc => by
    have hk : (cs c).writes k := Or.inl (hw k (by simp [Prog.writes]))
    obtain ⟨a, m⟩ := changed_feeds cs (store s k v) [k] c (by simpa using hk) ht
    generalize hs1 : changed cs (store s k v) [k] (some c) = s1 at a m
    have ht1 : ∀ d k, k ∈ s1.reads d → (cs d).f.reads k := by rw [a.reads]; exact ht
    have hl1 : ∀ k w, s1.writers k = some w → (cs w).writes k := by
      intro k' w h
      rcases m.writers k' w h with h | ⟨rfl, h⟩
      · exact hl k' w h
      · exact h
    have hs1' : ∀ r, s1.ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1 := by
      rw [a.ran]; exact hs
    have hsr1 : ∀ d, s1.asleep d = true → s1.reads d = [] := by
      rw [a.asleep, a.reads]; exact hsr
    obtain ⟨f2, r2, i2, m2, t2, l2, st2, sn2, z2, q2⟩ := exec_base cs c next s1
      (fun k h => hr k (by simp [Prog.reads, h])) (fun k h => hw k (by simp [Prog.writes, h]))
      ht1 hl1 hs1' hsr1 (by rw [a.asleep]; exact hzc)
    simp only [exec, hs1]
    have em : s1.made = s.made := a.made
    have ea : s1.after = s.after := a.after
    have er : s1.ran = s.ran := a.ran
    have f1 : Fixed s s1 := ⟨a.made, a.after, a.acts, a.phase, a.last, a.earlies⟩
    refine ⟨f1.trans f2, fun d hd => (r2 d hd).trans (by rw [er]),
      fun h => i2 (by rw [er]; exact h), ?_, t2, l2, ?_, sn2, ?_, ?_⟩
    · refine Moved.trans (s' := store s k v) (Moved.of_eq rfl rfl) (Moved.trans (s' := s1)
        (m.mono (fun d h => ⟨h.1, Or.inl h.2⟩) (fun _ _ h => Or.inl h))
        (m2.mono (fun d h => ⟨by rw [← em]; exact h.1, by
            rcases h.2 with h | h
            · exact Or.inl h
            · exact Or.inr (by rw [a.asleep] at h; exact h)⟩)
          (fun _ _ h => by
            rcases h with h | ⟨h1, h2⟩
            · exact Or.inl h
            · exact Or.inr ⟨h1, by rw [a.asleep] at h2; exact h2⟩)))
    · intro w h
      obtain ⟨h1, h2, h3, h4⟩ := st2 w h
      refine ⟨h1, ?_, h3, h4⟩
      rw [← h2]; exact (waits_congr ea em w c).symm
    · intro d h
      obtain ⟨h1, h2⟩ := z2 d h
      rw [a.asleep] at h1
      refine ⟨h1, h2.trans ?_⟩
      -- asleep, it reads nothing: no mark of the write reaches it
      obtain ⟨_, m0⟩ := changed_same cs (store s k v) [k] (some c)
      rw [hs1] at m0
      cases e : s.due d with
      | none =>
        cases e1 : s1.due d with
        | none => rfl
        | some x =>
          rcases m0.fresh d (by simp [e1]) with h3 | ⟨_, k', _, hk2⟩
          · simp [store, e] at h3
          · have : (store s k v).reads d = [] := hsr d h1
            rw [this] at hk2; cases hk2
      | some x => exact m.due d x (by simp [store, e])
    · intro d hd; rw [q2 d hd, a.reads]; rfl
  | .read k next, s, hr, hw, ht, hl, hs, hsr, hzc => by
    have hkr : (cs c).f.reads k := hr k (by simp [Prog.reads])
    -- after the read: tracked, seen
    have e0 : ∀ (s : State K V) (g : Run K V → Run K V), Fixed s (edit s c g) ∧
        (edit s c g).due = s.due ∧ (edit s c g).writers = s.writers ∧ (edit s c g).reads = s.reads ∧
        (∀ d, d ≠ c → (edit s c g).ran d = s.ran d) ∧
        ((s.ran c).isSome → ((edit s c g).ran c).isSome) ∧
        (edit s c g).ran c = (s.ran c).map g ∧ (edit s c g).made = s.made ∧
        (edit s c g).after = s.after ∧ (edit s c g).asleep = s.asleep := by
      intro s g
      refine ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl, fun d hd => by simp [edit, put_ne _ _ hd],
        fun h => by simpa [edit] using h, by simp [edit], rfl, rfl, rfl⟩
    generalize hs1 : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) = s1
    obtain ⟨f1, d1, w1, rd1, r1, i1, c1, mk1, a1, z1⟩ := e0 { s with reads := put s.reads c (s.reads c ++ [k]) }
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] })
    rw [hs1] at f1 d1 w1 rd1 r1 i1 c1 mk1 a1 z1
    replace f1 : Fixed s s1 := ⟨f1.1, f1.2, f1.3, f1.4, f1.5, f1.6⟩
    have ht1 : ∀ d k', k' ∈ s1.reads d → (cs d).f.reads k' := by
      intro d k' h
      rw [rd1] at h
      by_cases hd : d = c
      · subst hd; simp at h
        rcases h with h | rfl
        · exact ht _ _ h
        · exact hkr
      · simp [put_ne _ _ hd] at h; exact ht d k' h
    have hs1' : ∀ r, s1.ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1 := by
      intro r h; rw [c1] at h
      cases e : s.ran c with
      | none => simp [e] at h
      | some r0 =>
        simp [e] at h; subst h
        refine ⟨(hs r0 e).1, fun q hq => ?_⟩
        simp only [List.mem_append, List.mem_singleton] at hq
        rcases hq with hq | rfl
        · exact (hs r0 e).2 q hq
        · exact hkr
    -- the wake, when nobody tracked k
    generalize hS1 : (if (!tracked s k) = true then wake cs s1 k else s1) = S1
    obtain ⟨fW, rW, qW, mW, zW⟩ : Fixed s1 S1 ∧ S1.ran = s1.ran ∧ S1.reads = s1.reads ∧
        Moved (fun d => d < s1.made ∧ s1.asleep d = true) (fun k w => (cs w).writes k ∧ s1.asleep w = true)
          s1 S1 ∧
        (∀ d, S1.asleep d = true → s1.asleep d = true ∧ S1.due d = s1.due d) := by
      rw [← hS1]; split
      · exact wake_base cs s1 k
      · exact ⟨Fixed.refl s1, rfl, rfl, Moved.refl _ _ s1, fun d h => ⟨h, rfl⟩⟩
    have hrn : ∀ x, ∀ k, (next x).reads k → (cs c).f.reads k :=
      fun x k h => hr k (Or.inr ⟨x, h⟩)
    have hwn : ∀ x, ∀ k, (next x).writes k → (cs c).f.writes k :=
      fun x k h => hw k ⟨x, h⟩
    -- from s to S1
    have M1 : Moved (fun d => d < s.made ∧ (feeds cs c d ∨ s.asleep d = true))
        (fun k w => (w = c ∧ (cs c).writes k) ∨ ((cs w).writes k ∧ s.asleep w = true)) s S1 :=
      Moved.trans (Moved.of_eq (s' := s1) d1 w1)
        (mW.mono (fun d h => ⟨by rw [← mk1]; exact h.1, Or.inr (by rw [← z1]; exact h.2)⟩)
          (fun _ _ h => Or.inr ⟨h.1, by rw [← z1]; exact h.2⟩))
    have FS : Fixed s S1 := f1.trans fW
    have l1 : ∀ k' w, S1.writers k' = some w → (cs w).writes k' := by
      intro k' w h
      rcases M1.writers k' w h with h | (⟨rfl, h⟩ | ⟨h, _⟩)
      · exact hl k' w h
      · exact h
      · exact h
    have tS : ∀ d k', k' ∈ S1.reads d → (cs d).f.reads k' := by rw [qW]; exact ht1
    have sS : ∀ r, S1.ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1 := by
      rw [rW]; exact hs1'
    have zS : ∀ d, S1.asleep d = true → s.asleep d = true ∧ S1.due d = s.due d := by
      intro d h
      obtain ⟨h1, h2⟩ := zW d h
      rw [z1] at h1
      exact ⟨h1, by rw [h2, d1]⟩
    have qS : ∀ d, d ≠ c → S1.reads d = s.reads d := by
      intro d hd; rw [qW, rd1]; simp [put_ne _ _ hd]
    have hzS : S1.asleep c = false := by
      cases h : S1.asleep c
      · rfl
      · rw [(zS c h).1] at hzc; cases hzc
    have srS : ∀ d, S1.asleep d = true → S1.reads d = [] := by
      intro d h
      have hdc : d ≠ c := by intro e; subst e; rw [hzS] at h; cases h
      rw [qS d hdc]; exact hsr d (zS d h).1
    -- the rest of the run from any state like S1
    have go : ∀ s2 : State K V, Fixed s s2 →
        Moved (fun d => d < s.made ∧ (feeds cs c d ∨ s.asleep d = true))
          (fun k w => (w = c ∧ (cs c).writes k) ∨ ((cs w).writes k ∧ s.asleep w = true)) s s2 →
        s2.made = s.made → s2.after = s.after → (∀ d, d ≠ c → s2.ran d = s.ran d) →
        ((s.ran c).isSome → (s2.ran c).isSome) →
        (∀ d k, k ∈ s2.reads d → (cs d).f.reads k) →
        (∀ k w, s2.writers k = some w → (cs w).writes k) →
        (∀ r, s2.ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1) →
        (∀ d, s2.asleep d = true → s.asleep d = true ∧ s2.due d = s.due d) →
        (∀ d, d ≠ c → s2.reads d = s.reads d) →
        Fixed s (exec cs c s2 (next (s.store k))).1 ∧
        (∀ d, d ≠ c → (exec cs c s2 (next (s.store k))).1.ran d = s.ran d) ∧
        ((s.ran c).isSome → ((exec cs c s2 (next (s.store k))).1.ran c).isSome) ∧
        Moved (fun d => d < s.made ∧ (feeds cs c d ∨ s.asleep d = true))
          (fun k w => (w = c ∧ (cs c).writes k) ∨ ((cs w).writes k ∧ s.asleep w = true)) s
          (exec cs c s2 (next (s.store k))).1 ∧
        (∀ d k', k' ∈ (exec cs c s2 (next (s.store k))).1.reads d → (cs d).f.reads k') ∧
        (∀ k' w, (exec cs c s2 (next (s.store k))).1.writers k' = some w → (cs w).writes k') ∧
        (∀ w, ((exec cs c s2 (next (s.store k))).1.ran c).bind (·.stopped) = some w →
          ((exec cs c s2 (next (s.store k))).1.due w).isSome ∧ waits s w c = false ∧ w ≠ c ∧
            feeds cs w c) ∧
        (∀ r, (exec cs c s2 (next (s.store k))).1.ran c = some r →
          ∀ q ∈ r.seen, (cs c).f.reads q.1) ∧
        (∀ d, (exec cs c s2 (next (s.store k))).1.asleep d = true → s.asleep d = true ∧
          (exec cs c s2 (next (s.store k))).1.due d = s.due d) ∧
        (∀ d, d ≠ c → (exec cs c s2 (next (s.store k))).1.reads d = s.reads d) := by
      intro s2 f2 m2 mk2 a2 r2 i2 t2 l2 s2s z2 q2
      have hz2 : s2.asleep c = false := by
        cases h : s2.asleep c
        · rfl
        · rw [(z2 c h).1] at hzc; cases hzc
      have sr2 : ∀ d, s2.asleep d = true → s2.reads d = [] := by
        intro d h
        have hdc : d ≠ c := by intro e; subst e; rw [hz2] at h; cases h
        rw [q2 d hdc]; exact hsr d (z2 d h).1
      obtain ⟨f3, r3, i3, m3, t3, l3, st3, sn3, z3, q3⟩ := exec_base cs c (next (s.store k)) s2
        (hrn _) (hwn _) t2 l2 s2s sr2 hz2
      refine ⟨f2.trans f3, fun d hd => (r3 d hd).trans (r2 d hd), fun h => i3 (i2 h), ?_, t3, l3,
        ?_, sn3, ?_, fun d hd => (q3 d hd).trans (q2 d hd)⟩
      · refine Moved.trans m2 (m3.mono ?_ ?_)
        · intro d h
          refine ⟨mk2 ▸ h.1, ?_⟩
          rcases h.2 with h | h
          · exact Or.inl h
          · exact Or.inr (z2 d h).1
        · intro k' w h
          rcases h with h | ⟨h1, h2⟩
          · exact Or.inl h
          · exact Or.inr ⟨h1, (z2 w h2).1⟩
      · intro w h
        obtain ⟨h1, h2, h3, h4⟩ := st3 w h
        exact ⟨h1, by rw [← h2]; exact (waits_congr a2 mk2 w c).symm, h3, h4⟩
      · intro d h
        obtain ⟨h1, h2⟩ := z3 d h
        obtain ⟨h3, h4⟩ := z2 d h1
        exact ⟨h3, h2.trans h4⟩
    have mS : S1.made = s.made := FS.made
    have aS : S1.after = s.after := FS.after
    have rS : ∀ d, d ≠ c → S1.ran d = s.ran d := by intro d hd; rw [rW, r1 d hd]
    have iS : (s.ran c).isSome → (S1.ran c).isSome := by intro h; rw [rW]; exact i1 h
    simp only [exec]
    rw [hs1, hS1]
    cases hwk : S1.writers k with
    | none =>
      exact go S1 FS M1 mS aS rS iS tS l1 sS zS qS
    | some w =>
      simp only []
      by_cases hwc : w = c
      · simp only [hwc, ite_true]
        exact go S1 FS M1 mS aS rS iS tS l1 sS zS qS
      · simp only [hwc, ite_false]
        generalize hs2 : edit S1 c (fun r => { r with values := ins w r.values }) = s2
        obtain ⟨f2, d2, w2, rd2, r2, i2, c2, mk2, a2, z2⟩ := e0 S1 (fun r => { r with values := ins w r.values })
        rw [hs2] at f2 d2 w2 rd2 r2 i2 c2 mk2 a2 z2
        have hs2' : ∀ r, s2.ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1 := by
          intro r h; rw [c2] at h
          cases e : S1.ran c with
          | none => simp [e] at h
          | some r0 => simp [e] at h; subst h; exact sS r0 e
        have M2 := Moved.trans M1 (Moved.of_eq (s' := s2) d2 w2)
        split
        · rename_i hcond
          simp only [Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true] at hcond
          obtain ⟨f4, d4, w4, rd4, r4, i4, c4, mk4, a4, z4⟩ := e0 s2 (fun r => { r with stopped := some w })
          refine ⟨(FS.trans f2).trans f4, fun d hd => by rw [r4 d hd, r2 d hd, rS d hd],
            fun h => i4 (i2 (iS h)), Moved.trans M2 (Moved.of_eq d4 w4),
            by rw [rd4, rd2]; exact tS, by rw [w4, w2]; exact l1, ?_, ?_, ?_, ?_⟩
          · intro w' h
            rw [c4] at h
            cases e : s2.ran c with
            | none => simp [e] at h
            | some r0 =>
              simp [e] at h
              subst h
              refine ⟨by rw [d4]; exact hcond.1.1, ?_, hwc, k, l1 k w hwk, hkr⟩
              rw [← hcond.1.2]
              exact waits_congr (by rw [a2, aS]) (by rw [mk2, mS]) w c
          · intro r h
            rw [c4] at h
            cases e : s2.ran c with
            | none => simp [e] at h
            | some r0 => simp [e] at h; subst h; exact (hs2' r0 e).2
          · intro d h
            rw [z4, z2] at h
            obtain ⟨h1, h2⟩ := zS d h
            exact ⟨h1, by rw [d4, d2, h2]⟩
          · intro d hd; rw [rd4, rd2]; exact qS d hd
        · exact go s2 (FS.trans f2) M2 (by rw [mk2, mS]) (by rw [a2, aS])
            (fun d hd => by rw [r2 d hd, rS d hd]) (fun h => i2 (iS h)) (by rw [rd2]; exact tS)
            (by rw [w2]; exact l1) hs2'
            (fun d h => by rw [z2] at h; obtain ⟨h1, h2⟩ := zS d h; exact ⟨h1, by rw [d2, h2]⟩)
            (fun d hd => by rw [rd2]; exact qS d hd)

-- the due sum: each due d weighs a d, and b d for each of the n that does not wait after it (a
-- stop on d spends one)

-- how many of the first n wait after d
def waiting (n : Nat) (s : State K V) (d : Nat) : Nat :=
  tot n fun e => if s.after e = some d then 1 else 0

def weight (n : Nat) (a b : Nat → Nat) (s : State K V) (d : Nat) : Nat :=
  if (s.due d).isSome then a d + (n - waiting n s d) * b d else 0

def dues (n : Nat) (a b : Nat → Nat) (s : State K V) : Nat := tot n (weight n a b s)

-- a new due one, at its most
def newly (n : Nat) (a b : Nat → Nat) (s s' : State K V) (d : Nat) : Nat :=
  if (s'.due d).isSome ∧ s.due d = none then a d + n * b d else 0

theorem waiting_le (n : Nat) (s : State K V) (d : Nat) : waiting n s d ≤ n :=
  Nat.le_trans (tot_const (x := 1) fun e _ => by split <;> omega) (by omega)

-- afters changed at c only, c not after d before
theorem waiting_mono {n c d : Nat} {s s' : State K V} (ha : ∀ e, e ≠ c → s'.after e = s.after e)
    (hc : s.after c ≠ some d) : waiting n s d ≤ waiting n s' d := by
  apply tot_le
  intro e _
  by_cases hec : e = c
  · subst hec; simp [hc]
  · rw [ha e hec]; exact Nat.le_refl _

theorem waiting_up {n c w : Nat} {s s' : State K V} (hcn : c < n)
    (ha : ∀ e, e ≠ c → s'.after e = s.after e) (hc : s.after c ≠ some w) (hc' : s'.after c = some w) :
    waiting n s w + 1 ≤ waiting n s' w := by
  have := tot_one (n := n) 1 hcn
  have h2 := tot_add n (fun e => if s.after e = some w then 1 else 0) (fun e => if e = c then 1 else 0)
  have h3 : tot n (fun e => (if s.after e = some w then 1 else 0) + (if e = c then 1 else 0)) ≤
      waiting n s' w := by
    apply tot_le
    intro e _
    by_cases hec : e = c
    · subst hec; simp [hc, hc']
    · simp [hec, ha e hec]
  unfold waiting at h3 ⊢
  omega

-- a run of a ready c, the afters changed at c only: not stopped, c's weight is spent
theorem dues_go {n c : Nat} {a b : Nat → Nat} {s s' : State K V} (hcn : c < n)
    (hc : (s.due c).isSome) (hr : ∀ w, s.after c = some w → s.due w = none)
    (ha : s'.after = put s.after c none)
    (hd : ∀ d, (s'.due d).isSome → d ≠ c ∧ ((s.due d).isSome ∨ s.due d = none)) :
    dues n a b s' + a c ≤ dues n a b s + tot n (newly n a b s s') := by
  have key : ∀ d, d < n → weight n a b s' d + (if d = c then a c else 0) ≤
      weight n a b s d + newly n a b s s' d := by
    intro d _
    have hwm : ∀ x, (s.due x).isSome → waiting n s x ≤ waiting n s' x := by
      intro x hx
      refine waiting_mono (c := c) (fun e he => by rw [ha, put_ne _ _ he]) ?_
      intro h; have := hr x h; simp [this] at hx
    by_cases hdc : d = c
    · subst hdc
      have : (s'.due d).isSome = false := by
        cases h : (s'.due d).isSome
        · rfl
        · exact absurd rfl (hd d h).1
      simp [weight, newly, this, hc]
    · simp only [hdc, ite_false, Nat.add_zero]
      unfold weight newly
      by_cases h1 : (s'.due d).isSome
      · by_cases h2 : (s.due d).isSome
        · have := hwm d h2
          have : (n - waiting n s' d) * b d ≤ (n - waiting n s d) * b d :=
            Nat.mul_le_mul_right _ (by omega)
          have hn : s.due d ≠ none := by intro e; simp [e] at h2
          simp [h1, h2, hn]; omega
        · have hn : s.due d = none := by simpa using h2
          have : (n - waiting n s' d) * b d ≤ n * b d := Nat.mul_le_mul_right _ (by omega)
          simp [h1, hn]; omega
      · simp [h1]
  have := tot_le key
  rw [tot_add, tot_add, tot_one _ hcn] at this
  exact this

-- stopped on a due w: c due again, w's weight less one b w
theorem dues_stop {n c w : Nat} {a b : Nat → Nat} {s s' : State K V} (hcn : c < n)
    (hc : (s.due c).isSome) (hr : ∀ w, s.after c = some w → s.due w = none)
    (hcc : s.after c ≠ some c) (hwc : w ≠ c) (hwn : w < n) (hw : (s.due w).isSome)
    (ha : s'.after = put s.after c (some w)) :
    dues n a b s' + b w ≤ dues n a b s + tot n (newly n a b s s') := by
  have hae : ∀ e, e ≠ c → s'.after e = s.after e := fun e he => by rw [ha, put_ne _ _ he]
  have key : ∀ d, d < n → weight n a b s' d + (if d = w then b w else 0) ≤
      weight n a b s d + newly n a b s s' d := by
    intro d _
    have hwm : ∀ x, (s.due x).isSome → waiting n s x ≤ waiting n s' x := by
      intro x hx
      refine waiting_mono (c := c) hae ?_
      intro h
      by_cases hxc : x = c
      · subst hxc; exact hcc h
      · have := hr x h; simp [this] at hx
    by_cases hdw : d = w
    · subst hdw
      have hup : waiting n s d + 1 ≤ waiting n s' d :=
        waiting_up hcn hae (fun h => by have := hr d h; simp [this] at hw) (by simp [ha])
      have := waiting_le n s' d
      have hn : s.due d ≠ none := by intro e; simp [e] at hw
      unfold weight newly
      simp only [hw, ite_true, hn, and_false, ite_false]
      by_cases h1 : (s'.due d).isSome
      · simp only [h1, ite_true]
        have : (n - waiting n s' d) * b d + b d ≤ (n - waiting n s d) * b d := by
          rw [← Nat.succ_mul]; exact Nat.mul_le_mul_right _ (by omega)
        omega
      · simp only [h1]
        have : b d ≤ (n - waiting n s d) * b d := by
          conv => lhs; rw [← Nat.one_mul (b d)]
          exact Nat.mul_le_mul_right _ (by omega)
        simp; omega
    · simp only [hdw, ite_false, Nat.add_zero]
      unfold weight newly
      by_cases h1 : (s'.due d).isSome
      · by_cases h2 : (s.due d).isSome
        · have := hwm d h2
          have : (n - waiting n s' d) * b d ≤ (n - waiting n s d) * b d :=
            Nat.mul_le_mul_right _ (by omega)
          have hn : s.due d ≠ none := by intro e; simp [e] at h2
          simp [h1, h2, hn]; omega
        · have hn : s.due d = none := by simpa using h2
          have : (n - waiting n s' d) * b d ≤ n * b d := Nat.mul_le_mul_right _ (by omega)
          simp [h1, hn]; omega
      · simp [h1]
  have := tot_le key
  rw [tot_add, tot_add, tot_one _ hwn] at this
  exact this

-- the new ones: at most n, each at most x
theorem fresh_le {n x : Nat} {a b : Nat → Nat} {s s' : State K V} (F : Nat → Prop)
    (hF : ∀ d, d < n → (s'.due d).isSome → s.due d = none → F d)
    (hx : ∀ d, d < n → F d → a d + n * b d ≤ x) : tot n (newly n a b s s') ≤ n * x := by
  apply tot_const
  intro d hd
  unfold newly
  split
  · rename_i h; exact hx d hd (hF d hd h.1 h.2)
  · omega

-- a run's end, writes in it or not

theorem finish_fix (s : State K V) (c : Nat) (e : Ended) (eq : Option Bool) (w : Option Nat)
    (th : Option (List Nat)) :
    Fixed s (finish s c e eq w th) ∧ (finish s c e eq w th).due = s.due ∧
    (finish s c e eq w th).writers = s.writers ∧ (finish s c e eq w th).reads = s.reads := by
  cases h : s.ran c with
  | none =>
    have e : finish s c e eq w th = s := by simp [finish, h]
    rw [e]; exact ⟨Fixed.refl s, rfl, rfl, rfl⟩
  | some r =>
    obtain ⟨_, _, -, hfin⟩ := finish_any s c r h e eq w th
    rw [hfin]; exact ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl⟩

theorem set_base (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V)
    (ht : ∀ d k, k ∈ s.reads d → (cs d).f.reads k) :
    Fixed s (set cs s c v) ∧ (set cs s c v).reads = s.reads ∧
    Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s
      (set cs s c v) := by
  simp only [set]
  split
  · rename_i k heq
    have hk : (cs c).writes k := Or.inr (Or.inr (by simp [heq]))
    obtain ⟨a, m⟩ := changed_feeds cs (store (say s (.set c v)) k v) [k] c (by simpa using hk) ht
    exact ⟨⟨a.made, a.after, a.acts, a.phase, a.last, a.earlies⟩, a.reads,
      Moved.trans (s' := store (say s (.set c v)) k v) (Moved.of_eq rfl rfl) m⟩
  · exact ⟨⟨rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, Moved.of_eq rfl rfl⟩

-- the queue of s' is s's, with at most one act of c more: any sum by computation grows by c's at
-- most, and what is there was there or is c's
def QAdd (s s' : State K V) (c : Nat) : Prop :=
  (∀ g : Nat → Nat, ((queue s').map (fun a => g a.1)).sum ≤ ((queue s).map (fun a => g a.1)).sum + g c) ∧
  (∀ a ∈ queue s', a ∈ queue s ∨ a.1 = c)

theorem QAdd.of_eq {s s' : State K V} {c : Nat} (h : queue s' = queue s) : QAdd s s' c :=
  ⟨fun g => by rw [h]; omega, fun a ha => Or.inl (h ▸ ha)⟩

theorem QAdd.trans_eq {s s' s'' : State K V} {c : Nat} (a : QAdd s s' c) (h : queue s'' = queue s') :
    QAdd s s'' c := ⟨fun g => by rw [h]; exact a.1 g, fun x hx => a.2 x (h ▸ hx)⟩

theorem qadd_early (s : State K V) (c : Nat) (v : V) :
    QAdd s { s with earlies := s.earlies ++ [(c, v)] } c := by
  refine ⟨fun g => ?_, fun a ha => ?_⟩
  · simp [queue, List.map_append, List.sum_append]; omega
  · simp only [queue, List.mem_append, List.mem_singleton] at ha ⊢
    rcases ha with (h | h) | h
    · exact Or.inl (Or.inl h)
    · subst h; exact Or.inr rfl
    · exact Or.inl (Or.inr h)

theorem qadd_late (s : State K V) (c : Nat) (v : V) :
    QAdd s { s with acts := s.acts ++ [(c, v)] } c := by
  refine ⟨fun g => ?_, fun a ha => ?_⟩
  · simp [queue, List.map_append, List.sum_append]; omega
  · simp only [queue, List.mem_append, List.mem_singleton] at ha ⊢
    rcases ha with h | h | h
    · exact Or.inl (Or.inl h)
    · exact Or.inl (Or.inr h)
    · subst h; exact Or.inr rfl

theorem result_base (cs : Nat → Comp K V) (s : State K V) (c : Nat) (v : V)
    (ht : ∀ d k, k ∈ s.reads d → (cs d).f.reads k) :
    (result cs s c v).made = s.made ∧ (result cs s c v).after = s.after ∧
    (result cs s c v).phase = s.phase ∧ (result cs s c v).reads = s.reads ∧
    QAdd s (result cs s c v) c ∧
    Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s
      (result cs s c v) ∧ (result cs s c v).asleep = s.asleep := by
  have fin : ∀ (s' : State K V) e eq w th, s'.made = s.made → s'.after = s.after →
      s'.phase = s.phase → s'.reads = s.reads →
      Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s s' →
      QAdd s s' c → s'.asleep = s.asleep →
      (finish s' c e eq w th).made = s.made ∧ (finish s' c e eq w th).after = s.after ∧
      (finish s' c e eq w th).phase = s.phase ∧ (finish s' c e eq w th).reads = s.reads ∧
      QAdd s (finish s' c e eq w th) c ∧
      Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s
        (finish s' c e eq w th) ∧ (finish s' c e eq w th).asleep = s.asleep := by
    intro s' e eq w th e1 e2 e3 r m a z
    obtain ⟨f1, d1, w1, r1⟩ := finish_fix s' c e eq w th
    exact ⟨f1.1.trans e1, f1.2.trans e2, f1.4.trans e3, r1.trans r,
      a.trans_eq (by simp [queue, f1.3, f1.6]),
      Moved.trans m (Moved.of_eq d1 w1), by simp [z]⟩
  simp only [result]
  split
  · exact fin s _ _ _ _ rfl rfl rfl rfl (Moved.refl _ _ s) (QAdd.of_eq rfl) rfl
  · rename_i e _
    split
    · exact fin s _ _ _ _ rfl rfl rfl rfl (Moved.refl _ _ s) (QAdd.of_eq rfl) rfl
    · split
      · split
        · exact fin s _ _ _ _ rfl rfl rfl rfl (Moved.refl _ _ s) (QAdd.of_eq rfl) rfl
        · split
          · exact fin _ _ _ _ _ rfl rfl rfl rfl (Moved.of_eq rfl rfl) (qadd_early s c v) rfl
          · exact fin _ _ _ _ _ rfl rfl rfl rfl (Moved.of_eq rfl rfl) (qadd_late s c v) rfl
      · split
        · exact fin s _ _ _ _ rfl rfl rfl rfl (Moved.refl _ _ s) (QAdd.of_eq rfl) rfl
        · obtain ⟨f1, r1, m1⟩ := set_base cs s c v ht
          exact fin _ _ _ _ _ f1.1 f1.2 f1.4 r1 (Moved.trans m1 (Moved.of_eq rfl rfl))
            (QAdd.of_eq (by simp [queue, f1.3, f1.6]))
            (by simp only [Model.set]; split <;> simp [say, store])

theorem ending_base (cs : Nat → Comp K V) (s : State K V) (c : Nat) (o : Out V)
    (ht : ∀ d k, k ∈ s.reads d → (cs d).f.reads k) :
    (ending cs s c o).made = s.made ∧ (ending cs s c o).phase = s.phase ∧
    (ending cs s c o).reads = s.reads ∧ (ending cs s c o).asleep = s.asleep ∧
    ((∃ r w, s.ran c = some r ∧ r.stopped = some w ∧
        (ending cs s c o).after = put s.after c (some w) ∧
        (ending cs s c o).due = put s.due c (some r.mark) ∧ queue (ending cs s c o) = queue s ∧
        (ending cs s c o).writers = s.writers) ∨
      ((s.ran c).bind (·.stopped) = none ∧ (ending cs s c o).after = s.after ∧
        QAdd s (ending cs s c o) c ∧
        Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s
          (ending cs s c o))) := by
  unfold ending
  split
  · rename_i hst
    cases hr : s.ran c with
    | none => simp [hr] at hst
    | some r =>
      simp only [hr, Option.bind_some] at hst
      obtain ⟨w, hw⟩ := Option.isSome_iff_exists.1 hst
      have key : ∀ X : State K V, X.made = s.made → X.phase = s.phase → X.reads = s.reads →
          X.after = put s.after c r.stopped → X.due = put s.due c (some r.mark) →
          queue X = queue s → X.writers = s.writers → X.asleep = s.asleep →
          (finish X c .stopped none r.stopped none).made = s.made ∧
          (finish X c .stopped none r.stopped none).phase = s.phase ∧
          (finish X c .stopped none r.stopped none).reads = s.reads ∧
          (finish X c .stopped none r.stopped none).asleep = s.asleep ∧
          (finish X c .stopped none r.stopped none).after = put s.after c (some w) ∧
          (finish X c .stopped none r.stopped none).due = put s.due c (some r.mark) ∧
          queue (finish X c .stopped none r.stopped none) = queue s ∧
          (finish X c .stopped none r.stopped none).writers = s.writers := by
        intro X e1 e2 e3 e4 e5 e6 e7 e8
        obtain ⟨f, d, wr, rd⟩ := finish_fix X c .stopped none r.stopped none
        refine ⟨f.1.trans e1, f.4.trans e2, rd.trans e3, by simp [e8], ?_, ?_,
          by simp [queue, f.3, f.6]; exact e6, wr.trans e7⟩
        · rw [f.2, e4, hw]
        · rw [d, e5]
      have hs : (stop s c).made = s.made ∧ (stop s c).phase = s.phase ∧
          (stop s c).reads = s.reads ∧ (stop s c).asleep = s.asleep ∧
          (stop s c).after = put s.after c (some w) ∧
          (stop s c).due = put s.due c (some r.mark) ∧ queue (stop s c) = queue s ∧
          (stop s c).writers = s.writers := by
        simp only [stop, hr]
        split
        · exact key
            { s with loop := put s.loop c r.loop, after := put s.after c r.stopped,
                     due := put s.due c (some r.mark) } rfl rfl rfl rfl rfl rfl rfl rfl
        · exact key { s with after := put s.after c r.stopped, due := put s.due c (some r.mark) }
            rfl rfl rfl rfl rfl rfl rfl rfl
      obtain ⟨a1, a2, a3, a0, a4, a5, a6, a7⟩ := hs
      exact ⟨a1, a2, a3, a0, Or.inl ⟨r, w, rfl, hw, a4, a5, a6, a7⟩⟩
  · rename_i hst
    have hst' : (s.ran c).bind (·.stopped) = none := by simpa using hst
    generalize hs1 : edit s c (fun r => { r with out := some o }) = s1
    have e1 : s1.made = s.made := by rw [← hs1]; rfl
    have e2 : s1.after = s.after := by rw [← hs1]; rfl
    have e3 : s1.phase = s.phase := by rw [← hs1]; rfl
    have e4 : s1.reads = s.reads := by rw [← hs1]; rfl
    have e5 : queue s1 = queue s := by rw [← hs1]; rfl
    have e6 : s1.asleep = s.asleep := by rw [← hs1]; rfl
    have m1 : Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s s1 :=
      Moved.of_eq (by rw [← hs1]; rfl) (by rw [← hs1]; rfl)
    have plain : ∀ e, (finish s1 c e none none none).made = s.made ∧
        (finish s1 c e none none none).phase = s.phase ∧
        (finish s1 c e none none none).reads = s.reads ∧
        (finish s1 c e none none none).asleep = s.asleep ∧
        ((∃ r w, s.ran c = some r ∧ r.stopped = some w ∧
          (finish s1 c e none none none).after = put s.after c (some w) ∧
          (finish s1 c e none none none).due = put s.due c (some r.mark) ∧
          queue (finish s1 c e none none none) = queue s ∧
          (finish s1 c e none none none).writers = s.writers) ∨
        ((s.ran c).bind (·.stopped) = none ∧ (finish s1 c e none none none).after = s.after ∧
          QAdd s (finish s1 c e none none none) c ∧
          Moved (fun d => d < s.made ∧ feeds cs c d) (fun k w => w = c ∧ (cs c).writes k) s
            (finish s1 c e none none none))) := by
      intro e
      obtain ⟨f, d, wr, rd⟩ := finish_fix s1 c e none none none
      exact ⟨f.1.trans e1, f.4.trans e3, rd.trans e4, by simp [e6], Or.inr ⟨hst', f.2.trans e2,
        QAdd.of_eq (by rw [← e5]; simp [queue, f.3, f.6]), Moved.trans m1 (Moved.of_eq d wr)⟩⟩
    split
    · exact plain _
    · exact plain _
    · rename_i v
      obtain ⟨a1, a2, a3, a4, a5, a6, a7⟩ := result_base cs s1 c v (by rw [e4]; exact ht)
      refine ⟨a1.trans e1, a3.trans e3, a4.trans e4, a7.trans e6, Or.inr ⟨hst', a2.trans e2, ?_,
        Moved.trans m1 (a6.mono (fun d h => ⟨e1 ▸ h.1, h.2⟩) (fun _ _ h => h))⟩⟩
      refine ⟨fun g => ?_, fun a h => ?_⟩
      · have := a5.1 g; rw [e5] at this; exact this
      · rcases a5.2 a h with h | h
        · exact Or.inl (e5 ▸ h)
        · exact Or.inr h

-- a run step, writes in it or not: c is done with, or due again after a due writer fed into it;
-- what else became due is fed by c, or was asleep (and is woken: up now); what is asleep after was
-- before, as due as it was
theorem first_base (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (g : Base cs s)
    (hc : (s.due c).isSome) :
    (first cs s c rk).made = s.made ∧ (first cs s c rk).phase = s.phase ∧
    (∀ d m, d ≠ c → s.due d = some m → (first cs s c rk).due d = some m) ∧
    (((first cs s c rk).after = put s.after c none ∧
      ∀ d, ((first cs s c rk).due d).isSome → (d ≠ c ∧ (s.due d).isSome) ∨
        (d < s.made ∧ (feeds cs c d ∨ s.asleep d = true))) ∨
     ∃ w, (first cs s c rk).after = put s.after c (some w) ∧ w ≠ c ∧ w < s.made ∧
      ((first cs s c rk).due w).isSome ∧ ((first cs s c rk).due c).isSome ∧ feeds cs w c ∧
      waits (start s c rk) w c = false ∧
      ∀ d, ((first cs s c rk).due d).isSome → d = c ∨ (s.due d).isSome ∨
        (d < s.made ∧ (feeds cs c d ∨ s.asleep d = true))) ∧
    QAdd (start s c rk) (first cs s c rk) c ∧
    (∀ d, (first cs s c rk).asleep d = true → s.asleep d = true) ∧
    Base cs (first cs s c rk) := by
  have hcm : c < s.made := g.due_made c hc
  have hzc : s.asleep c = false := by
    cases h : s.asleep c
    · rfl
    · rw [g.asleep_due c h] at hc; cases hc
  -- start
  have s1 : (start s c rk).made = s.made ∧ (start s c rk).phase = s.phase ∧
      (start s c rk).reads = s.reads ∧ (start s c rk).writers = s.writers ∧
      (start s c rk).due = put s.due c none ∧ (start s c rk).after = put s.after c none ∧
      queue (start s c rk) = (queue s).filter (fun a => a.1 ≠ c) ∧
      (∀ r, (start s c rk).ran c = some r → r.stopped = none ∧ ∀ q ∈ r.seen, (cs c).f.reads q.1) ∧
      ((start s c rk).ran c).isSome ∧ (start s c rk).asleep = s.asleep := by
    refine ⟨rfl, rfl, rfl, rfl, rfl, rfl, by simp [start, say, queue, List.filter_append], ?_,
      by simp [start, say], rfl⟩
    intro r h; simp [start, say] at h; subst h; simp
  obtain ⟨e1, e2, e3, e4, e5, e6, e7, e8, e9, e0⟩ := s1
  obtain ⟨f2, r2, i2, m2, t2, l2, st2, sn2, z2, q2⟩ := exec_base cs c (cs c).f (start s c rk) (fun _ h => h)
    (fun _ h => h) (by rw [e3]; exact g.tracked) (by rw [e4]; exact g.learned) e8
    (by rw [e0, e3]; exact g.asleep_reads) (by rw [e0]; exact hzc)
  simp only [first]
  generalize hx : exec cs c (start s c rk) (cs c).f = x at f2 r2 i2 m2 t2 l2 st2 sn2 z2 q2
  obtain ⟨s2, o⟩ := x
  simp only at f2 r2 i2 m2 t2 l2 st2 sn2 z2 q2 ⊢
  rw [untrack_eq]
  generalize hs3 : ({ ({ s2 with reads := put s2.reads c (((s2.ran c).map fun r => r.seen.map (·.1)).getD []) } :
      State K V) with dying := _ } : State K V) = s3
  have t3 : ∀ d k, k ∈ s3.reads d → (cs d).f.reads k := by
    intro d k h
    rw [← hs3] at h
    by_cases hd : d = c
    · subst hd
      simp only [put_same] at h
      cases e : s2.ran d with
      | none => simp [e] at h
      | some r =>
        simp only [e, Option.map_some, Option.getD_some, List.mem_map] at h
        obtain ⟨q, hq, rfl⟩ := h
        exact sn2 r e q hq
    · simp only [put_ne _ _ hd] at h; exact t2 d k h
  obtain ⟨a1, a2, a3, a0, a4⟩ := ending_base cs s3 c o t3
  have h3 : s3.made = s.made ∧ s3.phase = s.phase ∧ s3.due = s2.due ∧ s3.after = s2.after ∧
      queue s3 = queue s2 ∧ s3.writers = s2.writers ∧ s3.ran = s2.ran ∧ s3.asleep = s2.asleep := by
    rw [← hs3]; exact ⟨f2.1.trans e1, f2.4.trans e2, rfl, rfl, rfl, rfl, rfl, rfl⟩
  obtain ⟨b1, b2, b3, b4, b5, b6, b7, b8⟩ := h3
  have hz3 : s3.asleep c = false := by
    cases h : s3.asleep c
    · rfl
    · rw [b8] at h; have := (z2 c h).1; rw [e0, hzc] at this; cases this
  have hush := ending_hush cs s3 c o hz3
  have ea : s2.after = put s.after c none := f2.2.trans e6
  have eacts : queue s2 = (queue s).filter (fun a => a.1 ≠ c) := by
    rw [← e7]; simp [queue, f2.3, f2.6]
  -- dues before ending: c's gone, the rest grew, the new ones fed by c or woken
  have hd2 : ∀ d m, d ≠ c → s.due d = some m → s2.due d = some m := by
    intro d m hd h
    exact m2.due d m (by rw [e5, put_ne _ _ hd]; exact h)
  have hf2 : ∀ d, (s2.due d).isSome → (d ≠ c ∧ (s.due d).isSome) ∨
      (d < s.made ∧ (feeds cs c d ∨ s.asleep d = true)) := by
    intro d h
    rcases m2.fresh d h with h | h
    · rw [e5] at h
      by_cases hd : d = c
      · subst hd; simp at h
      · rw [put_ne _ _ hd] at h; exact Or.inl ⟨hd, h⟩
    · exact Or.inr ⟨by rw [← e1]; exact h.1, by rw [← e0]; exact h.2⟩
  generalize hF : ending cs s3 c o = F at a1 a2 a3 a0 a4 hush
  have hFm : F.made = s.made := a1.trans b1
  have hFz : ∀ d, F.asleep d = true → s.asleep d = true := by
    intro d h; rw [a0, b8] at h; rw [← e0]; exact (z2 d h).1
  -- the afters with c's cleared: s's, less one
  have sub : ∀ a b, TransGen (fun x y => put s.after c none x = some y) a b → TransGen (aft s) a b := by
    intro a b h
    refine tg_mono (fun x y hxy => ?_) h
    by_cases hx : x = c
    · subst hx; simp at hxy
    · simp [put_ne _ _ hx] at hxy; exact hxy
  have hdue : ∀ d m, d ≠ c → s.due d = some m → F.due d = some m := by
    intro d m hd h
    rcases a4 with ⟨r, w, hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
    · rw [hdd, put_ne _ _ hd, b3]; exact hd2 d m hd h
    · exact m4.due d m (by rw [b3]; exact hd2 d m hd h)
  have hdm : ∀ x, (F.due x).isSome → x < s.made := by
    intro x h
    have key : ∀ x, (s2.due x).isSome → x < s.made := by
      intro x h
      rcases hf2 x h with ⟨_, h⟩ | ⟨h, _⟩
      · exact g.due_made x h
      · exact h
    rcases a4 with ⟨r, w, hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
    · rw [hdd] at h
      by_cases hx : x = c
      · subst hx; exact hcm
      · rw [put_ne _ _ hx, b3] at h; exact key x h
    · rcases m4.fresh x h with h | h
      · rw [b3] at h; exact key x h
      · rw [← b1]; exact h.1
  refine ⟨a1.trans b1, a2.trans b2, hdue, ?_, ?_, hFz, ?_⟩
  · rcases a4 with ⟨r, w, hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
    · right
      obtain ⟨h1, h2, h3, h4⟩ := st2 w (by rw [← b7, hr]; exact hw)
      have hwm : w < s.made := by
        rcases hf2 w h1 with ⟨_, h⟩ | ⟨h, _⟩
        · exact g.due_made w h
        · exact h
      refine ⟨w, by rw [ha, b4, ea, put_put], h3, hwm, by rw [hdd, put_ne _ _ h3, b3]; exact h1,
        by rw [hdd]; simp, h4, h2, ?_⟩
      intro d h
      by_cases hd : d = c
      · exact Or.inl hd
      · rw [hdd, put_ne _ _ hd, b3] at h
        rcases hf2 d h with ⟨_, h⟩ | h
        · exact Or.inr (Or.inl h)
        · exact Or.inr (Or.inr h)
    · left
      refine ⟨by rw [ha, b4, ea], fun d h => ?_⟩
      rcases m4.fresh d h with h | h
      · rw [b3] at h; exact hf2 d h
      · exact Or.inr ⟨by rw [← b1]; exact h.1, Or.inl h.2⟩
  · have hq3 : queue s3 = queue (start s c rk) := by rw [b5, eacts, e7]
    rcases a4 with ⟨r, w, hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
    · exact QAdd.of_eq (by rw [hac, hq3])
    · exact ⟨fun gg => by rw [← hq3]; exact hac.1 gg, fun a h => by rw [← hq3]; exact hac.2 a h⟩
  · refine ⟨?_, ?_, fun x h => hFm ▸ hdm x h, by rw [a3]; exact t3, ?_, ?_, ?_, ?_, ?_⟩
    · intro x w h
      rw [hFm]
      have hx : x ≠ c → s.after x = some w := by
        intro hx
        rcases a4 with ⟨r, w', hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
        · rw [ha, b4, ea, put_ne _ _ hx, put_ne _ _ hx] at h; exact h
        · rw [ha, b4, ea, put_ne _ _ hx] at h; exact h
      by_cases hxc : x = c
      · subst hxc
        rcases a4 with ⟨r, w', hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
        · rw [ha, b4, ea, put_put] at h; simp at h; subst h
          obtain ⟨h1, _, h3, _⟩ := st2 w' (by rw [← b7, hr]; exact hw)
          refine ⟨by rw [hdd]; simp, ?_⟩
          rcases hf2 w' h1 with ⟨_, h⟩ | ⟨h, _⟩
          · exact g.due_made w' h
          · exact h
        · rw [ha, b4, ea] at h; simp at h
      · obtain ⟨h1, h2⟩ := g.after_due x w (hx hxc)
        obtain ⟨m, hm⟩ := Option.isSome_iff_exists.1 h1
        exact ⟨by rw [hdue x m hxc hm]; rfl, h2⟩
    · intro x h
      rcases a4 with ⟨r, w, hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
      · have e' : aft F = fun x y => put (put s.after c none) c (some w) x = some y := by
          funext a b; simp [aft, ha, b4, ea]
        rw [e'] at h
        obtain ⟨_, h2, hwc, _⟩ := st2 w (by rw [← b7, hr]; exact hw)
        rcases tg_put (by simp) h with h | ⟨h1, h2'⟩
        · exact g.acyclic x (sub x x h)
        · -- then w reaches c with c's after cleared: waitsAfter would have said so
          have hwc' : TransGen (fun x y => put s.after c none x = some y) w c := by
            rcases h1 with rfl | h1 <;> rcases h2' with h2' | h2'
            · exact absurd h2' hwc
            · exact h2'
            · subst h2'; exact h1
            · exact TransGen.trans h2' h1
          have ea' : aft (start s c rk) = fun x y => put s.after c none x = some y := by
            funext a b; simp [aft, start, say]
          have hwm : w < s.made := hdm w (by rw [hdd, put_ne _ _ hwc, b3]; exact (st2 w (by rw [← b7, hr]; exact hw)).1)
          have hst : waits (start s c rk) w c = true := by
            refine waits_of_tg ?_ ?_ (by simpa [start, say] using hwm) ?_
            · intro y hy
              rw [ea'] at hy
              exact g.acyclic y (sub y y hy)
            · intro a b hab
              have : put s.after c none a = some b := by simpa [start, say] using hab
              by_cases ha : a = c
              · subst ha; simp at this
              · rw [put_ne _ _ ha] at this
                simpa [start, say] using (g.after_due a b this).2
            · rw [ea']; exact hwc'
          rw [h2] at hst; cases hst
      · have e' : aft F = fun x y => put s.after c none x = some y := by
          funext a b; simp [aft, ha, b4, ea]
        exact g.acyclic x (sub x x (e' ▸ h))
    · intro k w h
      rcases a4 with ⟨r, w', hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
      · rw [hwr, b6] at h; exact l2 k w h
      · rcases m4.writers k w h with h | ⟨rfl, h⟩
        · rw [b6] at h; exact l2 k w h
        · exact h
    · intro a h
      rw [hFm]
      have hf : ∀ a ∈ queue s3, a.1 < s.made := by
        intro a h
        rw [b5, eacts] at h
        exact g.acts_made a (List.mem_filter.1 h).1
      rcases a4 with ⟨r, w', hr, hw, ha, hdd, hac, hwr⟩ | ⟨hst, ha, hac, m4⟩
      · rw [hac] at h; exact hf a h
      · rcases hac.2 a h with h | h
        · exact hf a h
        · rw [h]; exact hcm
    · intro d h
      have h' : s3.asleep d = true := by rw [← a0]; exact h
      have hs := (z2 d (b8 ▸ h')).1
      rw [e0] at hs
      by_cases e : F.due d = s3.due d
      · rw [e, b3, (z2 d (b8 ▸ h')).2, e5]
        have hdc : d ≠ c := by intro e'; subst e'; rw [hzc] at hs; cases hs
        rw [put_ne _ _ hdc]; exact g.asleep_due d hs
      · rcases hush.due d e with h2 | h2
        · rw [h] at h2; cases h2
        · exfalso; apply h2
          have hdc : d ≠ c := by intro e'; subst e'; rw [hzc] at hs; cases hs
          rw [← hs3]; simp only [put_ne _ _ hdc]
          rw [q2 d hdc, e3]; exact g.asleep_reads d hs
    · intro d h
      have h' : s3.asleep d = true := by rw [← a0]; exact h
      have hs := (z2 d (b8 ▸ h')).1
      rw [e0] at hs
      have hdc : d ≠ c := by intro e'; subst e'; rw [hzc] at hs; cases hs
      rw [a3, ← hs3]; simp only [put_ne _ _ hdc]
      rw [q2 d hdc, e3]; exact g.asleep_reads d hs
    · intro d h
      rw [hFm]
      by_cases hdc : d = c
      · subst hdc; exact hcm
      · rw [a3, ← hs3] at h; simp only [put_ne _ _ hdc] at h
        rw [q2 d hdc, e3] at h; exact g.reads_made d h

-- an act's writes, each said changed by e
theorem writes_base (cs : Nat → Comp K V) (e : Nat) : ∀ (ws : List (K × V)) (s : State K V),
    (∀ kv ∈ ws, (cs e).writes kv.1) → (∀ d k, k ∈ s.reads d → (cs d).f.reads k) →
    Fixed s (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s) ∧
    (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s).reads = s.reads ∧
    Moved (fun d => d < s.made ∧ feeds cs e d) (fun k w => w = e ∧ (cs e).writes k) s
      (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s)
  | [], s, _, _ => ⟨Fixed.refl s, rfl, Moved.refl _ _ s⟩
  | kv :: ws, s, hw, ht => by
    simp only [List.foldl_cons]
    obtain ⟨a, m⟩ := changed_feeds cs (store s kv.1 kv.2) [kv.1] e (by simpa using hw kv (by simp)) ht
    have em : (changed cs (store s kv.1 kv.2) [kv.1] (some e)).made = s.made := a.made
    obtain ⟨f2, r2, m2⟩ := writes_base cs e ws _ (fun x hx => hw x (by simp [hx]))
      (by rw [a.reads]; exact ht)
    refine ⟨Fixed.trans ⟨a.made, a.after, a.acts, a.phase, a.last, a.earlies⟩ f2, r2.trans a.reads, ?_⟩
    refine Moved.trans (s' := store s kv.1 kv.2) (Moved.of_eq rfl rfl) (Moved.trans m ?_)
    exact m2.mono (fun d h => ⟨em ▸ h.1, h.2⟩) (fun _ _ h => h)

-- an act step, writes in runs or not: what it marks is fed by e. s0 is s with its act out of the
-- queue, what else is queued as it was
theorem act_base (cs : Nat → Comp K V) (s s0 : State K V) (e : Nat) (v : V)
    (es as : List (Nat × V)) (h0 : s0 = { s with earlies := es, acts := as }) (g : Base cs s)
    (hrest : ∀ a ∈ es ++ as, a ∈ queue s) :
    (act cs s0 e v).made = s.made ∧
    (act cs s0 e v).phase = s.phase ∧
    (act cs s0 e v).after = s.after ∧
    (act cs s0 e v).earlies = es ∧ (act cs s0 e v).acts = as ∧
    Moved (fun d => d < s.made ∧ feeds cs e d) (fun k w => w = e ∧ (cs e).writes k) s
      (act cs s0 e v) ∧
    (act cs s0 e v).asleep = s.asleep ∧
    Base cs (act cs s0 e v) := by
  subst h0
  have fin : ∀ A : State K V, A.made = s.made → A.after = s.after → A.reads = s.reads →
      A.earlies = es → A.acts = as → A.phase = s.phase → A.asleep = s.asleep →
      (∀ d, A.asleep d = true → A.due d = s.due d) →
      Moved (fun d => d < s.made ∧ feeds cs e d) (fun k w => w = e ∧ (cs e).writes k) s A →
      Base cs A := by
    intro A e1 e2 e3 e4 e5 e6 e7 e8 m
    refine ⟨fun x w h => ?_, fun x h => ?_, fun x h => ?_, by rw [e3]; exact g.tracked, ?_,
      fun a h => ?_, fun x h => ?_, fun x h => ?_, fun x h => ?_⟩
    · rw [e2] at h
      obtain ⟨h1, h2⟩ := g.after_due x w h
      exact ⟨m.isSome h1, e1 ▸ h2⟩
    · have : aft A = aft s := by funext a b; simp [aft, e2]
      exact g.acyclic x (this ▸ h)
    · rcases m.fresh x h with h | h
      · exact e1 ▸ g.due_made x h
      · exact e1 ▸ h.1
    · intro k w h
      rcases m.writers k w h with h | ⟨rfl, h⟩
      · exact g.learned k w h
      · exact h
    · rw [queue, e4, e5] at h; rw [e1]; exact g.acts_made a (hrest a h)
    · rw [e8 x h]; exact g.asleep_due x (e7 ▸ h)
    · rw [e3]; exact g.asleep_reads x (e7 ▸ h)
    · rw [e1]; rw [e3] at h; exact g.reads_made x h
  have hush := act_hush cs { s with earlies := es, acts := as } e v
  have ez : (act cs { s with earlies := es, acts := as } e v).asleep = s.asleep := by
    unfold act
    split
    · rfl
    · split
      · rfl
      · dsimp only
        simp only [say]
        have : ∀ (ws : List (K × V)) (s1 : State K V),
            (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1).asleep =
              s1.asleep := by
          intro ws; induction ws with
          | nil => intro s1; rfl
          | cons kv ws ih => intro s1; simp only [List.foldl_cons]; rw [ih]; simp [store]
        rw [this]
  have keep : ∀ d, (act cs { s with earlies := es, acts := as } e v).asleep d = true →
      (act cs { s with earlies := es, acts := as } e v).due d = s.due d := by
    intro d h
    by_cases e' : (act cs { s with earlies := es, acts := as } e v).due d =
      ({ s with earlies := es, acts := as } : State K V).due d
    · exact e'
    · rcases hush.due d e' with h2 | h2
      · rw [h] at h2; cases h2
      · exact absurd (g.asleep_reads d (by rw [ez] at h; exact h)) h2
  have hfr : (act cs { s with earlies := es, acts := as } e v).made = s.made ∧
      (act cs { s with earlies := es, acts := as } e v).phase = s.phase ∧
      (act cs { s with earlies := es, acts := as } e v).after = s.after ∧
      (act cs { s with earlies := es, acts := as } e v).earlies = es ∧
      (act cs { s with earlies := es, acts := as } e v).acts = as ∧
      (act cs { s with earlies := es, acts := as } e v).reads = s.reads ∧
      Moved (fun d => d < s.made ∧ feeds cs e d) (fun k w => w = e ∧ (cs e).writes k) s
        (act cs { s with earlies := es, acts := as } e v) := by
    simp only [act]
    split
    · exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, Moved.of_eq rfl rfl⟩
    · split
      · exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, Moved.of_eq rfl rfl⟩
      · rename_i act' hk
        obtain ⟨f, r, m⟩ := writes_base cs e (act' v (s.last e))
          (say { s with earlies := es, acts := as } (.act e v (s.last e)))
          (fun kv hkv => Or.inr (Or.inr (by simp [hk]; exact ⟨v, s.last e, kv.2, hkv⟩)))
          (by exact g.tracked)
        generalize hX : (act' v (s.last e)).foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1]
          (some e)) (say { s with earlies := es, acts := as } (.act e v (s.last e))) = X at f r m ⊢
        have m1 : Moved (fun d => d < s.made ∧ feeds cs e d) (fun k w => w = e ∧ (cs e).writes k) s X :=
          Moved.trans (s' := say { s with earlies := es, acts := as } (.act e v (s.last e)))
            (Moved.of_eq (s := s) rfl rfl) (m.mono (fun d h => h) (fun _ _ h => h))
        exact ⟨f.1, f.4, f.2, f.6, f.3, r, Moved.trans m1 (Moved.of_eq rfl rfl)⟩
  obtain ⟨a1, a2, a3, a4, a5, a6, a7⟩ := hfr
  exact ⟨a1, a2, a3, a4, a5, a7, ez, fin _ a1 a3 a6 a4 a5 a2 ez keep a7⟩

-- Base over every reachable state

theorem Base.empty (cs : Nat → Comp K V) : Base cs (empty : State K V) where
  after_due x w h := by simp [Model.empty] at h
  acyclic x h := by
    obtain ⟨z, hz, _⟩ := tg_head h
    simp [aft, Model.empty] at hz
  due_made x h := by simp [Model.empty] at h
  tracked d k h := by simp [Model.empty] at h
  learned k w h := by simp [Model.empty] at h
  acts_made a h := by simp [Model.empty, queue] at h
  asleep_due c h := by simp [Model.empty] at h
  asleep_reads c h := by simp [Model.empty] at h
  reads_made c h := by simp [Model.empty] at h

-- what keeps the afters, reads, asleep, queue and made, grows the dues at made ones (awake, or
-- reading nothing... a reader), learns writers of keys they may write
theorem Base.extend {cs : Nat → Comp K V} {s s' : State K V} (g : Base cs s) (e1 : s'.made = s.made)
    (e2 : s'.after = s.after) (e3 : s'.reads = s.reads) (e4 : queue s' = queue s)
    (e5 : s'.asleep = s.asleep) (F : Nat → Prop) (G : K → Nat → Prop)
    (m : Moved F G s s') (hF : ∀ d, F d → d < s.made ∧ s.reads d ≠ [])
    (hG : ∀ k w, G k w → (cs w).writes k) : Base cs s' where
  after_due x w h := by
    rw [e2] at h
    obtain ⟨h1, h2⟩ := g.after_due x w h
    exact ⟨m.isSome h1, e1 ▸ h2⟩
  acyclic x h := by
    have : aft s' = aft s := by funext a b; simp [aft, e2]
    exact g.acyclic x (this ▸ h)
  due_made x h := by
    rcases m.fresh x h with h | h
    · exact e1 ▸ g.due_made x h
    · exact e1 ▸ (hF x h).1
  tracked := by rw [e3]; exact g.tracked
  learned k w h := by
    rcases m.writers k w h with h | h
    · exact g.learned k w h
    · exact hG k w h
  acts_made a h := by rw [e4] at h; rw [e1]; exact g.acts_made a h
  asleep_due x h := by
    rw [e5] at h
    cases e : s'.due x with
    | none => rfl
    | some y =>
      rcases m.fresh x (by simp [e]) with h2 | h2
      · rw [g.asleep_due x h] at h2; cases h2
      · exact absurd (g.asleep_reads x h) (hF x h2).2
  asleep_reads x h := by rw [e3]; rw [e5] at h; exact g.asleep_reads x h
  reads_made x h := by rw [e1]; rw [e3] at h; exact g.reads_made x h

theorem Base.tell {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) (keys : List K) :
    Base cs (changed cs s keys none) := by
  obtain ⟨a, m⟩ := changed_same cs s keys none
  refine g.extend a.made a.after a.reads (by simp [queue, a.acts, a.earlies]) a.asleep _ _ m
    (fun d h => ⟨h.1, ?_⟩) (fun k w h => by simp at h)
  obtain ⟨_, k, _, hk⟩ := h
  intro e; rw [e] at hk; cases hk

theorem Base.write {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) (kvs : List (K × V)) :
    Base cs (write cs s kvs) := by
  obtain ⟨st, h1, _⟩ := stores_shape s kvs
  simp only [Model.write, h1]
  have g' : Base cs { s with store := st } := ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩
  exact g'.tell _

-- a going (Quiet): d asleep, not due, reading nothing, after nothing
theorem Base.bury {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) (hQ : Quiet cs) (d : Nat) :
    Base cs (bury cs s d) := by
  unfold Model.bury
  cases (cs d).key with
  | none => exact g
  | some k =>
    simp only
    split
    · exact g
    · rw [hQ d]
      simp only [List.foldl_nil]
      obtain ⟨dy, hU⟩ := untrack_shape cs (s.reads d) { s with
        due := put s.due d none, asleep := put s.asleep d true, reads := put s.reads d [],
        values := put s.values d [], after := put s.after d none, last := put s.last d none,
        kept := put s.kept d [], loop := put s.loop d none, looping := put s.looping d false,
        ran := put s.ran d none, cut := put s.cut d false, store := put s.store k none }
      rw [hU]
      refine ⟨fun x w h => ?_, fun x h => ?_, fun x h => ?_, fun x k' h => ?_, g.learned,
        fun a h => g.acts_made a h, fun x h => ?_, fun x h => ?_, fun x h => ?_⟩
      · by_cases hx : x = d
        · subst hx; simp at h
        · simp only [put_ne _ _ hx] at h ⊢; exact g.after_due x w h
      · refine g.acyclic x (tg_mono (fun a b hab => ?_) h)
        by_cases ha : a = d
        · subst ha; simp [aft] at hab
        · simpa [aft, put_ne _ _ ha] using hab
      · by_cases hx : x = d
        · subst hx; simp at h
        · simp only [put_ne _ _ hx] at h; exact g.due_made x h
      · by_cases hx : x = d
        · subst hx; simp at h
        · simp only [put_ne _ _ hx] at h; exact g.tracked x k' h
      · by_cases hx : x = d
        · subst hx; simp
        · simp only [put_ne _ _ hx] at h ⊢; exact g.asleep_due x h
      · by_cases hx : x = d
        · subst hx; simp
        · simp only [put_ne _ _ hx] at h ⊢; exact g.asleep_reads x h
      · by_cases hx : x = d
        · subst hx; simp at h
        · simp only [put_ne _ _ hx] at h; exact g.reads_made x h

theorem Base.make {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) : Base cs (make cs s) := by
  -- grown: made one more, the new one awake, maybe its key's writer
  have g1 : Base cs (Model.grow cs s) := by
    have key : ∀ M : State K V, M.made = s.made + 1 → M.after = s.after → M.due = s.due →
        M.reads = s.reads → (∀ k w, M.writers k = some w → (cs w).writes k) → queue M = queue s →
        M.asleep = put s.asleep s.made false → Base cs M := by
      intro M e1 e2 e3 e4 e5 e6 e7
      refine ⟨fun x w h => ?_, fun x h => ?_, fun x h => ?_, by rw [e4]; exact g.tracked, e5,
        fun a h => ?_, fun x h => ?_, fun x h => ?_, fun x h => ?_⟩
      · rw [e2] at h; obtain ⟨h1, h2⟩ := g.after_due x w h; exact ⟨e3 ▸ h1, by omega⟩
      · have : aft M = aft s := by funext a b; simp [aft, e2]
        exact g.acyclic x (this ▸ h)
      · have := g.due_made x (e3 ▸ h); omega
      · rw [e6] at h; have := g.acts_made a h; omega
      · rw [e7] at h
        by_cases hx : x = s.made
        · subst hx; simp at h
        · simp [put_ne _ _ hx] at h; rw [e3]; exact g.asleep_due x h
      · rw [e7] at h
        by_cases hx : x = s.made
        · subst hx; simp at h
        · simp [put_ne _ _ hx] at h; rw [e4]; exact g.asleep_reads x h
      · rw [e4] at h; have := g.reads_made x h; omega
    simp only [Model.grow]
    split
    · rename_i k hk
      refine key _ rfl rfl rfl rfl ?_ rfl rfl
      intro k' w h
      by_cases e : k' = k
      · subst e; simp at h; subst h; exact Or.inr (Or.inl hk)
      · simp [put_ne _ _ e] at h; exact g.learned k' w h
    · exact key _ rfl rfl rfl rfl g.learned rfl rfl
  have hm1 : (Model.grow cs s).made = s.made + 1 := by simp only [Model.grow]; split <;> rfl
  have hz1 : (Model.grow cs s).asleep s.made = false := by simp only [Model.grow]; split <;> simp
  simp only [Model.make]
  split
  · refine ⟨g1.1, g1.2, g1.3, g1.4, g1.5, g1.6, fun x h => ?_, fun x h => ?_, g1.9⟩
    · by_cases hx : x = s.made
      · subst hx
        show (Model.grow cs s).due s.made = none
        cases e : (Model.grow cs s).due s.made with
        | none => rfl
        | some _ =>
          have ed : (Model.grow cs s).due = s.due := by simp only [Model.grow]; split <;> rfl
          rw [ed] at e; have := g.due_made s.made (by simp [e]); omega
      · simp only [put_ne _ _ hx] at h; exact g1.asleep_due x h
    · by_cases hx : x = s.made
      · subst hx
        show (Model.grow cs s).reads s.made = []
        cases e : (Model.grow cs s).reads s.made with
        | nil => rfl
        | cons _ _ =>
          have ed : (Model.grow cs s).reads = s.reads := by simp only [Model.grow]; split <;> rfl
          rw [ed] at e; have := g.reads_made s.made (by simp [e]); omega
      · simp only [put_ne _ _ hx] at h; exact g1.asleep_reads x h
  · obtain ⟨a, wr, m⟩ := mark_same (Model.grow cs s) s.made (Model.grow cs s).tick none
    have g2 : Base cs (mark (Model.grow cs s) s.made (Model.grow cs s).tick none) := by
      refine ⟨fun x w h => ?_, fun x h => ?_, fun x h => ?_, by rw [a.reads]; exact g1.tracked,
        by rw [wr]; exact g1.learned, by rw [show queue _ = queue (Model.grow cs s) by
          simp [queue, a.acts, a.earlies]]; rw [a.made]; exact g1.acts_made, fun x h => ?_,
        fun x h => ?_, by rw [a.reads, a.made]; exact g1.reads_made⟩
      · rw [a.after] at h
        obtain ⟨h1, h2⟩ := g1.after_due x w h
        exact ⟨m.isSome h1, a.made ▸ h2⟩
      · have : aft (mark (Model.grow cs s) s.made (Model.grow cs s).tick none) = aft (Model.grow cs s) := by
          funext a' b; simp [aft, a.after]
        exact g1.acyclic x (this ▸ h)
      · rw [a.made]
        rcases m.fresh x h with h | h
        · exact g1.due_made x h
        · subst h; rw [hm1]; omega
      · rw [a.asleep] at h
        have hx : x ≠ s.made := by intro e; subst e; rw [hz1] at h; cases h
        cases e : (mark (Model.grow cs s) s.made (Model.grow cs s).tick none).due x with
        | none => rfl
        | some _ =>
          rcases m.fresh x (by simp [e]) with h2 | h2
          · rw [g1.asleep_due x h] at h2; cases h2
          · exact absurd h2 hx
      · rw [a.asleep] at h; rw [a.reads]; exact g1.asleep_reads x h
    split
    · have hdue : ((mark (Model.grow cs s) s.made (Model.grow cs s).tick none).due s.made).isSome := by
        simp only [mark, settle, Option.isSome_none, Bool.and_false, Bool.false_eq_true, ite_false,
          Model.due]
        split
        · assumption
        · simp [say]
      obtain ⟨_, _, _, _, _, _, g3⟩ := first_base cs _ s.made 0 g2 hdue
      simp only [actnow]
      split
      · rename_i a' ha
        exact (act_base cs _ _ s.made a'.2 _ _ rfl g3 (fun x hx => by
          simp only [List.mem_append, List.mem_filter] at hx
          simp only [queue, List.mem_append]
          rcases hx with h | h
          · exact Or.inl h.1
          · exact Or.inr h)).2.2.2.2.2.2.2
      · exact g3
    · exact g2

-- a step, Quiet
theorem Base.step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (g : Base cs s) (hQ : Quiet cs) (h : step cs rank s = some s') : Base cs s' := by
  simp only [Model.step] at h
  split at h
  · split at h
    · rename_i c hc
      cases h
      have := (next_ready hc).1
      simp only [ready, Bool.and_eq_true] at this
      exact (first_base cs s c (rank s c) g this.1).2.2.2.2.2.2
    · cases h; exact ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩
  · split at h
    · rename_i a rest ha
      cases h
      exact (act_base cs s _ a.1 a.2 rest s.acts rfl g (fun x hx => by
        simp only [queue, ha, List.mem_append, List.mem_cons] at hx ⊢
        rcases hx with h | h
        · exact Or.inl (Or.inr h)
        · exact Or.inr h)).2.2.2.2.2.2.2
    · rename_i he
      split at h
      · rename_i a rest ha
        cases h
        exact (act_base cs s _ a.1 a.2 s.earlies rest rfl g (fun x hx => by
          simp only [queue, ha, List.mem_append, List.mem_cons] at hx ⊢
          rcases hx with h | h
          · exact Or.inl h
          · exact Or.inr (Or.inr h))).2.2.2.2.2.2.2
      · split at h
        · cases h; exact ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩
        · split at h
          · cases h
          · cases h; exact ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩
  · split at h
    · rename_i d rest _
      cases h
      exact Base.bury (s := { s with dying := rest }) ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩ hQ d
    · cases h; exact ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩

theorem Reach.base {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hQ : Quiet cs) (h : Reach cs rank s) : Base cs s := by
  induction h with
  | empty => exact Base.empty cs
  | make _ ih => exact ih.make
  | write kvs _ ih => exact ih.write kvs
  | tell keys _ ih => exact ih.tell keys
  | begin _ ih => exact ⟨ih.1, ih.2, ih.3, ih.4, ih.5, ih.6, ih.7, ih.8, ih.9⟩
  | step _ h ih => exact ih.step hQ h
  | close _ _ ih => exact ⟨ih.1, ih.2, ih.3, ih.4, ih.5, ih.6, ih.7, ih.8, ih.9⟩

-- Lemma N, writes in runs or not: next is total
theorem Base.short {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) {x : Nat}
    (hx : x < s.made) : (chain s (s.made + 1) x).length < s.made + 1 := by
  have hsub : (x :: chain s (s.made + 1) x) ⊆ List.range s.made := by
    intro y hy
    rcases List.mem_cons.1 hy with rfl | hy
    · exact List.mem_range.2 hx
    · exact List.mem_range.2 (chain_lt (fun a b h => (g.after_due a b h).2) _ _ _ hy)
  have := (chain_nodup g.acyclic (s.made + 1) x).length_le_of_subset hsub
  simp at this
  omega

theorem Base.walk {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) :
    ∀ f x, (s.due x).isSome → x < s.made → (chain s f x).length < f →
      ∃ y, ready s y = true ∧ y < s.made
  | 0, _, _, _, h => absurd h (Nat.not_lt_zero _)
  | f + 1, x, hd, hx, hl => by
    cases ha : s.after x with
    | none => exact ⟨x, by simp [ready, hd, ha], hx⟩
    | some z =>
      cases hz : s.due z with
      | none => exact ⟨x, by simp [ready, hd, ha, hz], hx⟩
      | some _ =>
        have hl' : (chain s f z).length < f := by
          simp only [chain, ha, List.length_cons] at hl; omega
        exact g.walk f z (by simp [hz]) (g.after_due x z ha).2 hl'

theorem Base.total {cs : Nat → Comp K V} {s : State K V} (g : Base cs s) (rank : State K V → Nat → Nat)
    {p : Nat} (hp : (s.due p).isSome) : (next rank s).isSome := by
  obtain ⟨y, hy, hym⟩ := g.walk _ p hp (g.due_made p hp) (g.short (g.due_made p hp))
  simp only [Model.next]
  exact pick_some _ _ none (Or.inr (List.ne_nil_of_mem (a := y) (by simp [hym, hy])))

-- the due sum when only new dues come: the afters as they were
theorem dues_grow {n : Nat} {a b : Nat → Nat} {s s' : State K V} (ha : s'.after = s.after)
    (hd : ∀ d m, s.due d = some m → s'.due d = some m) :
    dues n a b s' ≤ dues n a b s + tot n (newly n a b s s') := by
  rw [dues, dues, ← tot_add]
  apply tot_le
  intro d _
  have hw : waiting n s' d = waiting n s d := by simp [waiting, ha]
  unfold weight newly
  cases h : s.due d with
  | none =>
    by_cases h1 : (s'.due d).isSome
    · have : (n - waiting n s' d) * b d ≤ n * b d := Nat.mul_le_mul_right _ (by omega)
      simp [h1]; omega
    · simp [h1]
  | some m => simp [hd d m h, hw]

-- Theorem 1's weights, by height h among n: a due one, one height down, a queued act
def cost (n : Nat) : Nat → Nat
  | 0 => 4
  | h + 1 => 4 + 2 * (n + 1) * (n + 1) * cost n h

def under (n : Nat) : Nat → Nat
  | 0 => 0
  | h + 1 => cost n h

def owed (n h : Nat) : Nat := 3 + (n + 1) * (n + 1) * under n h

theorem cost_eq (n h : Nat) : cost n h = 4 + 2 * (n + 1) * (n + 1) * under n h := by
  cases h <;> simp [cost, under]

theorem cost_step (n h : Nat) : cost n h ≤ cost n (h + 1) := by
  simp only [cost]
  have : 1 ≤ 2 * (n + 1) * (n + 1) := by
    have := Nat.mul_le_mul (Nat.mul_le_mul (show 1 ≤ 2 by omega) (show 1 ≤ n + 1 by omega))
      (show 1 ≤ n + 1 by omega)
    simpa using this
  have := Nat.mul_le_mul_right (cost n h) this
  omega

theorem cost_mono (n : Nat) {h h' : Nat} (hh : h ≤ h') : cost n h ≤ cost n h' := by
  induction h' with
  | zero => have : h = 0 := by omega
            subst this; exact Nat.le_refl _
  | succ h' ih =>
    by_cases e : h = h' + 1
    · subst e; exact Nat.le_refl _
    · exact Nat.le_trans (ih (by omega)) (cost_step n h')

-- one height down
theorem cost_lt (n : Nat) {h h' : Nat} (hh : h < h') : cost n h ≤ under n h' := by
  cases h' with
  | zero => omega
  | succ h' => exact cost_mono n (by omega)

theorem under_le (n h : Nat) : under n h ≤ cost n h := by
  cases h with
  | zero => simp [under]
  | succ h => exact cost_step n h

theorem under_lt (n : Nat) {h h' : Nat} (hh : h < h') : under n h ≤ under n h' :=
  Nat.le_trans (under_le n h) (cost_lt n hh)

-- the phase: a run phase, or an act phase with something due, has a step of its own left (the
-- going phase is counted apart: idle)
def stage (s : State K V) : Nat :=
  match s.phase with
  | .runs => 1
  | .acts => if (List.range s.made).any fun p => (s.due p).isSome then 2 else 0
  | .goes => 0

-- Theorem 1's measure: the due sum by heights, the queued acts, the phase
noncomputable def measure (cs : Nat → Comp K V) (n : Nat) (s : State K V) : Nat :=
  dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
    ((queue s).map fun a => owed n (height cs n a.1)).sum + stage s

-- what new dues fed by c weigh, at most
theorem fresh_feeds {cs : Nat → Comp K V} {n c : Nat} {s s' : State K V}
    (hac : ∀ x, ¬TransGen (among n (feeds cs)) x x) (hcn : c < n)
    (hF : ∀ d, d < n → (s'.due d).isSome → s.due d = none → feeds cs c d) :
    tot n (newly n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s s') ≤
      n * ((n + 1) * under n (height cs n c)) := by
  refine fresh_le (fun d => d < n ∧ feeds cs c d) (fun d hd h1 h2 => ⟨hd, hF d hd h1 h2⟩) ?_
  rintro d _ ⟨hd, hf⟩
  have hl := height_lt hac hf hcn hd
  have h1 := cost_lt n hl
  have h2 := under_lt n hl
  have : n * under n (height cs n d) ≤ n * under n (height cs n c) := Nat.mul_le_mul_left _ h2
  rw [Nat.succ_mul]; omega

-- the asleep among the first n: a wake spends one, nothing in a run or an act puts one to sleep
def sleepers (n : Nat) (s : State K V) : Nat := tot n fun c => if s.asleep c then 1 else 0

theorem tot_lt {n : Nat} {f g : Nat → Nat} (h : ∀ d, d < n → f d ≤ g d) {c : Nat} (hc : c < n)
    (hlt : f c < g c) : tot n f < tot n g := by
  induction n with
  | zero => omega
  | succ n ih =>
    simp only [tot]
    by_cases e : c = n
    · subst e
      have := tot_le (n := c) (fun d hd => h d (by omega))
      omega
    · have := ih (fun d hd => h d (by omega)) (by omega)
      have := h n (by omega)
      omega

theorem sleepers_le {n : Nat} {s s' : State K V} (h : ∀ d, s'.asleep d = true → s.asleep d = true) :
    sleepers n s' ≤ sleepers n s := by
  apply tot_le
  intro d _
  cases e : s'.asleep d
  · simp
  · simp [h d e]

-- none less: as asleep as before
theorem sleepers_eq {n : Nat} {s s' : State K V} (h : ∀ d, s'.asleep d = true → s.asleep d = true)
    (he : ¬ sleepers n s' < sleepers n s) : ∀ d, d < n → s'.asleep d = s.asleep d := by
  intro d hd
  cases e : s'.asleep d
  · cases e2 : s.asleep d
    · rfl
    · exfalso; apply he
      refine tot_lt (fun x _ => ?_) hd (by simp [e, e2])
      cases e3 : s'.asleep x
      · simp
      · simp [h x e3]
  · exact (h d e).symm

-- idle: nothing due, nothing queued, at the acts' end or going. what is left is the goings
def idle (s : State K V) : Prop :=
  (∀ d, s.due d = none) ∧ queue s = [] ∧ (s.phase = .acts ∨ s.phase = .goes)

-- the goings' measure: the reads (a going lets go of its own), the dying, the phase
def rsum (n : Nat) (s : State K V) : Nat := tot n fun c => (s.reads c).length

def gm (n : Nat) (s : State K V) : Nat :=
  3 * rsum n s + 2 * s.dying.length + (if s.phase = .acts ∧ s.dying ≠ [] then 1 else 0) +
    (if s.phase = .goes ∧ s.dying = [] then 1 else 0)

theorem untrack_len (cs : Nat → Comp K V) : ∀ (ks : List K) (s : State K V),
    (untrack cs s ks).dying.length ≤ s.dying.length + ks.length
  | [], s => by simp [untrack]
  | k :: ks, s => by
    simp only [untrack, List.foldl_cons]
    have h1 := untrack_len cs ks (untrack1 cs s k)
    simp only [untrack] at h1
    have h2 : (untrack1 cs s k).dying.length ≤ s.dying.length + 1 := by
      unfold untrack1
      split
      · omega
      · split
        · split <;> simp
        · omega
    simp only [List.length_cons]; omega

-- an idle step (Quiet): still idle, the goings' measure falls
theorem idle_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hQ : Quiet cs) (g : Base cs s) (hi : idle s) (h : step cs rank s = some s') :
    idle s' ∧ gm s.made s' < gm s.made s ∧ s'.made = s.made := by
  obtain ⟨hd, hq, hph⟩ := hi
  have he : s.earlies = [] := by simp [queue] at hq; exact hq.1
  have ha : s.acts = [] := by simp [queue] at hq; exact hq.2
  simp only [Model.step] at h
  rcases hph with hph | hph
  · rw [hph] at h
    simp only [he, ha] at h
    have hny : ((List.range s.made).any fun p => (s.due p).isSome) = false := by
      rw [List.any_eq_false]; intro p _; simp [hd p]
    simp only [hny, Bool.false_eq_true, ite_false] at h
    split at h
    · cases h
    · rename_i hdy
      cases h
      have hdy' : s.dying ≠ [] := by intro e; simp [e] at hdy
      refine ⟨⟨hd, by simp [queue, he, ha], Or.inr rfl⟩, ?_, rfl⟩
      simp [gm, rsum, hph, hdy']
  · rw [hph] at h
    simp only at h
    split at h
    · rename_i d rest hdr
      cases h
      -- the going of d, from s with d out of the dying
      have key : ∀ T : State K V, T = { s with dying := rest } → idle (bury cs T d) ∧
          gm s.made (bury cs T d) < gm s.made s ∧ (bury cs T d).made = s.made := by
        intro T hT
        have hT1 : idle T ∧ gm s.made T < gm s.made s ∧ T.made = s.made := by
          subst hT
          refine ⟨⟨hd, by simp [queue, he, ha], Or.inr hph⟩, ?_, rfl⟩
          simp only [gm, hph, hdr, rsum, List.length_cons]
          simp
          split <;> omega
        unfold Model.bury
        cases hk : (cs d).key with
        | none => exact hT1
        | some k =>
          simp only
          split
          · exact hT1
          · rw [hQ d]
            simp only [List.foldl_nil]
            subst hT
            generalize hX : ({ ({ s with dying := rest } : State K V) with
              due := put s.due d none, asleep := put s.asleep d true, reads := put s.reads d [],
              values := put s.values d [], after := put s.after d none, last := put s.last d none,
              kept := put s.kept d [], loop := put s.loop d none, looping := put s.looping d false,
              ran := put s.ran d none, cut := put s.cut d false, store := put s.store k none } : State K V) = X
            obtain ⟨dy, hU⟩ := untrack_shape cs (s.reads d) X
            have hlen := untrack_len cs (s.reads d) X
            rw [hU] at hlen ⊢
            have hXd : X.dying = rest := by rw [← hX]
            have hXph : X.phase = .goes := by rw [← hX]; exact hph
            refine ⟨⟨fun x => ?_, by rw [← hX]; simp [queue, he, ha], Or.inr hXph⟩, ?_, by rw [← hX]⟩
            · rw [← hX]; by_cases hx : x = d
              · subst hx; simp
              · simp [put_ne _ _ hx, hd x]
            · -- the reads fall by d's, the dying grow by at most as many
              have hr : rsum s.made X + (s.reads d).length = rsum s.made s := by
                unfold rsum
                by_cases hdm : d < s.made
                · rw [← tot_one (n := s.made) (s.reads d).length hdm, ← tot_add]
                  apply tot_cong; intro x _
                  rw [← hX]; by_cases hx : x = d
                  · subst hx; simp
                  · simp [put_ne _ _ hx, hx]
                · have h0 : s.reads d = [] := by
                    cases e : s.reads d with
                    | nil => rfl
                    | cons _ _ => exact absurd (g.reads_made d (by simp [e])) hdm
                  rw [h0]; simp only [List.length_nil, Nat.add_zero]
                  apply tot_cong; intro x hx
                  rw [← hX]; have : x ≠ d := by omega
                  simp [put_ne _ _ this]
              have h5 : gm s.made { X with dying := dy } ≤ 3 * rsum s.made X + 2 * dy.length + 1 := by
                simp only [gm, hXph, rsum]
                simp
                split <;> omega
              have h3 : gm s.made s = 3 * rsum s.made s + 2 * (rest.length + 1) := by
                simp [gm, hph, hdr]
              simp only [hXd] at hlen
              omega
      exact key _ (by simp only [hph])
    · cases h
      refine ⟨⟨hd, by simp [queue, he, ha], Or.inl rfl⟩, ?_, rfl⟩
      rename_i hdr
      simp [gm, rsum, hph, hdr]

-- a queue's sum, its head out: what the head weighs less
theorem qsum_filter (f : Nat → Nat) (l : List (Nat × V)) (c : Nat) :
    ((l.filter (fun a => a.1 ≠ c)).map fun a => f a.1).sum ≤ (l.map fun a => f a.1).sum :=
  sum_filter _ _ l

-- Theorem 1, a step that is not idle (the goings apart): what is asleep only wakes, and unless the
-- step ends idle or wakes one, the measure falls (H acyclic)
theorem measure_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    {n : Nat} (hn : s.made = n)
    (hac : ∀ x, ¬TransGen (among n (feeds cs)) x x) (g : Base cs s)
    (hph : s.phase ≠ .goes) (hni : ¬ idle s) (h : step cs rank s = some s') :
    s'.made = n ∧ sleepers n s' ≤ sleepers n s ∧
    (idle s' ∨ sleepers n s' < sleepers n s ∨ measure cs n s' < measure cs n s) := by
  simp only [Model.step] at h
  split at h
  · rename_i hph'
    split at h
    · rename_i c hc
      cases h
      obtain ⟨hrd, hcn⟩ := next_ready hc
      simp only [ready, Bool.and_eq_true] at hrd
      have hcd := hrd.1
      have hr : ∀ w, s.after c = some w → s.due w = none := by
        intro w hw; have := hrd.2; simp [hw] at this; exact this
      have hcc : s.after c ≠ some c := by
        intro e; have := hr c e; simp [this] at hcd
      obtain ⟨b1, b2, b3, b4, b5, b6, b7⟩ := first_base cs s c (rank s c) g hcd
      rw [hn] at hcn
      have hsl : sleepers n (first cs s c (rank s c)) ≤ sleepers n s := sleepers_le b6
      refine ⟨b1.trans hn, hsl, ?_⟩
      by_cases hlt : sleepers n (first cs s c (rank s c)) < sleepers n s
      · exact Or.inr (Or.inl hlt)
      right; right
      have heq := sleepers_eq b6 hlt
      -- no wake: what became due is fed by c
      have nofresh : ∀ d, ((first cs s c (rank s c)).due d).isSome → s.due d = none →
          d < s.made → s.asleep d = true → False := by
        intro d h1 h2 hdm hs
        have : (first cs s c (rank s c)).asleep d = true := by rw [heq d (hn ▸ hdm)]; exact hs
        rw [b7.asleep_due d this] at h1; cases h1
      have hst : stage (first cs s c (rank s c)) = stage s := by simp [stage, b2, hph']
      have hacts : ((queue (first cs s c (rank s c))).map fun a => owed n (height cs n a.1)).sum ≤
          ((queue s).map fun a => owed n (height cs n a.1)).sum + owed n (height cs n c) := by
        have h1 := b5.1 (fun x => owed n (height cs n x))
        have h2 : queue (start s c (rank s c)) = (queue s).filter (fun a => a.1 ≠ c) := by
          simp [start, say, queue, List.filter_append]
        rw [h2] at h1
        have := qsum_filter (fun x => owed n (height cs n x)) (queue s) c
        omega
      have hce := cost_eq n (height cs n c)
      have e1 : measure cs n (first cs s c (rank s c)) =
          dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d))
            (first cs s c (rank s c)) +
          ((queue (first cs s c (rank s c))).map fun a => owed n (height cs n a.1)).sum + stage s := by
        unfold measure; rw [hst]
      have e2 : measure cs n s =
          dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
          ((queue s).map fun a => owed n (height cs n a.1)).sum + stage s := rfl
      have e3 : owed n (height cs n c) = 3 + (n + 1) * (n + 1) * under n (height cs n c) := rfl
      rw [e1, e2]
      have hsq : n * ((n + 1) * under n (height cs n c)) ≤
          (n + 1) * (n + 1) * under n (height cs n c) := by
        rw [← Nat.mul_assoc]; exact Nat.mul_le_mul_right _ (Nat.mul_le_mul_right _ (by omega))
      have hq : 2 * (n + 1) * (n + 1) * under n (height cs n c) =
          (n + 1) * (n + 1) * under n (height cs n c) + (n + 1) * (n + 1) * under n (height cs n c) := by
        rw [Nat.mul_assoc 2, Nat.mul_assoc 2, Nat.two_mul, Nat.mul_assoc]
      rcases b4 with ⟨ha, hd⟩ | ⟨w, ha, hwc, hwm, hw', hc', hf, _, hd⟩
      · have hd' : ∀ d, ((first cs s c (rank s c)).due d).isSome → d ≠ c ∧
            ((s.due d).isSome ∨ s.due d = none) := by
          intro d h
          rcases hd d h with ⟨h1, _⟩ | ⟨_, h1⟩
          · exact ⟨h1, by cases s.due d <;> simp⟩
          · refine ⟨fun e => ?_, by cases s.due d <;> simp⟩
            subst e
            rcases h1 with h1 | h1
            · exact hac _ (.single ⟨hcn, hcn, h1⟩)
            · rw [g.asleep_due d h1] at hcd; cases hcd
        have k1 := dues_go (a := fun d => cost n (height cs n d)) (b := fun d => under n (height cs n d))
          hcn hcd hr ha hd'
        have k2 := fresh_feeds (n := n) (c := c) (s := s) (s' := first cs s c (rank s c)) hac hcn
          (fun d hdn h1 h2 => by
            rcases hd d h1 with ⟨_, h⟩ | ⟨hdm, h⟩
            · simp [h2] at h
            · rcases h with h | h
              · exact h
              · exact (nofresh d h1 h2 hdm h).elim)
        omega
      · have hwd : (s.due w).isSome := by
          rcases hd w hw' with h | h | ⟨hwm', h⟩
          · exact absurd h hwc
          · exact h
          · rcases h with h | h
            · exact absurd (TransGen.trans (.single ⟨hcn, hn ▸ hwm, h⟩) (.single ⟨hn ▸ hwm, hcn, hf⟩)) (hac c)
            · exfalso
              cases e : s.due w with
              | none => exact nofresh w hw' e hwm' h
              | some _ => rw [g.asleep_due w h] at e; cases e
        have k1 := dues_stop (a := fun d => cost n (height cs n d)) (b := fun d => under n (height cs n d))
          hcn hcd hr hcc hwc (hn ▸ hwm) hwd ha
        have k2 := fresh_feeds (n := n) (c := c) (s := s) (s' := first cs s c (rank s c)) hac hcn
          (fun d hdn h1 h2 => by
            rcases hd d h1 with rfl | h | ⟨hdm, h⟩
            · simp [h2] at hcd
            · simp [h2] at h
            · rcases h with h | h
              · exact h
              · exact (nofresh d h1 h2 hdm h).elim)
        have k3 : cost n (height cs n c) ≤ under n (height cs n w) :=
          cost_lt n (height_lt hac hf (hn ▸ hwm) hcn)
        omega
    · rename_i hnx
      cases h
      have hnd : ∀ p, p < s.made → (s.due p).isSome = false := by
        intro p _
        cases e : (s.due p).isSome
        · rfl
        · have := g.total rank e
          rw [hnx] at this; cases this
      refine ⟨hn, Nat.le_refl _, ?_⟩
      by_cases hq : queue s = []
      · left
        refine ⟨fun d => ?_, hq, Or.inl rfl⟩
        cases e : s.due d with
        | none => rfl
        | some _ =>
          have := hnd d (g.due_made d (by simp [e])); simp [e] at this
      right; right
      have : stage { s with phase := .acts } = 0 := by
        simp only [stage]
        have : ((List.range s.made).any fun p => (s.due p).isSome) = false := by
          rw [List.any_eq_false]; intro p hp; simp [hnd p (List.mem_range.1 hp)]
        simp [this]
      show dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
          ((queue s).map fun a => owed n (height cs n a.1)).sum + stage { s with phase := .acts } <
        dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
          ((queue s).map fun a => owed n (height cs n a.1)).sum + stage s
      rw [this, show stage s = 1 by simp [stage, hph']]
      omega
  · rename_i hph'
    -- an act: the early queue's head, or the other's with the early empty
    have actstep : ∀ (a : Nat × V) (es as : List (Nat × V)),
        (∀ x ∈ es ++ as, x ∈ queue s) →
        ((queue s).map fun x => owed n (height cs n x.1)).sum =
          owed n (height cs n a.1) + ((es ++ as).map fun x => owed n (height cs n x.1)).sum →
        a ∈ queue s →
        (act cs { s with earlies := es, acts := as } a.1 a.2).made = n ∧
          sleepers n (act cs { s with earlies := es, acts := as } a.1 a.2) ≤ sleepers n s ∧
          (idle (act cs { s with earlies := es, acts := as } a.1 a.2) ∨
            sleepers n (act cs { s with earlies := es, acts := as } a.1 a.2) < sleepers n s ∨
            measure cs n (act cs { s with earlies := es, acts := as } a.1 a.2) < measure cs n s) := by
      intro a es as hrest hsum hain
      obtain ⟨b1, b2, b3, b4, b5, m, bz, _⟩ := act_base cs s _ a.1 a.2 es as rfl g hrest
      have han : a.1 < n := hn ▸ g.acts_made a hain
      refine ⟨b1.trans hn, by rw [sleepers, sleepers, bz]; exact Nat.le_refl _, Or.inr (Or.inr ?_)⟩
      have k1 := dues_grow (n := n) (a := fun d => cost n (height cs n d))
        (b := fun d => under n (height cs n d)) b3 m.due
      have k2 := fresh_feeds (n := n) (c := a.1) (s := s)
        (s' := act cs { s with earlies := es, acts := as } a.1 a.2) hac han
        (fun d _ h1 h2 => by
          rcases m.fresh d h1 with h | h
          · simp [h2] at h
          · exact h.2)
      have hst : stage (act cs { s with earlies := es, acts := as } a.1 a.2) ≤ 2 := by
        unfold stage; rw [b2, hph']
        dsimp only
        split
        · exact Nat.le_refl _
        · exact Nat.zero_le _
      have hsq : n * ((n + 1) * under n (height cs n a.1)) ≤
          (n + 1) * (n + 1) * under n (height cs n a.1) := by
        rw [← Nat.mul_assoc]; exact Nat.mul_le_mul_right _ (Nat.mul_le_mul_right _ (by omega))
      have e1 : measure cs n (act cs { s with earlies := es, acts := as } a.1 a.2) =
          dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d))
            (act cs { s with earlies := es, acts := as } a.1 a.2) +
          ((es ++ as).map fun a => owed n (height cs n a.1)).sum +
          stage (act cs { s with earlies := es, acts := as } a.1 a.2) := by
        unfold measure; rw [queue, b4, b5]
      have e2 : measure cs n s =
          dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
          (owed n (height cs n a.1) + ((es ++ as).map fun a => owed n (height cs n a.1)).sum) +
            stage s := by
        unfold measure; rw [hsum]
      have e3 : owed n (height cs n a.1) = 3 + (n + 1) * (n + 1) * under n (height cs n a.1) := rfl
      rw [e1, e2]
      omega
    split at h
    · rename_i a rest ha
      cases h
      exact actstep a rest s.acts
        (fun x hx => by
          simp only [queue, ha, List.mem_append, List.mem_cons] at hx ⊢
          rcases hx with h | h
          · exact Or.inl (Or.inr h)
          · exact Or.inr h)
        (by simp [queue, ha, List.map_append, List.sum_append]) (by simp [queue, ha])
    · rename_i he
      split at h
      · rename_i a rest ha
        cases h
        have he' : s.earlies = [] := he
        exact actstep a s.earlies rest
          (fun x hx => by
            simp only [queue, ha, List.mem_append, List.mem_cons] at hx ⊢
            rcases hx with h | h
            · exact Or.inl h
            · exact Or.inr (Or.inr h))
          (by simp [queue, ha, he']) (by simp [queue, ha])
      · split at h
        · rename_i hany
          cases h
          refine ⟨hn, Nat.le_refl _, Or.inr (Or.inr ?_)⟩
          have : stage s = 2 := by simp [stage, hph', hany]
          show dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
              ((queue s).map fun a => owed n (height cs n a.1)).sum +
              stage { s with phase := .runs, round := s.round + 1 } <
            dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) s +
              ((queue s).map fun a => owed n (height cs n a.1)).sum + stage s
          rw [this, show stage { s with phase := .runs, round := s.round + 1 } = 1 by simp [stage]]
          omega
        · rename_i ha2 hany
          exfalso; apply hni
          have he' : s.earlies = [] := he
          have ha' : s.acts = [] := ha2
          refine ⟨fun d => ?_, by simp [queue, he', ha'], Or.inl hph'⟩
          cases e : s.due d with
          | none => rfl
          | some _ =>
            have hdm := g.due_made d (by simp [e])
            simp only [Bool.not_eq_true] at hany
            rw [List.any_eq_false] at hany
            have := hany d (List.mem_range.2 hdm); simp [e] at this
  · rename_i hph'; exact absurd hph' hph

-- more fuel: the same end
theorem steps_more {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} :
    ∀ (f k : Nat) (s : State K V), (steps cs rank f s).isSome → (steps cs rank (f + k) s).isSome
  | 0, _, _, h => by simp [steps] at h
  | f + 1, k, s, h => by
    rw [show f + 1 + k = (f + k) + 1 by omega]
    simp only [steps] at h ⊢
    split
    · rename_i s' h1
      rw [h1] at h; exact steps_more f k s' h
    · rfl

-- the goings end: an idle state's steps, within its goings' measure
theorem idle_end {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} (hQ : Quiet cs) :
    ∀ (f : Nat) (s : State K V), Base cs s → idle s → gm s.made s < f → (steps cs rank f s).isSome
  | 0, _, _, _, h => absurd h (Nat.not_lt_zero _)
  | f + 1, s, g, hi, hf => by
    simp only [steps]
    split
    · rename_i s' h
      obtain ⟨h1, h2, h3⟩ := idle_step hQ g hi h
      exact idle_end hQ f s' (g.step hQ h) h1 (by rw [h3]; omega)
    · rfl

-- the going phase comes only from an idle acts phase, and stays idle (Quiet)
theorem step_goes {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hQ : Quiet cs) (g : Base cs s) (hP : s.phase = .goes → idle s) (h : step cs rank s = some s') :
    s'.phase = .goes → idle s' := by
  by_cases hi : idle s
  · intro _; exact (idle_step hQ g hi h).1
  have hph : s.phase ≠ .goes := fun e => hi (hP e)
  intro e
  simp only [Model.step] at h
  split at h
  · rename_i hph'
    split at h
    · rename_i c hc
      cases h
      have := (next_ready hc).1
      simp only [ready, Bool.and_eq_true] at this
      rw [(first_base cs s c _ g this.1).2.1, hph'] at e; cases e
    · cases h; simp at e
  · rename_i hph'
    split at h
    · rename_i a rest ha
      cases h
      rw [(act_base cs s _ a.1 a.2 rest s.acts rfl g (fun x hx => by
        simp only [queue, ha, List.mem_append, List.mem_cons] at hx ⊢
        rcases hx with h | h
        · exact Or.inl (Or.inr h)
        · exact Or.inr h)).2.1, hph'] at e; cases e
    · rename_i he
      split at h
      · rename_i a rest ha
        cases h
        rw [(act_base cs s _ a.1 a.2 s.earlies rest rfl g (fun x hx => by
          simp only [queue, ha, List.mem_append, List.mem_cons] at hx ⊢
          rcases hx with h | h
          · exact Or.inl h
          · exact Or.inr (Or.inr h))).2.1, hph'] at e; cases e
      · rename_i ha2
        split at h
        · cases h; simp at e
        · rename_i hany
          split at h
          · cases h
          · cases h
            refine ⟨fun d => ?_, by simp [queue, he, ha2], Or.inr rfl⟩
            cases ed : s.due d with
            | none => rfl
            | some _ =>
              have hdm := g.due_made d (by simp [ed])
              simp only [Bool.not_eq_true] at hany
              rw [List.any_eq_false] at hany
              have := hany d (List.mem_range.2 hdm); simp [ed] at this
  · rename_i hph'; exact absurd hph' hph

-- Theorem 1 (proof.md §3), the pulse: from a state the pulse can be in (the going phase only
-- idle), with H acyclic and Quiet, the steps end: by the asleep left (a wake spends one), then
-- the measure, then the goings
theorem steps_end {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} (hQ : Quiet cs) (n : Nat)
    (hac : ∀ x, ¬TransGen (among n (feeds cs)) x x) :
    ∀ (w m : Nat) (s : State K V), Base cs s → (s.phase = .goes → idle s) → s.made = n →
      sleepers n s ≤ w → measure cs n s ≤ m → ∃ f, (steps cs rank f s).isSome := by
  intro w
  induction w using Nat.strongRecOn with
  | ind w ihw =>
    intro m
    induction m using Nat.strongRecOn with
    | ind m ihm =>
      intro s g hP hn hw hm
      by_cases hi : idle s
      · exact ⟨gm s.made s + 1, idle_end hQ _ s g hi (by omega)⟩
      have hph : s.phase ≠ .goes := fun e => hi (hP e)
      cases h : step cs rank s with
      | none => exact ⟨1, by simp [steps, h]⟩
      | some s' =>
        obtain ⟨h1, h2, h3⟩ := measure_step hn hac g hph hi h
        have g' := g.step hQ h
        have hP' := step_goes hQ g hP h
        rcases h3 with h3 | h3 | h3
        · obtain ⟨f, hf⟩ : ∃ f, (steps cs rank f s').isSome :=
            ⟨_, idle_end hQ _ s' g' h3 (Nat.lt_succ_self _)⟩
          exact ⟨f + 1, by simp only [steps, h]; exact hf⟩
        · obtain ⟨f, hf⟩ := ihw (sleepers n s') (by omega) _ s' g' hP' h1 (Nat.le_refl _)
            (Nat.le_refl _)
          exact ⟨f + 1, by simp only [steps, h]; exact hf⟩
        · obtain ⟨f, hf⟩ := ihm (measure cs n s') (by omega) s' g' hP' h1 (by omega) (Nat.le_refl _)
          exact ⟨f + 1, by simp only [steps, h]; exact hf⟩

-- Theorem 1: when H is acyclic and no going writes (Quiet), every pulse from a reachable state
-- ends. a pulse with attended computes whose goings write can loop for ever (Model.Check, endless)
theorem termination {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hQ : Quiet cs) (hac : ∀ x, ¬TransGen (among s.made (feeds cs)) x x) (h : Reach cs rank s) :
    ∃ f, (pulse cs rank f s).isSome := by
  have g := h.base hQ
  exact steps_end hQ s.made hac _ _ (begin s) ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩
    (fun e => by simp [begin] at e) rfl (Nat.le_refl _) (Nat.le_refl _)

-- the bound: n made, a acts queued at the start. cost n n is about 4 (2 (n + 1)²)^n
def bound (n a : Nat) : Nat := n * ((n + 1) * cost n n) + a * owed n n + 2

theorem under_mono (n : Nat) {h h' : Nat} (hh : h ≤ h') : under n h ≤ under n h' := by
  cases h with
  | zero => simp [under]
  | succ h =>
    cases h' with
    | zero => omega
    | succ h' => exact cost_mono n (by omega)

theorem measure_le (cs : Nat → Comp K V) (s : State K V) :
    measure cs s.made (begin s) < bound s.made (queue s).length := by
  generalize hn : s.made = n
  have h1 : dues n (fun d => cost n (height cs n d)) (fun d => under n (height cs n d)) (begin s) ≤
      n * ((n + 1) * cost n n) := by
    apply tot_const
    intro d _
    unfold weight
    dsimp only
    split
    · have a1 := cost_mono n (height_le cs n d)
      have a2 := under_mono n (height_le cs n d)
      have a3 := under_le n n
      have : (n - waiting n (begin s) d) * under n (height cs n d) ≤ n * cost n n :=
        Nat.mul_le_mul (by omega) (by omega)
      rw [Nat.succ_mul]; omega
    · exact Nat.zero_le _
  have h2 : ((queue (begin s)).map fun a => owed n (height cs n a.1)).sum ≤
      (queue s).length * owed n n := by
    show ((queue s).map fun a => owed n (height cs n a.1)).sum ≤ (queue s).length * owed n n
    have : ∀ l : List (Nat × V), (l.map fun a => owed n (height cs n a.1)).sum ≤ l.length * owed n n := by
      intro l
      induction l with
      | nil => simp
      | cons a l ih =>
        simp only [List.map_cons, List.sum_cons, List.length_cons, Nat.succ_mul]
        have : owed n (height cs n a.1) ≤ owed n n := by
          unfold owed; have := under_mono n (height_le cs n a.1)
          have := Nat.mul_le_mul_left ((n + 1) * (n + 1)) this
          omega
        omega
    exact this (queue s)
  have h3 : stage (begin s) = 1 := rfl
  unfold measure bound
  omega

-- Theorem 1′: cycles, A2 (proof.md §7.2)

-- the computations behind a cause, its own first
def anc (k : Why) : List Nat := (behind k).map (·.of.1)

theorem back_plain (t : Nat) : ∀ (k : Why), (plain k).back t = true ↔ t ∈ anc k
  | .mk o ps => by
    have ih : ∀ p ∈ ps, ((plain p).back t = true ↔ t ∈ anc p) := fun p hp => back_plain t p
    simp only [plain, Cause.back, anc, behind, Bool.or_eq_true, beq_iff_eq, List.any_eq_true,
      List.map_cons, List.mem_cons, List.map_flatten, List.mem_flatten, List.mem_map]
    constructor
    · rintro (h | ⟨⟨x, hx⟩, _, hb⟩)
      · exact Or.inl (by simp [Cause.of, h])
      · right
        obtain ⟨⟨p, hp⟩, _, rfl⟩ := List.mem_map.1 hx
        exact ⟨_, ⟨_, ⟨⟨p, hp⟩, List.mem_attach _ _, rfl⟩, rfl⟩, (ih p hp).1 hb⟩
    · rintro (h | ⟨l, ⟨a, ⟨⟨p, hp⟩, _, rfl⟩, rfl⟩, ht⟩)
      · exact Or.inl (by simp [Cause.of] at h; exact h.symm)
      · right
        exact ⟨⟨plain p, List.mem_map.2 ⟨⟨p, hp⟩, List.mem_attach _ _, rfl⟩⟩, List.mem_attach _ _,
          (ih p hp).2 ht⟩

-- on (causes.ts loop's walk) is being behind
theorem on_iff (t : Nat) (k : Why) : on t k = true ↔ t ∈ anc k := back_plain t k

theorem anc_self (o : Nat × Nat) (ps : List Why) : o.1 ∈ anc (.mk o ps) := by
  simp [anc, behind, Cause.of]

theorem anc_parent {o : Nat × Nat} {ps : List Why} {p : Why} (hp : p ∈ ps) {y : Nat}
    (hy : y ∈ anc p) : y ∈ anc (.mk o ps) := by
  simp only [anc, behind, List.map_cons, List.mem_cons, List.map_flatten, List.mem_flatten,
    List.mem_map] at hy ⊢
  right
  exact ⟨_, ⟨_, ⟨⟨p, hp⟩, List.mem_attach _ _, rfl⟩, rfl⟩, List.mem_map.2 hy⟩

theorem anc_root (k : Why) : k.of.1 ∈ anc k := by
  cases k with
  | mk o ps => exact anc_self o ps

-- y ran this pulse and is behind one of xs: a mark on y from them is a loop
def inside (went : Nat → Bool) (xs : List Why) (y : Nat) : Bool :=
  went y && xs.any fun x => decide (y ∈ anc x)

-- the room a cause leaves: how many of the first n a mark from it would find free
def room (n : Nat) (went : Nat → Bool) (xs : List Why) : Nat :=
  tot n fun y => if inside went xs y then 0 else 1

-- a due z's level: the room z's next run leaves, its causes those kept
def level (n : Nat) (s : State K V) (z : Nat) : Nat :=
  tot n fun y => if y = z ∨ inside s.went (s.kept z) y then 0 else 1

-- a queued act's level: the room the cause it marks with leaves (causeOf)
def later (n : Nat) (s : State K V) (e : Nat) : Nat :=
  if s.when e = s.pulses then room n s.went [s.cause e]
  else room n (put s.went e true) [.mk (e, ((s.ran e).map (·.n)).getD 0) []]

theorem later_eq (n : Nat) (s : State K V) (e : Nat) :
    later n s e = room n (causeof s e).1.went [(causeof s e).2] := by
  unfold later causeof
  split <;> rfl

-- the weights: a due unflagged one at level j may run free and mark n others one level down
def worth (n : Nat) : Nat → Nat
  | 0 => 2
  | j + 1 => 2 + n * worth n j

def deed (n : Nat) : Nat → Nat
  | 0 => 1
  | j + 1 => 1 + n * worth n j

theorem worth_deed (n j : Nat) : worth n j = deed n j + 1 := by
  cases j with
  | zero => rfl
  | succ j => simp only [worth, deed]; omega

theorem worth_step (n j : Nat) : worth n j ≤ worth n (j + 1) := by
  induction j with
  | zero => show 2 ≤ 2 + n * 2; omega
  | succ j ih =>
    show 2 + n * worth n j ≤ 2 + n * worth n (j + 1)
    exact Nat.add_le_add_left (Nat.mul_le_mul_left _ ih) _

theorem worth_mono (n : Nat) {j j' : Nat} (h : j ≤ j') : worth n j ≤ worth n j' := by
  induction j' with
  | zero => have : j = 0 := by omega
            subst this; exact Nat.le_refl _
  | succ j' ih =>
    by_cases e : j = j' + 1
    · subst e; exact Nat.le_refl _
    · exact Nat.le_trans (ih (by omega)) (worth_step n j')

theorem deed_mono (n : Nat) {j j' : Nat} (h : j ≤ j') : deed n j ≤ deed n j' := by
  have a := worth_deed n j; have b := worth_deed n j'; have := worth_mono n h; omega

-- a due computation's term: unflagged, its worth at its level
def term (n : Nat) (s : State K V) (z : Nat) : Nat :=
  if (s.due z).isSome && (s.loop z).isNone then worth n (level n s z) else 0

-- Ψ: what free runs may still come: the due unflagged ones, and the queued acts
def budget (n : Nat) (s : State K V) : Nat :=
  tot n (term n s) + ((queue s).map fun a => deed n (later n s a.1)).sum

-- the most a free mark from a cause at level j weighs
def top (n j : Nat) : Nat := if j = 0 then 0 else worth n (j - 1)

theorem top_le {n i j : Nat} (h : i + 1 ≤ j) : worth n i ≤ top n j := by
  unfold top
  split
  · omega
  · exact worth_mono n (by omega)

-- monotone: more ran, more kept, less room
theorem room_mono {n : Nat} {w w' : Nat → Bool} {xs xs' : List Why}
    (hw : ∀ y, w y = true → w' y = true) (hx : ∀ x ∈ xs, x ∈ xs') : room n w' xs' ≤ room n w xs := by
  apply tot_le
  intro y _
  by_cases h : inside w xs y
  · have : inside w' xs' y = true := by
      simp only [inside, Bool.and_eq_true, List.any_eq_true, decide_eq_true_eq] at h ⊢
      obtain ⟨h1, x, hx', h2⟩ := h
      exact ⟨hw y h1, x, hx x hx', h2⟩
    simp [this]
  · simp [h]; split <;> omega

theorem level_mono {n : Nat} {s s' : State K V} {z : Nat} (hw : ∀ y, s.went y = true → s'.went y = true)
    (hk : ∀ x ∈ s.kept z, x ∈ s'.kept z) : level n s' z ≤ level n s z := by
  apply tot_le
  intro y _
  by_cases h : y = z ∨ inside s.went (s.kept z) y
  · have : y = z ∨ inside s'.went (s'.kept z) y = true := by
      rcases h with h | h
      · exact Or.inl h
      · right
        simp only [inside, Bool.and_eq_true, List.any_eq_true, decide_eq_true_eq] at h ⊢
        obtain ⟨h1, x, hx', h2⟩ := h
        exact ⟨hw y h1, x, hk x hx', h2⟩
    simp [this]
  · simp only [h, ite_false]; split <;> omega

-- the invariant on causes: whens not past the pulse; a run's number its count; this pulse's cause
-- of c is of its latest run; a kept cause, and one a run was given (taken from c's kept till its
-- end), is this pulse's, and the latest run's is c's cause
structure Causal (s : State K V) : Prop where
  when_le : ∀ c, s.when c ≤ s.pulses
  runs : ∀ c, ((s.ran c).map (·.n)).getD 0 = s.runs c
  cause : ∀ c, s.when c = s.pulses → (s.cause c).of = (c, s.runs c)
  kept : ∀ d x, x ∈ s.kept d → s.when x.of.1 = s.pulses ∧ x.of.2 ≤ s.runs x.of.1 ∧
    (x.of.2 = s.runs x.of.1 → x = s.cause x.of.1)
  given : ∀ d r, s.ran d = some r → ∀ x ∈ r.given, s.when x.of.1 = s.pulses ∧
    x.of.2 ≤ s.runs x.of.1 ∧ (x.of.2 = s.runs x.of.1 → x = s.cause x.of.1)

theorem Causal.of {s s' : State K V} (h : Causal s) (e1 : s'.when = s.when) (e2 : s'.pulses = s.pulses)
    (e3 : ∀ c, (s'.ran c).map (·.n) = (s.ran c).map (·.n)) (e4 : s'.runs = s.runs)
    (e5 : s'.cause = s.cause)
    (e6 : ∀ d, ∀ x ∈ s'.kept d, x ∈ s.kept d ∨ (s.when x.of.1 = s.pulses ∧ x = s.cause x.of.1) ∨
      ∃ r, s.ran d = some r ∧ x ∈ r.given)
    (e7 : ∀ d r', s'.ran d = some r' → ∀ x ∈ r'.given, ∃ r, s.ran d = some r ∧ x ∈ r.given) :
    Causal s' where
  when_le c := by rw [e1, e2]; exact h.when_le c
  runs c := by rw [e3, e4]; exact h.runs c
  cause c hc := by rw [e1, e2] at hc; rw [e5, e4]; exact h.cause c hc
  kept d x hx := by
    rw [e1, e2, e4, e5]
    rcases e6 d x hx with hx | ⟨h1, h2⟩ | ⟨r, h1, h2⟩
    · exact h.kept d x hx
    · have := h.cause _ h1
      refine ⟨h1, ?_, fun _ => h2⟩
      rw [h2, this]; exact Nat.le_refl _
    · exact h.given d r h1 x h2
  given d r' hr x hx := by
    rw [e1, e2, e4, e5]
    obtain ⟨r, h1, h2⟩ := e7 d r' hr x hx
    exact h.given d r h1 x h2

-- the same, the ran as it was
theorem Causal.ofr {s s' : State K V} (h : Causal s) (e1 : s'.when = s.when) (e2 : s'.pulses = s.pulses)
    (e3 : s'.ran = s.ran) (e4 : s'.runs = s.runs) (e5 : s'.cause = s.cause)
    (e6 : ∀ d, ∀ x ∈ s'.kept d, x ∈ s.kept d ∨ (s.when x.of.1 = s.pulses ∧ x = s.cause x.of.1)) :
    Causal s' :=
  h.of e1 e2 (fun c => by rw [e3]) e4 e5 (fun d x hx => (e6 d x hx).imp_right Or.inl)
    (fun d r hr x hx => ⟨r, e3 ▸ hr, hx⟩)

-- causeOf: c's cause, this pulse's; a cut one is the latest run alone
theorem causeof_causal {s : State K V} (h : Causal s) (c : Nat) :
    Causal (causeof s c).1 ∧ (causeof s c).1.when c = (causeof s c).1.pulses ∧
    (causeof s c).1.cause c = (causeof s c).2 ∧ (causeof s c).2.of.1 = c ∧
    (∀ x, (causeof s c).2.of = x.of → ∀ d, x ∈ (causeof s c).1.kept d → x = (causeof s c).2) ∧
    (causeof s c).1.kept = s.kept ∧ (causeof s c).1.pulses = s.pulses := by
  unfold causeof
  split
  · rename_i hw
    refine ⟨h, hw, rfl, by rw [h.cause c hw], fun x hx d hd => ?_, rfl, rfl⟩
    obtain ⟨h1, h2, h3⟩ := h.kept d x hd
    rw [← hx, h.cause c hw] at h3
    have := h3 rfl
    simpa using this
  · rename_i hw
    refine ⟨?_, by simp, by simp, rfl, fun x hx d hd => ?_, rfl, rfl⟩
    · refine ⟨fun d => ?_, fun d => h.runs d, fun d hd => ?_, fun d x hx => ?_, fun d r hr x hx => ?_⟩
      · by_cases e : d = c
        · subst e; simp
        · simp [put_ne _ _ e]; exact h.when_le d
      · by_cases e : d = c
        · subst e; simp [Cause.of, h.runs]
        · simp [put_ne _ _ e] at hd ⊢; exact h.cause d hd
      · obtain ⟨h1, h2, h3⟩ := h.kept d x hx
        by_cases e : x.of.1 = c
        · rw [e] at h1; exact absurd h1 hw
        · simp only [put_ne _ _ e]; exact ⟨h1, h2, h3⟩
      · obtain ⟨h1, h2, h3⟩ := h.given d r hr x hx
        by_cases e : x.of.1 = c
        · rw [e] at h1; exact absurd h1 hw
        · simp only [put_ne _ _ e]; exact ⟨h1, h2, h3⟩
    · obtain ⟨h1, _⟩ := h.kept d x hd
      have : x.of.1 = c := by rw [← hx]; rfl
      rw [this] at h1; exact absurd h1 hw

theorem causeof_went (s : State K V) (c : Nat) :
    (∀ y, s.went y = true → (causeof s c).1.went y = true) ∧ Same s (causeof s c).1 ∧
    (causeof s c).1.due = s.due ∧ (causeof s c).1.loop = s.loop ∧ (causeof s c).1.acts = s.acts ∧
    (∀ e, e ≠ c → (causeof s c).1.when e = s.when e ∧ (causeof s c).1.cause e = s.cause e) := by
  unfold causeof
  split
  · exact ⟨fun _ h => h, Same.refl s, rfl, rfl, rfl, fun _ _ => ⟨rfl, rfl⟩⟩
  · refine ⟨fun y h => ?_, ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩, rfl, rfl, rfl,
      fun e he => by simp [put_ne _ _ he]⟩
    by_cases e : y = c
    · subst e; simp
    · simp [put_ne _ _ e, h]

-- keep: the cause is kept on d after, the one there of its run being it
theorem keep_kept (s : State K V) (d : Nat) (k : Why) (hd : ∀ x ∈ s.kept d, x.of = k.of → x = k) :
    k ∈ (keep s d k).kept d ∧ (∀ z, ∀ x ∈ s.kept z, x ∈ (keep s d k).kept z) ∧
    (∀ z, ∀ x ∈ (keep s d k).kept z, x ∈ s.kept z ∨ x = k) ∧
    ∃ kp, keep s d k = { s with kept := kp } := by
  unfold keep
  split
  · rename_i h
    obtain ⟨x, hx, he⟩ := Option.map_eq_some_iff.1 h
    have hx' := List.mem_of_getLast? hx
    exact ⟨hd x hx' he ▸ hx', fun _ _ h => h, fun _ _ h => Or.inl h, _, rfl⟩
  · refine ⟨by simp, fun z x hx => ?_, fun z x hx => ?_, _, rfl⟩
    · by_cases e : z = d
      · subst e; simp [hx]
      · simp [put_ne _ _ e, hx]
    · by_cases e : z = d
      · subst e; simp at hx; rcases hx with h | h
        · exact Or.inl h
        · exact Or.inr h
      · simp [put_ne _ _ e] at hx; exact Or.inl hx

-- settle touches d's flags and due, and the cut
theorem settle_eq (s : State K V) (d t : Nat) (who : Option Nat) (l : Option (List Nat)) (fl : Bool) :
    (settle s d t who l fl).kept = s.kept ∧ (settle s d t who l fl).went = s.went ∧
    (settle s d t who l fl).when = s.when ∧ (settle s d t who l fl).cause = s.cause ∧
    (∀ z, z ≠ d → (settle s d t who l fl).due z = s.due z ∧ (settle s d t who l fl).loop z = s.loop z) ∧
    ((l.isSome && fl) = true → (settle s d t who l fl).due d = s.due d ∧
      (settle s d t who l fl).loop d = s.loop d) ∧
    ((l.isSome && fl) = false → (settle s d t who l fl).loop d = l) ∧
    ((l.isSome && fl) = false → l = none → ((settle s d t who l fl).due d).isSome) := by
  unfold settle
  split
  · rename_i h
    split
    · exact ⟨rfl, rfl, rfl, rfl, fun _ _ => ⟨rfl, rfl⟩, fun _ => ⟨rfl, rfl⟩, fun h' => by simp [h] at h',
        fun h' => by simp [h] at h'⟩
    · exact ⟨rfl, rfl, rfl, rfl, fun _ _ => ⟨rfl, rfl⟩, fun _ => ⟨rfl, rfl⟩, fun h' => by simp [h] at h',
        fun h' => by simp [h] at h'⟩
  · rename_i h
    dsimp only
    split
    · rename_i h2
      refine ⟨rfl, rfl, rfl, rfl, fun z hz => ⟨rfl, by simp [put_ne _ _ hz]⟩, fun h' => by simp [h] at h',
        fun _ => by simp, fun _ hl => ?_⟩
      simp [hl] at h2
    · refine ⟨?_, ?_, ?_, ?_, fun z hz => ⟨?_, ?_⟩, fun h' => by simp [h] at h', fun _ => ?_, fun _ _ => ?_⟩ <;>
        simp only [due] <;> split <;> simp_all [say, put_ne]

-- a free mark from x, kept on z: z's level is below x's room
theorem level_room {n : Nat} {s : State K V} {z : Nat} {x : Why} (hk : x ∈ s.kept z) (hz : z < n)
    (hf : ¬(s.went z = true ∧ z ∈ anc x)) : level n s z + 1 ≤ room n s.went [x] := by
  have key : ∀ y, y < n → (if y = z ∨ inside s.went (s.kept z) y = true then 0 else 1) +
      (if y = z then 1 else 0) ≤ (if inside s.went [x] y = true then 0 else 1) := by
    intro y _
    by_cases hy : y = z
    · subst hy
      have : inside s.went [x] y = false := by
        simp only [inside, List.any_cons, List.any_nil, Bool.or_false, Bool.and_eq_false_iff,
          decide_eq_false_iff_not]
        by_cases hw : s.went y = true
        · exact Or.inr (fun h => hf ⟨hw, h⟩)
        · exact Or.inl (by simpa using hw)
      simp [this]
    · simp only [hy, ite_false, Nat.add_zero, false_or]
      by_cases hi : inside s.went [x] y = true
      · have : inside s.went (s.kept z) y = true := by
          simp only [inside, Bool.and_eq_true, List.any_cons, List.any_nil, Bool.or_false,
            decide_eq_true_eq, List.any_eq_true] at hi ⊢
          exact ⟨hi.1, x, hk, hi.2⟩
        simp [this]
      · have : (if inside s.went [x] y = true then 0 else 1) = 1 := by simp [hi]
        rw [this]; split <;> omega
  have := tot_le key
  rw [tot_add, tot_one _ hz] at this
  exact this

-- a mark by c's latest run (causes as the invariant says): every other's term is no more; the one
-- marked, unflagged and free, is below c's level; levels of queued acts no more
theorem mark_budget {s : State K V} (h : Causal s) (c d t n : Nat) (hd : d < n) (B : Nat)
    (hB : ∀ j, j + 1 ≤ later n s c → worth n j ≤ B) :
    Causal (mark s d t (some c)) ∧ Same s (mark s d t (some c)) ∧
    (∀ z, z ≠ d → term n (mark s d t (some c)) z ≤ term n s z) ∧
    term n (mark s d t (some c)) d ≤ max (term n s d) B ∧
    (∀ e, later n (mark s d t (some c)) e ≤ later n s e) ∧
    (∀ y, s.went y = true → (mark s d t (some c)).went y = true) ∧
    (∀ z, ∀ x ∈ s.kept z, x ∈ (mark s d t (some c)).kept z) ∧
    (s.went c = true → (s.due c = none ∨ (s.loop c).isSome) →
      ((mark s d t (some c)).due c = none ∨ ((mark s d t (some c)).loop c).isSome)) := by
  obtain ⟨c1, c2, c3, c4, c5, c6, c7⟩ := causeof_causal h c
  obtain ⟨w1, w2, w3, w4, w5, w6⟩ := causeof_went s c
  generalize hp : causeof s c = p at c1 c2 c3 c4 c5 c6 c7 w1 w2 w3 w4 w5 w6
  obtain ⟨s1, k⟩ := p
  simp only at c1 c2 c3 c4 c5 c6 c7 w1 w2 w3 w4 w5 w6
  have hl : later n s c = room n s1.went [k] := by rw [later_eq, hp]
  obtain ⟨k1, k2, k3, kp, hkp⟩ := keep_kept s1 d k (fun x hx he => c5 x he.symm d hx)
  simp only [mark, hp]
  rw [hkp] at k1 k2 k3 ⊢
  generalize hl2 : loopof { s1 with kept := kp } k d = l
  generalize hfl : (((({ s1 with kept := kp } : State K V).ran c).bind (·.loop)).isSome) = fl
  obtain ⟨e1, e2, e3, e4, e5, e6, e7, e8⟩ := settle_eq { s1 with kept := kp } d t (some c) l fl
  obtain ⟨sa, _, _⟩ := settle_same { s1 with kept := kp } d t (some c) l fl
  generalize hs' : settle { s1 with kept := kp } d t (some c) l fl = s' at e1 e2 e3 e4 e5 e6 e7 e8 sa
  simp only at e1 e2 e3 e4 e5 e6 e7 e8 k1 k2 k3
  -- the facts of s' in terms of s
  have hwent : ∀ y, s.went y = true → s'.went y = true := fun y hy => by rw [e2]; exact w1 y hy
  have hkept : ∀ z, ∀ x ∈ s.kept z, x ∈ s'.kept z := fun z x hx => by rw [e1]; exact k2 z x (c6 ▸ hx)
  have hsame : Same s s' := w2.trans (Same.trans (s' := { s1 with kept := kp })
    ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ sa)
  have hother : ∀ z, z ≠ d → s'.due z = s.due z ∧ s'.loop z = s.loop z := by
    intro z hz; obtain ⟨a, b⟩ := e5 z hz; exact ⟨a.trans (by rw [w3]), b.trans (by rw [w4])⟩
  have hcaus : Causal s' := by
    refine c1.ofr (s' := s') (by rw [e3]) (by rw [sa.pulses]) sa.ran (by rw [sa.runs])
      (by rw [e4]) (fun z x hx => ?_)
    rw [e1] at hx
    rcases k3 z x hx with hx | hx
    · exact Or.inl hx
    · subst hx; exact Or.inr ⟨by rw [c4]; exact c2, by rw [c4, c3]⟩
  have hlev : ∀ z, level n s' z = level n { s1 with kept := kp } z := by
    intro z; unfold level; rw [e1, e2]
  have hpul : s'.pulses = s.pulses := by rw [sa.pulses]; exact c7
  refine ⟨hcaus, hsame, ?_, ?_, ?_, hwent, hkept, ?_⟩
  · intro z hz
    obtain ⟨h1, h2⟩ := hother z hz
    unfold term
    rw [h1, h2]
    by_cases hc : ((s.due z).isSome && (s.loop z).isNone) = true
    · simp only [hc, ite_true]
      exact worth_mono n (level_mono hwent (hkept z))
    · simp only [hc]; exact Nat.le_refl _
  · cases hb : (l.isSome && fl)
    · rw [eq_comm] at hb
      have hlo := e7 hb.symm
      cases hl' : l with
      | some x =>
        have : term n s' d = 0 := by unfold term; simp [hlo, hl']
        rw [this]; exact Nat.zero_le _
      | none =>
        refine Nat.le_trans ?_ (Nat.le_max_right _ _)
        unfold term
        split
        · apply hB
          rw [hl, hlev d]
          refine level_room (s := { s1 with kept := kp }) k1 hd ?_
          intro ⟨hw, ha⟩
          have hw' : s1.went d = true := hw
          have : loopof { s1 with kept := kp } k d = some (through { s1 with kept := kp } d k) := by
            simp [loopof, hw', (on_iff d k).2 ha]
          rw [hl2, hl'] at this; cases this
        · exact Nat.zero_le _
    · obtain ⟨h1, h2⟩ := e6 hb
      refine Nat.le_trans ?_ (Nat.le_max_left _ _)
      unfold term
      rw [h1, h2]
      show (if ((s1.due d).isSome && (s1.loop d).isNone) = true then worth n (level n s' d) else 0) ≤
        if ((s.due d).isSome && (s.loop d).isNone) = true then worth n (level n s d) else 0
      rw [w3, w4]
      by_cases hc : ((s.due d).isSome && (s.loop d).isNone) = true
      · simp only [hc, ite_true]
        exact worth_mono n (level_mono hwent (hkept d))
      · simp only [hc]; exact Nat.le_refl _
  · intro e
    have hran : s'.ran = s.ran := hsame.ran
    by_cases he : e = c
    · subst he
      have hw' : s'.when e = s'.pulses := by rw [e3, hpul, ← c7]; exact c2
      have : later n s' e = room n s1.went [k] := by
        unfold later
        split
        · rw [e2, e4, c3]
        · contradiction
      rw [this, hl]; exact Nat.le_refl _
    · obtain ⟨h1, h2⟩ := w6 e he
      unfold later
      rw [e3, e4, hpul, hran]
      show (if s1.when e = s.pulses then room n s'.went [s1.cause e]
          else room n (put s'.went e true) [.mk (e, ((s.ran e).map (·.n)).getD 0) []]) ≤ _
      rw [h1, h2]
      split
      · exact room_mono hwent (fun x hx => hx)
      · refine room_mono (fun y hy => ?_) (fun x hx => hx)
        by_cases hye : y = e
        · subst hye; simp
        · simp [put_ne _ _ hye] at hy ⊢; exact hwent y hy
  · intro hwc hP
    by_cases hdc : d = c
    · subst hdc
      have hl' : l = some (through { s1 with kept := kp } d k) := by
        rw [← hl2]
        simp [loopof, show s1.went d = true from w1 d hwc, (on_iff d k).2 (c4 ▸ anc_root k)]
      cases hb : (l.isSome && fl)
      · rw [e7 hb, hl']; exact Or.inr rfl
      · obtain ⟨h1, h2⟩ := e6 hb
        rw [h1, h2]
        show s1.due d = none ∨ (s1.loop d).isSome
        rw [w3, w4]; exact hP
    · obtain ⟨h1, h2⟩ := hother c (Ne.symm hdc)
      rw [h1, h2]; exact hP

-- what the folds of marks keep: P is "c is not due unflagged"
structure Spent (n B c : Nat) (s s' : State K V) : Prop where
  causal : Causal s'
  same : Same s s'
  terms : ∀ z, term n s' z ≤ max (term n s z) B
  laters : ∀ e, later n s' e ≤ later n s e
  went : ∀ y, s.went y = true → s'.went y = true
  kept : ∀ z, ∀ x ∈ s.kept z, x ∈ s'.kept z
  self : s.went c = true → (s.due c = none ∨ (s.loop c).isSome) →
    (s'.due c = none ∨ (s'.loop c).isSome)

theorem Spent.refl {n B c : Nat} {s : State K V} (h : Causal s) : Spent n B c s s :=
  ⟨h, Same.refl s, fun _ => Nat.le_max_left _ _, fun _ => Nat.le_refl _, fun _ h => h, fun _ _ h => h,
    fun _ h => h⟩

theorem Spent.trans {n B c : Nat} {s s' s'' : State K V} (a : Spent n B c s s') (b : Spent n B c s' s'') :
    Spent n B c s s'' where
  causal := b.causal
  same := a.same.trans b.same
  terms z := by
    have h1 := a.terms z; have h2 := b.terms z
    simp only [Nat.max_def] at *; split at h2 <;> split at h1 <;> split <;> omega
  laters e := Nat.le_trans (b.laters e) (a.laters e)
  went y h := b.went y (a.went y h)
  kept z x h := b.kept z x (a.kept z x h)
  self h1 h2 := b.self (a.went c h1) (a.self h1 h2)

-- s' is s but for fields no term, level or cause reads (the writers, the store, the tick)
theorem Spent.plain {n B c : Nat} {s s' : State K V} (h : Causal s) (a : Same s s')
    (e1 : s'.due = s.due) (e2 : s'.loop = s.loop) (e3 : s'.kept = s.kept) (e4 : s'.went = s.went)
    (e5 : s'.when = s.when) (e6 : s'.cause = s.cause) : Spent n B c s s' where
  causal := h.ofr e5 a.pulses a.ran a.runs e6 (fun d x hx => Or.inl (e3 ▸ hx))
  same := a
  terms z := by
    have : Model.term n s' z = Model.term n s z := by unfold Model.term level; rw [e1, e2, e3, e4]
    rw [this]; exact Nat.le_max_left _ _
  laters e := by unfold Model.later; rw [e4, e5, e6, a.pulses, a.ran]; exact Nat.le_refl _
  went y h := by rw [e4]; exact h
  kept z x h := by rw [e3]; exact h
  self _ h := by rw [e1, e2]; exact h

theorem marks_budget (c t n B : Nat) : ∀ (ds : List Nat) (s : State K V), Causal s →
    (∀ j, j + 1 ≤ later n s c → worth n j ≤ B) → (∀ d ∈ ds, d < n) →
    Spent n B c s (ds.foldl (fun s d => mark s d t (some c)) s)
  | [], s, h, _, _ => Spent.refl h
  | d :: ds, s, h, hB, hd => by
    simp only [List.foldl_cons]
    obtain ⟨a1, a2, a3, a4, a5, a6, a7, a8⟩ := mark_budget h c d t n (hd d (by simp)) B hB
    have first : Spent n B c s (mark s d t (some c)) := by
      refine ⟨a1, a2, fun z => ?_, a5, a6, a7, a8⟩
      by_cases hz : z = d
      · subst hz; exact a4
      · exact Nat.le_trans (a3 z hz) (Nat.le_max_left _ _)
    exact first.trans (marks_budget c t n B ds _ a1
      (fun j hj => hB j (Nat.le_trans hj (a5 c))) (fun x hx => hd x (by simp [hx])))

-- a change named by c, whose latest run is there: terms at most B more, B above c's free marks
theorem changed_budget (cs : Nat → Comp K V) (s : State K V) (keys : List K) (c B : Nat)
    (h : Causal s) (hc : (s.ran c).isSome) (hB : ∀ j, j + 1 ≤ later s.made s c → worth s.made j ≤ B) :
    Spent s.made B c s (changed cs s keys (some c)) := by
  simp only [changed]
  generalize ht : s.tick + 1 = t
  have hr : runof { s with tick := t } (some c) = some c := by simp [runof, hc]
  rw [hr]
  generalize hwr : ((some c).filter fun c => match (cs c).kind with
    | .compute _ => true | .effect _ => false) = w
  have s0 : Spent s.made B c s { s with tick := t } :=
    Spent.plain h ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ rfl rfl rfl rfl rfl rfl
  have fold : ∀ (ks : List K) (s1 : State K V), Spent s.made B c s s1 →
      Spent s.made B c s (ks.foldl (fun s k => tell (learn s k w) k t (some c)) s1) := by
    intro ks
    induction ks with
    | nil => intro s1 h1; exact h1
    | cons k ks ih =>
      intro s1 h1
      simp only [List.foldl_cons]
      apply ih
      have l1 : Spent s.made B c s1 (learn s1 k w) := by
        cases w with
        | none => exact Spent.refl h1.causal
        | some x =>
          exact Spent.plain h1.causal ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ rfl rfl rfl
            rfl rfl rfl
      have hm : (learn s1 k w).made = s.made := by
        have := (h1.trans l1).same.made; exact this
      refine h1.trans (l1.trans ?_)
      refine marks_budget c t s.made B (readers (learn s1 k w) k) (learn s1 k w) l1.causal
        (fun j hj => hB j (Nat.le_trans hj (Nat.le_trans (l1.laters c) (h1.laters c)))) ?_
      intro d hd
      simp only [readers, List.mem_filter, List.mem_range] at hd
      rw [← hm]; exact hd.1
  exact fold keys _ s0

-- an act's writes, each named by e
theorem writes_budget (cs : Nat → Comp K V) (e B : Nat) : ∀ (ws : List (K × V)) (s s0 : State K V),
    Spent s0.made B e s0 s → (s.ran e).isSome →
    (∀ j, j + 1 ≤ later s0.made s0 e → worth s0.made j ≤ B) →
    Spent s0.made B e s0 (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s)
  | [], _, _, h, _, _ => h
  | kv :: ws, s, s0, h, hr, hB => by
    simp only [List.foldl_cons]
    have st : Spent s0.made B e s (store s kv.1 kv.2) :=
      Spent.plain h.causal ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩ rfl rfl rfl rfl rfl rfl
    have hm : (store s kv.1 kv.2).made = s0.made := h.same.made
    have ch := changed_budget cs (store s kv.1 kv.2) [kv.1] e B st.causal (by simpa [store] using hr)
      (fun j hj => by
        rw [hm] at hj ⊢
        exact hB j (Nat.le_trans hj (Nat.le_trans (st.laters e) (h.laters e))))
    rw [hm] at ch
    have h2 := h.trans (st.trans ch)
    have hr2 : (changed cs (store s kv.1 kv.2) [kv.1] (some e)).ran e = s.ran e := by
      rw [ch.same.ran]; rfl
    exact writes_budget cs e B ws _ s0 h2 (by rw [hr2]; exact hr) hB

-- a run under A2: start, f read along the store, then its end. its record rr, its start's fields
-- no attended computes: nothing wakes, nothing goes
def Unattended (cs : Nat → Comp K V) : Prop := ∀ c, attends (cs c) = false

theorem attending_un {cs : Nat → Comp K V} (hU : Unattended cs) (n : Nat) (k : K) :
    attending cs n k = none := by
  unfold attending
  have : ((List.range n).filter fun c => attends (cs c) && decide ((cs c).key = some k)) = [] := by
    rw [List.filter_eq_nil_iff]; intro c _; simp [hU c]
  rw [this]; rfl

theorem wakes_un {cs : Nat → Comp K V} (hU : Unattended cs) :
    ∀ (ws : List K) (s : State K V), wakes cs s ws = s
  | [], _ => rfl
  | k :: ws, s => by
    simp only [wakes, List.foldl_cons]
    have : wake cs s k = s := by unfold wake; rw [attending_un hU]
    rw [this]; exact wakes_un hU ws s

theorem untrack_un {cs : Nat → Comp K V} (hU : Unattended cs) :
    ∀ (ks : List K) (s : State K V), untrack cs s ks = s
  | [], _ => rfl
  | k :: ks, s => by
    simp only [untrack, List.foldl_cons]
    have : untrack1 cs s k = s := by unfold untrack1; rw [attending_un hU]; split <;> rfl
    rw [this]; exact untrack_un hU ks s

theorem bury_un {cs : Nat → Comp K V} (hU : Unattended cs) (s : State K V) (d : Nat) :
    bury cs s d = s := by
  unfold Model.bury
  cases (cs d).key with
  | none => rfl
  | some k => simp [hU d]

theorem first_a2 (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hp : nowrites (cs c).f)
    (hU : Unattended cs) :
    ∃ (rr : Run K V) (R : Nat → List K) (o : Out V),
      first cs s c rk = ending cs { start s c rk with ran := put s.ran c (some rr), reads := R } c o ∧
      rr.n = s.runs c + 1 ∧ rr.mark = (s.due c).getD 0 ∧ rr.loop = s.loop c ∧
      rr.given = s.kept c ∧ (∀ w, rr.stopped = some w → (s.due w).isSome ∧ w ≠ c) := by
  have h0 : (start s c rk).ran c = some (begun s c [] none []) := by simp [start, say, begun]
  obtain ⟨seen, vals, st, ws, heq, _, hfo, hstop⟩ := exec_spec cs c (cs c).f hp (start s c rk) _ h0 rfl
  clear hfo
  simp only [first]
  rw [untrack_un hU]
  rw [wakes_un hU] at heq hstop
  generalize hx : exec cs c (start s c rk) (cs c).f = x at heq
  obtain ⟨s2, o⟩ := x
  simp only at heq
  subst heq
  refine ⟨{ begun s c [] none [] with seen := seen, values := vals, stopped := st },
    put s.reads c (seen.map (·.1)), o, ?_, rfl, rfl, rfl, rfl, ?_⟩
  · simp [start, say, put_put, begun]
  · intro w hw
    obtain ⟨h1, _, h3, _⟩ := hstop w hw
    refine ⟨?_, h3⟩
    simpa [start, say, put_ne _ _ h3] using h1

-- the room a run of c leaves, at its start: no more than c's level
theorem room_level (n : Nat) (s : State K V) (c m : Nat) :
    room n (put s.went c true) [.mk (c, m) (s.kept c)] ≤ level n s c := by
  apply tot_le
  intro y _
  by_cases h : y = c ∨ inside s.went (s.kept c) y = true
  · have : inside (put s.went c true) [.mk (c, m) (s.kept c)] y = true := by
      simp only [inside, Bool.and_eq_true, List.any_cons, List.any_nil, Bool.or_false,
        decide_eq_true_eq]
      rcases h with rfl | h
      · exact ⟨by simp, anc_self _ _⟩
      · simp only [inside, Bool.and_eq_true, List.any_eq_true, decide_eq_true_eq] at h
        obtain ⟨h1, x, hx, h2⟩ := h
        refine ⟨?_, anc_parent hx h2⟩
        by_cases e : y = c
        · subst e; simp
        · simp [put_ne _ _ e, h1]
    simp [this]
  · simp only [h, ite_false]; split <;> omega

-- the start's fields, and what it leaves of the budget
theorem start_budget (n : Nat) (s : State K V) (c rk : Nat) (R : Nat → List K) (rr : Run K V)
    (hcn : c < n) (hc : (s.due c).isSome) :
    budget n { start s c rk with ran := put s.ran c (some rr), reads := R } + term n s c ≤ budget n s := by
  generalize hs3 : ({ start s c rk with ran := put s.ran c (some rr), reads := R } : State K V) = s3
  have f1 : s3.due = put s.due c none := by rw [← hs3]; rfl
  have f2 : s3.loop = put s.loop c none := by rw [← hs3]; rfl
  have f3 : s3.kept = put s.kept c [] := by rw [← hs3]; rfl
  have f4 : s3.went = put s.went c true := by rw [← hs3]; rfl
  have f5 : queue s3 = (queue s).filter (fun a => a.1 ≠ c) := by
    rw [← hs3]; simp [start, say, queue, List.filter_append]
  have f6 : ∀ e, e ≠ c → s3.when e = s.when e ∧ s3.cause e = s.cause e ∧ s3.ran e = s.ran e := by
    intro e he; rw [← hs3]; simp [start, say, put_ne _ _ he]
  have f7 : s3.pulses = s.pulses := by rw [← hs3]; rfl
  have hw : ∀ y, s.went y = true → s3.went y = true := by
    intro y hy; rw [f4]; by_cases e : y = c
    · subst e; simp
    · simp [put_ne _ _ e, hy]
  have h1 : tot n (term n s3) + term n s c ≤ tot n (term n s) := by
    have key : ∀ z, z < n → term n s3 z + (if z = c then term n s c else 0) ≤ term n s z := by
      intro z _
      by_cases hz : z = c
      · subst hz; simp [term, f1]
      · simp only [hz, ite_false, Nat.add_zero]
        unfold term
        rw [f1, f2, put_ne _ _ hz, put_ne _ _ hz]
        by_cases hc' : ((s.due z).isSome && (s.loop z).isNone) = true
        · simp only [hc', ite_true]
          exact worth_mono n (level_mono hw (fun x hx => by rw [f3, put_ne _ _ hz]; exact hx))
        · simp only [hc']; exact Nat.le_refl _
    have := tot_le key
    rw [tot_add, tot_one _ hcn] at this
    exact this
  have h2 : ((queue s3).map fun a => deed n (later n s3 a.1)).sum ≤
      ((queue s).map fun a => deed n (later n s a.1)).sum := by
    rw [f5]
    refine Nat.le_trans (sum_le (g := fun a => deed n (later n s a.1)) ?_) (sum_filter _ _ _)
    intro a ha
    have hac : a.1 ≠ c := by simpa using (List.mem_filter.1 ha).2
    obtain ⟨g1, g2, g3⟩ := f6 a.1 hac
    have : later n s3 a.1 ≤ later n s a.1 := by
      unfold later
      rw [g1, g2, g3, f7]
      split
      · exact room_mono hw (fun x hx => hx)
      · refine room_mono (fun y hy => ?_) (fun x hx => hx)
        by_cases e : y = a.1
        · subst e; simp
        · simp [put_ne _ _ e] at hy ⊢; exact hw y hy
    exact deed_mono n this
  unfold budget
  omega

-- the budget reads the dues, flags, kept causes, ran, the queued acts and the causes' fields
theorem budget_congr {n : Nat} {s s' : State K V} (e1 : s'.due = s.due) (e2 : s'.loop = s.loop)
    (e3 : s'.kept = s.kept) (e4 : s'.went = s.went) (e5 : queue s' = queue s) (e6 : s'.when = s.when)
    (e7 : s'.cause = s.cause) (e8 : s'.pulses = s.pulses)
    (e9 : ∀ c, (s'.ran c).map (·.n) = (s.ran c).map (·.n)) : budget n s' = budget n s := by
  have ht : term n s' = term n s := by funext z; unfold term level; rw [e1, e2, e3, e4]
  have hl : later n s' = later n s := by funext c; unfold later; rw [e4, e6, e7, e8, e9]
  unfold budget; rw [ht, hl, e5]

-- the run-and-flag sum (φ): each due one 2, and 1 for each not waiting after it; and the phase
def quiet (n : Nat) (s : State K V) : Nat := dues n (fun _ => 2) (fun _ => 1) s + stage s

def big (n : Nat) : Nat := n * (n + 2) + 3

theorem quiet_lt (n : Nat) (s : State K V) : quiet n s < big n := by
  have h1 : dues n (fun _ => 2) (fun _ => 1) s ≤ n * (n + 2) := by
    apply tot_const
    intro d _
    unfold weight; split
    · have := waiting_le n s d
      simp only [Nat.mul_one]; omega
    · omega
  have h2 : stage s ≤ 2 := by unfold stage; split <;> (try split) <;> omega
  unfold quiet big; omega

-- Theorem 1′'s measure: the budget first, then φ
def gauge (n : Nat) (s : State K V) : Nat := budget n s * big n + quiet n s

theorem gauge_lt_budget {n : Nat} {s s' : State K V} (h : budget n s' + 1 ≤ budget n s) :
    gauge n s' < gauge n s := by
  have h1 := quiet_lt n s'
  have : (budget n s' + 1) * big n ≤ budget n s * big n := Nat.mul_le_mul_right _ h
  unfold gauge
  rw [Nat.succ_mul] at this
  omega

theorem gauge_lt_calm {n : Nat} {s s' : State K V} (h1 : budget n s' ≤ budget n s)
    (h2 : quiet n s' < quiet n s) : gauge n s' < gauge n s := by
  have : budget n s' * big n ≤ budget n s * big n := Nat.mul_le_mul_right _ h1
  unfold gauge; omega

-- finish: φ and the causes' invariant as they were, the budget no more (a run not done gives its
-- given back to c's kept: more kept, less room)
theorem finish_keeps {n : Nat} (X : State K V) (c : Nat) (e : Ended) (eq : Option Bool)
    (w : Option Nat) (th : Option (List Nat)) (hc : Causal X) :
    budget n (finish X c e eq w th) ≤ budget n X ∧ quiet n (finish X c e eq w th) = quiet n X ∧
    Causal (finish X c e eq w th) ∧ (finish X c e eq w th).made = X.made := by
  cases hr : X.ran c with
  | none =>
    have : finish X c e eq w th = X := by simp [finish, hr]
    rw [this]; exact ⟨Nat.le_refl _, rfl, hc, rfl⟩
  | some r =>
    obtain ⟨e, th, -, hfin⟩ := finish_any X c r hr e eq w th
    rw [hfin]
    have e9 : ∀ d, ((put X.ran c (some { r with
        ended := some e, given := [], loop := if e = .pending then r.loop else none })) d).map (·.n) =
        (X.ran d).map (·.n) := by
      intro d; by_cases hd : d = c
      · subst hd; simp [hr]
      · simp [put_ne _ _ hd]
    refine ⟨?_, rfl, ?_, rfl⟩
    · by_cases hd : e = .done
      · exact Nat.le_of_eq (budget_congr rfl rfl (by simp [hd]) rfl rfl rfl rfl rfl e9)
      · have hl : ∀ d, later n { X with
            kept := if e = .done then X.kept else put X.kept c (r.given ++ X.kept c),
            looping := if e = .looping then put X.looping c true else X.looping,
            values := if e ≠ .stopped then put X.values c r.values else X.values,
            ran := put X.ran c (some { r with
              ended := some e, given := [], loop := if e = .pending then r.loop else none }),
            log := X.log ++ [⟨X.pulses, X.round, .ends c r.n e eq w th⟩] } d = later n X d := by
          intro d; unfold later; simp only [e9]
        have ht : ∀ z, z < n → term n { X with
            kept := if e = .done then X.kept else put X.kept c (r.given ++ X.kept c),
            looping := if e = .looping then put X.looping c true else X.looping,
            values := if e ≠ .stopped then put X.values c r.values else X.values,
            ran := put X.ran c (some { r with
              ended := some e, given := [], loop := if e = .pending then r.loop else none }),
            log := X.log ++ [⟨X.pulses, X.round, .ends c r.n e eq w th⟩] } z ≤ term n X z := by
          intro z _
          unfold term
          simp only
          split
          · refine worth_mono n (level_mono (fun y h => h) (fun x hx => ?_))
            by_cases hzc : z = c
            · subst hzc; simp [hd, hx]
            · simp [hd, put_ne _ _ hzc, hx]
          · exact Nat.zero_le _
        unfold budget
        simp only [hl]
        have := tot_le ht
        simp only [queue] at this ⊢
        omega
    · refine ⟨hc.when_le, fun d => by rw [e9]; exact hc.runs d, hc.cause, fun d x hx => ?_,
        fun d r' hr' x hx => ?_⟩
      · by_cases hd : e = .done
        · simp only [hd, ite_true] at hx; exact hc.kept d x hx
        · simp only [hd, ite_false] at hx
          by_cases hdc : d = c
          · subst hdc
            simp only [put_same, List.mem_append] at hx
            rcases hx with hx | hx
            · exact hc.given d r hr x hx
            · exact hc.kept d x hx
          · rw [put_ne _ _ hdc] at hx; exact hc.kept d x hx
      · by_cases hdc : d = c
        · subst hdc; simp at hr'; rw [← hr'] at hx; cases hx
        · simp only [put_ne _ _ hdc] at hr'; exact hc.given d r' hr' x hx

-- start: c's kept taken, the run given it
theorem start_causal (s : State K V) (c rk : Nat) (R : Nat → List K) (rr : Run K V)
    (hn : rr.n = s.runs c + 1) (hg : rr.given = s.kept c) (h : Causal s) :
    Causal { start s c rk with ran := put s.ran c (some rr), reads := R } where
  when_le d := by
    show put s.when c s.pulses d ≤ s.pulses
    by_cases e : d = c
    · subst e; simp
    · simp [put_ne _ _ e]; exact h.when_le d
  runs d := by
    show ((put s.ran c (some rr) d).map (·.n)).getD 0 = put s.runs c (s.runs c + 1) d
    by_cases e : d = c
    · subst e; simp [hn]
    · simp [put_ne _ _ e]; exact h.runs d
  cause d hd := by
    show (put s.cause c (.mk (c, s.runs c + 1) (s.kept c)) d).of = (d, put s.runs c (s.runs c + 1) d)
    by_cases e : d = c
    · subst e; simp [Cause.of]
    · simp [put_ne _ _ e]
      have : s.when d = s.pulses := by simpa [start, say, put_ne _ _ e] using hd
      exact h.cause d this
  kept d x hx := by
    have hx' : x ∈ s.kept d := by
      have : x ∈ put s.kept c [] d := hx
      by_cases e : d = c
      · subst e; simp at this
      · rwa [put_ne _ _ e] at this
    obtain ⟨h1, h2, h3⟩ := h.kept d x hx'
    show put s.when c s.pulses x.of.1 = s.pulses ∧ x.of.2 ≤ put s.runs c (s.runs c + 1) x.of.1 ∧
      (x.of.2 = put s.runs c (s.runs c + 1) x.of.1 →
        x = put s.cause c (.mk (c, s.runs c + 1) (s.kept c)) x.of.1)
    by_cases e : x.of.1 = c
    · rw [e] at h2 ⊢; simp
      refine ⟨by omega, fun h4 => by omega⟩
    · simp [put_ne _ _ e]; exact ⟨h1, h2, h3⟩
  given d r hr x hx := by
    have hx' : x ∈ s.kept d ∨ ∃ r0, s.ran d = some r0 ∧ x ∈ r0.given := by
      have : put s.ran c (some rr) d = some r := hr
      by_cases e : d = c
      · subst e; simp at this; subst this; rw [hg] at hx; exact Or.inl hx
      · rw [put_ne _ _ e] at this; exact Or.inr ⟨r, this, hx⟩
    obtain ⟨h1, h2, h3⟩ : s.when x.of.1 = s.pulses ∧ x.of.2 ≤ s.runs x.of.1 ∧
        (x.of.2 = s.runs x.of.1 → x = s.cause x.of.1) := by
      rcases hx' with hx' | ⟨r0, h0, hx'⟩
      · exact h.kept d x hx'
      · exact h.given d r0 h0 x hx'
    show put s.when c s.pulses x.of.1 = s.pulses ∧ x.of.2 ≤ put s.runs c (s.runs c + 1) x.of.1 ∧
      (x.of.2 = put s.runs c (s.runs c + 1) x.of.1 →
        x = put s.cause c (.mk (c, s.runs c + 1) (s.kept c)) x.of.1)
    by_cases e : x.of.1 = c
    · rw [e] at h2 ⊢; simp
      refine ⟨by omega, fun h4 => by omega⟩
    · simp [put_ne _ _ e]; exact ⟨h1, h2, h3⟩

-- the free marks of a set from a cause at level j: at most n of them, one level down
theorem spent_budget {n B c : Nat} {s s' : State K V} (h : Spent n B c s s') :
    budget n s' ≤ budget n s + n * B := by
  have h1 : tot n (term n s') ≤ tot n (term n s) + n * B := by
    have := tot_le (n := n) (f := term n s') (g := fun z => term n s z + B)
      (fun z _ => Nat.le_trans (h.terms z) (by simp only [Nat.max_def]; split <;> omega))
    rw [tot_add] at this
    have h2 := tot_const (n := n) (x := B) (f := fun _ => B) (fun _ _ => Nat.le_refl _)
    omega
  have h2 : ((queue s').map fun a => deed n (later n s' a.1)).sum ≤
      ((queue s).map fun a => deed n (later n s a.1)).sum := by
    rw [queue, queue, h.same.acts, h.same.earlies]
    exact sum_le (fun a _ => deed_mono n (h.laters a.1))
  unfold budget; omega

theorem worth_top (n j : Nat) : n * top n j + 2 ≤ worth n j := by
  cases j with
  | zero => simp [top, worth]
  | succ j => simp [top, worth]; omega

theorem top_mono (n : Nat) {j j' : Nat} (h : j ≤ j') : top n j ≤ top n j' := by
  unfold top
  split
  · omega
  · split
    · omega
    · exact worth_mono n (by omega)

-- Theorem 1′, a run step (A2): the gauge falls
theorem run_gauge (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) (hA : A2 cs) (hU : Unattended cs)
    (hca : Causal s) (hc : (s.due c).isSome)
    (hr : ∀ w, s.after c = some w → s.due w = none) (hcn : c < s.made)
    (hdm : ∀ x, (s.due x).isSome → x < s.made) :
    Causal (first cs s c rk) ∧ (first cs s c rk).made = s.made ∧
    (s.phase = .runs → gauge s.made (first cs s c rk) < gauge s.made s) := by
  generalize hn : s.made = n at hcn
  obtain ⟨rr, R, o, hfirst, hrn, hrm, hrl, hrg, hrs⟩ := first_a2 cs s c rk (hA c) hU
  rw [hfirst]
  have hb3 := start_budget n s c rk R rr hcn hc
  have hc3 := start_causal s c rk R rr hrn hrg hca
  generalize hs3 : ({ start s c rk with ran := put s.ran c (some rr), reads := R } : State K V) = s3
    at hb3 hc3 ⊢
  have f_due : s3.due = put s.due c none := by subst hs3; rfl
  have f_after : s3.after = put s.after c none := by subst hs3; rfl
  have f_made : s3.made = s.made := by subst hs3; rfl
  have f_phase : s3.phase = s.phase := by subst hs3; rfl
  have f_ran : s3.ran = put s.ran c (some rr) := by subst hs3; rfl
  have f_loop : s3.loop = put s.loop c none := by subst hs3; rfl
  have f_went : s3.went = put s.went c true := by subst hs3; rfl
  have f_when : s3.when = put s.when c s.pulses := by subst hs3; rfl
  have f_pulses : s3.pulses = s.pulses := by subst hs3; rfl
  have f_cause : s3.cause = put s.cause c (.mk (c, s.runs c + 1) (s.kept c)) := by subst hs3; rfl
  have f_kept : s3.kept = put s.kept c [] := by subst hs3; rfl
  have f_cut : s3.cut c = false := by rw [← hs3]; simp [start, say]
  have hlat : later n s3 c ≤ level n s c := by
    unfold later
    rw [f_when, f_pulses, f_went, f_cause]
    simp only [put_same, ite_true]
    exact room_level n s c (s.runs c + 1)
  have hstage : s.phase = .runs → ∀ X : State K V, X.phase = s.phase → stage X = stage s := by
    intro hph X hX; simp [stage, hX, hph]
  -- a plain end: no free run left of c, nothing marked
  have plain : ∀ X : State K V, Causal X → X.due = put s.due c none →
      X.after = put s.after c none → X.made = s.made → X.phase = s.phase → budget n X ≤ budget n s →
      ∀ e eq w th, Causal (finish X c e eq w th) ∧ (finish X c e eq w th).made = s.made ∧
        (s.phase = .runs → gauge n (finish X c e eq w th) < gauge n s) := by
    intro X hX e1 e2 e3 e4 e5 e eq w th
    obtain ⟨k1, k2, k3, k4⟩ := finish_keeps (n := n) X c e eq w th hX
    refine ⟨k3, k4.trans e3, fun hph => gauge_lt_calm (Nat.le_trans k1 e5) ?_⟩
    rw [k2]
    have hd := dues_go (n := n) (a := fun _ => 2) (b := fun _ => 1) (s := s) (s' := X) hcn hc hr e2
      (fun d h => by
        by_cases hdc : d = c
        · subst hdc; rw [e1] at h; simp at h
        · exact ⟨hdc, by cases s.due d <;> simp⟩)
    have hf : tot n (newly n (fun _ => 2) (fun _ => 1) s X) = 0 := by
      rw [show tot n (newly n (fun _ => 2) (fun _ => 1) s X) = tot n (fun _ => 0) from
        tot_cong (fun d _ => by
          unfold newly
          by_cases hdc : d = c
          · subst hdc; simp [e1]
          · rw [e1, put_ne _ _ hdc]; cases s.due d <;> simp)]
      exact tot_zero n
    unfold quiet
    rw [hstage hph X e4]
    omega
  have hcterm : s.loop c = none → term n s c = worth n (level n s c) := by
    intro hl; simp [term, hc, hl]
  have hworth : ∀ j, 2 ≤ worth n j := by intro j; cases j <;> simp [worth] <;> omega
  -- the run's record changed, nothing else: as s3
  have edits : ∀ g : Run K V → Run K V, (∀ r, (g r).n = r.n) → (∀ r, (g r).given = r.given) →
      Causal (edit s3 c g) ∧ budget n (edit s3 c g) = budget n s3 ∧
      (edit s3 c g).due = s3.due ∧ (edit s3 c g).after = s3.after ∧ (edit s3 c g).made = s3.made ∧
      (edit s3 c g).phase = s3.phase ∧ (edit s3 c g).loop = s3.loop ∧ (edit s3 c g).went = s3.went ∧
      (edit s3 c g).acts = s3.acts ∧ (edit s3 c g).cut = s3.cut ∧
      ((edit s3 c g).ran c).bind (·.loop) = ((s3.ran c).map g).bind (·.loop) ∧
      (∀ e, later n (edit s3 c g) e = later n s3 e) ∧ ((edit s3 c g).ran c).isSome := by
    intro g hg hgg
    have e9 : ∀ d, ((edit s3 c g).ran d).map (·.n) = (s3.ran d).map (·.n) := by
      intro d; by_cases hd : d = c
      · subst hd; simp only [edit, put_same]; cases s3.ran d <;> simp [hg]
      · simp [edit, put_ne _ _ hd]
    have e7 : ∀ d r', (edit s3 c g).ran d = some r' → ∀ x ∈ r'.given,
        ∃ r, s3.ran d = some r ∧ x ∈ r.given := by
      intro d r' hr' x hx
      by_cases hd : d = c
      · subst hd
        simp only [edit, put_same, Option.map_eq_some_iff] at hr'
        obtain ⟨r0, h0, rfl⟩ := hr'
        exact ⟨r0, h0, by rw [hgg] at hx; exact hx⟩
      · simp only [edit, put_ne _ _ hd] at hr'; exact ⟨r', hr', hx⟩
    refine ⟨hc3.of rfl rfl e9 rfl rfl (fun d x hx => Or.inl hx) e7,
      budget_congr rfl rfl rfl rfl rfl rfl rfl rfl e9,
      rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, by simp [edit], fun e => ?_, by simp [edit, f_ran]⟩
    unfold later; rw [show (edit s3 c g).when = s3.when from rfl, show (edit s3 c g).cause = s3.cause from rfl,
      show (edit s3 c g).went = s3.went from rfl, show (edit s3 c g).pulses = s3.pulses from rfl, e9]
  have hd3 : s3.due c = none := by rw [f_due]; simp
  have hb3' : budget n s3 ≤ budget n s := by omega
  unfold ending
  split
  · -- stopped: due again at its mark, after its writer, its flag kept (F1)
    rename_i hst
    have hrr : s3.ran c = some rr := by rw [f_ran]; simp
    simp only [hrr, Option.bind_some] at hst
    obtain ⟨w, hw⟩ := Option.isSome_iff_exists.1 hst
    obtain ⟨hwd, hwc⟩ := hrs w hw
    rw [stop_eq s3 c rr hrr hd3]
    generalize hs' : ({ s3 with loop := put s3.loop c rr.loop, after := put s3.after c rr.stopped,
                                due := put s3.due c (some rr.mark),
                                kept := put s3.kept c (rr.given ++ s3.kept c),
                                ran := put s3.ran c
                                  (some { rr with ended := some .stopped, given := [], loop := none }),
                                log := s3.log ++ [⟨s3.pulses, s3.round,
                                  .ends c rr.n .stopped none rr.stopped none⟩] } : State K V) = s'
    have g_loop : s'.loop = put s3.loop c rr.loop := by subst hs'; rfl
    have g_after : s'.after = put s3.after c rr.stopped := by subst hs'; rfl
    have g_due : s'.due = put s3.due c (some rr.mark) := by subst hs'; rfl
    have g_ran : s'.ran =
        put s3.ran c (some { rr with ended := some .stopped, given := [], loop := none }) := by
      subst hs'; rfl
    have g_rest : s'.kept = put s3.kept c (rr.given ++ s3.kept c) ∧ s'.went = s3.went ∧
        s'.when = s3.when ∧ s'.cause = s3.cause ∧
        s'.pulses = s3.pulses ∧ s'.runs = s3.runs ∧ s'.acts = s3.acts ∧ s'.made = s3.made ∧
        s'.phase = s3.phase := by subst hs'; exact ⟨rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl, rfl⟩
    obtain ⟨g1, g2, g3, g4, g5, g6, g7, g8, g9⟩ := g_rest
    have e9 : ∀ d, (s'.ran d).map (·.n) = (s3.ran d).map (·.n) := by
      intro d; rw [g_ran]; by_cases hd : d = c
      · subst hd; simp [hrr]
      · simp [put_ne _ _ hd]
    -- the given back in c's kept: s's kept of c, as it was before the run
    have g1c : s'.kept c = s.kept c := by rw [g1, f_kept]; simp [hrg]
    have g1z : ∀ z, z ≠ c → s'.kept z = s3.kept z := fun z hz => by rw [g1, put_ne _ _ hz]
    have hcs' : Causal s' := hc3.of g3 g5 e9 g6 g4
      (fun d x hx => by
        by_cases hd : d = c
        · subst hd; rw [g1] at hx; simp only [put_same, List.mem_append] at hx
          rcases hx with hx | hx
          · exact Or.inr (Or.inr ⟨rr, hrr, hx⟩)
          · exact Or.inl hx
        · exact Or.inl (by rw [g1z d hd] at hx; exact hx))
      (fun d r' hr' x hx => by
        rw [g_ran] at hr'
        by_cases hd : d = c
        · subst hd; simp at hr'; rw [← hr'] at hx; cases hx
        · rw [put_ne _ _ hd] at hr'; exact ⟨r', hr', hx⟩)
    refine ⟨hcs', by rw [g8, ← hn, f_made], fun hph => ?_⟩
    apply gauge_lt_calm
    · -- c's term as it was before the run, the rest as at s3
      have ht : ∀ z, z < n → term n s' z ≤ term n s3 z + (if z = c then term n s c else 0) := by
        intro z _
        by_cases hz : z = c
        · subst hz
          simp only [ite_true]
          unfold term
          rw [g_due, g_loop]
          simp only [put_same, Option.isSome_some, Bool.true_and, hrl]
          have hl : level n s' z ≤ level n s z := by
            refine level_mono (fun y hy => ?_) (fun x hx => by rw [g1c]; exact hx)
            rw [g2, f_went]; by_cases e : y = z
            · subst e; simp
            · simp [put_ne _ _ e, hy]
          have hcs : (s.due z).isSome = true := hc
          split
          · rename_i hl'
            simp only [hcs, Bool.true_and, hl', ite_true]
            have := worth_mono n hl; omega
          · omega
        · simp only [hz, ite_false, Nat.add_zero]
          unfold term level
          rw [g_due, g_loop, put_ne _ _ hz, put_ne _ _ hz, g1z z hz, g2]
          exact Nat.le_refl _
      have := tot_le ht
      rw [tot_add, tot_one _ hcn] at this
      have hl : ∀ e, later n s' e = later n s3 e := by
        intro e; unfold later; rw [g2, g3, g4, g5, e9]
      have g7e : s'.earlies = s3.earlies := by rw [← hs']
      unfold budget at hb3 ⊢
      simp only [hl, queue, g7, g7e] at hb3 ⊢
      omega
    · have hwn : w < n := hn ▸ hdm w hwd
      have hcc : s.after c ≠ some c := by intro e; have := hr c e; simp [this] at hc
      have hd := dues_stop (n := n) (a := fun _ => 2) (b := fun _ => 1) (s := s) (s' := s')
        hcn hc hr hcc hwc hwn hwd (by rw [g_after, f_after, hw, put_put])
      have hf : tot n (newly n (fun _ => 2) (fun _ => 1) s s') = 0 := by
        rw [tot_cong (g := fun _ => 0) (fun d _ => by
          unfold newly
          rw [g_due, f_due]
          by_cases hdc : d = c
          · subst hdc; cases e : s.due d <;> simp_all
          · simp only [put_ne _ _ hdc]; cases s.due d <;> simp)]
        exact tot_zero n
      unfold quiet
      rw [hstage hph _ (g9.trans f_phase)]
      omega
  · rename_i hst
    obtain ⟨x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13⟩ :=
      edits (fun r => { r with out := some o }) (fun r => rfl) (fun r => rfl)
    generalize hX : edit s3 c (fun r => { r with out := some o }) = X
      at x1 x2 x3 x4 x5 x6 x7 x8 x9 x10 x11 x12 x13 ⊢
    dsimp only
    have pl := plain X x1 (x3.trans f_due) (x4.trans f_after) (x5.trans f_made) (x6.trans f_phase)
      (x2 ▸ hb3')
    have fl : (X.ran c).bind (·.loop) = s.loop c := by rw [x11, f_ran]; simp [hrl]
    have hXm : X.made = n := by rw [x5, f_made, hn]
    split
    · obtain ⟨a, b, c'⟩ := pl .failed none none none; exact ⟨a, b.trans hn, c'⟩
    · obtain ⟨a, b, c'⟩ := pl .pending none none none; exact ⟨a, b.trans hn, c'⟩
    · rename_i v
      unfold result
      split
      · obtain ⟨a, b, c'⟩ := pl .failed none none none; exact ⟨a, b.trans hn, c'⟩
      · rename_i e _
        dsimp only
        split
        · obtain ⟨a, b, c'⟩ := pl .looping (some e) none ((X.ran c).bind (·.loop))
          exact ⟨a, b.trans hn, c'⟩
        · rename_i hnl
          have hfl : e = false → s.loop c = none := by
            intro he'
            rw [← fl]
            cases h' : (X.ran c).bind (·.loop) with
            | none => rfl
            | some _ => simp [he', h'] at hnl
          split
          · -- an effect: its act queued, unless equal
            split
            · obtain ⟨a, b, c'⟩ := pl .done (some e) none none; exact ⟨a, b.trans hn, c'⟩
            · rename_i he
              have he' : e = false := by simpa using he
              have hgen : ∀ Y : State K V, Causal Y → Y.made = X.made →
                  budget n Y = budget n X + deed n (later n X c) →
                  Causal (finish Y c .done (some e) none none) ∧
                  (finish Y c .done (some e) none none).made = n ∧
                  (s.phase = .runs → gauge n (finish Y c .done (some e) none none) < gauge n s) := by
                intro Y hY hYm hb
                obtain ⟨k1, _, k3, k4⟩ := finish_keeps (n := n) Y c .done (some e) none none hY
                refine ⟨k3, k4.trans (hYm.trans hXm), fun _ => gauge_lt_budget ?_⟩
                refine Nat.le_trans (Nat.add_le_add_right k1 1) ?_
                rw [hb, x2, x12 c]
                have := deed_mono n hlat
                have := worth_deed n (level n s c)
                have := hcterm (hfl he')
                omega
              split
              · refine hgen _ (x1.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)) rfl ?_
                unfold budget
                simp only [queue, List.map_append, List.sum_append, List.map_cons, List.map_nil,
                  List.sum_cons, List.sum_nil, Nat.add_zero]
                have : ∀ d, later n { X with earlies := X.earlies ++ [(c, v)] } d = later n X d :=
                  fun d => rfl
                have ht : term n { X with earlies := X.earlies ++ [(c, v)] } = term n X := rfl
                rw [ht]; simp only [this]; omega
              · refine hgen _ (x1.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)) rfl ?_
                unfold budget
                simp only [queue, List.map_append, List.sum_append, List.map_cons, List.map_nil,
                  List.sum_cons, List.sum_nil, Nat.add_zero]
                have : ∀ d, later n { X with acts := X.acts ++ [(c, v)] } d = later n X d := fun d => rfl
                have ht : term n { X with acts := X.acts ++ [(c, v)] } = term n X := rfl
                rw [ht]; simp only [this]; omega
          · -- a compute: its set called, unless equal
            split
            · obtain ⟨a, b, c'⟩ := pl .done (some e) none none; exact ⟨a, b.trans hn, c'⟩
            · rename_i he
              have he' : e = false := by simpa using he
              have hts := hcterm (hfl he')
              unfold set
              dsimp only
              split
              · rename_i k heq
                generalize hY : store (say X (.set c v)) k v = Y
                have y1 : Causal Y := by
                  rw [← hY]; exact x1.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
                have y2 : Y.made = n := by rw [← hY]; exact hXm
                have y3 : (Y.ran c).isSome := by rw [← hY]; exact x13
                have y4 : ∀ d, later n Y d = later n X d := by intro d; rw [← hY]; rfl
                have y5 : budget n Y = budget n X := by rw [← hY]; rfl
                have sp := changed_budget cs Y [k] c (top n (later n s3 c)) y1 y3 (by
                  rw [y2, y4 c, x12 c]; intro j hj; exact top_le hj)
                rw [y2] at sp
                generalize hZ : changed cs Y [k] (some c) = Z at sp
                have hZ' : Causal { Z with last := put Z.last c (some v) } :=
                  sp.causal.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
                obtain ⟨k1, _, k3, k4⟩ := finish_keeps (n := n) { Z with last := put Z.last c (some v) } c .done
                  (some e) none none hZ'
                refine ⟨k3, k4.trans (sp.same.made.trans y2), fun _ => gauge_lt_budget ?_⟩
                refine Nat.le_trans (Nat.add_le_add_right k1 1) ?_
                have hb : budget n { Z with last := put Z.last c (some v) } = budget n Z := rfl
                rw [hb]
                have h1 := spent_budget sp
                rw [y5, x2] at h1
                have h2 := worth_top n (level n s c)
                have h3 := Nat.mul_le_mul_left n (top_mono n hlat)
                omega
              · rename_i hk
                have hS : Causal { say X (.set c v) with last := put (say X (.set c v)).last c (some v) } :=
                  x1.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
                obtain ⟨k1, _, k3, k4⟩ := finish_keeps (n := n)
                  { say X (.set c v) with last := put (say X (.set c v)).last c (some v) } c .done
                  (some e) none none hS
                refine ⟨k3, k4.trans hXm, fun _ => gauge_lt_budget ?_⟩
                refine Nat.le_trans (Nat.add_le_add_right k1 1) ?_
                have hb : budget n { say X (.set c v) with last := put (say X (.set c v)).last c (some v) } =
                    budget n X := rfl
                rw [hb, x2]
                have := hworth (level n s c)
                omega

theorem deed_top (n j : Nat) : deed n j = 1 + n * top n j := by
  cases j <;> simp [deed, top]

-- Theorem 1′, an act step: the gauge falls
-- the budget with the queue's head out: that act's deed less
theorem budget_head (n : Nat) (s : State K V) (e : Nat) (v : V) (es as : List (Nat × V))
    (hs : queue s = (e, v) :: (es ++ as)) :
    budget n s = budget n { s with earlies := es, acts := as } + deed n (later n s e) := by
  unfold budget; rw [hs]; simp only [List.map_cons, List.sum_cons]
  have : later n { s with earlies := es, acts := as } = later n s := rfl
  have ht : term n { s with earlies := es, acts := as } = term n s := rfl
  rw [this, ht]; simp [queue]; omega

theorem act_gauge (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V) (es as : List (Nat × V))
    (n : Nat) (hn : s.made = n) (hca : Causal s)
    (hre : (s.ran e).isSome) :
    Causal (act cs { s with earlies := es, acts := as } e v) ∧
    (act cs { s with earlies := es, acts := as } e v).made = n ∧
    (budget n s = budget n { s with earlies := es, acts := as } + deed n (later n s e) →
      gauge n (act cs { s with earlies := es, acts := as } e v) < gauge n s) := by
  have hc0 : Causal { s with earlies := es, acts := as } :=
    hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
  have hdd := deed_top n (later n s e)
  unfold act
  split
  · exact ⟨hc0, hn, fun hb => gauge_lt_budget (by omega)⟩
  · split
    · exact ⟨hc0, hn, fun hb => gauge_lt_budget (by omega)⟩
    · rename_i g _
      dsimp only
      generalize hS : say { s with earlies := es, acts := as } (.act e v (s.last e)) = S0
      have s1 : Causal S0 := by
        rw [← hS]; exact hc0.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
      have s2 : S0.made = n := by rw [← hS]; exact hn
      have s3 : budget n S0 = budget n { s with earlies := es, acts := as } := by rw [← hS]; rfl
      have s4 : later n S0 e = later n s e := by rw [← hS]; rfl
      have s5 : (S0.ran e).isSome := by rw [← hS]; exact hre
      have sp := writes_budget cs e (top n (later n s e)) (g v (s.last e)) S0 S0 (Spent.refl s1) s5
        (by rw [s2, s4]; intro j hj; exact top_le hj)
      rw [s2] at sp
      generalize hZ : (g v (s.last e)).foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) S0 = Z
        at sp
      have h1 := spent_budget sp
      refine ⟨sp.causal.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx),
        sp.same.made.trans s2, fun hb => gauge_lt_budget ?_⟩
      have : budget n (say { Z with last := put Z.last e (some v) } (.acts e (((Z.ran e).map (·.n)).getD 0))) =
          budget n Z := rfl
      rw [this]
      omega

-- the host's changes: no causes, so the causes' invariant holds
theorem marks_none (t : Nat) : ∀ (ds : List Nat) (s : State K V),
    (ds.foldl (fun s d => mark s d t none) s).kept = s.kept ∧
    (ds.foldl (fun s d => mark s d t none) s).when = s.when ∧
    (ds.foldl (fun s d => mark s d t none) s).cause = s.cause
  | [], _ => ⟨rfl, rfl, rfl⟩
  | d :: ds, s => by
    simp only [List.foldl_cons]
    obtain ⟨a, b, c⟩ := marks_none t ds (mark s d t none)
    obtain ⟨e1, _, e3, e4, _⟩ := settle_eq s d t none none false
    exact ⟨a.trans e1, b.trans e3, c.trans e4⟩

theorem Causal.told {cs : Nat → Comp K V} {s : State K V} (h : Causal s) (keys : List K) :
    Causal (changed cs s keys none) := by
  have a := (changed_same cs s keys none).1
  have key : ∀ (ks : List K) (s1 : State K V),
      (ks.foldl (fun s k => Model.tell (learn s k none) k (s.tick + 1) none) s1).kept = s1.kept := by
    intro ks; induction ks with
    | nil => intro s1; rfl
    | cons k ks ih => intro s1; simp only [List.foldl_cons]; rw [ih]; exact (marks_none _ _ _).1
  have key2 : ∀ (t : Nat) (ks : List K) (s1 : State K V),
      (ks.foldl (fun s k => Model.tell (learn s k none) k t none) s1).kept = s1.kept ∧
      (ks.foldl (fun s k => Model.tell (learn s k none) k t none) s1).when = s1.when ∧
      (ks.foldl (fun s k => Model.tell (learn s k none) k t none) s1).cause = s1.cause := by
    intro t ks; induction ks with
    | nil => intro s1; exact ⟨rfl, rfl, rfl⟩
    | cons k ks ih =>
      intro s1; simp only [List.foldl_cons]
      obtain ⟨a1, a2, a3⟩ := ih (Model.tell (learn s1 k none) k t none)
      obtain ⟨b1, b2, b3⟩ := marks_none t (readers (learn s1 k none) k) (learn s1 k none)
      exact ⟨a1.trans b1, a2.trans b2, a3.trans b3⟩
  clear key
  have hr : runof { s with tick := s.tick + 1 } none = none := rfl
  obtain ⟨k1, k2, k3⟩ := key2 (s.tick + 1) keys { s with tick := s.tick + 1 }
  simp only [changed, hr] at a ⊢
  exact h.ofr k2 a.pulses a.ran a.runs k3 (fun d x hx => Or.inl (k1 ▸ hx))

theorem exec_ran_some (cs : Nat → Comp K V) (c : Nat) :
    ∀ (p : Prog K V) (s : State K V), (s.ran c).isSome → ((exec cs c s p).1.ran c).isSome
  | .value _, _, h => h
  | .error, _, h => h
  | .pending, _, h => h
  | .write k v next, s, h => by
    simp only [exec]
    exact exec_ran_some cs c next _ (by simpa [store] using h)
  | .read k next, s, h => by
    simp only [exec]
    generalize hX : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) = X
    have hXr : (X.ran c).isSome := by rw [← hX]; simpa [edit] using h
    generalize hY : (if (!tracked s k) = true then wake cs X k else X) = Y
    have hYr : (Y.ran c).isSome := by
      rw [← hY]; split
      · have : wake cs X k = wakes cs X [k] := rfl
        rw [this, wakes_ran]; exact hXr
      · exact hXr
    split
    · exact exec_ran_some cs c _ _ hYr
    · split
      · exact exec_ran_some cs c _ _ hYr
      · split
        · simpa [edit] using hYr
        · exact exec_ran_some cs c _ _ (by simpa [edit] using hYr)

-- a run leaves its computation a latest run
theorem first_ran (cs : Nat → Comp K V) (s : State K V) (c rk : Nat) :
    ((first cs s c rk).ran c).isSome := by
  have fin : ∀ (X : State K V) e eq w th, (X.ran c).isSome →
      ((finish X c e eq w th).ran c).isSome := by
    intro X e eq w th h
    unfold finish
    split
    · rename_i hn; rw [hn] at h; cases h
    · simp [say]
  have hX : ∀ X : State K V, (X.ran c).isSome → ((ending cs X c (Out.error)).ran c).isSome ∧
      ∀ o, ((ending cs X c o).ran c).isSome := by
    intro X hX
    have key : ∀ o, ((ending cs X c o).ran c).isSome := by
      intro o
      unfold ending
      split
      · unfold stop
        split
        · exact hX
        · exact fin _ _ _ _ _ (by split <;> simpa using hX)
      · have hE : ((edit X c fun r => { r with out := some o }).ran c).isSome := by
          simpa [edit] using hX
        split
        · exact fin _ _ _ _ _ hE
        · exact fin _ _ _ _ _ hE
        · simp only [result]
          split
          · exact fin _ _ _ _ _ hE
          · split
            · exact fin _ _ _ _ _ hE
            · split
              · split
                · exact fin _ _ _ _ _ hE
                · split <;> exact fin _ _ _ _ _ hE
              · split
                · exact fin _ _ _ _ _ hE
                · refine fin _ _ _ _ _ ?_
                  simp only [Model.set]
                  split <;> simpa [say, store] using hE
    exact ⟨key _, key⟩
  simp only [first]
  refine (hX _ ?_).2 _
  simp only [untrack_ran]
  exact exec_ran_some cs c _ _ (by simp [start, say])

theorem Causal.make {cs : Nat → Comp K V} {s : State K V} (h : Causal s) (g : Base cs s) (hA : A2 cs)
    (hU : Unattended cs) : Causal (make cs s) := by
  have key : ∀ M : State K V, Causal M → Causal (mark M s.made M.tick none) := by
    intro M hM
    obtain ⟨e1, _, e3, e4, _⟩ := settle_eq M s.made M.tick none none false
    obtain ⟨a, _, _⟩ := mark_same M s.made M.tick none
    have e1' : (mark M s.made M.tick none).kept = M.kept := e1
    have e3' : (mark M s.made M.tick none).when = M.when := e3
    have e4' : (mark M s.made M.tick none).cause = M.cause := e4
    exact hM.ofr e3' a.pulses a.ran a.runs e4' (fun d x hx => Or.inl (e1' ▸ hx))
  have g1 : Causal (Model.grow cs s) := by
    have e : ∀ d, ∀ x ∈ (put s.kept s.made [] : Nat → List Why) d, x ∈ s.kept d := by
      intro d x hx
      by_cases hd : d = s.made
      · subst hd; simp at hx
      · rwa [put_ne _ _ hd] at hx
    simp only [Model.grow]; split <;> exact h.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl (e d x hx))
  simp only [Model.make]
  split
  · exact g1.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
  · have h2 := key _ g1
    split
    · -- an early effect: its first run, then its act
      obtain ⟨am, _, mm⟩ := mark_same (Model.grow cs s) s.made (Model.grow cs s).tick none
      have hgm : (Model.grow cs s).made = s.made + 1 := by simp only [Model.grow]; split <;> rfl
      have hga : (Model.grow cs s).after = s.after := by simp only [Model.grow]; split <;> rfl
      have hgd : (Model.grow cs s).due = s.due := by simp only [Model.grow]; split <;> rfl
      have hdue : ((mark (Model.grow cs s) s.made (Model.grow cs s).tick none).due s.made).isSome := by
        simp only [mark, settle, Option.isSome_none, Bool.and_false, Bool.false_eq_true, ite_false,
          Model.due]
        split
        · assumption
        · simp [say]
      obtain ⟨c1, _, _⟩ := run_gauge cs _ s.made 0 hA hU h2 hdue
        (fun w hw => by
          rw [am.after, hga] at hw
          have := g.due_made s.made (g.after_due s.made w hw).1; omega)
        (by rw [am.made, hgm]; omega)
        (fun x hx => by
          rw [am.made, hgm]
          rcases mm.fresh x hx with h3 | h3
          · rw [hgd] at h3; have := g.due_made x h3; omega
          · rw [h3]; omega)
      simp only [actnow]
      split
      · rename_i a ha
        exact (act_gauge cs _ s.made a.2 _ _ _ rfl c1 (first_ran cs _ s.made 0)).1
      · exact c1
    · exact h2

theorem Causal.empty : Causal (empty : State K V) where
  when_le c := by simp [Model.empty]
  runs c := by simp [Model.empty]
  cause c _ := by simp [Model.empty, Cause.of]
  kept d x hx := by simp [Model.empty] at hx
  given d r hr := by simp [Model.empty] at hr

-- at a pulse's end no latest run holds a given (Core.given): none is cut
theorem Causal.close {s : State K V} (h : Causal s) (hg : ∀ c r, s.ran c = some r → r.given = []) :
    Causal (close s) where
  when_le c := Nat.le_trans (h.when_le c) (Nat.le_succ _)
  runs c := h.runs c
  cause c hc := by
    have := h.when_le c
    simp only [Model.close] at hc; omega
  kept d x hx := by simp [Model.close] at hx
  given d r hr x hx := by rw [hg d r hr] at hx; cases hx

-- Theorem 1′, a step (A2): the causes' invariant kept, the gauge falls
-- Theorem 1′, a step that is not idle (no attended computes, A2): the causes' invariant kept, and
-- the step ends idle or the gauge falls
theorem gauge_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hA : A2 cs) (hU : Unattended cs) (h : Reach cs rank s) (hca : Causal s) (hph : s.phase ≠ .goes)
    (hni : ¬ idle s) (hs : step cs rank s = some s') :
    Causal s' ∧ s'.made = s.made ∧ (idle s' ∨ gauge s.made s' < gauge s.made s) := by
  have g := h.good hA
  have b := h.base hA.goes
  simp only [Model.step] at hs
  split at hs
  · rename_i hph'
    split at hs
    · rename_i c hc
      cases hs
      obtain ⟨hrd, hcn⟩ := next_ready hc
      simp only [ready, Bool.and_eq_true] at hrd
      have hr : ∀ w, s.after c = some w → s.due w = none := by
        intro w hw; have := hrd.2; simp [hw] at this; exact this
      obtain ⟨h1, h2, h3⟩ := run_gauge cs s c (rank s c) hA hU hca hrd.1 hr hcn b.due_made
      exact ⟨h1, h2, Or.inr (h3 hph')⟩
    · rename_i hnx
      cases hs
      refine ⟨hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx), rfl, ?_⟩
      have hnd : ((List.range s.made).any fun p => (s.due p).isSome) = false := by
        rw [List.any_eq_false]
        intro p _ hp
        have := b.total rank hp
        rw [hnx] at this; cases this
      by_cases hq : queue s = []
      · left
        refine ⟨fun d => ?_, hq, Or.inl rfl⟩
        cases e : s.due d with
        | none => rfl
        | some _ =>
          rw [List.any_eq_false] at hnd
          have := hnd d (List.mem_range.2 (b.due_made d (by simp [e]))); simp [e] at this
      right
      refine gauge_lt_calm ?_ ?_
      · exact Nat.le_refl _
      show dues s.made (fun _ => 2) (fun _ => 1) s + stage { s with phase := .acts } <
        dues s.made (fun _ => 2) (fun _ => 1) s + stage s
      have : stage { s with phase := .acts } = 0 := by simp [stage, hnd]
      rw [this, show stage s = 1 by simp [stage, hph']]
      omega
  · rename_i hph'
    split at hs
    · rename_i a rest ha
      cases hs
      obtain ⟨_, r, hr, _⟩ := g.acts a.1 a.2 (by simp [queue, ha])
      obtain ⟨h1, h2, h3⟩ := act_gauge cs s a.1 a.2 rest s.acts s.made rfl hca (by simp [hr])
      exact ⟨h1, h2, Or.inr (h3 (budget_head _ s a.1 a.2 rest s.acts (by simp [queue, ha])))⟩
    · rename_i he
      split at hs
      · rename_i a rest ha
        cases hs
        obtain ⟨_, r, hr, _⟩ := g.acts a.1 a.2 (by simp [queue, ha])
        obtain ⟨h1, h2, h3⟩ := act_gauge cs s a.1 a.2 s.earlies rest s.made rfl hca (by simp [hr])
        exact ⟨h1, h2, Or.inr (h3 (budget_head _ s a.1 a.2 s.earlies rest (by simp [queue, ha, he])))⟩
      · rename_i ha2
        split at hs
        · rename_i hany
          cases hs
          refine ⟨hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx), rfl, Or.inr ?_⟩
          refine gauge_lt_calm ?_ ?_
          · exact Nat.le_refl _
          show dues s.made (fun _ => 2) (fun _ => 1) s + stage { s with phase := .runs, round := s.round + 1 } <
            dues s.made (fun _ => 2) (fun _ => 1) s + stage s
          have e1 : stage s = 2 := by simp [stage, hph', hany]
          have e2 : stage { s with phase := .runs, round := s.round + 1 } = 1 := by simp [stage]
          rw [e1, e2]
          omega
        · rename_i hany
          exfalso; apply hni
          refine ⟨fun d => ?_, by simp [queue, he, ha2], Or.inl hph'⟩
          cases e : s.due d with
          | none => rfl
          | some _ =>
            have hdm := b.due_made d (by simp [e])
            simp only [Bool.not_eq_true] at hany
            rw [List.any_eq_false] at hany
            have := hany d (List.mem_range.2 hdm); simp [e] at this
  · rename_i hph'; exact absurd hph' hph

-- any step (no attended computes, A2) keeps the causes' invariant
theorem causal_step {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hA : A2 cs) (hU : Unattended cs) (h : Reach cs rank s) (hca : Causal s)
    (hs : step cs rank s = some s') : Causal s' := by
  by_cases hph : s.phase = .goes
  · simp only [Model.step, hph] at hs
    split at hs
    · cases hs; rw [bury_un hU]; exact hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
    · cases hs; exact hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
  by_cases hi : idle s
  · obtain ⟨hd, hq, hph'⟩ := hi
    have hph' : s.phase = .acts := by rcases hph' with e | e; exact e; exact absurd e hph
    have he : s.earlies = [] := by simp [queue] at hq; exact hq.1
    have ha : s.acts = [] := by simp [queue] at hq; exact hq.2
    simp only [Model.step, hph', he, ha] at hs
    split at hs
    · cases hs; exact hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
    · split at hs
      · cases hs
      · cases hs; exact hca.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
  · exact (gauge_step hA hU h hca hph hi hs).1

theorem Reach.causal {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hU : Unattended cs) (h : Reach cs rank s) : Causal s := by
  induction h with
  | empty => exact Causal.empty
  | make h1 ih => exact ih.make (h1.base hA.goes) hA hU
  | @write s kvs _ ih =>
    obtain ⟨st, h1, _⟩ := stores_shape s kvs
    simp only [Model.write, h1]
    exact (ih.ofr (s' := { s with store := st }) rfl rfl rfl rfl rfl
      (fun d x hx => Or.inl hx)).told _
  | tell keys _ ih => exact ih.told keys
  | begin _ ih => exact ih.ofr rfl rfl rfl rfl rfl (fun d x hx => Or.inl hx)
  | step h1 h2 ih => exact causal_step hA hU h1 ih h2
  | close h1 _ ih => exact ih.close (h1.good hA).given

-- Theorem 1′ (proof.md §7.2): with cycles, under A2, with no attended computes and the host's
-- changes from outside, every pulse from a reachable state ends: the gauge falls until idle,
-- then the goings
theorem steps_close {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} (hA : A2 cs)
    (hU : Unattended cs) (n : Nat) :
    ∀ (m : Nat) (s : State K V), Reach cs rank s → (s.phase = .goes → idle s) → s.made = n →
      gauge n s ≤ m → ∃ f, (steps cs rank f s).isSome := by
  intro m
  induction m using Nat.strongRecOn with
  | ind m ihm =>
    intro s hr hP hn hm
    have g := hr.base hA.goes
    by_cases hi : idle s
    · exact ⟨gm s.made s + 1, idle_end hA.goes _ s g hi (by omega)⟩
    have hph : s.phase ≠ .goes := fun e => hi (hP e)
    cases h : step cs rank s with
    | none => exact ⟨1, by simp [steps, h]⟩
    | some s' =>
      obtain ⟨_, h1, h2⟩ := gauge_step hA hU hr (hr.causal hA hU) hph hi h
      have hP' := step_goes hA.goes g hP h
      rcases h2 with h2 | h2
      · obtain ⟨f, hf⟩ : ∃ f, (steps cs rank f s').isSome :=
          ⟨_, idle_end hA.goes _ s' ((Reach.step hr h).base hA.goes) h2 (Nat.lt_succ_self _)⟩
        exact ⟨f + 1, by simp only [steps, h]; exact hf⟩
      · rw [hn] at h1 h2
        obtain ⟨f, hf⟩ := ihm (gauge n s') (by omega) s' (.step hr h) hP' h1 (Nat.le_refl _)
        exact ⟨f + 1, by simp only [steps, h]; exact hf⟩

theorem cycles {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hU : Unattended cs) (h : Reach cs rank s) :
    ∃ f, (pulse cs rank f s).isSome :=
  steps_close hA hU s.made _ (begin s) (.begin h) (fun e => by simp [begin] at e) rfl (Nat.le_refl _)

-- Theorem 1′'s bound: n made, a acts queued at the start. worth n n is about 2 n^n
def limit (n a : Nat) : Nat := (n * worth n n + a * deed n n + 1) * big n

theorem level_le (n : Nat) (s : State K V) (z : Nat) : level n s z ≤ n := by
  have := tot_const (n := n) (x := 1) (f := fun y => if y = z ∨ inside s.went (s.kept z) y = true then 0 else 1)
    (fun y _ => by split <;> omega)
  unfold level; omega

theorem room_le (n : Nat) (w : Nat → Bool) (xs : List Why) : room n w xs ≤ n := by
  have := tot_const (n := n) (x := 1) (f := fun y => if inside w xs y = true then 0 else 1)
    (fun y _ => by split <;> omega)
  unfold room; omega

theorem later_le (n : Nat) (s : State K V) (e : Nat) : later n s e ≤ n := by
  unfold later; split <;> exact room_le _ _ _

theorem gauge_le (n : Nat) (s : State K V) : gauge n s < limit n (queue s).length := by
  have h1 : tot n (term n s) ≤ n * worth n n := by
    apply tot_const; intro z _; unfold term; split
    · exact worth_mono n (level_le n s z)
    · exact Nat.zero_le _
  have h2 : ((queue s).map fun a => deed n (later n s a.1)).sum ≤ (queue s).length * deed n n := by
    have : ∀ l : List (Nat × V), (l.map fun a => deed n (later n s a.1)).sum ≤ l.length * deed n n := by
      intro l; induction l with
      | nil => simp
      | cons a l ih =>
        simp only [List.map_cons, List.sum_cons, List.length_cons, Nat.succ_mul]
        have := deed_mono n (later_le n s a.1); omega
    exact this (queue s)
  have h3 := quiet_lt n s
  have h4 : budget n s ≤ n * worth n n + (queue s).length * deed n n := by unfold budget; omega
  have h5 : budget n s * big n ≤ (n * worth n n + (queue s).length * deed n n) * big n :=
    Nat.mul_le_mul_right _ h4
  unfold gauge limit
  rw [Nat.succ_mul]
  omega

-- Theorem 1′ with its bound
-- with no attended computes, nothing is asleep and nothing dying, ever

theorem exec_un {cs : Nat → Comp K V} (hU : Unattended cs) (c : Nat) :
    ∀ (p : Prog K V) (s : State K V),
      (exec cs c s p).1.dying = s.dying ∧ (exec cs c s p).1.asleep = s.asleep
  | .value _, _ => ⟨rfl, rfl⟩
  | .error, _ => ⟨rfl, rfl⟩
  | .pending, _ => ⟨rfl, rfl⟩
  | .write k v next, s => by
    simp only [exec]
    obtain ⟨h1, h2⟩ := exec_un hU c next (changed cs (store s k v) [k] (some c))
    rw [h1, h2]; simp [store]
  | .read k next, s => by
    simp only [exec]
    have hw : ∀ X : State K V, wake cs X k = X := fun X => by unfold wake; rw [attending_un hU]
    simp only [hw, ite_self]
    generalize hX : edit { s with reads := put s.reads c (s.reads c ++ [k]) } c
      (fun r => { r with seen := r.seen ++ [(k, s.store k)] }) = X
    have e1 : X.dying = s.dying ∧ X.asleep = s.asleep := by rw [← hX]; exact ⟨rfl, rfl⟩
    split
    · obtain ⟨h1, h2⟩ := exec_un hU c _ X; exact ⟨h1.trans e1.1, h2.trans e1.2⟩
    · split
      · obtain ⟨h1, h2⟩ := exec_un hU c _ X; exact ⟨h1.trans e1.1, h2.trans e1.2⟩
      · split
        · exact e1
        · obtain ⟨h1, h2⟩ := exec_un hU c _ (edit X c fun r => { r with values := ins _ r.values })
          exact ⟨h1.trans e1.1, h2.trans e1.2⟩

theorem ending_un (cs : Nat → Comp K V) (s : State K V) (c : Nat) (o : Out V) :
    (ending cs s c o).dying = s.dying ∧ (ending cs s c o).asleep = s.asleep := by
  have fin : ∀ (X : State K V) e eq w th, X.dying = s.dying → X.asleep = s.asleep →
      (finish X c e eq w th).dying = s.dying ∧ (finish X c e eq w th).asleep = s.asleep :=
    fun X e eq w th h1 h2 => ⟨by simp [h1], by simp [h2]⟩
  unfold ending
  split
  · unfold stop
    split
    · exact ⟨rfl, rfl⟩
    · exact fin _ _ _ _ _ (by split <;> rfl) (by split <;> rfl)
  · split
    · exact fin _ _ _ _ _ rfl rfl
    · exact fin _ _ _ _ _ rfl rfl
    · simp only [result]
      split
      · exact fin _ _ _ _ _ rfl rfl
      · split
        · exact fin _ _ _ _ _ rfl rfl
        · split
          · split
            · exact fin _ _ _ _ _ rfl rfl
            · split <;> exact fin _ _ _ _ _ rfl rfl
          · split
            · exact fin _ _ _ _ _ rfl rfl
            · refine fin _ _ _ _ _ ?_ ?_ <;> (simp only [Model.set]; split <;> simp [say, store, edit])

theorem first_un {cs : Nat → Comp K V} (hU : Unattended cs) (s : State K V) (c rk : Nat) :
    (first cs s c rk).dying = s.dying ∧ (first cs s c rk).asleep = s.asleep := by
  simp only [first]
  rw [untrack_un hU]
  obtain ⟨h3, h4⟩ := exec_un hU c (cs c).f (start s c rk)
  generalize exec cs c (start s c rk) (cs c).f = x at h3 h4 ⊢
  obtain ⟨E, o⟩ := x
  simp only at h3 h4 ⊢
  refine ⟨(ending_un cs _ c o).1.trans ?_, (ending_un cs _ c o).2.trans ?_⟩
  · exact h3
  · exact h4

theorem act_un (cs : Nat → Comp K V) (s : State K V) (e : Nat) (v : V) :
    (act cs s e v).dying = s.dying ∧ (act cs s e v).asleep = s.asleep := by
  unfold act
  split
  · exact ⟨rfl, rfl⟩
  · split
    · exact ⟨rfl, rfl⟩
    · dsimp only
      simp only [say]
      have : ∀ (ws : List (K × V)) (s1 : State K V),
          (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1).dying = s1.dying ∧
          (ws.foldl (fun s kv => changed cs (store s kv.1 kv.2) [kv.1] (some e)) s1).asleep =
            s1.asleep := by
        intro ws; induction ws with
        | nil => intro s1; exact ⟨rfl, rfl⟩
        | cons kv ws ih =>
          intro s1; simp only [List.foldl_cons]
          obtain ⟨h1, h2⟩ := ih _
          exact ⟨h1.trans (by simp [store]), h2.trans (by simp [store])⟩
      obtain ⟨h1, h2⟩ := this _ _
      exact ⟨h1, h2⟩

-- a step, and the host's calls, with no attended computes: still nothing dying, nothing asleep
theorem step_un {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s s' : State K V}
    (hU : Unattended cs) (h : step cs rank s = some s') (hd : s.dying = []) :
    s'.dying = [] ∧ s'.asleep = s.asleep := by
  simp only [Model.step] at h
  split at h
  · split at h
    · cases h; obtain ⟨h1, h2⟩ := first_un hU s _ _; exact ⟨h1.trans hd, h2⟩
    · cases h; exact ⟨hd, rfl⟩
  · split at h
    · cases h; obtain ⟨h1, h2⟩ := act_un cs _ _ _; exact ⟨h1.trans hd, h2⟩
    · split at h
      · cases h; obtain ⟨h1, h2⟩ := act_un cs _ _ _; exact ⟨h1.trans hd, h2⟩
      · split at h
        · cases h; exact ⟨hd, rfl⟩
        · split at h
          · cases h
          · cases h; exact ⟨hd, rfl⟩
  · split at h
    · rename_i d rest hdr; rw [hd] at hdr; cases hdr
    · cases h; exact ⟨hd, rfl⟩

theorem Reach.un {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hU : Unattended cs) (h : Reach cs rank s) : s.dying = [] ∧ ∀ c, s.asleep c = false := by
  induction h with
  | empty => exact ⟨rfl, fun _ => rfl⟩
  | @make s _ ih =>
    have g1 : (Model.grow cs s).dying = [] ∧ ∀ c, (Model.grow cs s).asleep c = false := by
      simp only [Model.grow]
      split <;> exact ⟨ih.1, fun c => by by_cases e : c = s.made <;> simp [e, ih.2 c]⟩
    simp only [Model.make, hU s.made, Bool.false_and, Bool.false_eq_true, ite_false]
    have g2 : (mark (Model.grow cs s) s.made (Model.grow cs s).tick none).dying = [] ∧
        ∀ c, (mark (Model.grow cs s) s.made (Model.grow cs s).tick none).asleep c = false := by
      simp only [mark_dying, mark_asleep]; exact g1
    split
    · simp only [actnow]
      obtain ⟨h1, h2⟩ := first_un hU (mark (Model.grow cs s) s.made (Model.grow cs s).tick none) s.made 0
      split
      · obtain ⟨h3, h4⟩ := act_un cs _ s.made _
        refine ⟨?_, fun c => ?_⟩
        · rw [h3]; exact h1.trans g2.1
        · rw [h4]; show (first cs _ s.made 0).asleep c = false; rw [h2]; exact g2.2 c
      · exact ⟨h1.trans g2.1, fun c => by rw [h2]; exact g2.2 c⟩
    · exact g2
  | @write s kvs _ ih =>
    obtain ⟨st, h1, _⟩ := stores_shape s kvs
    simp only [Model.write, h1]
    exact ⟨by simp [ih.1], fun c => by simp [ih.2 c]⟩
  | tell keys _ ih => exact ⟨by simp [ih.1], fun c => by simp [ih.2 c]⟩
  | begin _ ih => exact ih
  | step _ h ih =>
    obtain ⟨h1, h2⟩ := step_un hU h ih.1
    exact ⟨h1, fun c => by rw [h2]; exact ih.2 c⟩
  | close _ _ ih => exact ih

-- idle, nothing dying: the pulse ends within two steps
theorem idle_quick {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hi : idle s) (hd : s.dying = []) : (steps cs rank 2 s).isSome := by
  obtain ⟨hdue, hq, hph⟩ := hi
  have he : s.earlies = [] := by simp [queue] at hq; exact hq.1
  have ha : s.acts = [] := by simp [queue] at hq; exact hq.2
  have hny : ((List.range s.made).any fun p => (s.due p).isSome) = false := by
    rw [List.any_eq_false]; intro p _; simp [hdue p]
  rcases hph with hph | hph
  · simp [steps, Model.step, hph, he, ha, hny, hd]
  · simp [steps, Model.step, hph, hd, he, ha, hny]

-- Theorem 1′ with its bound (no attended computes)
theorem cycles_bound {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hA : A2 cs) (hU : Unattended cs) (h : Reach cs rank s) :
    (pulse cs rank (limit s.made (queue s).length + 2) s).isSome := by
  have key : ∀ (f : Nat) (t : State K V), Reach cs rank t → t.made = s.made → t.phase ≠ .goes →
      gauge s.made t + 2 < f → (steps cs rank f t).isSome := by
    intro f
    induction f with
    | zero => intro t _ _ _ h; omega
    | succ f ih =>
      intro t ht hm hph hf
      by_cases hi : idle t
      · have := idle_quick (cs := cs) (rank := rank) hi (ht.un hU).1
        exact steps_more 2 (f - 1) t this |> fun h => by
          rw [show 2 + (f - 1) = f + 1 by omega] at h; exact h
      simp only [steps]
      cases hs : step cs rank t with
      | none => rfl
      | some t' =>
        simp only
        obtain ⟨_, h1, h2⟩ := gauge_step hA hU ht (ht.causal hA hU) hph hi hs
        rcases h2 with h2 | h2
        · have := idle_quick (cs := cs) (rank := rank) h2 ((Reach.step ht hs).un hU).1
          exact steps_more 2 (f - 2) t' this |> fun h => by
            rw [show 2 + (f - 2) = f by omega] at h; exact h
        · by_cases hi' : idle t'
          · have := idle_quick (cs := cs) (rank := rank) hi' ((Reach.step ht hs).un hU).1
            exact steps_more 2 (f - 2) t' this |> fun h => by
              rw [show 2 + (f - 2) = f by omega] at h; exact h
          have hph' : t'.phase ≠ .goes := fun e =>
            hi' (step_goes hA.goes (ht.base hA.goes) (fun e' => absurd e' hph) hs e)
          exact ih t' (.step ht hs) (h1.trans hm) hph' (by rw [hm] at h2; omega)
  exact key _ (begin s) (.begin h) rfl (by simp [begin]) (by
    have := gauge_le s.made (begin s); simp [begin, queue] at this ⊢; omega)

-- Theorem 1 with its bound, no attended computes: within bound made (acts queued) steps, two more
theorem termination_bound {cs : Nat → Comp K V} {rank : State K V → Nat → Nat} {s : State K V}
    (hQ : Quiet cs) (hU : Unattended cs) (hac : ∀ x, ¬TransGen (among s.made (feeds cs)) x x)
    (h : Reach cs rank s) : (pulse cs rank (bound s.made (queue s).length + 2) s).isSome := by
  have key : ∀ (f : Nat) (t : State K V), Base cs t → t.dying = [] → (∀ c, t.asleep c = false) →
      t.made = s.made → t.phase ≠ .goes → measure cs s.made t + 2 < f → (steps cs rank f t).isSome := by
    intro f
    induction f with
    | zero => intro t _ _ _ _ _ h; omega
    | succ f ih =>
      intro t g hd hz hm hph hf
      by_cases hi : idle t
      · have := idle_quick (cs := cs) (rank := rank) hi hd
        exact steps_more 2 (f - 1) t this |> fun h => by
          rw [show 2 + (f - 1) = f + 1 by omega] at h; exact h
      simp only [steps]
      cases hs : step cs rank t with
      | none => rfl
      | some t' =>
        simp only
        obtain ⟨hd', hz'⟩ := step_un hU hs hd
        obtain ⟨h1, _, h3⟩ := measure_step hm hac g hph hi hs
        have hz0 : sleepers s.made t = 0 := by
          unfold sleepers
          rw [tot_cong (g := fun _ => 0) (fun c _ => by simp [hz c])]
          exact tot_zero _
        rcases h3 with h3 | h3 | h3
        · have := idle_quick (cs := cs) (rank := rank) h3 hd'
          exact steps_more 2 (f - 2) t' this |> fun h => by
            rw [show 2 + (f - 2) = f by omega] at h; exact h
        · omega
        · by_cases hi' : idle t'
          · have := idle_quick (cs := cs) (rank := rank) hi' hd'
            exact steps_more 2 (f - 2) t' this |> fun h => by
              rw [show 2 + (f - 2) = f by omega] at h; exact h
          have hph' : t'.phase ≠ .goes := fun e =>
            hi' (step_goes hQ g (fun e' => absurd e' hph) hs e)
          exact ih t' (g.step hQ hs) hd' (fun c => by rw [hz']; exact hz c) h1 hph' (by omega)
  have g := h.base hQ
  obtain ⟨hd, hz⟩ := h.un hU
  exact key _ (begin s) ⟨g.1, g.2, g.3, g.4, g.5, g.6, g.7, g.8, g.9⟩ hd hz rfl (by simp [begin])
    (by have := measure_le cs s; omega)

-- H, checked: a height for the made ones, falling along H, makes H acyclic among them
theorem acyclic_of_height {cs : Nat → Comp K V} {n : Nat} (ht : Nat → Nat)
    (h : ∀ c d, c < n → d < n → feeds cs c d → ht d < ht c) :
    ∀ x, ¬TransGen (among n (feeds cs)) x x := by
  have key : ∀ a b, TransGen (among n (feeds cs)) a b → ht b < ht a := by
    intro a b hab
    induction hab with
    | single hab => exact h _ _ hab.1 hab.2.1 hab.2.2
    | tail _ hbc ih => exact Nat.lt_trans (h _ _ hbc.1 hbc.2.1 hbc.2.2) ih
  intro x hx
  exact Nat.lt_irrefl _ (key x x hx)

-- and keys listed for each, covering what f may read and what it may write: a height checked
-- on the lists (by decide) is one for H
theorem feeds_of_lists {cs : Nat → Comp K V} (rd wr : Nat → List K)
    (hrd : ∀ c k, (cs c).f.reads k → k ∈ rd c) (hwr : ∀ c k, (cs c).writes k → k ∈ wr c)
    {c d : Nat} (h : feeds cs c d) : ∃ k ∈ wr c, k ∈ rd d := by
  obtain ⟨k, h1, h2⟩ := h
  exact ⟨k, hwr c k h1, hrd d k h2⟩


end Model

-- checks: 03-diamond's H is acyclic, so Theorem 1 covers it; the bounds on model scenarios
namespace Model.Check

open Model Relation

-- 03-diamond: 0 → 2, 1 → 2, 2 → 3; heights 2, 2, 1, 0
example : ∀ x, ¬TransGen (among 4 (feeds diamond)) x x := by
  apply acyclic_of_height (fun c => if c < 2 then 2 else if c = 2 then 1 else 0)
  intro c d hc hd ⟨k, hw, hr⟩
  have hc' : c = 0 ∨ c = 1 ∨ c = 2 ∨ c = 3 := by omega
  have hd' : d = 0 ∨ d = 1 ∨ d = 2 ∨ d = 3 := by omega
  rcases hc' with rfl | rfl | rfl | rfl <;> rcases hd' with rfl | rfl | rfl | rfl <;>
    simp_all [diamond, cmp, eff, Comp.writes, Prog.writes, Prog.reads] <;> (subst hw; revert hr; decide)

-- the bounds as fuel: 12-loop-set (cyclic, A2) in 30, 30-loop-stopped in 319, 03-diamond's first
-- pulse in Theorem 1's (loose) bound
#guard (pulse selfloop rk (limit 1 0) (make selfloop empty)).isSome
#guard (pulse c1 rk (limit 2 0) (makes c1 2 empty)).isSome
#guard (pulse diamond rk (bound 4 0) (makes diamond 4 (write diamond empty [("x", .num 1)]))).isSome

end Model.Check
