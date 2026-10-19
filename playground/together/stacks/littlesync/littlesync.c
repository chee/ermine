// littlesync (littlesync.h), in C
#include "littlesync.h"

#include "frame.h"

#include "../../../../ermine/encoding/c/cbor.h"
#include "../../../../ermine/encoding/c/commit.h"
#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/pack.h"
#include "../../../../playground/together/c/ed25519/ed25519.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ---- what a device holds

// a commit that makes the value now: its seal, and who has it. Which links have it: a bitset over link
// slots (marks), not a set of names per link. A commit is the one thing that knows it, there is nothing
// to bound or search, and a link's slot is cleared in one pass when it opens or says hello again. A second
// bitset: sent on that link (a want, a write) since its last round (a second, the link's): it waits a round
// then, else it goes again each round till acked; a send on one link does not hold back another.
typedef struct {
	uint8_t name[CM_NAME];
	uint8_t *sealed; // NULL: off (keep: in the store, read again to send)
	size_t length;
	int64_t lamport;
	uint32_t refs; // its writes standing
	uint32_t signer_at; // where its signer's bytes are in sealed (0: not found)
	uint32_t walk;      // the ancestor walk that went through it last
	// its parents, each by PRE bytes of its name: what the device can tell of ancestry (parents of
	// held commits, nothing further)
	uint8_t (*parents)[8];
	uint16_t n_parents;
	bool own;
	bool named;   // a commit taken in names it as a parent: no head
	bool went;    // put on a wire once (or loaded: it may have been)
	bool passing; // no write of it stands: kept only till every link up has it (since: when)
	int64_t since;
	// per link slot a bit: acked (the peer has it), the dev's w bytes; then sent in the slot's round
	uint8_t marks[];
} commit;

// a name in short: 8 bytes of its digest (after the multihash's 2-byte head)
#define PRE 8
static const uint8_t *pre(const uint8_t name[CM_NAME]) { return name + 2; }

// a standing write: one patch of a held commit, at a path (its keys each followed by a 0), that no later
// write has replaced. value: NULL when gone (a delete stands as gone) or far (past LS_ITEMS at its path:
// read again from the seal when it comes up). replaces: what its patch names, PRE bytes each
// (has_replaces 0: absent, an older commit's: ancestry, as far as the device can tell)
// more: names it took over from the writes it replaced (theirs and what they replaced, the latest
// INHERIT), so a write that comes late is known replaced though the one that named it is gone: the
// chain of replaces as far as this device saw it, the same on every device that saw the same commits
#define INHERIT 16
typedef struct {
	char *path;
	size_t bytes, depth;
	commit *by;
	op_value *value;
	uint8_t (*replaces)[PRE];
	uint8_t (*more)[PRE];
	uint16_t patch, n_replaces;
	uint8_t n_more;
	bool gone, far, has_replaces;
} write;

#define HELDS 8
// topics a peer may say it wants: past this, all
#define WANTS 128
#define RING 8
// commits passing (no write stands) per node at most, and how long one waits for the links
#define PASSING 16
#define PASS_MS 30000
#define NAMED 8
#define OUT_MAX 16384
// a node holding more commits than this finds them by an index (open addressing on 8 bytes of the name)
#define INDEX 32
// keep is ls_options.keep where it is compiled in
#define KEEPS(d) (LS_SERVER && (d)->o.keep)
// names in one blob of a keeping node's list
#define KEPT 256
#define CHUNK 3000
#define DEPTH 16

struct ls_node {
	ls_dev *dev;
	char id[LS_ID_LEN + 1];
	uint8_t doc[32];
	op_value *value; // the first item at each path, composed
	// sorted: by depth, then path, then the agreed order (higher lamport first, then the greater name)
	write *writes;
	size_t n_writes, c_writes;
	commit **commits;
	size_t n_commits, c_commits;
	commit **index; // NULL: none (INDEX commits or fewer). c_index slots, a power of 2
	size_t c_index;
	// keep: the commits off, in the order they went (their names in "kept:<id>:<k>"), saved up to n_kept_saved
	commit **kept;
	size_t n_kept, c_kept, n_kept_saved;
	uint8_t ring[RING][CM_NAME]; // names seen and let go of
	unsigned ring_at, ring_n;
	// parents named by commits taken in that were not held then (the first 8 bytes): one that comes
	// later is no head
	uint8_t named[NAMED][8];
	unsigned named_at, named_n;
	int64_t lamport;
	ls_held helds[HELDS];
	uint8_t *hold; // the unsealed commit being beaten
	size_t hold_length;
	int64_t hold_sent;
	bool hold_dirty;
	uint32_t version;
	// commits taken in from a link since the last tick: heads to the others then (once, however many came).
	// news_from: the link they came on, -1: several
	bool news;
	int news_from;
	bool dirty;
	int64_t saved;
};

// a topic this device hears: told to options.heard (listen), its presence rows kept (room: a followed
// node's id, or ls_presence_on), or both. rows: n_rows of them, in no order. row: my presence row,
// presence.ts's message, sealed (put_said), framed once and sent as it is (row_length: its message's bytes)
typedef struct {
	char *name;
	bool listen, room;
	ls_row *rows;
	size_t n_rows, c_rows;
	ls_framed *row;
	size_t row_length;
	int64_t row_sent;
	bool row_dirty;
} topic;

// one byte stream to one peer: what is said on it, and what is known of the peer on it
struct ls_link {
	ls_dev *dev;
	unsigned slot;
	// the frames to send (shared: a holder each), out_n from out_at; queued their bytes. given: the one
	// ls_next handed out last, held till the next
	ls_framed **out, *given;
	size_t out_at, out_n, out_cap, queued;
	size_t rx_n;
	bool rx_over;
	bool up, beat, due;
	int64_t heard, hello_sent, heads_sent, round;
	uint8_t peer[LS_KEY_LEN];
	bool has_peer;
	ls_traffic traffic;
	// the topics its peer wants sent to it (its last listen), or all. announce: it began again, so my
	// rows go to it at its next listen. told: the listen last sent to it (a sum of hashes; 0: none since)
	char **wants;
	size_t n_wants;
	bool wants_all, announce;
	uint32_t told;
	// the frame being read: the dev's frame bytes at most
	uint8_t rx[];
};

struct ls_dev {
	ls_options o;
	uint8_t seed[32];
	uint8_t key[LS_KEY_LEN];
	int64_t now;
	uint32_t nonce;
	ls_node **nodes;
	size_t n_nodes;
	struct ls_link **links;
	size_t n_links, w; // w: bytes of a bitset over the link slots
	uint8_t *up;       // the slots up, as bits (links_up)
	uint32_t walks;
	// public keys decoded once
	ermEd25519Key keys[4];
	unsigned keys_next;
	ls_stats stats;
	const char *reason;
	// the topics heard (listened to, rooms); wants_changed: the links are told at the next tick
	topic **topics;
	size_t n_topics;
	bool wants_changed;
	size_t frame; // a link's rx bytes: a frame of the largest message
};

static void say(ls_dev *d, const char *format, ...) __attribute__((format(printf, 2, 3)));
static void say(ls_dev *d, const char *format, ...) {
	if (d->o.log == NULL) return;
	char line[200];
	va_list args;
	va_start(args, format);
	vsnprintf(line, sizeof line, format, args);
	va_end(args);
	d->o.log(d->o.log_context, line);
}

static const char *short_id(const ls_node *n) { return n->id + 9; }

// ---- ids, seals

static int digit(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; }
// ermine://<64 hex>: the document's 32 bytes are the 64 hex
static bool id_doc(const char *id, uint8_t doc[32]) {
	if (strncmp(id, "ermine://", 9) != 0 || strlen(id) != LS_ID_LEN) return false;
	for (int i = 0; i < 32; i++) {
		int a = digit(id[9 + 2 * i]), b = digit(id[10 + 2 * i]);
		if (a < 0 || b < 0) return false;
		doc[i] = (uint8_t)(a << 4 | b);
	}
	return true;
}

// the varsig header of Ed25519 (seal.c's): a seal here is exactly header and 64 bytes
static const uint8_t HEADER[8] = {0x34, 0x01, 0xed, 0x01, 0xed, 0x01, 0x13, 0x5f};
// what is signed (seal.h's): "ermine/v0/commit", the document, the signature's header, the commit's name
#define SIGNED 90
static void signed_message(const uint8_t doc[32], const uint8_t name[CM_NAME], uint8_t m[SIGNED]) {
	memcpy(m, "ermine/v0/commit", 16);
	memcpy(m + 16, doc, 32);
	memcpy(m + 48, HEADER, 8);
	memcpy(m + 56, name, CM_NAME);
}

// writing CBOR (cbor.h's writer): a buffer that grows from about `size` bytes; a key of a map
static CborOut out_of(size_t size) { return (CborOut){allocate(size), size, 0, true}; }
static void key(CborOut *o, const char *k) { cborPutText(o, k, strlen(k)); }

// the sealed commit (seal.h's bytes), malloc'd
static uint8_t *seal(ls_dev *d, const uint8_t *commit_bytes, size_t length, const uint8_t doc[32], size_t *out) {
	uint8_t name[CM_NAME], m[SIGNED], signature[72];
	cm_name(commit_bytes, length, name);
	signed_message(doc, name, m);
	memcpy(signature, HEADER, 8);
	ermEd25519Sign(d->seed, m, SIGNED, signature + 8);
	CborOut o = out_of(length + 96);
	cborPutHead(&o, 5, 2);
	key(&o, "commit"), cborPutBytes(&o, commit_bytes, length);
	key(&o, "signature"), cborPutBytes(&o, signature, 72);
	*out = o.length;
	return o.data;
}

typedef struct {
	cm_commit c;
	uint8_t name[CM_NAME];
} opened;

static bool is_name(const Json *b) { return b != NULL && b->type == JSON_BYTES && b->bytes.length == CM_NAME; }

// a seal's commit name and nothing else (no check)
static bool peek_name(const uint8_t *sealed, size_t length, uint8_t name[CM_NAME]) {
	Json *x = cborDecode(sealed, length, NULL, NULL);
	const Json *c = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "commit") : NULL;
	bool ok = c != NULL && c->type == JSON_BYTES;
	if (ok) cm_name(c->bytes.data, c->bytes.length, name);
	jsonFree(x);
	return ok;
}

// an Ed25519 key (its 32 bytes) ready to verify with, kept among the last four; NULL: not a key
static const ermEd25519Key *key_of(ls_dev *d, const uint8_t pub[32]) {
	for (unsigned i = 0; i < 4; i++)
		if (d->keys[i].good && memcmp(d->keys[i].pub, pub, 32) == 0) return &d->keys[i];
	ermEd25519Key *k = &d->keys[d->keys_next++ % 4];
	return ermEd25519KeyOf(k, pub) ? k : NULL;
}

// the seal's commit, and with verify its signature for the document. 0: bad shape, 1: bad signature, 2: good
static int open_seal(ls_dev *d, const uint8_t *sealed, size_t length, const uint8_t doc[32], bool verify, opened *o) {
	memset(o, 0, sizeof *o);
	Json *x = cborDecode(sealed, length, NULL, NULL);
	if (x == NULL || x->type != JSON_OBJECT || x->object.count != 2) return jsonFree(x), 0;
	const Json *c = jsonGet(x, "commit"), *s = jsonGet(x, "signature");
	if (c == NULL || c->type != JSON_BYTES || s == NULL || s->type != JSON_BYTES) return jsonFree(x), 0;
	if (cm_decode(c->bytes.data, c->bytes.length, &o->c, NULL) != CM_OK) return jsonFree(x), 0;
	cm_name(c->bytes.data, c->bytes.length, o->name);
	int result = 2;
	if (verify) {
		const uint8_t *key = o->c.signer;
		if (s->bytes.length != 72 || memcmp(s->bytes.data, HEADER, 8) != 0 || o->c.signer_length != LS_KEY_LEN ||
			key[0] != 0xed || key[1] != 0x01) result = 1;
		else {
			const ermEd25519Key *k = key_of(d, key + 2);
			uint8_t m[SIGNED];
			signed_message(doc, o->name, m);
			if (k == NULL || !ermEd25519VerifyKey(k, m, SIGNED, s->bytes.data + 8)) result = 1;
		}
	}
	jsonFree(x);
	if (result != 2) cm_free(&o->c);
	return result;
}

// a sealed message (seal.ts's sealMessage): {bytes, signer, signature}. What is signed:
// "ermine/v0/message", the BLAKE3 of the bytes, the signature's header, then the topic (the rest)
#define SAID_MAX (17 + 32 + 8 + LS_TOPIC_MAX)
static size_t said(const char *topic, const uint8_t *bytes, size_t length, uint8_t m[SAID_MAX]) {
	size_t t = strlen(topic);
	memcpy(m, "ermine/v0/message", 17);
	cm_digest(bytes, length, m + 17);
	memcpy(m + 49, HEADER, 8);
	memcpy(m + 57, topic, t);
	return 57 + t;
}

// the bytes on the topic (a topic_ok one), sealed by this device, written into o as one CBOR byte string:
// the sealed map's length (counted: nothing written), then the map
static void put_said(ls_dev *d, CborOut *o, const char *topic, const uint8_t *bytes, size_t length) {
	uint8_t m[SAID_MAX], signature[72];
	size_t n = said(topic, bytes, length, m);
	memcpy(signature, HEADER, 8);
	ermEd25519Sign(d->seed, m, n, signature + 8);
	CborOut count = {NULL, 0, 0, false};
	for (CborOut *w = &count;; w = o) {
		cborPutHead(w, 5, 3);
		key(w, "bytes"), cborPutBytes(w, bytes, length);
		key(w, "signer"), cborPutBytes(w, d->key, LS_KEY_LEN);
		key(w, "signature"), cborPutBytes(w, signature, 72);
		if (w == o) break;
		cborPutHead(o, 2, count.length);
	}
}

// a sealed message opened for the topic (a topic_ok one): its signer (an Ed25519 multikey) and bytes,
// both in *x (jsonFree it, whatever the answer). false: not a sealed message, or its seal not good
static bool open_said(ls_dev *d, const uint8_t *sealed, size_t length, const char *topic, Json **x, const Json **signer,
	const Json **bytes) {
	*x = cborDecode(sealed, length, NULL, NULL);
	if (*x == NULL || (*x)->type != JSON_OBJECT || (*x)->object.count != 3) return false;
	const Json *b = jsonGet(*x, "bytes"), *k = jsonGet(*x, "signer"), *s = jsonGet(*x, "signature");
	if (b == NULL || b->type != JSON_BYTES || k == NULL || k->type != JSON_BYTES || k->bytes.length != LS_KEY_LEN ||
		k->bytes.data[0] != 0xed || k->bytes.data[1] != 0x01 || s == NULL || s->type != JSON_BYTES ||
		s->bytes.length != 72 || memcmp(s->bytes.data, HEADER, 8) != 0)
		return false;
	const ermEd25519Key *e = key_of(d, k->bytes.data + 2);
	uint8_t m[SAID_MAX];
	size_t n = said(topic, b->bytes.data, b->bytes.length, m);
	if (e == NULL || !ermEd25519VerifyKey(e, m, n, s->bytes.data + 8)) return false;
	*signer = k, *bytes = b;
	return true;
}

// ---- the wire out

// room on the link for a message of n bytes: the out queue is not full (an empty one takes any message)
static bool room_for(struct ls_link *l, size_t n) {
	bool room = l->queued == 0 || l->queued + n * 2 + 16 <= (l->dev->o.max_out ? l->dev->o.max_out : OUT_MAX);
	if (!room) l->traffic.dropped_out++;
	return room;
}

// a frame queued on the link: one more holder of it
static void queue(struct ls_link *l, ls_framed *f) {
	if (l->out_at + l->out_n == l->out_cap) {
		if (l->out_at) memmove(l->out, l->out + l->out_at, l->out_n * sizeof *l->out), l->out_at = 0;
		else if ((l->out = realloc(l->out, (l->out_cap = l->out_cap ? l->out_cap * 2 : 8) * sizeof *l->out)) == NULL) abort();
	}
	l->out[l->out_at + l->out_n++] = f;
	f->refs++;
	l->queued += f->length;
	l->traffic.frames_out++;
}

// the message written (message, then its pairs) sent, and let go of. false: dropped
static bool send_message(struct ls_link *l, CborOut *m) {
	bool room = room_for(l, m->length);
	if (room) {
		ls_framed *f = ls_framed_of(m->data, m->length);
		queue(l, f);
		ls_framed_drop(f);
	}
	free(m->data);
	return room;
}

// a commit's marks: the peer on slot s has it (acked), it went on slot s in the slot's round (sent)
static bool acked(const commit *c, unsigned s) { return c->marks[s >> 3] >> (s & 7) & 1; }
static void ack(commit *c, unsigned s) { c->marks[s >> 3] |= (uint8_t)(1u << (s & 7)); }
static bool sent(const ls_dev *d, const commit *c, unsigned s) { return c->marks[d->w + (s >> 3)] >> (s & 7) & 1; }
static void mark_sent(const ls_dev *d, commit *c, unsigned s, bool on) {
	uint8_t *b = &c->marks[d->w + (s >> 3)], bit = (uint8_t)(1u << (s & 7));
	*b = on ? *b | bit : *b & (uint8_t)~bit;
}

// the links that are up, but not `except` (NULL: all): what is sent to every peer but the one it came from
static bool others_up(const ls_dev *d, const struct ls_link *except) {
	for (unsigned i = 0; i < d->n_links; i++)
		if (d->links[i] != NULL && d->links[i] != except && d->links[i]->up) return true;
	return false;
}

// a message: a map of t and `pairs` more, each key then its value, the keys in canonical order (cbor.h:
// the shorter first, then byte by byte; "t" first). size: about how many bytes it will be
static CborOut message(const char *t, size_t pairs, size_t size) {
	CborOut m = out_of(size);
	cborPutHead(&m, 5, pairs + 1);
	key(&m, "t"), key(&m, t);
	return m;
}

static void send_hello(struct ls_link *l, bool re) {
	ls_dev *d = l->dev;
	CborOut m = message("hello", 2 + re, 64);
	if (re) key(&m, "re"), cborPutBoolean(&m, true);
	key(&m, "key"), cborPutBytes(&m, d->key, LS_KEY_LEN);
	key(&m, "stack"), key(&m, LS_STACK);
	l->hello_sent = d->now;
	say(d, "tx hello%s", re ? " re" : "");
	send_message(l, &m);
}

static void send_heads(ls_node *n, struct ls_link *l, bool re) {
	ls_dev *d = n->dev;
	// the commits making the node (not the passing ones: those are sent to the links that lack them);
	// the highest lamports, when there are too many
	size_t held = 0;
	int64_t *lam = allocate((n->n_commits + 1) * sizeof *l);
	for (size_t i = 0; i < n->n_commits; i++)
		if (!n->commits[i]->passing) lam[held++] = n->commits[i]->lamport;
	size_t count = held < LS_MAX_HEADS ? held : LS_MAX_HEADS;
	int64_t floor_ = 0;
	if (held > LS_MAX_HEADS) {
		for (size_t i = 1; i < held; i++) {
			int64_t v = lam[i];
			size_t k = i;
			for (; k > 0 && lam[k - 1] < v; k--) lam[k] = lam[k - 1];
			lam[k] = v;
		}
		floor_ = lam[LS_MAX_HEADS - 1];
	}
	free(lam);
	size_t put = 0;
	for (size_t i = 0; i < n->n_commits && put < count; i++) put += !n->commits[i]->passing && n->commits[i]->lamport >= floor_;
	CborOut m = message("heads", 2 + re, 64 + put * (CM_NAME + 2));
	if (re) key(&m, "re"), cborPutBoolean(&m, true);
	key(&m, "node"), cborPutBytes(&m, n->doc, 32);
	key(&m, "heads"), cborPutHead(&m, 4, put);
	for (size_t i = 0, k = 0; i < n->n_commits && k < put; i++)
		if (!n->commits[i]->passing && n->commits[i]->lamport >= floor_) cborPutBytes(&m, n->commits[i]->name, CM_NAME), k++;
	say(d, "tx heads %.8s %zu%s", short_id(n), put, re ? " re" : "");
	send_message(l, &m);
}

static void send_names(ls_node *n, struct ls_link *l, const char *t, const uint8_t (*names)[CM_NAME], size_t count) {
	for (size_t at = 0; at < count; at += LS_MAX_HEADS) {
		size_t k = count - at < LS_MAX_HEADS ? count - at : (size_t)LS_MAX_HEADS;
		CborOut m = message(t, 2, 64 + k * (CM_NAME + 2));
		key(&m, "node"), cborPutBytes(&m, n->doc, 32);
		key(&m, "names"), cborPutHead(&m, 4, k);
		for (size_t i = at; i < at + k; i++) cborPutBytes(&m, names[i], CM_NAME);
		say(n->dev, "tx %s %.8s %zu", t, short_id(n), k);
		send_message(l, &m);
	}
}

static uint8_t *seal_of(ls_node *n, const commit *c);
static int lower(const void *a, const void *b) {
	const commit *x = *(commit *const *)a, *y = *(commit *const *)b;
	return x->lamport != y->lamport ? (x->lamport < y->lamport ? -1 : 1) : memcmp(x->name, y->name, CM_NAME);
}
// the seals of the commits, in messages of about CHUNK bytes; the lower lamports first (a commit's
// ancestors before it, so what it replaces is there to replace). Marked sent on the link if not dropped
static void send_commits(ls_node *n, struct ls_link *l, commit *const *given, size_t count) {
	ls_dev *d = n->dev;
	commit **list = allocate((count + 1) * sizeof *list);
	memcpy(list, given, count * sizeof *list);
	if (count > 1) qsort(list, count, sizeof *list, lower);
	// a message's seals, and whose each is (one read from the store is let go of once written)
	uint8_t **seals = allocate((count + 1) * sizeof *seals);
	commit **of = allocate((count + 1) * sizeof *of);
	size_t at = 0;
	while (at < count) {
		size_t size = 0, k = 0, from = at;
		while (at < count && (k == 0 || size + list[at]->length <= CHUNK)) {
			uint8_t *b = seal_of(n, list[at]);
			if (b != NULL) seals[k] = b, of[k++] = list[at];
			size += list[at]->length + 4;
			at++;
		}
		CborOut m = message("commits", 2, size + 64);
		key(&m, "node"), cborPutBytes(&m, n->doc, 32);
		key(&m, "sealed"), cborPutHead(&m, 4, k);
		for (size_t i = 0; i < k; i++) {
			cborPutBytes(&m, seals[i], of[i]->length);
			if (seals[i] != of[i]->sealed) free(seals[i]);
		}
		say(d, "tx commits %.8s %zu", short_id(n), k);
		if (send_message(l, &m))
			for (size_t i = from; i < at; i++) mark_sent(d, list[i], l->slot, true), list[i]->went = true;
	}
	free(seals), free(of);
	free(list);
}

// ---- values

// a copy nobody else holds; NULL when it is deeper than DEPTH
static op_value *copy(const op_value *v, int depth) {
	if (v == NULL) return NULL;
	if (depth > DEPTH && (v->type == OP_MAP || v->type == OP_LIST || v->type == OP_STAND)) return NULL;
	switch (v->type) {
	case OP_NULL: return op_null();
	case OP_BOOL: return op_bool(v->bool_);
	case OP_NUM: return v->big ? op_whole(v->bigNegative, v->big, v->bigLength) : op_num(v->num);
	case OP_STR: return op_str_n(v->str, v->bytes);
	case OP_BYTES: return op_bytes(v->data, v->bytes);
	case OP_TYPED: return op_typed(v->kind, v->data, op_length(v));
	case OP_LIST:
	case OP_MAP:
	case OP_STAND: {
		op_value *c = v->type == OP_LIST ? op_list() : v->type == OP_MAP ? op_map() : NULL;
		if (v->type == OP_STAND) {
			op_value *k = copy(v->items[0], depth + 1);
			return k == NULL ? NULL : op_stand(k);
		}
		for (size_t i = 0; i < v->count; i++) {
			op_value *item = copy(v->items[i], depth + 1);
			if (item == NULL) return op_free(c), NULL;
			if (v->type == OP_LIST) op_push(c, item);
			else op_set(c, v->keys[i], item);
		}
		return c;
	}
	}
	return NULL;
}

// whether copy makes one
static bool carried(const op_value *v, int depth) {
	if (v == NULL) return false;
	if (v->type != OP_MAP && v->type != OP_LIST && v->type != OP_STAND) return true;
	if (depth > DEPTH || (v->type == OP_STAND && v->count == 0)) return false;
	for (size_t i = 0; i < v->count; i++)
		if (!carried(v->items[i], depth + 1)) return false;
	return true;
}

// the value at keys (each ending in 0) inside v, through maps; NULL when there is none
static const op_value *dig(const op_value *v, const char *keys, size_t depth) {
	for (size_t i = 0; i < depth && v != NULL; i++) {
		v = v->type == OP_MAP ? op_get(v, keys) : NULL;
		keys += strlen(keys) + 1;
	}
	return v;
}
// v (taken) put at a path of *root, gone: taken out there. Missing parents made as maps (sync only:
// core's apply stays strict); under a value that is not a map, left out (lists.ts's put)
static void place(op_value **root, const char *path, size_t depth, op_value *v, bool gone) {
	if (depth == 0) {
		op_free(*root);
		*root = gone ? NULL : v;
		return;
	}
	if (*root == NULL) {
		if (gone) return;
		*root = op_map();
	}
	op_value *at = *root;
	if (at->type != OP_MAP) {
		op_free(v);
		return;
	}
	for (size_t i = 0; i + 1 < depth; i++) {
		op_value *next = op_get(at, path);
		if (next == NULL) {
			if (gone) return;
			next = op_map();
			op_set(at, path, next);
		}
		if (next->type != OP_MAP) {
			op_free(v);
			return;
		}
		at = next;
		path += strlen(path) + 1;
	}
	if (!gone) {
		op_set(at, path, v);
		return;
	}
	long k = op_find(at, path);
	if (k < 0) return;
	op_free(at->items[k]);
	op_unset(at, (size_t)k);
}

// ---- writes and commits

// the agreed order of two commits (the same on every device): by lamport, then by name. Positive: a is
// later (shown first)
static int later(int64_t la, const uint8_t *na, int64_t lb, const uint8_t *nb) {
	if (la != lb) return la < lb ? -1 : 1;
	return memcmp(na, nb, CM_NAME);
}

static void ring_add(ls_node *n, const uint8_t name[CM_NAME]) {
	memcpy(n->ring[n->ring_at], name, CM_NAME);
	n->ring_at = (n->ring_at + 1) % RING;
	if (n->ring_n < RING) n->ring_n++;
}

// the index: a commit's slot by PRE bytes of its name (they are a digest's: spread already)
static size_t slot_of(const ls_node *n, const uint8_t *p) {
	uint64_t h;
	memcpy(&h, p, sizeof h);
	return (size_t)h & (n->c_index - 1);
}
static void index_put(ls_node *n, commit *c) {
	size_t i = slot_of(n, pre(c->name));
	while (n->index[i] != NULL) i = (i + 1) & (n->c_index - 1);
	n->index[i] = c;
}
// made again at 4 times the commits, when there are more than INDEX of them and it is half full
static void index_grow(ls_node *n) {
	if (n->n_commits <= INDEX || (n->index != NULL && n->n_commits * 2 < n->c_index)) return;
	free(n->index);
	for (n->c_index = 64; n->c_index < n->n_commits * 4; n->c_index *= 2) {}
	n->index = calloc(n->c_index, sizeof *n->index);
	if (n->index == NULL) abort();
	for (size_t i = 0; i < n->n_commits; i++) index_put(n, n->commits[i]);
}
// out of the index: the ones after it in its run are put again
static void index_drop(ls_node *n, const commit *c) {
	if (n->index == NULL) return;
	size_t i = slot_of(n, pre(c->name)), mask = n->c_index - 1;
	while (n->index[i] != NULL && n->index[i] != c) i = (i + 1) & mask;
	if (n->index[i] == NULL) return;
	n->index[i] = NULL;
	for (i = (i + 1) & mask; n->index[i] != NULL; i = (i + 1) & mask) {
		commit *x = n->index[i];
		n->index[i] = NULL;
		index_put(n, x);
	}
}
static void commit_add(ls_node *n, commit *k) {
	if (n->n_commits == n->c_commits) {
		n->c_commits = n->c_commits ? n->c_commits * 2 : 4;
		n->commits = realloc(n->commits, n->c_commits * sizeof *n->commits);
		if (n->commits == NULL) abort();
	}
	n->commits[n->n_commits++] = k;
	if (!LS_SERVER) return;
	if (n->index != NULL && n->n_commits * 2 < n->c_index) index_put(n, k);
	else index_grow(n);
}
// out of the list (the last takes its place) and the index; not freed
static void commit_remove(ls_node *n, size_t i) {
	if (LS_SERVER) index_drop(n, n->commits[i]);
	n->commits[i] = n->commits[--n->n_commits];
}

// by PRE bytes (whole: CM_NAME bytes of the name), the held commit, or NULL
static commit *held_at(const ls_node *n, const uint8_t *p, bool whole) {
	const uint8_t *q = whole ? pre(p) : p;
	if (LS_SERVER && n->index != NULL) {
		for (size_t i = slot_of(n, q); n->index[i] != NULL; i = (i + 1) & (n->c_index - 1))
			if (whole ? memcmp(n->index[i]->name, p, CM_NAME) == 0 : memcmp(pre(n->index[i]->name), p, PRE) == 0) return n->index[i];
		return NULL;
	}
	for (size_t i = 0; i < n->n_commits; i++)
		if (whole ? memcmp(n->commits[i]->name, p, CM_NAME) == 0 : memcmp(pre(n->commits[i]->name), p, PRE) == 0) return n->commits[i];
	return NULL;
}
static commit *commit_find(const ls_node *n, const uint8_t name[CM_NAME]) { return held_at(n, name, true); }
static bool seen(const ls_node *n, const uint8_t name[CM_NAME]) {
	if (commit_find(n, name) != NULL) return true;
	for (unsigned i = 0; i < n->ring_n; i++)
		if (memcmp(n->ring[i], name, CM_NAME) == 0) return true;
	return false;
}

static void commit_free(commit *c) {
	free(c->sealed);
	free(c->parents);
	free(c);
}
static void commit_drop(ls_node *n, size_t i) {
	commit *c = n->commits[i];
	commit_remove(n, i);
	ring_add(n, c->name);
	commit_free(c);
}
// the link slots that are up, as bits (d->up)
static void links_up(ls_dev *d) {
	memset(d->up, 0, d->w);
	for (unsigned i = 0; i < d->n_links; i++)
		if (d->links[i] != NULL && d->links[i]->up) d->up[i >> 3] |= (uint8_t)(1u << (i & 7));
}
static bool all_up_have(const ls_dev *d, const commit *c) {
	for (size_t i = 0; i < d->w; i++)
		if ((c->marks[i] & d->up[i]) != d->up[i]) return false;
	return true;
}

static void seal_name(const ls_node *n, const uint8_t name[CM_NAME], char *out) {
	int k = snprintf(out, 16 + LS_ID_LEN, "seal:%s:", short_id(n));
	for (int i = 0; i < CM_NAME; i++) snprintf(out + k + 2 * i, 3, "%02x", name[i]);
}
#define SEAL_NAME (16 + LS_ID_LEN + 2 * CM_NAME)
// a commit's seal: held, or (off) read from the store, malloc'd (free it when it is not c->sealed). NULL:
// not there
static uint8_t *seal_of(ls_node *n, const commit *c) {
	if (!LS_SERVER || c->sealed != NULL) return c->sealed;
	char name[SEAL_NAME];
	seal_name(n, c->name, name);
	uint8_t *b;
	size_t len;
	if (!n->dev->o.store.load(n->dev->o.store.context, name, &b, &len)) return NULL;
	if (len == c->length) return b;
	free(b);
	return NULL;
}
static void kept_add(ls_node *n, commit *c) {
	if (n->n_kept == n->c_kept) {
		n->c_kept = n->c_kept ? n->c_kept * 2 : 16;
		n->kept = realloc(n->kept, n->c_kept * sizeof *n->kept);
		if (n->kept == NULL) abort();
	}
	n->kept[n->n_kept++] = c;
}
// keep: a passing commit's seal to the store and out of memory, its name to the node's list
static void go_off(ls_node *n, commit *c) {
	ls_dev *d = n->dev;
	char name[SEAL_NAME];
	seal_name(n, c->name, name);
	if (!d->o.store.save(d->o.store.context, name, c->sealed, c->length)) return;
	free(c->sealed);
	c->sealed = NULL;
	kept_add(n, c);
	n->dirty = true;
}
// passing commits let go of: each every link up has, or that waited PASS_MS; past PASSING, the oldest.
// keep: none (each went off as it began passing)
static void pass(ls_node *n) {
	if (KEEPS(n->dev)) return;
	links_up(n->dev);
	size_t count = 0;
	for (size_t i = n->n_commits; i-- > 0;) {
		commit *c = n->commits[i];
		if (!c->passing) continue;
		if (all_up_have(n->dev, c) || n->dev->now - c->since >= PASS_MS) commit_drop(n, i);
		else count++;
	}
	for (; count > PASSING; count--) {
		size_t old = SIZE_MAX;
		for (size_t i = 0; i < n->n_commits; i++)
			if (n->commits[i]->passing && (old == SIZE_MAX || n->commits[i]->since < n->commits[old]->since)) old = i;
		commit_drop(n, old);
	}
}
// a write let go of: when none of its commit's stands, the commit passes (kept till every link that is
// up has it, so the writes between reach each peer: else a peer could show a write this one replaced)
static void unref(ls_node *n, commit *c) {
	if (--c->refs != 0) return;
	c->passing = true;
	c->since = n->dev->now;
	if (KEEPS(n->dev)) go_off(n, c);
	else pass(n);
}
static void write_free(write *w) {
	op_free(w->value);
	free(w->path);
	free(w->more);
}
// a name w took over, once; past INHERIT the oldest goes
static void take_name(write *w, const uint8_t p[PRE]) {
	for (size_t i = 0; i < w->n_replaces; i++)
		if (memcmp(w->replaces[i], p, PRE) == 0) return;
	for (size_t i = 0; i < w->n_more; i++)
		if (memcmp(w->more[i], p, PRE) == 0) return;
	// room grows 4, 8, 16
	size_t room = w->n_more < 4 ? 4 : w->n_more < 8 ? 8 : INHERIT;
	if (w->n_more == 0 || w->n_more == 4 || w->n_more == 8) {
		w->more = realloc(w->more, room * PRE);
		if (w->more == NULL) abort();
	}
	if (w->n_more == INHERIT) memmove(w->more, w->more + 1, (INHERIT - 1) * PRE), w->n_more--;
	memcpy(w->more[w->n_more++], p, PRE);
}
// w replaced s: what s named, and s, are w's to know
static void inherit(write *w, const write *s) {
	for (size_t i = 0; i < s->n_replaces; i++) take_name(w, s->replaces[i]);
	for (size_t i = 0; i < s->n_more; i++) take_name(w, s->more[i]);
	if (w->by != s->by) take_name(w, pre(s->by->name));
}

// whether a (its name, its lamport) is an ancestor of a commit with these parents, as far as the held
// commits' parents tell: a walk down through held commits only (one not held ends it: unsure, so no)
static bool ancestor(const ls_node *n, const uint8_t a[CM_NAME], int64_t lamport, const uint8_t (*parents)[PRE], size_t count) {
	for (size_t i = 0; i < count; i++)
		if (memcmp(parents[i], pre(a), PRE) == 0) return true;
	if (n->n_commits == 0) return false;
	// been: marked with this walk's number
	uint32_t walk = ++n->dev->walks;
	bool found = false;
	commit **todo = malloc(n->n_commits * sizeof *todo), *k;
	size_t m = 0;
	if (todo == NULL) abort();
	for (size_t i = 0; i < count; i++)
		if ((k = held_at(n, parents[i], false)) != NULL && k->walk != walk && k->lamport > lamport) k->walk = walk, todo[m++] = k;
	while (m > 0 && !found) {
		const commit *c = todo[--m];
		for (size_t i = 0; i < c->n_parents && !found; i++) {
			if (memcmp(c->parents[i], pre(a), PRE) == 0) found = true;
			if ((k = held_at(n, c->parents[i], false)) != NULL && k->walk != walk && k->lamport > lamport) k->walk = walk, todo[m++] = k;
		}
	}
	free(todo);
	return found;
}

// whether w replaces s (an earlier write at or under w's path, the caller's to check): s's commit named
// in w's replaces, or in what w took over from the writes it replaced; replaces absent (an older
// commit's), a parent of w's commit, or an ancestor as far as the held commits tell. Names are trusted (a
// device without history cannot clamp them to ancestors), but never a commit as late as w's. When
// unsure: no, both stay (never hidden)
static bool covers(const ls_node *n, const write *w, const write *s) {
	const commit *c = w->by, *d = s->by;
	if (c == d || d->lamport >= c->lamport) return false;
	for (size_t i = 0; i < w->n_replaces; i++)
		if (memcmp(w->replaces[i], pre(d->name), PRE) == 0) return true;
	for (size_t i = 0; i < w->n_more; i++)
		if (memcmp(w->more[i], pre(d->name), PRE) == 0) return true;
	return !w->has_replaces && ancestor(n, d->name, d->lamport, (const uint8_t(*)[PRE])c->parents, c->n_parents);
}
// whether c's write owns d's: the same commit, or d's an edit made after c (c an ancestor of d's commit)
static bool owns(const ls_node *n, const write *c, const write *d) {
	return c->by == d->by || ancestor(n, c->by->name, c->by->lamport, (const uint8_t(*)[PRE])d->by->parents, d->by->n_parents);
}

// a's path at or above b's
static bool above(const write *a, const write *b) { return a->bytes <= b->bytes && memcmp(a->path, b->path, a->bytes) == 0; }
static bool same_path(const write *a, const write *b) { return a->bytes == b->bytes && memcmp(a->path, b->path, a->bytes) == 0; }
// the writes' order: shallow first, then by path, then the agreed order (later first)
static int write_cmp(const write *a, const write *b) {
	if (a->depth != b->depth) return a->depth < b->depth ? -1 : 1;
	size_t m = a->bytes < b->bytes ? a->bytes : b->bytes;
	int k = memcmp(a->path, b->path, m);
	if (k != 0 || a->bytes != b->bytes) return k != 0 ? k : a->bytes < b->bytes ? -1 : 1;
	return -later(a->by->lamport, a->by->name, b->by->lamport, b->by->name);
}

// a far write's value, read again from its commit's seal
static void reread(ls_node *n, write *w) {
	opened o;
	if (open_seal(n->dev, w->by->sealed, w->by->length, n->doc, false, &o) != 2) return;
	if (w->patch < o.c.patches_length && o.c.patches[w->patch].has_value) {
		w->value = copy(o.c.patches[w->patch].value, 0);
		w->far = w->value == NULL;
	}
	cm_free(&o.c);
}

// after writes came or went: sorted; at each path the first LS_ITEMS hold their values, the rest are
// far; the value composed again, shallow to deep, of the first item at each path. A value is shared
// with the composed one when no write is under it, else copied (what is under goes into the copy)
static void settle(ls_node *n) {
	for (size_t i = 1; i < n->n_writes; i++) {
		write w = n->writes[i];
		size_t k = i;
		for (; k > 0 && write_cmp(&n->writes[k - 1], &w) > 0; k--) n->writes[k] = n->writes[k - 1];
		n->writes[k] = w;
	}
	size_t at = 0;
	for (size_t i = 0; i < n->n_writes; i++) {
		write *w = &n->writes[i];
		at = i > 0 && same_path(&n->writes[i - 1], w) ? at + 1 : 0;
		if (w->gone) continue;
		if (at < LS_ITEMS && w->far) reread(n, w);
		else if (at >= LS_ITEMS && !w->far) {
			op_free(w->value);
			w->value = NULL;
			w->far = true;
		}
	}
	op_value *root = NULL;
	for (size_t i = 0; i < n->n_writes; i++) {
		write *w = &n->writes[i];
		if ((i > 0 && same_path(&n->writes[i - 1], w)) || (w->far && !w->gone)) continue;
		bool under = false;
		for (size_t j = i + 1; j < n->n_writes && !under; j++) under = n->writes[j].depth > w->depth && above(w, &n->writes[j]);
		op_value *v = w->gone ? NULL : under ? copy(w->value, 0) : op_ref(w->value);
		place(&root, w->path, w->depth, v, w->gone);
	}
	op_free(n->value);
	n->value = root;
	n->version++;
	n->dirty = true;
}

static bool shallow(const op_value *v, int depth) {
	if (v == NULL || (v->type != OP_MAP && v->type != OP_LIST && v->type != OP_STAND)) return true;
	if (depth > DEPTH) return false;
	for (size_t i = 0; i < v->count; i++)
		if (!shallow(v->items[i], depth + 1)) return false;
	return true;
}

// a commit's patches, if v1 merges them all: NULL, else why not
static const char *refusal(const cm_commit *c) {
	if (strcmp(c->table, "value") != 0) return "only the value table is kept";
	for (size_t i = 0; i < c->patches_length; i++) {
		const op_patch *p = &c->patches[i];
		if (p->has_move) return "a move patch is not merged";
		if (p->place.has_range) return "a range patch is not merged";
		for (size_t k = 0; k < p->place.length; k++)
			if (p->place.path[k].type != OP_STR_KEY) return "a list index in a path is not merged";
		if (p->has_value && !shallow(p->value, 0)) return "a value too deep";
	}
	return NULL;
}

// a held value of the device: its entry, made if there is none. When full: the oldest empty one
// goes, else the one held longest unrenewed; never this device's own (NULL when nothing can go)
static ls_held *held_of(ls_node *n, const uint8_t *signer, size_t length, bool make) {
	ls_held *free_ = NULL;
	for (int i = 0; i < HELDS; i++) {
		ls_held *h = &n->helds[i];
		if (h->signer_length == length && memcmp(h->signer, signer, length) == 0) return h;
		if (h->signer_length == 0 && free_ == NULL) free_ = h;
	}
	if (!make) return NULL;
	if (free_ == NULL) {
		for (int i = 0; i < HELDS; i++) {
			ls_held *h = &n->helds[i];
			if (h->value == NULL && !h->own && (free_ == NULL || h->last < free_->last)) free_ = h;
		}
		bool empty = free_ != NULL;
		for (int i = 0; !empty && i < HELDS; i++) {
			ls_held *h = &n->helds[i];
			bool mine = h->own || memcmp(h->signer, n->dev->key, LS_KEY_LEN) == 0;
			if (!mine && (free_ == NULL || h->expires < free_->expires)) free_ = h;
		}
		if (free_ == NULL) return NULL;
		op_free(free_->value);
	}
	memset(free_, 0, sizeof *free_);
	memcpy(free_->signer, signer, length);
	free_->signer_length = length;
	return free_;
}

// that device's stored commit has landed: what it held is gone
static void held_landed(ls_node *n, const uint8_t *signer, size_t length, int64_t lamport) {
	if (length > LS_KEY_LEN) return;
	ls_held *h = held_of(n, signer, length, true);
	if (h == NULL) return;
	if (lamport > h->last) h->last = lamport;
	if (h->value != NULL) {
		op_free(h->value);
		h->value = NULL;
		n->version++;
	}
}

// the commit's parents are no heads: marked when held, else remembered for when they come
static void name_parents(ls_node *n, const cm_commit *c) {
	for (size_t i = 0; i < c->parents_length; i++) {
		commit *p = commit_find(n, c->parents[i]);
		if (p != NULL) p->named = true;
		else {
			memcpy(n->named[n->named_at], c->parents[i], 8);
			n->named_at = (n->named_at + 1) % NAMED;
			if (n->named_n < NAMED) n->named_n++;
		}
	}
}
static bool named_before(const ls_node *n, const uint8_t name[CM_NAME]) {
	for (unsigned i = 0; i < n->named_n; i++)
		if (memcmp(n->named[i], name, 8) == 0) return true;
	return false;
}

// the parents of many commits taken at once (a load, a commits message), in any order: kept in a list
// till all are in, then marked (more than NAMED out of order would be missed)
typedef struct {
	uint8_t (*names)[CM_NAME];
	size_t n, cap;
} parents_seen;
static void parents_add(parents_seen *ps, const cm_commit *c) {
	for (size_t i = 0; i < c->parents_length; i++) {
		if (ps->n == ps->cap) {
			ps->cap = ps->cap ? ps->cap * 2 : 8;
			ps->names = realloc(ps->names, ps->cap * CM_NAME);
			if (ps->names == NULL) abort();
		}
		memcpy(ps->names[ps->n++], c->parents[i], CM_NAME);
	}
}
static void parents_mark(ls_node *n, parents_seen *ps) {
	for (size_t i = 0; i < ps->n; i++) {
		commit *p = commit_find(n, ps->names[i]);
		if (p != NULL) p->named = true;
	}
	free(ps->names);
}

// where the bytes are in the seal (0: not there)
static uint32_t find(const uint8_t *in, size_t length, const uint8_t *bytes, size_t n) {
	for (size_t i = 1; n > 0 && i + n <= length; i++)
		if (in[i] == bytes[0] && memcmp(in + i, bytes, n) == 0) return (uint32_t)i;
	return 0;
}

// a commit made or received (its patches decoded, sealed bytes the seal's). Its writes: each patch at
// its path, but one a later patch of the commit overwrote (at a prefix of its path). A write is dead on
// arrival when a standing write at or above it replaces it (it came late); dead or not, it replaces
// what it covers at and under its path. The commit is kept while a write of it stands, then passes
// (unref). from: the link slot it came on (acked; -1: none). NULL when it is let go of at once
static commit *commit_new(const ls_node *n, const uint8_t name[CM_NAME], const cm_commit *c, bool own) {
	commit *k = allocate(sizeof *k + 2 * n->dev->w);
	memcpy(k->name, name, CM_NAME);
	k->lamport = c->lamport;
	k->own = own;
	k->n_parents = (uint16_t)(c->parents_length < UINT16_MAX ? c->parents_length : UINT16_MAX);
	k->parents = allocate((k->n_parents + 1) * PRE);
	for (size_t i = 0; i < k->n_parents; i++) memcpy(k->parents[i], pre(c->parents[i]), PRE);
	return k;
}
static commit *take_commit(ls_node *n, const uint8_t name[CM_NAME], const uint8_t *sealed, size_t length, const cm_commit *c,
	bool own, int from) {
	commit *k = commit_new(n, name, c, own);
	write *mine = allocate((c->patches_length + 1) * sizeof *mine);
	bool *dead = allocate(c->patches_length + 1);
	size_t m = 0;
	for (size_t i = 0; i < c->patches_length && i < UINT16_MAX; i++) {
		const op_patch *p = &c->patches[i];
		size_t bytes = 0;
		for (size_t j = 0; j < p->place.length; j++) bytes += strlen(p->place.path[j].s) + 1;
		const cm_replaces *r = c->replaces != NULL && c->replaces[i].has ? &c->replaces[i] : NULL;
		size_t nr = r != NULL ? (r->length < UINT16_MAX ? r->length : UINT16_MAX) : 0;
		write w = {.bytes = bytes, .depth = p->place.length, .by = k, .patch = (uint16_t)i, .n_replaces = (uint16_t)nr,
			.gone = !p->has_value, .has_replaces = r != NULL};
		w.path = allocate(bytes + nr * PRE + 1);
		char *at = w.path;
		for (size_t j = 0; j < p->place.length; j++) {
			size_t len = strlen(p->place.path[j].s) + 1;
			memcpy(at, p->place.path[j].s, len);
			at += len;
		}
		w.replaces = (uint8_t(*)[PRE])(w.path + bytes);
		for (size_t j = 0; j < nr; j++) memcpy(w.replaces[j], pre(r->names[j]), PRE);
		// overwritten by a later patch of its commit: no write
		bool over = false;
		for (size_t j = i + 1; j < c->patches_length && !over; j++) {
			const op_target *q = &c->patches[j].place;
			over = q->length <= p->place.length;
			for (size_t x = 0; over && x < q->length; x++) over = strcmp(q->path[x].s, p->place.path[x].s) == 0;
		}
		if (over) {
			free(w.path);
			continue;
		}
		if (p->has_value) w.value = copy(p->value, 0);
		if (!w.gone && w.value == NULL) w.value = op_null();
		mine[m++] = w;
	}
	bool changed = false;
	for (size_t i = 0; i < m; i++) {
		size_t keep = 0;
		for (size_t s = 0; s < n->n_writes; s++) {
			write *x = &n->writes[s];
			if (above(&mine[i], x) && covers(n, &mine[i], x)) {
				commit *by = x->by;
				inherit(&mine[i], x);
				write_free(x);
				unref(n, by);
				changed = true;
			} else n->writes[keep++] = *x;
		}
		n->n_writes = keep;
	}
	for (size_t i = 0; i < m; i++)
		for (size_t s = 0; s < n->n_writes && !dead[i]; s++)
			if (above(&n->writes[s], &mine[i]) && covers(n, &n->writes[s], &mine[i])) {
				dead[i] = true;
				inherit(&n->writes[s], &mine[i]);
			}
	for (size_t i = 0; i < m; i++) {
		if (dead[i]) {
			write_free(&mine[i]);
			continue;
		}
		if (n->n_writes == n->c_writes) {
			n->c_writes = n->c_writes ? n->c_writes * 2 : 4;
			n->writes = realloc(n->writes, n->c_writes * sizeof *n->writes);
			if (n->writes == NULL) abort();
		}
		n->writes[n->n_writes++] = mine[i];
		k->refs++;
		changed = true;
	}
	free(mine);
	free(dead);
	name_parents(n, c);
	// the highest commit with a write standing stays (only a later one replaces a write): the highest
	// held is a head, so a write's lamport is 1 + its parents' highest (a passing one does not count)
	if (k->refs > 0 && c->lamport > n->lamport) n->lamport = c->lamport;
	k->named = named_before(n, name);
	k->sealed = allocate(length);
	memcpy(k->sealed, sealed, length);
	k->length = length;
	k->signer_at = find(sealed, length, c->signer, c->signer_length);
	if (from >= 0) ack(k, (unsigned)from);
	k->went = from >= 0;
	commit_add(n, k);
	commit *kept = k;
	if (k->refs == 0) {
		// nothing of it stands: it passes on to the links that lack it, or goes
		k->refs = 1;
		unref(n, k);
		kept = commit_find(n, name);
	}
	if (changed) settle(n);
	return kept;
}

// ---- nodes

static void blob_name(const ls_node *n, char *out) { snprintf(out, 16 + LS_ID_LEN, "node:%s", n->id); }

static void kept_name(const ls_node *n, size_t k, char *out) { snprintf(out, 40 + LS_ID_LEN, "kept:%s:%zu", short_id(n), k); }

// what the store keeps for a node: {lamport, commits: [seal]} (keep: and kept, how many are off),
// malloc'd
static uint8_t *node_blob(const ls_node *n, size_t *len) {
	size_t k = 0, size = 64;
	for (size_t i = 0; i < n->n_commits; i++)
		if (!n->commits[i]->passing) k++, size += n->commits[i]->length + 3;
	CborOut m = out_of(size);
	cborPutHead(&m, 5, 2 + KEEPS(n->dev));
	if (KEEPS(n->dev)) key(&m, "kept"), cborPutInteger(&m, (int64_t)n->n_kept_saved);
	key(&m, "commits"), cborPutHead(&m, 4, k);
	for (size_t i = 0; i < n->n_commits; i++)
		if (!n->commits[i]->passing) cborPutBytes(&m, n->commits[i]->sealed, n->commits[i]->length);
	key(&m, "lamport"), cborPutInteger(&m, n->lamport);
	*len = m.length;
	return m.data;
}

// keep: the blobs of names off since the last save (the last one again, and the new ones)
static void save_kept(ls_node *n) {
	ls_dev *d = n->dev;
	for (size_t k = n->n_kept_saved / KEPT; k * KEPT < n->n_kept; k++) {
		size_t end = (k + 1) * KEPT < n->n_kept ? (k + 1) * KEPT : n->n_kept;
		CborOut list = out_of((end - k * KEPT) * (CM_NAME + 2) + 3);
		cborPutHead(&list, 4, end - k * KEPT);
		for (size_t i = k * KEPT; i < end; i++) cborPutBytes(&list, n->kept[i]->name, CM_NAME);
		size_t len = list.length;
		uint8_t *b = list.data;
		char name[40 + LS_ID_LEN];
		kept_name(n, k, name);
		bool ok = b != NULL && d->o.store.save(d->o.store.context, name, b, len);
		free(b);
		if (!ok) return;
		n->n_kept_saved = (k + 1) * KEPT < n->n_kept ? (k + 1) * KEPT : n->n_kept;
	}
}

static void save_node(ls_node *n) {
	ls_dev *d = n->dev;
	n->dirty = false;
	n->saved = d->now;
	if (KEEPS(d)) save_kept(n);
	size_t len;
	uint8_t *b = node_blob(n, &len);
	char name[16 + LS_ID_LEN];
	blob_name(n, name);
	if (b != NULL) d->o.store.save(d->o.store.context, name, b, len);
	free(b);
}

// keep: the commits off, from their blobs: each seal read for its lamport and parents, then let go of
static void load_kept(ls_node *n, size_t count, parents_seen *ps) {
	ls_dev *d = n->dev;
	for (size_t k = 0; k * KEPT < count; k++) {
		char name[40 + LS_ID_LEN];
		kept_name(n, k, name);
		uint8_t *b;
		size_t len;
		if (!d->o.store.load(d->o.store.context, name, &b, &len)) break;
		Json *list = cborDecode(b, len, NULL, NULL);
		free(b);
		for (int i = 0; list != NULL && list->type == JSON_ARRAY && i < list->array.count && k * KEPT + (size_t)i < count; i++) {
			const Json *x = list->array.items[i];
			char sname[SEAL_NAME];
			uint8_t *s;
			size_t slen;
			opened o;
			if (!is_name(x) || commit_find(n, x->bytes.data) != NULL) continue;
			seal_name(n, x->bytes.data, sname);
			if (!d->o.store.load(d->o.store.context, sname, &s, &slen)) continue;
			if (open_seal(d, s, slen, n->doc, false, &o) == 2) {
				commit *c = commit_new(n, o.name, &o.c, memcmp(o.c.signer, d->key, LS_KEY_LEN) == 0);
				c->length = slen;
				c->passing = c->went = true;
				c->since = d->now;
				commit_add(n, c);
				kept_add(n, c);
				parents_add(ps, &o.c);
				cm_free(&o.c);
			}
			free(s);
		}
		jsonFree(list);
	}
	n->n_kept_saved = n->n_kept;
}

static void load_node(ls_node *n) {
	ls_dev *d = n->dev;
	char name[16 + LS_ID_LEN];
	blob_name(n, name);
	uint8_t *b;
	size_t len;
	if (!d->o.store.load(d->o.store.context, name, &b, &len)) return;
	Json *m = cborDecode(b, len, NULL, NULL);
	free(b);
	const Json *list = m != NULL ? jsonGet(m, "commits") : NULL, *kept = m != NULL ? jsonGet(m, "kept") : NULL;
	parents_seen ps = {0};
	if (KEEPS(d) && kept != NULL && kept->type == JSON_NUMBER && kept->number > 0) load_kept(n, (size_t)kept->number, &ps);
	if (list != NULL && list->type == JSON_ARRAY)
		for (int i = 0; i < list->array.count; i++) {
			const Json *s = list->array.items[i];
			opened o;
			// our own store: not checked again
			if (s->type != JSON_BYTES || open_seal(d, s->bytes.data, s->bytes.length, n->doc, false, &o) != 2) continue;
			if (!seen(n, o.name) && refusal(&o.c) == NULL) {
				commit *k = take_commit(n, o.name, s->bytes.data, s->bytes.length, &o.c, memcmp(o.c.signer, d->key, LS_KEY_LEN) == 0, -1);
				// it may have gone to a peer before the restart
				if (k != NULL) k->went = true;
				parents_add(&ps, &o.c);
			}
			cm_free(&o.c);
		}
	parents_mark(n, &ps);
	// the saved "lamport" is not read back: the commits held say it (take_commit)
	jsonFree(m);
	n->dirty = false;
}

ls_node *ls_find(ls_dev *d, const char *id) {
	for (size_t i = 0; i < d->n_nodes; i++)
		if (strcmp(d->nodes[i]->id, id) == 0) return d->nodes[i];
	return NULL;
}

static ls_node *by_doc(ls_dev *d, const Json *b) {
	if (b == NULL || b->type != JSON_BYTES || b->bytes.length != 32) return NULL;
	for (size_t i = 0; i < d->n_nodes; i++)
		if (memcmp(d->nodes[i]->doc, b->bytes.data, 32) == 0) return d->nodes[i];
	return NULL;
}

static topic *topic_make(ls_dev *d, const char *name);
ls_node *ls_follow(ls_dev *d, const char *id) {
	ls_node *n = ls_find(d, id);
	if (n != NULL) return n;
	uint8_t doc[32];
	if (!id_doc(id, doc) || d->n_nodes >= (d->o.max_nodes ? d->o.max_nodes : 64)) return NULL;
	n = allocate(sizeof *n);
	n->dev = d;
	memcpy(n->id, id, LS_ID_LEN);
	memcpy(n->doc, doc, 32);
	n->version = 1;
	n->saved = d->now;
	n->hold_sent = INT64_MIN / 2;
	load_node(n);
	d->nodes = realloc(d->nodes, (d->n_nodes + 1) * sizeof *d->nodes);
	if (d->nodes == NULL) abort();
	d->nodes[d->n_nodes++] = n;
	for (unsigned i = 0; i < d->n_links; i++)
		if (d->links[i] != NULL && d->links[i]->up) send_heads(n, d->links[i], false);
	// its presence rows: a room on its id
	topic *t = topic_make(d, id);
	if (!t->room) t->room = true, d->wants_changed = true;
	return n;
}

const char *ls_id(const ls_node *n) { return n->id; }
const op_value *ls_value(const ls_node *n) { return n->value; }
uint32_t ls_version(const ls_node *n) { return n->version; }
size_t ls_commits(const ls_node *n) {
	size_t k = 0;
	for (size_t i = 0; i < n->n_commits; i++) k += !n->commits[i]->passing;
	return k;
}
int64_t ls_lamport(const ls_node *n) { return n->lamport; }

// the bytes a value takes encoded (0: none)
static size_t encoded(const Json *j) {
	size_t k = 0;
	if (j == NULL || !cborEncode(j, NULL, 0, &k, NULL)) return 0;
	return k;
}

ls_cost ls_cost_of(const ls_node *n) {
	ls_cost c = {0};
	size_t len;
	free(node_blob(n, &len));
	c.stored = len;
	c.commits = ls_commits(n);
	const commit *top = NULL;
	for (size_t i = 0; i < n->n_commits; i++) {
		if (n->commits[i]->passing) continue;
		c.seals += n->commits[i]->length;
		if (top == NULL || later(n->commits[i]->lamport, n->commits[i]->name, top->lamport, top->name) > 0) top = n->commits[i];
	}
	if (top == NULL) return c;
	c.newest.length = top->length;
	Json *x = cborDecode(top->sealed, top->length, NULL, NULL);
	const Json *b = x != NULL ? jsonGet(x, "commit") : NULL;
	Json *j = b != NULL && b->type == JSON_BYTES ? cborDecode(b->bytes.data, b->bytes.length, NULL, NULL) : NULL;
	if (j != NULL) {
		c.newest.signature = encoded(jsonGet(x, "signature"));
		c.newest.signer = encoded(jsonGet(j, "signer"));
		const Json *parents = jsonGet(j, "parents");
		c.newest.parents = parents != NULL && parents->type == JSON_ARRAY ? (size_t)parents->array.count : 0;
		c.newest.parents_bytes = encoded(parents);
		c.newest.patches = encoded(jsonGet(j, "patches"));
		c.newest.rest = c.newest.length - c.newest.signature - c.newest.signer - c.newest.parents_bytes - c.newest.patches;
	}
	jsonFree(j);
	jsonFree(x);
	return c;
}

static void node_free(ls_node *n) {
	op_free(n->value);
	for (size_t i = 0; i < n->n_writes; i++) write_free(&n->writes[i]);
	free(n->writes);
	for (size_t i = 0; i < n->n_commits; i++) commit_free(n->commits[i]);
	free(n->commits);
	free(n->index);
	free(n->kept);
	for (int i = 0; i < HELDS; i++) op_free(n->helds[i].value);
	free(n->hold);
	free(n);
}

// ---- writing

// a write's parents: the held commits no commit taken in names (the heads, as far as this device can
// tell), the highest lamports first when there are more than LS_MAX_PARENTS; the highest held always
// (a write's lamport is 1 + its); and every head it replaces a write of (so what it names is its
// ancestor, values.org). In name order
static bool gone(const commit *c, commit *const *list, size_t n) {
	for (size_t i = 0; i < n; i++)
		if (list[i] == c) return true;
	return false;
}
// skip: commits that are not there (collapsed)
static void heads_parents(const ls_node *n, commit *const *named, size_t n_named, commit *const *skip, size_t n_skip,
	const uint8_t (**out)[CM_NAME], size_t *count) {
	const commit **all = allocate((n->n_commits + 1) * sizeof *all);
	const commit *top = NULL;
	for (size_t i = 0; i < n->n_commits; i++)
		if (!n->commits[i]->passing && !gone(n->commits[i], skip, n_skip) &&
			(top == NULL || later(n->commits[i]->lamport, n->commits[i]->name, top->lamport, top->name) > 0))
			top = n->commits[i];
	size_t m = 0;
	if (top != NULL) all[m++] = top;
	for (size_t i = 0; i < n->n_commits; i++) {
		const commit *c = n->commits[i];
		if (c->named || c == top || c->passing || gone(c, skip, n_skip)) continue;
		size_t k = m++;
		for (; k > 1 && later(all[k - 1]->lamport, all[k - 1]->name, c->lamport, c->name) < 0; k--) all[k] = all[k - 1];
		all[k] = c;
	}
	size_t heads = m;
	if (m > LS_MAX_PARENTS) m = LS_MAX_PARENTS;
	// the heads past the cap that a write replaces come back in
	for (size_t i = m; i < heads; i++) {
		bool wanted = false;
		for (size_t k = 0; k < n_named && !wanted; k++) wanted = named[k] == all[i];
		if (wanted) all[m++] = all[i];
	}
	for (size_t i = 1; i < m; i++) {
		const commit *c = all[i];
		size_t k = i;
		for (; k > 0 && memcmp(all[k - 1]->name, c->name, CM_NAME) > 0; k--) all[k] = all[k - 1];
		all[k] = c;
	}
	uint8_t(*p)[CM_NAME] = allocate((m + 1) * CM_NAME);
	for (size_t i = 0; i < m; i++) memcpy(p[i], all[i]->name, CM_NAME);
	free(all);
	*out = (const uint8_t(*)[CM_NAME])p;
	*count = m;
}

// a commit of the patches (borrowed) at the lamport, no parents yet (a held value's: none), its bytes
// cm_encode's. Key patches only: several parents need neither base nor merge (commit.h)
static cm_commit commit_of(ls_dev *d, op_patch *patches, size_t n, int64_t lamport) {
	cm_commit c = {.table = "value", .change = {.has_time = 1, .time = d->o.epoch_ms + d->now}, .signer_length = LS_KEY_LEN,
		.lamport = lamport, .patches = patches, .patches_length = n};
	memcpy(c.signer, d->key, LS_KEY_LEN);
	d->nonce = d->nonce * 1664525u + 1013904223u;
	c.nonce = d->nonce;
	return c;
}

static void drop_hold(ls_node *n) {
	ls_held *h = held_of(n, n->dev->key, LS_KEY_LEN, false);
	if (h != NULL && h->value != NULL) {
		op_free(h->value);
		h->value = NULL;
		n->version++;
	}
	free(n->hold);
	n->hold = NULL;
}

// a patch's path as a write's (keys each followed by a 0), malloc'd; NULL: a key that is none
static char *path_bytes(const ls_patch *p, size_t *bytes) {
	size_t b = 0;
	for (size_t k = 0; k < p->length; k++) {
		if (p->path[k] == NULL) return NULL;
		b += strlen(p->path[k]) + 1;
	}
	char *out = allocate(b + 1), *at = out;
	for (size_t k = 0; k < p->length; k++) {
		size_t m = strlen(p->path[k]) + 1;
		memcpy(at, p->path[k], m);
		at += m;
	}
	*bytes = b;
	return out;
}

// what patch replaces: the commits of the first item at each path at and under it (what ls_value
// shows), or with all of every item there. Each once, into out (n_writes room); how many
static size_t replaced(const ls_node *n, const ls_patch *p, commit **out) {
	size_t bytes, m = 0;
	char *path = path_bytes(p, &bytes);
	if (path == NULL) return 0;
	write me = {.path = path, .bytes = bytes};
	for (size_t i = 0; i < n->n_writes; i++) {
		const write *w = &n->writes[i];
		if (!above(&me, w)) continue;
		bool first = i == 0 || !same_path(&n->writes[i - 1], w), had = false;
		for (size_t k = 0; k < m && !had; k++) had = out[k] == w->by;
		if (!had && (first || p->all)) out[m++] = w->by;
	}
	free(path);
	return m;
}

// names, each once
typedef struct {
	uint8_t (*names)[CM_NAME];
	size_t n, cap;
} names;
static void name_add(names *s, const uint8_t name[CM_NAME]) {
	for (size_t i = 0; i < s->n; i++)
		if (memcmp(s->names[i], name, CM_NAME) == 0) return;
	if (s->n == s->cap) {
		s->cap = s->cap ? s->cap * 2 : 4;
		s->names = realloc(s->names, s->cap * CM_NAME);
		if (s->names == NULL) abort();
	}
	memcpy(s->names[s->n++], name, CM_NAME);
}
static int name_order(const void *a, const void *b) { return memcmp(a, b, CM_NAME); }

ls_code ls_write(ls_node *n, const ls_patch *patches, size_t count) {
	ls_dev *d = n->dev;
	if (count == 0) return LS_BAD;
	// what each patch replaces (commits)
	size_t room = n->n_writes + 1;
	commit **reps = allocate(count * room * sizeof *reps);
	size_t *k = allocate(count * sizeof *k), *bytes = allocate(count * sizeof *bytes);
	char **paths = allocate(count * sizeof *paths);
	bool bad = false;
	for (size_t i = 0; i < count; i++) {
		paths[i] = path_bytes(&patches[i], &bytes[i]);
		bad |= paths[i] == NULL;
		k[i] = replaced(n, &patches[i], reps + i * room);
	}
	// an own commit never sent, every write of which this one replaces at that write's own path, is as
	// if never made (collapsed): this write takes its parents, and names what it named in its place.
	// So a device's moves while no peer hears it are one commit, exact everywhere
	commit **gone_ = allocate((n->n_commits + 1) * sizeof *gone_);
	opened *was = allocate((n->n_commits + 1) * sizeof *was);
	size_t n_gone = 0;
	for (size_t c = 0; c < n->n_commits && !bad; c++) {
		commit *x = n->commits[c];
		if (!x->own || x->went || x->passing || x->refs == 0) continue;
		bool all = true;
		for (size_t w = 0; w < n->n_writes && all; w++) {
			const write *y = &n->writes[w];
			if (y->by != x) continue;
			bool hit = false;
			for (size_t i = 0; i < count && !hit; i++)
				if (bytes[i] == y->bytes && memcmp(paths[i], y->path, y->bytes) == 0)
					for (size_t j = 0; j < k[i] && !hit; j++) hit = reps[i * room + j] == x;
			all = hit;
		}
		if (!all || open_seal(d, x->sealed, x->length, n->doc, false, &was[n_gone]) != 2) continue;
		gone_[n_gone++] = x;
	}
	// the names per patch: a collapsed commit's own in its place (absent: its parents, which is what
	// ancestry gave it)
	names *named = allocate(count * sizeof *named);
	commit **heads_named = allocate((count * room + 1) * sizeof *heads_named);
	size_t n_heads_named = 0;
	for (size_t i = 0; i < count && !bad; i++) {
		for (size_t j = 0; j < k[i]; j++) {
			commit *x = reps[i * room + j];
			size_t g = 0;
			while (g < n_gone && gone_[g] != x) g++;
			if (g == n_gone) {
				name_add(&named[i], x->name);
				heads_named[n_heads_named++] = x;
				continue;
			}
			const cm_commit *cc = &was[g].c;
			for (size_t p = 0; p < cc->patches_length; p++) {
				const op_target *t = &cc->patches[p].place;
				size_t b = 0;
				for (size_t q = 0; q < t->length; q++) b += strlen(t->path[q].s) + 1;
				bool here = b == bytes[i] && t->length == patches[i].length;
				for (size_t q = 0; q < t->length && here; q++) here = strcmp(t->path[q].s, patches[i].path[q]) == 0;
				if (!here) continue;
				if (cc->replaces != NULL && cc->replaces[p].has)
					for (size_t r = 0; r < cc->replaces[p].length; r++) name_add(&named[i], cc->replaces[p].names[r]);
				else
					for (size_t r = 0; r < cc->parents_length; r++) name_add(&named[i], cc->parents[r]);
			}
		}
	}
	// the parents: the heads (but the collapsed), the heads it replaces, the collapsed ones' parents. The
	// lamport: 1 + theirs, the highest (a collapsed one's parents: at most its lamport - 1)
	const uint8_t(*heads)[CM_NAME];
	size_t n_heads;
	heads_parents(n, heads_named, n_heads_named, gone_, n_gone, &heads, &n_heads);
	names parents = {0};
	int64_t top = 0;
	for (size_t i = 0; i < n_heads; i++) {
		name_add(&parents, heads[i]);
		const commit *x = commit_find(n, heads[i]);
		if (x != NULL && x->lamport > top) top = x->lamport;
	}
	free((void *)heads);
	for (size_t g = 0; g < n_gone; g++) {
		for (size_t r = 0; r < was[g].c.parents_length; r++) name_add(&parents, was[g].c.parents[r]);
		if (gone_[g]->lamport - 1 > top) top = gone_[g]->lamport - 1;
	}
	if (parents.n > 1) qsort(parents.names, parents.n, CM_NAME, name_order);
	int64_t lamport = n_gone ? top + 1 : n->lamport + 1;
	// the commit, its patches the caller's (borrowed: kept as they are, take_commit copies)
	op_patch *list = allocate((count + 1) * sizeof *list);
	cm_replaces *rs = allocate((count + 1) * sizeof *rs);
	size_t keys = 0;
	for (size_t i = 0; i < count; i++) keys += patches[i].length;
	op_key *key_list = allocate((keys + 1) * sizeof *key_list), *at = key_list;
	for (size_t i = 0; i < count && !bad; i++) {
		const ls_patch *p = &patches[i];
		for (size_t q = 0; q < p->length; q++) at[q] = (op_key){.type = OP_STR_KEY, .s = p->path[q]};
		list[i].place = (op_target){.path = at, .length = p->length};
		at += p->length;
		list[i].has_value = p->value != NULL;
		list[i].value = p->value;
		bad |= p->value != NULL && !carried(p->value, 0);
		// replaces: always said, the names ascending (left out, it would mean ancestry: what a device
		// without history can tell only in part)
		if (named[i].n > 1) qsort(named[i].names, named[i].n, CM_NAME, name_order);
		rs[i] = (cm_replaces){.has = 1, .names = (const uint8_t(*)[CM_NAME])named[i].names, .length = named[i].n};
	}
	for (size_t i = 0; i < count; i++) free(paths[i]);
	for (size_t g = 0; g < n_gone; g++) cm_free(&was[g].c);
	free(heads_named), free(reps), free(k), free(bytes), free(paths), free(was);
	cm_commit c = {0};
	uint8_t *encoded_ = NULL;
	size_t length;
	if (!bad) {
		c = commit_of(d, list, count, lamport);
		c.parents = (const uint8_t(*)[CM_NAME])parents.names;
		c.parents_length = parents.n;
		c.replaces = rs;
		bad = cm_encode(&c, &encoded_, &length, NULL) != CM_OK;
	}
	size_t slength = 0;
	uint8_t *sealed = NULL;
	uint8_t name[CM_NAME];
	if (!bad) {
		cm_name(encoded_, length, name);
		sealed = seal(d, encoded_, length, n->doc, &slength);
	}
	free(encoded_);
	// a seal that can't go in one message would be sent, dropped by the peer and sent again forever
	bad = bad || refusal(&c) != NULL || slength > CHUNK;
	commit *kept = NULL;
	if (!bad) {
		// a write is this device's next stored commit: what it held goes
		drop_hold(n);
		held_landed(n, d->key, LS_KEY_LEN, c.lamport);
		kept = take_commit(n, name, sealed, slength, &c, true, -1);
	}
	free(sealed);
	for (size_t i = 0; i < count; i++) free(named[i].names);
	free(named), free(parents.names), free(list), free(rs), free(key_list);
	if (bad) return free(gone_), LS_BAD;
	// the collapsed: their writes, and they, gone (nobody else had them)
	for (size_t g = 0; g < n_gone; g++) {
		size_t at = 0;
		while (at < n->n_commits && n->commits[at] != gone_[g]) at++;
		if (at == n->n_commits) continue;
		size_t keep = 0;
		for (size_t w = 0; w < n->n_writes; w++)
			if (n->writes[w].by == gone_[g]) write_free(&n->writes[w]);
			else n->writes[keep++] = n->writes[w];
		n->n_writes = keep;
		commit_remove(n, at);
		commit_free(gone_[g]);
	}
	if (n_gone) settle(n);
	free(gone_);
	n->version++;
	if (kept != NULL)
		for (unsigned i = 0; i < d->n_links; i++)
			if (d->links[i] != NULL && d->links[i]->up) send_commits(n, d->links[i], &kept, 1);
	return LS_OK;
}

ls_code ls_put(ls_node *n, const op_value *value) {
	ls_patch p = {NULL, 0, value, 0};
	return ls_write(n, &p, 1);
}
ls_code ls_pick(ls_node *n, const op_value *value) {
	ls_patch p = {NULL, 0, value, 1};
	return ls_write(n, &p, 1);
}
ls_code ls_set(ls_node *n, const char *key, const op_value *value) {
	const char *path[1] = {key};
	ls_patch p = {path, 1, value, 0};
	return ls_write(n, &p, 1);
}
ls_code ls_del(ls_node *n, const char *key) { return ls_set(n, key, NULL); }

// ---- reading

_Static_assert(sizeof(((ls_item *)0)->name) == CM_NAME, "an item's name is a commit's");

static void item_of(const write *w, size_t at, const op_value *value, bool gone, bool inside, ls_item *out) {
	memset(out, 0, sizeof *out);
	out->value = gone ? NULL : value;
	out->gone = gone;
	out->far = !gone && w->far;
	out->inside = inside;
	out->at = at;
	if (w->by->signer_at) {
		out->signer = w->by->sealed + w->by->signer_at;
		out->signer_length = LS_KEY_LEN;
	}
	out->lamport = w->by->lamport;
	memcpy(out->name, w->by->name, CM_NAME);
}

// whether a standing write under w's path is not its own
static bool inside_of(const ls_node *n, const write *w) {
	for (size_t i = 0; i < n->n_writes; i++) {
		const write *d = &n->writes[i];
		if (d->depth > w->depth && above(w, d) && !owns(n, w, d)) return true;
	}
	return false;
}

size_t ls_values(const ls_node *n, const char *const *path, size_t length, ls_item *out, size_t max) {
	ls_patch p = {path, length, NULL, 0};
	size_t bytes, k = 0;
	char *keys = path_bytes(&p, &bytes);
	if (keys == NULL) return 0;
	write me = {.path = keys, .bytes = bytes, .depth = length};
	// the writes at the path, in the agreed order (the writes are sorted)
	for (size_t i = 0; i < n->n_writes; i++) {
		const write *w = &n->writes[i];
		if (!same_path(w, &me)) continue;
		if (k < max) item_of(w, length, w->value, w->gone, inside_of(n, w), &out[k]);
		k++;
	}
	// a shallower write over it, when one here is not its own: its value at the path, in the agreed order
	size_t here = k;
	const write **over = allocate((n->n_writes + 1) * sizeof *over);
	size_t m = 0;
	for (size_t i = 0; here > 0 && i < n->n_writes; i++) {
		const write *c = &n->writes[i];
		if (c->depth >= length || !above(c, &me)) continue;
		bool not_own = false;
		for (size_t j = 0; j < n->n_writes && !not_own; j++)
			not_own = same_path(&n->writes[j], &me) && !owns(n, c, &n->writes[j]);
		if (!not_own) continue;
		size_t x = m++;
		for (; x > 0 && later(over[x - 1]->by->lamport, over[x - 1]->by->name, c->by->lamport, c->by->name) < 0; x--) over[x] = over[x - 1];
		over[x] = c;
	}
	for (size_t i = 0; i < m; i++) {
		const write *c = over[i];
		const char *rest = keys + c->bytes;
		const op_value *v = c->gone || c->far ? NULL : dig(c->value, rest, length - c->depth);
		if (k < max) item_of(c, c->depth, v, c->gone || (!c->far && v == NULL), inside_of(n, c), &out[k]);
		k++;
	}
	free(over);
	free(keys);
	return k;
}

// ---- held values

// an unsealed commit to every link that is up but `except`: the device's own hold goes to all, one taken in
// from a link goes on to the others
static void send_ephemeral(ls_node *n, const struct ls_link *except, const uint8_t *bytes, size_t length) {
	ls_dev *d = n->dev;
	ls_framed *f = NULL;
	size_t size = 0;
	for (unsigned i = 0; i < d->n_links; i++) {
		struct ls_link *l = d->links[i];
		if (l == NULL || l == except || !l->up) continue;
		say(d, "tx ephemeral %.8s", short_id(n));
		// framed once, for every link
		if (f == NULL) {
			CborOut m = message("ephemeral", 2, length + 64);
			key(&m, "node"), cborPutBytes(&m, n->doc, 32);
			key(&m, "commit"), cborPutBytes(&m, bytes, length);
			f = ls_framed_of(m.data, size = m.length);
			free(m.data);
		}
		if (room_for(l, size)) queue(l, f);
	}
	ls_framed_drop(f);
}

static void send_hold(ls_node *n) {
	n->hold_sent = n->dev->now;
	n->hold_dirty = false;
	if (n->hold != NULL) send_ephemeral(n, NULL, n->hold, n->hold_length);
}

ls_code ls_hold(ls_node *n, const op_value *value) {
	ls_dev *d = n->dev;
	op_value *c = copy(value, 0);
	if (c == NULL) return LS_BAD;
	op_patch p = {.has_value = 1, .value = c};
	cm_commit j = commit_of(d, &p, 1, n->lamport + 1);
	uint8_t *bytes;
	size_t length;
	if (cm_encode(&j, &bytes, &length, NULL) != CM_OK) return op_free(c), LS_BAD;
	free(n->hold);
	n->hold = bytes;
	n->hold_length = length;
	ls_held *h = held_of(n, d->key, LS_KEY_LEN, true);
	op_free(h->value);
	h->value = c;
	h->own = 1;
	n->version++;
	if (d->now - n->hold_sent >= 50) send_hold(n);
	else n->hold_dirty = true;
	return LS_OK;
}

void ls_unhold(ls_node *n) { drop_hold(n); }

size_t ls_helds(const ls_node *n) {
	size_t k = 0;
	for (int i = 0; i < HELDS; i++) k += n->helds[i].value != NULL;
	return k;
}
const ls_held *ls_held_at(const ls_node *n, size_t at) {
	for (int i = 0; i < HELDS; i++)
		if (n->helds[i].value != NULL && at-- == 0) return &n->helds[i];
	return NULL;
}

// ---- short-lived messages: bytes on a topic, to the peers that want it, never stored

static const Json *field(const Json *m, const char *key, JsonType type) {
	const Json *v = jsonGet(m, key);
	return v != NULL && v->type == type ? v : NULL;
}

static size_t message_max(const ls_dev *d) { return d->o.message ? d->o.message : LS_MESSAGE; }
static size_t rows_max(const ls_dev *d) { return d->o.rows ? d->o.rows : LS_ROWS; }

static bool topic_ok(const char *name) {
	size_t n = name != NULL ? strlen(name) : 0;
	return n > 0 && n <= LS_TOPIC_MAX;
}

static char *text_copy(const char *s) {
	size_t n = strlen(s);
	char *c = allocate(n + 1);
	memcpy(c, s, n);
	return c;
}

static topic *topic_find(const ls_dev *d, const char *name) {
	for (size_t i = 0; i < d->n_topics; i++)
		if (strcmp(d->topics[i]->name, name) == 0) return d->topics[i];
	return NULL;
}

// the topic, made if it is not there (heard as nothing yet: the caller says listen or room)
static topic *topic_make(ls_dev *d, const char *name) {
	topic *t = topic_find(d, name);
	if (t != NULL) return t;
	t = allocate(sizeof *t);
	t->name = text_copy(name);
	t->row_sent = INT64_MIN / 2;
	d->topics = realloc(d->topics, (d->n_topics + 1) * sizeof *d->topics);
	if (d->topics == NULL) abort();
	d->topics[d->n_topics++] = t;
	return t;
}

static void topic_free(topic *t) {
	for (size_t i = 0; i < t->n_rows; i++) op_free(t->rows[i].value);
	free(t->rows);
	ls_framed_drop(t->row);
	free(t->name);
	free(t);
}

static bool wants(const struct ls_link *l, const char *name) {
	if (l->wants_all) return true;
	for (size_t i = 0; i < l->n_wants; i++)
		if (strcmp(l->wants[i], name) == 0) return true;
	return false;
}

// a link a say on the topic goes to: up and wanting it, not `except`; only: that link alone
static bool say_to(const struct ls_link *l, const struct ls_link *except, const struct ls_link *only, const char *name) {
	return l != NULL && l != except && l->up && (only == NULL || l == only) && wants(l, name);
}
static bool says(const ls_dev *d, const struct ls_link *except, const struct ls_link *only, const char *name) {
	for (unsigned i = 0; i < d->n_links; i++)
		if (say_to(d->links[i], except, only, name)) return true;
	return false;
}

// a say on the topic, framed: its bytes the sealed ones given, or (sealed NULL) these bytes sealed here.
// *n its message's bytes. NULL: a topic that is no text
static ls_framed *say_frame(ls_dev *d, const char *name, const uint8_t *sealed, const uint8_t *bytes, size_t length,
	size_t *n) {
	CborOut m = message("say", 2, length + (sealed ? 0 : LS_SEALED) + strlen(name) + 32);
	key(&m, "bytes");
	if (sealed != NULL) cborPutBytes(&m, sealed, length);
	else put_said(d, &m, name, bytes, length);
	key(&m, "topic");
	ls_framed *f = cborPutText(&m, name, strlen(name)) ? ls_framed_of(m.data, m.length) : NULL;
	*n = m.length;
	free(m.data);
	return f;
}

// a say (say_frame's) to every link say_to takes
static void send_say(ls_dev *d, const struct ls_link *except, struct ls_link *only, const char *name, ls_framed *f,
	size_t n) {
	for (unsigned i = 0; i < d->n_links; i++) {
		struct ls_link *l = d->links[i];
		if (!say_to(l, except, only, name)) continue;
		say(d, "tx say %.24s", name);
		if (f != NULL && room_for(l, n)) queue(l, f);
	}
}

ls_code ls_send(ls_dev *d, const char *name, const uint8_t *bytes, size_t length) {
	if (!topic_ok(name) || (bytes == NULL && length) || length > message_max(d)) return LS_BAD;
	if (!says(d, NULL, NULL, name)) return LS_OK;
	size_t n;
	ls_framed *f = say_frame(d, name, NULL, bytes, length, &n);
	send_say(d, NULL, NULL, name, f, n);
	ls_framed_drop(f);
	return LS_OK;
}

ls_code ls_listen(ls_dev *d, const char *name) {
	if (!topic_ok(name)) return LS_BAD;
	topic *t = topic_make(d, name);
	if (!t->listen) t->listen = true, d->wants_changed = true;
	return LS_OK;
}

// what the link's peer is told this device wants: the topics it hears, and (a relay) what the peers on
// its other links want. Sent when it differs from the last told, or force
static void send_listen(ls_dev *d, struct ls_link *l, bool force) {
	const char **list = NULL;
	size_t n = 0;
	bool all = false;
	uint32_t sum = 0;
	for (unsigned k = 0; k <= d->n_links && !all; k++) {
		const struct ls_link *o = k < d->n_links ? d->links[k] : NULL;
		if (k < d->n_links && (o == NULL || o == l)) continue;
		all = o != NULL && o->wants_all;
		size_t count = o != NULL ? o->n_wants : d->n_topics;
		for (size_t i = 0; i < count && !all; i++) {
			const char *name = o != NULL ? o->wants[i] : d->topics[i]->name;
			if (o == NULL && !d->topics[i]->listen && !d->topics[i]->room) continue;
			bool there = false;
			for (size_t j = 0; j < n && !there; j++) there = strcmp(list[j], name) == 0;
			if (there) continue;
			if (n == WANTS) all = true;
			else {
				if (n % 16 == 0 && (list = realloc(list, (n + 16) * sizeof *list)) == NULL) abort();
				list[n++] = name;
				// FNV-1a, summed: the same for the same set in any order
				uint32_t h = 2166136261u;
				for (const char *c = name; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
				sum += h;
			}
		}
	}
	uint32_t told = (all ? 0x9e3779b9u : sum + (uint32_t)n * 2654435761u) | 1;
	if (force || told != l->told) {
		l->told = told;
		size_t size = 32, put = all ? 0 : n;
		for (size_t i = 0; i < put; i++) size += strlen(list[i]) + 3;
		CborOut m = message("listen", 1 + all, size);
		if (all) key(&m, "all"), cborPutBoolean(&m, true);
		key(&m, "topics"), cborPutHead(&m, 4, put);
		bool ok = true;
		for (size_t i = 0; i < put; i++) ok &= cborPutText(&m, list[i], strlen(list[i]));
		say(d, "tx listen %zu%s", put, all ? " all" : "");
		if (ok) send_message(l, &m);
		else free(m.data);
	}
	free(list);
}

// ---- presence: rows on a topic, each a message (presence.ts's) of who's, lasting till its ttl

static void rows_changed(ls_dev *d, const topic *t) {
	ls_node *n = ls_find(d, t->name);
	if (n != NULL) n->version++;
}

// who's row: found, or (make) a new one, else the one of another device soonest to lapse. NULL: none
static ls_row *row_of(ls_dev *d, topic *t, const uint8_t *who, size_t length, bool make) {
	for (size_t i = 0; i < t->n_rows; i++)
		if (t->rows[i].who_length == length && memcmp(t->rows[i].who, who, length) == 0) return &t->rows[i];
	if (!make) return NULL;
	ls_row *r = NULL;
	if (t->n_rows < rows_max(d)) {
		if (t->n_rows == t->c_rows) {
			t->c_rows = t->c_rows ? t->c_rows * 2 : 2;
			if (t->c_rows > rows_max(d)) t->c_rows = rows_max(d);
			if ((t->rows = realloc(t->rows, t->c_rows * sizeof *t->rows)) == NULL) abort();
		}
		r = &t->rows[t->n_rows++];
	} else {
		for (size_t i = 0; i < t->n_rows; i++)
			if (!t->rows[i].own && (r == NULL || t->rows[i].until < r->until)) r = &t->rows[i];
		if (r == NULL) return NULL;
		op_free(r->value);
	}
	memset(r, 0, sizeof *r);
	memcpy(r->who, who, length);
	r->who_length = length;
	return r;
}

static void row_drop(ls_dev *d, topic *t, ls_row *r) {
	if (r == NULL) return;
	op_free(r->value);
	*r = t->rows[--t->n_rows];
	rows_changed(d, t);
}

static void send_row(ls_dev *d, topic *t, struct ls_link *only) {
	if (only == NULL) t->row_sent = d->now, t->row_dirty = false;
	ls_row *r = row_of(d, t, d->key, LS_KEY_LEN, false);
	if (r != NULL && only == NULL) r->until = d->now + LS_TTL_MS;
	if (t->row != NULL) send_say(d, NULL, only, t->name, t->row, t->row_length);
}

static ls_code presence_set(ls_dev *d, topic *t, const op_value *value) {
	op_value *c = NULL;
	CborOut m;
	if (value == NULL) {
		if (t->row == NULL) return LS_OK;
		m = out_of(8);
		cborPutHead(&m, 5, 1);
		key(&m, "gone"), cborPutBoolean(&m, true);
	} else {
		c = copy(value, 0);
		if (c == NULL) return LS_BAD;
		m = out_of(256);
		cborPutHead(&m, 5, 2);
		key(&m, "ttl"), cborPutInteger(&m, LS_TTL_MS);
		key(&m, "value");
		if (!pk_put(&m, c)) return free(m.data), op_free(c), LS_BAD;
	}
	if (m.length > message_max(d)) return free(m.data), op_free(c), LS_BAD;
	// sealed and framed once, sent as it is at each renew (its bytes the same: the ttl is the same)
	ls_framed_drop(t->row);
	t->row = say_frame(d, t->name, NULL, m.data, m.length, &t->row_length);
	free(m.data);
	if (c == NULL) {
		// gone, told once: then no row of mine
		row_drop(d, t, row_of(d, t, d->key, LS_KEY_LEN, false));
		send_row(d, t, NULL);
		ls_framed_drop(t->row);
		t->row = NULL;
		return LS_OK;
	}
	ls_row *r = row_of(d, t, d->key, LS_KEY_LEN, true);
	op_free(r->value);
	r->value = c;
	r->own = 1;
	r->until = d->now + LS_TTL_MS;
	rows_changed(d, t);
	if (d->now - t->row_sent >= 50) send_row(d, t, NULL);
	else t->row_dirty = true;
	return LS_OK;
}

void ls_unlisten(ls_dev *d, const char *name) {
	topic *t = topic_find(d, name);
	if (t == NULL) return;
	presence_set(d, t, NULL);
	if (t->n_rows) rows_changed(d, t);
	for (size_t i = 0; i < d->n_topics; i++)
		if (d->topics[i] == t) {
			d->topics[i] = d->topics[--d->n_topics];
			break;
		}
	topic_free(t);
	d->wants_changed = true;
}

ls_code ls_presence_on(ls_dev *d, const char *name, const op_value *value) {
	if (!topic_ok(name)) return LS_BAD;
	topic *t = topic_make(d, name);
	if (!t->room) t->room = true, d->wants_changed = true;
	return presence_set(d, t, value);
}
size_t ls_rows_on(const ls_dev *d, const char *name) {
	const topic *t = topic_find(d, name);
	return t != NULL && t->room ? t->n_rows : 0;
}
const ls_row *ls_row_on(const ls_dev *d, const char *name, size_t at) {
	const topic *t = topic_find(d, name);
	return t != NULL && t->room && at < t->n_rows ? &t->rows[at] : NULL;
}
ls_code ls_presence(ls_node *n, const op_value *value) { return ls_presence_on(n->dev, n->id, value); }
size_t ls_rows(const ls_node *n) { return ls_rows_on(n->dev, n->id); }
const ls_row *ls_row_at(const ls_node *n, size_t at) { return ls_row_on(n->dev, n->id, at); }

// a row heard on a room (presence.ts's message): {ttl, value} who's row, {gone} none; a numbered patch
// ({patches, n}) is not taken (the next renew is whole)
static void take_row(ls_dev *d, topic *t, const Json *who, const Json *b) {
	Json *row = cborDecode(b->bytes.data, b->bytes.length, NULL, NULL);
	if (row == NULL || row->type != JSON_OBJECT) {
		jsonFree(row);
		return;
	}
	const Json *gone = field(row, "gone", JSON_BOOLEAN), *ttl = field(row, "ttl", JSON_NUMBER);
	if (gone != NULL && gone->boolean) row_drop(d, t, row_of(d, t, who->bytes.data, who->bytes.length, false));
	else if (jsonGet(row, "patches") == NULL) {
		const Json *v = jsonGet(row, "value");
		op_value *value = v != NULL ? pk_of_json(v) : op_null();
		ls_row *r = value != NULL ? row_of(d, t, who->bytes.data, who->bytes.length, true) : NULL;
		if (r != NULL) {
			op_free(r->value);
			r->value = value;
			// the time left, as a peer said it (an hour at most)
			int32_t ms = ttl == NULL || !(ttl->number > 0) ? 0 : ttl->number < 3600000 ? (int32_t)ttl->number : 3600000;
			r->until = d->now + ms;
			rows_changed(d, t);
		} else op_free(value);
	}
	jsonFree(row);
}

// ---- the wire in

static void to_peer_up(struct ls_link *l) {
	// back from silent: told again what this device wants
	if (!l->up) l->told = 0;
	l->up = true;
	l->heard = l->dev->now;
}

// a link slot's marks cleared: no commit has been sent on it or acked by it
static void forget_slot(ls_dev *d, unsigned slot) {
	uint8_t keep = (uint8_t)~(1u << (slot & 7));
	for (size_t i = 0; i < d->n_nodes; i++)
		for (size_t k = 0; k < d->nodes[i]->n_commits; k++) {
			commit *c = d->nodes[i]->commits[k];
			c->marks[slot >> 3] &= keep;
			c->marks[d->w + (slot >> 3)] &= keep;
		}
	struct ls_link *l = d->links[slot];
	// its peer knows nothing of what this device wants, nor of my rows
	if (l != NULL) l->round = INT64_MIN / 2, l->told = 0, l->announce = true;
}

static void on_hello(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	const Json *key = field(m, "key", JSON_BYTES), *stack = field(m, "stack", JSON_STRING);
	if (key == NULL || key->bytes.length != LS_KEY_LEN || stack == NULL || strncmp(stack->string, "littlesync/", 11) != 0) return;
	memcpy(l->peer, key->bytes.data, LS_KEY_LEN);
	l->has_peer = true;
	const Json *re = jsonGet(m, "re");
	bool is_re = re != NULL && re->type == JSON_BOOLEAN && re->boolean, was = l->up;
	say(d, "rx hello%s", is_re ? " re" : "");
	to_peer_up(l);
	if (is_re && was) return;
	// a peer that has begun again knows nothing of ours
	forget_slot(d, l->slot);
	send_hello(l, !is_re);
	for (size_t i = 0; i < d->n_nodes; i++) send_heads(d->nodes[i], l, false);
	// what this device wants, at the next tick; my rows once it says what it wants (presence's announce)
}

static bool in_list(const Json *list, const uint8_t name[CM_NAME]) {
	for (int i = 0; i < list->array.count; i++)
		if (is_name(list->array.items[i]) && memcmp(list->array.items[i]->bytes.data, name, CM_NAME) == 0) return true;
	return false;
}

static void on_heads(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	ls_node *n = by_doc(d, jsonGet(m, "node"));
	const Json *heads = field(m, "heads", JSON_ARRAY), *re = jsonGet(m, "re");
	if (n == NULL || heads == NULL) return;
	say(d, "rx heads %.8s %d", short_id(n), heads->array.count);
	uint8_t(*lack)[CM_NAME] = allocate((size_t)heads->array.count * CM_NAME + CM_NAME);
	size_t lacking = 0;
	for (int i = 0; i < heads->array.count; i++) {
		const Json *h = heads->array.items[i];
		if (!is_name(h)) continue;
		commit *c = commit_find(n, h->bytes.data);
		if (c != NULL) ack(c, l->slot);
		else if (!seen(n, h->bytes.data)) memcpy(lack[lacking++], h->bytes.data, CM_NAME);
	}
	if (lacking) send_names(n, l, "want", (const uint8_t(*)[CM_NAME])lack, lacking);
	free(lack);
	if (re != NULL && re->type == JSON_BOOLEAN && re->boolean) return;
	// the sender lacks some of ours: ours, once
	for (size_t i = 0; i < n->n_commits; i++)
		if (!n->commits[i]->passing && !in_list(heads, n->commits[i]->name)) {
			send_heads(n, l, true);
			return;
		}
}

static void on_want(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	ls_node *n = by_doc(d, jsonGet(m, "node"));
	const Json *names = field(m, "names", JSON_ARRAY);
	if (n == NULL || names == NULL) return;
	say(d, "rx want %.8s %d", short_id(n), names->array.count);
	commit **list = allocate(((size_t)names->array.count + 1) * sizeof *list);
	size_t k = 0;
	for (int i = 0; i < names->array.count; i++)
		if (is_name(names->array.items[i])) {
			commit *c = commit_find(n, names->array.items[i]->bytes.data);
			if (c != NULL) list[k++] = c;
		}
	if (k) send_commits(n, l, list, k);
	free(list);
}

static void on_commits(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	ls_node *n = by_doc(d, jsonGet(m, "node"));
	const Json *sealed = field(m, "sealed", JSON_ARRAY);
	if (n == NULL || sealed == NULL) return;
	say(d, "rx commits %.8s %d", short_id(n), sealed->array.count);
	uint8_t(*took)[CM_NAME] = allocate((size_t)sealed->array.count * CM_NAME + CM_NAME);
	size_t k = 0;
	bool news = false;
	parents_seen ps = {0};
	for (int i = 0; i < sealed->array.count; i++) {
		const Json *s = sealed->array.items[i];
		uint8_t name[CM_NAME];
		if (s->type != JSON_BYTES || !peek_name(s->bytes.data, s->bytes.length, name)) {
			l->traffic.junk++;
			continue;
		}
		d->stats.commits_in++;
		if (seen(n, name)) {
			commit *c = commit_find(n, name);
			if (c != NULL) ack(c, l->slot);
			memcpy(took[k++], name, CM_NAME);
			continue;
		}
		opened o;
		int r = open_seal(d, s->bytes.data, s->bytes.length, n->doc, true, &o);
		if (r != 2) {
			d->stats.bad_seals++;
			say(d, "rx bad seal %.8s", short_id(n));
			continue;
		}
		memcpy(took[k++], name, CM_NAME);
		const char *why = refusal(&o.c);
		if (why != NULL) {
			d->stats.refused++;
			d->reason = why;
			ring_add(n, name);
			say(d, "rx refused: %s", why);
		} else {
			held_landed(n, o.c.signer, o.c.signer_length, o.c.lamport);
			commit *c = take_commit(n, name, s->bytes.data, s->bytes.length, &o.c, false, (int)l->slot);
			parents_add(&ps, &o.c);
			d->stats.applied++;
			if (c != NULL) ack(c, l->slot);
			news = true;
		}
		cm_free(&o.c);
	}
	parents_mark(n, &ps);
	if (k) send_names(n, l, "ack", (const uint8_t(*)[CM_NAME])took, k);
	free(took);
	// a relay: the other peers are told what the node is now (at the next tick), and want what they lack
	// (never this link)
	if (news) {
		n->news_from = n->news && n->news_from != (int)l->slot ? -1 : (int)l->slot;
		n->news = true;
	}
}

static void on_ack(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	ls_node *n = by_doc(d, jsonGet(m, "node"));
	const Json *names = field(m, "names", JSON_ARRAY);
	if (n == NULL || names == NULL) return;
	say(d, "rx ack %.8s %d", short_id(n), names->array.count);
	for (int i = 0; i < names->array.count; i++)
		if (is_name(names->array.items[i])) {
			commit *c = commit_find(n, names->array.items[i]->bytes.data);
			if (c != NULL) ack(c, l->slot);
		}
}

static void on_ephemeral(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	ls_node *n = by_doc(d, jsonGet(m, "node"));
	const Json *b = field(m, "commit", JSON_BYTES);
	if (n == NULL || b == NULL) return;
	cm_commit c;
	if (cm_decode(b->bytes.data, b->bytes.length, &c, NULL) != CM_OK) return;
	if (c.patches_length == 1 && c.patches[0].place.length == 0 && c.patches[0].has_value &&
		c.patches[0].value != NULL && c.signer_length == LS_KEY_LEN && memcmp(c.signer, d->key, LS_KEY_LEN) != 0) {
		ls_held *h = held_of(n, c.signer, c.signer_length, true);
		if (h != NULL && c.lamport > h->last) {
			op_value *v = copy(c.patches[0].value, 0);
			if (v != NULL) {
				op_free(h->value);
				h->value = v;
				h->expires = d->now + LS_HELD_MS;
				n->version++;
				// still unsealed, on to the other peers (a ring of links would carry it round for ever)
				if (others_up(d, l)) send_ephemeral(n, l, b->bytes.data, b->bytes.length);
			}
		}
	}
	cm_free(&c);
}

// what the peer wants sent to it: the topics (each once), or all. My rows go to it where it wants them
// now and did not before (all of them when it began again)
static void on_listen(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	const Json *list = field(m, "topics", JSON_ARRAY), *all = field(m, "all", JSON_BOOLEAN);
	if (list == NULL && all == NULL) return;
	char **was = l->wants;
	size_t was_n = l->n_wants;
	bool was_all = l->wants_all;
	l->wants = NULL, l->n_wants = 0;
	l->wants_all = all != NULL && all->boolean;
	for (int i = 0; list != NULL && !l->wants_all && i < list->array.count; i++) {
		const Json *x = list->array.items[i];
		if (x->type != JSON_STRING || !topic_ok(x->string) || wants(l, x->string)) continue;
		if (l->n_wants == WANTS) l->wants_all = true;
		else {
			if (l->n_wants % 16 == 0 && (l->wants = realloc(l->wants, (l->n_wants + 16) * sizeof *l->wants)) == NULL) abort();
			l->wants[l->n_wants++] = text_copy(x->string);
		}
	}
	if (l->wants_all) {
		for (size_t i = 0; i < l->n_wants; i++) free(l->wants[i]);
		l->n_wants = 0;
	}
	say(d, "rx listen %zu%s", l->n_wants, l->wants_all ? " all" : "");
	for (size_t i = 0; i < d->n_topics; i++) {
		topic *t = d->topics[i];
		bool before = was_all;
		for (size_t k = 0; k < was_n && !before; k++) before = strcmp(was[k], t->name) == 0;
		if (t->row != NULL && wants(l, t->name) && (l->announce || !before)) send_row(d, t, l);
	}
	l->announce = false;
	for (size_t k = 0; k < was_n; k++) free(was[k]);
	free(was);
	d->wants_changed = true;
}

// a sealed message: who said it is its signer, checked; unsealed, badly sealed or over the bytes allowed:
// dropped, and not relayed
static void on_say(struct ls_link *l, const Json *m) {
	ls_dev *d = l->dev;
	const Json *name = field(m, "topic", JSON_STRING), *sealed = field(m, "bytes", JSON_BYTES), *who, *b;
	if (name == NULL || !topic_ok(name->string) || sealed == NULL || sealed->bytes.length > message_max(d) + LS_SEALED)
		return;
	Json *x;
	if (!open_said(d, sealed->bytes.data, sealed->bytes.length, name->string, &x, &who, &b) || b->bytes.length > message_max(d) ||
		// mine, come back round: dropped
		memcmp(who->bytes.data, d->key, LS_KEY_LEN) == 0) {
		jsonFree(x);
		return;
	}
	say(d, "rx say %.24s", name->string);
	// on to the other peers that want it, as it came (a ring of links would carry it round for ever)
	if (says(d, l, NULL, name->string)) {
		size_t n;
		ls_framed *f = say_frame(d, name->string, sealed->bytes.data, NULL, sealed->bytes.length, &n);
		send_say(d, l, NULL, name->string, f, n);
		ls_framed_drop(f);
	}
	topic *t = topic_find(d, name->string);
	if (t != NULL && t->room) take_row(d, t, who, b);
	if (t != NULL && t->listen && d->o.heard != NULL)
		d->o.heard(d->o.heard_context, name->string, who->bytes.data, who->bytes.length, b->bytes.data, b->bytes.length);
	jsonFree(x);
}

static void on_message(struct ls_link *l, const uint8_t *bytes, size_t length) {
	Json *m = cborDecode(bytes, length, NULL, NULL);
	const Json *t = m != NULL && m->type == JSON_OBJECT ? field(m, "t", JSON_STRING) : NULL;
	if (t == NULL) {
		l->traffic.junk++;
		jsonFree(m);
		return;
	}
	l->traffic.frames_in++;
	bool hello = strcmp(t->string, "hello") == 0;
	if (!l->up && !hello) {
		// a peer that thinks we are up: it is told we are here, and says hello back
		to_peer_up(l);
		send_hello(l, false);
	}
	l->heard = l->dev->now;
	if (hello) on_hello(l, m);
	else if (strcmp(t->string, "heads") == 0) on_heads(l, m);
	else if (strcmp(t->string, "want") == 0) on_want(l, m);
	else if (strcmp(t->string, "commits") == 0) on_commits(l, m);
	else if (strcmp(t->string, "ack") == 0) on_ack(l, m);
	else if (strcmp(t->string, "ephemeral") == 0) on_ephemeral(l, m);
	else if (strcmp(t->string, "say") == 0) on_say(l, m);
	else if (strcmp(t->string, "listen") == 0) on_listen(l, m);
	jsonFree(m);
}

void ls_feed(struct ls_link *l, const uint8_t *bytes, size_t length) {
	for (size_t i = 0; i < length; i++) {
		uint8_t b = bytes[i];
		if (b != 0) {
			if (l->rx_n < l->dev->frame) l->rx[l->rx_n++] = b;
			else l->rx_over = true;
			continue;
		}
		// a zero ends what came before it (a frame, or text that was no frame) and begins the next
		if (l->rx_n > 0) {
			const uint8_t *message;
			size_t n;
			if (!l->rx_over && ls_unframe(l->rx, l->rx_n, &message, &n)) on_message(l, message, n);
			else l->traffic.junk++;
		}
		l->rx_n = 0;
		l->rx_over = false;
	}
}

size_t ls_next(struct ls_link *l, const uint8_t **out) {
	ls_framed_drop(l->given);
	l->given = NULL;
	*out = NULL;
	if (l->out_n == 0) {
		// room taken up by a big burst is given back
		if (l->out_cap > 64) free(l->out), l->out = NULL, l->out_cap = 0;
		l->out_at = 0;
		return 0;
	}
	ls_framed *f = l->given = l->out[l->out_at++];
	l->out_n--;
	l->queued -= f->length;
	*out = f->bytes;
	return f->length;
}

size_t ls_take(struct ls_link *l, ls_framed **out, size_t max) {
	ls_framed_drop(l->given);
	l->given = NULL;
	size_t n = l->out_n < max ? l->out_n : max;
	for (size_t i = 0; i < n; i++) out[i] = l->out[l->out_at + i], l->queued -= out[i]->length;
	l->out_at += n, l->out_n -= n;
	return n;
}

// ---- time

void ls_tick(ls_dev *d, int64_t now) {
	d->now = now;
	bool any = false;
	for (unsigned i = 0; i < d->n_links; i++) {
		struct ls_link *l = d->links[i];
		if (l == NULL) continue;
		if (l->up && now - l->heard > 8000) {
			l->up = false;
			say(d, "peer silent");
		}
		if (!l->up) {
			if (now - l->hello_sent >= 2000) send_hello(l, false);
		} else if (now - l->hello_sent >= 4000) send_hello(l, true);
		l->beat = l->up && now - l->heads_sent >= 10000;
		if (l->beat) l->heads_sent = now;
		// a round: what the peer lacks is sent again, but what went on the link in the last round
		l->due = l->up && now - l->round >= 1000;
		if (l->due) l->round = now;
		any |= l->up;
		// what this device wants: when it changed, to a peer that began again, and with each heads beat
		if (l->up && (d->wants_changed || l->told == 0 || l->beat)) send_listen(d, l, l->beat);
	}
	d->wants_changed = false;
	for (size_t i = 0; i < d->n_topics; i++) {
		topic *t = d->topics[i];
		for (size_t k = 0; k < t->n_rows;)
			if (!t->rows[k].own && now >= t->rows[k].until) row_drop(d, t, &t->rows[k]);
			else k++;
		if (t->row != NULL && any && (now - t->row_sent >= LS_RENEW_MS || (t->row_dirty && now - t->row_sent >= 50)))
			send_row(d, t, NULL);
	}
	for (size_t i = 0; i < d->n_nodes; i++) {
		ls_node *n = d->nodes[i];
		for (int k = 0; k < HELDS; k++) {
			ls_held *h = &n->helds[k];
			if (h->value != NULL && !h->own && now >= h->expires) {
				op_free(h->value);
				h->value = NULL;
				n->version++;
			}
		}
		for (unsigned s = 0; n->news && s < d->n_links; s++)
			if (d->links[s] != NULL && (int)s != n->news_from && d->links[s]->up) send_heads(n, d->links[s], false);
		n->news = false;
		if (n->hold != NULL && any && (now - n->hold_sent >= LS_BEAT_MS || (n->hold_dirty && now - n->hold_sent >= 50)))
			send_hold(n);
		for (unsigned s = 0; s < d->n_links; s++) {
			struct ls_link *l = d->links[s];
			if (l == NULL || !l->up) continue;
			// own commits this peer has not said it has, and passing ones (resent each round)
			commit **list = NULL;
			size_t k = 0, room = 0;
			for (size_t c = 0; c < n->n_commits && l->due; c++) {
				commit *x = n->commits[c];
				if (!(x->own || x->passing) || acked(x, s)) continue;
				if (sent(d, x, s)) mark_sent(d, x, s, false);
				else {
					if (k == room) {
						room = room ? room * 2 : 8;
						list = realloc(list, room * sizeof *list);
						if (list == NULL) abort();
					}
					list[k++] = x;
				}
			}
			// a round's own sends do not hold back the next round
			if (k) send_commits(n, l, list, k);
			for (size_t i = 0; i < k; i++) mark_sent(d, list[i], s, false);
			free(list);
			if (l->beat) send_heads(n, l, false);
		}
		pass(n);
		if (n->dirty && now - n->saved >= (d->o.save_ms ? d->o.save_ms : 2000)) save_node(n);
	}
}

// ---- links

struct ls_link *ls_link(ls_dev *d) {
	unsigned slot = 0;
	while (slot < d->n_links && d->links[slot] != NULL) slot++;
	if (slot == d->n_links) return NULL;
	struct ls_link *l = allocate(sizeof *l + d->frame);
	l->dev = d;
	l->slot = slot;
	l->hello_sent = INT64_MIN / 2;
	d->links[slot] = l;
	forget_slot(d, slot);
	return l;
}

void ls_unlink(struct ls_link *l) {
	if (l == NULL) return;
	l->dev->links[l->slot] = NULL;
	l->dev->wants_changed = true;
	for (size_t i = 0; i < l->n_wants; i++) free(l->wants[i]);
	free(l->wants);
	for (size_t i = 0; i < l->out_n; i++) ls_framed_drop(l->out[l->out_at + i]);
	ls_framed_drop(l->given);
	free(l->out);
	free(l);
}

// ---- the device

ls_dev *ls_open(const ls_options *o) {
	if (o->store.load == NULL || o->store.save == NULL || o->random == NULL || (o->keep && !LS_SERVER)) return NULL;
	ls_dev *d = allocate(sizeof *d);
	d->o = *o;
	d->n_links = o->links ? o->links : LS_LINKS;
	d->w = (d->n_links + 7) / 8;
	// a say's fields around its bytes and their seal (the topic at most), then COBS, "L", the CRC and the zeros
	size_t frame = message_max(d) + LS_SEALED + LS_TOPIC_MAX + 128;
	frame += frame / 254 + 16;
	d->frame = frame > LS_FRAME_MAX ? frame : LS_FRAME_MAX;
	d->links = allocate(d->n_links * sizeof *d->links);
	d->up = allocate(d->w);
	uint8_t *seed = NULL;
	size_t length = 0;
	if (o->store.load(o->store.context, "key", &seed, &length) && length == 32) memcpy(d->seed, seed, 32);
	else {
		o->random(o->random_context, d->seed, 32);
		if (!o->store.save(o->store.context, "key", d->seed, 32)) {
			free(seed);
			free(d->links), free(d->up), free(d);
			return NULL;
		}
	}
	free(seed);
	uint8_t pub[32];
	ermEd25519Public(d->seed, pub);
	d->key[0] = 0xed, d->key[1] = 0x01;
	memcpy(d->key + 2, pub, 32);
	uint8_t r[4];
	o->random(o->random_context, r, 4);
	d->nonce = (uint32_t)r[0] | (uint32_t)r[1] << 8 | (uint32_t)r[2] << 16 | (uint32_t)r[3] << 24;
	return d;
}

void ls_close(ls_dev *d) {
	if (d == NULL) return;
	for (size_t i = 0; i < d->n_nodes; i++) {
		if (d->nodes[i]->dirty) save_node(d->nodes[i]);
		node_free(d->nodes[i]);
	}
	free(d->nodes);
	for (size_t i = 0; i < d->n_topics; i++) topic_free(d->topics[i]);
	free(d->topics);
	for (unsigned i = 0; i < d->n_links; i++) ls_unlink(d->links[i]);
	free(d->links), free(d->up), free(d);
}

const uint8_t *ls_key(const ls_dev *d) { return d->key; }
const uint8_t *ls_peer(const struct ls_link *l) { return l->has_peer ? l->peer : NULL; }
int ls_up(const struct ls_link *l) { return l->up; }
const ls_traffic *ls_traffic_of(const struct ls_link *l) { return &l->traffic; }
const ls_stats *ls_stats_of(const ls_dev *d) { return &d->stats; }
const char *ls_reason(const ls_dev *d) { return d->reason != NULL ? d->reason : ""; }

