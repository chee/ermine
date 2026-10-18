// littlesync: a small-device sync stack for ermine, in C. A device with no room for history (an ESP32-S3
// with 512 KB of SRAM) follows a few nodes, keeps what makes their current value, and syncs with up to LS_LINKS peers
// over byte streams (USB serial, a second serial line). Sans-IO: this file's device does no reading,
// writing, sleeping or threading. Transports are parts outside it (see "use" below). A user: lab-pig's
// pigs (playground/demos/pigs/littlesync: its value format, pigs.h, and littlesync-pigs, a Mac peer;
// the Cardputer, playground/cardputer).
//
// what a device keeps, per followed node (never a history):
//   - its current value (an op_value, value.h)
//   - per path written, a stamp: the lamport and name of the commit that last wrote there
//   - the sealed bytes of the commits that hold a stamp (the ones that made the value), so a fresh
//     peer can be sent them and verify them; its own until each peer has them
//   - a few names it has seen and dropped (so it does not ask for them again)
//   - per commit held, whether a commit taken in names it as a parent (then it is no head), and a few
//     parents named that are not held (yet)
//   - ephemeral values (a value being carried, held up by a device), per sending device, never stored
// everything older is dropped: a commit with no stamp left is gone.
//
// merge, per path, last writer wins. every patch is a set or a delete at a path of string keys (a
// range, a move or a list index is refused, with a reason). an incoming patch applies when its stamp
// (lamport, then name bytes) beats the stamps on its path and on every ancestor path; applying it drops
// the stamps below it, except the ones that beat it (they stay, and their values are put back on top).
// So the same commits in any order give the same value. A new commit's lamport is 1 + the highest
// held on its node; its parents are the heads, as far as the device can tell: the held commits no
// commit it has taken in names as a parent (the LS_MAX_PARENTS highest when there are more, the
// highest held always, so the lamport is 1 + its parents' highest). Nothing here walks parents.
//
// the node's id is in the signed message (a seal is good in its document only, seal.h), so a commit
// sealed for one node does not verify in another.
//
// trust: the peers are trusted (your own Mac over USB). Any key may write: a seal shows who signed, not
// that they may. A commit's lamport is taken as given (no parents are kept to check it), so a high
// one wins every path it writes, and one at 2^53 - 1 leaves no lamport for this device's next write.
// Ephemerals are not sealed: a held value may name any signer but this device's own. Not for a peer
// you don't trust.
//
// links: a device talks to several peers at once, each over its own byte stream (ls_link). A link has its own
// rx buffer, out queue, hello and heads timers, and the record of which of the device's own commits that
// peer has acked; the nodes and everything written are the device's. A write goes to every link that is up.
// The device is a relay: what is taken in from one link is offered to the others (heads, then they want
// it), never back to the one it came from; a held (ephemeral) value taken in on one link is sent on, still
// unsealed, to the others. Links should not form a ring (a hold would go round for ever).
//
// wire (frames in a byte stream that may also carry other text, a console log): 0x00, the COBS of
// ("L", one CBOR message, the CRC-32 of the message, 4 bytes little end), 0x00. What does not decode
// is dropped (ls_stats.junk). Messages are maps with "t":
//   hello      {key: multikey, stack: "littlesync/0", re?: true}
//   heads      {node: 32 bytes, heads: [name], re?: true}  names of the commits making the node
//   want       {node, names: [name]}
//   commits    {node, sealed: [bytes]}                      seals (seal.h's format)
//   ephemeral  {node, commit: bytes}                        an unsealed commit, one put at []
//   ack        {node, names: [name]}
// sync: on hello, and whenever a node changes, each side sends heads for what it follows; a side that
// lacks names sends want; the other sends the commits it still has; the receiver acks what it took
// in. A heads that lacks names its receiver has is answered once with the receiver's heads (re).
//
// ephemeral: shown on top of the stored value, one per sending device (its signer), dropped when that
// device's next stored commit on the node lands, or 4 s after the last beat. ls_hold resends every 1 s.
//
// storage (ls_store): one blob per name: "key" (the 32-byte seed) and "node:<id>" (the node's seals).
//
// ---- use (a device loop, the USB-serial-JTAG on a Cardputer; one link, a second is the same again) ----
//   ls_store st = ls_store_nvs("littlesync");              // ESP-IDF: nvs_flash_init() before
//   ls_options o = {.store = st, .random = my_random};   // my_random: esp_fill_random
//   ls_dev *d = ls_open(&o);
//   ls_link *usb = ls_link(d);                           // one per byte stream; ls_unlink when it goes away
//   ls_node *node = ls_follow(d, "ermine://<64 hex>");   // a node: its saved value, then its peers'
//   uint32_t seen = 0;
//   for (;;) {                                           // one task, 8 KB of stack or more
//     n = usb_serial_jtag_read_bytes(buf, sizeof buf, 0); if (n > 0) ls_feed(usb, buf, n);
//     ls_tick(d, esp_timer_get_time() / 1000);
//     const uint8_t *out; size_t m = ls_next(usb, &out);
//     if (m) usb_serial_jtag_write_bytes(out, m, portMAX_DELAY);   // all of it: valid till the next ls_ call
//     // read: when ls_version(node) != seen (then seen = it), ls_value(node) is the stored value, and
//     // ls_held_at(node, i), i below ls_helds(node), the values peers hold up over it
//     // write: ls_set(node, "x", v) one key, ls_put(node, v) the whole value; both copy v (op_free it)
//     // hold: ls_hold(node, v) shows v to the peers, sent every LS_BEAT_MS till ls_unhold(node) or a
//     // write of this device's on the node
//   }
// no threads inside: call from one task. Everything the device hands out (values, held) is the
// device's: never change it, it is valid until the next ls_ call.
#ifndef LITTLESYNC_H
#define LITTLESYNC_H

#include "../../../../core/op/c/value.h"

#include <stddef.h>
#include <stdint.h>

// at most this many links on a device (each has a frame buffer). A commit marks the links that acked it in
// one byte
#ifndef LS_LINKS
#define LS_LINKS 4
#endif
#define LS_STACK "littlesync/0"
// the merge rule a commit with several parents names (commit.h wants one): per-path last writer wins
#define LS_MERGE "littlesync/lww-path"
#define LS_ID_LEN 73
// a multikey of an Ed25519 key (0xed 0x01 and 32 bytes)
#define LS_KEY_LEN 34
// at most this many commits are named in one heads (the highest lamports): a node with more is
// synced in part. At most this many parents to a commit
#define LS_MAX_HEADS 64
#ifndef LS_MAX_PARENTS
#define LS_MAX_PARENTS 4
#endif
// a held (ephemeral) value goes after this long without a beat, and is resent this often
#define LS_HELD_MS 4000
#define LS_BEAT_MS 1000

typedef enum {
	LS_OK,
	LS_BAD,     // an argument that is not a thing (a path with no keys... a value too deep, a node not followed, a
	            // write whose seal is over 3000 bytes: one message)
	LS_REFUSED, // a commit with something v1 does not merge (ls_reason says what)
} ls_code;

// storage: one blob under a name. load: 1 and a malloc'd *out (free it), 0 when there is none. save:
// 1 when kept. Function pointers: a file one (store_file.c) and an NVS one (store_nvs.c) are given
typedef struct {
	int (*load)(void *context, const char *name, uint8_t **out, size_t *length);
	int (*save)(void *context, const char *name, const uint8_t *data, size_t length);
	void *context;
} ls_store;
// a store in the directory (made if it is not there): a file for each name. context is malloc'd:
// ls_store_file_free
ls_store ls_store_file(const char *dir);
void ls_store_file_free(ls_store *store);
#ifdef ESP_PLATFORM
// a store in an NVS namespace (nvs_flash_init first); names are hashed to NVS's 15-character keys
ls_store ls_store_nvs(const char *space);
#endif

typedef struct {
	ls_store store;
	// fills out[0..n) with random bytes (the signing seed the first time, and nonces)
	void (*random)(void *context, uint8_t *out, size_t n);
	void *random_context;
	// added to the ms ls_tick is given to make a commit's time (0: the uptime)
	int64_t epoch_ms;
	size_t max_nodes;  // 0: 64
	uint32_t save_ms;  // 0: 2000. a changed node is saved at most this often
	// protocol events, one line each (NULL: none)
	void (*log)(void *context, const char *line);
	void *log_context;
} ls_options;

typedef struct ls_dev ls_dev;
typedef struct ls_node ls_node;
// no typedef: ls_link is also the function that opens one
struct ls_link;

// NULL when there is no key and none could be made. Loads the key, or makes it from options.random
ls_dev *ls_open(const ls_options *options);
// saves every node and frees all
void ls_close(ls_dev *dev);
// a byte stream to one peer: NULL when the device has LS_LINKS already. Its peer is told hello at the next
// ls_tick
struct ls_link *ls_link(ls_dev *dev);
// the stream is closed: the link is freed (ls_close frees the rest). A link opened again starts over
void ls_unlink(struct ls_link *link);
// bytes that arrived on the link (any: frames among text, half a frame, nothing)
void ls_feed(struct ls_link *link, const uint8_t *bytes, size_t length);
// the bytes to send on the link now, all of them: *out is valid until the next ls_ call. 0: nothing
size_t ls_next(struct ls_link *link, const uint8_t **out);
// time has passed, for every link: now_ms is a clock that only goes up (any start)
void ls_tick(ls_dev *dev, int64_t now_ms);
// this device's key (LS_KEY_LEN bytes, a multikey), and a link's peer's once it has said hello (else NULL)
const uint8_t *ls_key(const ls_dev *dev);
const uint8_t *ls_peer(const struct ls_link *link);
// whether the peer has been heard from lately (8 s)
int ls_up(const struct ls_link *link);

// per link
typedef struct {
	uint32_t frames_in, frames_out;
	uint32_t junk;        // frames that did not decode, and text between them
	uint32_t dropped_out; // messages dropped for a full out queue
} ls_traffic;
const ls_traffic *ls_traffic_of(const struct ls_link *link);
// per device
typedef struct {
	uint32_t refused;    // commits refused (ls_reason)
	uint32_t bad_seals;  // seals that did not verify
	uint32_t commits_in, applied;
} ls_stats;
const ls_stats *ls_stats_of(const ls_dev *dev);
// why the last commit was refused, a static string ("" if none)
const char *ls_reason(const ls_dev *dev);

// follow a node by id ("ermine://" and 64 hex): loads what was saved. NULL: not an id, or too many nodes
ls_node *ls_follow(ls_dev *dev, const char *id);
ls_node *ls_find(ls_dev *dev, const char *id);
const char *ls_id(const ls_node *node);
// the stored value (NULL: none). Counts up whenever the value or a held value changes
const op_value *ls_value(const ls_node *node);
uint32_t ls_version(const ls_node *node);
// how many commits make the value now, and the highest lamport held
size_t ls_commits(const ls_node *node);
int64_t ls_lamport(const ls_node *node);

// what a node costs, now: in the store, in seals, and its newest commit's seal taken apart. Every part
// is its bytes as encoded (CBOR: a head and the bytes), field names not counted in them
typedef struct {
	size_t stored;  // the bytes the store keeps for it (the blob "node:<id>")
	size_t commits; // commits held (ls_commits)
	size_t seals;   // their seals' bytes, all
	// the newest commit held (the highest lamport); all 0 when none
	struct {
		size_t length;        // its seal, all of it
		size_t signature;     // the signature (the varsig header, 8 bytes, and 64)
		size_t signer;        // the signer's multikey
		size_t parents;       // how many parents
		size_t parents_bytes; // the parents list
		size_t patches;       // the patches: paths and values
		size_t rest;          // field names, table, actor, time, nonce, lamport, merge, the seal's map
	} newest;
} ls_cost;
// encodes the node's blob and decodes its newest seal: for showing, not for every frame of a loop
ls_cost ls_cost_of(const ls_node *node);

// a write: a path of string keys (none: the whole value) set to value (NULL: deleted). Copied
typedef struct {
	const char *const *path;
	size_t length;
	const op_value *value;
} ls_patch;
// one commit of the patches, sealed and sent. Drops this device's hold on the node
ls_code ls_write(ls_node *node, const ls_patch *patches, size_t n);
// the whole value; one key of it; a key removed
ls_code ls_put(ls_node *node, const op_value *value);
ls_code ls_set(ls_node *node, const char *key, const op_value *value);
ls_code ls_del(ls_node *node, const char *key);

// a held value: shown on top of the stored one, by the device whose key is signer
typedef struct {
	uint8_t signer[LS_KEY_LEN];
	size_t signer_length;
	op_value *value; // NULL: none now (the device's last stored lamport is kept)
	int own;
	// the stack's
	int64_t last, expires;
} ls_held;
// hold: this device's value, sent now and every LS_BEAT_MS, on every link, till ls_unhold, a write, or ls_close
ls_code ls_hold(ls_node *node, const op_value *value);
void ls_unhold(ls_node *node);
// the held values now: i from 0 to ls_helds - 1 (entries with a value only)
size_t ls_helds(const ls_node *node);
const ls_held *ls_held_at(const ls_node *node, size_t i);

#endif
