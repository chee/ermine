// clingy (typescript/clingy.ts), in C; prefix cl_. keys of the caller's, each known tracked or not,
// the caller told when its last tracker goes. built on sc_on_tracking_start and sc_on_tracking_end
// only. the same rules as clingy.ts, which says them once.
//
//   cl_clingy *c = cl_new(scheduler, settle, data);   // settle(key, data): its last tracker gone
//   cl_add(c, key);                                   // a key made now: no run tracks it yet
//   cl_tracked(c, key);                               // a run tracks it now
//   cl_drop(c, key);                                  // never told of again
//   cl_free(c);                                       // before sc_free: it takes its listeners away
//
// keys are the caller's, compared by identity, never NULL; kept only as pointers. out of memory
// aborts.
#ifndef CLINGY_H
#define CLINGY_H

#include <stdbool.h>

#include "../../../core/scheduler/c/scheduler.h"

typedef struct cl_clingy cl_clingy;

cl_clingy *cl_new(sc_scheduler *s, void (*go)(const void *key, void *data), void *data);
// takes its listeners from the scheduler (still alive) and frees itself; tells nothing
void cl_free(cl_clingy *c);

// added already: nothing
void cl_add(cl_clingy *c, const void *key);
// added, not dropped
bool cl_has(const cl_clingy *c, const void *key);
bool cl_tracked(const cl_clingy *c, const void *key);
void cl_drop(cl_clingy *c, const void *key);

#endif
