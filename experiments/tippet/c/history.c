// history (history.h): the recorder, on places' pl_watch_all; the lander, on the log's told; and
// the merge, each entry's steps in order of lamport, then device
#include "history.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "../../../ermine/encoding/c/cbor.h"
#include "wire.h"

// a step, as an entry's list holds it: device, its place in the history's devices
typedef struct {
	uint64_t lamport, n;
	uint32_t device;
} ref;

// a kept entry's steps, in order; key: part \0 node \0; broken: it has a write here that wasn't
// kept, so its patches stay here until a whole write is kept
typedef struct {
	char *key;
	size_t size;
	ref *refs;
	size_t count, room;
	int broken;
} entry;

// a step that didn't land, or a write not kept (no device); fixed: it applied in a redo
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
	// not a history keeper (history.h)
	int forgets;
	pl_watch *watch;
	entry *entries;
	size_t nentries, roomentries;
	// entries by key: their place + 1, 0 none; a power of 2 of them
	size_t *slots, nslots;
	uint8_t (*devices)[32];
	size_t ndevices, roomdevices;
	failures failed, unkept;
	// writing into the graph: what is written then is not recorded
	int landing;
	// a step's bytes, read back from the log
	tp_buf bytes;
};

// ---- values in cbor, and back

// what the graph is made of is malloc'd, as everywhere in core: out of memory aborts
static void *must(size_t n) {
	void *p = malloc(n ? n : 1);
	if (!p) abort();
	return p;
}

// a map's keys in their encodings' order: indexes, merge-sorted, no recursion
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

// a container being written: its items written up to at, a map's in order
typedef struct {
	const op_value *v;
	size_t at, *order;
} level;

// a value's canonical cbor, as cbor.ts writes it, the containers open on a stack. 0: it has none
// (a string not UTF-8, nested past CBOR_DEPTH)
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
				// a stand-in, list or map: open, its items next
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
		// the next item: the innermost open container's
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

// a target's path, and its range when it has one: {path, range?}'s fields
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

// patches as a step holds them: [{move?, path, range?, value?}], keys in their encodings' order
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

// cbor's items as op's values
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

// ---- a step, as the graph is given it

// a step decoded into op's values, and what an entry's change refers to: its patches, their keys,
// its header. held by the entry it was written to, until the next write there
typedef struct {
	op_value *step, *actor, *device, *whole;
	const char *node, *part;
	op_patch *patches;
	size_t count;
	op_key *keys;
	ch_entry metadata[3];
	ch_header header;
} block;

static void block_free(void *p) {
	block *b = p;
	op_free(b->step), op_free(b->actor), op_free(b->device), op_free(b->whole);
	free(b->patches), free(b->keys), free(b);
}

static int64_t int_of(const op_value *v) {
	int64_t n = 0;
	op_as_int64(v, &n);
	return n;
}

// a target from its map, its path's keys from *keys on
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

// a step's bytes (one the log holds: a step) as a block. its header, as history.ts makes it:
// time its when, actor its who or else its device, metadata {device, n, lamport}
static block *block_of(const uint8_t *bytes, size_t length) {
	op_value *s = cborRead(bytes, length, &maker, NULL, NULL);
	if (!s) return NULL;
	block *b = must(sizeof *b);
	memset(b, 0, sizeof *b);
	b->step = s;
	if (s->items[3]->type == OP_LIST) {
		// a node relative to the step's device: its id, whole
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
	b->actor = op_ref(s->count == 9 ? s->items[8] : b->device);
	b->metadata[0] = (ch_entry){"device", b->device};
	b->metadata[1] = (ch_entry){"n", s->items[1]};
	b->metadata[2] = (ch_entry){"lamport", s->items[6]};
	b->header = (ch_header){.has_time = 1, .time = int_of(s->items[7]), .actor = b->actor,
		.metadata = b->metadata, .metadata_length = 3};
	return b;
}

// its patches one whole value: a put at [] (value NULL: a removal), held by the block
static void whole_of(block *b, op_value *value) {
	free(b->patches), free(b->keys);
	b->keys = NULL, b->count = 1, b->whole = value;
	b->patches = must(sizeof *b->patches);
	memset(b->patches, 0, sizeof *b->patches);
	b->patches->has_value = value != NULL, b->patches->value = value;
}

// ---- the history's own

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

// a step in failed, or NULL
static failure *failed_at(const tp_history *h, const uint8_t *device, uint64_t n) {
	for (size_t i = 0; i < h->failed.n; i++) {
		failure *f = &h->failed.items[i];
		if (f->n == n && !memcmp(f->device, device, 32)) return f;
	}
	return NULL;
}

static void forget(tp_history *h, const failure *f) {
	if (f->node) tp_free(&h->mem, f->node, strlen(f->node) + 1);
	if (f->part) tp_free(&h->mem, f->part, strlen(f->part) + 1);
}

// those failed that applied in a redo: out once its write held, else kept
static void unfail(tp_history *h, int held) {
	size_t k = 0;
	for (size_t i = 0; i < h->failed.n; i++) {
		failure f = h->failed.items[i];
		if (held && f.fixed) forget(h, &f);
		else f.fixed = 0, h->failed.items[k++] = f;
	}
	h->failed.n = k;
}

// a device's place in devices, made when there is none; -1: no memory
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

// the entry of part and node, made when there is none: its place, or -1 (no memory)
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
	es[h->nentries] = (entry){key, size, NULL, 0, 0, 0};
	h->slots[s] = ++h->nentries;
	// at half full, the slots twice as many
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

// a step into its entry's list: 1 it went last, 0 not; -1 no memory
static int placed(tp_history *h, long k, const uint8_t device[32], uint64_t n, uint64_t lamport) {
	long d = device_of(h, device);
	if (d < 0) return -1;
	entry *e = &h->entries[k];
	ref *refs = grown(h, e->refs, &e->room, e->count, sizeof *refs);
	if (!refs) return -1;
	e->refs = refs;
	size_t i = e->count;
	while (i > 0 && (refs[i - 1].lamport > lamport ||
		(refs[i - 1].lamport == lamport && memcmp(h->devices[refs[i - 1].device], device, 32) > 0)))
		i--;
	// forgets: the list is the newest alone, and one older is not put in
	if (h->forgets && i < e->count) return 0;
	if (h->forgets) e->count = i = 0;
	memmove(&refs[i + 1], &refs[i], (e->count - i) * sizeof *refs);
	refs[i] = (ref){lamport, n, (uint32_t)d};
	return ++e->count == i + 1;
}

// a step the log holds, as a block; NULL: not held (or no memory)
static block *read_back(tp_history *h, const uint8_t device[32], uint64_t n) {
	long length = tp_log_step(h->log, device, n, NULL, 0);
	h->bytes.len = 0, h->bytes.bad = 0;
	if (length < 0 || !tp_reserve(&h->bytes, (size_t)length)) return NULL;
	tp_log_step(h->log, device, n, h->bytes.p, (size_t)length);
	return block_of(h->bytes.p, (size_t)length);
}

// ---- into the graph

typedef struct {
	tp_history *h;
	block *b;
	int code, held;
} writing;

// the graph's entry made what a block says: its patches applied, or a whole value put
static void write_f(void *data) {
	writing *w = data;
	tp_history *h = w->h;
	block *b = w->b;
	tb_key part = tb_string(b->part), id = tb_string(b->node);
	nd_entry *e = tb_get(h->table, part, id);
	size_t failed;
	if (e) {
		if ((w->code = nd_update(e, b->patches, b->count, b->header, &failed))) return;
		// held before it is told, so what is told of it in turn holds its own after it
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

// f(data), in the host's run, its writes not recorded
static void quietly(tp_history *h, void (*f)(void *data), void *data) {
	int was = h->landing;
	h->landing = 1;
	if (h->run) h->run(h->ctx, f, data);
	else f(data);
	h->landing = was;
}

// a block written, inside the host's run; the block the graph's, or let go. 0, or op's code
static int write(tp_history *h, block *b) {
	writing w = {h, b, 0, 0};
	quietly(h, write_f, &w);
	if (!w.held) block_free(b);
	return w.code;
}

// an entry worked out again from all its steps, from nothing; last: the step that brought it
// here, the header's if none of them applies
static int redo(tp_history *h, long k, block *last) {
	op_value *value = NULL;
	for (size_t i = 0; i < h->entries[k].count; i++) {
		ref r = h->entries[k].refs[i];
		const uint8_t *device = h->devices[r.device];
		block *b = read_back(h, device, r.n);
		op_value *out = NULL;
		size_t failed;
		int code = b ? op_apply(value, b->patches, b->count, NULL, &out, &failed) : TP_STORE;
		failure *was = failed_at(h, device, r.n);
		if (!code) {
			op_free(value), value = out;
			block_free(last), last = b;
			if (was) was->fixed = 1;
			continue;
		}
		if (!was) {
			note(h, &h->failed, device, r.n, b ? b->node : "", b ? b->part : "",
				b ? op_code_name(code) : tp_why(code));
		}
		if (b) block_free(b);
	}
	whole_of(last, value);
	int code = write(h, last);
	unfail(h, !code);
	return code;
}

// a step from elsewhere into the graph
static void land(tp_history *h, const uint8_t device[32], uint64_t n) {
	block *b = read_back(h, device, n);
	if (!b) {
		note(h, &h->failed, device, n, "", "", tp_why(TP_STORE));
		return;
	}
	long k = entry_of(h, b->part, b->node);
	int last = k < 0 ? -1 : placed(h, k, device, n, (uint64_t)int_of(b->step->items[6]));
	// the step's node and part, past the block's going to the graph
	op_value *s = op_ref(b->step);
	// forgets: one that goes earlier is passed over
	int code = last < 0 ? (block_free(b), TP_NOMEM)
		: last         ? write(h, b)
		: h->forgets   ? (block_free(b), 0)
			       : redo(h, k, b);
	if (code) {
		note(h, &h->failed, device, n, s->items[3]->str, s->items[4]->str,
			code < 0 ? tp_why(code) : op_code_name(code));
	}
	op_free(s);
}

void tp_history_told(void *ctx, const uint8_t device[32], uint64_t from, size_t count) {
	tp_history *h = ctx;
	const uint8_t *me = tp_log_device(h->log);
	// this device's own are only ever written here
	if (me && !memcmp(me, device, 32)) return;
	for (size_t i = 0; i < count; i++) land(h, device, from + i);
}

// ---- the snapshot

// {count: {device: n}, entries: [[part, node, value | null, [[lamport, device, n], …]], …]}, as
// history.ts writes it, devices hex: each kept entry's value and its list of steps, and how many of
// each device's steps are in them. 0: a value or name with no cbor
static int put_snapshot(tp_history *h, CborOut *o) {
	char hex[64];
	size_t devices = tp_log_devices(h->log), kept = 0;
	cborPutHead(o, 5, 2), cborPutText(o, "count", 5), cborPutHead(o, 5, devices);
	// the devices in their keys' order: hex all as long, so bytewise
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
		const entry *e = &h->entries[i];
		const char *part = e->key, *node = part + strlen(part) + 1;
		if (!e->count) continue;
		const nd_entry *x = tb_get(h->table, tb_string(part), tb_string(node));
		cborPutHead(o, 4, 4);
		if (!cborPutText(o, part, strlen(part)) || !cborPutText(o, node, strlen(node))) return 0;
		if (!x || !x->value) cborPutNull(o);
		else if (!put_value(o, x->value)) return 0;
		cborPutHead(o, 4, e->count);
		for (size_t k = 0; k < e->count; k++) {
			tp_hex(hex, h->devices[e->refs[k].device], 32);
			cborPutHead(o, 4, 3), cborPutHead(o, 0, e->refs[k].lamport);
			cborPutText(o, hex, 64), cborPutHead(o, 0, e->refs[k].n);
		}
	}
	return 1;
}

int tp_history_snapshot(tp_history *h) {
	// measured, then written
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

// a snapshot being read back: in, at its entries; names, an entry's part and node, each with a 0
typedef struct {
	tp_history *h;
	tp_in in;
	tp_buf names;
	int why;
} unsnapping;

// one of the snapshot's entries: its list of steps, and its value the graph's entry. 0 or a code
static int unsnap(tp_history *h, tp_in *in, tp_buf *names) {
	tp_span part, node, value = {NULL, 0}, hex;
	uint64_t k, lamport, n;
	uint8_t device[32];
	if (tp_array(in, &k) || k != 4 || tp_text(in, &part) || tp_text(in, &node)) return TP_NOTSTEP;
	if (!tp_null(in) && tp_skip(in, &value)) return TP_NOTSTEP;
	names->len = 0;
	tp_put(names, part.p, part.n), tp_put(names, "", 1), tp_put(names, node.p, node.n), tp_put(names, "", 1);
	if (names->bad) return tp_buf_why(names);
	const char *p = (const char *)names->p, *id = p + part.n + 1;
	long e = entry_of(h, p, id);
	if (e < 0 || tp_array(in, &k)) return e < 0 ? TP_NOMEM : TP_NOTSTEP;
	h->entries[e].count = 0;
	for (uint64_t i = 0; i < k; i++) {
		uint64_t three;
		if (tp_array(in, &three) || three != 3 || tp_whole(in, &lamport) || tp_text(in, &hex) ||
			hex.n != 64 || tp_unhex(device, hex.p, 32) || tp_whole(in, &n))
			return TP_NOTSTEP;
		if (placed(h, e, device, n, lamport) < 0) return TP_NOMEM;
	}
	if (!value.p) return 0;
	op_value *v = cborRead(value.p, value.n, &maker, NULL, NULL);
	if (!v) return TP_NOTSTEP;
	// its header, held by a block as a step's is
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

// device's count in the snapshot's, 0 when it has none
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
		// {count, entries}: their keys in that order
		if (!tp_canonical(bytes, (size_t)length) || tp_map(&u.in, &k) || k != 2 || tp_text(&u.in, &t) ||
			!tp_is(t, "count") || tp_skip(&u.in, &count) || tp_text(&u.in, &t) || !tp_is(t, "entries"))
			u.why = TP_NOTSTEP;
		else quietly(h, unsnap_f, &u);
	}
	// every step after it landed, this device's too
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

// ---- the recorder

static int kept_by_default(const char *part) {
	return !strcmp(part, "value") || !strcmp(part, "attributes") || !strcmp(part, "children");
}

// a kept write here, a step
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
	int ok = put_patches(&o, f->patches, f->patches_length) && when >= 0;
	tp_write w = {{(const uint8_t *)node, strlen(node)}, {(const uint8_t *)part, strlen(part)},
		{o.data, o.length}, {(const uint8_t *)who, who ? strlen(who) : 0}, (uint64_t)when};
	uint64_t n, lamport;
	int why = ok ? tp_log_write(h->log, &w, &n, &lamport) : TP_NOTSTEP;
	free(o.data);
	if (why) {
		h->entries[k].broken = 1;
		note(h, &h->unkept, NULL, 0, node, part, tp_why(why));
		return;
	}
	h->entries[k].broken = 0;
	// written here, it is in the graph already, unless it sorts before steps already there
	const uint8_t *me = tp_log_device(h->log);
	int last = placed(h, k, me, n, lamport);
	block *b = last ? NULL : read_back(h, me, n);
	int code = last < 0 ? TP_NOMEM : b ? redo(h, k, b) : last ? 0 : TP_STORE;
	if (code) note(h, &h->failed, me, n, node, part, code < 0 ? tp_why(code) : op_code_name(code));
}

// ---- made and let go

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
		tp_free(&h->mem, h->entries[i].refs, h->entries[i].room * sizeof(ref));
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

// ---- forgetting (a try-out)

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
