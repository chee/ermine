// littlesync (littlesync.h), in C
#include "littlesync.h"

#include "frame.h"

#include "../../../../ermine/encoding/c/cbor.h"
#include "../../../../ermine/encoding/c/commit.h"
#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/pack.h"
#include "../../../../extensions/together/c/ed25519/ed25519.h"

#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ---- what a device holds

// a commit that makes the value now: its seal, and who has it. Which links have it: a bitmask over link
// slots (LS_LINKS, 4 at most), not a set of names per link. A commit is the one thing that knows it, there
// is nothing to bound or search, and a link's slot is cleared in one pass when it opens or says hello
// again. The same slots keep when each link was last sent it, so a resend on one link is not held back
// by a send on another.
typedef struct {
	uint8_t name[CM_NAME];
	uint8_t *sealed;
	size_t length;
	int64_t lamport;
	uint32_t refs; // stamps that name it
	bool own;
	bool named; // a commit taken in names it as a parent: no head
	uint8_t acked;          // bit i: the peer on link slot i has it
	int64_t sent[LS_LINKS]; // ms of the last send on each link slot, for resends
} commit;

// the last write at a path: the path as its keys each followed by a 0
typedef struct {
	char *path;
	size_t bytes, depth;
	int64_t lamport;
	commit *by;
	bool gone; // a delete: no value there, the stamp stays
} stamp;

#define HELDS 8
#define RING 8
#define NAMED 8
#define OUT_MAX 16384
#define CHUNK 3000
#define DEPTH 16

struct ls_node {
	ls_dev *dev;
	char id[LS_ID_LEN + 1];
	uint8_t doc[32];
	op_value *value;
	stamp *stamps;
	size_t n_stamps, c_stamps;
	commit **commits;
	size_t n_commits, c_commits;
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
	bool dirty;
	int64_t saved;
};

// one byte stream to one peer: what is said on it, and what is known of the peer on it
struct ls_link {
	ls_dev *dev;
	unsigned slot;
	uint8_t *out;
	size_t out_used, out_cap;
	uint8_t rx[LS_FRAME_MAX];
	size_t rx_n;
	bool rx_over;
	bool up;
	int64_t heard, hello_sent, heads_sent;
	uint8_t peer[LS_KEY_LEN];
	bool has_peer;
	ls_traffic traffic;
};

struct ls_dev {
	ls_options o;
	uint8_t seed[32];
	uint8_t key[LS_KEY_LEN];
	int64_t now;
	uint32_t nonce;
	ls_node **nodes;
	size_t n_nodes;
	struct ls_link *links[LS_LINKS];
	// public keys decoded once
	ermEd25519Key keys[4];
	unsigned keys_next;
	ls_stats stats;
	const char *reason;
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

static uint8_t *encode(const Json *j, size_t *length) {
	size_t n = 0;
	if (!cborEncode(j, NULL, 0, &n, NULL)) return NULL;
	uint8_t *b = allocate(n ? n : 1);
	cborEncode(j, b, n, &n, NULL);
	*length = n;
	return b;
}

// the sealed commit (seal.h's bytes), malloc'd
static uint8_t *seal(ls_dev *d, const uint8_t *commit_bytes, size_t length, const uint8_t doc[32], size_t *out) {
	uint8_t name[CM_NAME], m[SIGNED], signature[72];
	cm_name(commit_bytes, length, name);
	signed_message(doc, name, m);
	memcpy(signature, HEADER, 8);
	ermEd25519Sign(d->seed, m, SIGNED, signature + 8);
	Json *s = jsonObject();
	jsonAdd(s, "commit", jsonBytes(commit_bytes, length));
	jsonAdd(s, "signature", jsonBytes(signature, 72));
	uint8_t *bytes = encode(s, out);
	jsonFree(s);
	return bytes;
}

typedef struct {
	cm_commit c;
	uint8_t name[CM_NAME];
} opened;

// a seal's commit name and nothing else (no check)
static bool peek_name(const uint8_t *sealed, size_t length, uint8_t name[CM_NAME]) {
	Json *x = cborDecode(sealed, length, NULL, NULL);
	const Json *c = x != NULL && x->type == JSON_OBJECT ? jsonGet(x, "commit") : NULL;
	bool ok = c != NULL && c->type == JSON_BYTES;
	if (ok) cm_name(c->bytes.data, c->bytes.length, name);
	jsonFree(x);
	return ok;
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
			ermEd25519Key *k = NULL;
			for (unsigned i = 0; i < 4 && k == NULL; i++)
				if (d->keys[i].good && memcmp(d->keys[i].pub, key + 2, 32) == 0) k = &d->keys[i];
			if (k == NULL) {
				k = &d->keys[d->keys_next++ % 4];
				if (!ermEd25519KeyOf(k, key + 2)) result = 1;
			}
			uint8_t m[SIGNED];
			signed_message(doc, o->name, m);
			if (result == 2 && !ermEd25519VerifyKey(k, m, SIGNED, s->bytes.data + 8)) result = 1;
		}
	}
	jsonFree(x);
	if (result != 2) cm_free(&o->c);
	return result;
}

// ---- the wire out

static void send_message(struct ls_link *l, Json *m) {
	size_t n;
	uint8_t *b = encode(m, &n);
	jsonFree(m);
	if (b == NULL) return;
	if (l->out_used + n * 2 + 16 > OUT_MAX) {
		l->traffic.dropped_out++;
		free(b);
		return;
	}
	ls_frame(b, n, &l->out, &l->out_used, &l->out_cap);
	l->traffic.frames_out++;
	free(b);
}

// the links that are up, but not `except` (NULL: all): what is sent to every peer but the one it came from
static bool others_up(const ls_dev *d, const struct ls_link *except) {
	for (unsigned i = 0; i < LS_LINKS; i++)
		if (d->links[i] != NULL && d->links[i] != except && d->links[i]->up) return true;
	return false;
}

static Json *message(const char *t) {
	Json *m = jsonObject();
	jsonAdd(m, "t", jsonString(t));
	return m;
}

static void send_hello(struct ls_link *l, bool re) {
	ls_dev *d = l->dev;
	Json *m = message("hello");
	jsonAdd(m, "key", jsonBytes(d->key, LS_KEY_LEN));
	jsonAdd(m, "stack", jsonString(LS_STACK));
	if (re) jsonAdd(m, "re", jsonBoolean(true));
	l->hello_sent = d->now;
	say(d, "tx hello%s", re ? " re" : "");
	send_message(l, m);
}

static void send_heads(ls_node *n, struct ls_link *l, bool re) {
	ls_dev *d = n->dev;
	Json *m = message("heads"), *list = jsonArray();
	jsonAdd(m, "node", jsonBytes(n->doc, 32));
	// the highest lamports, when there are too many
	size_t count = n->n_commits < LS_MAX_HEADS ? n->n_commits : LS_MAX_HEADS;
	int64_t floor_ = 0;
	if (n->n_commits > LS_MAX_HEADS) {
		int64_t *l = allocate(n->n_commits * sizeof *l);
		for (size_t i = 0; i < n->n_commits; i++) l[i] = n->commits[i]->lamport;
		for (size_t i = 1; i < n->n_commits; i++) {
			int64_t v = l[i];
			size_t k = i;
			for (; k > 0 && l[k - 1] < v; k--) l[k] = l[k - 1];
			l[k] = v;
		}
		floor_ = l[LS_MAX_HEADS - 1];
		free(l);
	}
	size_t put = 0;
	for (size_t i = 0; i < n->n_commits && put < count; i++)
		if (n->commits[i]->lamport >= floor_) jsonPush(list, jsonBytes(n->commits[i]->name, CM_NAME)), put++;
	jsonAdd(m, "heads", list);
	if (re) jsonAdd(m, "re", jsonBoolean(true));
	say(d, "tx heads %.8s %zu%s", short_id(n), put, re ? " re" : "");
	send_message(l, m);
}

static void send_names(ls_node *n, struct ls_link *l, const char *t, const uint8_t (*names)[CM_NAME], size_t count) {
	for (size_t at = 0; at < count; at += LS_MAX_HEADS) {
		Json *m = message(t), *list = jsonArray();
		jsonAdd(m, "node", jsonBytes(n->doc, 32));
		for (size_t i = at; i < count && i < at + LS_MAX_HEADS; i++) jsonPush(list, jsonBytes(names[i], CM_NAME));
		jsonAdd(m, "names", list);
		say(n->dev, "tx %s %.8s %zu", t, short_id(n), count - at < LS_MAX_HEADS ? count - at : (size_t)LS_MAX_HEADS);
		send_message(l, m);
	}
}

// the seals of the commits, in messages of about CHUNK bytes
static void send_commits(ls_node *n, struct ls_link *l, commit *const *list, size_t count) {
	size_t at = 0;
	while (at < count) {
		Json *m = message("commits"), *seals = jsonArray();
		jsonAdd(m, "node", jsonBytes(n->doc, 32));
		size_t size = 0, k = 0;
		while (at < count && (k == 0 || size + list[at]->length <= CHUNK)) {
			jsonPush(seals, jsonBytes(list[at]->sealed, list[at]->length));
			size += list[at]->length + 4;
			list[at]->sent[l->slot] = n->dev->now;
			at++, k++;
		}
		jsonAdd(m, "sealed", seals);
		say(n->dev, "tx commits %.8s %zu", short_id(n), k);
		send_message(l, m);
	}
}

// ---- values

// a copy nobody else holds; NULL when it is deeper than DEPTH
static op_value *copy(const op_value *v, int depth) {
	if (v == NULL) return NULL;
	if (depth > DEPTH && (v->type == OP_MAP || v->type == OP_LIST || v->type == OP_STAND)) return NULL;
	switch (v->type) {
	case OP_NULL: return op_null();
	case OP_BOOL: return op_bool(v->bool_);
	case OP_NUM: return op_num(v->num);
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

// the value at a path (keys each ending in 0), NULL when there is none
static op_value *get_at(op_value *root, const char *path, size_t depth) {
	op_value *at = root;
	for (size_t i = 0; i < depth && at != NULL; i++) {
		at = at->type == OP_MAP ? op_get(at, path) : NULL;
		path += strlen(path) + 1;
	}
	return at;
}
// the value (taken) put at a path, made of maps on the way; a thing that is not a map is replaced
static void put_at(op_value **root, const char *path, size_t depth, op_value *v) {
	if (depth == 0) {
		op_free(*root);
		*root = v;
		return;
	}
	if (*root == NULL || (*root)->type != OP_MAP) {
		op_free(*root);
		*root = op_map();
	}
	op_value *at = *root;
	for (size_t i = 0; i + 1 < depth; i++) {
		op_value *child = op_get(at, path);
		if (child == NULL || child->type != OP_MAP) {
			child = op_map();
			op_set(at, path, child);
		}
		at = child;
		path += strlen(path) + 1;
	}
	op_set(at, path, v);
}
static void del_at(op_value **root, const char *path, size_t depth) {
	if (depth == 0) {
		op_free(*root);
		*root = NULL;
		return;
	}
	op_value *at = *root;
	for (size_t i = 0; i + 1 < depth && at != NULL; i++) {
		at = at->type == OP_MAP ? op_get(at, path) : NULL;
		path += strlen(path) + 1;
	}
	if (at == NULL || at->type != OP_MAP) return;
	long k = op_find(at, path);
	if (k < 0) return;
	op_free(at->items[k]);
	op_unset(at, (size_t)k);
}

// ---- stamps and commits

static int stamp_cmp(int64_t la, const uint8_t *na, int64_t lb, const uint8_t *nb) {
	if (la != lb) return la < lb ? -1 : 1;
	return memcmp(na, nb, CM_NAME);
}

static void ring_add(ls_node *n, const uint8_t name[CM_NAME]) {
	memcpy(n->ring[n->ring_at], name, CM_NAME);
	n->ring_at = (n->ring_at + 1) % RING;
	if (n->ring_n < RING) n->ring_n++;
}

static commit *commit_find(const ls_node *n, const uint8_t name[CM_NAME]) {
	for (size_t i = 0; i < n->n_commits; i++)
		if (memcmp(n->commits[i]->name, name, CM_NAME) == 0) return n->commits[i];
	return NULL;
}
static bool seen(const ls_node *n, const uint8_t name[CM_NAME]) {
	if (commit_find(n, name) != NULL) return true;
	for (unsigned i = 0; i < n->ring_n; i++)
		if (memcmp(n->ring[i], name, CM_NAME) == 0) return true;
	return false;
}

static void commit_free(commit *c) {
	free(c->sealed);
	free(c);
}
// a stamp let go of: its commit goes when no stamp names it
static void unref(ls_node *n, commit *c) {
	if (--c->refs != 0) return;
	for (size_t i = 0; i < n->n_commits; i++)
		if (n->commits[i] == c) {
			n->commits[i] = n->commits[--n->n_commits];
			ring_add(n, c->name);
			commit_free(c);
			return;
		}
}

static void add_stamp(ls_node *n, stamp s) {
	if (n->n_stamps == n->c_stamps) {
		n->c_stamps = n->c_stamps ? n->c_stamps * 2 : 4;
		n->stamps = realloc(n->stamps, n->c_stamps * sizeof *n->stamps);
		if (n->stamps == NULL) abort();
	}
	n->stamps[n->n_stamps++] = s;
	s.by->refs++;
}

// one patch of a commit at the path: false when a stamp there or above beats it
static bool apply_patch(ls_node *n, const char *path, size_t bytes, size_t depth, const op_value *value, bool has_value,
	int64_t lamport, commit *by) {
	for (size_t i = 0; i < n->n_stamps; i++) {
		const stamp *s = &n->stamps[i];
		if (s->bytes <= bytes && memcmp(s->path, path, s->bytes) == 0 &&
			stamp_cmp(s->lamport, s->by->name, lamport, by->name) > 0)
			return false;
	}
	// what is below, and newer, stays (its value put back on top); the rest, and this path's, goes
	stamp *kept = NULL;
	op_value **kept_values = NULL;
	size_t n_kept = 0, w = 0;
	for (size_t i = 0; i < n->n_stamps; i++) {
		stamp s = n->stamps[i];
		bool below = s.bytes >= bytes && memcmp(s.path, path, bytes) == 0;
		if (!below) {
			n->stamps[w++] = s;
			continue;
		}
		if (s.bytes > bytes && stamp_cmp(s.lamport, s.by->name, lamport, by->name) > 0) {
			kept = realloc(kept, (n_kept + 1) * sizeof *kept);
			kept_values = realloc(kept_values, (n_kept + 1) * sizeof *kept_values);
			if (kept == NULL || kept_values == NULL) abort();
			kept[n_kept] = s;
			kept_values[n_kept] = s.gone ? NULL : op_ref(get_at(n->value, s.path, s.depth));
			n_kept++;
			continue;
		}
		free(s.path);
		unref(n, s.by);
	}
	n->n_stamps = w;
	if (has_value) {
		op_value *v = copy(value, 0);
		put_at(&n->value, path, depth, v != NULL ? v : op_null());
	} else del_at(&n->value, path, depth);
	// shallow ones first: a delete there would take a deeper one's place with it
	for (size_t i = 1; i < n_kept; i++) {
		stamp s = kept[i];
		op_value *v = kept_values[i];
		size_t k = i;
		for (; k > 0 && kept[k - 1].depth > s.depth; k--) kept[k] = kept[k - 1], kept_values[k] = kept_values[k - 1];
		kept[k] = s, kept_values[k] = v;
	}
	for (size_t i = 0; i < n_kept; i++) {
		if (kept[i].gone) del_at(&n->value, kept[i].path, kept[i].depth);
		else put_at(&n->value, kept[i].path, kept[i].depth, kept_values[i]);
		n->stamps[n->n_stamps++] = kept[i];
	}
	free(kept);
	free(kept_values);
	stamp mine = {malloc(bytes ? bytes : 1), bytes, depth, lamport, by, !has_value};
	if (mine.path == NULL) abort();
	memcpy(mine.path, path, bytes);
	add_stamp(n, mine);
	return true;
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

// a commit made or received (its patches decoded, sealed bytes the seal's): applied when any patch
// wins. Kept while a stamp names it. NULL when nothing of it stays
static commit *take_commit(ls_node *n, const uint8_t name[CM_NAME], const uint8_t *sealed, size_t length, const cm_commit *c,
	bool own) {
	commit *k = allocate(sizeof *k);
	memcpy(k->name, name, CM_NAME);
	k->lamport = c->lamport;
	k->own = own;
	for (unsigned i = 0; i < LS_LINKS; i++) k->sent[i] = INT64_MIN / 2;
	k->refs = 1; // while it is being applied
	bool any = false;
	for (size_t i = 0; i < c->patches_length; i++) {
		const op_patch *p = &c->patches[i];
		size_t bytes = 0;
		for (size_t j = 0; j < p->place.length; j++) bytes += strlen(p->place.path[j].s) + 1;
		char *path = malloc(bytes ? bytes : 1), *at = path;
		if (path == NULL) abort();
		for (size_t j = 0; j < p->place.length; j++) {
			size_t m = strlen(p->place.path[j].s) + 1;
			memcpy(at, p->place.path[j].s, m);
			at += m;
		}
		if (apply_patch(n, path, bytes, p->place.length, p->value, p->has_value, c->lamport, k)) any = true;
		free(path);
	}
	name_parents(n, c);
	if (any) {
		n->version++;
		n->dirty = true;
	}
	if (--k->refs == 0) {
		ring_add(n, name);
		free(k);
		return NULL;
	}
	// the highest commit taken holds a stamp for good (nothing beats it): the highest seen is a held
	// one, and a head, so a write's lamport is 1 + its parents' highest (one with no patches, held by
	// nothing, does not count)
	if (c->lamport > n->lamport) n->lamport = c->lamport;
	k->named = named_before(n, name);
	k->sealed = allocate(length);
	memcpy(k->sealed, sealed, length);
	k->length = length;
	if (n->n_commits == n->c_commits) {
		n->c_commits = n->c_commits ? n->c_commits * 2 : 4;
		n->commits = realloc(n->commits, n->c_commits * sizeof *n->commits);
		if (n->commits == NULL) abort();
	}
	n->commits[n->n_commits++] = k;
	return k;
}

// ---- nodes

static void blob_name(const ls_node *n, char *out) { snprintf(out, 16 + LS_ID_LEN, "node:%s", n->id); }

// what the store keeps for a node: {lamport, commits: [seal]}, malloc'd
static uint8_t *node_blob(const ls_node *n, size_t *len) {
	Json *m = jsonObject(), *list = jsonArray();
	jsonAdd(m, "lamport", jsonNumber((double)n->lamport));
	for (size_t i = 0; i < n->n_commits; i++) jsonPush(list, jsonBytes(n->commits[i]->sealed, n->commits[i]->length));
	jsonAdd(m, "commits", list);
	uint8_t *b = encode(m, len);
	jsonFree(m);
	return b;
}

static void save_node(ls_node *n) {
	ls_dev *d = n->dev;
	n->dirty = false;
	n->saved = d->now;
	size_t len;
	uint8_t *b = node_blob(n, &len);
	char name[16 + LS_ID_LEN];
	blob_name(n, name);
	if (b != NULL) d->o.store.save(d->o.store.context, name, b, len);
	free(b);
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
	const Json *list = m != NULL ? jsonGet(m, "commits") : NULL;
	parents_seen ps = {0};
	if (list != NULL && list->type == JSON_ARRAY)
		for (int i = 0; i < list->array.count; i++) {
			const Json *s = list->array.items[i];
			opened o;
			// our own store: not checked again
			if (s->type != JSON_BYTES || open_seal(d, s->bytes.data, s->bytes.length, n->doc, false, &o) != 2) continue;
			if (!seen(n, o.name) && refusal(&o.c) == NULL) {
				take_commit(n, o.name, s->bytes.data, s->bytes.length, &o.c, memcmp(o.c.signer, d->key, LS_KEY_LEN) == 0);
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
	for (unsigned i = 0; i < LS_LINKS; i++)
		if (d->links[i] != NULL && d->links[i]->up) send_heads(n, d->links[i], false);
	return n;
}

const char *ls_id(const ls_node *n) { return n->id; }
const op_value *ls_value(const ls_node *n) { return n->value; }
uint32_t ls_version(const ls_node *n) { return n->version; }
size_t ls_commits(const ls_node *n) { return n->n_commits; }
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
	c.commits = n->n_commits;
	const commit *top = NULL;
	for (size_t i = 0; i < n->n_commits; i++) {
		c.seals += n->commits[i]->length;
		if (top == NULL || stamp_cmp(n->commits[i]->lamport, n->commits[i]->name, top->lamport, top->name) > 0) top = n->commits[i];
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
	for (size_t i = 0; i < n->n_stamps; i++) free(n->stamps[i].path);
	free(n->stamps);
	for (size_t i = 0; i < n->n_commits; i++) commit_free(n->commits[i]);
	free(n->commits);
	for (int i = 0; i < HELDS; i++) op_free(n->helds[i].value);
	free(n->hold);
	free(n);
}

// ---- writing

// a write's parents: the held commits no commit taken in names (the heads, as far as this device can
// tell), the highest lamports first when there are more than LS_MAX_PARENTS; the highest held always
// (a write's lamport is 1 + its). In name order
static void heads_parents(const ls_node *n, const uint8_t (**out)[CM_NAME], size_t *count) {
	const commit **all = allocate((n->n_commits + 1) * sizeof *all);
	const commit *top = NULL;
	for (size_t i = 0; i < n->n_commits; i++)
		if (top == NULL || stamp_cmp(n->commits[i]->lamport, n->commits[i]->name, top->lamport, top->name) > 0) top = n->commits[i];
	size_t m = 0;
	if (top != NULL) all[m++] = top;
	for (size_t i = 0; i < n->n_commits; i++) {
		const commit *c = n->commits[i];
		if (c->named || c == top) continue;
		size_t k = m++;
		for (; k > 1 && stamp_cmp(all[k - 1]->lamport, all[k - 1]->name, c->lamport, c->name) < 0; k--) all[k] = all[k - 1];
		all[k] = c;
	}
	if (m > LS_MAX_PARENTS) m = LS_MAX_PARENTS;
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

static Json *commit_json(ls_dev *d, ls_node *n, Json *patches, bool stored) {
	Json *j = jsonObject();
	jsonAdd(j, "table", jsonString("value"));
	jsonAdd(j, "actor", jsonNull());
	jsonAdd(j, "time", jsonNumber((double)(d->o.epoch_ms + d->now)));
	jsonAdd(j, "signer", jsonBytes(d->key, LS_KEY_LEN));
	d->nonce = d->nonce * 1664525u + 1013904223u;
	jsonAdd(j, "nonce", jsonNumber((double)d->nonce));
	Json *parents = jsonArray();
	size_t count = 0;
	if (stored) {
		const uint8_t(*p)[CM_NAME];
		heads_parents(n, &p, &count);
		for (size_t i = 0; i < count; i++) jsonPush(parents, jsonBytes(p[i], CM_NAME));
		free((void *)p);
	}
	jsonAdd(j, "parents", parents);
	// commit.h: with several parents and no base, a merge rule's name; the rule is ours
	if (count >= 2) jsonAdd(j, "merge", jsonString(LS_MERGE));
	jsonAdd(j, "lamport", jsonNumber((double)(n->lamport + 1)));
	jsonAdd(j, "patches", patches);
	return j;
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

ls_code ls_write(ls_node *n, const ls_patch *patches, size_t count) {
	ls_dev *d = n->dev;
	if (count == 0) return LS_BAD;
	Json *list = jsonArray();
	for (size_t i = 0; i < count; i++) {
		const ls_patch *p = &patches[i];
		Json *o = jsonObject(), *path = jsonArray();
		jsonPush(list, o);
		for (size_t k = 0; k < p->length; k++) {
			if (p->path[k] == NULL) return jsonFree(list), LS_BAD;
			jsonPush(path, jsonString(p->path[k]));
		}
		jsonAdd(o, "path", path);
		if (p->value != NULL) {
			op_value *c = copy(p->value, 0);
			Json *v = c != NULL ? pk_to_json(c) : NULL;
			op_free(c);
			if (v == NULL) return jsonFree(list), LS_BAD;
			jsonAdd(o, "value", v);
		}
	}
	Json *j = commit_json(d, n, list, true);
	uint8_t *bytes;
	size_t length;
	if (cm_encode_json(j, &bytes, &length, NULL) != CM_OK) return jsonFree(j), LS_BAD;
	jsonFree(j);
	size_t slength;
	uint8_t *sealed = seal(d, bytes, length, n->doc, &slength);
	cm_commit c;
	uint8_t name[CM_NAME];
	cm_name(bytes, length, name);
	if (sealed == NULL || cm_decode(bytes, length, &c, NULL) != CM_OK) return free(bytes), free(sealed), LS_BAD;
	free(bytes);
	if (refusal(&c) != NULL) return free(sealed), cm_free(&c), LS_BAD;
	// a seal that can't go in one message would be sent, dropped by the peer and sent again forever
	if (slength > CHUNK) return free(sealed), cm_free(&c), LS_BAD;
	// a write is this device's next stored commit: what it held goes
	drop_hold(n);
	held_landed(n, d->key, LS_KEY_LEN, c.lamport);
	commit *k = take_commit(n, name, sealed, slength, &c, true);
	cm_free(&c);
	free(sealed);
	n->version++;
	if (k != NULL)
		for (unsigned i = 0; i < LS_LINKS; i++)
			if (d->links[i] != NULL && d->links[i]->up) send_commits(n, d->links[i], &k, 1);
	return LS_OK;
}

ls_code ls_put(ls_node *n, const op_value *value) {
	ls_patch p = {NULL, 0, value};
	return ls_write(n, &p, 1);
}
ls_code ls_set(ls_node *n, const char *key, const op_value *value) {
	const char *path[1] = {key};
	ls_patch p = {path, 1, value};
	return ls_write(n, &p, 1);
}
ls_code ls_del(ls_node *n, const char *key) { return ls_set(n, key, NULL); }

// ---- held values

// an unsealed commit to every link that is up but `except`: the device's own hold goes to all, one taken in
// from a link goes on to the others
static void send_ephemeral(ls_node *n, const struct ls_link *except, const uint8_t *bytes, size_t length) {
	ls_dev *d = n->dev;
	for (unsigned i = 0; i < LS_LINKS; i++) {
		struct ls_link *l = d->links[i];
		if (l == NULL || l == except || !l->up) continue;
		Json *m = message("ephemeral");
		jsonAdd(m, "node", jsonBytes(n->doc, 32));
		jsonAdd(m, "commit", jsonBytes(bytes, length));
		say(d, "tx ephemeral %.8s", short_id(n));
		send_message(l, m);
	}
}

static void send_hold(ls_node *n) {
	n->hold_sent = n->dev->now;
	n->hold_dirty = false;
	if (n->hold != NULL) send_ephemeral(n, NULL, n->hold, n->hold_length);
}

ls_code ls_hold(ls_node *n, const op_value *value) {
	ls_dev *d = n->dev;
	op_value *c = copy(value, 0);
	Json *v = c != NULL ? pk_to_json(c) : NULL;
	if (v == NULL) return op_free(c), LS_BAD;
	Json *patches = jsonArray(), *p = jsonObject();
	jsonAdd(p, "path", jsonArray());
	jsonAdd(p, "value", v);
	jsonPush(patches, p);
	Json *j = commit_json(d, n, patches, false);
	uint8_t *bytes;
	size_t length;
	cm_code code = cm_encode_json(j, &bytes, &length, NULL);
	jsonFree(j);
	if (code != CM_OK) return op_free(c), LS_BAD;
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

// ---- the wire in

static const Json *field(const Json *m, const char *key, JsonType type) {
	const Json *v = jsonGet(m, key);
	return v != NULL && v->type == type ? v : NULL;
}
static bool is_name(const Json *b) { return b != NULL && b->type == JSON_BYTES && b->bytes.length == CM_NAME; }

static void to_peer_up(struct ls_link *l) {
	l->up = true;
	l->heard = l->dev->now;
}

// a link slot's marks cleared: no commit has been sent on it or acked by it
static void forget_slot(ls_dev *d, unsigned slot) {
	for (size_t i = 0; i < d->n_nodes; i++)
		for (size_t k = 0; k < d->nodes[i]->n_commits; k++) {
			d->nodes[i]->commits[k]->acked &= (uint8_t)~(1u << slot);
			d->nodes[i]->commits[k]->sent[slot] = INT64_MIN / 2;
		}
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
		if (c != NULL) c->acked |= (uint8_t)(1u << l->slot);
		else if (!seen(n, h->bytes.data)) memcpy(lack[lacking++], h->bytes.data, CM_NAME);
	}
	if (lacking) send_names(n, l, "want", (const uint8_t(*)[CM_NAME])lack, lacking);
	free(lack);
	if (re != NULL && re->type == JSON_BOOLEAN && re->boolean) return;
	// the sender lacks some of ours: ours, once
	for (size_t i = 0; i < n->n_commits; i++)
		if (!in_list(heads, n->commits[i]->name)) {
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
	uint8_t bit = (uint8_t)(1u << l->slot);
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
			if (c != NULL) c->acked |= bit;
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
			commit *c = take_commit(n, name, s->bytes.data, s->bytes.length, &o.c, false);
			parents_add(&ps, &o.c);
			d->stats.applied++;
			if (c != NULL) c->acked |= bit;
			news = true;
		}
		cm_free(&o.c);
	}
	parents_mark(n, &ps);
	if (k) send_names(n, l, "ack", (const uint8_t(*)[CM_NAME])took, k);
	free(took);
	// a relay: the other peers are told what the node is now, and want what they lack (never this link)
	if (news)
		for (unsigned i = 0; i < LS_LINKS; i++)
			if (d->links[i] != NULL && d->links[i] != l && d->links[i]->up) send_heads(n, d->links[i], false);
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
			if (c != NULL) c->acked |= (uint8_t)(1u << l->slot);
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
	jsonFree(m);
}

void ls_feed(struct ls_link *l, const uint8_t *bytes, size_t length) {
	for (size_t i = 0; i < length; i++) {
		uint8_t b = bytes[i];
		if (b != 0) {
			if (l->rx_n < LS_FRAME_MAX) l->rx[l->rx_n++] = b;
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
	size_t n = l->out_used;
	l->out_used = 0;
	// room taken up by a big burst is given back
	if (n == 0 && l->out_cap > 4096) {
		free(l->out);
		l->out = NULL;
		l->out_cap = 0;
	}
	*out = l->out;
	return n;
}

// ---- time

void ls_tick(ls_dev *d, int64_t now) {
	d->now = now;
	bool beat[LS_LINKS] = {false}, any = false;
	for (unsigned i = 0; i < LS_LINKS; i++) {
		struct ls_link *l = d->links[i];
		if (l == NULL) continue;
		if (l->up && now - l->heard > 8000) {
			l->up = false;
			say(d, "peer silent");
		}
		if (!l->up) {
			if (now - l->hello_sent >= 2000) send_hello(l, false);
		} else if (now - l->hello_sent >= 4000) send_hello(l, true);
		beat[i] = l->up && now - l->heads_sent >= 10000;
		if (beat[i]) l->heads_sent = now;
		any |= l->up;
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
		if (n->hold != NULL && any && (now - n->hold_sent >= LS_BEAT_MS || (n->hold_dirty && now - n->hold_sent >= 50)))
			send_hold(n);
		for (unsigned s = 0; s < LS_LINKS; s++) {
			struct ls_link *l = d->links[s];
			if (l == NULL || !l->up) continue;
			// own commits this peer has not said it has
			commit **list = NULL;
			size_t k = 0;
			for (size_t c = 0; c < n->n_commits; c++) {
				commit *x = n->commits[c];
				if (x->own && !(x->acked & (1u << s)) && now - x->sent[s] >= 1000) {
					list = realloc(list, (k + 1) * sizeof *list);
					if (list == NULL) abort();
					list[k++] = x;
				}
			}
			if (k) send_commits(n, l, list, k);
			free(list);
			if (beat[s]) send_heads(n, l, false);
		}
		if (n->dirty && now - n->saved >= (d->o.save_ms ? d->o.save_ms : 2000)) save_node(n);
	}
}

// ---- links

struct ls_link *ls_link(ls_dev *d) {
	unsigned slot = 0;
	while (slot < LS_LINKS && d->links[slot] != NULL) slot++;
	if (slot == LS_LINKS) return NULL;
	struct ls_link *l = allocate(sizeof *l);
	l->dev = d;
	l->slot = slot;
	l->hello_sent = INT64_MIN / 2;
	forget_slot(d, slot);
	d->links[slot] = l;
	return l;
}

void ls_unlink(struct ls_link *l) {
	if (l == NULL) return;
	l->dev->links[l->slot] = NULL;
	free(l->out);
	free(l);
}

// ---- the device

ls_dev *ls_open(const ls_options *o) {
	if (o->store.load == NULL || o->store.save == NULL || o->random == NULL) return NULL;
	ls_dev *d = allocate(sizeof *d);
	d->o = *o;
	uint8_t *seed = NULL;
	size_t length = 0;
	if (o->store.load(o->store.context, "key", &seed, &length) && length == 32) memcpy(d->seed, seed, 32);
	else {
		o->random(o->random_context, d->seed, 32);
		if (!o->store.save(o->store.context, "key", d->seed, 32)) {
			free(seed);
			free(d);
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
	for (unsigned i = 0; i < LS_LINKS; i++) ls_unlink(d->links[i]);
	free(d);
}

const uint8_t *ls_key(const ls_dev *d) { return d->key; }
const uint8_t *ls_peer(const struct ls_link *l) { return l->has_peer ? l->peer : NULL; }
int ls_up(const struct ls_link *l) { return l->up; }
const ls_traffic *ls_traffic_of(const struct ls_link *l) { return &l->traffic; }
const ls_stats *ls_stats_of(const ls_dev *d) { return &d->stats; }
const char *ls_reason(const ls_dev *d) { return d->reason != NULL ? d->reason : ""; }
