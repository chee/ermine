// Two hosts typing into one text at once, merging by eg-walker (extensions/sync/typescript/
// merge_bench.ts, in C): the CPU time it takes (the machine may be loaded, so wall time misleads), and
// the part of it merging. merge-bench [keys per host] [pure: eg-walker from scratch every merge,
// without its walker]. Two syncs over one in-memory pipe (wires.h), each with a table of its own; the
// host's writes as the sync harness makes them, with no places
#include "egwalker.h"
#include "sync.h"
#include "wires.h"

#include "../../../core/node/c/update.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/resource.h>

static double cpu_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &t);
	return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}
static double wall_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

// every merge timed, the walker's too
static double merging;
static void timed(void *state, const hy_history *h, const hy_kept *const *heads, size_t n, rp_get get, void *context,
	rp_tables *out) {
	double t = cpu_ms();
	eg_rule.merge(state, h, heads, n, get, context, out);
	merging += cpu_ms() - t;
}
static rp_rule rule = {"eg-walker", timed, NULL, NULL};

typedef struct {
	tb_table *table;
	sy_sync *sync;
	op_value *actor;
	// a memory store is never freed (store.h): kept here, reachable
	ErmStore *store;
	nd_entry **made;
	size_t made_count, made_room;
	unsigned calls;
	char name[8];
} host_t;

static void dropped(void *context, nd_entry *e) {
	host_t *h = context;
	for (size_t i = 0; i < h->made_count; i++) {
		if (h->made[i] != e) continue;
		h->made[i] = h->made[--h->made_count];
		nd_free_entry(e);
		return;
	}
}
static void table_event(void *context, tb_key part, tb_key id) {
	host_t *h = context;
	if (h->sync != NULL) sy_table_changed(h->sync, part, id);
}
static void random_of(void *context, uint8_t *out, size_t n) {
	host_t *h = context;
	char text[32];
	snprintf(text, sizeof text, "%s/%u", h->name, h->calls++);
	uint8_t hash[32];
	cm_name((const uint8_t *)text, strlen(text), hash);
	memcpy(out, hash, n < 32 ? n : 32);
}

static void host(host_t *h, int n) {
	memset(h, 0, sizeof *h);
	snprintf(h->name, sizeof h->name, "host%d", n);
	h->actor = op_str(h->name);
	h->table = tb_make(table_event, h);
	static const rp_rule *merges[1] = {&rule};
	sy_options o = {.table = h->table, .store = NULL, .now = wr_clock, .random = random_of, .merges = merges,
		.merges_length = 1, .merge = "eg-walker", .drop = dropped, .context = h};
	h->store = malloc(sizeof *h->store);
	if (h->store == NULL) abort();
	*h->store = ermStoreMemory();
	o.store = h->store;
	memset(o.seed, n, 32);
	h->sync = sy_create(&o);
	if (h->sync == NULL) abort();
}

static host_t hosts[2];
static void run_all(void) {
	for (int i = 0; i < 2; i++) {
		sy_run(hosts[i].sync);
		wr_drain(sy_device(hosts[i].sync));
	}
}
static void quiet(void) {
	size_t still = 0, last = (size_t)-1;
	for (int round = 0; round < 3000; round++) {
		run_all();
		bool idle = sy_idle(hosts[0].sync) && sy_idle(hosts[1].sync);
		wr_ms += 2;
		if (idle && wr_moved == last) {
			if (++still >= 5) return;
		} else still = 0, last = wr_moved;
	}
}

static void write(host_t *h, const char *id, const op_patch *p) {
	ch_header change = {.has_time = 1, .time = (int64_t)(wr_ms / 1000), .actor = h->actor};
	tb_key part = tb_string("value"), k = tb_string(id);
	nd_entry *e = tb_get(h->table, part, k);
	if (e == NULL) {
		e = nd_make_entry((op_value *)p->value, &change, NULL);
		if (e == NULL) abort();
		if (h->made_count == h->made_room) {
			h->made_room = h->made_room ? 2 * h->made_room : 16;
			h->made = realloc(h->made, h->made_room * sizeof *h->made);
			if (h->made == NULL) abort();
		}
		h->made[h->made_count++] = e;
		tb_add(h->table, part, k, e);
		return;
	}
	size_t failed;
	if (nd_update(e, p, 1, change, &failed) != OP_OK) abort();
	sy_wrote(h->sync, &e, 1);
}

static const op_value *read(host_t *h, const char *id) {
	nd_entry *e = tb_get(h->table, tb_string("value"), tb_string(id));
	return e != NULL ? e->value : NULL;
}

static unsigned long seed = 7;
static long r(long n) {
	seed = (seed * 1103515245 + 12345) % 2147483648ul;
	return (long)(seed % (unsigned long)n);
}

static op_value *a_text;
static void type(host_t *h, const char *id, const char *c) {
	const op_value *v = read(h, id);
	long at = r((long)(v != NULL ? v->bytes : 0) + 1);
	op_value *value = op_str(c);
	op_patch p = {.place = {.length = 0, .has_range = 1, .from = at, .to = at}, .has_value = 1, .value = value};
	write(h, id, &p);
	op_free(value);
}

int main(int argc, char **argv) {
	long keys = argc > 1 ? atol(argv[1]) : 150;
	bool pure = argc > 2 && strcmp(argv[2], "pure") == 0;
	if (!pure) rule.create = eg_rule.create, rule.free = eg_rule.free;
	host(&hosts[0], 1), host(&hosts[1], 2);
	char id[9 + 64 + 1];
	sy_mint(hosts[0].sync, id);
	sy_follow(hosts[1].sync, id);
	tp_device *x = sy_device(hosts[0].sync), *y = sy_device(hosts[1].sync);
	wr_connect(x, y);
	for (int round = 0; round < 3000; round++) {
		run_all();
		if (wr_up(x, y) && tp_fetching(x) == 0 && tp_fetching(y) == 0) break;
		wr_ms += 1;
	}
	a_text = op_str("");
	op_patch first = {.has_value = 1, .value = a_text};
	write(&hosts[0], id, &first);
	quiet();
	double cpu = cpu_ms(), wall = wall_ms();
	for (long i = 0; i < keys; i++) {
		type(&hosts[0], id, "a"), type(&hosts[1], id, "b");
		if (r(3) == 0) run_all();
		if (r(10) == 0) quiet();
	}
	quiet();
	double used = cpu_ms() - cpu;
	const op_value *a = read(&hosts[0], id), *b = read(&hosts[1], id);
	if (a == NULL || b == NULL || a->bytes != (size_t)(2 * keys) || b->bytes != a->bytes || memcmp(a->str, b->str, a->bytes) != 0) {
		fprintf(stderr, "not converged\n");
		return 1;
	}
	printf("2x%ld keys%s: cpu %.0f ms, merging %.0f ms, wall %.0f ms\n", keys, pure ? ", pure" : "", used, merging,
		wall_ms() - wall);
	for (int i = 0; i < 2; i++) {
		wr_close(sy_device(hosts[i].sync));
		sy_free(hosts[i].sync);
		for (size_t k = 0; k < hosts[i].made_count; k++) nd_free_entry(hosts[i].made[k]);
		free(hosts[i].made);
		tb_free(hosts[i].table);
		op_free(hosts[i].actor);
	}
	op_free(a_text);
	wr_free();
	return 0;
}
