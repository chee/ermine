// littlesync: a small-device sync stack for ermine, in C. A device with no room for history (an ESP32-S3
// with 512 KB of SRAM) follows a few nodes, keeps what makes their current value, and syncs with one peer
// over a byte stream (USB serial) in lab-pig's format. Sans-IO: this file's device does no reading,
// writing, sleeping or threading. Transports are parts outside it (host/pigs.c is one, a Cardputer loop
// is another, see "use" below).
//
// what a device keeps, per followed node (never a history):
//   - its current value (an op_value, value.h)
//   - per path written, a stamp: the lamport and name of the commit that last wrote there
//   - the sealed bytes of the commits that hold a stamp (the ones that made the value), so a fresh
//     peer can be sent them and verify them; its own until the peer has them
//   - a few names it has seen and dropped (so it does not ask for them again)
//   - ephemeral values (a pig being carried), per sending device, never stored
// everything older is dropped: a commit with no stamp left is gone.
//
// merge, per path, last writer wins. every patch is a set or a delete at a path of string keys (a
// range, a move or a list index is refused, with a reason). an incoming patch applies when its stamp
// (lamport, then name bytes) beats the stamps on its path and on every ancestor path; applying it drops
// the stamps below it, except the ones that beat it (they stay, and their values are put back on top).
// So the same commits in any order give the same value. A new commit's lamport is 1 + the highest
// seen on its node; its parents are the names of the commits making the node now (the LS_MAX_PARENTS highest: a seal is
// small that way, and nothing here walks parents).
//
// the node's id is in the signed message (a seal is good in its document only, seal.h), so a commit
// sealed for one node does not verify in another.
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
// ---- use (a device loop, the USB-serial-JTAG on a Cardputer) ----
//   ls_store st = ls_store_nvs("littlesync");              // ESP-IDF: nvs_flash_init() before
//   ls_options o = {.store = st, .random = my_random};   // my_random: esp_fill_random
//   ls_dev *d = ls_open(&o);
//   ls_node *room = ls_follow(d, LS_ROOM);              // the room: {[pig id]: true|false}
//   for (;;) {                                           // one task, 8 KB of stack or more
//     n = usb_serial_jtag_read_bytes(buf, sizeof buf, 0); if (n > 0) ls_feed(d, buf, n);
//     ls_tick(d, esp_timer_get_time() / 1000);
//     const uint8_t *out; size_t m = ls_next(d, &out);
//     if (m) usb_serial_jtag_write_bytes(out, m, portMAX_DELAY);   // all of it: valid till the next ls_ call
//     // read pigs: when ls_version(room) changed, for each key of ls_value(room) that is a pig (ls_pig_id)
//     // with a true value: ls_follow(d, key), then ls_pig_read(ls_value(pig), &p), and for each
//     // ls_held_at(pig, i) laid over p (ls_pig_held). pigs.h has the helpers.
//     // store a pig: ls_put(pig, v) with v from ls_pig_make; wave one: ls_hold(pig, ls_pig_make_held(...))
//     // each frame, ls_unhold(pig) is not needed: ls_put drops your own hold.
//   }
// no threads inside: call from one task. Everything the device hands out (values, held) is the
// device's: never change it, it is valid until the next ls_ call.
#ifndef LITTLESYNC_H
#define LITTLESYNC_H

#include "../../../../core/op/c/value.h"

#include <stddef.h>
#include <stdint.h>

#define LS_STACK "littlesync/0"
// the merge rule a commit with several parents names (commit.h wants one): per-path last writer wins
#define LS_MERGE "littlesync/lww-path"
// the default room, and the first pig (lab-pig's), ids as the graph has them
#define LS_ROOM "ermine://bf04115f9b284145026eab6801219d6e" "00000000000000000000000000000000"
#define LS_FIRST "ermine://d3b583537595c9a6de0110781d4566d1" "00000000000000000000000000000000"
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
	LS_BAD,     // an argument that is not a thing (a path with no keys... a value too deep, a node not followed)
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

// NULL when there is no key and none could be made. Loads the key, or makes it from options.random
ls_dev *ls_open(const ls_options *options);
// saves every node and frees all
void ls_close(ls_dev *dev);
// bytes that arrived (any: frames among text, half a frame, nothing)
void ls_feed(ls_dev *dev, const uint8_t *bytes, size_t length);
// the bytes to send now, all of them: *out is valid until the next ls_ call. 0: nothing
size_t ls_next(ls_dev *dev, const uint8_t **out);
// time has passed: now_ms is a clock that only goes up (any start)
void ls_tick(ls_dev *dev, int64_t now_ms);
// this device's key (LS_KEY_LEN bytes, a multikey), and the peer's once it has said hello (else NULL)
const uint8_t *ls_key(const ls_dev *dev);
const uint8_t *ls_peer(const ls_dev *dev);
// whether the peer has been heard from lately (8 s)
int ls_up(const ls_dev *dev);

typedef struct {
	uint32_t frames_in, frames_out;
	uint32_t junk;       // frames that did not decode, and text between them
	uint32_t refused;    // commits refused (ls_reason)
	uint32_t bad_seals;  // seals that did not verify
	uint32_t commits_in, applied, dropped_out;
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
// how many commits make the value now, and the highest lamport seen
size_t ls_commits(const ls_node *node);
int64_t ls_lamport(const ls_node *node);

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
// hold: this device's value, sent now and every LS_BEAT_MS till ls_unhold, a write, or ls_close
ls_code ls_hold(ls_node *node, const op_value *value);
void ls_unhold(ls_node *node);
// the held values now: i from 0 to ls_helds - 1 (entries with a value only)
size_t ls_helds(const ls_node *node);
const ls_held *ls_held_at(const ls_node *node, size_t i);

#include "pigs.h"

#endif
