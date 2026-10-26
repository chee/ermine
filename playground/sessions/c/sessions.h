// Sessions (typescript/sessions.ts), in C: one world opened on an install's root, a tab, a worker,
// one run, fresh each start. A session is here at a node while it beats there: its entry in the
// node's "online" part, { [session]: { install, until } }, each written as a patch at its own key,
// so two sessions' beats never write over each other. Same rules as sessions.ts, which the suite in
// playground/sessions/conformance/sessions/ holds both to.
//   - online: the entries whose until is ahead of now, in no order. tracked
//   - sweep: takes out the entries whose until is not ahead, and any that is no beat, as one write
//   - what a beat says is only that the session is here, and its install: nothing here checks it
//
// The world is the host's (a table, places, a scheduler: places.h), set up once; sessions makes none
// of them. Every write is made as the world's scope (its header's actor). Time is ms, the host's
// clock, given. Randomness is the caller's: sess_start is handed 32 bytes. A node (an id's text) is
// the table's key: the table copies it, so the caller's may go after the call.
//
// A session has a key of its own, made at its start and never stored; its id is "ermine:ed01" and
// the key's hex, as an install's is. The install vouches for it once: its signature over
// "ermine/v1/session", the install's key, the session's key. The library knows no Ed25519: the
// host hands in the key of a secret, a signer and a verifier.
//
//   sess_world w = {.table = t, .places = p, .scheduler = s, .scope = scope};
//   sess_session me;
//   int code = sess_start(random, &install, &signing, &me);   // random: 32 bytes
//   bool ok = sess_vouched(me.id, me.install, me.vouch, &verifying);
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
#include "../../../core/places/c/places.h"

#define SESS_PART "online"

typedef struct {
	tb_table *table;
	pl *places;
	sc_scheduler *scheduler;
	// the scope the writes are made in
	sc_scope *scope;
} sess_world;

// a secret's Ed25519 public key, 32 bytes; false when it cannot be worked out
// sign: the 64-byte signature by the secret of message[0 .. length); false when it failed
typedef struct {
	bool (*public_key_of)(void *ctx, const uint8_t secret[32], uint8_t out[32]);
	bool (*sign)(void *ctx, const uint8_t secret[32], const uint8_t *message, size_t length, uint8_t out[64]);
	void *ctx;
} sess_signing;

// whether signature is the key's over message[0 .. length)
typedef struct {
	bool (*verify)(void *ctx, const uint8_t key[32], const uint8_t *message, size_t length, const uint8_t signature[64]);
	void *ctx;
} sess_verifying;

// the install a session starts under: its id (a key id: "ermine:ed01…") and its secret
typedef struct {
	const char *id;
	uint8_t secret[32];
} sess_install;

// the session's id (a key id), its install's (borrowed: it outlives the session), its public key and
// secret, and the install's signature over the two keys
typedef struct {
	char id[ID_TEXT];
	const char *install;
	uint8_t key[32];
	uint8_t secret[32];
	uint8_t vouch[64];
} sess_session;

typedef enum { SESS_OK, SESS_BAD_INSTALL, SESS_FAILED } sess_code;

// a session started: its key made from the 32 random bytes as its secret, and the install's vouch for
// it. an install whose id is no key id: SESS_BAD_INSTALL; a key or signature that could not be made:
// SESS_FAILED. nothing is in *out on an error
int sess_start(const uint8_t random[32], const sess_install *install, const sess_signing *signing, sess_session *out);

// whether the install vouched for the session id: its signature over the two keys. ids that are no
// key ids: false
bool sess_vouched(const char *id, const char *install, const uint8_t vouch[64], const sess_verifying *verifying);

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
// the sessions here at node now, in no order. tracked: a reader reruns when
// the entry changes. told to the scheduler as places' reads are: a run asks pl_status after
sess_heres sess_online(sess_world *w, const char *node, int64_t now);

// every entry at node whose until is not ahead of now, out; and any that is no beat. one write, none
// when nothing is to go
void sess_sweep(sess_world *w, const char *node, int64_t now);

#endif
