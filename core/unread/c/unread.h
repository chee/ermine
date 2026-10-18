// unread (core/unread/typescript/unread.ts), in C: an entry's writes change in place what
// its own earlier writes copied, until someone reads it. a write copies what it changes that it
// does not own (along its patches' paths only, each container shallowly: a new list, map or
// typed array holding one reference on each item) and owns the copies; the next write changes
// those in place, as op_apply's in_place does. a read lets go of all of it: what a reader holds is
// never changed under it, and the next write copies again
//
// owned: only copies made here, from the root down along the paths written, and the list a span
// move takes out (op_apply gives it to owned as it lands). never a patch's value (op puts it in as
// given: the caller's; an owned container in one, of any entry, is let go of first: a walk over
// every container in each patch's value), nor what a write takes out (its undo holds it). each
// patch is owned and applied in the tree the ones before it left. a write that fails puts back
// what landed and changes nothing, which container is where too
//
// memory: the owned set of an entry holds one reference (op_ref) on every container in it, so
// a container in a set is never freed and its address never reused; released when it leaves the
// set (a write took it out, un_read, un_free). nothing else is held: so an entry's copies live
// until its read or un_free. the entry is the caller's (node.h); un_read it before it goes
#ifndef UN_UNREAD_H
#define UN_UNREAD_H

#include <stddef.h>

#include "../../../core/node/c/node.h"
#include "../../../core/scheduler/c/scheduler.h"

typedef struct un_unread un_unread;

// NULL when out of memory
un_unread *un_new(void);
// lets go of everything owned, for every entry
void un_free(un_unread *u);

// nd_update (update.h) for an entry whose value is changed in place where this owns it: the
// patches, in order, to the entry's value; its change then the header with has_op, the patches
// as given and their undo (the patches' undos, the last patch's first). memory as nd_update's:
// patches and header pieces borrowed until the next update or nd_free_entry; the undo is the
// entry's own. op's code on an invalid patch, *failed its index in the whole write (may be
// NULL), and nothing changes
int un_update(un_unread *u, nd_entry *entry, const op_patch *patches, size_t n, ch_header header,
	size_t *failed);

// what readers hold now: nothing of the entry's is owned, the next write copies
void un_read(un_unread *u, const nd_entry *entry);

// a value held past now (a computation's result): every owned container in it, in any entry,
// let go (its reference released), with all under it. handed, n of them (NULL, 0: none): what the
// run was given; at a container in it, what is owned under it is let go (only owned ones are
// walked) and no deeper. the rest walked (lists, maps, typed arrays), a container seen twice once:
// the seen set is made at the first step into a nested container, so a flat value makes none.
// a copy's set is found by the owner map, as in unread.ts
void un_kept(un_unread *u, const op_value *value, const op_value *const *handed, size_t n);

// a scheduler's run ends wired to u: what a run keeps past it (sc_more's kept: a compute's result
// given to set, an effect's to be acted on) is kept; one that is not a container holds nothing.
// the scheduler's values are taken as op_value * (as the harness world's are). handed: NULL, or the
// host's function from a key the run tracked to the value that key gave it (NULL: none, or not a
// container); with it and reads, those values are the handed set, else the result is walked whole.
// ctx is passed to it. a write (un_update) made in a run's body (before sc_on_run_return) is the
// run's own: in place, as any, so what the run read can change under it by its own writes. one
// made after its body returned, before its end (its set, given the result): what the run's reads
// gave it (held till the run ends) let go of first; no handed, all of the entry written. a run
// awaiting goes on no longer: its landing's set is not seen. the wiring, for un_unwire (u keeps
// it until un_free)
typedef struct un_wiring un_wiring;
un_wiring *un_keeping(sc_scheduler *s, un_unread *u,
	const op_value *(*handed)(const void *key, void *ctx), void *ctx);
// its listeners removed (before the scheduler is freed), what it held let go of
void un_unwire(un_wiring *w);

#endif
