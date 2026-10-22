// Sessions (typescript/sessions.ts), in C: one world opened on an install's root, a tab, a worker,
// one run, fresh each start. A session is here at a node while it beats there: its entry in the
// node's "online" part, { [session]: { install, until } }, each written as a patch at its own key,
// so two sessions' beats never write over each other. Same rules as sessions.ts, which the suite in
// playground/sessions/conformance/sessions/ holds both to.
//   - online: the entries whose until is ahead of now, in the order they were made. tracked
//   - sweep: takes out the entries whose until is not ahead, and any that is no beat, as one write
//   - what a beat says is only that the session is here, and its install: nothing here checks it
//
// The world is the host's (a table, places, a scheduler: places.h), set up once; sessions makes none
// of them. Every write is made as the world's scope (its header's actor). Time is ms, the host's
// clock, given. Randomness is the caller's: sess_start is handed 16 bytes. A node (an id's text) is
// the table's key, so it outlives its entry (as pl_upsert's id).
//
//   sess_world w = {.table = t, .places = p, .scheduler = s, .scope = scope};
//   sess_session me = sess_start(random, install_id);
//   sess_beat(&w, &me, "den", now + 10000);
//   sess_heres here = sess_online(&w, "den", now);
//   sess_sweep(&w, "den", now);
//   sess_leave(&w, &me, "den");
#ifndef SESSIONS_H
#define SESSIONS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../../ermine/ids/c/ids.h"
#include "../../../filesystem/places/c/places.h"

#define SESS_PART "online"

typedef struct {
	tb_table *table;
	pl *places;
	sc_scheduler *scheduler;
	// the scope the writes are made in
	sc_scope *scope;
} sess_world;

// the id's text, and the install's (borrowed: it outlives the session)
typedef struct {
	char id[ID_TEXT];
	const char *install;
} sess_session;

// a session started: a fresh id from the 16 random bytes
sess_session sess_start(const uint8_t random[16], const char *install);

// the session's entry at node, made or renewed; until: ms
void sess_beat(sess_world *w, const sess_session *session, const char *node, int64_t until);
// the session's entry at node, out; none there: nothing
void sess_leave(sess_world *w, const sess_session *session, const char *node);

// a session here: its id and install (copies, for sess_heres_free), and until
typedef struct {
	char *session;
	char *install;
	int64_t until;
} sess_here;
typedef struct {
	sess_here *items;
	size_t n;
} sess_heres;
void sess_heres_free(sess_heres *here);
// the sessions here at node now, in the order their entries were made. tracked: a reader reruns when
// the entry changes. told to the scheduler as places' reads are: a run asks pl_status after
sess_heres sess_online(sess_world *w, const char *node, int64_t now);

// every entry at node whose until is not ahead of now, out; and any that is no beat. one write, none
// when nothing is to go
void sess_sweep(sess_world *w, const char *node, int64_t now);

#endif
