// The merge rule "eg-walker" (extensions/sync/typescript/egwalker.ts, its header the exact rules), in
// C, as its keeping walker (walker.ts): the replay's state kept between merges for one node's history
// (every write, element and removal made, with its id; which commits are in, each one's version), and
// a merge asked for later applies only the commits it does not have yet, then reads the heads'
// version. The pure rule (state NULL) is the same walker built for the one merge and let go of: by
// rule 1 any start gives the same merge, so it gives egwalker.ts's tables.
//
// A state is built again (since, from the heads asked) as walker.ts's is: when asked for the
// history's own heads and a commit there does not follow from the start (a fork from before it), or
// more than its limit of commits came since it was built; when given another history. Heads it
// can't give that are not the history's (a merge commit's parents, from before the start): a fresh
// throwaway build, the state kept. Everything a state holds is in an arena of its own, freed whole
// when it is dropped or built again. Out of memory aborts
#ifndef EG_EGWALKER_H
#define EG_EGWALKER_H

#include "replay.h"

// more commits than this applied since it was built: built again from a later start, the next time
// the history's heads are asked for
#define EG_LIMIT 1024

// "eg-walker": merge with state NULL is the pure rule; create makes a keeping walker (EG_LIMIT)
extern const rp_rule eg_rule;

// a keeping walker with its own limit (fewer, to see it built again); eg_rule.free lets it go
void *eg_walker(size_t limit);

#endif
