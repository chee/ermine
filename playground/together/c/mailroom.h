// mailroom.h: what a device keeps of its documents' commits, whatever carries them (mailroom.ts in
// TypeScript). Per document: two histories (history.h), stored and ephemeral (holding every stored
// commit too); the seals taken in and those waiting on a parent's seal; what is refused; the snapshots
// that came as hints. And this device's own takes: taken in unchecked, then queued for the stack to send,
// in the order made. What arrives is checked (the mailroom's seal handling, then the histories and the
// integration's check).
//
// a stack (subduction.h is one; a small device's, as playground/together/stacks/littlesync's, would be another) is
// what carries commits: it reads and writes the network, a store and a clock, and talks to the mailroom
// through the functions here. It hands in what arrives (mr_pend, mr_member, mr_settle, mr_hint,
// mr_hear, mr_tell_stopped, mr_refuse) and takes what goes out (mr_front, mr_pop; mr_sealed and
// mr_handed for a stored commit). It may read a mr_doc's fields (histories, names, seen, order) and
// changes none of them but through these functions. The mailroom never reads a network, a store or a
// clock. Sans-IO as the device is: one thread at a time.
#ifndef MR_MAILROOM_H
#define MR_MAILROOM_H

#include "history.h"
#include "ids.h"
#include "replay.h"
// ermine ids: for now only an ermine id is a document here (mr_id); together's own ids.h is the maps
// above
#include "../../../ermine/ids/c/ids.h"
#include "seal.h"

#include <stdbool.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdint.h>

typedef struct mr_mailroom mr_mailroom;
typedef struct mr_doc mr_doc;

typedef enum { MR_STORED, MR_EPHEMERAL } mr_layer;
// "stored", "ephemeral"
const char *mr_layer_name(mr_layer layer);

// why the mailroom or the stack refused a seal, a fragment or an ephemeral commit before a history saw it
// (what a history refuses is the history's: hy_refused). MR_BOUNDARY: a fragment's members, boundary
// or checkpoints not what Subduction's build makes them for its head. MR_ID: an envelope opened (a
// stack's: the id and what it carries) naming another id than the one followed (the refusal of a
// second id for a tree held is replaced by the envelope's id check), or a seal for another id (SL_ID)
typedef enum { MR_LOCK = 1, MR_SHAPE, MR_SIGNATURE, MR_STORED_ID, MR_PARENTS, MR_BOUNDARY, MR_ID } mr_code;
// "lock", "shape", "signature", "stored", "parents", "boundary", "id"
const char *mr_code_name(mr_code code);
// a refusal as the maps of them hold it (the refused, the heard, the stack's fragments refused whole):
// its code, and the text beside it (a lock's, or why an envelope's id is not this one; malloc'd; NULL:
// none)
typedef struct {
	mr_code code;
	char *why;
} mr_refusal;

// what a device holds for others at most, each letting go of its oldest past it (heard again, it
// comes in again), as mailroom.ts's Limits: pending, a document's seals waiting on a parent's seal and its
// stored commits waiting on a parent, and at the stack what waits on the lock (loose commits and
// fragments, each apart); refused, its refusals noted (each kind) and its snapshot hints;
// waiting, its ephemeral commits waiting on a parent. 0: the default (65 536, 4 096, 1 024)
typedef struct {
	size_t pending, refused, waiting;
} mr_limits;

// a commit taken into a history from elsewhere (the network or the store), after it is taken in;
// heard: from a peer's ephemeral message. This device's own takes are not told. Good for the call
typedef struct {
	const char *doc;
	mr_layer layer;
	const hy_kept *kept;
	bool heard;
} mr_arrival;
typedef void (*mr_arrived_fn)(void *context, const mr_arrival *arrival);

// the integration's: whether a commit from elsewhere, its parents all taken in, applies to its
// parent's node. Never asked of this device's own takes. It may apply it as it looks. 0: yes; else the
// refusal (HY_PATCHES: it does not apply; HY_MERGE: a merge by a rule not known here); HY_WAIT: it
// cannot judge it yet, and asks again on mr_changed
typedef hy_refusal (*mr_check_fn)(void *context, const char *doc, const hy_kept *kept, const cm_commit *commit,
	mr_layer layer);

typedef struct {
	// the seals' signer: the device's Ed25519 key
	uint8_t seed[32];
	// NULL: everything applies
	mr_check_fn check;
	void *context;
	// the merge rules a snapshot from elsewhere is checked with (a replay to its head); NULL: none.
	// borrowed: it must outlive the mailroom
	const rp_merges *merges;
	mr_limits limits;
} mr_options;

// what the mailroom tells its stack, both optional, given once (mr_attach). made: a document made, its stack
// slot (mr_doc.stack) to be filled; handed: a seal taken in at the document, own or not
typedef struct {
	void (*made)(void *context, mr_doc *d);
	void (*handed)(void *context, mr_doc *d, const uint8_t stored[32]);
} mr_stack;

// ---- what is kept of a seal

// a seal's commit, as the mailroom reads it: its name, bytes, the seal's stored id, lamport, parents
typedef struct {
	uint8_t name[CM_NAME], stored[32];
	uint8_t *bytes;
	size_t length;
	int64_t lamport;
	uint8_t (*parents)[CM_NAME];
	size_t parents_length;
} mr_sealed_t;

void mr_sealed_free(mr_sealed_t *s);
// the unsealed's, taking its bytes; the unsealed is let go of
void mr_sealed_of(mr_sealed_t *s, sl_unsealed *u);

// a seal taken in: its commit's name and lamport, its commit's bytes, its sealed bytes (NULL: a
// commit a pack's next vouched for, held without a seal), and the stored ids of the seals it was taken
// in over (its commit's parents; or, for a seal alone, every seal of each)
typedef struct {
	uint8_t stored[32], name[CM_NAME];
	int64_t lamport;
	uint8_t *bytes;
	size_t length;
	uint8_t *sealed;
	size_t sealed_length;
	uint8_t (*ids)[32];
	size_t ids_length;
} mr_seen_t;

// a loose commit, or a seal alone (a fragment's member), not yet handed to the histories: its parents
// not all here, or one refused. given: the commit's parents' stored ids, sorted. waiting, stuck: what
// settle last found
typedef struct {
	uint8_t key[32];
	bool commit;
	mr_sealed_t it;
	uint8_t *sealed;
	size_t sealed_length;
	uint8_t (*given)[32];
	size_t given_length;
	bool waits, sticks;
	uint8_t (*waiting)[CM_NAME];
	size_t waiting_length;
	uint8_t (*stuck)[CM_NAME];
	size_t stuck_length;
} mr_pending_t;

// a fragment's member: its sealed bytes (NULL: vouched for by the next in its pack), and its commit as
// the mailroom reads it
typedef struct {
	uint8_t *sealed;
	size_t length;
	mr_sealed_t it;
} mr_member_t;

// a name's stored ids (one: a stored id is of the id and the name, seal.h)
typedef struct {
	uint8_t (*ids)[32];
	size_t length, room;
} mr_idlist_t;

typedef struct {
	uint8_t *bytes;
	size_t length;
} mr_blob_t;
void mr_blob_free(void *b);

// the keys of a map in the order they came, so its oldest can be let go of past a most (mailroom.ts's
// note, a Map's order): each with the serial it came with, which at keeps, so one that went and came
// again is where it came last
typedef struct {
	im_map at;
	struct {
		uint8_t key[CM_NAME];
		uintptr_t serial;
	} *keys;
	size_t first, count, room;
	uintptr_t serial;
} mr_order_t;

void mr_order_free(mr_order_t *o);
// the key into the map, under value. New to it: past most, the oldest let go of first (drop: what is
// done with its value, or NULL)
void mr_note(im_map *m, mr_order_t *o, const uint8_t *key, void *value, size_t most, void (*drop)(void *value));

// ---- documents

typedef struct {
	mr_doc *d;
	mr_layer layer;
} mr_side;

// a document: its id (text, malloc'd; its UTF-8, length bytes, is what a seal and the lock bind), and
// the mailroom's key for it (mr_id: a hash of the id, never stored or sent). A stack files it under
// its own address (Subduction's: a tree id) in its slot
struct mr_doc {
	char *id;
	size_t length;
	uint8_t key[32];
	mr_mailroom *mailroom;
	// the stack's: made by its mr_stack.made
	void *stack;
	mr_side sides[2];
	hy_history *histories[2];
	// what each history was given from elsewhere and has not taken in yet, by name: 1 + heard
	im_map elsewhere[2];
	// this device's own takes waiting on a parent, by name: sent once let in
	im_map own[2];
	// a taken-in seal's name to its stored ids (mr_idlist_t)
	im_map names;
	// by stored id (mr_seen_t), and in the order taken in
	im_map seen;
	mr_seen_t **order;
	size_t order_count, order_room;
	// the snapshots fragments carried, packed, by their head's name (mr_blob_t), each checked (hint); the
	// snapshots not checked yet (mr_blob_t), and the heads checked
	im_map snapshots, hints, judged;
	// by a commit's head or a seal's stored id (mr_pending_t)
	im_map pending;
	// refusals (mr_refusal): by head or stored id; refused ephemeral commits by name: one the lock
	// refused by the name of the bytes as they came (closed: it could not be opened), one refused after
	// (shape, signature) by the opened commit's
	im_map refused, heard;
	// names of seals refused here
	im_map bad;
	// the order each capped map's keys came in (mr_note)
	mr_order_t pending_order, refused_order, heard_order, bad_order, hints_order;
	// ephemeral commits to let go of once nothing queued holds them (mr_forget)
	uint8_t (*forgets)[CM_NAME];
	size_t forgets_count, forgets_room;
	mr_doc *next;
};

// ---- the mailroom

// a mailroom (out of memory aborts)
mr_mailroom *mr_create(const mr_options *options);
void mr_free(mr_mailroom *k);
void mr_attach(mr_mailroom *k, const mr_stack *stack, void *context);
// the device's key: an Ed25519 multikey, SL_KEY bytes
const uint8_t *mr_key(const mr_mailroom *k);
const mr_limits *mr_limits_of(const mr_mailroom *k);

// whether the text is a document's id, and the mailroom's key for it (the BLAKE3 of its UTF-8). For
// now only an ermine id (of any kind: ermine/ids) is: which nodes sync is sync's own question, and
// changes with its plan, not here
bool mr_id(const char *doc, uint8_t key[32]);
// the document by its id, made when first named (the stack told: mr_stack.made). NULL: not a
// document's id. An id is compared as its bytes: two ids, two documents
mr_doc *mr_named(mr_mailroom *k, const char *id);
// the document under the key (mr_id) if it is here, else NULL; and the first of all, in the order
// made (mr_doc.next)
mr_doc *mr_find(const mr_mailroom *k, const uint8_t key[32]);
mr_doc *mr_first(const mr_mailroom *k);

// a peer's key (Subduction's, Ed25519) as the multikey the commits carry it as
void mr_peer(const uint8_t from[32], uint8_t key[SL_KEY]);
void mr_hex(const uint8_t *bytes, size_t n, char *out);
void *mr_copy(const void *bytes, size_t length);

// what the stack hands in
// a seal taken in as a fragment's member, unsealed: no commit around it. Takes the member's
void mr_member(mr_doc *d, mr_member_t *m);
// pending, the oldest let go of past the limit (heard again, it comes in again); its key's refusal let go
void mr_pend(mr_doc *d, mr_pending_t *p);
// a refusal noted under the key in m (o: its order): the code and a copy of the text (NULL: none),
// in place of any before; past most, the oldest let go of
void mr_refusal_note(im_map *m, mr_order_t *o, const uint8_t *key, mr_code code, const char *why, size_t most);
// the refusal under the key let go of, its text with it
void mr_refusal_del(im_map *m, const uint8_t *key);
// every refusal in m let go of, and m
void mr_refusals_free(im_map *m);
// a seal refused: noted by key, its name (NULL: none) noted bad; what pends under the key let go of
void mr_refuse(mr_doc *d, const uint8_t key[32], mr_code code, const uint8_t *name, const char *why);
// for each pending seal, until none moves: stuck, waiting, or handed to the histories
void mr_settle(mr_doc *d);
// a snapshot a fragment carried is a hint, checked once its head is taken in; own: made here, kept
// as it is
void mr_hint(mr_doc *d, const uint8_t name[CM_NAME], const uint8_t *bytes, size_t length, bool own);
// an ephemeral commit that arrived, opened, from a device with that key (a multikey): decode, its
// signer the sender's; then handed to the ephemeral history; never stored
void mr_hear(mr_doc *d, const uint8_t *blob, size_t length, const uint8_t from[SL_KEY]);
// an ephemeral commit refused before it could be opened (the lock's refusal), noted under its name:
// the name of the bytes as they arrived, closed
void mr_unheard(mr_doc *d, const uint8_t *blob, size_t length, mr_code code, const char *why);
// a stop heard from a device (a multikey): the listeners told
void mr_tell_stopped(mr_doc *d, const uint8_t from[SL_KEY], const char *table);
// a seal opened and checked, in its document: its commit in *u
sl_code mr_opened(mr_doc *d, const uint8_t *blob, size_t length, sl_unsealed *u);
// what is held back or refused at the document may have changed: told
void mr_tell_moved(mr_mailroom *k, mr_doc *d);
// whether a commit waits on a parent: a seal held here for its parents' seals, or a commit in the
// stored history
bool mr_waits(const mr_doc *d);

// this device's own stored commit: sealed (malloc'd into *sealed, with its stored id); false: it
// could not be
bool mr_sealed(mr_doc *d, const hy_kept *kept, uint8_t **sealed, size_t *length, uint8_t stored[32]);
// its seal handed over (taken in already unless it is from elsewhere's), behind the parents' seals
// handed before it: the parents' stored ids, malloc'd into *ids (kept->parents_length of them). false:
// a parent is not taken in
bool mr_handed(mr_doc *d, const hy_kept *kept, const uint8_t *sealed, size_t length, const uint8_t stored[32],
	uint8_t (**ids)[32]);

// the own takes going out, in the order made, one at a time: the first, or NULL; the item is the
// stack's to send. stop: a stop message for that table (no kept)
typedef struct mr_item {
	mr_doc *d;
	mr_layer layer;
	const hy_kept *kept;
	char *stop;
	struct mr_item *next;
} mr_item;
mr_item *mr_front(mr_mailroom *k);
void mr_pop(mr_mailroom *k);
bool mr_idle(const mr_mailroom *k);

// the check changed: what waited on it is judged again, when the stack next runs mr_rejudge: true when
// it did something
void mr_changed(mr_mailroom *k);
bool mr_rejudge(mr_mailroom *k);
// the ephemeral commits forgotten that nothing holds now, let go of (the end of a run)
void mr_forgotten(mr_mailroom *k);

// what is held back or refused at the document, before its histories (taking, in transport.h). broken:
// the stack's fragments refused whole, by head (codes), or NULL
typedef struct {
	uint8_t commit[32];
	uint8_t (*names)[CM_NAME];
	size_t count;
	// a fragment waiting on the lock (commit: its head): its boundary, stored ids
	bool fragment;
	uint8_t (*boundary)[32];
	size_t boundary_count;
} mr_waiting_row;
// id: a stored id (32 bytes), or an ephemeral commit's name (CM_NAME): id_length
typedef struct {
	uint8_t id[CM_NAME];
	size_t id_length;
	bool fragment, stuck;
	mr_code code;
	// the text a lock refused with (code lock), borrowed from the document; NULL: none
	const char *why;
	uint8_t (*names)[CM_NAME];
	size_t count;
} mr_refused_row;
typedef struct {
	mr_waiting_row *waiting;
	size_t waiting_count;
	mr_refused_row *refused;
	size_t refused_count;
} mr_taking;
// broken: the stack's fragments refused whole (by head, mr_refusal); locked: its loose commits waiting on the
// lock (by head), each a waiting row with no parents named
mr_taking mr_taking_of(mr_doc *d, mr_layer layer, const im_map *broken, const im_map *locked);
void mr_taking_free(mr_taking *taking);

// what a device does, whichever stack carries it (transport.h's tp_ names, one for one)
typedef void (*mr_moved_fn)(void *context, const char *doc);
typedef void (*mr_hearing_fn)(void *context, const char *doc, const uint8_t from[SL_KEY], const uint8_t name[CM_NAME]);
typedef void (*mr_stopped_fn)(void *context, const char *doc, const uint8_t from[SL_KEY], const char *table);
hy_history *mr_history(mr_mailroom *k, const char *id, mr_layer layer);
hy_added mr_take(mr_mailroom *k, const char *id, const uint8_t *bytes, size_t length, mr_layer layer, const hy_made *made);
void mr_arrived(mr_mailroom *k, mr_arrived_fn fn, void *context);
void mr_moved(mr_mailroom *k, mr_moved_fn fn, void *context);
void mr_hearing(mr_mailroom *k, mr_hearing_fn fn, void *context);
void mr_stop(mr_mailroom *k, const char *id, const char *table);
void mr_stopped(mr_mailroom *k, mr_stopped_fn fn, void *context);
bool mr_again(mr_mailroom *k, const char *id, const uint8_t name[CM_NAME]);
bool mr_forget(mr_mailroom *k, const char *id, const uint8_t name[CM_NAME]);
bool mr_snapshot(mr_mailroom *k, const char *id, const uint8_t name[CM_NAME], rp_tables *out);

// room for one more in an array; the codes a map holds, and a set's value
#ifndef ROOM
#define ROOM(array, count, room) \
	do { \
		if ((count) == (room)) { \
			(room) = (room) ? (room) * 2 : 8; \
			(array) = realloc((array), (room) * sizeof *(array)); \
			if ((array) == NULL) abort(); \
		} \
	} while (0)
#endif
#ifndef CODE
#define CODE(c) ((void *)(uintptr_t)(c))
#endif
#ifndef SET
#define SET ((void *)1)
#endif

#endif
