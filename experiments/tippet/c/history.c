// The C side of the history (see history.h): records writes made in the graph as steps, and lands
// steps that arrive from elsewhere. Entries are merged in order of lamport, then device.
#include "history.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../encoding/c/cbor.h"
#include "wire.h"

typedef struct {
	uint64_t lamport, n;
	uint32_t device;
	uint8_t head;
} ref;

// A kept entry, keyed by part and node. broken: a write here was not kept. unsure: the list of
// failed
// steps may be incomplete, so the next walk goes back to the first step.
typedef struct {
	char *key;
	size_t size;
	ref one, *more;
	uint32_t count;
	uint8_t broken, unsure;
} entry;

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
	pl_watch *watch;
	entry *entries;
	size_t nentries, roomentries;
	size_t *slots, nslots;
	uint8_t (*devices)[32];
	size_t ndevices, roomdevices;
	failures failed, unkept;
	int landing;
	tp_buf bytes;
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
	es[h->nentries] = (entry){key, size, {0}, NULL, 0, 0, 0};
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

static void unplace(tp_history *h, entry *e) {
	if (e->count > 1) tp_free(&h->mem, e->more, (e->count - 1) * sizeof *e->more);
	e->more = NULL, e->count = 0;
}

static int placed(tp_history *h, long k, const uint8_t device[32], uint64_t n, uint64_t lamport) {
	long d = device_of(h, device);
	if (d < 0) return -1;
	entry *e = &h->entries[k];
	ref r = {lamport, n, (uint32_t)d, 1}, *mine = NULL;
	int last = 1;
	for (size_t i = 0; i < e->count; i++) {
		ref *x = at(e, i);
		if (after(h, x, &r)) last = 0;
		if (x->device == r.device) mine = x;
	}
	if (h->forgets) {
		if (last) unplace(h, e), e->one = r, e->count = 1;
		return last;
	}
	if (mine) {
		if (mine->n < n) *mine = r;
		return last;
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
// applies; else to the first step.
static int walked(tp_history *h, long k, const ref *late, tp_buf *out, size_t *count) {
	entry *e = &h->entries[k];
	size_t n = e->count;
	cursor *cs = tp_alloc(&h->mem, n * sizeof *cs);
	if (!cs) return TP_NOMEM;
	for (size_t i = 0; i < n; i++) cs[i].at = *at(e, i), look(h, e, &cs[i]);
	for (;;) {
		cursor *c = NULL;
		for (size_t i = 0; i < n; i++) {
			if (cs[i].at.n && (!c || after(h, &cs[i].at, &c->at))) c = &cs[i];
		}
		if (!c) break;
		if (c->ours) {
			tp_put(out, &c->at, sizeof c->at);
			if (tp_buf_why(out)) break;
			if (late && !e->unsure && c->whole && !after(h, &c->at, late) && applies(h, &c->at)) break;
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

static int redo(tp_history *h, long k, block *last, const ref *late) {
	tp_buf list = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	size_t count;
	if (walked(h, k, late, &list, &count)) {
		tp_buf_free(&list), block_free(last);
		h->entries[k].unsure = 1;
		return TP_NOMEM;
	}
	op_value *value = NULL;
	int twice = 0;
	for (size_t i = 0; i < count && !h->forgets; i++) {
		const ref *r = &((const ref *)list.p)[i];
		tp_step s;
		long length = after(h, r, late) ? fetch(h, h->devices[r->device], r->n) : -1;
		if (length >= 0 && !tp_step_decode(h->bytes.p, (size_t)length, &s) && covers(h, &s, r, late)) {
			named(&h->entries[k], late);
			break;
		}
	}
	for (size_t i = 0; i < count; i++) {
		ref r = ((const ref *)list.p)[i];
		const uint8_t *device = h->devices[r.device];
		block *b = read_back(h, device, r.n);
		op_value *out = NULL;
		size_t failed;
		int code = b ? op_apply(value, b->patches, b->count, NULL, &out, &failed) : TP_STORE;
		failure *was = failed_at(h, device, r.n);
		if (!code) {
			op_free(value), value = out;
			block_free(last), last = b;
			if (was) was->fixed = 1, twice |= failed_after(h, was) != NULL;
			continue;
		}
		if (!was) {
			note(h, &h->failed, device, r.n, b ? b->node : "", b ? b->part : "",
				b ? op_code_name(code) : tp_why(code));
		}
		if (b) block_free(b);
	}
	tp_buf_free(&list);
	whole_of(last, value);
	int code = write(h, last);
	unfail(h, !code);
	h->entries[k].unsure = code != 0 || twice;
	return code;
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
	long k = entry_of(h, b->part, b->node);
	ref late = {(uint64_t)int_of(b->step->items[6]), n, 0, 0};
	int last = k < 0 ? -1 : placed(h, k, device, n, late.lamport);
	if (last >= 0) late.device = (uint32_t)device_of(h, device);
	if (last >= 0 && !h->forgets) unhead(h, &h->entries[k], &st, &late);
	op_value *s = op_ref(b->step);
	int code = last < 0 ? (block_free(b), TP_NOMEM)
		: last         ? write(h, b)
		: h->forgets   ? (block_free(b), 0)
			       : redo(h, k, b, &late);
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
		if (placed(h, e, device, n, lamport) < 0) return TP_NOMEM;
	}
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
	tp_buf on = {NULL, 0, 0, (size_t)-1, &h->mem, 0};
	if (me) put_on(h, &h->entries[k], me, tp_log_count(h->log, me) + 1, &on);
	tp_write w = {{(const uint8_t *)node, strlen(node)}, {(const uint8_t *)part, strlen(part)},
		{o.data, o.length}, {(const uint8_t *)who, who ? strlen(who) : 0}, (uint64_t)when,
		{on.p, on.len}};
	uint64_t n, lamport;
	int why = !ok ? TP_NOTSTEP : tp_buf_why(&on) ? tp_buf_why(&on) : tp_log_write(h->log, &w, &n, &lamport);
	free(o.data), tp_buf_free(&on);
	if (why) {
		h->entries[k].broken = 1;
		note(h, &h->unkept, NULL, 0, node, part, tp_why(why));
		return;
	}
	h->entries[k].broken = 0;
	int last = placed(h, k, me, n, lamport);
	ref late = {lamport, n, last >= 0 ? (uint32_t)device_of(h, me) : 0, 1};
	for (size_t i = 0; last >= 0 && i < h->entries[k].count; i++) {
		ref *x = at(&h->entries[k], i);
		x->head = x->device == late.device && x->n == n;
	}
	block *b = last ? NULL : read_back(h, me, n);
	int code = last < 0 ? TP_NOMEM : b ? redo(h, k, b, &late) : last ? 0 : TP_STORE;
	if (code) note(h, &h->failed, me, n, node, part, code < 0 ? tp_why(code) : op_code_name(code));
}


tp_history *tp_history_new(const tp_history_options *o) {
	tp_history *h = tp_alloc(&o->mem, sizeof *h);
	if (!h) return NULL;
	memset(h, 0, sizeof *h);
	h->mem = o->mem, h->log = o->log, h->table = o->table, h->places = o->places;
	h->kept = o->kept, h->run = o->run, h->ctx = o->ctx, h->forgets = o->forgets;
	h->bytes = (tp_buf){NULL, 0, 0, 1 << 20, &h->mem, 0};
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
	if (h->forgets || nh < 2 || walked(h, k, NULL, &list, &m) || !m) goto done;
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
		for (size_t i = start; i < m; i++) {
			long length = fetch(h, h->devices[steps[i].device], steps[i].n);
			block *b = length < 0 ? NULL : block_of(h->bytes.p, (size_t)length);
			tp_step s;
			if (!b || tp_step_decode(h->bytes.p, (size_t)length, &s)) {
				if (b) block_free(b);
				continue;
			}
			size_t kept = 0, q = 0;
			tp_patch p;
			for (size_t at = 0; !tp_patch_next(s.patches, &at, &p); q++) {
				tp_span t[2];
				int clash = 0;
				for (size_t r = 0, nt = touched(&p, t); r < nt && !(seen[i] & bit) && !clash; r++) {
					tp_in in = {side.p, side.p + side.len};
					tp_span y;
					while (!clash && in.p < in.end && !tp_skip(&in, &y)) clash = overlap(t[r], y);
				}
				if (!clash) b->patches[kept++] = b->patches[q];
			}
			op_value *next = NULL;
			size_t failed;
			if (kept && !op_apply(value, b->patches, kept, NULL, &next, &failed)) op_free(value), value = next;
			else if (next) op_free(next);
			block_free(b);
		}
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
