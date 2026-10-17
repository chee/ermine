// transport.h: transport.ts in C, a device over Subduction. two histories per document (history.h):
// stored and ephemeral (holding every stored commit too). own commits taken in unchecked, then in
// order a stored one sealed (seal.h), stored and sent, an ephemeral one published unsealed. what
// arrives is checked (seal, stored id, parents), then by the histories and the integration's check.
// fragments carry {run, snapshot?} (run.h, snapshot.h); a snapshot is a hint, kept once a replay
// agrees. a stored fragment lets go of the loose commits it covers. an empty followed document is
// asked again, 0.25 s doubling to 16 s. ephemeral messages on hashed topics (tp_send, tp_listen),
// in parts over 65 536 bytes. only lock "unlocked" is built.
//
// sans-IO (subduction.h): the host gives messages in (tp_received), sends what tp_next gives, and
// calls tp_run, which says when to run again. one thread at a time; time is the options' clock. a
// document: an ermine:// id (64 hex digits); its tree and topic are its 32 bytes. the store
// (store.h) holds only what the device admits; a new device takes in everything stored on its
// first tp_run (lazy: per tree when followed, tp_options).
//
// on a server (subduction/transport.h): ermTransportOpen(url), tp_service(url), tp_connect(t, name);
// in the loop: ermTransportReceive -> tp_received, TP_SEND -> ermTransportSend, TP_CLOSE ->
// ermTransportClose, closed socket -> tp_closed, wait on the fd for tp_run's ms. callbacks (check,
// snapshot, arrived, heard) never call tp_run.
#ifndef TP_TRANSPORT_H
#define TP_TRANSPORT_H

#include "history.h"
#include "replay.h"
#include "seal.h"
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
// history refuses is the history's: hy_refused). TP_BOUNDARY: a fragment's members, boundary or
// checkpoints not what its head's walk makes them
typedef enum { TP_LOCK = 1, TP_SHAPE, TP_SIGNATURE, TP_STORED_ID, TP_PARENTS, TP_BOUNDARY } tp_code;
// "lock", "shape", "signature", "stored", "parents", "boundary"
const char *tp_code_name(tp_code code);

// what a device holds for others at most, each letting go of its oldest past it (heard again, it
// comes in again), as transport.ts's Limits: pending, a document's seals waiting on a parent's seal
// and its stored commits waiting on a parent; refused, its refusals noted (each kind) and its snapshot
// hints; waiting, its ephemeral commits waiting on a parent; joins, the ephemeral payloads being
// joined; parts, the parts one may have. 0: the default (65 536, 4 096, 1 024, 64, 1 024)
typedef struct {
	size_t pending, refused, waiting, joins, parts;
} tp_limits;

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
// the refusal (HY_PATCHES: it does not apply; HY_MERGE: a merge by a rule not known here); HY_WAIT:
// it cannot judge it yet, and asks again on tp_changed
typedef hy_refusal (*tp_check_fn)(void *context, const char *doc, const hy_kept *kept, const cm_commit *commit,
	tp_layer layer);
// the integration's: the tables at a fragment's head, packed (snapshot.h), malloc'd into *out; false:
// none for this one (the integration decides when one is worth it)
typedef bool (*tp_snapshot_fn)(void *context, const char *doc, const hy_kept *head, uint8_t **out,
	size_t *length);
// the clock: ms since 1970
typedef uint64_t (*tp_clock_fn)(void *context);

typedef struct {
	// Subduction's peer key and the seals' signer: the device's Ed25519 key (its multikey for the seals)
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
	// the merge rules a snapshot from elsewhere is checked with (a replay to its head); NULL: none.
	// borrowed: it must outlive the device
	const rp_merges *merges;
	tp_limits limits;
	// what the store holds is taken in as each document is followed, not at the first tp_run: the
	// first run takes in the trees of the documents followed before it, a later tp_follow reads its
	// document's tree from the store (fragments, then loose commits, as the first run would) before the
	// document is fetched from any peer. So the histories hold the followed documents and no other; a
	// stored document never followed enters no history
	bool lazy;
} tp_options;

// a device; it takes in what the store holds on its first tp_run (lazy: only what is followed). NULL
// when Subduction says no
tp_device *tp_create(const tp_options *options);
// lets go of everything, the store's contents aside (what is not stored yet is lost: run to tp_idle
// first)
void tp_free(tp_device *t);
// the device's key (its peer id): an Ed25519 multikey, SL_KEY bytes
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
// whether the connection's handshake is done, and the peer's key (a multikey)
bool tp_connected(const tp_device *t, uint64_t conn, uint8_t key[SL_KEY]);
// every connection to the peer with that key (a multikey) let go of, each asked of the host to close
void tp_disconnect(tp_device *t, const uint8_t key[SL_KEY]);
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
// before (sent again), after any arrival it made: the document, the sender's key (a multikey), the
// commit's name.
// What keeps another device's ephemeral commits standing. Any number of listeners
typedef void (*tp_hearing_fn)(void *context, const char *doc, const uint8_t from[SL_KEY], const uint8_t name[32]);
void tp_hearing(tp_device *t, tp_hearing_fn fn, void *context);
// this device's standing ephemeral commit at the document's table ends: a stop message on the
// document's ephemeral topic, the CBOR map {stop: table}, queued behind the takes before it. It names
// no commit: a receiver drops whatever stands for its sender at that table. It travels as the
// ephemeral commits do, signed by Subduction with the sender's key (what hear checks a commit's signer
// against), so no other device can send one for this device. Forgets nothing here: the integration
// forgets what stood
void tp_stop(tp_device *t, const char *doc, const char *table);
// told each stop heard on a followed document: the document, the sender's key (a multikey), the
// table (good for the call). One for nothing standing from that sender is the integration's to
// ignore. Any number of listeners
typedef void (*tp_stopped_fn)(void *context, const char *doc, const uint8_t from[SL_KEY], const char *table);
void tp_stopped(tp_device *t, tp_stopped_fn fn, void *context);
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
// told each message on the topic: the sender's key (a multikey) as lowercase hex, the bytes (good for the call)
typedef void (*tp_heard_fn)(void *context, const char *from, const uint8_t *bytes, size_t length);
typedef struct tp_listener tp_listener;
// subscribes as needed; the listener, for tp_unlisten
tp_listener *tp_listen(tp_device *t, const char *topic, tp_heard_fn fn, void *context);
void tp_unlisten(tp_device *t, tp_listener *l);
// the check's changed: what waited on it (HY_WAIT) is judged again, at the next tp_run
void tp_changed(tp_device *t);

#endif
