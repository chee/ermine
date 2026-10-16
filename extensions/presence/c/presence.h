// Presence (typescript/presence.ts), in C: who is here, and where their cursor is, anchored on a
// node. Same rules as presence.ts, which the suite in playground/presence/conformance/presence/
// holds both to. Rows live in the part "presence" at the anchor's id: { [who]: { value, until } },
// one row a device or person, each written as a patch (so tracked, watched, drawn).
//   - until: now + ttl, renewed by the row's owner (a heartbeat). readers see rows with until > now
//   - a sweeper removes the rows past until, as patches, so readers rerun
//   - a channel (channel.h) sends my rows on topic = the anchor and applies the rows it receives
//     under the sender's name. "gone" is until lapsing, never the transport
//   - never saved, unless the host says so (pres_keep): saving is a side's choice
//
// The world is the host's (a table, places, a scheduler: places.h), set up once; presence makes
// none of them. Every write is made as the world's scope (its header's actor). Time is ms, from the
// world's clock: given, so a host or a test says what time it is.
//
//   pres_world w = {.table = t, .places = p, .scheduler = s, .scope = scope};
//   pres_connect(&w, channel, "topic", NULL);
//   pres_set(&w, "topic", "juno", value, 2000);
//   ...
//   pres_free(&w);
#ifndef PRESENCE_H
#define PRESENCE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../../filesystem/places/c/places.h"
#include "channel.h"

#define PRES_PART "presence"

// ms since 1970, or any epoch the host keeps
typedef int64_t (*pres_clock)(void *ctx);

typedef struct {
	tb_table *table;
	pl *places;
	sc_scheduler *scheduler;
	// the scope the presence writes are made in
	sc_scope *scope;
	// NULL: the wall clock
	pres_clock now;
	void *now_ctx;
	// whether this side keeps presence in a save. default never. see pres_keep
	bool save;
	// presence's own, made at first use, let go of by pres_free
	void *state;
} pres_world;

// a live row: who, its value (a hold the caller lets go of), until
typedef struct {
	char *who;
	op_value *value;
	int64_t until;
} pres_live;
typedef struct {
	pres_live *items;
	size_t n;
} pres_lives;
void pres_live_free(pres_live *row);
void pres_lives_free(pres_lives *rows);

// my row at the anchor: made or replaced, until = now + ttl (ms). told to a connected channel. The
// value is held (op_ref) by the row, the strings are copied
void pres_set(pres_world *w, const char *anchor, const char *who, const op_value *value, int64_t ttl);
// the heartbeat: until = now + ttl, the value as it was. no such row: false
bool pres_renew(pres_world *w, const char *anchor, const char *who, int64_t ttl);
// my row taken out, and told, so the others do not wait for its until
void pres_clear(pres_world *w, const char *anchor, const char *who);

// the live rows at an anchor (until > now), by name. tracked: a reader reruns when any row arrives,
// changes or leaves. rows past until that are not swept yet are not shown. Told to the scheduler as
// places' reads are: a run asks pl_status after
pres_lives pres_read(pres_world *w, const char *anchor);
// one row, tracked at its own spot: a reader reruns only when that row changes. true and *out, or
// false: none, or past its until
bool pres_read_row(pres_world *w, const char *anchor, const char *who, pres_live *out);

// what a sweep removed
typedef struct {
	char *anchor;
	char *who;
} pres_gone;
typedef struct {
	pres_gone *items;
	size_t n;
} pres_swept;
void pres_swept_free(pres_swept *swept);
// removes every row past until (until <= at), at any anchor this world has written or received, as
// patches (one write an anchor). gives back what it removed. the host says when. pres_sweep_now: at
// the world's now. (the reference's startSweeper, a timer the host owns, is the host's here)
pres_swept pres_sweep(pres_world *w, int64_t at);
pres_swept pres_sweep_now(pres_world *w);

// saving: a host's pack takes the triples it is given, so it filters them: pres_keep says whether
// this side keeps that part. presence is not kept unless the world's save is true
bool pres_keep(const pres_world *w, const char *part);

// the rows at an anchor, over the channel on topic. what is sent: my rows, whole, as they are
// written, with the time left (not a time: devices' clocks differ). what is received lands under the
// sender's name, from outside, and is never sent back. none of it is saved
typedef struct pres_conn pres_conn;
// anchor NULL: the topic. the connection is the world's until pres_free
pres_conn *pres_connect(pres_world *w, chn_channel *channel, const char *topic, const char *anchor);
// no more is heard or told on it
void pres_stop(pres_conn *c);
// send all my rows now (to someone new; or as the heartbeat)
void pres_announce(pres_conn *c);

// an entry for the anchor, so a path (a mounted node) can be watched before any row is there
void pres_ensure(pres_world *w, const char *anchor);

// lets go of what presence kept for the world (not the world, nor the channels)
void pres_free(pres_world *w);

#endif
