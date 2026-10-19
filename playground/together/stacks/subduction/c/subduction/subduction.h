// subduction.h: the C ABI of libsubduction_c.a (src/, Rust, no_std with alloc). NOTES.md.
//
// sans-IO: no I/O, threads or clock. the host opens connections, hands in each binary message
// (erm_sd_received), sends what SEND events ask, and calls erm_sd_run with the time after a call,
// a message in, or when the time it gave has passed; then takes events (erm_sd_poll) and frees each
// (erm_sd_free_event). calls but the first four return a call number at once; the answer is a
// later event naming it. ids, digests, topics, keys: 32 bytes. calls copy their input; NULL for a
// list or bytes with a nonzero count: refused (call number 0). one thread, one call at a time.
// storage: the host's store (store.h). the host defines platform.h's erm_host_random, _malloc,
// _realloc, _free, _abort; otherwise only memcpy, memmove, memset, memcmp are linked.

#ifndef ERM_SUBDUCTION_H
#define ERM_SUBDUCTION_H

#include "platform.h"
#include "store.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ErmSd ErmSd;

/** what an event is */
enum {
	ERM_SD_DONE = 1,  // a call finished: ok, or error
	ERM_SD_CONNECTED, // erm_sd_connect: the handshake is done, key the server's; or error
	ERM_SD_COMMITS,   // erm_sd_commits: the commits of doc (found 0: none held)
	ERM_SD_BLOB,      // erm_sd_blob: the blob, bytes (NULL: not held); or error
	ERM_SD_HEADS,     // by itself: the peer `key` told of its heads of doc
	ERM_SD_HEARD,     // by itself: an ephemeral message on topic, signed by `key`, payload in bytes
	ERM_SD_SEND,      // send bytes as one binary message on connection conn
	ERM_SD_CLOSE,     // close connection conn
};

/** a loose commit held: its id, its blob's digest, its parents (parentCount of 32 bytes each) */
typedef struct ErmSdCommit {
	uint8_t id[32];
	uint8_t digest[32];
	const uint8_t *parents;
	size_t parentCount;
} ErmSdCommit;

typedef struct ErmSdEvent {
	int kind;
	uint64_t call;                // the call it answers; 0 for HEADS, HEARD, SEND and CLOSE
	uint64_t conn;                // CONNECTED, SEND, CLOSE: the connection
	int ok;                       // 1; 0 when the call failed, with error
	const char *error;            // why, when not ok
	uint8_t doc[32];              // COMMITS, BLOB, HEADS: the sedimentree
	uint8_t key[32];              // CONNECTED: the server's; HEADS: the peer's; HEARD: the sender's
	uint8_t topic[32];            // HEARD
	const uint8_t *bytes;         // HEARD: the payload; SEND: the message; BLOB: the blob, NULL when not held
	size_t length;
	int found;                    // COMMITS: whether the sedimentree is held at all
	const ErmSdCommit *commits;   // COMMITS
	size_t count;
	void *owned;                  // the library's: erm_sd_free_event frees what the pointers above hold
} ErmSdEvent;

/**
 * a node signing with the seed's Ed25519 key, open to every peer, keeping
 * what it holds in the store (copied; what it points to must outlive the
 * node), now as erm_sd_run takes it: NULL without a store
 */
ErmSd *erm_sd_new(const uint8_t seed[32], uint64_t now, const ErmStore *store);
/** frees the node, its tasks and the events not taken (not the store) */
void erm_sd_free(ErmSd *sd);
/** the public key (the peer id) a seed signs as */
void erm_sd_key(const uint8_t seed[32], uint8_t out[32]);
/**
 * runs what can run, now being the wall clock in ms since the Unix epoch
 * (taken as never going back): the ms until it must run again though nothing
 * comes in (0: at once), or -1 for only when something does
 */
int64_t erm_sd_run(ErmSd *sd, uint64_t now);
/** the next event into *event, 1; or 0 when none waits */
int erm_sd_poll(ErmSd *sd, ErmSdEvent *event);
/** frees what an event holds */
void erm_sd_free_event(ErmSdEvent *event);

/**
 * a connection to a server over a transport the host has opened: the
 * client's handshake, its audience discovered by the service name (the
 * server URL's host, with :port when the URL names one), then the
 * connection added. Its number is the call's, the conn of its SEND and CLOSE
 * events and of erm_sd_received and erm_sd_closed: CONNECTED
 */
uint64_t erm_sd_connect(ErmSd *sd, const char *service);
/** a binary message that arrived on a connection (NULL with a length: none) */
void erm_sd_received(ErmSd *sd, uint64_t conn, const uint8_t *bytes, size_t length);
/** the host's transport for a connection closed */
void erm_sd_closed(ErmSd *sd, uint64_t conn);

/** stores a commit, its parents count * 32 bytes, and pushes it to the subscribed peers: DONE */
uint64_t erm_sd_add_commit(ErmSd *sd, const uint8_t doc[32], const uint8_t commit[32], const uint8_t *parents, size_t count, const uint8_t *blob, size_t length);
/**
 * stores a fragment (FRAGMENT.tex): its head, its boundary (count * 32
 * bytes) and checkpoints (checks * 32 bytes, CommitIds, which it keeps as
 * their first 12 bytes), and pushes it to the subscribed peers: DONE
 */
uint64_t erm_sd_add_fragment(ErmSd *sd, const uint8_t doc[32], const uint8_t head[32], const uint8_t *boundary, size_t count, const uint8_t *checkpoints, size_t checks, const uint8_t *blob, size_t length);
/** syncs a sedimentree with every connected peer, subscribing to it when subscribe, within timeout ms (0: the default): DONE */
uint64_t erm_sd_sync(ErmSd *sd, const uint8_t doc[32], int subscribe, uint64_t timeout);
/** the loose commits held of a sedimentree: COMMITS */
uint64_t erm_sd_commits(ErmSd *sd, const uint8_t doc[32]);
/** a blob held, by its digest: BLOB */
uint64_t erm_sd_blob(ErmSd *sd, const uint8_t doc[32], const uint8_t digest[32]);
/** subscribes to an ephemeral topic with every connected peer: DONE. Subscriptions and publications are made in the order called */
uint64_t erm_sd_subscribe(ErmSd *sd, const uint8_t topic[32]);
/** signs and publishes a payload to an ephemeral topic, stamped with the time last run: DONE */
uint64_t erm_sd_publish(ErmSd *sd, const uint8_t topic[32], const uint8_t *payload, size_t length);

/**
 * A commit or fragment record of the store (store.h's COMMIT or FRAGMENT
 * bytes, Subduction's Signed encoding), decoded with no task, for a host that
 * reads the store itself: a commit's id and parents, or a fragment's head,
 * boundary (in parents) and checkpoints (12 bytes each); its blob's digest
 * and size; who signed it. Free it with erm_sd_free_record.
 */
typedef struct ErmSdRecord {
	int fragment;
	uint8_t id[32];
	uint8_t digest[32];
	uint64_t size;
	uint8_t issuer[32];
	const uint8_t *parents;
	size_t parentCount;
	const uint8_t *checkpoints;
	size_t checkpointCount;
	void *owned;
} ErmSdRecord;

/** decodes a record of kind ERM_STORE_COMMIT or ERM_STORE_FRAGMENT into *record: 1, or 0 when it is not one */
int erm_sd_decode(int kind, const uint8_t *bytes, size_t length, ErmSdRecord *record);
void erm_sd_free_record(ErmSdRecord *record);

#ifdef __cplusplus
}
#endif

#endif
