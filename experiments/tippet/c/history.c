// The C side of the history (see history.h): records writes made in the graph as steps, and lands
// steps that arrive from elsewhere. Entries are merged in order of lamport, then device.
#include "history.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../core/encoding/c/cbor.h"
#include "elements.h"
#include "wire.h"

// seq: how many elements its device's steps before it insert (WIRE.md, ids)
typedef struct {
	uint64_t lamport, n, seq;
	uint32_t device;
	uint8_t head;
	uint8_t ghost; // a head beside its device's newest step: it names nothing the step after it does
} ref;

// A kept entry, keyed by part and node. broken: a write here was not kept. unsure: the list of
// failed
// steps may be incomplete, so the next walk goes back to the first step. waits: a step landed early
// in it, and it is worked out again once the run landing is all in (settle).
typedef struct own own;
typedef struct {
	char *key;
	size_t size;
	ref one, *more;
	own *mine;
	uint32_t count;
	uint8_t broken, unsure, waits;
	uint8_t plain; // forgets: no own: its elements are those of a put of the whole value by one
	op_value *was; // plain: the graph's value, as the newest step left it
	ref mark; // the newest step it had when the host last emptied it
	uint8_t marked;
} entry;

// What an entry holds when rebase is on: the value its steps make as history worked it out, and its
// newest steps in the order applied, each with what undoes it (empty for one that did not apply).
// all: the tail is every step of the entry, so undoing it all leaves nothing. forgets: its elements,
// value the graph's (shared), no tail.
typedef struct {
	ref at;
	op_undo undo;
	el_back back; // what undoes its sequences' elements
} rung;
struct own {
	op_value *value;
	el_state el; // its strings' and arrays' elements (elements.h)
	rung *tail;
	size_t n, room;
	uint8_t all;
};

// a step that landed early in entry k
typedef struct {
	long k;
	ref at;
} early;

static ref *at(entry *e, size_t i) { return i ? &e->more[i - 1] : &e->one; }

typedef struct {
	uint8_t device[32];
	int has_device, fixed;
	uint64_t n;
	char *node, *part;
	const char *why;
	uint64_t lamport; // forgets: the step's place, when ordered
	int ordered;
} failure;

typedef struct {
	failure *items;
	size_t n, room;
} failures;

struct tp_history {
	tp_mem mem;
	int skipped; // a step of the log walked over because the store could not give it back
	tp_log *log;
	tb_table *table;
	pl *places;
	int (*kept)(void *ctx, const char *node, const char *part);
	void (*run)(void *ctx, void (*f)(void *data), void *data);
	void *ctx;
	int forgets;
	int cut; // forgets: runs let go (cut())
	uint64_t seen; // the log's drops when the first steps were last looked at
	size_t window; // steps of an entry that hold what undoes them; 0: none
	pl_watch *watch;
	entry *entries;
	size_t nentries, roomentries;
	size_t *slots, nslots;
	uint8_t (*devices)[32];
	size_t ndevices, roomdevices;
	failures failed, unkept;
	int landing;
	tp_buf bytes;
	tp_buf early; // early steps of the run landing, in order
};

// a value that holds others: a map, a list, a string
static int holds(const op_value *v) { return v && (v->type == OP_MAP || v->type == OP_LIST || v->type == OP_STR); }

static void *must(size_t n) {
	void *p = malloc(n ? n : 1);
	if (!p) abort();
	return p;
}

// merge sort without recursion
static size_t *order_of(const op_value *m) {
	size_t n = m->count, *a = must(2 * n * sizeof *a), *t = a + n;
	for (size_t i = 0; i < n; i++) a[i] = i;
	for (size_t w = 1; w < n; w *= 2) {
		for (size_t lo = 0; lo < n; lo += 2 * w) {
			size_t mid = lo + w < n ? lo + w : n, hi = lo + 2 * w < n ? lo + 2 * w : n;
			size_t i = lo, j = mid, k = lo;
			while (i < mid && j < hi) {
				const char *x = m->keys[a[j]], *y = m->keys[a[i]];
				t[k++] = cborKeyCompare(x, strlen(x), y, strlen(y)) < 0 ? a[j++] : a[i++];
			}
			while (i < mid) t[k++] = a[i++];
			while (j < hi) t[k++] = a[j++];
		}
		memcpy(a, t, n * sizeof *a);
	}
	return a;
}

typedef struct {
	const op_value *v;
	size_t at, *order;
} level;

// A value's canonical cbor, with open containers on a stack (no recursion). 0 if it has none.
static int put_value(CborOut *o, const op_value *v) {
	level *stack = NULL;
	size_t depth = 0, room = 0;
	int ok = 1;
	while (ok && v) {
		switch (v->type) {
			case OP_NULL: cborPutNull(o); break;
			case OP_BOOL: cborPutBoolean(o, v->bool_); break;
			case OP_NUM:
				if (v->big) cborPutWhole(o, v->bigNegative, v->big, v->bigLength);
				else cborPutNumber(o, v->num);
				break;
			case OP_STR: ok = cborPutText(o, v->str, v->bytes); break;
			case OP_BYTES: cborPutBytes(o, v->data, v->bytes); break;
			case OP_TYPED: cborPutTyped(o, (JsonKind)v->kind, v->data, op_length(v)); break;
			default:
				if (depth == CBOR_DEPTH) {
					ok = 0;
					break;
				}
				if (v->type == OP_STAND) cborPutStand(o);
				else cborPutHead(o, v->type == OP_LIST ? 4 : 5, v->count);
				if (depth == room) {
					room = room ? 2 * room : 8;
					level *s = realloc(stack, room * sizeof *s);
					if (!s) abort();
					stack = s;
				}
				stack[depth++] = (level){v, 0, v->type == OP_MAP ? order_of(v) : NULL};
		}
		v = NULL;
		while (ok && depth && !v) {
			level *top = &stack[depth - 1];
			if (top->at == top->v->count) {
				free(top->order);
				depth--;
				continue;
			}
			size_t i = top->order ? top->order[top->at] : top->at;
			top->at++;
			if (top->v->type == OP_MAP) ok = cborPutText(o, top->v->keys[i], strlen(top->v->keys[i]));
			v = top->v->items[i];
		}
	}
	while (depth) free(stack[--depth].order);
	free(stack);
	return ok;
}

static int put_target(CborOut *o, const op_target *t) {
	cborPutText(o, "path", 4), cborPutHead(o, 4, t->length);
	for (size_t i = 0; i < t->length; i++) {
		const op_key *k = &t->path[i];
		if (k->type == OP_STR_KEY) {
			if (!cborPutText(o, k->s, strlen(k->s))) return 0;
		} else if (k->type == OP_NUM_KEY && k->n >= 0) {
			cborPutHead(o, 0, (uint64_t)k->n);
		} else {
			return 0;
		}
	}
	if (!t->has_range) return 1;
	if (t->from < 0 || t->to < 0) return 0;
	cborPutText(o, "range", 5), cborPutHead(o, 4, 2);
	cborPutHead(o, 0, (uint64_t)t->from), cborPutHead(o, 0, (uint64_t)t->to);
	return 1;
}

static int put_patches(CborOut *o, const op_patch *ps, size_t n) {
	cborPutHead(o, 4, n);
	for (size_t i = 0; i < n; i++) {
		const op_patch *p = &ps[i];
		cborPutHead(o, 5, 1 + (size_t)!!p->place.has_range + !!p->has_value + !!p->has_move);
		if (p->has_move) {
			cborPutText(o, "move", 4), cborPutHead(o, 5, 1 + (size_t)!!p->move.has_range);
			if (!put_target(o, &p->move)) return 0;
		}
		if (!put_target(o, &p->place)) return 0;
		if (p->has_value && (cborPutText(o, "value", 5), !put_value(o, p->value))) return 0;
	}
	return 1;
}


static int same_path(const op_key *a, const op_key *b, size_t n) {
	for (size_t i = 0; i < n; i++) {
		if (a[i].type != b[i].type || (a[i].type == OP_NUM_KEY ? a[i].n != b[i].n : strcmp(a[i].s, b[i].s))) return 0;
	}
	return 1;
}
static const op_value *value_at(const op_value *v, const op_key *path, size_t n) {
	for (size_t i = 0; i < n && v; i++) {
		if (v->type == OP_LIST && path[i].type == OP_NUM_KEY) v = path[i].n >= 0 && (size_t)path[i].n < v->count ? v->items[path[i].n] : NULL;
		else if (v->type == OP_MAP && path[i].type == OP_STR_KEY) v = op_get(v, path[i].s);
		else return NULL;
	}
	return v;
}
// a write's patches as its step has them: a move of a span of a text is a removal and an insertion
// (it can't be named by ids), a list move that moves nothing is left out. *out (malloc'd) is NULL
// when they are the patches given; texts holds the values made, for the caller to free
static void step_patches(const op_value *value, const op_patch *ps, size_t n, op_patch **out, size_t *nout,
	op_value ***texts, size_t *ntexts) {
	int any = 0;
	*out = NULL, *nout = 0, *texts = NULL, *ntexts = 0;
	for (size_t i = 0; i < n; i++) any |= ps[i].has_move;
	if (!any || !value) return;
	op_patch *o = must(2 * n * sizeof *o);
	op_value **t = must(n * sizeof *t);
	size_t no = 0, nt = 0;
	op_value *cur = op_ref((op_value *)value);
	for (size_t i = 0; i < n; i++) {
		const op_patch *p = &ps[i];
		// a move onto its own place changes nothing (as apply has it)
		if (p->has_move && !p->place.has_range && !p->move.has_range && p->move.length == p->place.length &&
			same_path(p->move.path, p->place.path, p->place.length))
			continue;
		const op_value *sv = cur && p->has_move && p->place.has_range && p->place.from == p->place.to
			? value_at(cur, p->place.path, p->place.length) : NULL;
		if (sv && p->move.has_range && p->move.length == p->place.length && same_path(p->move.path, p->place.path, p->place.length) &&
			sv->type == OP_STR) {
			size_t x, y;
			if (op_string_span(sv, p->move.from, p->move.to, &x, &y)) {
				op_value *text = op_str_n(sv->str + x, y - x);
				t[nt++] = text;
				o[no] = (op_patch){0}, o[no].place = p->place, o[no].place.from = p->move.from, o[no++].place.to = p->move.to;
				o[no] = (op_patch){0}, o[no].place = p->place, o[no].has_value = 1, o[no++].value = text;
			} else o[no++] = *p;
		} else if (sv && sv->type == OP_LIST) {
			int64_t a = p->move.has_range ? p->move.from : p->move.length ? p->move.path[p->move.length - 1].n : -1;
			if (a == p->place.from && (p->move.has_range || p->move.path[p->move.length - 1].type == OP_NUM_KEY)) {
				continue;
			}
			o[no++] = *p;
		} else o[no++] = *p;
		if (cur) {
			op_value *next = NULL;
			size_t failed;
			if (op_apply(cur, p, 1, NULL, &next, &failed)) next = NULL;
			op_free(cur), cur = next;
		}
	}
	if (cur) op_free(cur);
	*out = o, *nout = no, *texts = t, *ntexts = nt;
}

static void drop_texts(op_value **t, size_t n, op_patch *alt) {
	for (size_t i = 0; i < n; i++) op_free(t[i]);
	free(t), free(alt);
}

static void *make(void *self, const CborItem *it) {
	(void)self;
	switch (it->what) {
		case CBOR_NULL: return op_null();
		case CBOR_BOOLEAN: return op_bool(it->boolean);
		case CBOR_FLOAT: return op_num(it->number);
		case CBOR_UNSIGNED: return op_uint(it->argument);
		case CBOR_WHOLE: return op_whole(it->negative, it->data, it->length);
		case CBOR_TEXT: return op_str_take(it->text, it->length);
		case CBOR_BYTES: return op_bytes(it->data, it->length);
		case CBOR_TYPED: return op_typed((op_elements)it->kind, it->data, it->count);
		case CBOR_LIST: return op_list();
		case CBOR_MAP: return op_map();
		default: return op_stand(NULL);
	}
}
static void place(void *self, void *container, const char *key, size_t length, void *item) {
	(void)self, (void)length;
	op_value *c = container;
	if (c->type == OP_STAND) c->items[0] = item;
	else if (c->type == OP_LIST) op_push(c, item);
	else op_set(c, key, item);
}
static void drop(void *self, void *v) {
	(void)self;
	op_free(v);
}
static const CborMaker maker = {make, place, drop, NULL};

typedef struct {
	op_value *step, *actor, *device, *whole;
	const char *node, *part;
	op_patch *patches;
	size_t count;
	// values made for the patches, as applied (a list of items a move brings back)
	op_value **made;
	size_t nmade;
	op_key *keys;
	ch_frame *frame;
	ch_header header;
} block;

static void block_free(void *p) {
	block *b = p;
	op_free(b->step), op_free(b->actor), op_free(b->device), op_free(b->whole);
	for (size_t i = 0; i < b->nmade; i++) op_free(b->made[i]);
	free(b->made);
	ch_frame_free(b->frame);
	free(b->patches), free(b->keys), free(b);
}

// the values a step made for its patches belong to the block that holds the patches
static void attach(tp_history *h, block *b, el_made *m) {
	if (m->n) {
		op_value **p = realloc(b->made, (b->nmade + m->n) * sizeof *p);
		if (!p) abort();
		memcpy(p + b->nmade, m->p, m->n * sizeof *p);
		b->made = p, b->nmade += m->n;
	}
	tp_free(&h->mem, m->p, m->room * sizeof *m->p);
	*m = (el_made){0};
}

static int64_t int_of(const op_value *v) {
	int64_t n = 0;
	op_as_int64(v, &n);
	return n;
}

static void target_of(const op_value *m, op_target *t, op_key **keys) {
	const op_value *path = op_get(m, "path"), *range = op_get(m, "range");
	t->path = *keys, t->length = path->count;
	for (size_t i = 0; i < path->count; i++) {
		const op_value *k = path->items[i];
		// an index past what a long holds, less one for the op layer's n + 1, names no item
		int64_t x = k->type == OP_STR ? 0 : int_of(k);
		(*keys)[i] = k->type == OP_STR ? (op_key){.type = OP_STR_KEY, .s = k->str}
					       : (op_key){.type = OP_NUM_KEY, .n = x > LONG_MAX - 1 ? LONG_MAX - 1 : (long)x};
	}
	*keys += path->count;
	if (range) t->has_range = 1, t->from = int_of(range->items[0]), t->to = int_of(range->items[1]);
}

static block *block_of(const uint8_t *bytes, size_t length) {
	op_value *s = cborRead(bytes, length, &maker, NULL, NULL);
	if (!s) return NULL;
	block *b = must(sizeof *b);
	memset(b, 0, sizeof *b);
	b->step = s;
	if (s->items[3]->type == OP_LIST) {
		const op_value *r = s->items[3]->items[0];
		size_t n = TP_OWN_ID + r->bytes;
		char *full = must(n);
		memcpy(full, "ermine:ed01", 11), tp_hex(full + 11, s->items[0]->data, 32);
		memcpy(full + TP_OWN_ID, r->str, r->bytes);
		op_free(s->items[3]), s->items[3] = op_str_n(full, n);
		free(full);
	}
	b->node = s->items[3]->str, b->part = s->items[4]->str;
	const op_value *ps = s->items[5];
	size_t keys = 0;
	for (size_t i = 0; i < ps->count; i++) {
		const op_value *move = op_get(ps->items[i], "move");
		keys += op_get(ps->items[i], "path")->count + (move ? op_get(move, "path")->count : 0);
	}
	b->count = ps->count;
	b->patches = must(ps->count * sizeof *b->patches);
	op_key *k = b->keys = must(keys * sizeof *b->keys);
	for (size_t i = 0; i < ps->count; i++) {
		op_patch *p = &b->patches[i];
		const op_value *m = ps->items[i], *move = op_get(m, "move");
		memset(p, 0, sizeof *p);
		target_of(m, &p->place, &k);
		p->value = op_get(m, "value"), p->has_value = p->value != NULL;
		if (move) p->has_move = 1, target_of(move, &p->move, &k);
	}
	char hex[65];
	tp_hex(hex, s->items[0]->data, 32);
	hex[64] = 0;
	b->device = op_str(hex);
	op_value *last = s->items[s->count - 1];
	b->actor = op_ref(s->count > 8 && last->type == OP_STR ? last : b->device);
	ch_pair info[3] = {{"device", b->device}, {"n", s->items[1]}, {"lamport", s->items[6]}};
	b->frame = ch_frame_make(info, 3, NULL);
	b->header = (ch_header){.has_time = 1, .time = int_of(s->items[7]), .actor = b->actor,
		.frame = b->frame};
	return b;
}

static void whole_of(block *b, op_value *value) {
	free(b->patches), free(b->keys);
	b->keys = NULL, b->count = 1, b->whole = value;
	b->patches = must(sizeof *b->patches);
	memset(b->patches, 0, sizeof *b->patches);
	b->patches->has_value = value != NULL, b->patches->value = value;
}

static void *grown(tp_history *h, void *p, size_t *room, size_t n, size_t each) {
	if (n < *room) return p;
	size_t more = *room ? 2 * *room : 8;
	void *q = tp_grow(&h->mem, p, *room * each, more * each);
	if (q) *room = more;
	return q;
}

static char *copy(tp_history *h, const char *s) {
	size_t n = strlen(s) + 1;
	char *c = tp_alloc(&h->mem, n);
	if (c) memcpy(c, s, n);
	return c;
}

static void note(tp_history *h, failures *list, const uint8_t *device, uint64_t n,
	const char *node, const char *part, const char *why) {
	failure *items = grown(h, list->items, &list->room, list->n, sizeof *items);
	if (!items) return;
	list->items = items;
	failure *f = &items[list->n];
	memset(f, 0, sizeof *f);
	if (device) memcpy(f->device, device, 32), f->has_device = 1;
	f->n = n, f->why = why;
	f->node = copy(h, node), f->part = copy(h, part);
	list->n++;
}

// a failure noted for the step at lamport
static void note_at(tp_history *h, const uint8_t *device, uint64_t n, const char *node, const char *part,
	const char *why, uint64_t lamport) {
	size_t was = h->failed.n;
	note(h, &h->failed, device, n, node, part, why);
	if (h->failed.n > was) h->failed.items[was].lamport = lamport, h->failed.items[was].ordered = 1;
}

static failure *failed_at(const tp_history *h, const uint8_t *device, uint64_t n) {
	for (size_t i = 0; i < h->failed.n; i++) {
		failure *f = &h->failed.items[i];
		if (f->n == n && !memcmp(f->device, device, 32)) return f;
	}
	return NULL;
}

static failure *failed_after(const tp_history *h, const failure *f) {
	for (failure *g = (failure *)f + 1; g < h->failed.items + h->failed.n; g++) {
		if (g->n == f->n && !memcmp(g->device, f->device, 32)) return g;
	}
	return NULL;
}

static void forget(tp_history *h, const failure *f) {
	if (f->node) tp_free(&h->mem, f->node, strlen(f->node) + 1);
	if (f->part) tp_free(&h->mem, f->part, strlen(f->part) + 1);
}

static void unfail(tp_history *h, int held) {
	size_t k = 0;
	for (size_t i = 0; i < h->failed.n; i++) {
		failure f = h->failed.items[i];
		if (held && f.fixed) forget(h, &f);
		else f.fixed = 0, h->failed.items[k++] = f;
	}
	h->failed.n = k;
}

static long device_of(tp_history *h, const uint8_t device[32]) {
	for (size_t i = 0; i < h->ndevices; i++) {
		if (!memcmp(h->devices[i], device, 32)) return (long)i;
	}
	uint8_t(*d)[32] = grown(h, h->devices, &h->roomdevices, h->ndevices, 32);
	if (!d) return -1;
	h->devices = d;
	memcpy(h->devices[h->ndevices], device, 32);
	return (long)h->ndevices++;
}

static size_t hash(const char *key, size_t size) {
	size_t x = 2166136261u;
	for (size_t i = 0; i < size; i++) x = (x ^ (uint8_t)key[i]) * 16777619u;
	return x;
}

static long entry_of(tp_history *h, const char *part, const char *node) {
	size_t a = strlen(part), size = a + strlen(node) + 2;
	char *key = tp_alloc(&h->mem, size);
	if (!key) return -1;
	memcpy(key, part, a + 1), memcpy(key + a + 1, node, size - a - 1);
	size_t mask = h->nslots - 1, s = hash(key, size) & mask;
	for (; h->slots[s]; s = (s + 1) & mask) {
		const entry *e = &h->entries[h->slots[s] - 1];
		if (e->size == size && !memcmp(e->key, key, size)) {
			tp_free(&h->mem, key, size);
			return (long)h->slots[s] - 1;
		}
	}
	entry *es = grown(h, h->entries, &h->roomentries, h->nentries, sizeof *es);
	if (!es) return tp_free(&h->mem, key, size), -1;
	h->entries = es;
	es[h->nentries] = (entry){key, size, {0}, NULL, NULL, 0, 0, 0, 0, 0, NULL, {0}, 0};
	h->slots[s] = ++h->nentries;
	if (2 * h->nentries > h->nslots) {
		size_t n = 2 * h->nslots, *slots = tp_alloc(&h->mem, n * sizeof *slots);
		if (slots) {
			memset(slots, 0, n * sizeof *slots);
			for (size_t i = 0; i < h->nentries; i++) {
				size_t t = hash(es[i].key, es[i].size) & (n - 1);
				while (slots[t]) t = (t + 1) & (n - 1);
				slots[t] = i + 1;
			}
			tp_free(&h->mem, h->slots, h->nslots * sizeof *slots);
			h->slots = slots, h->nslots = n;
		}
	}
	return (long)h->nentries - 1;
}

static int after(const tp_history *h, const ref *x, const ref *y) {
	if (x->lamport != y->lamport) return x->lamport > y->lamport;
	return memcmp(h->devices[x->device], h->devices[y->device], 32) > 0;
}

// steps up to the mark are applied without making trash, so working an entry out again does not
// bring back what the host let go
static int quiet_at(const tp_history *h, long k, const ref *r) {
	const entry *e = &h->entries[k];
	return e->marked && !after(h, r, &e->mark);
}

static void unown(tp_history *h, entry *e) {
	own *m = e->mine;
	if (!m) return;
	for (size_t i = 0; i < m->n; i++) {
		op_undo_free(&m->tail[i].undo);
		el_back_free(&h->mem, &m->tail[i].back);
	}
	tp_free(&h->mem, m->tail, m->room * sizeof *m->tail);
	el_state_free(&h->mem, &m->el);
	op_free(m->value);
	tp_free(&h->mem, m, sizeof *m);
	e->mine = NULL;
}

// the newest steps only: older ones no longer hold what undoes them
static void trim(tp_history *h, own *m, size_t window) {
	if (m->n <= window) return;
	size_t gone = m->n - window;
	for (size_t i = 0; i < gone; i++) {
		op_undo_free(&m->tail[i].undo);
		el_back_free(&h->mem, &m->tail[i].back);
	}
	memmove(m->tail, m->tail + gone, window * sizeof *m->tail);
	m->n = window, m->all = 0;
}

static void unplace(tp_history *h, entry *e) {
	unown(h, e);
	if (e->count > 1) tp_free(&h->mem, e->more, (e->count - 1) * sizeof *e->more);
	e->more = NULL, e->count = 0, e->plain = 0;
	op_free(e->was), e->was = NULL;
}

// forgets: an own for an entry whose newest step, seed (if not NULL), put the whole value, a
// container or not
static own *seeded(tp_history *h, const ref *seed, int container) {
	own *m = tp_alloc(&h->mem, sizeof *m);
	if (!m) return NULL;
	memset(m, 0, sizeof *m);
	el_ref er = seed ? (el_ref){seed->lamport, seed->n, seed->seq, seed->device} : (el_ref){0};
	if (seed && el_seed(&h->mem, &m->el, &er, container)) return tp_free(&h->mem, m, sizeof *m), NULL;
	return m;
}

static void resync(tp_history *h, long k);

// forgets: a plain entry's value, as the graph has it now
static void refresh(tp_history *h, long k) {
	entry *e = &h->entries[k];
	if (!e->plain || e->mine) return;
	const char *part = e->key, *node = part + strlen(part) + 1;
	nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
	op_free(e->was);
	e->was = x && x->value ? op_ref(x->value) : NULL;
}

static int placed(tp_history *h, long k, const uint8_t device[32], uint64_t n, uint64_t lamport,
	uint64_t seq, int whole, int simple, ref *replaced) {
	if (replaced) replaced->n = 0;
	long d = device_of(h, device);
	if (d < 0) return -1;
	entry *e = &h->entries[k];
	ref r = {.lamport = lamport, .n = n, .seq = seq, .device = (uint32_t)d, .head = 1}, *mine = NULL;
	int last = 1;
	for (size_t i = 0; i < e->count; i++) {
		ref *x = at(e, i);
		if (after(h, x, &r)) last = 0;
		if (x->device == r.device && !x->ghost) mine = x;
	}
	if (h->forgets) {
		// its elements, from the entry's first step seen. a put of the whole value, alone, has none:
		// its cell is the root, made when another step comes
		if (!e->count && !e->mine) {
			if (simple) e->plain = 1;
			else if (!(e->mine = seeded(h, NULL, 0))) return -1;
		} else if (e->plain && !e->mine) {
			if (!(e->mine = seeded(h, &e->one, holds(e->was)))) return -1;
			e->plain = 0;
			op_free(e->was), e->was = NULL;
		}
		if (last && e->count > 1) tp_free(&h->mem, e->more, (e->count - 1) * sizeof *e->more);
		if (last) e->more = NULL, e->one = r, e->count = 1;
		return last;
	}
	if (mine) {
		if (mine->n < n) {
			if (replaced) *replaced = *mine;
			*mine = r;
		}
		return last;
	}
	if (!e->count && !h->forgets && whole && !e->mine) {
		// an entry seen from its first step, a whole value: its own from nothing, every step in its tail
		own *m = tp_alloc(&h->mem, sizeof *m);
		if (m) memset(m, 0, sizeof *m), m->all = 1;
		e->mine = m;
	}
	if (e->count) {
		ref *more = tp_grow(&h->mem, e->more, (e->count - 1) * sizeof *more, e->count * sizeof *more);
		if (!more) return -1;
		e->more = more, more[e->count - 1] = r;
	} else e->one = r;
	e->count++;
	return last;
}

static int covers(const tp_history *h, const tp_step *s, const ref *x) {
	size_t at = 0;
	const uint8_t *d;
	uint64_t n;
	while (!tp_on_next(s, &at, &d, &n)) {
		if (n == x->n && !memcmp(d, h->devices[x->device], 32)) return 1;
	}
	return 0;
}

static void unhead(tp_history *h, entry *e, const tp_step *s, const ref *r) {
	for (size_t i = 0; i < e->count; i++) {
		ref *x = at(e, i);
		if (x->head && !(x->device == r->device && x->n == r->n) && covers(h, s, x)) x->head = 0;
	}
}

// a head that is no longer the newest of its device: a ref of its own, noted ghost
static void ghost(tp_history *h, long k, const ref *old) {
	entry *e = &h->entries[k];
	ref *more = tp_grow(&h->mem, e->more, (e->count - 1) * sizeof *more, e->count * sizeof *more);
	if (!more) return;
	e->more = more, more[e->count - 1] = *old, more[e->count - 1].ghost = 1;
	e->count++;
}

// ghosts that are no head any more let go
static void sweep(tp_history *h, entry *e) {
	for (size_t i = 0; i < e->count;) {
		ref *x = at(e, i);
		if (!x->ghost || x->head) {
			i++;
			continue;
		}
		ref last = *at(e, e->count - 1);
		ref *more = tp_grow(&h->mem, e->more, (e->count - 1) * sizeof *more, (e->count - 2) * sizeof *more);
		if (!more && e->count > 2) {
			i++;
			continue;
		}
		e->more = e->count > 2 ? more : NULL;
		if (i != e->count - 1) *at(e, i) = last;
		e->count--;
	}
}

static void named(entry *e, const ref *r) {
	for (size_t i = 0; i < e->count; i++) {
		ref *x = at(e, i);
		if (x->device == r->device && x->n == r->n) x->head = 0;
	}
}

static long fetch(tp_history *h, const uint8_t device[32], uint64_t n) {
	h->bytes.len = 0, h->bytes.bad = 0;
	long length = tp_log_step(h->log, device, n, h->bytes.p, h->bytes.cap);
	if (length < 0) return -1;
	if ((size_t)length > h->bytes.cap) {
		if (!tp_reserve(&h->bytes, (size_t)length)) return -1;
		tp_log_step(h->log, device, n, h->bytes.p, (size_t)length);
	}
	return length;
}

static block *read_back(tp_history *h, const uint8_t device[32], uint64_t n) {
	long length = fetch(h, device, n);
	return length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
}

typedef struct {
	ref at;
	int ours, whole;
} cursor;

static void look(tp_history *h, const entry *e, cursor *c) {
	const char *part = e->key, *node = part + strlen(part) + 1;
	size_t a = strlen(part), b = strlen(node);
	tp_step s;
	memset(&s, 0, sizeof s);
	c->ours = c->whole = 0;
	for (; c->at.n; c->at.n--) {
		long length = fetch(h, h->devices[c->at.device], c->at.n);
		if (length >= 0 && !tp_step_decode(h->bytes.p, (size_t)length, &s)) break;
		h->skipped = 1;
	}
	if (!c->at.n) return;
	c->at.lamport = s.lamport;
	c->at.seq = s.seq;
	if (s.part.n != a || memcmp(s.part.p, part, a)) return;
	if (s.relative) {
		char own[TP_OWN_ID];
		memcpy(own, "ermine:ed01", 11), tp_hex(own + 11, s.device, 32);
		if (b != TP_OWN_ID + s.node.n || memcmp(node, own, TP_OWN_ID) ||
			memcmp(node + TP_OWN_ID, s.node.p, s.node.n))
			return;
	} else if (s.node.n != b || memcmp(s.node.p, node, b)) return;
	c->ours = 1;
	size_t from = 0;
	tp_patch p;
	c->whole = !tp_patch_next(s.patches, &from, &p) && p.path.n == 1 && !p.ranged && p.value.p && !p.move.p;
}

// Walk back from the frontier, newest first, to the first step. from: only back to that step. (A
// put of the whole value no longer stops it: another root cell may be visible beside it.)
static int walked(tp_history *h, long k, const ref *from, tp_buf *out, size_t *count) {
	entry *e = &h->entries[k];
	size_t n = e->count;
	cursor *cs = tp_alloc(&h->mem, n * sizeof *cs);
	if (!cs) return TP_NOMEM;
	for (size_t i = 0; i < n; i++) {
		cs[i].at = *at(e, i);
		if (at(e, i)->ghost) cs[i].at.n = 0, cs[i].ours = cs[i].whole = 0;
		else look(h, e, &cs[i]);
	}
	for (;;) {
		cursor *c = NULL;
		for (size_t i = 0; i < n; i++) {
			if (cs[i].at.n && (!c || after(h, &cs[i].at, &c->at))) c = &cs[i];
		}
		if (!c || (from && after(h, from, &c->at))) break;
		if (c->ours) {
			tp_put(out, &c->at, sizeof c->at);
			if (tp_buf_why(out)) break;
		}
		c->at.n--, look(h, e, c);
	}
	tp_free(&h->mem, cs, n * sizeof *cs);
	int why = tp_buf_why(out);
	*count = why ? 0 : out->len / sizeof(ref);
	ref *r = (ref *)out->p;
	for (size_t i = 0; i < *count / 2; i++) {
		ref t = r[i];
		r[i] = r[*count - 1 - i], r[*count - 1 - i] = t;
	}
	return why;
}

typedef struct {
	tp_history *h;
	block *b;
	int code, held;
} writing;

static void write_f(void *data) {
	writing *w = data;
	tp_history *h = w->h;
	block *b = w->b;
	tb_key part = tb_string(b->part), id = tb_string(b->node);
	nd_entry *e = tb_get(h->table, part, id);
	size_t failed;
	if (e) {
		if ((w->code = nd_update(e, b->patches, b->count, b->header, &failed))) return;
		pl_hold(h->places, e, b, block_free), w->held = 1;
		pl_changed changed = {1, {e, NULL}};
		pl_commit(h->places, &changed);
		return;
	}
	op_value *v = NULL;
	if ((w->code = op_apply(NULL, b->patches, b->count, NULL, &v, &failed)) || !v) return;
	e = nd_make_entry(v, &b->header);
	op_free(v);
	if (!e) abort();
	pl_own(h->places, e);
	pl_hold(h->places, e, b, block_free), w->held = 1;
	pl_add(h->places, part, id, e);
}

static void quietly(tp_history *h, void (*f)(void *data), void *data) {
	int was = h->landing;
	h->landing = 1;
	if (h->run) h->run(h->ctx, f, data);
	else f(data);
	h->landing = was;
}

static int write(tp_history *h, block *b) {
	writing w = {h, b, 0, 0};
	quietly(h, write_f, &w);
	if (!w.held) block_free(b);
	return w.code;
}

static long el_index(void *self, const uint8_t device[32]) { return device_of(self, device); }
static const uint8_t *el_bytes(void *self, uint32_t i) { return ((tp_history *)self)->devices[i]; }
static long el_find(void *self, const uint8_t device[32]) {
	tp_history *h = self;
	for (size_t i = 0; i < h->ndevices; i++) {
		if (!memcmp(h->devices[i], device, 32)) return (long)i;
	}
	return -1;
}
static int el_put_value(void *self, tp_buf *b, const op_value *v) {
	(void)self;
	CborOut o = {NULL, 0, 0, false};
	if (!put_value(&o, v)) return -1;
	uint8_t *bytes = tp_reserve(b, o.length);
	if (!bytes) return TP_NOMEM;
	CborOut w = {bytes, o.length, 0, false};
	put_value(&w, v);
	return 0;
}
static op_value *el_get_value(void *self, tp_span cbor) {
	(void)self;
	return cborRead(cbor.p, cbor.n, &maker, NULL, NULL);
}
static el_ctx elc(tp_history *h) {
	return (el_ctx){&h->mem, h, el_index, el_find, el_bytes, el_put_value, el_get_value};
}

// a step applied after the rest to an entry's own value, and noted in its tail: its patches as
// applied there, by position (*applied, malloc'd). one that does not apply is passed over (nothing
// to undo): its code. *owned 0: no own value (or no room for its tail: it is dropped), nothing done
static int onto(tp_history *h, long k, const ref *r, tp_span patches, const op_patch *ps, size_t n,
	const el_anchor *ids, op_patch **applied, size_t *napplied, el_made *made, int *owned) {
	own *m = h->entries[k].mine;
	*owned = 0, *applied = NULL, *napplied = 0;
	if (!m) return 0;
	rung *g = grown(h, m->tail, &m->room, m->n, sizeof *g);
	if (!g) {
		unown(h, &h->entries[k]);
		return 0;
	}
	m->tail = g;
	op_undo u = {NULL, 0, 0};
	el_back back = {NULL, 0, 0};
	el_ctx c = elc(h);
	el_ref er = {r->lamport, r->n, r->seq, r->device};
	m->el.quiet = quiet_at(h, k, r);
	int code = el_step(&c, &m->el, &m->value, &er, patches, ps, n, NULL, ids, 0, &u, &back, applied,
		napplied, NULL, made);
	m->el.quiet = 0;
	// a step that does not apply keeps what notes it landed
	m->tail[m->n++] = (rung){*r, u, back};
	trim(h, m, h->window);
	*owned = 1;
	return code;
}

// an entry's own value undone back through its tail, to t steps
static int unwound(const own *m, size_t t, op_value **value) {
	op_value *v = m->value ? op_ref(m->value) : NULL;
	for (size_t i = m->n; i-- > t;) {
		const op_undo *u = &m->tail[i].undo;
		op_value *out = NULL;
		size_t failed;
		if (!u->n) continue;
		if (op_apply(v, u->patches, u->n, NULL, &out, &failed)) return op_free(v), 0;
		op_free(v), v = out;
	}
	*value = v;
	return 1;
}

// step r read back (its block, for the caller to free) and applied to value and its elements; u, if
// given, gets what undoes the value, bk what undoes the elements
static int apply_ref(tp_history *h, const ref *r, op_value **value, el_state *es, op_undo *u,
	el_back *bk, block **out, int quiet) {
	long length = fetch(h, h->devices[r->device], r->n);
	tp_step s;
	block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
	*out = b;
	if (!b || tp_step_decode(h->bytes.p, (size_t)length, &s)) return TP_STORE;
	el_ctx c = elc(h);
	el_anchor *ids;
	int code = el_read(&c, &s, &ids);
	if (code) return code;
	el_ref er = {r->lamport, r->n, r->seq, r->device};
	es->quiet = quiet;
	code = el_step(&c, es, value, &er, s.patches, b->patches, b->count, NULL, ids, 0, u, bk, NULL, NULL,
		NULL, NULL);
	es->quiet = 0;
	el_anchors_free(&h->mem, ids, s.count);
	return code;
}

// an entry's own value made again from its first step, not written (a write here needs it). NULL: no
// room
static own *rebuild(tp_history *h, long k) {
	tp_buf list = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	size_t count;
	own *m = tp_alloc(&h->mem, sizeof *m);
	if (!m) return NULL;
	memset(m, 0, sizeof *m), m->all = 1;
	if (walked(h, k, NULL, &list, &count)) {
		tp_buf_free(&list);
		tp_free(&h->mem, m, sizeof *m);
		return NULL;
	}
	int ok = 1;
	for (size_t i = 0; i < count && ok; i++) {
		ref r = ((const ref *)list.p)[i];
		op_undo u = {NULL, 0, 0};
		el_back bk = {NULL, 0, 0};
		block *b;
		int code = apply_ref(h, &r, &m->value, &m->el, &u, &bk, &b, quiet_at(h, k, &r));
		if (b) block_free(b);
		if (code) op_undo_free(&u), u = (op_undo){NULL, 0, 0};
		rung *g = grown(h, m->tail, &m->room, m->n, sizeof *g);
		if (!g) {
			op_undo_free(&u), el_back_free(&h->mem, &bk);
			ok = 0;
			break;
		}
		m->tail = g, g[m->n++] = (rung){r, u, bk};
		trim(h, m, h->window);
	}
	tp_buf_free(&list);
	h->entries[k].mine = m;
	if (!ok) return unown(h, &h->entries[k]), NULL;
	return m;
}

// The entry worked out again, for its early steps (lates, n of them; last: the earliest's block):
// its own value undone back to before the earliest when its tail reaches that far, else from the
// first step (or the newest that puts the whole value); each early step a head no more if a step
// after it names it (each step after the earliest read once, for all of them); then every step from
// there applied in order.
static int redo(tp_history *h, long k, block *last, const ref *lates, size_t nlates) {
	const ref *late = lates;
	for (size_t j = 1; j < nlates; j++) {
		if (after(h, late, &lates[j])) late = &lates[j];
	}
	tp_buf list = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	size_t count, t = 0;
	own *m = h->entries[k].mine;
	op_value *value = NULL;
	if (m) {
		for (t = m->n; t > 0 && after(h, &m->tail[t - 1].at, late); t--) {}
	}
	// a tail with a step before the earliest (or every step) reaches; an undo that fails is not trusted
	int reach = m && (t > 0 || m->all) && unwound(m, t, &value);
	if (m && !reach) unown(h, &h->entries[k]), m = NULL;
	uint8_t *done = tp_alloc(&h->mem, nlates);
	h->skipped = 0;
	if (!done || walked(h, k, reach ? late : NULL, &list, &count)) {
		tp_free(&h->mem, done, nlates), tp_buf_free(&list), block_free(last), op_free(value);
		h->entries[k].unsure = 1;
		return TP_NOMEM;
	}
	memset(done, 0, nlates);
	el_state local = {0}, *es = &local;
	if (reach) {
		for (size_t i = m->n; i-- > t;) {
			el_back_undo(&h->mem, &m->el, &m->tail[i].back);
			op_undo_free(&m->tail[i].undo);
		}
		m->n = t, es = &m->el;
	} else {
		// no tail that reaches: made again, from the step the walk began at
		own *fresh = tp_alloc(&h->mem, sizeof *fresh);
		if (fresh) memset(fresh, 0, sizeof *fresh), fresh->all = 1, es = &fresh->el;
		unown(h, &h->entries[k]);
		h->entries[k].mine = m = fresh;
	}
	int twice = 0, dropped = 0, unread = h->skipped;
	size_t left = nlates;
	for (size_t i = 0; i < count && left && !h->forgets; i++) {
		const ref *r = &((const ref *)list.p)[i];
		tp_step s;
		long length = after(h, r, late) ? fetch(h, h->devices[r->device], r->n) : -1;
		if (length < 0 || tp_step_decode(h->bytes.p, (size_t)length, &s)) continue;
		for (size_t j = 0; j < nlates; j++) {
			if (!done[j] && after(h, r, &lates[j]) && covers(h, &s, &lates[j])) {
				named(&h->entries[k], &lates[j]), done[j] = 1, left--;
			}
		}
	}
	tp_free(&h->mem, done, nlates);
	sweep(h, &h->entries[k]);
	for (size_t i = 0; i < count; i++) {
		ref r = ((const ref *)list.p)[i];
		const uint8_t *device = h->devices[r.device];
		block *b;
		op_undo u = {NULL, 0, 0};
		el_back bk = {NULL, 0, 0};
		uint64_t passed = es->passed;
		int code = apply_ref(h, &r, &value, es, m ? &u : NULL, &bk, &b, quiet_at(h, k, &r));
		if (code == TP_STORE) unread = 1;
		// a step of it the store could not give back: a patch passed over may be one that names it
		if (!code && unread && es->passed != passed) code = OP_RANGE;
		failure *was = failed_at(h, device, r.n);
		if (m) {
			rung *g = grown(h, m->tail, &m->room, m->n, sizeof *g);
			if (g) m->tail = g, g[m->n++] = (rung){r, u, bk}, m->n > 2 * h->window ? trim(h, m, h->window) : (void)0;
			else op_undo_free(&u), el_back_free(&h->mem, &bk), dropped = 1, m = NULL;
		} else el_back_free(&h->mem, &bk);
		if (!code) {
			block_free(last), last = b;
			if (was) was->fixed = 1, twice |= failed_after(h, was) != NULL;
			continue;
		}
		if (!was) {
			note_at(h, device, r.n, b ? b->node : "", b ? b->part : "",
				code < 0 ? tp_why(code) : op_code_name(code), r.lamport);
		}
		if (b) block_free(b);
	}
	tp_buf_free(&list);
	if (unread) {
		// a step the store can't give back: what is rebuilt is not the entry, so the value the graph has stays
		op_free(value);
		block_free(last);
		el_state_free(&h->mem, &local);
		unown(h, &h->entries[k]);
		h->entries[k].unsure = 1;
		return 0;
	}
	if (m) {
		trim(h, m, h->window);
		op_free(m->value), m->value = value ? op_ref(value) : NULL;
	} else if (dropped) unown(h, &h->entries[k]);
	el_state_free(&h->mem, &local);
	const char *part = h->entries[k].key, *node = part + strlen(part) + 1;
	const nd_entry *there = tb_get(h->table, tb_string(part), tb_string(node));
	int code = 0;
	if (value || (there && there->value)) whole_of(last, value), code = write(h, last);
	else block_free(last);
	unfail(h, !code);
	h->entries[k].unsure = code != 0 || twice;
	return code;
}

// a step landed early in entry k: its entry waits to be worked out again once (settle). no room to
// note it: worked out now
static int later(tp_history *h, long k, block *b, const ref *late) {
	early e = {k, *late};
	tp_put(&h->early, &e, sizeof e);
	if (h->early.bad) return h->early.bad = 0, redo(h, k, b, late, 1);
	block_free(b);
	h->entries[k].waits = 1;
	return 0;
}

// forgets: an entry's own value is the graph's, held (shared) between steps
static void resync(tp_history *h, long k) {
	own *m = h->entries[k].mine;
	if (!m) return;
	const char *part = h->entries[k].key, *node = part + strlen(part) + 1;
	nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
	op_free(m->value);
	m->value = x && x->value ? op_ref(x->value) : NULL;
}

// forgets: whether any device's first step is let go, asked of the log (a drop by any path counts)
// (the first steps are looked at again when the log has dropped since, or on ask: a store may lose
// steps with no drop)
static int cut(tp_history *h, int ask) {
	if (h->cut || (!ask && h->seen == tp_log_drops(h->log))) return h->cut;
	h->seen = tp_log_drops(h->log);
	for (size_t i = 0; i < tp_log_devices(h->log) && !h->cut; i++) {
		uint64_t have;
		const uint8_t *d = tp_log_have(h->log, i, &have);
		h->cut = tp_log_count(h->log, d) && tp_log_step(h->log, d, 1, NULL, 0) < 0;
	}
	return h->cut;
}

static void into(tp_history *h, long k, block *b, const ref *r, int last, tp_span patches,
	const el_anchor *ids, int again);

// forgets: step n of device read back and gone into entry k
static void again(tp_history *h, long k, const uint8_t device[32], uint64_t n, int last) {
	long length = fetch(h, device, n), d = device_of(h, device);
	tp_step st;
	block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
	el_ctx c = elc(h);
	el_anchor *ids = NULL;
	if (!b || d < 0 || tp_step_decode(h->bytes.p, (size_t)length, &st) || el_read(&c, &st, &ids)) {
		if (b) block_free(b);
		return;
	}
	ref r = {.lamport = st.lamport, .n = n, .seq = st.seq, .device = (uint32_t)d, .head = 1};
	into(h, k, b, &r, last, st.patches, ids, 0);
	el_anchors_free(&h->mem, ids, st.count);
}

// forgets, runs let go: the entry's failed steps the log holds tried again, a late one having gone in
static void retry(tp_history *h, long k) {
	const char *part = h->entries[k].key, *node = part + strlen(part) + 1;
	size_t m = 0, left = 0;
#define OURS(f) ((f)->has_device && !strcmp((f)->node, node) && !strcmp((f)->part, part) && \
	tp_log_step(h->log, (f)->device, (f)->n, NULL, 0) >= 0)
	for (size_t i = 0; i < h->failed.n; i++) m += OURS(&h->failed.items[i]);
	failure *list = m ? tp_alloc(&h->mem, m * sizeof *list) : NULL;
	if (!list) return;
	m = 0;
	for (size_t i = 0; i < h->failed.n; i++) {
		failure f = h->failed.items[i];
		if (OURS(&f)) list[m++] = f, forget(h, &f);
		else h->failed.items[left++] = f;
	}
#undef OURS
	h->failed.n = left;
	for (size_t i = 0; i < m; i++) again(h, k, list[i].device, list[i].n, 0);
	tp_free(&h->mem, list, m * sizeof *list);
}

// forgets: a step into an entry's elements, late or not, its value the graph's (see history.ts)
// forgets: step r, read as b, waits for its entry to be worked out again once the run landing is in
static int waitfor(tp_history *h, long k, block *b, const ref *r) {
	early x = {k, *r};
	tp_put(&h->early, &x, sizeof x);
	if (b) block_free(b);
	if (h->early.bad) return h->early.bad = 0, TP_NOMEM;
	h->entries[k].waits = 1;
	return 0;
}

// forgets: a failed step of the entry is after r (so r may let it apply)
static int enables(const tp_history *h, const char *part, const char *node, const ref *r) {
	for (size_t i = 0; i < h->failed.n; i++) {
		const failure *f = &h->failed.items[i];
		if (!f->has_device || strcmp(f->node, node) || strcmp(f->part, part)) continue;
		if (!f->ordered || r->lamport < f->lamport ||
			(r->lamport == f->lamport && memcmp(h->devices[r->device], f->device, 32) < 0)) return 1;
	}
	return 0;
}

// forgets: an entry that is only the root cell its newest step made holds no state: plain
static void collapse(tp_history *h, long k) {
	entry *e = &h->entries[k];
	if (!h->forgets || !e->mine || e->plain) return;
	el_ref er = {e->one.lamport, e->one.n, e->one.seq, e->one.device};
	if (!el_lone(&e->mine->el, &er)) return;
	unown(h, e);
	e->plain = 1;
	refresh(h, k);
}

static void into(tp_history *h, long k, block *b, const ref *r, int last, tp_span patches,
	const el_anchor *ids, int again) {
	entry *e = &h->entries[k];
	const uint8_t *device = h->devices[r->device];
	const char *part = e->key, *node = part + strlen(part) + 1;
	int code = 0;
	if (e->waits) {
		early x = {k, *r};
		tp_put(&h->early, &x, sizeof x);
		block_free(b);
		if (h->early.bad) h->early.bad = 0, note_at(h, device, r->n, node, part, tp_why(TP_NOMEM), r->lamport);
		return;
	}
	if (!e->mine) {
		// no elements: a put of the whole value, which needs none; else the entry worked out again
		// from the log, if none is let go
		if (last && e->plain) code = write(h, b), refresh(h, k);
		else if (!cut(h, 0)) code = waitfor(h, k, b, r);
		else block_free(b), code = TP_LATE;
		if (code) note_at(h, device, r->n, node, part, code == TP_LATE ? tp_why(TP_LATE)
			: code < 0 ? tp_why(code) : op_code_name(code), r->lamport);
		return;
	}
	el_ctx c = elc(h);
	el_ref er = {r->lamport, r->n, r->seq, r->device};
	el_back back = {NULL, 0, 0};
	op_patch *applied = NULL;
	size_t napplied = 0;
	el_made made = {0};
	resync(h, k);
	e->mine->el.by = 0;
	e->mine->el.quiet = quiet_at(h, k, r);
	code = el_step(&c, &e->mine->el, &e->mine->value, &er, patches, b->patches, b->count, NULL, ids, !last,
		NULL, &back, &applied, &napplied, NULL, &made);
	e->mine->el.quiet = 0;
	el_back_free(&h->mem, &back);
	if (!code) {
		attach(h, b, &made);
		free(b->patches);
		b->patches = applied ? applied : must(1), b->count = napplied;
		if (napplied) code = write(h, b);
		else block_free(b);
		// after a cut, a step with nothing of it in the value, its container made by a failed step, is shown to the host
		if (!code && !napplied && e->mine->el.by && cut(h, 0) &&
			failed_at(h, h->devices[e->mine->el.byd], e->mine->el.byn)) {
			note_at(h, device, r->n, node, part, op_code_name(OP_RANGE), r->lamport);
		}
	} else block_free(b);
	resync(h, k);
	if (!code && last) collapse(h, k);
	int ours = !code && !last && again && enables(h, part, node, r);
	if (!last && !cut(h, 0) && (code || ours)) {
		if (!(code = waitfor(h, k, NULL, r))) return;
	}
	if (code) {
		note_at(h, device, r->n, node, part, code == TP_LATE ? tp_why(TP_LATE)
			: code < 0 ? tp_why(code) : op_code_name(code), r->lamport);
		return;
	}
	if (ours) retry(h, k);
}

// forgets: the entry worked out again from every step of it the log holds (a cursor at each
// device's newest step, the walk reading back from there), its value written whole; some let go:
// each early step as it comes
static int anew(tp_history *h, long k, block *b, const ref *lates, size_t nlates) {
	size_t nd = tp_log_devices(h->log);
	entry *e = &h->entries[k];
	e->plain = 0;
	if (cut(h, 1)) {
		block_free(b);
		uint8_t *done = tp_alloc(&h->mem, nlates);
		if (!done) return TP_NOMEM;
		memset(done, 0, nlates);
		for (size_t i = 0; i < nlates; i++) {
			size_t j = nlates;
			for (size_t x = 0; x < nlates; x++) {
				if (!done[x] && (j == nlates || after(h, &lates[j], &lates[x]))) j = x;
			}
			done[j] = 1;
			again(h, k, h->devices[lates[j].device], lates[j].n, !after(h, &h->entries[k].one, &lates[j]));
		}
		tp_free(&h->mem, done, nlates);
		return 0;
	}
	ref newest = e->one;
	ref *more = nd > 1 ? tp_alloc(&h->mem, (nd - 1) * sizeof *more) : NULL;
	if (nd > 1 && !more) return block_free(b), TP_NOMEM;
	e->more = more, e->count = (uint32_t)nd;
	for (size_t i = 0; i < nd; i++) {
		uint64_t have;
		long d = device_of(h, tp_log_have(h->log, i, &have));
		*at(e, i) = (ref){.n = d < 0 ? 0 : tp_log_count(h->log, h->devices[d]), .device = d < 0 ? 0 : (uint32_t)d};
	}
	int code = redo(h, k, b, lates, nlates);
	e = &h->entries[k];
	if (e->count > 1) tp_free(&h->mem, e->more, (e->count - 1) * sizeof *e->more);
	e->more = NULL, e->count = 1, e->one = newest;
	resync(h, k);
	return code;
}

// each entry steps landed early in, worked out again once, for all of them
static void settle(tp_history *h) {
	size_t n = h->early.len / sizeof(early);
	ref *lates = n ? tp_alloc(&h->mem, n * sizeof *lates) : NULL;
	for (size_t i = 0; i < n; i++) {
		const early *es = (const early *)h->early.p;
		long k = es[i].k;
		if (!h->entries[k].waits) continue;
		h->entries[k].waits = 0;
		// its early steps (no room for the list: the earliest alone), and the earliest
		size_t m = 0;
		ref first = es[i].at;
		for (size_t j = i; j < n; j++) {
			if (es[j].k != k) continue;
			if (lates) lates[m++] = es[j].at;
			if (after(h, &first, &es[j].at)) first = es[j].at;
		}
		const uint8_t *device = h->devices[first.device];
		block *b = read_back(h, device, first.n);
		int code = !b ? TP_STORE : h->forgets ? anew(h, k, b, lates ? lates : &first, lates ? m : 1)
			: redo(h, k, b, lates ? lates : &first, lates ? m : 1);
		if (code) {
			const char *part = h->entries[k].key, *node = part + strlen(part) + 1;
			note_at(h, device, first.n, node, part, code < 0 ? tp_why(code) : op_code_name(code), first.lamport);
		}
	}
	tp_free(&h->mem, lates, n * sizeof *lates);
	h->early.len = 0;
}

// a patch that names a container: every patch but a move
static int needs(const op_patch *p) { return !p->has_move || el_list_move(p); }

static void land(tp_history *h, const uint8_t device[32], uint64_t n) {
	long length = fetch(h, device, n);
	block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
	tp_step st;
	if (!b || tp_step_decode(h->bytes.p, (size_t)length, &st)) {
		if (b) block_free(b);
		note(h, &h->failed, device, n, "", "", tp_why(TP_STORE));
		return;
	}
	uint64_t at = st.seq;
	el_ctx c = elc(h);
	el_anchor *ids = NULL;
	int code = el_read(&c, &st, &ids);
	if (code) {
		block_free(b);
		note_at(h, device, n, "", "", tp_why(code), st.lamport);
		return;
	}
	tp_span patches = st.patches;
	size_t from = 0;
	tp_patch first;
	int whole = !tp_patch_next(patches, &from, &first) && first.path.n == 1 && !first.ranged && !first.move.p;
	int simple = whole && st.count == 1 && first.value.p && !(ids && ids[0].npred);
	long k = entry_of(h, b->part, b->node);
	ref late = {.lamport = (uint64_t)int_of(b->step->items[6]), .n = n, .seq = at};
	ref replaced = {0};
	int last = k < 0 ? -1 : placed(h, k, device, n, late.lamport, at, whole, simple, &replaced);
	if (last >= 0) late.device = (uint32_t)device_of(h, device);
	if (last >= 0 && !h->forgets) {
		unhead(h, &h->entries[k], &st, &late);
		// the device's step before this one, if this names nothing of it, stays a head beside it
		if (replaced.n && replaced.head && !covers(h, &st, &replaced)) ghost(h, k, &replaced);
		sweep(h, &h->entries[k]);
	}
	op_value *s = op_ref(b->step);
	if (last < 0) code = (block_free(b), TP_NOMEM);
	else if (h->forgets) into(h, k, b, &late, last, patches, ids, 1);
	else if (!last) code = later(h, k, b, &late);
	else if (h->entries[k].waits) code = (block_free(b), 0);
	else {
		// by its ids, as its own value has it; with none held, the entry is worked out again
		int owned;
		op_patch *applied;
		size_t napplied;
		el_made made = {0};
		code = onto(h, k, &late, patches, b->patches, b->count, ids, &applied, &napplied, &made, &owned);
		if (owned && code) block_free(b);
		else if (owned) {
			attach(h, b, &made);
			free(b->patches);
			b->patches = applied ? applied : must(1), b->count = napplied;
			if (napplied) code = write(h, b);
			else block_free(b);
		} else {
			int wants = 0;
			for (size_t i = 0; i < b->count; i++) wants |= needs(&b->patches[i]);
			code = wants ? redo(h, k, b, &late, 1) : write(h, b);
		}
	}
	el_anchors_free(&h->mem, ids, st.count);
	if (code) {
		note_at(h, device, n, s->items[3]->str, s->items[4]->str,
			code < 0 ? tp_why(code) : op_code_name(code), late.lamport);
	}
	op_free(s);
}

void tp_history_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	tp_history *h = ctx;
	const uint8_t *me = tp_log_device(h->log);
	if (me && !memcmp(me, device, 32)) return;
	for (size_t i = 0; i < count; i++) land(h, device, from + i);
	settle(h);
}

static int put_snapshot(tp_history *h, CborOut *o) {
	char hex[64];
	size_t devices = tp_log_devices(h->log), kept = 0, lost = 0;
	for (size_t i = 0; i < h->failed.n; i++) lost += h->failed.items[i].has_device;
	cborPutHead(o, 5, lost ? 4 : 3), cborPutText(o, "v", 1), cborPutHead(o, 0, 1);
	cborPutText(o, "count", 5), cborPutHead(o, 5, devices);
	const uint8_t *last = NULL;
	for (size_t k = 0; k < devices; k++) {
		const uint8_t *next = NULL;
		uint64_t have;
		for (size_t i = 0; i < devices; i++) {
			const uint8_t *d = tp_log_have(h->log, i, &have);
			if ((!last || memcmp(d, last, 32) > 0) && (!next || memcmp(d, next, 32) < 0)) next = d;
		}
		tp_hex(hex, next, 32), cborPutText(o, hex, 64), cborPutHead(o, 0, tp_log_count(h->log, next));
		last = next;
	}
	if (lost) {
		cborPutText(o, "failed", 6), cborPutHead(o, 4, lost);
		for (size_t i = 0; i < h->failed.n; i++) {
			const failure *f = &h->failed.items[i];
			if (!f->has_device) continue;
			cborPutHead(o, 4, 5), tp_hex(hex, f->device, 32), cborPutText(o, hex, 64), cborPutHead(o, 0, f->n);
			if (!cborPutText(o, f->node, strlen(f->node)) || !cborPutText(o, f->part, strlen(f->part))) return 0;
			if (f->ordered) cborPutHead(o, 0, f->lamport);
			else cborPutNull(o);
		}
	}
	for (size_t i = 0; i < h->nentries; i++) kept += h->entries[i].count > 0;
	cborPutText(o, "entries", 7), cborPutHead(o, 4, kept);
	for (size_t i = 0; i < h->nentries; i++) {
		entry *e = &h->entries[i];
		const char *part = e->key, *node = part + strlen(part) + 1;
		if (!e->count) continue;
		const nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
		cborPutHead(o, 4, 6);
		if (!cborPutText(o, part, strlen(part)) || !cborPutText(o, node, strlen(node))) return 0;
		if (!x || !x->value) cborPutNull(o);
		else if (cborPutHead(o, 4, 1), !put_value(o, x->value)) return 0;
		cborPutHead(o, 4, e->count);
		const ref *was = NULL;
		for (size_t k = 0; k < e->count; k++) {
			const ref *next = NULL;
			for (size_t j = 0; j < e->count; j++) {
				const ref *r = at(e, j);
				if ((!was || after(h, r, was)) && (!next || after(h, next, r))) next = r;
			}
			tp_hex(hex, h->devices[next->device], 32);
			cborPutHead(o, 4, 4), cborPutHead(o, 0, next->lamport);
			cborPutText(o, hex, 64), cborPutHead(o, 0, next->n), cborPutHead(o, 0, next->seq);
			was = next;
		}
		size_t heads = 0;
		for (size_t k = 0; k < e->count; k++) heads += at(e, k)->head;
		cborPutHead(o, 4, heads);
		for (size_t k = 0; k < e->count; k++) {
			const ref *r = at(e, k);
			if (!r->head) continue;
			size_t place = 0;
			for (size_t j = 0; j < e->count; j++) place += after(h, r, at(e, j));
			cborPutHead(o, 0, place);
		}
		// forgets: its elements (a plain entry's are those of its put)
		if (h->forgets && e->mine) {
			tp_buf b = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
			el_ctx c = elc(h);
			el_save(&b, &c, &e->mine->el);
			if (tp_buf_why(&b)) return tp_buf_free(&b), 0;
			cborPutBytes(o, b.p, b.len), tp_buf_free(&b);
		} else if (h->forgets && e->plain) cborPutBoolean(o, true);
		else cborPutNull(o);
	}
	return 1;
}

int tp_history_snapshot(tp_history *h) {
	CborOut o = {NULL, 0, 0, false};
	if (!put_snapshot(h, &o)) return TP_NOTSTEP;
	uint8_t *bytes = tp_alloc(&h->mem, o.length);
	if (!bytes) return TP_NOMEM;
	CborOut w = {bytes, o.length, 0, false};
	put_snapshot(h, &w);
	int why = tp_log_snapshot(h->log, bytes, o.length);
	tp_free(&h->mem, bytes, o.length);
	return why;
}

typedef struct {
	tp_history *h;
	tp_in in;
	tp_buf names;
	int why;
	int wrapped; // the snapshot marks its format: a value is [v], not v
} unsnapping;

static int unsnap(tp_history *h, tp_in *in, tp_buf *names, int wrapped) {
	tp_span part, node, value = {NULL, 0}, hex;
	uint64_t k, lamport, n;
	uint8_t device[32];
	uint64_t items;
	if (tp_array(in, &items) || items != 6 || tp_text(in, &part) || tp_text(in, &node))
		return TP_NOTSTEP;
	uint64_t held = 0;
	if (!tp_null(in) && ((wrapped && (tp_array(in, &held) || held != 1)) || tp_skip(in, &value))) return TP_NOTSTEP;
	names->len = 0;
	tp_put(names, part.p, part.n), tp_put(names, "", 1), tp_put(names, node.p, node.n), tp_put(names, "", 1);
	if (names->bad) return tp_buf_why(names);
	const char *p = (const char *)names->p, *id = p + part.n + 1;
	long e = entry_of(h, p, id);
	if (e < 0 || tp_array(in, &k)) return e < 0 ? TP_NOMEM : TP_NOTSTEP;
	unplace(h, &h->entries[e]);
	h->entries[e].unsure = 1;
	tp_in list = *in;
	for (uint64_t i = 0; i < k; i++) {
		uint64_t four, seq;
		if (tp_array(in, &four) || four != 4 || tp_whole(in, &lamport) || tp_text(in, &hex) ||
			hex.n != 64 || tp_unhex(device, hex.p, 32) || tp_whole(in, &n) || tp_whole(in, &seq))
			return TP_NOTSTEP;
		if (placed(h, e, device, n, lamport, seq, 0, 0, NULL) < 0) return TP_NOMEM;
	}
	unown(h, &h->entries[e]);
	entry *en = &h->entries[e];
	uint64_t heads = 0, place;
	for (size_t i = 0; i < en->count; i++) at(en, i)->head = 0;
	if (tp_array(in, &heads)) return TP_NOTSTEP;
	for (uint64_t i = 0; i < heads; i++) {
		tp_in t = list;
		uint64_t three;
		if (tp_whole(in, &place) || place >= k) return TP_NOTSTEP;
		for (uint64_t j = 0; j < place; j++) tp_skip(&t, NULL);
		tp_array(&t, &three), tp_whole(&t, &lamport), tp_text(&t, &hex), tp_unhex(device, hex.p, 32);
		tp_whole(&t, &n);
		long d = device_of(h, device);
		if (d < 0) return TP_NOMEM;
		for (size_t j = 0; j < en->count; j++) {
			if (at(en, j)->device == (uint32_t)d && at(en, j)->n == n) at(en, j)->head = 1;
		}
	}
	tp_span elements = {NULL, 0};
	int plain = 0;
	if (in->p < in->end && *in->p == 0xf5) in->p++, plain = 1;
	else if (!tp_null(in) && tp_bytes(in, 0, &elements)) return TP_NOTSTEP;
	if (h->forgets && elements.p) {
		el_ctx c = elc(h);
		own *m = seeded(h, NULL, 0);
		if (!m) return TP_NOMEM;
		int why = el_load(&c, &m->el, elements);
		if (why) return tp_free(&h->mem, m, sizeof *m), why;
		en->mine = m;
	}
	en->plain = (uint8_t)plain;
	if (!value.p) return 0;
	op_value *v = cborRead(value.p, value.n, &maker, NULL, NULL);
	if (!v) return TP_NOTSTEP;
	block *b = must(sizeof *b);
	memset(b, 0, sizeof *b);
	b->actor = op_str("snapshot");
	b->header = (ch_header){.has_time = 1, .time = 0, .actor = b->actor};
	nd_entry *x = nd_make_entry(v, &b->header);
	op_free(v);
	if (!x) abort();
	pl_own(h->places, x);
	pl_hold(h->places, x, b, block_free);
	pl_sub(h->places, tb_string(p), tb_string(id), x);
	refresh(h, e);
	if (h->forgets) resync(h, e);
	return 0;
}

static void unsnap_f(void *data) {
	unsnapping *u = data;
	uint64_t n = 0;
	if (tp_array(&u->in, &n)) u->why = TP_NOTSTEP;
	for (uint64_t i = 0; i < n && !u->why; i++) u->why = unsnap(u->h, &u->in, &u->names, u->wrapped);
}

static uint64_t count_of(tp_span count, const uint8_t device[32]) {
	tp_in in = {count.p, count.p + count.n};
	uint64_t k, n;
	tp_span hex;
	uint8_t d[32];
	if (tp_map(&in, &k)) return 0;
	for (uint64_t i = 0; i < k; i++) {
		if (tp_text(&in, &hex) || tp_whole(&in, &n)) return 0;
		if (hex.n == 64 && !tp_unhex(d, hex.p, 32) && !memcmp(d, device, 32)) return n;
	}
	return 0;
}

// forgets: the failed steps a snapshot holds
static int unfail_load(tp_history *h, tp_span list) {
	tp_in in = {list.p, list.p + list.n};
	uint64_t k;
	if (tp_array(&in, &k)) return TP_NOTSTEP;
	for (uint64_t i = 0; i < k; i++) {
		uint64_t five, n, lamport;
		tp_span hex, node, part;
		uint8_t device[32];
		if (tp_array(&in, &five) || five != 5 || tp_text(&in, &hex) || hex.n != 64 ||
			tp_unhex(device, hex.p, 32) || tp_whole(&in, &n) || tp_text(&in, &node) || tp_text(&in, &part))
			return TP_NOTSTEP;
		char *nd = tp_alloc(&h->mem, node.n + 1), *pt = tp_alloc(&h->mem, part.n + 1);
		if (!nd || !pt) return TP_NOMEM;
		memcpy(nd, node.p, node.n), nd[node.n] = 0, memcpy(pt, part.p, part.n), pt[part.n] = 0;
		int ordered = !tp_null(&in);
		if (ordered && tp_whole(&in, &lamport)) return TP_NOTSTEP;
		if (ordered) note_at(h, device, n, nd, pt, "failed before a reload", lamport);
		else note(h, &h->failed, device, n, nd, pt, "failed before a reload");
		tp_free(&h->mem, nd, node.n + 1), tp_free(&h->mem, pt, part.n + 1);
	}
	return 0;
}

int tp_history_load(tp_history *h) {
	long length = tp_log_snapped(h->log, NULL, 0);
	uint8_t *bytes = length > 0 ? tp_alloc(&h->mem, (size_t)length) : NULL;
	if (length > 0 && !bytes) return TP_NOMEM;
	unsnapping u = {h, {NULL, NULL}, {NULL, 0, 0, 1 << 20, &h->mem, 0}, 0, 0};
	tp_span count = {NULL, 0}, t;
	uint64_t k;
	if (bytes) {
		tp_log_snapped(h->log, bytes, (size_t)length);
		u.in = (tp_in){bytes, bytes + length};
		tp_span lost = {NULL, 0};
		uint64_t format = 0;
		int bad = !tp_canonical(bytes, (size_t)length) || tp_map(&u.in, &k) || !k || tp_text(&u.in, &t);
		// "v" first: the format, 1 (values as [v]); none: before it (a value, null for none)
		if (!bad && tp_is(t, "v")) bad = tp_whole(&u.in, &format) || format != 1 || --k == 0 || tp_text(&u.in, &t);
		u.wrapped = (int)format;
		if (bad || (k != 2 && k != 3) || !tp_is(t, "count") || tp_skip(&u.in, &count) ||
			(k == 3 && (tp_text(&u.in, &t) || !tp_is(t, "failed") || tp_skip(&u.in, &lost))) ||
			tp_text(&u.in, &t) || !tp_is(t, "entries"))
			u.why = TP_NOTSTEP;
		else {
			quietly(h, unsnap_f, &u);
			if (!u.why && lost.p) u.why = unfail_load(h, lost);
		}
	}
	// a snapshot refused: what it made is let go, and every step the log holds lands
	if (u.why) {
		for (size_t i = 0; i < h->nentries; i++) unplace(h, &h->entries[i]);
		count.p = NULL;
	}
	for (size_t i = 0; i < tp_log_devices(h->log); i++) {
		uint8_t device[32];
		uint64_t have;
		memcpy(device, tp_log_have(h->log, i, &have), 32);
		uint64_t from = count.p ? count_of(count, device) : 0, held = tp_log_count(h->log, device);
		for (uint64_t n = from + 1; n <= held; n++) land(h, device, n);
	}
	settle(h);
	tp_buf_free(&u.names);
	tp_free(&h->mem, bytes, length > 0 ? (size_t)length : 0);
	return u.why;
}

static void put_on(tp_history *h, const entry *e, const uint8_t *me, uint64_t n, tp_buf *b) {
	size_t count = 0;
	for (size_t i = 0; i < e->count; i++) count += at((entry *)e, i)->head;
	tp_put_head(b, 4, count);
	const ref *was = NULL;
	for (size_t k = 0; k < count; k++) {
		const ref *next = NULL;
		for (size_t j = 0; j < e->count; j++) {
			const ref *r = at((entry *)e, j);
			if (r->head && (!was || after(h, was, r)) && (!next || after(h, r, next))) next = r;
		}
		const uint8_t *d = h->devices[next->device];
		if (!memcmp(d, me, 32)) tp_put_head(b, 0, n - next->n);
		else tp_put_head(b, 4, 2), tp_put_head(b, 2, 32), tp_put(b, d, 32), tp_put_head(b, 0, next->n);
		was = next;
	}
}

static int kept_by_default(const char *part) {
	return !strcmp(part, "value") || !strcmp(part, "attributes") || !strcmp(part, "children");
}

// what a step undone leaves: its value and elements as before it
static void unstep(tp_history *h, own *m, op_undo *u, el_back *bk) {
	op_value *out;
	size_t failed;
	if (!op_apply(m->value, u->patches, u->n, NULL, &out, &failed)) op_free(m->value), m->value = out;
	op_undo_free(u);
	el_back_undo(&h->mem, &m->el, bk);
	*u = (op_undo){NULL, 0, 0}, *bk = (el_back){NULL, 0, 0};
}

static int record(tp_history *h, const pl_fact *f, long k, int retry);

// the graph's whole value for the entry of f, as a write of its own
static int instead(tp_history *h, const pl_fact *f, long k) {
	const char *part = h->entries[k].key, *node = part + strlen(part) + 1;
	const nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
	op_patch p;
	memset(&p, 0, sizeof p);
	if (x && x->value) p.has_value = 1, p.value = x->value;
	pl_fact g = *f;
	g.patches = &p, g.patches_length = 1;
	return record(h, &g, k, 0);
}

// a write here as a step. 0: none made. a write it can't name goes as the graph's whole value
// instead (retry), which starts the entry's elements again
static int record(tp_history *h, const pl_fact *f, long k, int retry) {
	const char *node = f->id.string, *part = f->part.string;
	const op_patch *first = f->patches_length ? &f->patches[0] : NULL, *ps = f->patches;
	int whole = first && !first->place.length && !first->place.has_range && !first->has_move;
	int simple = whole && f->patches_length == 1 && first->has_value;
	if (h->entries[k].broken && !whole) return retry && instead(h, f, k);
	const op_value *actor = f->change ? f->change->actor : NULL;
	const char *who = actor && actor->type == OP_STR ? actor->str : NULL;
	int64_t when = f->change && f->change->has_time ? f->change->time : (int64_t)time(NULL);
	CborOut o = {NULL, 0, 0, true};
	const uint8_t *me = tp_log_device(h->log);
	int ok = put_patches(&o, ps, f->patches_length) && when >= 0;
	size_t np = f->patches_length;
	op_patch *alt = NULL;
	op_value **texts = NULL;
	size_t ntexts = 0;
	tp_buf on = {NULL, 0, 0, (size_t)-1, &h->mem, 0}, idb = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	if (me) put_on(h, &h->entries[k], me, tp_log_count(h->log, me) + 1, &on);
	// its containers and elements named by ids from the entry's own state,
	// applied there (as the graph has it); a whole value starts them again
	el_ctx c = elc(h);
	el_anchor *named = NULL;
	op_undo u = {NULL, 0, 0};
	el_back bk = {NULL, 0, 0};
	int ids = 0, wants = 0, mistake = 0;
	for (size_t i = 0; i < np; i++) wants |= needs(&ps[i]);
	long mei = me ? device_of(h, me) : -1;
	uint64_t seq = me ? tp_log_seq(h->log, me) : 0;
	own *mine = NULL;
	if (ok && mei >= 0) {
		entry *en = &h->entries[k];
		if (whole && wants && (en->broken || !en->count)) {
			unown(h, en);
			mine = en->mine = seeded(h, NULL, 0);
			if (mine) mine->all = !en->count;
		} else if (!en->broken) {
			mine = en->mine;
			if (!mine && en->count && !h->forgets) mine = rebuild(h, k);
			else if (!mine && en->plain) {
				mine = en->mine = seeded(h, &en->one, holds(en->was));
				en->plain = !mine;
				if (mine) mine->value = en->was, en->was = NULL;
			} else if (!mine && wants && !en->count) {
				mine = en->mine = seeded(h, NULL, 0);
				if (mine) mine->all = 1;
			}
		}
		if (mine && !whole) {
			size_t nalt;
			step_patches(mine->value, ps, np, &alt, &nalt, &texts, &ntexts);
			if (alt) {
				ps = alt, np = nalt;
				free(o.data), o = (CborOut){NULL, 0, 0, true};
				ok = put_patches(&o, ps, np) && when >= 0;
				wants = 0;
				for (size_t i = 0; i < np; i++) wants |= needs(&ps[i]);
			}
		}
		if (alt && !np) {
			// nothing moved: no step
			free(o.data), drop_texts(texts, ntexts, alt);
			el_anchors_free(&h->mem, named, np), tp_buf_free(&idb), tp_buf_free(&on);
			return 0;
		}
		if (mine) {
			el_ref er = {tp_log_lamport(h->log) + 1, tp_log_count(h->log, me) + 1, seq, (uint32_t)mei};
			ids = !el_step(&c, &mine->el, &mine->value, &er, (tp_span){o.data, o.length}, ps, np,
				NULL, NULL, 0, &u, &bk, NULL, NULL, &named, NULL);
			if (!ids) el_back_free(&h->mem, &bk), bk = (el_back){NULL, 0, 0};
			else if (el_named(named, np)) el_write(&idb, &c, named, np, (uint32_t)mei, er.n, er.seq);
		}
		// every patch that names elements has them; nothing else does
		for (size_t i = 0; i < np && ids; i++) {
			if (needs(&ps[i]) != (named && named[i].kind != 0)) mistake = 1;
		}
		if (!ids && wants) mistake = 1;
	}
	if (!idb.len) {
		tp_put_head(&idb, 4, np);
		for (size_t i = 0; i < np; i++) tp_put(&idb, "\xf6", 1);
	}
	// who as the wire has it: the op layer holds a NUL as the two bytes c0 80
	size_t wn = who ? strlen(who) : 0, wm = wn;
	uint8_t *wire = NULL;
	if (who && strstr(who, "\xc0\x80")) {
		wire = tp_alloc(&h->mem, wn), wm = 0;
		for (size_t i = 0; wire && i < wn; i++, wm++) {
			wire[wm] = (uint8_t)who[i];
			if ((uint8_t)who[i] == 0xc0 && i + 1 < wn && (uint8_t)who[i + 1] == 0x80) wire[wm] = 0, i++;
		}
	}
	tp_write w = {{(const uint8_t *)node, strlen(node)}, {(const uint8_t *)part, strlen(part)},
		{o.data, o.length}, {wire ? wire : (const uint8_t *)who, wm}, (uint64_t)when, {on.p, on.len}, {idb.p, idb.len}};
	uint64_t n, lamport;
	int why = !ok ? TP_NOTSTEP : tp_buf_why(&on) ? tp_buf_why(&on) : tp_buf_why(&idb) ? tp_buf_why(&idb)
		: mistake ? TP_NOTSTEP : wm != wn && !wire ? TP_NOMEM : tp_log_write(h->log, &w, &n, &lamport);
	if (wire) tp_free(&h->mem, wire, wn);
	el_anchors_free(&h->mem, named, np), tp_buf_free(&idb), tp_buf_free(&on);
	if (why) {
		// its own value has a write no step holds: undone
		if (ids && mine == h->entries[k].mine) unstep(h, mine, &u, &bk);
		else if (ids) op_undo_free(&u), el_back_free(&h->mem, &bk);
		free(o.data), drop_texts(texts, ntexts, alt);
		if (!whole && retry && instead(h, f, k)) {
			note(h, &h->unkept, NULL, 0, node, part, "a write it can't name, its whole value was put");
			return 1;
		}
		h->entries[k].broken = 1;
		note(h, &h->unkept, NULL, 0, node, part, mistake && why == TP_NOTSTEP ? "its elements can't name it" : tp_why(why));
		return 0;
	}
	h->entries[k].broken = 0;
	int last = placed(h, k, me, n, lamport, seq, whole, simple, NULL);
	ref late = {lamport, n, seq, last >= 0 ? (uint32_t)device_of(h, me) : 0, 1, 0};
	for (size_t i = 0; last >= 0 && i < h->entries[k].count; i++) {
		ref *x = at(&h->entries[k], i);
		x->head = x->device == late.device && x->n == n;
	}
	if (last >= 0) sweep(h, &h->entries[k]);
	int code = 0;
	if (last < 0) {
		code = TP_NOMEM;
		if (ids) op_undo_free(&u), el_back_free(&h->mem, &bk), unown(h, &h->entries[k]);
	} else if (!last) {
		// early (a write here never is): its own value dropped, the entry worked out again now
		if (ids) op_undo_free(&u), el_back_free(&h->mem, &bk), unown(h, &h->entries[k]);
		block *b = read_back(h, me, n);
		code = b ? redo(h, k, b, &late, 1) : TP_STORE;
	} else if (ids) {
		// named: it is in its own value already
		own *m = h->entries[k].mine;
		rung *g = m ? grown(h, m->tail, &m->room, m->n, sizeof *g) : NULL;
		if (g) m->tail = g, m->tail[m->n++] = (rung){late, u, bk}, trim(h, m, h->window);
		else op_undo_free(&u), el_back_free(&h->mem, &bk), unown(h, &h->entries[k]);
	} else if (!h->entries[k].waits) {
		int owned;
		op_patch *applied;
		size_t napplied;
		el_made made = {0};
		onto(h, k, &late, (tp_span){o.data, o.length}, ps, np, NULL, &applied, &napplied, &made, &owned);
		el_made_free(&h->mem, &made);
		free(applied);
	}
	if (h->forgets) resync(h, k), refresh(h, k);
	free(o.data), drop_texts(texts, ntexts, alt);
	if (code) note_at(h, me, n, node, part, code < 0 ? tp_why(code) : op_code_name(code), lamport);
	return 1;
}

static void recorded(const pl_fact *f, void *ctx) {
	tp_history *h = ctx;
	if (h->landing || f->id.symbol || !f->id.string || f->part.symbol || !f->part.string) return;
	const char *node = f->id.string, *part = f->part.string;
	if (!(h->kept ? h->kept(h->ctx, node, part) : kept_by_default(part))) return;
	long k = entry_of(h, part, node);
	if (k < 0) {
		note(h, &h->unkept, NULL, 0, node, part, tp_why(TP_NOMEM));
		return;
	}
	record(h, f, k, 1);
}

tp_history *tp_history_new(const tp_history_options *o) {
	tp_history *h = tp_alloc(&o->mem, sizeof *h);
	if (!h) return NULL;
	memset(h, 0, sizeof *h);
	h->mem = o->mem, h->log = o->log, h->table = o->table, h->places = o->places;
	h->kept = o->kept, h->run = o->run, h->ctx = o->ctx, h->forgets = o->forgets;
	h->window = o->forgets || o->rebase < 0 ? 0 : o->rebase ? (size_t)o->rebase : 256;
	h->bytes = (tp_buf){NULL, 0, 0, TP_RUN, &h->mem, 0};
	h->early = (tp_buf){NULL, 0, 0, (size_t)-1, &h->mem, 0};
	h->nslots = 16;
	if (!(h->slots = tp_alloc(&h->mem, h->nslots * sizeof *h->slots))) {
		return tp_free(&o->mem, h, sizeof *h), NULL;
	}
	memset(h->slots, 0, h->nslots * sizeof *h->slots);
	h->watch = pl_watch_all(h->places, recorded, h);
	return h;
}

static void release(tp_history *h, failures *list) {
	for (size_t i = 0; i < list->n; i++) forget(h, &list->items[i]);
	tp_free(&h->mem, list->items, list->room * sizeof *list->items);
}

void tp_history_free(tp_history *h) {
	if (!h) return;
	pl_stop(h->watch);
	for (size_t i = 0; i < h->nentries; i++) {
		tp_free(&h->mem, h->entries[i].key, h->entries[i].size);
		unplace(h, &h->entries[i]);
	}
	tp_free(&h->mem, h->entries, h->roomentries * sizeof *h->entries);
	tp_free(&h->mem, h->slots, h->nslots * sizeof *h->slots);
	tp_free(&h->mem, h->devices, h->roomdevices * 32);
	release(h, &h->failed), release(h, &h->unkept);
	tp_buf_free(&h->bytes);
	tp_buf_free(&h->early);
	tp_mem mem = h->mem;
	tp_free(&mem, h, sizeof *h);
}

static size_t told(const failures *list, size_t i, tp_failed *out) {
	if (i < list->n) {
		const failure *f = &list->items[i];
		*out = (tp_failed){f->has_device ? f->device : NULL, f->n, f->node ? f->node : "",
			f->part ? f->part : "", f->why};
	}
	return list->n;
}
size_t tp_history_failed(const tp_history *h, size_t i, tp_failed *out) { return told(&h->failed, i, out); }
size_t tp_history_unkept(const tp_history *h, size_t i, tp_failed *out) { return told(&h->unkept, i, out); }

static long found(const tp_history *h, const char *part, const char *node) {
	size_t a = strlen(part), size = a + strlen(node) + 2, mask = h->nslots - 1, x = 2166136261u;
	for (size_t j = 0; j < size; j++) {
		uint8_t c = j < a ? (uint8_t)part[j] : j == a || j == size - 1 ? 0 : (uint8_t)node[j - a - 1];
		x = (x ^ c) * 16777619u;
	}
	for (size_t s = x & mask; h->slots[s]; s = (s + 1) & mask) {
		const entry *e = &h->entries[h->slots[s] - 1];
		if (e->size == size && !memcmp(e->key, part, a + 1) && !strcmp(e->key + a + 1, node)) {
			return (long)h->slots[s] - 1;
		}
	}
	return -1;
}

int tp_history_cells(tp_history *h, const char *node, const char *part, const op_key *path, size_t length,
	tp_version **out, size_t *count) {
	*out = NULL, *count = 0;
	long k = found(h, part, node);
	if (k < 0 || !h->entries[k].count) return 0;
	entry *e = &h->entries[k];
	own *m = e->mine;
	int rebuilt = 0;
	const nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
	if (!x || !x->value) return 0;
	if (!m && h->forgets && e->plain) {
		// one put of the whole value alone: its root cell, made for the asking
		if (!(m = seeded(h, &e->one, holds(x->value)))) return TP_NOMEM;
		rebuilt = 2;
	} else if (!m && !h->forgets) {
		if (!(m = rebuild(h, k))) return 0;
		rebuilt = 1;
	}
	if (!m) return 0;
	el_ctx c = elc(h);
	el_version *vs;
	size_t n;
	int code = el_cells(&c, &m->el, x->value, path, length, &vs, &n);
	if (rebuilt == 1) unown(h, e);
	else if (rebuilt == 2) el_state_free(&h->mem, &m->el), tp_free(&h->mem, m, sizeof *m);
	if (code || !n) return code;
	tp_version *res = malloc(n * sizeof *res);
	if (!res) {
		el_cells_free(&h->mem, vs, n);
		return TP_NOMEM;
	}
	for (size_t i = 0; i < n; i++) {
		res[i] = (tp_version){vs[i].value ? op_ref(vs[i].value) : NULL, h->devices[vs[i].device], vs[i].n};
	}
	el_cells_free(&h->mem, vs, n);
	*out = res, *count = n;
	return 0;
}

long tp_history_empty(tp_history *h) {
	long n = 0;
	for (size_t k = 0; k < h->nentries; k++) {
		entry *e = &h->entries[k];
		for (size_t i = 0; i < e->count; i++) {
			const ref *r = at(e, i);
			if (!e->marked || after(h, r, &e->mark)) e->mark = *r, e->marked = 1;
		}
		own *m = e->mine;
		if (!m) continue;
		long c = el_empty(&h->mem, &m->el);
		if (c < 0) return c;
		n += c;
		trim(h, m, 0);
		if (!h->forgets) m->all = 0;
	}
	return n;
}

void tp_history_trash(const tp_history *h, size_t *count, size_t *bytes) {
	*count = *bytes = 0;
	for (size_t k = 0; k < h->nentries; k++) {
		const own *m = h->entries[k].mine;
		size_t c, b;
		if (!m) continue;
		el_trash(&m->el, &c, &b);
		*count += c, *bytes += b;
	}
}

int tp_history_forget(tp_history *h, const tp_sync *s) {
	if (!h->forgets) return TP_BOUND;
	int why = tp_history_snapshot(h);
	for (size_t i = 0; i < tp_log_devices(h->log) && !why; i++) {
		uint64_t held;
		const uint8_t *device = tp_log_have(h->log, i, &held);
		uint64_t passed = tp_sync_passed(s, device), drop = passed < held ? passed : held;
		why = tp_log_drop(h->log, device, drop);
	}
	return why;
}
