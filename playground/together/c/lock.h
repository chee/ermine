// lock.h: the lock, as typescript/lock.ts has it, in C. what a commit is closed into before any carrier
// takes it, and opened from where it lands (encryption, or nothing). a carrier (the Subduction stack, a
// gateway) calls it; none of them owns it. doc: the document's 32 bytes; name and parents: the commit's,
// given so a lock can bind them (they travel in clear: a carrier needs the history's shape). only
// lk_unlocked is built. header only: a stack that takes a lock needs no more source
//
// sans-IO as the device is: open and close answer at once (lock.ts may answer later). close is asked of
// a stored commit's seal, a fragment's blob and an ephemeral commit's bytes before they leave (stored,
// sent); open of what lands, before the seal or the commit is read. a name that is a commit's is CM_NAME
// bytes, a fragment's is the name of the bytes closed, a multihash of their BLAKE3 as a commit's name is
// (parents: its boundary's names)
#ifndef LK_LOCK_H
#define LK_LOCK_H

#include "../../../ermine/encoding/c/commit.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

// what close gives: the bytes to carry, borrowed from what it was given or malloc'd (owned: the
// caller frees them); NULL: it could not close them, and the commit goes nowhere
typedef struct {
	const uint8_t *bytes;
	size_t length;
	bool owned;
} lk_closed;

// what open gives: the bytes close was given (OPEN, as for lk_closed); not yet (WAIT: no key here yet);
// or never (REFUSED, why: borrowed, good for the call; its text is shown beside the code lock wherever
// the refusal shows). a stored commit or a fragment that waits is held and opened again when the lock
// changes (the device's changed); an ephemeral commit that waits is dropped, and comes back with its
// device's next beat (it is sent again)
typedef enum { LK_OPEN, LK_WAIT, LK_REFUSED } lk_kind;
typedef struct {
	lk_kind kind;
	const uint8_t *bytes;
	size_t length;
	bool owned;
	const char *refused;
} lk_opened;

typedef struct {
	lk_closed (*close)(void *context, const uint8_t doc[32], const uint8_t name[CM_NAME],
		const uint8_t (*parents)[CM_NAME], size_t parent_count, const uint8_t *bytes, size_t length);
	lk_opened (*open)(void *context, const uint8_t doc[32], const uint8_t *bytes, size_t length);
	void *context;
} lk_lock;

// close and open give back what they are given
static inline lk_closed lk_unlocked_close(void *context, const uint8_t doc[32], const uint8_t name[CM_NAME],
	const uint8_t (*parents)[CM_NAME], size_t parent_count, const uint8_t *bytes, size_t length) {
	(void)context, (void)doc, (void)name, (void)parents, (void)parent_count;
	return (lk_closed){bytes, length, false};
}

static inline lk_opened lk_unlocked_open(void *context, const uint8_t doc[32], const uint8_t *bytes, size_t length) {
	(void)context, (void)doc;
	return (lk_opened){LK_OPEN, bytes, length, false, NULL};
}

static inline const lk_lock *lk_unlocked(void) {
	static const lk_lock unlocked = {lk_unlocked_close, lk_unlocked_open, NULL};
	return &unlocked;
}

static inline void lk_closed_free(lk_closed *c) {
	if (c->owned) free((void *)c->bytes);
	*c = (lk_closed){0};
}

static inline void lk_opened_free(lk_opened *o) {
	if (o->owned) free((void *)o->bytes);
	*o = (lk_opened){0};
}

#endif
