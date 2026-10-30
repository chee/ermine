// The C side of the history (see history.h): records writes made in the graph as steps, and lands
// steps that arrive from elsewhere. Entries are merged in order of lamport, then device.
#include "history.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../encoding/c/cbor.h"
#include "elements.h"
#include "wire.h"

typedef struct {
	uint64_t lamport, n;
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
} entry;

// What an entry holds when rebase is on: the value its steps make as history worked it out, and its
// newest steps in the order applied, each with what undoes it (empty for one that did not apply).
// all: the tail is every step of the entry, so undoing it all leaves nothing.
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
} failure;

typedef struct {
	failure *items;
	size_t n, room;
} failures;

struct tp_history {
	tp_mem mem;
	tp_log *log;
	tb_table *table;
	pl *places;
	int (*kept)(void *ctx, const char *node, const char *part);
	void (*run)(void *ctx, void (*f)(void *data), void *data);
	void *ctx;
	int forgets;
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
	op_key *keys;
	ch_frame *frame;
	ch_header header;
} block;

static void block_free(void *p) {
	block *b = p;
	op_free(b->step), op_free(b->actor), op_free(b->device), op_free(b->whole);
	ch_frame_free(b->frame);
	free(b->patches), free(b->keys), free(b);
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
		(*keys)[i] = k->type == OP_STR ? (op_key){.type = OP_STR_KEY, .s = k->str}
					       : (op_key){.type = OP_NUM_KEY, .n = (long)int_of(k)};
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
	es[h->nentries] = (entry){key, size, {0}, NULL, NULL, 0, 0, 0, 0};
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
	e->more = NULL, e->count = 0;
}

static int placed(tp_history *h, long k, const uint8_t device[32], uint64_t n, uint64_t lamport,
	int whole, ref *replaced) {
	if (replaced) replaced->n = 0;
	long d = device_of(h, device);
	if (d < 0) return -1;
	entry *e = &h->entries[k];
	ref r = {lamport, n, (uint32_t)d, 1, 0}, *mine = NULL;
	int last = 1;
	for (size_t i = 0; i < e->count; i++) {
		ref *x = at(e, i);
		if (after(h, x, &r)) last = 0;
		if (x->device == r.device && !x->ghost) mine = x;
	}
	if (h->forgets) {
		if (last) unplace(h, e), e->one = r, e->count = 1;
		return last;
	}
	if (mine) {
		if (mine->n < n) {
			if (replaced) *replaced = *mine;
			*mine = r;
		}
		return last;
	}
	if (!e->count && !h->forgets && whole) {
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

static int covers(const tp_history *h, const tp_step *s, const ref *r, const ref *x) {
	if (!s->on.p) return after(h, r, x);
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
		if (x->head && !(x->device == r->device && x->n == r->n) && covers(h, s, r, x)) x->head = 0;
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
	}
	if (!c->at.n) return;
	c->at.lamport = s.lamport;
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

static int applies(tp_history *h, const ref *r) {
	block *b = read_back(h, h->devices[r->device], r->n);
	if (!b) return 0;
	op_value *out = NULL;
	size_t failed;
	int ok = !op_apply(NULL, b->patches, b->count, NULL, &out, &failed);
	if (out) op_free(out);
	block_free(b);
	return ok;
}

// Walk back from the frontier, newest first, to the newest step that puts the whole value and
// applies (*whole set); else to the first step. from: only back to that step, whatever puts the
// whole value.
static int walked(tp_history *h, long k, const ref *late, const ref *from, int *whole, tp_buf *out,
	size_t *count) {
	entry *e = &h->entries[k];
	size_t n = e->count;
	if (whole) *whole = 0;
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
			if (!from && late && !e->unsure && c->whole && !after(h, &c->at, late) &&
				applies(h, &c->at)) {
				if (whole) *whole = 1;
				break;
			}
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
	tb_add(h->table, part, id, e);
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
static el_ctx elc(tp_history *h) { return (el_ctx){&h->mem, h, el_index, el_find, el_bytes}; }

// a step applied after the rest to an entry's own value, and noted in its tail: its patches as
// applied there, by position (*applied, malloc'd). one that does not apply is passed over (nothing
// to undo): its code. *owned 0: no own value (or no room for its tail: it is dropped), nothing done
static int onto(tp_history *h, long k, const ref *r, tp_span patches, const op_patch *ps, size_t n,
	const el_anchor *ids, op_patch **applied, size_t *napplied, int *owned) {
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
	el_ref er = {r->lamport, r->n, r->device};
	int code = el_step(&c, &m->el, &m->value, &er, patches, ps, n, NULL, ids, 0, &u, &back, applied,
		napplied, NULL);
	if (code) el_back_free(&h->mem, &back), u = (op_undo){NULL, 0, 0}, back = (el_back){NULL, 0, 0};
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
	el_back *bk, block **out) {
	long length = fetch(h, h->devices[r->device], r->n);
	tp_step s;
	block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
	*out = b;
	if (!b || tp_step_decode(h->bytes.p, (size_t)length, &s)) return TP_STORE;
	el_ctx c = elc(h);
	el_anchor *ids;
	int code = h->forgets ? (ids = NULL, 0) : el_read(&c, &s, &ids);
	if (code) return code;
	el_ref er = {r->lamport, r->n, r->device};
	code = el_step(&c, es, value, &er, s.patches, b->patches, b->count, NULL, ids, 0, u, bk, NULL, NULL,
		NULL);
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
	if (walked(h, k, NULL, NULL, NULL, &list, &count)) {
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
		int code = apply_ref(h, &r, &m->value, &m->el, &u, &bk, &b);
		if (b) block_free(b);
		if (code) op_undo_free(&u), el_back_free(&h->mem, &bk), u = (op_undo){NULL, 0, 0}, bk = (el_back){NULL, 0, 0};
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
	int whole = 0;
	if (m) {
		for (t = m->n; t > 0 && after(h, &m->tail[t - 1].at, late); t--) {}
	}
	// a tail with a step before the earliest (or every step) reaches; an undo that fails is not trusted
	int reach = m && (t > 0 || m->all) && unwound(m, t, &value);
	if (m && !reach) unown(h, &h->entries[k]), m = NULL;
	uint8_t *done = tp_alloc(&h->mem, nlates);
	if (!done || walked(h, k, late, reach ? late : NULL, &whole, &list, &count)) {
		tp_free(&h->mem, done, nlates), tp_buf_free(&list), block_free(last), op_free(value);
		h->entries[k].unsure = 1;
		return TP_NOMEM;
	}
	memset(done, 0, nlates);
	el_state local = {NULL, 0, 0, NULL, 0, 0}, *es = &local;
	if (reach) {
		for (size_t i = m->n; i-- > t;) {
			el_back_undo(&h->mem, &m->el, &m->tail[i].back);
			op_undo_free(&m->tail[i].undo);
		}
		m->n = t, es = &m->el;
	} else if (!h->forgets) {
		// no tail that reaches: made again, from the step the walk began at
		own *fresh = tp_alloc(&h->mem, sizeof *fresh);
		if (fresh) memset(fresh, 0, sizeof *fresh), fresh->all = (uint8_t)!whole, es = &fresh->el;
		unown(h, &h->entries[k]);
		h->entries[k].mine = m = fresh;
	}
	int twice = 0, dropped = 0;
	size_t left = nlates;
	for (size_t i = 0; i < count && left && !h->forgets; i++) {
		const ref *r = &((const ref *)list.p)[i];
		tp_step s;
		long length = after(h, r, late) ? fetch(h, h->devices[r->device], r->n) : -1;
		if (length < 0 || tp_step_decode(h->bytes.p, (size_t)length, &s)) continue;
		for (size_t j = 0; j < nlates; j++) {
			if (!done[j] && after(h, r, &lates[j]) && covers(h, &s, r, &lates[j])) {
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
		int code = apply_ref(h, &r, &value, es, m ? &u : NULL, &bk, &b);
		failure *was = failed_at(h, device, r.n);
		if (code) el_back_free(&h->mem, &bk), bk = (el_back){NULL, 0, 0};
		if (m) {
			rung *g = grown(h, m->tail, &m->room, m->n, sizeof *g);
			if (g) m->tail = g, g[m->n++] = (rung){r, u, bk};
			else op_undo_free(&u), el_back_free(&h->mem, &bk), dropped = 1, m = NULL;
		} else el_back_free(&h->mem, &bk);
		if (!code) {
			block_free(last), last = b;
			if (was) was->fixed = 1, twice |= failed_after(h, was) != NULL;
			continue;
		}
		if (!was) {
			note(h, &h->failed, device, r.n, b ? b->node : "", b ? b->part : "",
				code < 0 ? tp_why(code) : op_code_name(code));
		}
		if (b) block_free(b);
	}
	tp_buf_free(&list);
	if (m) {
		trim(h, m, h->window);
		op_free(m->value), m->value = value ? op_ref(value) : NULL;
	} else if (dropped) unown(h, &h->entries[k]);
	el_state_free(&h->mem, &local);
	whole_of(last, value);
	int code = write(h, last);
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
		int code = !b ? TP_STORE : redo(h, k, b, lates ? lates : &first, lates ? m : 1);
		if (code) {
			const char *part = h->entries[k].key, *node = part + strlen(part) + 1;
			note(h, &h->failed, device, first.n, node, part, code < 0 ? tp_why(code) : op_code_name(code));
		}
	}
	tp_free(&h->mem, lates, n * sizeof *lates);
	h->early.len = 0;
}

static void land(tp_history *h, const uint8_t device[32], uint64_t n) {
	long length = fetch(h, device, n);
	block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
	tp_step st;
	if (!b || tp_step_decode(h->bytes.p, (size_t)length, &st)) {
		if (b) block_free(b);
		note(h, &h->failed, device, n, "", "", tp_why(TP_STORE));
		return;
	}
	el_ctx c = elc(h);
	el_anchor *ids = NULL;
	int code = h->forgets ? (ids = NULL, 0) : el_read(&c, &st, &ids);
	if (code) {
		block_free(b);
		note(h, &h->failed, device, n, "", "", tp_why(code));
		return;
	}
	int named_ids = el_named(ids, st.count);
	tp_span patches = st.patches;
	size_t from = 0;
	tp_patch first;
	int whole = !tp_patch_next(patches, &from, &first) && first.path.n == 1 && !first.ranged && !first.move.p;
	long k = entry_of(h, b->part, b->node);
	ref late = {(uint64_t)int_of(b->step->items[6]), n, 0, 0, 0};
	ref replaced = {0, 0, 0, 0, 0};
	int last = k < 0 ? -1 : placed(h, k, device, n, late.lamport, whole, &replaced);
	if (last >= 0) late.device = (uint32_t)device_of(h, device);
	if (last >= 0 && !h->forgets) {
		unhead(h, &h->entries[k], &st, &late);
		// the device's step before this one, if this names nothing of it, stays a head beside it
		if (replaced.n && replaced.head && !covers(h, &st, &late, &replaced)) ghost(h, k, &replaced);
		sweep(h, &h->entries[k]);
	}
	op_value *s = op_ref(b->step);
	if (last < 0) code = (block_free(b), TP_NOMEM);
	else if (!last && !h->forgets) code = later(h, k, b, &late);
	else if (h->entries[k].waits || !last) code = (block_free(b), 0);
	else {
		// by its ids, as its own value has it; with none held, a step with ids is worked out again
		int owned;
		op_patch *applied;
		size_t napplied;
		code = onto(h, k, &late, patches, b->patches, b->count, ids, &applied, &napplied, &owned);
		if (owned && code) block_free(b);
		else if (owned) {
			free(b->patches);
			b->patches = applied ? applied : must(1), b->count = napplied;
			code = write(h, b);
		} else code = named_ids && !h->forgets ? redo(h, k, b, &late, 1) : write(h, b);
	}
	el_anchors_free(&h->mem, ids, st.count);
	if (code) {
		note(h, &h->failed, device, n, s->items[3]->str, s->items[4]->str,
			code < 0 ? tp_why(code) : op_code_name(code));
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
	size_t devices = tp_log_devices(h->log), kept = 0;
	cborPutHead(o, 5, 2), cborPutText(o, "count", 5), cborPutHead(o, 5, devices);
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
	for (size_t i = 0; i < h->nentries; i++) kept += h->entries[i].count > 0;
	cborPutText(o, "entries", 7), cborPutHead(o, 4, kept);
	for (size_t i = 0; i < h->nentries; i++) {
		entry *e = &h->entries[i];
		const char *part = e->key, *node = part + strlen(part) + 1;
		if (!e->count) continue;
		const nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
		cborPutHead(o, 4, 5);
		if (!cborPutText(o, part, strlen(part)) || !cborPutText(o, node, strlen(node))) return 0;
		if (!x || !x->value) cborPutNull(o);
		else if (!put_value(o, x->value)) return 0;
		cborPutHead(o, 4, e->count);
		const ref *was = NULL;
		for (size_t k = 0; k < e->count; k++) {
			const ref *next = NULL;
			for (size_t j = 0; j < e->count; j++) {
				const ref *r = at(e, j);
				if ((!was || after(h, r, was)) && (!next || after(h, next, r))) next = r;
			}
			tp_hex(hex, h->devices[next->device], 32);
			cborPutHead(o, 4, 3), cborPutHead(o, 0, next->lamport);
			cborPutText(o, hex, 64), cborPutHead(o, 0, next->n);
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
} unsnapping;

static int unsnap(tp_history *h, tp_in *in, tp_buf *names) {
	tp_span part, node, value = {NULL, 0}, hex;
	uint64_t k, lamport, n;
	uint8_t device[32];
	uint64_t items;
	if (tp_array(in, &items) || (items != 4 && items != 5) || tp_text(in, &part) || tp_text(in, &node))
		return TP_NOTSTEP;
	if (!tp_null(in) && tp_skip(in, &value)) return TP_NOTSTEP;
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
		uint64_t three;
		if (tp_array(in, &three) || three != 3 || tp_whole(in, &lamport) || tp_text(in, &hex) ||
			hex.n != 64 || tp_unhex(device, hex.p, 32) || tp_whole(in, &n))
			return TP_NOTSTEP;
		if (placed(h, e, device, n, lamport, 0, NULL) < 0) return TP_NOMEM;
	}
	unown(h, &h->entries[e]);
	entry *en = &h->entries[e];
	uint64_t heads = 0, place;
	ref *newest = NULL;
	for (size_t i = 0; i < en->count; i++) {
		ref *r = at(en, i);
		r->head = 0;
		if (!newest || after(h, r, newest)) newest = r;
	}
	if (items == 4 && newest) newest->head = 1;
	if (items == 5 && tp_array(in, &heads)) return TP_NOTSTEP;
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
	tb_sub(h->table, tb_string(p), tb_string(id), x);
	return 0;
}

static void unsnap_f(void *data) {
	unsnapping *u = data;
	uint64_t n = 0;
	if (tp_array(&u->in, &n)) u->why = TP_NOTSTEP;
	for (uint64_t i = 0; i < n && !u->why; i++) u->why = unsnap(u->h, &u->in, &u->names);
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

int tp_history_load(tp_history *h) {
	long length = tp_log_snapped(h->log, NULL, 0);
	uint8_t *bytes = length > 0 ? tp_alloc(&h->mem, (size_t)length) : NULL;
	if (length > 0 && !bytes) return TP_NOMEM;
	unsnapping u = {h, {NULL, NULL}, {NULL, 0, 0, 1 << 20, &h->mem, 0}, 0};
	tp_span count = {NULL, 0}, t;
	uint64_t k;
	if (bytes) {
		tp_log_snapped(h->log, bytes, (size_t)length);
		u.in = (tp_in){bytes, bytes + length};
		if (!tp_canonical(bytes, (size_t)length) || tp_map(&u.in, &k) || k != 2 || tp_text(&u.in, &t) ||
			!tp_is(t, "count") || tp_skip(&u.in, &count) || tp_text(&u.in, &t) || !tp_is(t, "entries"))
			u.why = TP_NOTSTEP;
		else quietly(h, unsnap_f, &u);
	}
	for (size_t i = 0; i < tp_log_devices(h->log) && !u.why; i++) {
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
	const op_patch *first = f->patches_length ? &f->patches[0] : NULL;
	int whole = first && !first->place.length && !first->place.has_range && !first->has_move;
	if (h->entries[k].broken && !whole) {
		note(h, &h->unkept, NULL, 0, node, part, "its entry has a write not kept");
		return;
	}
	const op_value *actor = f->change ? f->change->actor : NULL;
	const char *who = actor && actor->type == OP_STR ? actor->str : NULL;
	int64_t when = f->change && f->change->has_time ? f->change->time : (int64_t)time(NULL);
	CborOut o = {NULL, 0, 0, true};
	const uint8_t *me = tp_log_device(h->log);
	int ok = put_patches(&o, f->patches, f->patches_length) && when >= 0;
	size_t np = f->patches_length;
	tp_buf on = {NULL, 0, 0, (size_t)-1, &h->mem, 0}, idb = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	if (me) put_on(h, &h->entries[k], me, tp_log_count(h->log, me) + 1, &on);
	// its splices named by ids from the entry's own elements, applied there (as the graph has it);
	// none known, or not applying there: by their ranges
	el_ctx c = elc(h);
	el_anchor *named = NULL;
	op_undo u = {NULL, 0, 0};
	el_back bk = {NULL, 0, 0};
	int ids = 0;
	long mei = me ? device_of(h, me) : -1;
	if (ok && mei >= 0 && !h->forgets && !h->entries[k].broken && !h->entries[k].waits) {
		own *mine = h->entries[k].mine;
		if (!mine && h->entries[k].count) mine = rebuild(h, k);
		if (mine) {
			el_ref er = {tp_log_lamport(h->log) + 1, tp_log_count(h->log, me) + 1, (uint32_t)mei};
			ids = !el_step(&c, &mine->el, &mine->value, &er, (tp_span){o.data, o.length}, f->patches, np,
				NULL, NULL, 1, &u, &bk, NULL, NULL, &named);
			if (!ids) el_back_free(&h->mem, &bk), bk = (el_back){NULL, 0, 0}, unown(h, &h->entries[k]);
			else if (el_named(named, np)) el_write(&idb, &c, named, np, (uint32_t)mei, er.lamport);
		}
	}
	tp_write w = {{(const uint8_t *)node, strlen(node)}, {(const uint8_t *)part, strlen(part)},
		{o.data, o.length}, {(const uint8_t *)who, who ? strlen(who) : 0}, (uint64_t)when,
		{on.p, on.len}, {idb.p, idb.len}};
	uint64_t n, lamport;
	int why = !ok ? TP_NOTSTEP : tp_buf_why(&on) ? tp_buf_why(&on) : tp_buf_why(&idb) ? tp_buf_why(&idb)
		: tp_log_write(h->log, &w, &n, &lamport);
	el_anchors_free(&h->mem, named, np), tp_buf_free(&idb), tp_buf_free(&on);
	if (why) {
		// its own value has a write no step holds: made again when next needed
		if (ids) op_undo_free(&u), el_back_free(&h->mem, &bk), unown(h, &h->entries[k]);
		free(o.data);
		h->entries[k].broken = 1;
		note(h, &h->unkept, NULL, 0, node, part, tp_why(why));
		return;
	}
	h->entries[k].broken = 0;
	int last = placed(h, k, me, n, lamport, whole, NULL);
	ref late = {lamport, n, last >= 0 ? (uint32_t)device_of(h, me) : 0, 1, 0};
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
		onto(h, k, &late, (tp_span){o.data, o.length}, f->patches, np, NULL, &applied, &napplied, &owned);
		free(applied);
	}
	free(o.data);
	if (code) note(h, &h->failed, me, n, node, part, code < 0 ? tp_why(code) : op_code_name(code));
}


tp_history *tp_history_new(const tp_history_options *o) {
	tp_history *h = tp_alloc(&o->mem, sizeof *h);
	if (!h) return NULL;
	memset(h, 0, sizeof *h);
	h->mem = o->mem, h->log = o->log, h->table = o->table, h->places = o->places;
	h->kept = o->kept, h->run = o->run, h->ctx = o->ctx, h->forgets = o->forgets;
	h->window = o->forgets || o->rebase < 0 ? 0 : o->rebase ? (size_t)o->rebase : 256;
	h->bytes = (tp_buf){NULL, 0, 0, 1 << 20, &h->mem, 0};
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

static size_t heads_of(const tp_history *h, const entry *e, ref *out) {
	size_t n = 0;
	const ref *was = NULL;
	for (;;) {
		const ref *next = NULL;
		for (size_t j = 0; j < e->count; j++) {
			const ref *r = at((entry *)e, j);
			if (r->head && (!was || after(h, was, r)) && (!next || after(h, r, next))) next = r;
		}
		if (!next || n == TP_VERSIONS - 1) return n;
		out[n++] = *next, was = next;
	}
}

size_t tp_history_heads(const tp_history *h, const char *node, const char *part, size_t i,
	const uint8_t **device, uint64_t *n) {
	long k = found(h, part, node);
	ref hs[TP_VERSIONS];
	size_t count = k < 0 ? 0 : heads_of(h, &h->entries[k], hs);
	if (i < count) *device = h->devices[hs[i].device], *n = hs[i].n;
	return count;
}

static int overlap(tp_span a, tp_span b) {
	tp_in x = {a.p, a.p + a.n}, y = {b.p, b.p + b.n};
	uint64_t m, n;
	if (tp_array(&x, &m) || tp_array(&y, &n)) return 1;
	for (uint64_t i = 0; i < m && i < n; i++) {
		tp_span s, t;
		if (tp_skip(&x, &s) || tp_skip(&y, &t) || s.n != t.n || memcmp(s.p, t.p, s.n)) return 0;
	}
	return 1;
}

static tp_span move_path(tp_span move) {
	tp_in in = {move.p, move.p + move.n};
	uint64_t k;
	tp_span key, v = {NULL, 0};
	tp_map(&in, &k);
	for (uint64_t i = 0; i < k; i++) {
		tp_text(&in, &key), tp_skip(&in, &v);
		if (tp_is(key, "path")) return v;
	}
	return v;
}

static size_t touched(const tp_patch *p, tp_span out[2]) {
	out[0] = p->path;
	if (!p->move.p) return 1;
	out[1] = move_path(p->move);
	return 2;
}

static uint8_t *bytes_of(const op_value *v, size_t *n) {
	CborOut o = {NULL, 0, 0, true};
	if (v && !put_value(&o, v)) {
		free(o.data);
		*n = 0;
		return NULL;
	}
	*n = o.length;
	return o.data ? o.data : must(1);
}

size_t tp_history_versions(tp_history *h, const char *node, const char *part, tp_version out[TP_VERSIONS]) {
	long k = found(h, part, node);
	if (k < 0 || !h->entries[k].count) return 0;
	ref hs[TP_VERSIONS];
	size_t nh = heads_of(h, &h->entries[k], hs), count = 0, m = 0, listed = 0, values = 0;
	const nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
	out[count++] = (tp_version){x && x->value ? op_ref(x->value) : NULL, NULL, 0};
	tp_buf list = {NULL, 0, 0, (size_t)-1, &h->mem, 0}, side = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	uint32_t *seen = NULL;
	uint8_t *bytes[TP_VERSIONS];
	size_t sizes[TP_VERSIONS];
	if (h->forgets || nh < 2 || walked(h, k, NULL, NULL, NULL, &list, &m) || !m) goto done;
	const ref *steps = (const ref *)list.p;
	uint32_t all = (1u << nh) - 1;
	if (!(seen = tp_alloc(&h->mem, m * sizeof *seen))) goto done;
	memset(seen, 0, m * sizeof *seen);
	for (size_t j = 0; j < nh; j++) {
		for (size_t i = 0; i < m; i++) {
			if (steps[i].device == hs[j].device && steps[i].n == hs[j].n) seen[i] |= 1u << j;
		}
	}
	for (size_t i = m; i-- > 0;) {
		tp_step s;
		long length = seen[i] ? fetch(h, h->devices[steps[i].device], steps[i].n) : -1;
		if (length < 0 || tp_step_decode(h->bytes.p, (size_t)length, &s)) continue;
		if (!s.on.p) {
			for (size_t j = 0; j < i; j++) seen[j] |= seen[i];
			continue;
		}
		size_t at = 0;
		const uint8_t *d;
		uint64_t n;
		while (!tp_on_next(&s, &at, &d, &n)) {
			for (size_t j = 0; j < i; j++) {
				if (steps[j].n == n && !memcmp(h->devices[steps[j].device], d, 32)) seen[j] |= seen[i];
			}
		}
	}
	size_t start = 0;
	for (size_t i = m; i-- > 1 && !start;) {
		tp_step s;
		tp_patch p;
		size_t at = 0;
		long length = seen[i] == all ? fetch(h, h->devices[steps[i].device], steps[i].n) : -1;
		if (length >= 0 && !tp_step_decode(h->bytes.p, (size_t)length, &s) &&
			!tp_patch_next(s.patches, &at, &p) && p.path.n == 1 && !p.ranged && !p.move.p)
			start = i;
	}
	bytes[listed] = bytes_of(out[0].value, &sizes[listed]), listed++;
	for (size_t j = 0; j < nh; j++) {
		uint32_t bit = 1u << j;
		side.len = 0;
		for (size_t i = start; i < m; i++) {
			tp_step s;
			tp_patch p;
			tp_span t[2];
			long length = seen[i] & bit && seen[i] != all ? fetch(h, h->devices[steps[i].device], steps[i].n) : -1;
			if (length < 0 || tp_step_decode(h->bytes.p, (size_t)length, &s)) continue;
			for (size_t at = 0; !tp_patch_next(s.patches, &at, &p);) {
				for (size_t q = 0, nt = touched(&p, t); q < nt; q++) tp_put(&side, t[q].p, t[q].n);
			}
		}
		if (tp_buf_why(&side)) break;
		op_value *value = NULL;
		el_state es = {NULL, 0, 0, NULL, 0, 0};
		for (size_t i = start; i < m; i++) {
			long length = fetch(h, h->devices[steps[i].device], steps[i].n);
			block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
			tp_step s;
			if (!b || tp_step_decode(h->bytes.p, (size_t)length, &s)) {
				if (b) block_free(b);
				continue;
			}
			size_t left = 0, q = 0;
			tp_patch p;
			uint8_t *keep = must(s.count);
			for (size_t at = 0; !tp_patch_next(s.patches, &at, &p); q++) {
				tp_span t[2];
				int clash = 0;
				for (size_t r = 0, nt = touched(&p, t); r < nt && !(seen[i] & bit) && !clash; r++) {
					tp_in in = {side.p, side.p + side.len};
					tp_span y;
					while (!clash && in.p < in.end && !tp_skip(&in, &y)) clash = overlap(t[r], y);
				}
				keep[q] = !clash, left += !clash;
			}
			el_ctx c = elc(h);
			el_anchor *ids;
			if (left && !el_read(&c, &s, &ids)) {
				el_back bk = {NULL, 0, 0};
				el_ref er = {steps[i].lamport, steps[i].n, steps[i].device};
				el_step(&c, &es, &value, &er, s.patches, b->patches, b->count, keep, ids, 0, NULL, &bk,
					NULL, NULL, NULL);
				el_back_free(&h->mem, &bk);
				el_anchors_free(&h->mem, ids, s.count);
			}
			free(keep);
			block_free(b);
		}
		el_state_free(&h->mem, &es);
		size_t n;
		uint8_t *v = bytes_of(value, &n);
		int known = !v;
		for (size_t i = 0; i < listed && !known; i++) known = sizes[i] == n && !memcmp(bytes[i], v, n);
		if (known) {
			free(v), op_free(value);
			continue;
		}
		bytes[listed] = v, sizes[listed++] = n;
		out[count++] = (tp_version){value, h->devices[hs[j].device], hs[j].n};
	}
done:
	for (size_t i = 0; i < listed; i++) free(bytes[i]);
	tp_buf_free(&list), tp_buf_free(&side);
	tp_free(&h->mem, seen, m * sizeof *seen);
	for (size_t i = 0; i < count; i++) values += out[i].value != NULL;
	if (!values) count = 0;
	return count;
}


int tp_history_forget(tp_history *h, const tp_sync *s) {
	if (!h->forgets) return TP_BOUND;
	int why = tp_history_snapshot(h);
	for (size_t i = 0; i < tp_log_devices(h->log) && !why; i++) {
		uint64_t held;
		const uint8_t *device = tp_log_have(h->log, i, &held);
		uint64_t passed = tp_sync_passed(s, device);
		why = tp_log_drop(h->log, device, passed < held ? passed : held);
	}
	return why;
}
