// Commits over Subduction (extensions/sync/typescript/transport.ts), in C: a device. Two histories
// per document (history.h): stored and ephemeral, the ephemeral one holding every stored commit too.
// This device's own commits are taken into them at once, unchecked; then, in the order made, a stored
// one is sealed (seal.h), stored as a loose commit and sent, an ephemeral one published unsealed; one
// waiting on a parent goes once the parent lets it in. What arrives (the network, or what the store
// held) is checked here (the seal, its stored id, its parents), then by the histories and the
// integration's check, and told. Fragments carry {run, snapshot?} (run.h, snapshot.h), built when a
// commit can head one (a leading zero byte), and a stored fragment lets go of the loose commits it
// covers. A followed document still empty is asked for again, 0.25 s doubling to 16 s. Ephemeral
// messages on hashed topics (tp_send, tp_listen), sent as parts over 65 536 bytes. Same rules as
// transport.ts, whose header comments say why; only the lock "unlocked" is built (close and open
// give back what they are given), so nothing waits on a lock and nothing is refused "lock".
//
// Sans-IO, as Subduction for C is (extensions/subduction/c/subduction/subduction.h): the host opens
// each connection and gives its messages in (tp_received), sends each one asked of it (tp_next) and
// calls tp_run, which runs Subduction and everything here until nothing more can go on, and says when
// it must run again. One thread at a time. Time is the options' clock. A document is an ermine:// id
// (64 lowercase hex digits); its tree and ephemeral topic are its 32 bytes.
//
// Subduction keeps what it holds in the host's store (store.h); the device wraps it, and takes in
// each commit and fragment saved to it. A new device takes in everything the store holds on its first
// tp_run, before anything else: every fragment, then every loose commit, of each tree, as saves are.
//
// On a server (extensions/subduction/c/subduction/transport.h: websocket.c over transport_openssl.c):
// ermTransportOpen(url), tp_service(url) for the name it answers to, tp_connect(t, name); then, in the
// host's loop, each message ermTransportReceive gives to tp_received, each TP_SEND tp_next gives to
// ermTransportSend (TP_CLOSE: ermTransportClose), a closed socket to tp_closed, and the socket's fd
// waited on for the ms tp_run gave. Callbacks (check, snapshot, arrived, heard) never call tp_run.
#ifndef TP_TRANSPORT_H
#define TP_TRANSPORT_H

#include "history.h"
#include "replay.h"
#include "../../subduction/c/fragment.h"
#include "../../subduction/c/subduction/subduction.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct tp_device tp_device;

typedef enum { TP_STORED, TP_EPHEMERAL } tp_layer;
// "stored", "ephemeral"
const char *tp_layer_name(tp_layer layer);

// why the transport refused a seal, a fragment or an ephemeral commit before a history saw it (what a
// history refuses is the history's: hy_refused)
typedef enum { TP_LOCK = 1, TP_SHAPE, TP_SIGNATURE, TP_STORED_ID, TP_PARENTS } tp_code;
// "lock", "shape", "signature", "stored", "parents"
const char *tp_code_name(tp_code code);

// a commit taken into a history from elsewhere (the network or the store), after it is taken in;
// heard: from a peer's ephemeral message. This device's own takes are not told. Good for the call
typedef struct {
	const char *doc;
	tp_layer layer;
	const hy_kept *kept;
	bool heard;
} tp_arrival;
typedef void (*tp_arrived_fn)(void *context, const tp_arrival *arrival);

// the integration's: whether a commit from elsewhere, its parents all taken in, applies to its
// parent's node. Never asked of this device's own takes. It may apply it as it looks. 0: yes; else
// the refusal (HY_PATCHES: it does not apply; HY_MERGE: a merge by a rule not known here)
typedef hy_refusal (*tp_check_fn)(void *context, const char *doc, const hy_kept *kept, const cm_commit *commit,
	tp_layer layer);
// the integration's: the tables at a fragment's head, packed (snapshot.h), malloc'd into *out; false:
// none for this one (the integration decides when one is worth it)
typedef bool (*tp_snapshot_fn)(void *context, const char *doc, const hy_kept *head, uint8_t **out,
	size_t *length);
// the clock: ms since 1970
typedef uint64_t (*tp_clock_fn)(void *context);

typedef struct {
	// Subduction's peer key and the seals' signer: the device's Ed25519 key
	uint8_t seed[32];
	// where Subduction keeps what it holds: borrowed, it must outlive the device
	const ErmStore *store;
	// the name a peer answers to in the handshake, when tp_connect is given none; NULL: "ermine"
	const char *service;
	// how long, in ms, the parts of an ephemeral payload may wait for the rest; 0: 30 000
	uint64_t join;
	// NULL: erm_host_now
	tp_clock_fn now;
	void *clock;
	// NULL: everything applies; none: no snapshots
	tp_check_fn check;
	tp_snapshot_fn snapshot;
	void *context;
} tp_options;

// a device; it takes in what the store holds on its first tp_run. NULL when Subduction says no
tp_device *tp_create(const tp_options *options);
// lets go of everything, the store's contents aside (what is not stored yet is lost: run to tp_idle
// first)
void tp_free(tp_device *t);
// the device's key (its peer id)
const uint8_t *tp_key(const tp_device *t);

// runs everything that can run: the ms until it must run again though nothing comes in (0: at once),
// or -1 for only when something does
int64_t tp_run(tp_device *t);
// nothing left to take in, build, seal, store or publish (Subduction's own work and fetches aside)
bool tp_idle(const tp_device *t);
// what the store held is all taken in
bool tp_ready(const tp_device *t);
// how many fetches (a followed document synced with every peer) are out
size_t tp_fetching(const tp_device *t);

// --- connections

// a connection over a transport the host has opened: the handshake, then every followed document
// fetched over it. service: the name the server answers to (a public server: tp_service of its url;
// NULL: the options'). Its number is the conn of what is asked of the host and of tp_received and
// tp_closed; 0 when Subduction says no. Two devices in one process connect by each calling this on
// its end of a pipe (Subduction's simultaneous open: there is no accepting side)
uint64_t tp_connect(tp_device *t, const char *service);
void tp_received(tp_device *t, uint64_t conn, const uint8_t *bytes, size_t length);
// the host's transport for the connection closed
void tp_closed(tp_device *t, uint64_t conn);
// whether the connection's handshake is done, and the peer's key
bool tp_connected(const tp_device *t, uint64_t conn, uint8_t key[32]);
// every connection to the peer with that key let go of, each asked of the host to close
void tp_disconnect(tp_device *t, const uint8_t key[32]);
// the service name a server url defaults to: its host, with :port when it names one (a login left
// out), into out of size bytes
void tp_service(const char *url, char *out, size_t size);

// what the host is asked to do
typedef enum { TP_SEND, TP_CLOSE } tp_out_kind;
typedef struct {
	tp_out_kind kind;
	uint64_t conn;
	uint8_t *bytes; // SEND's, the host's: tp_out_free
	size_t length;
} tp_out;
// the next thing asked of the host, true; or false when none waits
bool tp_next(tp_device *t, tp_out *out);
void tp_out_free(tp_out *out);

// --- documents

// whether the text is a document id, and its bytes
bool tp_doc(const char *doc, uint8_t bytes[32]);
// what comes for the document is taken in: synced with every peer (subscribed), now and on each
// connection made after, its ephemeral messages subscribed; asked again while it is empty. false:
// not a document id
bool tp_follow(tp_device *t, const char *doc);
// the document's history of a layer (made at first; the ephemeral one holds every stored commit
// too); NULL: not a document id
hy_history *tp_history(tp_device *t, const char *doc, tp_layer layer);
// a commit this device made, its bytes: into the layer's history at once, with no check (it applied
// here already); then, in the order made, a stored one sealed, stored and sent, an ephemeral one
// published; one waiting on a parent goes once the parent lets it in. Answers as the history does
// (hy_added_free it); not a document id: refused, shape. made as hy_add's
hy_added tp_take(tp_device *t, const char *doc, const uint8_t *bytes, size_t length, tp_layer layer,
	const hy_made *made);
// told each arrival, after it is taken in and what took it in is done, in order: never in the middle
// of a history's add. Any number of listeners
void tp_arrived(tp_device *t, tp_arrived_fn fn, void *context);
// told each ephemeral commit heard on a followed document whose signer is the sender, new or heard
// before (sent again), after any arrival it made: the document, the sender's key, the commit's name.
// What keeps another device's ephemeral commits standing. Any number of listeners
typedef void (*tp_hearing_fn)(void *context, const char *doc, const uint8_t from[32], const uint8_t name[32]);
void tp_hearing(tp_device *t, tp_hearing_fn fn, void *context);
// an ephemeral commit of this device's (in the ephemeral history, not a stored one) published again,
// queued as a take is; false: no such commit
bool tp_again(tp_device *t, const char *doc, const uint8_t name[32]);
// an ephemeral commit (not a stored one) let go of: out of the ephemeral history and whatever was kept
// for it, as if never heard; heard again, it comes in again. Done once nothing queued here holds it
// (at the end of a tp_run): its kept is freed then. false: none such
bool tp_forget(tp_device *t, const char *doc, const uint8_t name[32]);
// the tables at a commit, when a fragment headed by it carried a snapshot: new ones put in *out
// (rp_init'd), true
bool tp_snapshot(tp_device *t, const char *doc, const uint8_t name[32], rp_tables *out);
// the loose commits Subduction holds of the document, by stored id, malloc'd into *out (free it);
// runs the device until Subduction answers
size_t tp_stored(tp_device *t, const char *doc, uint8_t (**out)[32]);
// the fragments here, made or taken in: *out malloc'd (free it, not what it points to), good until the
// next tp_run. A fragment taken in has no checkpoints
size_t tp_fragments(tp_device *t, const char *doc, const fragment ***out);

// --- ephemeral messages on topics (a string, named by hash so it is never a document's)

// bytes to whoever listens on the topic: kept nowhere, not heard here. Over 65 536 bytes (or looking
// like a part): sent as parts, joined at the other end
void tp_send(tp_device *t, const char *topic, const uint8_t *bytes, size_t length);
// told each message on the topic: the sender's key as lowercase hex, the bytes (good for the call)
typedef void (*tp_heard_fn)(void *context, const char *from, const uint8_t *bytes, size_t length);
typedef struct tp_listener tp_listener;
// subscribes as needed; the listener, for tp_unlisten
tp_listener *tp_listen(tp_device *t, const char *topic, tp_heard_fn fn, void *context);
void tp_unlisten(tp_device *t, tp_listener *l);
// the parts of an ephemeral payload not joined yet dropped now, as the clock would in time
void tp_expire(tp_device *t);

// --- for tests and conformance

// addCommit as given: nothing checked or taken in first (taken in as a save is)
bool tp_put(tp_device *t, const char *doc, const uint8_t head[32], const uint8_t (*parents)[32], size_t count,
	const uint8_t *blob, size_t length);
// addFragment as given, likewise
bool tp_put_fragment(tp_device *t, const char *doc, const uint8_t head[32], const uint8_t (*boundary)[32],
	size_t count, const uint8_t (*checkpoints)[32], size_t checks, const uint8_t *blob, size_t length);
// how many tp_put and tp_put_fragment calls Subduction has not answered
size_t tp_putting(const tp_device *t);

// what the transport holds back or refused before the histories. waiting: a loose commit (by its
// head), or a fragment's member (by its seal's stored id), and the names of its parents not here.
// refused, by id: a commit (code), a fragment refused whole (fragment, code), or one stuck on a parent
// refused or stuck here (stuck, the names of those parents). Each list sorted by id. The ephemeral
// layer: no waiting, the refused ephemeral commits by name
typedef struct {
	uint8_t commit[32];
	uint8_t (*names)[32];
	size_t count;
} tp_waiting;
typedef struct {
	uint8_t id[32];
	bool fragment, stuck;
	tp_code code;
	uint8_t (*names)[32];
	size_t count;
} tp_refused;
typedef struct {
	tp_waiting *waiting;
	size_t waiting_count;
	tp_refused *refused;
	size_t refused_count;
} tp_taking;
tp_taking tp_taking_of(tp_device *t, const char *doc, tp_layer layer);
void tp_taking_free(tp_taking *taking);

#endif
