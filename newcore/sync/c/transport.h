// Sync's transport (newcore/sync/TRANSPORT.tex), in C: sealed blops over Subduction (c/subduction),
// stored ones as its commits, ephemeral ones as its ephemeral messages; what arrives is checked
// before the histories (history.h) see it. Sans-IO as Subduction is: the host opens each connection
// (transport_connect), hands in each message that arrives, sends each one asked for (transport_next)
// and passes the time by calling transport_run. One thread at a time.
//
// Subduction keeps what it holds in the host's store (store.h); the device wraps it, and takes in
// each commit and fragment saved to it. The lock is "unlocked" (LOCK.tex): close and open give back
// what they are given. A document is an ermine:// id's text (id.h); its tree and ephemeral topic are
// its 32 bytes.
#ifndef TRANSPORT_H
#define TRANSPORT_H

#include "history.h"
#include "fragment.h"

#include "../../c/subduction/subduction.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct transport transport;

typedef enum {
	TRANSPORT_STORED,
	TRANSPORT_EPHEMERAL,
} transport_layer;

typedef enum {
	TRANSPORT_OK,
	TRANSPORT_DOC,     // not an ermine:// id
	TRANSPORT_SEAL,    // not a seal
	TRANSPORT_PARENTS, // a parent's seal is not taken in here
	TRANSPORT_BLOP,    // not a blop
} transport_code;

// why a commit or fragment is refused, in Taking in's order
typedef enum {
	TRANSPORT_LOCK,
	TRANSPORT_SHAPE,
	TRANSPORT_SIGNATURE,
	TRANSPORT_STORED_ID,
	TRANSPORT_DOCUMENT,
	TRANSPORT_PARENT_IDS,
} transport_refusal;
// "lock", "shape", "signature", "stored", "document", "parents"
const char *transport_refusal_name(transport_refusal refusal);

// commit: a loose commit's head; for what has no commit, a fragment's member the
// stored id of its seal, an ephemeral blop its name (BLAKE3 of its bytes)
typedef struct {
	uint8_t commit[32];
	uint8_t (*names)[32]; // the parents' blop names whose seals are not here, in parents order
	size_t count;
} transport_waiting;
typedef struct {
	uint8_t id[32]; // a loose commit's head, a fragment's head, or a seal's stored id
	bool fragment;  // a fragment refused whole
	transport_refusal code;
} transport_refused;
// each list sorted by id. stuck: a commit with a parent refused or stuck here, listed with the names of
// those parents (in names), in the refused's place
typedef struct {
	transport_waiting *waiting;
	size_t waiting_count;
	transport_waiting *stuck;
	size_t stuck_count;
	transport_refused *refused;
	size_t refused_count;
} transport_taking;

// what the host is asked to do
typedef enum {
	TRANSPORT_SEND,  // send bytes as one binary message on conn
	TRANSPORT_CLOSE, // close conn
} transport_out_kind;
typedef struct {
	transport_out_kind kind;
	uint64_t conn;
	uint8_t *bytes; // SEND's; transport_out_free
	size_t length;
} transport_out;

// a device signing as Subduction's peer with the seed's Ed25519 key (SEAL.tex: the device's key), keeping
// what Subduction holds in store (copied; what it points to must outlive the device). Before it returns,
// everything the store holds, every fragment and loose commit, is taken in as a save is, so no connection
// precedes it (TRANSPORT.tex, A device)
transport *transport_create(const uint8_t seed[32], const ErmStore *store);
void transport_free(transport *t);

// a connection: the handshake, then the followed documents synced over it. Its number is the conn of
// the calls below and of what is asked of the host
// service: the name the server answers to, in the handshake (a local subduction_cli: whatever its
// --service-name is; a public server: its host, as transport_service gives)
uint64_t transport_connect(transport *t, const char *service);
// the service name a server url defaults to: its host, with :port when it names one (a url's login
// left out), into out of size bytes
void transport_service(const char *url, char *out, size_t size);
// how many connections have completed their handshake
size_t transport_connected(const transport *t);
void transport_received(transport *t, uint64_t conn, const uint8_t *bytes, size_t length);
void transport_closed(transport *t, uint64_t conn);

// runs everything that can run, now by the clock: the ms until it must run again though nothing comes
// in (0: at once), or -1 for only when something does
int64_t transport_run(transport *t);
// the next thing to ask the host, true; or false when none waits
bool transport_next(transport *t, transport_out *out);
void transport_out_free(transport_out *out);

// how long, in ms, the parts of an ephemeral payload over Subduction's 65 536 bytes may wait for the rest
// before they are dropped (default 30 000); transport_expire drops them now
void transport_join(transport *t, uint64_t ms);
void transport_expire(transport *t);

// doc followed: synced with every peer, subscribe true, its ephemeral messages subscribed; from now on, with
// each peer connected later too
transport_code transport_follow(transport *t, const char *doc);
// the document's histories of a layer, made at first; the host commits through them (commit.h)
histories *transport_histories(transport *t, const char *doc, transport_layer layer);
// a stored blop of this device's, sealed: taken in, added as a loose commit, then fragments built
transport_code transport_add(transport *t, const char *doc, const uint8_t *sealed, size_t length);
// a blop this device made, its bytes, not yet sealed, into that layer's histories at once (WIRING.tex): add
// and publish then pass over the name already taken in. A stored blop goes into the ephemeral histories too.
// Not announced. The document keeps its bytes till its seal is taken in
transport_code transport_take(transport *t, const char *doc, const uint8_t *blop, size_t length, transport_layer layer);

// a blop that came to be taken in to a history, from the network or storage (heard: an ephemeral message),
// or that waited there on one that did. Valid for the call, blop too (held by the device till then)
typedef struct {
	const char *doc;
	transport_layer layer;
	const Json *blop;
	uint8_t name[32];
	bool heard;
} transport_arrival;
// told each, after it is taken in and what took it in is done (from transport_run, transport_add and
// transport_publish): not in the middle of taking in, so a listener may make changes. Any number of
// listeners; each is told every arrival, in order
void transport_arrived(transport *t, void (*listener)(void *context, const transport_arrival *arrival), void *context);
// transport_create, with a listener (as transport_arrived's) given before the store is taken in: it is told
// what the store held too, from the first transport_run, as TypeScript's device tells it on starting
transport *transport_create_told(const uint8_t seed[32], const ErmStore *store, void (*listener)(void *context, const transport_arrival *arrival), void *context);
// an ephemeral one, the blop's bytes, not sealed: taken in to the ephemeral layer (refused there as a
// receiver would refuse it, but still published), then published: over 65 536 bytes, as parts of at most
// 60 000 (each the map {whole, part, parts, bytes}), which a receiver joins
transport_code transport_publish(transport *t, const char *doc, const uint8_t *blop, size_t length);
// addCommit as given, nothing checked or taken in first
transport_code transport_put(transport *t, const char *doc, const uint8_t head[32], const uint8_t (*parents)[32], size_t count, const uint8_t *blob, size_t length);

// addFragment as given, nothing checked or taken in first
transport_code transport_put_fragment(transport *t, const char *doc, const uint8_t head[32], const uint8_t (*boundary)[32], size_t boundary_count, const uint8_t (*checkpoints)[32], size_t checkpoint_count, const uint8_t *blob, size_t length);

// Taking in's own waiting and refused; transport_taking_free
transport_taking transport_taking_of(transport *t, const char *doc, transport_layer layer);
void transport_taking_free(transport_taking *taking);
// the fragments here, made or taken in, sorted by head; checkpoints empty for one taken in (Subduction
// keeps 12 bytes of each). Valid until the next call
const fragment *transport_fragments(transport *t, const char *doc, size_t *count);
// the loose commits Subduction holds of the tree: heads, in *out (free it); runs until it answers
size_t transport_stored(transport *t, const char *doc, uint8_t (**out)[32]);

#endif
