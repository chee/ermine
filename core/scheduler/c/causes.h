// causes: within one pulse, what led to each run: its computation, and the causes of each change
// that marked it. so a mark on a computation can be asked: did it come out of a run of that same
// computation? then it is a loop through it. nothing is kept past the pulse: a cause from an
// earlier one is cut by the scheduler to its computation alone (scheduler.c, cause_of).
// a cause is counted: whoever holds one (a run, a computation's kept set, a later cause) holds a
// count; cs_release lets one go.
#ifndef CAUSES_H
#define CAUSES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "ptrmap.h"

// what a cause is about: embedded in the computation
typedef struct cs_item {
	void *owner;
	uint64_t n;
	// the causes of the marks since its last run that ended done
	pm kept;
} cs_item;

typedef struct cs_cause {
	cs_item *of;
	struct cs_cause **parents;
	size_t count;
	size_t refs;
} cs_cause;

typedef struct causes causes;

causes *cs_new(void);
void cs_free(causes *c);

cs_cause *cs_ref(cs_cause *c);
void cs_release(cs_cause *c);

// a run of t, caused by what caused each mark it was given: a new cause, one count to the caller
cs_cause *cs_run(causes *c, cs_item *t, cs_cause *const *given, size_t count);
// a mark's causes, kept on t until the pulse's end
void cs_keep(causes *c, cs_item *t, cs_cause *cause);
// t forgets its kept causes
void cs_forget(cs_item *t);
// a loop through t: cause came out of a run of t in this pulse. the computations on the loop
// (items): those of the causes on a path from cause back to a run of t, in the order made, in a
// new array of *count; or NULL
cs_item **cs_loop(causes *c, cs_cause *cause, cs_item *t, size_t *count);
// a mark kept on t came out of a run of of in this pulse
bool cs_from(causes *c, const cs_item *t, const cs_item *of);
// the pulse's end: causes and runs forgotten
void cs_end(causes *c);

#endif
