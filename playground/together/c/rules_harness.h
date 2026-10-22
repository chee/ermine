// The merge rules a harness knows (history_harness.c, sync_harness.c), the first the one a merge
// asks for when none is named: rules_harness.c's together's own ("serial/1" and "serial/2", a rule
// for testing merging, typescript/rules_harness.ts's, its header the rule), or a harness built with others
// links its own list (playground/egwalker/c/rules_harness.c)
#ifndef HARNESS_RULES_H
#define HARNESS_RULES_H

#include "replay.h"

extern const rp_rule *const harness_rules[];
extern const size_t harness_rules_length;

#endif
