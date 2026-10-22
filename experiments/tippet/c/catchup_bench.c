// tippet-catchup-bench: what a device in one room holds while it catches up on 1000 typed characters, a
// run at a time. a writer types them (a step each: one character spliced into a string), and its
// runs are taken off a link as they would go. then a fresh device, its graph made (table, places,
// scheduler), takes them one message at a time: its log, history and sync, with one of two stores
//
//   memory: every record, as tp_memory_store keeps them
//   heads:  only the last 64 of others' steps (enough to land a run); its own would all stay
//
// told: the device's tippet heap (tp_mem, counted: peak and at the end), and the whole process's
// in use (malloc's zone: the graph's too) above what it was before the device was made, sampled
// after each run. macOS (malloc_zone_statistics)
//   ./tippet-catchup-bench [memory | heads]
#include <malloc/malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "history.h"
#include "tippet.h"

#define CHARS 1000

// one part's heap, and all of them together
typedef struct heap {
	size_t now, peak;
	struct heap *all;
} heap;

static void count(heap *h, size_t old, size_t size) {
	for (; h; h = h->all) h->now = h->now - old + size, h->peak = h->now > h->peak ? h->now : h->peak;
}
static void *counted(void *ctx, void *p, size_t old, size_t size) {
	if (!size) return free(p), count(ctx, old, 0), NULL;
	void *q = realloc(p, size);
	if (q) count(ctx, old, size);
	return q;
}

static size_t in_use(void) {
	malloc_statistics_t s;
	malloc_zone_statistics(NULL, &s);
	return s.size_in_use;
}

// ---- the heads store

#define KEEP 64
typedef struct {
	tp_store store;
	tp_mem mem;
	uint8_t key[32];
	int keyed;
	// others' last steps, a ring
	struct {
		uint8_t device[32];
		uint64_t n;
		uint8_t *bytes;
		size_t length;
	} ring[KEEP];
	size_t at;
} heads;

static int h_load(void *self, tp_read read, void *ctx) { return (void)self, (void)read, (void)ctx, 0; }
static int h_append(void *self, const uint8_t *record, size_t length, const tp_at *at) {
	heads *h = self;
	if (!at) return 0;
	void *b = h->ring[h->at].bytes;
	if (b) h->mem.fn(h->mem.ctx, b, h->ring[h->at].length, 0);
	if (!(b = h->mem.fn(h->mem.ctx, NULL, 0, length))) return TP_NOMEM;
	memcpy(b, record, length);
	memcpy(h->ring[h->at].device, at->device, 32);
	h->ring[h->at].n = at->n, h->ring[h->at].bytes = b, h->ring[h->at].length = length;
	h->at = (h->at + 1) % KEEP;
	return 0;
}
static long h_get(void *self, const uint8_t device[32], uint64_t n, uint8_t *out, size_t cap) {
	heads *h = self;
	for (size_t i = 0; i < KEEP; i++) {
		if (h->ring[i].bytes && h->ring[i].n == n && !memcmp(h->ring[i].device, device, 32)) {
			if (h->ring[i].length <= cap) memcpy(out, h->ring[i].bytes, h->ring[i].length);
			return (long)h->ring[i].length;
		}
	}
	return -1;
}
static int h_key(void *self, const uint8_t seed[32], uint8_t key[32]) {
	heads *h = self;
	if (!h->keyed) memcpy(h->key, seed, 32), h->keyed = 1;
	memcpy(key, h->key, 32);
	return 0;
}
static void h_close(void *self) {
	heads *h = self;
	tp_mem mem = h->mem;
	for (size_t i = 0; i < KEEP; i++) {
		if (h->ring[i].bytes) mem.fn(mem.ctx, h->ring[i].bytes, h->ring[i].length, 0);
	}
	mem.fn(mem.ctx, h, sizeof *h, 0);
}
static tp_store *heads_store(const tp_mem *mem) {
	heads *h = mem->fn(mem->ctx, NULL, 0, sizeof *h);
	if (!h) return NULL;
	memset(h, 0, sizeof *h);
	h->mem = *mem;
	h->store = (tp_store){h, h_load, h_append, h_get, h_key, h_close};
	return &h->store;
}

// ---- the writer's runs

typedef struct {
	uint8_t **items;
	size_t *lengths, n;
} messages;

static int caught(void *ctx, const uint8_t *bytes, size_t length) {
	messages *m = ctx;
	m->items = realloc(m->items, (m->n + 1) * sizeof *m->items);
	m->lengths = realloc(m->lengths, (m->n + 1) * sizeof *m->lengths);
	if (!m->items || !m->lengths || !(m->items[m->n] = malloc(length))) abort();
	memcpy(m->items[m->n], bytes, length);
	m->lengths[m->n++] = length;
	return 0;
}

static void *plain(void *ctx, void *p, size_t old, size_t size) {
	(void)ctx, (void)old;
	if (!size) return free(p), NULL;
	return realloc(p, size);
}

// the writer's 1000 characters, as the runs its sync sends one who has none
static messages typed(void) {
	tp_mem mem = {plain, NULL};
	uint8_t seed[32];
	memset(seed, 7, 32);
	tp_log_options o = {mem, tp_memory_store(&mem, 1 << 24), seed, 1, {0, 0, 0}, NULL, NULL};
	tp_log *log = tp_log_new(&o);
	uint64_t n, lamport;
	tp_log_load(log);
	// [{path: [], value: ""}], then [{path: [], range: [i, i], value: "c"}]
	uint8_t first[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x80, 0x65, 'v', 'a', 'l', 'u', 'e', 0x60};
	tp_write w = {{(const uint8_t *)"text", 4}, {(const uint8_t *)"value", 5}, {first, sizeof first},
		{NULL, 0}, 1760000000};
	tp_log_write(log, &w, &n, &lamport);
	for (unsigned i = 0; i < CHARS; i++) {
		uint8_t p[32] = {0x81, 0xa3, 0x64, 'p', 'a', 't', 'h', 0x80, 0x65, 'r', 'a', 'n', 'g', 'e', 0x82};
		size_t at = 15;
		for (int k = 0; k < 2; k++) {
			if (i < 24) p[at++] = (uint8_t)i;
			else if (i < 256) p[at++] = 0x18, p[at++] = (uint8_t)i;
			else p[at++] = 0x19, p[at++] = (uint8_t)(i >> 8), p[at++] = (uint8_t)i;
		}
		memcpy(p + at, "\x65value\x61", 7), at += 7;
		p[at++] = (uint8_t)('a' + i % 26);
		w.patches = (tp_span){p, at}, w.when = 1760000000 + i / 5;
		if (tp_log_write(log, &w, &n, &lamport)) abort();
	}
	messages m = {NULL, NULL, 0};
	tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
	tp_sync *sync = tp_sync_new(&so);
	tp_link *l = tp_sync_link(sync, caught, &m, 0);
	// ["have", []]: it has none, and is sent every run
	tp_sync_receive(sync, l, (const uint8_t *)"\x82\x64have\x80", 7);
	tp_sync_free(sync);
	tp_log_free(log);
	return m;
}

// ---- the device

static int dropped(void *ctx, const uint8_t *bytes, size_t length) {
	(void)bytes;
	*(size_t *)ctx += length;
	return 0;
}

typedef struct {
	tp_history *history;
	tp_sync *sync;
	sc_scope *scope;
} device;

static void told(void *ctx, const uint8_t key[32], uint64_t from, size_t count) {
	device *d = ctx;
	tp_history_told(d->history, key, from, count);
	tp_sync_told(d->sync, key, from, count);
}
static void inside(void *ctx, void (*f)(void *data), void *data) {
	sc_run_with_scope(((device *)ctx)->scope, f, data);
}
static void drop_value(void *value, void *data) {
	(void)data;
	op_free(value);
}

static void catch_up(const messages *m, int keep_heads) {
	size_t before = in_use(), most = 0, sent = 0;
	// the parts' heaps: store, log, history, sync
	heap h = {0, 0, NULL}, parts[4] = {{0, 0, &h}, {0, 0, &h}, {0, 0, &h}, {0, 0, &h}};
	tp_mem mem[4];
	for (int i = 0; i < 4; i++) mem[i] = (tp_mem){counted, &parts[i]};
	uint8_t seed[32];
	memset(seed, 9, 32);
	device d = {0};
	// the graph, as the Cardputer's host makes it
	pl *places = pl_new();
	sc_scheduler *s = sc_new((sc_options){.drop = drop_value});
	sc_on_tracking_end(s, pl_forget, places);
	tb_table *table = tb_make(pl_event, places);
	pt_paths *paths = pt_new();
	pl_connect(places, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths, .scheduler = s});
	sc_pair info = {"actor", op_str("cardputer")};
	d.scope = sc_create_root_scope(s, &info, 1);
	size_t graph = in_use() - before;
	tp_store *store = keep_heads ? heads_store(&mem[0]) : tp_memory_store(&mem[0], 1 << 24);
	tp_log_options o = {mem[1], store, seed, 1, {0, 0, 0}, told, &d};
	tp_log *log = tp_log_new(&o);
	tp_log_load(log);
	tp_history_options ho = {mem[2], log, table, places, NULL, inside, &d};
	d.history = tp_history_new(&ho);
	tp_sync_options so = {mem[3], log, 0, NULL, NULL, NULL, 0, 0};
	d.sync = tp_sync_new(&so);
	tp_link *l = tp_sync_link(d.sync, dropped, &sent, 0);
	size_t first = 0;
	for (size_t i = 0; i < m->n; i++) {
		tp_sync_receive(d.sync, l, m->items[i], m->lengths[i]);
		size_t now = in_use() - before;
		if (now > most) most = now;
		if (i == 0) first = h.peak;
	}
	const nd_entry *e = tb_get(table, tb_string("value"), tb_string("text"));
	tp_failed f;
	printf("%s store: %zu runs, %llu steps held, text %zu bytes, %zu failed\n",
		keep_heads ? "heads" : "memory", m->n - 1, (unsigned long long)tp_log_count(log, m->items[1] + 7),
		e && e->value ? e->value->bytes : 0, tp_history_failed(d.history, 0, &f));
	printf("  tippet heap: peak %zu, at the end %zu (peak after the first run %zu)\n", h.peak, h.now, first);
	static const char *names[4] = {"store", "log", "history", "sync"};
	for (int i = 0; i < 4; i++) {
		printf("    %-8s peak %zu, at the end %zu\n", names[i], parts[i].peak, parts[i].now);
	}
	printf("  process in use above before: empty graph %zu, most after a run %zu, at the end %zu\n",
		graph, most, in_use() - before);
	tp_sync_free(d.sync);
	tp_history_free(d.history);
	tp_log_free(log);
	sc_free(s), tb_free(table), pt_free(paths), pl_free(places);
	op_free((op_value *)info.value);
}

int main(int argc, char **argv) {
	messages m = typed();
	size_t bytes = 0;
	for (size_t i = 0; i < m.n; i++) bytes += m.lengths[i];
	printf("tippet-catchup-bench: %d characters typed, %zu run messages (and a have), %zu bytes on the wire\n", CHARS, m.n - 1, bytes);
	// one store, else both
	const char *only = argc > 1 ? argv[1] : "";
	if (strcmp(only, "heads")) catch_up(&m, 0);
	if (strcmp(only, "memory")) catch_up(&m, 1);
	for (size_t i = 0; i < m.n; i++) free(m.items[i]);
	free(m.items), free(m.lengths);
	return 0;
}
