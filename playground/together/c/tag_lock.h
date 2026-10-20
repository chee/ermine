// tag_lock.h: the harnesses' test lock, no cryptography: it closes by putting a byte, 0xff, before the
// bytes (no seal, commit or fragment starts with it, so a device with no lock refuses what it is sent)
// and opens by taking it off, refusing bytes that have none; or, as its mode says from the request
// "lock", it waits or refuses. It remembers what it was asked to close, and whether it was asked to
// open. As typescript/tag_lock.ts. header only, for lock_harness.c and sync_harness.c
#ifndef TG_TAG_LOCK_H
#define TG_TAG_LOCK_H

#include "lock.h"

#include <stdlib.h>
#include <string.h>

#define TG_TAG 0xff

typedef enum { TG_OPEN, TG_WAIT, TG_REFUSE } tg_mode;

// one asked close, as the lock was given it
typedef struct {
	uint8_t doc[32];
	uint8_t name[CM_NAME];
	uint8_t (*parents)[CM_NAME];
	size_t parent_count;
} tg_call;

typedef struct {
	lk_lock lock;
	tg_mode mode;
	tg_call *closed;
	size_t closed_count, closed_room;
	bool opened;
} tg_lock;

static inline lk_closed tg_close(void *context, const uint8_t doc[32], const uint8_t name[CM_NAME],
	const uint8_t (*parents)[CM_NAME], size_t parent_count, const uint8_t *bytes, size_t length) {
	tg_lock *t = context;
	if (t->closed_count == t->closed_room) {
		t->closed_room = t->closed_room ? t->closed_room * 2 : 8;
		t->closed = realloc(t->closed, t->closed_room * sizeof *t->closed);
		if (t->closed == NULL) abort();
	}
	tg_call *c = &t->closed[t->closed_count++];
	memcpy(c->doc, doc, 32);
	memcpy(c->name, name, CM_NAME);
	c->parents = malloc(parent_count * CM_NAME + 1);
	if (c->parents == NULL) abort();
	memcpy(c->parents, parents, parent_count * CM_NAME);
	c->parent_count = parent_count;
	uint8_t *out = malloc(length + 1);
	if (out == NULL) abort();
	out[0] = TG_TAG;
	memcpy(out + 1, bytes, length);
	return (lk_closed){out, length + 1, true};
}

static inline lk_opened tg_open(void *context, const uint8_t doc[32], const uint8_t *bytes, size_t length) {
	tg_lock *t = context;
	(void)doc;
	t->opened = true;
	if (t->mode == TG_WAIT) return (lk_opened){.kind = LK_WAIT};
	if (t->mode == TG_REFUSE) return (lk_opened){.kind = LK_REFUSED, .refused = "the test lock refuses"};
	if (length == 0 || bytes[0] != TG_TAG) return (lk_opened){.kind = LK_REFUSED, .refused = "no tag on the bytes"};
	return (lk_opened){.kind = LK_OPEN, .bytes = bytes + 1, .length = length - 1};
}

static inline tg_lock *tg_make(void) {
	tg_lock *t = calloc(1, sizeof *t);
	if (t == NULL) abort();
	t->lock = (lk_lock){tg_close, tg_open, t};
	return t;
}

// the mode "tag", "wait" or "refuse"; false: none such
static inline bool tg_set(tg_lock *t, const char *open) {
	if (open == NULL) return false;
	if (strcmp(open, "tag") == 0) t->mode = TG_OPEN;
	else if (strcmp(open, "wait") == 0) t->mode = TG_WAIT;
	else if (strcmp(open, "refuse") == 0) t->mode = TG_REFUSE;
	else return false;
	return true;
}

// the closes remembered let go of
static inline void tg_forget(tg_lock *t) {
	for (size_t i = 0; i < t->closed_count; i++) free(t->closed[i].parents);
	t->closed_count = 0;
}

static inline void tg_free(tg_lock *t) {
	if (t == NULL) return;
	tg_forget(t);
	free(t->closed);
	free(t);
}

#endif
