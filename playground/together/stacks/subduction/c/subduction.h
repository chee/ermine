// subduction.h: the Subduction stack, subduction.ts in C: commits over Subduction, as the mailroom (mailroom.h)
// has them. What it carries: stored commits, sealed, as loose commits and fragments, each fragment
// with a snapshot of the tables at its head; ephemeral ones, never sealed, as its ephemeral messages.
// It reads the store (store.h), a clock and the network; every commit it takes in goes to the mailroom, and
// it sends what the mailroom queues. A fragment carries {run, snapshot?} (packer.h, snapshot.h); a stored
// fragment lets go of the loose commits it covers. An empty followed document is asked again, 0.25 s
// doubling to 16 s. Ephemeral messages on hashed topics (sb_send, sb_listen), in parts over 65 536
// bytes. Only lock "unlocked" is built.
//
// sans-IO: the host gives messages in (sb_received), sends what sb_next gives, and calls sb_run, which
// says when to run again. One thread at a time. transport.h is the device that composes it with the
// mailroom, and documents the whole.
#ifndef SB_SUBDUCTION_H
#define SB_SUBDUCTION_H

#include "../../../c/mailroom.h"
#include "fragment.h"
#include "subduction/subduction.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct sb_stack sb_stack;

// the clock: ms since 1970
typedef uint64_t (*sb_clock_fn)(void *context);
// the integration's: the tables at a fragment's head, packed (snapshot.h), malloc'd into *out; false:
// none for this one (the integration decides when one is worth it)
typedef bool (*sb_snapshot_fn)(void *context, const char *doc, const hy_kept *head, uint8_t **out,
	size_t *length);

typedef struct {
	// Subduction's peer key: the device's Ed25519 key
	uint8_t seed[32];
	// where Subduction keeps what it holds: borrowed, it must outlive the stack
	const ErmStore *store;
	// the name a peer answers to in the handshake, when sb_connect is given none; NULL: "ermine"
	const char *service;
	// how long, in ms, the parts of an ephemeral payload may wait for the rest; 0: 30 000
	uint64_t join;
	// NULL: erm_host_now
	sb_clock_fn now;
	void *clock;
	// NULL: no snapshots
	sb_snapshot_fn snapshot;
	void *context;
	// the ephemeral payloads being joined, the parts one may have. 0: the default (64, 1 024)
	size_t joins, parts;
	// what the store holds is taken in as each document is followed, not at the first sb_run
	bool lazy;
} sb_options;

// a stack over the mailroom, which it attaches to; it takes in what the store holds on its first sb_run
// (lazy: only what is followed). NULL when Subduction says no. sb_free before the mailroom is freed
sb_stack *sb_create(const sb_options *options, mr_mailroom *mailroom);
void sb_free(sb_stack *t);

// runs everything that can run: the ms until it must run again though nothing comes in (0: at once),
// or -1 for only when something does. Pulls the mailroom's own takes (mr_front)
int64_t sb_run(sb_stack *t);
// nothing left to take in or build here
bool sb_idle(const sb_stack *t);
// what the store held is all taken in
bool sb_ready(const sb_stack *t);
// how many fetches (a followed document synced with every peer) are out
size_t sb_fetching(const sb_stack *t);

// --- connections

uint64_t sb_connect(sb_stack *t, const char *service);
void sb_received(sb_stack *t, uint64_t conn, const uint8_t *bytes, size_t length);
void sb_closed(sb_stack *t, uint64_t conn);
bool sb_connected(const sb_stack *t, uint64_t conn, uint8_t key[SL_KEY]);
void sb_disconnect(sb_stack *t, const uint8_t key[SL_KEY]);
// the service name a server url defaults to: its host, with :port when it names one (a login left out)
void sb_service(const char *url, char *out, size_t size);

// what the host is asked to do
typedef enum { SB_SEND, SB_CLOSE } sb_out_kind;
typedef struct {
	sb_out_kind kind;
	uint64_t conn;
	uint8_t *bytes; // SEND's, the host's: sb_out_free
	size_t length;
} sb_out;
bool sb_next(sb_stack *t, sb_out *out);
void sb_out_free(sb_out *out);

// --- documents

// what comes for the document is taken in: synced with every peer (subscribed), asked again while it
// is empty. false: not a document id
bool sb_follow(sb_stack *t, const char *doc);
// the loose commits Subduction holds of the document, by stored id, malloc'd into *out (free it); runs
// the stack until Subduction answers
size_t sb_stored(sb_stack *t, const char *doc, uint8_t (**out)[32]);
// the fragments here, made or taken in: *out malloc'd (free it, not what it points to), good until the
// next sb_run
size_t sb_fragments(sb_stack *t, const char *doc, const fragment ***out);
// the document's fragments refused whole, by head (codes), for mr_taking_of
const im_map *sb_broken(const sb_stack *t, mr_doc *d);

// --- ephemeral messages on topics (a string, named by hash so it is never a document's)

void sb_send(sb_stack *t, const char *topic, const uint8_t *bytes, size_t length);
typedef void (*sb_heard_fn)(void *context, const char *from, const uint8_t *bytes, size_t length);
typedef struct sb_listener sb_listener;
sb_listener *sb_listen(sb_stack *t, const char *topic, sb_heard_fn fn, void *context);
void sb_unlisten(sb_stack *t, sb_listener *l);

#endif
