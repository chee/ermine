// Causes: within one pulse, what led to each run. A cause names its computation and the causes
// of each change that marked it, so a mark can be asked whether it came out of a run of that
// same computation (a loop). Causes are counted; cs_release lets one go. Nothing lasts past the
// pulse: the scheduler cuts an older cause down to its computation alone.
#ifndef CAUSES_H
#define CAUSES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../changeable/c/ptrmap.h"

// What a cause is about. Embedded in the computation, which is found again by its address.
typedef struct cs_item {
	uint64_t n;
	// The causes of the marks since its last run that ended done.
	pm kept;
} cs_item;

typedef struct causes causes;

typedef struct cs_cause {
	cs_item *of;
	// The causes given to its run: inline in small when few, else in a block of their own.
	struct cs_cause **parents;
	size_t count;
	size_t refs;
	causes *home;
	struct cs_cause *small[2];
} cs_cause;

causes *cs_new(void);
// Causes still held (say by a run held past sc_free) stay valid; c goes with the last release.
void cs_free(causes *c);

cs_cause *cs_ref(cs_cause *c);
void cs_release(cs_cause *c);

// A run of t, caused by whatever caused each mark it was given. The caller gets one count.
cs_cause *cs_run(causes *c, cs_item *t, cs_cause *const *given, size_t count);
// A mark's causes, held on t until the pulse's end.
void cs_keep(causes *c, cs_item *t, cs_cause *cause);
// t forgets the causes held on it. The set keeps its memory; pm_clear(&t->kept) frees it.
void cs_forget(cs_item *t);
// A loop through t: cause came out of a run of t in this pulse. Returns the computations on
// the loop in a new array of *count, or NULL.
cs_item **cs_loop(causes *c, cs_cause *cause, cs_item *t, size_t *count);
// True if a mark held on t came out of a run of "of" in this pulse.
bool cs_from(causes *c, const cs_item *t, const cs_item *of);
// The pulse's end: causes and runs are forgotten; released causes keep their memory for reuse.
void cs_end(causes *c);

#endif
