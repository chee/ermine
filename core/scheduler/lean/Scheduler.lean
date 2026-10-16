-- the scheduler (core/scheduler/typescript), in Lean. LLM generated working output
--
-- notes (2026-10-16: attended computes, early effects, nested info, rising ranks):
-- - modelled: attended computes (asleep till their key is tracked, woken by a read of it, going
--   at a pulse's end once nothing is due: Model.lean's wake, untrack, bury, the `.goes` phase),
--   early effects (run and act at their make; a round is runs, early acts, acts), scope info
--   required and nested with ["owner", ...] (Scopes.lean), the going path in the tree
--   (Scopes.bury), order.ts's ranks made whole once then only rising (Order.lean, RankOrder.lean)
-- - every theorem restored, nothing left unproved. what changed in their statements:
--   - A2 is now also Quiet: no going writes. without it a going's teardown write marks the going
--     one itself, which then runs asleep (Model.Check, selfgo; the TS the same)
--   - Theorem 1 (termination) with attended computes, given Quiet and H acyclic. Theorem 1′
--     (cycles) and both fuel bounds with no attended computes (Unattended)
--   - Theorem 4 and 4.1 (Once) need nothing asleep at the round's start: a wake makes one due
--     mid-round
--   - Theorem 3 (act_fresh) holds for early acts too; but an early act's writes mark at once, so
--     after one the store is not settled (C7 covers early writes)
--   - make_kept holds for effects not early only
--   - Wiring: order.ts's next is the model's next run with the order's own ranks (oranks), not
--     rank.ts's of the state; those ranks are ranked over the model's edges (next_reach)
-- - finding, termination: going writes can loop a pulse for ever with A2 and H acyclic
--   (Model.Check, endless; the TS the same). the scheduler needs a guard (Termination.lean)
-- - model fixes: bury drops the going one's cut (scheduler.ts keeps cut on the run it drops);
--   grow gives a new computation an empty kept (a new object)
import Scheduler.Basic
import Scheduler.Rank
import Scheduler.Order
import Scheduler.Scopes
import Scheduler.Causes
import Scheduler.Model
import Scheduler.Quiescence
import Scheduler.RankOrder
import Scheduler.Termination
import Scheduler.Once
import Scheduler.Wiring
import Scheduler.Async
