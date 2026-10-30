// Tippet in C on the line protocol (conformance/c/harness.h), the same ops as
// typescript/tippet_harness.ts, one process per scenario. With TIPPET_HEAP set, the library's peak
// memory and what is left at the end go to stderr.
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "../../../conformance/c/harness.h"
#include "../../../conformance/c/protocol_harness.h"
#include "../../../encoding/c/cbor.h"
#include "history.h"
#include "store.h"
#include "tippet.h"
#include "wire.h"

#define WHEN 1760000000
#define MAX (64u << 20)

typedef struct {
	size_t now, peak;
} heap;

static void *counted(void *ctx, void *p, size_t old, size_t size) {
	heap *h = ctx;
	if (!size) {
		free(p);
		h->now -= old;
		return NULL;
	}
	void *q = realloc(p, size);
	if (!q) return NULL;
	h->now = h->now - old + size;
	if (h->now > h->peak) h->peak = h->now;
	return q;
}

typedef struct {
	char *name;
	tp_log *log;
	tp_sync *sync;
	tp_key key;
	int keyed;
	tb_table *table;
	pt_paths *paths;
	pl *places;
	sc_scheduler *scheduler;
	sc_scope *scope;
	sc_pair info;
	tp_history *history;
	tp_span *heard;
	size_t nheard;
	char *dir;
	tp_store *store;
	uint8_t seed[32];
} device;

typedef struct {
	char *from, *to;
	tp_link *link;
	tp_span *queue;
	size_t count;
} side;

typedef struct {
	heap heap;
	tp_mem mem;
	device **devices;
	size_t count;
	side **sides;
	size_t nsides;
	uint64_t calls;
	hh_line **dead;
	size_t ndead;
} world;
static world w;

void hh_start(void) { w.mem = (tp_mem){counted, &w.heap}; }

static void bury(void) {
	for (size_t i = 0; i < w.ndead; i++) hh_release(w.dead[i]);
	w.ndead = 0;
}

static void drop_side(side *s) {
	for (size_t i = 0; i < s->count; i++) free((void *)s->queue[i].p);
	free(s->queue), free(s->from), free(s->to), free(s);
}

void hh_finish(void) {
	for (size_t i = 0; i < w.nsides; i++) drop_side(w.sides[i]);
	free(w.sides);
	for (size_t i = 0; i < w.count; i++) {
		device *d = w.devices[i];
		tp_sync_free(d->sync);
		if (d->history) tp_history_free(d->history);
		tp_log_free(d->log);
		if (d->scheduler) {
			sc_free(d->scheduler), tb_free(d->table), pt_free(d->paths), pl_free(d->places);
			op_free((op_value *)d->info.value);
		}
		for (size_t k = 0; k < d->nheard; k++) free((void *)d->heard[k].p);
		if (d->dir) {
			DIR *in = opendir(d->dir);
			struct dirent *e;
			char path[4096];
			while (in && (e = readdir(in))) {
				if (e->d_name[0] != '.') snprintf(path, sizeof path, "%s/%s", d->dir, e->d_name), unlink(path);
			}
			if (in) closedir(in);
			rmdir(d->dir);
		}
		free(d->heard), free(d->dir), free(d->name), free(d);
	}
	free(w.devices);
	bury();
	free(w.dead);
	if (getenv("TIPPET_HEAP")) {
		fprintf(stderr, "tippet heap: peak %zu, left %zu\n", w.heap.peak, w.heap.now);
	}
}


static void hex(FILE *out, const uint8_t *b, size_t n) {
	fputc('"', out);
	for (size_t i = 0; i < n; i++) fprintf(out, "%02x", b[i]);
	fputc('"', out);
}

static long unhex(const char *s, uint8_t **out) {
	size_t n = s ? strlen(s) : 1;
	if (n % 2) return -1;
	uint8_t *b = hh_take(n / 2);
	for (size_t i = 0; i < n; i++) {
		int c = s[i], d = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
		if (d < 0) return -1;
		b[i / 2] = (uint8_t)(i % 2 ? b[i / 2] << 4 | d : d);
	}
	*out = b;
	return (long)(n / 2);
}

static device *named(const char *name) {
	for (size_t i = 0; name && i < w.count; i++) {
		if (!strcmp(w.devices[i]->name, name)) return w.devices[i];
	}
	return NULL;
}

static const uint8_t *keyof(const char *s) {
	device *d = named(s);
	if (d && tp_log_device(d->log)) return tp_log_device(d->log);
	uint8_t *b;
	return unhex(s, &b) == 32 ? b : NULL;
}

static void nameof(FILE *out, const uint8_t key[32]) {
	for (size_t i = 0; i < w.count; i++) {
		const uint8_t *k = tp_log_device(w.devices[i]->log);
		if (k && !memcmp(k, key, 32)) { op_json_string(out, w.devices[i]->name); return; }
	}
	hex(out, key, 32);
}

static int whole(const op_value *v, int64_t *n) { return v && op_as_int64(v, n) && *n >= 0; }

static int put(CborOut *o, const op_value *v);
static const op_value *sorting;
static int bykey(const void *a, const void *b) {
	const char *x = sorting->keys[*(const size_t *)a], *y = sorting->keys[*(const size_t *)b];
	return cborKeyCompare(x, strlen(x), y, strlen(y));
}
static int put(CborOut *o, const op_value *v) {
	switch (v->type) {
		case OP_NULL: cborPutNull(o); return 1;
		case OP_BOOL: cborPutBoolean(o, v->bool_); return 1;
		case OP_NUM:
			if (v->big) cborPutWhole(o, v->bigNegative, v->big, v->bigLength);
			else cborPutNumber(o, v->num);
			return 1;
		case OP_STR: return cborPutText(o, v->str, v->bytes);
		case OP_BYTES: cborPutBytes(o, v->data, v->bytes); return 1;
		case OP_TYPED: cborPutTyped(o, (JsonKind)v->kind, v->data, op_length(v)); return 1;
		case OP_STAND: cborPutStand(o); return put(o, v->items[0]);
		case OP_LIST:
			cborPutHead(o, 4, v->count);
			for (size_t i = 0; i < v->count; i++) {
				if (!put(o, v->items[i])) return 0;
			}
			return 1;
		default: {
			size_t *order = hh_take((v->count ? v->count : 1) * sizeof *order);
			for (size_t i = 0; i < v->count; i++) order[i] = i;
			sorting = v;
			qsort(order, v->count, sizeof *order, bykey);
			cborPutHead(o, 5, v->count);
			for (size_t i = 0; i < v->count; i++) {
				const char *k = v->keys[order[i]];
				if (!cborPutText(o, k, strlen(k)) || !put(o, v->items[order[i]])) return 0;
			}
			return 1;
		}
	}
}

static size_t encode(const op_value *v, uint8_t **out) {
	CborOut o = {NULL, 0, 0, true};
	if (!put(&o, v)) {
		free(o.data);
		return 0;
	}
	*out = hh_take(o.length);
	memcpy(*out, o.data, o.length);
	free(o.data);
	return o.length;
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

static op_value *decode(const uint8_t *b, size_t n) {
	op_value *v = cborRead(b, n, &maker, NULL, NULL);
	return v ? hh_hold(v) : NULL;
}

static size_t stepin(const op_value *s, const uint8_t *device, const uint8_t *before, uint8_t **out) {
	const char *d = hh_str(s, "device"), *b = hh_str(s, "before");
	const op_value *bv = op_get(s, "before");
	const uint8_t *key = d ? keyof(d) : device;
	uint8_t *bb = NULL;
	if (!key || (b && unhex(b, &bb) < 0)) return 0;
	op_value *a = op_list();
	op_push(a, op_bytes(key, 32));
	op_push(a, op_ref(op_get(s, "n")));
	op_push(a, b ? op_bytes(bb, strlen(b) / 2) : bv || !before ? op_null() : op_bytes(before, 32));
	const char *fields[] = {"node", "part", "patches", "lamport", "when", "on", "who"};
	const op_value *rel = op_get(s, "relative");
	for (int i = 0; i < 7; i++) {
		op_value *v = op_get(s, fields[i]);
		if (i == 5) {
			int64_t n, m;
			if (!v) continue;
			if (v->type != OP_LIST || !whole(op_get(s, "n"), &n)) return op_free(a), 0;
			op_value *on = op_list();
			for (size_t j = 0; j < v->count; j++) {
				const op_value *x = v->items[j];
				const uint8_t *k = x->type == OP_LIST && x->count == 2 && x->items[0]->type == OP_STR
					? keyof(x->items[0]->str) : NULL;
				if (!k || !whole(x->items[1], &m)) return op_free(on), op_free(a), 0;
				if (!memcmp(k, key, 32)) op_push(on, op_int(n - m));
				else {
					op_value *pair = op_list();
					op_push(pair, op_bytes(k, 32)), op_push(pair, op_int(m));
					op_push(on, pair);
				}
			}
			op_push(a, on);
			continue;
		}
		if (!i && v && v->type == OP_STR && rel && rel->type == OP_BOOL && rel->bool_) {
			long rest = tp_step_rest(key, (tp_span){(const uint8_t *)v->str, v->bytes});
			if (rest < 0) return op_free(a), 0;
			op_value *near = op_list();
			op_push(near, op_str_n(v->str + v->bytes - (size_t)rest, (size_t)rest));
			op_push(a, near);
		} else if (v) op_push(a, op_ref(v));
		else if (i < 5) return op_free(a), 0;
	}
	size_t n = encode(a, out);
	op_free(a);
	return n;
}

static void steps(FILE *out, const tp_steps *s) {
	fputc('[', out);
	for (size_t i = 0; i < s->count; i++) {
		if (i) fputc(',', out);
		hex(out, s->bytes + s->at[i], s->at[i + 1] - s->at[i]);
	}
	fputc(']', out);
}

static long spans(const op_value *list, tp_span **out) {
	if (!list || list->type != OP_LIST) return -1;
	tp_span *s = hh_take((list->count ? list->count : 1) * sizeof *s);
	for (size_t i = 0; i < list->count; i++) {
		uint8_t *b;
		long n = list->items[i]->type == OP_STR ? unhex(list->items[i]->str, &b) : -1;
		if (n < 0) return -1;
		s[i] = (tp_span){b, (size_t)n};
	}
	*out = s;
	return (long)list->count;
}


static size_t message(const op_value *m, uint8_t **out) {
	CborOut o = {NULL, 0, 0, true};
	const char *t = m && m->type == OP_LIST && m->count ? (m->items[0]->type == OP_STR ? m->items[0]->str : NULL) : NULL;
	const op_value *x = m && m->count > 1 ? m->items[1] : NULL, *y = m && m->count > 2 ? m->items[2] : NULL,
		       *z = m && m->count > 3 ? m->items[3] : NULL;
	const uint8_t *key;
	uint8_t *b, *tail = NULL;
	size_t tailn = 0;
	long n;
	int ok = 1;
	if (!t) return 0;
	if (!strcmp(t, "have") && x && x->type == OP_LIST) {
		cborPutHead(&o, 4, 2), cborPutText(&o, t, 4), cborPutHead(&o, 4, x->count);
		for (size_t i = 0; i < x->count && ok; i++) {
			const op_value *e = x->items[i];
			ok = e->type == OP_LIST && e->count == 2 && e->items[0]->type == OP_STR &&
				(key = keyof(e->items[0]->str));
			if (ok) cborPutHead(&o, 4, 2), cborPutBytes(&o, key, 32), ok = put(&o, e->items[1]);
		}
	} else if (!strcmp(t, "run") && x && y && x->type == OP_STR && y->type == OP_STR &&
		(key = keyof(x->str)) && (n = unhex(y->str, &b)) >= 0) {
		tp_span *s, pack;
		long k = spans(z, &s);
		ok = k > 0 && !tp_pack(&w.mem, s, (size_t)k, MAX, &pack);
		if (ok) {
			cborPutHead(&o, 4, 4), cborPutText(&o, t, 3), cborPutBytes(&o, key, 32);
			cborPutBytes(&o, b, (size_t)n);
			tail = hh_take(pack.n ? pack.n : 1), tailn = pack.n;
			memcpy(tail, pack.p, pack.n);
			tp_span_free(&w.mem, &pack);
		}
	} else if (!strcmp(t, "live") && x && y && x->type == OP_STR && y->type == OP_STR &&
		(n = unhex(x->str, &b)) >= 0) {
		cborPutHead(&o, 4, 3), cborPutText(&o, t, 4), cborPutBytes(&o, b, (size_t)n);
		ok = (n = unhex(y->str, &b)) >= 0;
		if (ok) cborPutBytes(&o, b, (size_t)n);
	} else if (!strcmp(t, "refused") && x && y && x->type == OP_STR && (key = keyof(x->str))) {
		cborPutHead(&o, 4, 3), cborPutText(&o, t, 7), cborPutBytes(&o, key, 32);
		ok = put(&o, y);
	} else {
		ok = 0;
	}
	size_t length = o.length + tailn;
	if (ok) {
		*out = hh_take(length), memcpy(*out, o.data, o.length);
		if (tailn) memcpy(*out + o.length, tail, tailn);
	}
	free(o.data);
	return ok ? length : 0;
}

static int is(const op_value *v, const char *s) { return v && v->type == OP_STR && !strcmp(v->str, s); }
static int sized(const op_value *v, size_t n) { return v && v->type == OP_BYTES && (!n || v->bytes == n); }
static int counted_whole(const op_value *v) {
	int64_t n;
	return v && v->type == OP_NUM && !v->big && whole(v, &n) && (uint64_t)n <= TP_WHOLE;
}

static int readout(FILE *out, const uint8_t *b, size_t n) {
	op_value *m = decode(b, n);
	if (!m || m->type != OP_LIST || !m->count) return 0;
	const op_value *t = m->items[0], *x = m->count > 1 ? m->items[1] : NULL,
		       *y = m->count > 2 ? m->items[2] : NULL, *z = m->count > 3 ? m->items[3] : NULL;
	if (is(t, "have") && m->count == 2 && x->type == OP_LIST) {
		for (size_t i = 0; i < x->count; i++) {
			const op_value *e = x->items[i];
			if (e->type != OP_LIST || e->count != 2 || !sized(e->items[0], 32) || !counted_whole(e->items[1]))
				return 0;
		}
		fputs("{\"message\":[\"have\",[", out);
		int first = 1;
		for (size_t i = 0; i < x->count; i++) {
			const op_value *e = x->items[i];
			int seen = 0;
			for (size_t j = 0; j < i && !seen; j++) seen = !memcmp(x->items[j]->items[0]->data, e->items[0]->data, 32);
			if (seen) continue;
			const op_value *last = e;
			for (size_t j = i + 1; j < x->count; j++) {
				if (!memcmp(x->items[j]->items[0]->data, e->items[0]->data, 32)) last = x->items[j];
			}
			fputs(first ? "[" : ",[", out), first = 0;
			hex(out, e->items[0]->data, 32), fputc(',', out), op_json_write(out, last->items[1]);
			fputc(']', out);
		}
		fputs("]]}", out);
		return 1;
	}
	if (is(t, "run") && m->count == 4 && sized(x, 32) && sized(y, 64) && z->type == OP_LIST) {
		tp_in in = {b, b + n};
		uint64_t k;
		tp_array(&in, &k), tp_skip(&in, NULL), tp_skip(&in, NULL), tp_skip(&in, NULL);
		tp_steps s;
		int unpacked = !tp_unpack(&w.mem, (tp_span){in.p, (size_t)(in.end - in.p)}, TP_RUN, &s);
		fputs("{\"message\":[\"run\",", out);
		hex(out, x->data, 32), fputc(',', out);
		if (unpacked) {
			hex(out, y->data, 64), fputc(',', out), steps(out, &s);
			tp_steps_free(&w.mem, &s);
		} else {
			fputs("\"not a pack\"", out);
		}
		fputs("]}", out);
		return 1;
	}
	if (is(t, "refused") && m->count == 3 && sized(x, 32) && counted_whole(y)) {
		fputs("{\"message\":[\"refused\",", out);
		hex(out, x->data, 32), fputc(',', out), op_json_write(out, y), fputs("]}", out);
		return 1;
	}
	if (is(t, "live") && m->count == 3 && sized(x, 8) && sized(y, 0)) {
		fputs("{\"message\":[\"live\",", out);
		hex(out, x->data, 8), fputc(',', out), hex(out, y->data, y->bytes), fputs("]}", out);
		return 1;
	}
	return 0;
}


static tp_span stepof(const tp_log *log, const uint8_t *key, uint64_t n) {
	long length = tp_log_step(log, key, n, NULL, 0);
	if (length < 0) hh_fail("a step held is not in the store");
	uint8_t *b = hh_take(length ? (size_t)length : 1);
	tp_log_step(log, key, n, b, (size_t)length);
	return (tp_span){b, (size_t)length};
}

static void told(void *ctx, const uint8_t key[32], uint64_t from, size_t count) {
	device *d = ctx;
	if (d->history) tp_history_told(d->history, key, from, count);
	if (d->sync) tp_sync_told(d->sync, key, from, count);
}

static void random_(void *ctx, uint8_t *out, size_t n) {
	(void)ctx;
	uint64_t k = ++w.calls;
	for (size_t i = n; i-- > 0; k >>= 8) out[i] = (uint8_t)k;
}

static void heard(void *ctx, const uint8_t *data, size_t length) {
	device *d = ctx;
	uint8_t *copy = malloc(length ? length : 1);
	tp_span *h = realloc(d->heard, (d->nheard + 1) * sizeof *h);
	if (!copy || !h) hh_fail("out of memory");
	memcpy(copy, data, length);
	d->heard = h, d->heard[d->nheard++] = (tp_span){copy, length};
}

static void inside(void *ctx, void (*f)(void *data), void *data) {
	device *d = ctx;
	sc_run_with_scope(d->scope, f, data);
}

static void drop_value(void *value, void *data) {
	(void)data;
	op_free(value);
}

static device *made(const char *name, const uint8_t *seed, FILE *out) {
	if (named(name)) return hh_error(out, "%s is made", name), NULL;
	device *d = calloc(1, sizeof *d);
	device **grown = realloc(w.devices, (w.count + 1) * sizeof *grown);
	if (!d || !grown) hh_fail("out of memory");
	w.devices = grown;
	tp_store *store = tp_memory_store(&w.mem, MAX);
	tp_log_options o = {w.mem, store, seed, 1, {0, 0, 0}, told, d};
	tp_log *log = store ? tp_log_new(&o) : NULL;
	int why = log ? tp_log_load(log) : TP_NOMEM;
	if (why) {
		if (log) tp_log_free(log);
		else if (store) store->close(store->self);
		free(d);
		return hh_error(out, "%s", tp_why(why)), NULL;
	}
	w.devices[w.count++] = d;
	d->name = strdup(name), d->log = log;
	if (seed) {
		tp_key_of(&d->key, seed), d->keyed = 1;
		d->places = pl_new();
		d->scheduler = sc_new((sc_options){.drop = drop_value});
		sc_on_tracking_end(d->scheduler, pl_forget, d->places);
		d->table = tb_make(pl_event, d->places);
		d->paths = pt_new();
		pl_connect(d->places, &(pl_setup){.root = tb_string("root"), .table = d->table,
			.paths = d->paths, .scheduler = d->scheduler});
		d->info = (sc_pair){"actor", op_str("harness")};
		d->scope = sc_create_root_scope(d->scheduler, &d->info, 1);
		tp_history_options ho = {w.mem, log, d->table, d->places, NULL, inside, d, 0};
		if (!(d->history = tp_history_new(&ho))) hh_fail("out of memory");
		tp_history_load(d->history);
	}
	tp_sync_options so = {w.mem, log, !seed, heard, random_, d, 0, MAX};
	if (!(d->sync = tp_sync_new(&so))) hh_fail("out of memory");
	return d;
}

static device *which(const op_value *r, const char *field, FILE *out) {
	const char *name = hh_str(r, field);
	device *d = named(name);
	if (!d) hh_error(out, "no device %s", name ? name : "(none)");
	return d;
}

static void taken(FILE *out, long got) {
	if (got >= 0) fprintf(out, "{\"added\":%ld}", got);
	else if (got <= TP_OWN) fprintf(out, "{\"refused\":\"%s\"}", tp_why((int)got));
	else hh_error(out, "%s", tp_why((int)got));
}

static void take(const op_value *r, FILE *out) {
	device *d = which(r, "device", out);
	const op_value *run = op_get(r, "run"), *list = run ? op_get(run, "steps") : NULL;
	if (!d) return;
	const char *of = run ? hh_str(run, "device") : NULL;
	const uint8_t *key = of ? keyof(of) : NULL;
	if (!key || !list || list->type != OP_LIST || !list->count) { hh_error(out, "not a run"); return; }
	tp_span *s = hh_take(list->count * sizeof *s);
	uint8_t before[32];
	for (size_t i = 0; i < list->count; i++) {
		const op_value *v = list->items[i];
		uint8_t *b;
		long n = v->type == OP_STR ? unhex(v->str, &b) : (long)stepin(v, key, i ? before : NULL, &b);
		if (n <= 0) { hh_error(out, "not a step"); return; }
		s[i] = (tp_span){b, (size_t)n};
		tp_step_hash(b, (size_t)n, before);
	}
	uint8_t sig[64], *given;
	const char *hexsig = hh_str(run, "sig");
	if (hexsig) {
		if (unhex(hexsig, &given) != 64) { hh_error(out, "not a sig"); return; }
		memcpy(sig, given, 64);
	} else {
		const char *by = hh_str(run, "sign") ? hh_str(run, "sign") : of;
		device *signer = named(by);
		if (!signer || !signer->keyed) { hh_error(out, "%s signs nothing", by); return; }
		tp_sign(&signer->key, before, 32, sig);
	}
	taken(out, tp_log_take(d->log, key, s, list->count, sig, (tp_span){NULL, 0}));
}

static void pass(const op_value *r, FILE *out) {
	device *from = which(r, "from", out), *to = from ? which(r, "to", out) : NULL;
	const char *of = hh_str(r, "of");
	const uint8_t *key = of ? keyof(of) : NULL;
	int64_t at;
	uint64_t end;
	uint8_t sig[64];
	if (!to) return;
	if (!key || !whole(op_get(r, "at"), &at) || tp_log_run(from->log, key, (uint64_t)at, &end, sig))
		{ hh_error(out, "%s has no run of %s at that", from->name, of ? of : "(none)"); return; }
	size_t n = (size_t)(end - (uint64_t)at + 1);
	tp_span *s = hh_take(n * sizeof *s);
	for (size_t i = 0; i < n; i++) s[i] = stepof(from->log, key, (uint64_t)at + i);
	taken(out, tp_log_take(to->log, key, s, n, sig, (tp_span){NULL, 0}));
}


static void let_go(void *line) {
	hh_line **dead = realloc(w.dead, (w.ndead + 1) * sizeof *dead);
	if (!dead) hh_fail("out of memory");
	w.dead = dead, w.dead[w.ndead++] = line;
}

typedef struct {
	device *d;
	const char *node, *part, *error;
	op_patch *patches;
	size_t n;
	ch_header header;
	hh_line *line;
} host_write;

static void write_f(void *data) {
	host_write *x = data;
	device *d = x->d;
	tb_key part = tb_string(x->part), id = tb_string(x->node);
	nd_entry *e = tb_get(d->table, part, id);
	if (e) {
		size_t failed;
		int code = nd_update(e, x->patches, x->n, x->header, &failed);
		if (code) {
			x->error = op_code_name(code);
			return;
		}
		pl_hold(d->places, e, x->line, let_go), x->line = NULL;
		pl_changed changed = {1, {e, NULL}};
		pl_commit(d->places, &changed);
		return;
	}
	const op_patch *p = x->patches;
	if (x->n != 1 || p->place.length || p->place.has_range || p->has_move || !p->has_value) {
		x->error = "a first write is one whole value";
		return;
	}
	if (!(e = nd_make_entry((op_value *)p->value, &x->header))) hh_fail("out of memory");
	pl_own(d->places, e);
	pl_hold(d->places, e, x->line, let_go), x->line = NULL;
	tb_sub(d->table, part, id, e);
}

static void write_disk(device *d, const op_value *r, FILE *out);
static void written(const op_value *r, FILE *out) {
	device *d = which(r, "device", out);
	const op_value *patches = op_get(r, "patches");
	int64_t when = WHEN;
	if (!d) return;
	if (d->dir) { write_disk(d, r, out); return; }
	if (!d->history) { hh_error(out, "%s writes nothing", d->name); return; }
	if (!patches || patches->type != OP_LIST || !hh_str(r, "node")) { hh_error(out, "not a write"); return; }
	if (op_get(r, "when") && !whole(op_get(r, "when"), &when)) { hh_error(out, "not a when"); return; }
	host_write x = {d, hh_str(r, "node"), hh_str(r, "part") ? hh_str(r, "part") : "value", NULL,
		hh_take((patches->count + 1) * sizeof *x.patches), patches->count, {0}, hh_retain()};
	for (size_t i = 0; i < x.n; i++) hh_patch(patches->items[i], &x.patches[i]);
	const op_value *who = op_get(r, "who");
	x.header = (ch_header){.has_time = 1, .time = when, .actor = who && who->type == OP_STR ? who : NULL};
	tp_failed f;
	size_t unkept = tp_history_unkept(d->history, 0, &f);
	inside(d, write_f, &x);
	if (x.line) let_go(x.line);
	if (x.error) { hh_error(out, "%s", x.error); return; }
	if (tp_history_unkept(d->history, unkept, &f) > unkept) { hh_error(out, "not kept: %s", f.why); return; }
	const uint8_t *me = tp_log_device(d->log);
	tp_step s;
	tp_span bytes = stepof(d->log, me, tp_log_count(d->log, me));
	if (tp_step_decode(bytes.p, bytes.n, &s)) hh_fail("a step held is not one");
	fprintf(out, "{\"n\":%llu,\"lamport\":%llu}", (unsigned long long)s.n, (unsigned long long)s.lamport);
}

static void versions(const op_value *r, FILE *out) {
	device *d = which(r, "device", out);
	const char *node = hh_str(r, "node"), *part = hh_str(r, "part") ? hh_str(r, "part") : "value";
	if (!d) return;
	if (!d->history || !node) { hh_error(out, "no graph"); return; }
	tp_version v[TP_VERSIONS];
	size_t n = tp_history_versions(d->history, node, part, v);
	fputs("{\"versions\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		if (v[i].value) fputs("{\"value\":", out), op_json_write(out, v[i].value);
		else fputs("{\"gone\":true", out);
		fputs(",\"from\":[", out);
		const uint8_t *key;
		uint64_t m;
		if (v[i].device) fputc('[', out), nameof(out, v[i].device), fprintf(out, ",%llu]", (unsigned long long)v[i].n);
		for (size_t k = 0; !v[i].device && k < TP_VERSIONS - 1 &&
			k < tp_history_heads(d->history, node, part, k, &key, &m); k++) {
			fputs(k ? ",[" : "[", out), nameof(out, key), fprintf(out, ",%llu]", (unsigned long long)m);
		}
		fputs("]}", out);
		if (v[i].value) op_free(v[i].value);
	}
	fputs("]}", out);
}

static void value(const op_value *r, FILE *out) {
	device *d = which(r, "device", out);
	const char *node = hh_str(r, "node"), *part = hh_str(r, "part") ? hh_str(r, "part") : "value";
	if (!d) return;
	const nd_entry *e = d->table && node ? tb_get(d->table, tb_string(part), tb_string(node)) : NULL;
	if (!e || !e->value) { fputs("{}", out); return; }
	fputs("{\"value\":", out), op_json_write(out, e->value), fputc('}', out);
}


static side *side_of(const char *from, const char *to) {
	for (size_t i = 0; from && to && i < w.nsides; i++) {
		if (!strcmp(w.sides[i]->from, from) && !strcmp(w.sides[i]->to, to)) return w.sides[i];
	}
	return NULL;
}

static int sent(void *ctx, const uint8_t *bytes, size_t length) {
	side *s = ctx;
	uint8_t *copy = malloc(length ? length : 1);
	tp_span *q = realloc(s->queue, (s->count + 1) * sizeof *q);
	if (!copy || !q) hh_fail("out of memory");
	memcpy(copy, bytes, length);
	s->queue = q, s->queue[s->count++] = (tp_span){copy, length};
	return 0;
}

static void hear(const char *from, const char *to, const uint8_t *bytes, size_t length) {
	side *s = side_of(to, from);
	device *d = named(to);
	if (!s || !d || !s->link) hh_fail("no such link");
	tp_sync_receive(d->sync, s->link, bytes, length);
}

static void join(const op_value *r, FILE *out) {
	const char *a = hh_str(r, "a"), *b = hh_str(r, "b");
	device *x = which(r, "a", out), *y = x ? which(r, "b", out) : NULL;
	if (!y) return;
	if (side_of(a, b)) { hh_error(out, "%s and %s are linked", a, b); return; }
	const char *ends[2][2] = {{a, b}, {b, a}};
	side **grown = realloc(w.sides, (w.nsides + 2) * sizeof *grown);
	if (!grown) hh_fail("out of memory");
	w.sides = grown;
	for (int i = 0; i < 2; i++) {
		side *s = calloc(1, sizeof *s);
		if (!s) hh_fail("out of memory");
		s->from = strdup(ends[i][0]), s->to = strdup(ends[i][1]);
		w.sides[w.nsides++] = s;
	}
	for (int i = 0; i < 2; i++) {
		side *s = side_of(ends[i][0], ends[i][1]);
		s->link = tp_sync_link(named(s->from)->sync, sent, s, 0);
		if (!s->link) hh_fail("out of memory");
	}
	fputs("{}", out);
}

static void unjoin(const op_value *r, FILE *out) {
	const char *a = hh_str(r, "a"), *b = hh_str(r, "b");
	if (!side_of(a, b)) { hh_error(out, "no link %s %s", a ? a : "", b ? b : ""); return; }
	for (size_t i = w.nsides; i-- > 0;) {
		side *s = w.sides[i];
		if ((!strcmp(s->from, a) && !strcmp(s->to, b)) || (!strcmp(s->from, b) && !strcmp(s->to, a))) {
			tp_sync_unlink(named(s->from)->sync, s->link);
			drop_side(s);
			memmove(&w.sides[i], &w.sides[i + 1], (w.nsides - i - 1) * sizeof *w.sides);
			w.nsides--;
		}
	}
	fputs("{}", out);
}

static void view(FILE *out, const uint8_t *b, size_t n) {
	tp_in in = {b, b + n};
	uint64_t k, count, num;
	tp_span t, x, y;
	if (!tp_canonical(b, n) || tp_array(&in, &k) || tp_text(&in, &t)) goto none;
	if (tp_is(t, "have")) {
		tp_array(&in, &count);
		fputs("[\"have\",{", out);
		for (uint64_t i = 0; i < count; i++) {
			tp_array(&in, &k), tp_bytes(&in, 32, &x), tp_whole(&in, &num);
			if (i) fputc(',', out);
			nameof(out, x.p), fprintf(out, ":%llu", (unsigned long long)num);
		}
		fputs("}]", out);
	} else if (tp_is(t, "run")) {
		uint64_t first;
		int after;
		tp_bytes(&in, 32, &x), tp_bytes(&in, 64, &y);
		tp_span pack = {in.p, (size_t)(in.end - in.p)};
		if (tp_pack_first(pack, &first, &after) || !tp_pack_count(pack)) goto none;
		fputs("[\"run\",", out), nameof(out, x.p);
		fprintf(out, ",%llu,%llu]", (unsigned long long)first, (unsigned long long)(first + tp_pack_count(pack) - 1));
	} else if (tp_is(t, "live")) {
		tp_bytes(&in, 8, &x), tp_bytes(&in, 0, &y);
		fputs("[\"live\",", out), hex(out, x.p, 8), fputc(',', out), hex(out, y.p, y.n), fputc(']', out);
	} else if (tp_is(t, "refused")) {
		tp_bytes(&in, 32, &x), tp_whole(&in, &num);
		fputs("[\"refused\",", out), nameof(out, x.p), fprintf(out, ",%llu]", (unsigned long long)num);
	} else {
		goto none;
	}
	return;
none:
	fputs("[\"not a message\",", out), hex(out, b, n), fputc(']', out);
}

static void views(FILE *out, const char *field, const tp_span *list, size_t n) {
	fprintf(out, "{\"%s\":[", field);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		view(out, list[i].p, list[i].n);
	}
	fputs("]}", out);
}

static void waiting(const op_value *r, const char *op, FILE *out) {
	side *s = side_of(hh_str(r, "from"), hh_str(r, "to"));
	int64_t count;
	if (!s) { hh_error(out, "no link"); return; }
	if (!strcmp(op, "queued")) { views(out, "queued", s->queue, s->count); return; }
	size_t n = op_get(r, "count") && whole(op_get(r, "count"), &count) && (size_t)count < s->count
		? (size_t)count
		: s->count;
	tp_span *taken = hh_take((n ? n : 1) * sizeof *taken);
	memcpy(taken, s->queue, n * sizeof *taken);
	memmove(s->queue, s->queue + n, (s->count - n) * sizeof *s->queue);
	s->count -= n;
	char *from = strdup(s->from), *to = strdup(s->to);
	if (!strcmp(op, "deliver")) {
		for (size_t i = 0; i < n; i++) hear(from, to, taken[i].p, taken[i].n);
	}
	views(out, strcmp(op, "deliver") ? "dropped" : "got", taken, n);
	for (size_t i = 0; i < n; i++) free((void *)taken[i].p);
	free(from), free(to);
}

static void inject(const op_value *r, FILE *out) {
	const char *from = hh_str(r, "from"), *to = hh_str(r, "to");
	uint8_t *b;
	long n = hh_str(r, "bytes") ? unhex(hh_str(r, "bytes"), &b) : (long)message(op_get(r, "message"), &b);
	if (!side_of(to, from)) { hh_error(out, "no link"); return; }
	if (n < 0 || (!n && !hh_str(r, "bytes"))) { hh_error(out, "not a message"); return; }
	hear(from, to, b, (size_t)n);
	fputs("{}", out);
}


static int on_disk(device *d) {
	tp_store *store = tp_file_store(&w.mem, d->dir, MAX);
	tp_log_options o = {w.mem, store, d->seed, 1, {0, 0, 0}, told, d};
	tp_log *log = store ? tp_log_new(&o) : NULL;
	int why = log ? tp_log_load(log) : TP_NOMEM;
	if (why) {
		if (log) tp_log_free(log);
		else if (store) store->close(store->self);
		return why;
	}
	d->log = log, d->store = store;
	tp_sync_options so = {w.mem, log, 0, heard, random_, d, 0, MAX};
	if (!(d->sync = tp_sync_new(&so))) hh_fail("out of memory");
	return 0;
}

static void disk(const op_value *r, FILE *out) {
	const char *name = hh_str(r, "name") ? hh_str(r, "name") : "";
	uint8_t *seed, *log = NULL;
	long n = 0;
	if (named(name)) { hh_error(out, "%s is made", name); return; }
	if (unhex(hh_str(r, "seed"), &seed) != 32) { hh_error(out, "a seed is 32 bytes"); return; }
	if (hh_str(r, "log") && (n = unhex(hh_str(r, "log"), &log)) < 0) { hh_error(out, "not hex"); return; }
	const char *tmp = getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp";
	char dir[4096];
	static unsigned made_dirs;
	snprintf(dir, sizeof dir, "%s/tippet-%ld-%u", tmp, (long)getpid(), made_dirs++);
	if (mkdir(dir, 0700)) hh_fail("no directory");
	if (log) {
		char path[4200];
		snprintf(path, sizeof path, "%s/log", dir);
		FILE *f = fopen(path, "wb");
		if (!f || fwrite(log, 1, (size_t)n, f) != (size_t)n || fclose(f)) hh_fail("log not written");
	}
	device *d = calloc(1, sizeof *d);
	device **grown = realloc(w.devices, (w.count + 1) * sizeof *grown);
	if (!d || !grown) hh_fail("out of memory");
	w.devices = grown;
	d->name = strdup(name), d->dir = strdup(dir);
	memcpy(d->seed, seed, 32), tp_key_of(&d->key, seed), d->keyed = 1;
	w.devices[w.count++] = d;
	int why = on_disk(d);
	if (why) { hh_error(out, "%s", tp_why(why)); return; }
	fputs("{\"key\":", out), hex(out, tp_log_device(d->log), 32), fputc('}', out);
}

static device *on(const op_value *r, FILE *out) {
	device *d = which(r, "device", out);
	if (d && !d->dir) return hh_error(out, "%s is not on disk", d->name), NULL;
	return d;
}

static void reset(const op_value *r, FILE *out) {
	device *d = on(r, out);
	if (!d) return;
	for (size_t i = 0; i < w.nsides; i++) {
		if (!strcmp(w.sides[i]->from, d->name) || !strcmp(w.sides[i]->to, d->name))
			{ hh_error(out, "%s is linked", d->name); return; }
	}
	d->store->sync = NULL;
	tp_sync_free(d->sync), tp_log_free(d->log);
	d->sync = NULL, d->log = NULL;
	int why = on_disk(d);
	if (why) { hh_error(out, "%s", tp_why(why)); return; }
	fprintf(out, "{\"count\":%llu}", (unsigned long long)tp_log_count(d->log, tp_log_device(d->log)));
}

static size_t slurp(const device *d, const char *name, uint8_t **out) {
	char path[4200];
	snprintf(path, sizeof path, "%s/%s", d->dir, name);
	FILE *f = fopen(path, "rb");
	size_t n = 0, got;
	uint8_t chunk[4096];
	*out = NULL;
	if (!f) return 0;
	while ((got = fread(chunk, 1, sizeof chunk, f)) > 0) {
		uint8_t *b = realloc(*out, n + got);
		if (!b) hh_fail("out of memory");
		memcpy(b + n, chunk, got), *out = b, n += got;
	}
	fclose(f);
	if (*out) {
		uint8_t *held = hh_take(n);
		memcpy(held, *out, n), free(*out), *out = held;
	}
	return n;
}

static void frames(FILE *out, const uint8_t *b, size_t size) {
	fputc('[', out);
	for (size_t at = 0, i = 0; at + 4 <= size; i++) {
		size_t length = tp_get32(b + at);
		if (!length || length > size - at - 4) break;
		const uint8_t *r = b + at + 4;
		tp_step s;
		tp_span pack;
		tp_prior prior;
		int has, after;
		uint64_t first;
		if (i) fputc(',', out);
		if (tp_is_run(r, length)) tp_record_pack(r, length, &pack, &prior, &has);
		if (tp_is_run(r, length) && !tp_pack_first(pack, &first, &after) && tp_pack_count(pack)) {
			fputs("[\"run\",", out), nameof(out, r + 7);
			fprintf(out, ",%llu,%llu]", (unsigned long long)first, (unsigned long long)(first + tp_pack_count(pack) - 1));
		} else if (!tp_step_decode(r, length, &s)) {
			fputs("[\"step\",", out), nameof(out, s.device), fprintf(out, ",%llu]", (unsigned long long)s.n);
		} else {
			fputs("[\"other\"]", out);
		}
		at += 4 + length;
	}
	fputc(']', out);
}

static void files(const op_value *r, FILE *out) {
	device *d = on(r, out);
	if (!d) return;
	uint8_t *log, *open;
	size_t nlog = slurp(d, "log", &log), nopen = slurp(d, "open", &open);
	fputs("{\"log\":", out), frames(out, log, nlog);
	fputs(",\"open\":", out), frames(out, open, nopen);
	fprintf(out, ",\"bytes\":{\"log\":%zu,\"open\":%zu}}", nlog, nopen);
}

static void tear(const op_value *r, FILE *out) {
	device *d = on(r, out);
	const char *name = hh_str(r, "file");
	int64_t k;
	if (!d) return;
	if (!name || !whole(op_get(r, "bytes"), &k)) { hh_error(out, "not a tear"); return; }
	char path[4200];
	struct stat st;
	snprintf(path, sizeof path, "%s/%s", d->dir, name);
	if (stat(path, &st)) { hh_error(out, "no %s", name); return; }
	if (truncate(path, st.st_size > k ? st.st_size - k : 0)) hh_fail("not cut");
	fputs("{}", out);
}

static void write_disk(device *d, const op_value *r, FILE *out) {
	const op_value *patches = op_get(r, "patches"), *who = op_get(r, "who");
	int64_t when = WHEN;
	uint8_t *ps;
	if (!patches || patches->type != OP_LIST || !hh_str(r, "node")) { hh_error(out, "not a write"); return; }
	if (op_get(r, "when") && !whole(op_get(r, "when"), &when)) { hh_error(out, "not a when"); return; }
	op_value *revived = hh_hold(op_list());
	for (size_t i = 0; i < patches->count; i++) {
		const op_value *given = patches->items[i];
		op_patch p;
		hh_patch(given, &p);
		op_value *m = op_map();
		for (size_t k = 0; k < given->count; k++) {
			int value = !strcmp(given->keys[k], "value");
			op_set(m, given->keys[k], op_ref((op_value *)(value ? p.value : given->items[k])));
		}
		op_push(revived, m);
	}
	size_t np = encode(revived, &ps);
	const char *node = hh_str(r, "node"), *part = hh_str(r, "part") ? hh_str(r, "part") : "value";
	tp_write x = {{(const uint8_t *)node, strlen(node)}, {(const uint8_t *)part, strlen(part)}, {ps, np},
		{who && who->type == OP_STR ? (const uint8_t *)who->str : NULL, who && who->type == OP_STR ? who->bytes : 0},
		(uint64_t)when, {NULL, 0}};
	uint64_t n, lamport;
	int why = tp_log_write(d->log, &x, &n, &lamport);
	if (why) { hh_error(out, "%s", tp_why(why)); return; }
	fprintf(out, "{\"n\":%llu,\"lamport\":%llu}", (unsigned long long)n, (unsigned long long)lamport);
}


void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	uint8_t *b;
	long n;
	if (!op) { hh_unknown(out, r); return; }
	bury();
	if (!strcmp(op, "encode")) {
		const op_value *s = op_get(r, "step");
		size_t length = s ? stepin(s, NULL, NULL, &b) : 0;
		if (!length) { hh_error(out, "not a device"); return; }
		fputs("{\"bytes\":", out), hex(out, b, length), fputc('}', out);
	} else if (!strcmp(op, "decode")) {
		tp_step s;
		op_value *a;
		if ((n = unhex(hh_str(r, "bytes"), &b)) < 0) { hh_error(out, "not hex"); return; }
		if (tp_step_decode(b, (size_t)n, &s) || !(a = decode(b, (size_t)n)))
			{ fputs("{\"refused\":true}", out); return; }
		fputs("{\"step\":{\"device\":", out), hex(out, s.device, 32);
		fputs(",\"n\":", out), op_json_write(out, a->items[1]);
		fputs(",\"before\":", out);
		if (s.before) hex(out, s.before, 32);
		else fputs("null", out);
		const char *fields[] = {"", "", "", "node", "part", "patches", "lamport", "when", "who", "who"};
		for (size_t i = 3; i < a->count; i++) {
			if (i == 8 && s.on.p) {
				size_t at = 0, k = 0;
				const uint8_t *d;
				uint64_t m;
				fputs(",\"on\":[", out);
				while (!tp_on_next(&s, &at, &d, &m)) {
					fputs(k++ ? ",[" : "[", out), hex(out, d, 32), fprintf(out, ",%llu]", (unsigned long long)m);
				}
				fputc(']', out);
				continue;
			}
			fprintf(out, ",\"%s\":", fields[i]);
			if (i != 3 || !s.relative) { op_json_write(out, a->items[i]); continue; }
			size_t k = tp_step_node(&s, NULL, 0);
			char *node = hh_take(k + 1);
			tp_step_node(&s, node, k), node[k] = 0;
			op_json_string(out, node), fputs(",\"relative\":true", out);
		}
		fputs("}}", out);
	} else if (!strcmp(op, "hash")) {
		uint8_t hash[32];
		if ((n = unhex(hh_str(r, "bytes"), &b)) < 0) { hh_error(out, "not hex"); return; }
		tp_step_hash(b, (size_t)n, hash);
		fputs("{\"hash\":", out), hex(out, hash, 32), fputc('}', out);
	} else if (!strcmp(op, "sign")) {
		uint8_t *seed, sig[64];
		tp_key k;
		if (unhex(hh_str(r, "seed"), &seed) != 32) { hh_error(out, "a seed is 32 bytes"); return; }
		if ((n = unhex(hh_str(r, "bytes"), &b)) < 0) { hh_error(out, "not hex"); return; }
		tp_key_of(&k, seed);
		tp_sign(&k, b, (size_t)n, sig);
		fputs("{\"sig\":", out), hex(out, sig, 64), fputc('}', out);
	} else if (!strcmp(op, "pack")) {
		tp_span *s, pack;
		tp_prior prior;
		long k = spans(op_get(r, "steps"), &s);
		int why = k < 0 ? TP_NOTSTEP : 0;
		if (!why && hh_str(r, "before") && ((n = unhex(hh_str(r, "before"), &b)) < 0 || tp_prior_of(b, (size_t)n, &prior)))
			why = TP_NOTSTEP;
		if (!why) why = tp_pack_after(&w.mem, hh_str(r, "before") ? &prior : NULL, s, (size_t)k, MAX, &pack);
		if (why) { hh_error(out, "%s", tp_why(why)); return; }
		fputs("{\"pack\":", out), hex(out, pack.p, pack.n), fputc('}', out);
		tp_span_free(&w.mem, &pack);
	} else if (!strcmp(op, "unpack")) {
		tp_steps s;
		tp_prior prior;
		uint8_t *before;
		long m = 0;
		if ((n = unhex(hh_str(r, "pack"), &b)) < 0) { hh_error(out, "not hex"); return; }
		if (hh_str(r, "before") && ((m = unhex(hh_str(r, "before"), &before)) < 0 || tp_prior_of(before, (size_t)m, &prior)))
			{ hh_error(out, "not a step before"); return; }
		int why = tp_unpack_after(&w.mem, (tp_span){b, (size_t)n}, TP_RUN, hh_str(r, "before") ? &prior : NULL, &s);
		if (why == TP_NOTSTEP || why == TP_BEFORE || why == TP_BOUND) { fputs("{\"refused\":true}", out); return; }
		if (why) { hh_error(out, "%s", tp_why(why)); return; }
		fputs("{\"steps\":", out), steps(out, &s), fputc('}', out);
		tp_steps_free(&w.mem, &s);
	} else if (!strcmp(op, "message")) {
		size_t length = message(op_get(r, "message"), &b);
		if (!length) { hh_error(out, "not a message"); return; }
		fputs("{\"bytes\":", out), hex(out, b, length), fputc('}', out);
	} else if (!strcmp(op, "read")) {
		if ((n = unhex(hh_str(r, "bytes"), &b)) < 0) { hh_error(out, "not hex"); return; }
		if (!readout(out, b, (size_t)n)) fputs("{\"refused\":true}", out);
	} else if (!strcmp(op, "device")) {
		uint8_t *seed;
		if (unhex(hh_str(r, "seed"), &seed) != 32) { hh_error(out, "a seed is 32 bytes"); return; }
		device *d = made(hh_str(r, "name") ? hh_str(r, "name") : "", seed, out);
		if (d) fputs("{\"key\":", out), hex(out, tp_log_device(d->log), 32), fputc('}', out);
	} else if (!strcmp(op, "disk")) {
		disk(r, out);
	} else if (!strcmp(op, "sync")) {
		device *d = on(r, out);
		int why = d && d->store->sync ? d->store->sync(d->store->self) : 0;
		if (d && why) hh_error(out, "%s", tp_why(why));
		else if (d) fputs("{}", out);
	} else if (!strcmp(op, "reset")) {
		reset(r, out);
	} else if (!strcmp(op, "tear")) {
		tear(r, out);
	} else if (!strcmp(op, "files")) {
		files(r, out);
	} else if (!strcmp(op, "relay")) {
		if (made(hh_str(r, "name") ? hh_str(r, "name") : "", NULL, out)) fputs("{}", out);
	} else if (!strcmp(op, "write")) {
		written(r, out);
	} else if (!strcmp(op, "value")) {
		value(r, out);
	} else if (!strcmp(op, "versions")) {
		versions(r, out);
	} else if (!strcmp(op, "link")) {
		join(r, out);
	} else if (!strcmp(op, "unlink")) {
		unjoin(r, out);
	} else if (!strcmp(op, "queued") || !strcmp(op, "deliver") || !strcmp(op, "drop")) {
		waiting(r, op, out);
	} else if (!strcmp(op, "inject")) {
		inject(r, out);
	} else if (!strcmp(op, "live")) {
		device *d = which(r, "device", out);
		if (!d) return;
		if ((n = unhex(hh_str(r, "data"), &b)) < 0) { hh_error(out, "not hex"); return; }
		int why = tp_sync_live(d->sync, b, (size_t)n);
		if (why) { hh_error(out, "%s", tp_why(why)); return; }
		fputs("{}", out);
	} else if (!strcmp(op, "heard")) {
		device *d = which(r, "device", out);
		if (!d) return;
		fputs("{\"heard\":[", out);
		for (size_t i = 0; i < d->nheard; i++) {
			if (i) fputc(',', out);
			hex(out, d->heard[i].p, d->heard[i].n);
		}
		fputs("]}", out);
	} else if (!strcmp(op, "have")) {
		device *d = which(r, "device", out);
		if (!d) return;
		fputs("{\"have\":{", out);
		for (size_t i = 0; i < tp_log_devices(d->log); i++) {
			uint64_t have;
			const uint8_t *key = tp_log_have(d->log, i, &have);
			if (i) fputc(',', out);
			nameof(out, key), fprintf(out, ":%llu", (unsigned long long)have);
		}
		fputs("}}", out);
	} else if (!strcmp(op, "count") || !strcmp(op, "steps")) {
		device *d = which(r, "device", out);
		const uint8_t *key = keyof(hh_str(r, "of"));
		if (!d) return;
		if (!key) { hh_error(out, "no device %s", hh_str(r, "of") ? hh_str(r, "of") : "(none)"); return; }
		uint64_t count = tp_log_count(d->log, key);
		if (!strcmp(op, "count")) { fprintf(out, "{\"count\":%llu}", (unsigned long long)count); return; }
		fputs("{\"steps\":[", out);
		for (uint64_t i = 1; i <= count; i++) {
			tp_span s = stepof(d->log, key, i);
			if (i > 1) fputc(',', out);
			hex(out, s.p, s.n);
		}
		fputs("]}", out);
	} else if (!strcmp(op, "run")) {
		device *d = which(r, "device", out);
		const uint8_t *key = keyof(hh_str(r, "of"));
		int64_t from;
		uint64_t to;
		uint8_t sig[64];
		if (!d) return;
		if (!key || !op_as_int64(op_get(r, "from"), &from)) { hh_error(out, "not a run"); return; }
		if (from < 0 || tp_log_run(d->log, key, (uint64_t)from, &to, sig)) { fputs("{}", out); return; }
		fprintf(out, "{\"from\":%lld,\"to\":%llu,\"sig\":", (long long)from, (unsigned long long)to);
		hex(out, sig, 64), fputc('}', out);
	} else if (!strcmp(op, "take")) {
		take(r, out);
	} else if (!strcmp(op, "pass")) {
		pass(r, out);
	} else {
		hh_unknown(out, r);
	}
}
