// tippet-catchup-bench: a fresh device catches up on 1000 typed characters, then stays in a room
// with
// the writer; reports the tippet heap and the process's memory. macOS only.
//   ./tippet-catchup-bench [memory | file | forgets]
#include <malloc/malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "history.h"
#include "tippet.h"

#define CHARS 1000
#define TURNS 1200
#define WARM 200

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

static void *plain(void *ctx, void *p, size_t old, size_t size) {
	(void)ctx, (void)old;
	if (!size) return free(p), NULL;
	return realloc(p, size);
}


typedef struct {
	uint8_t **items;
	size_t *lengths, n;
} messages;

static int queued(void *ctx, const uint8_t *bytes, size_t length) {
	messages *m = ctx;
	m->items = realloc(m->items, (m->n + 1) * sizeof *m->items);
	m->lengths = realloc(m->lengths, (m->n + 1) * sizeof *m->lengths);
	if (!m->items || !m->lengths || !(m->items[m->n] = malloc(length))) abort();
	memcpy(m->items[m->n], bytes, length);
	m->lengths[m->n++] = length;
	return 0;
}

static void let_go(messages *m) {
	for (size_t i = 0; i < m->n; i++) free(m->items[i]);
	free(m->items), free(m->lengths);
	m->items = NULL, m->lengths = NULL, m->n = 0;
}


static size_t typing(uint8_t p[32], unsigned i) {
	memcpy(p, "\x81\xa3\x64path\x80\x65range\x82", 15);
	size_t at = 15;
	for (int k = 0; k < 2; k++) {
		if (i < 24) p[at++] = (uint8_t)i;
		else if (i < 256) p[at++] = 0x18, p[at++] = (uint8_t)i;
		else p[at++] = 0x19, p[at++] = (uint8_t)(i >> 8), p[at++] = (uint8_t)i;
	}
	memcpy(p + at, "\x65value\x61", 7), at += 7;
	p[at++] = (uint8_t)('a' + i % 26);
	return at;
}

static void type(tp_log *log, unsigned i) {
	uint8_t p[32];
	tp_write w = {{(const uint8_t *)"text", 4}, {(const uint8_t *)"value", 5}, {p, typing(p, i)},
		{NULL, 0}, 1760000000 + i / 5, {NULL, 0}, {NULL, 0}};
	uint64_t n, lamport;
	if (tp_log_write(log, &w, &n, &lamport)) abort();
}

static tp_log *writer(void) {
	tp_mem mem = {plain, NULL};
	uint8_t seed[32];
	memset(seed, 7, 32);
	tp_log_options o = {mem, tp_memory_store(&mem, 1 << 24), seed, 1, {0, 0, 0}, NULL, NULL};
	tp_log *log = tp_log_new(&o);
	uint64_t n, lamport;
	tp_log_load(log);
	uint8_t first[] = {0x81, 0xa2, 0x64, 'p', 'a', 't', 'h', 0x80, 0x65, 'v', 'a', 'l', 'u', 'e', 0x60};
	tp_write w = {{(const uint8_t *)"text", 4}, {(const uint8_t *)"value", 5}, {first, sizeof first},
		{NULL, 0}, 1760000000, {NULL, 0}, {NULL, 0}};
	tp_log_write(log, &w, &n, &lamport);
	for (unsigned i = 0; i < CHARS; i++) type(log, i);
	return log;
}

static messages typed(tp_log *log) {
	tp_mem mem = {plain, NULL};
	messages m = {NULL, NULL, 0};
	tp_sync_options so = {mem, log, 0, NULL, NULL, NULL, 0, 0};
	tp_sync *sync = tp_sync_new(&so);
	tp_link *l = tp_sync_link(sync, queued, &m, 0);
	tp_sync_receive(sync, l, (const uint8_t *)"\x82\x64have\x80", 7);
	tp_sync_free(sync);
	return m;
}


typedef struct {
	tp_history *history;
	tp_sync *sync;
	sc_scope *scope;
	tb_table *table;
	pl *places;
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

typedef struct {
	device *d;
	unsigned i;
} own;
typedef struct {
	op_value *value;
	op_patch patch;
} held;
static void unhold(void *p) {
	op_free(((held *)p)->value), free(p);
}
static void own_f(void *data) {
	own *o = data;
	device *d = o->d;
	tb_key part = tb_string("value"), id = tb_string("mine");
	ch_header header = {.has_time = 1, .time = 1760000000 + o->i / 5};
	nd_entry *e = tb_get(d->table, part, id);
	if (!e) {
		op_value *v = op_str("");
		e = nd_make_entry(v, &header);
		op_free(v);
		pl_own(d->places, e);
		tb_sub(d->table, part, id, e);
		return;
	}
	held *h = malloc(sizeof *h);
	char c[2] = {(char)('a' + o->i % 26), 0};
	memset(h, 0, sizeof *h);
	h->value = op_str(c);
	h->patch.place.has_range = 1, h->patch.place.from = h->patch.place.to = o->i - 1;
	h->patch.has_value = 1, h->patch.value = h->value;
	size_t failed;
	if (nd_update(e, &h->patch, 1, header, &failed)) abort();
	pl_hold(d->places, e, h, unhold);
	pl_changed changed = {1, {e, NULL}};
	pl_commit(d->places, &changed);
}

static void deliver(tp_sync *a, tp_link *at_a, messages *to_a, tp_sync *b, tp_link *at_b, messages *to_b) {
	while (to_a->n || to_b->n) {
		messages ma = *to_a, mb = *to_b;
		*to_a = (messages){NULL, NULL, 0}, *to_b = (messages){NULL, NULL, 0};
		for (size_t i = 0; i < ma.n; i++) tp_sync_receive(a, at_a, ma.items[i], ma.lengths[i]);
		for (size_t i = 0; i < mb.n; i++) tp_sync_receive(b, at_b, mb.items[i], mb.lengths[i]);
		let_go(&ma), let_go(&mb);
	}
}

static void bench(tp_log *w, const messages *m, int file, int forgets) {
	size_t before = in_use(), most = 0;
	heap h = {0, 0, NULL}, parts[4] = {{0, 0, &h}, {0, 0, &h}, {0, 0, &h}, {0, 0, &h}};
	tp_mem mem[4];
	for (int i = 0; i < 4; i++) mem[i] = (tp_mem){counted, &parts[i]};
	uint8_t seed[32];
	memset(seed, 9, 32);
	device d = {0};
	pl *places = pl_new();
	sc_scheduler *s = sc_new((sc_options){.drop = drop_value});
	sc_on_tracking_end(s, pl_forget, places);
	tb_table *table = tb_make(pl_event, places);
	pt_paths *paths = pt_new();
	pl_connect(places, &(pl_setup){.root = tb_string("R"), .table = table, .paths = paths, .scheduler = s});
	sc_pair info = {"actor", op_str("cardputer")};
	d.scope = sc_create_root_scope(s, &info, 1);
	d.table = table, d.places = places;
	size_t graph = in_use() - before;
	char dir[] = "/tmp/tippet-bench-XXXXXX";
	if (file && !mkdtemp(dir)) abort();
	tp_store *store = file ? tp_file_store(&mem[0], dir, 1 << 20) : tp_memory_store(&mem[0], 1 << 24);
	tp_log_options o = {mem[1], store, seed, 1, {0, 0, 0}, told, &d};
	tp_log *log = tp_log_new(&o);
	tp_log_load(log);
	tp_history_options ho = {mem[2], log, table, places, NULL, inside, &d, forgets, 0};
	d.history = tp_history_new(&ho);
	tp_sync_options so = {mem[3], log, 0, NULL, NULL, NULL, 0, 0};
	d.sync = tp_sync_new(&so);
	messages dropped = {NULL, NULL, 0};
	tp_link *l = tp_sync_link(d.sync, queued, &dropped, 0);
	size_t first = 0;
	for (size_t i = 0; i < m->n; i++) {
		tp_sync_receive(d.sync, l, m->items[i], m->lengths[i]);
		if (forgets && i % 2 == 0) tp_history_forget(d.history, d.sync);
		size_t now = in_use() - before;
		if (now > most) most = now;
		if (i == 0) first = h.peak;
	}
	let_go(&dropped);
	tp_sync_unlink(d.sync, l);
	const nd_entry *e = tb_get(table, tb_string("value"), tb_string("text"));
	tp_failed f;
	uint8_t wkey[32];
	memcpy(wkey, m->items[1] + 7, 32);
	printf("%s store%s: %zu runs, %llu steps held, text %zu bytes, %zu failed\n", file ? "file" : "memory",
		forgets ? ", forgetting" : "",
		m->n - 1, (unsigned long long)tp_log_count(log, wkey), e && e->value ? e->value->bytes : 0,
		tp_history_failed(d.history, 0, &f));
	printf("  tippet heap: peak %zu, at the end %zu (peak after the first run %zu)\n", h.peak, h.now, first);
	static const char *names[4] = {"store", "log", "history", "sync"};
	for (int i = 0; i < 4; i++) {
		printf("    %-8s peak %zu, at the end %zu\n", names[i], parts[i].peak, parts[i].now);
	}
	printf("  process in use above before: empty graph %zu, most after a run %zu, at the end %zu\n",
		graph, most, in_use() - before);

	tp_mem wmem = {plain, NULL};
	tp_sync_options wo = {wmem, w, 0, NULL, NULL, NULL, 0, 0};
	tp_sync *ws = tp_sync_new(&wo);
	messages to_w = {NULL, NULL, 0}, to_d = {NULL, NULL, 0};
	tp_link *dl = tp_sync_link(d.sync, queued, &to_w, 0), *wl = tp_sync_link(ws, queued, &to_d, 0);
	if (forgets) tp_sync_keeper(d.sync, dl);
	deliver(d.sync, dl, &to_d, ws, wl, &to_w);
	size_t warm[5] = {0}, end[5] = {0};
	uint64_t steps = 0;
	for (unsigned i = 0; i < TURNS; i++) {
		type(w, CHARS + i);
		tp_sync_told(ws, tp_log_device(w), tp_log_count(w, tp_log_device(w)), 1);
		own o = {&d, i};
		inside(&d, own_f, &o);
		deliver(d.sync, dl, &to_d, ws, wl, &to_w);
		if (forgets && (i + 1) % 8 == 0) tp_history_forget(d.history, d.sync);
		if (i + 1 == WARM || i + 1 == TURNS) {
			size_t *at = i + 1 == WARM ? warm : end;
			at[0] = h.now;
			for (int k = 0; k < 4; k++) at[k + 1] = parts[k].now;
			if (i + 1 == WARM) steps = tp_log_count(log, wkey) + tp_log_count(log, tp_log_device(log));
		}
	}
	steps = tp_log_count(log, wkey) + tp_log_count(log, tp_log_device(log)) - steps;
	e = tb_get(table, tb_string("value"), tb_string("mine"));
	printf("  in the room, %u turns: %llu steps more from turn %d, \"mine\" %zu bytes; per step: %.1f bytes (",
		TURNS, (unsigned long long)steps, WARM, e && e->value ? e->value->bytes : 0,
		(double)(end[0] - warm[0]) / (double)steps);
	for (int k = 0; k < 4; k++) {
		printf("%s %s %.1f", k ? "," : "", names[k], ((double)end[k + 1] - (double)warm[k + 1]) / (double)steps);
	}
	printf("); at the end %zu\n", h.now);
	tp_sync_free(ws);
	tp_sync_free(d.sync);
	tp_history_free(d.history);
	tp_log_free(log);
	sc_free(s), tb_free(table), pt_free(paths), pl_free(places);
	op_free((op_value *)info.value);
	if (file) {
		char path[64];
		static const char *const files[] = {"log", "snapshot", "key", "open", "index", "i0", "i1"};
		for (size_t i = 0; i < sizeof files / sizeof *files; i++) {
			snprintf(path, sizeof path, "%s/%s", dir, files[i]), unlink(path);
		}
		rmdir(dir);
	}
}

int main(int argc, char **argv) {
	tp_log *w = writer();
	messages m = typed(w);
	size_t bytes = 0;
	for (size_t i = 0; i < m.n; i++) bytes += m.lengths[i];
	printf("tippet-catchup-bench: %d characters typed, %zu run messages (and a have), %zu bytes on the wire\n", CHARS, m.n - 1, bytes);
	tp_log_free(w);
	const char *only = argc > 1 ? argv[1] : "";
	for (int k = 0; k < 4; k++) {
		int file = k & 1, forgets = k >> 1;
		if (*only && strcmp(only, forgets ? "forgets" : file ? "file" : "memory")) continue;
		w = writer();
		bench(w, &m, file, forgets);
		tp_log_free(w);
	}
	let_go(&m);
	return 0;
}
