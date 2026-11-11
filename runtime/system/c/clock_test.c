// The clock es_create is given: every change's time is read from it, for a host write, a patch, a
// process started and the nodes it makes. And the ids it is given: the root and the
// ids made through create_id and create_process_id. make test-clock-system, test-check-clock-system.
#include "ermine.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			failed = 1; \
		} \
	} while (0)

#define MS 1700000123456LL
#define SECONDS 1700000123LL

static int64_t fixed(void *ctx) {
	(void)ctx;
	return MS;
}

typedef struct {
	char ids[64][16];
	int n;
} ids_t;
static int next_id(void *ctx, char **out) {
	ids_t *t = ctx;
	snprintf(t->ids[t->n], sizeof t->ids[0], "n%d", t->n);
	*out = es_dup(t->ids[t->n++]);
	return 0;
}

static es_out setup(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *h;
	op_value *one = op_num(1);
	CHECK(es_ensure_node(c, es_text("/made"), one, &h) == 0);
	op_free(one);
	return es_out_of(NULL);
}

static int times_are_the_clock(es_ermine *e, ids_t *t) {
	int seen = 0;
	for (int i = 0; i < t->n; i++) {
		size_t n;
		const tb_entry *at = tb_at(e->table, tb_string(t->ids[i]), &n);
		for (size_t k = 0; k < n; k++) {
			const nd_entry *entry = at[k].node;
			CHECK(entry->change.has_time && entry->change.time == SECONDS);
			seen++;
		}
	}
	return seen;
}

static void every_change_takes_the_clock(void) {
	ids_t t = {0};
	es_ermine *e = NULL;
	CHECK(es_create(&(es_options){.now = fixed, .create_id = next_id, .create_id_ctx = &t,
		.create_process_id = next_id, .create_process_id_ctx = &t}, &e) == 0);
	es_context *host = es_host_context(e);
	op_value *zero = op_num(0);
	es_handle *h;
	CHECK(es_ensure_node(host, es_text("/a"), zero, &h) == 0);
	op_value *v = op_num(5);
	op_patch p = {.has_value = 1, .value = v};
	CHECK(es_patch(host, es_on_path(es_text("/a")), &p, 1) == 0);
	es_refused no = {0};
	es_started *s = NULL;
	CHECK(es_start(e, setup, NULL, es_text("/code/p"), NULL, &s, &no) == 0);
	es_pulse(host);
	CHECK(times_are_the_clock(e, &t) >= 5);
	op_free(v);
	op_free(zero);
	es_started_free(s);
	CHECK(es_close(e) == 0);
	es_free(e);
}

typedef struct {
	ids_t t;
	es_feature_api *api;
	int early;
} api_t;
static int api_setup(void *ctx, es_feature_api *f) {
	api_t *a = ctx;
	char *id = NULL;
	a->early = es_api_new_id(f, &id);
	a->api = f;
	return 0;
}

static void the_host_gives_its_ids(void) {
	api_t a = {0};
	es_ermine *e = NULL;
	es_feature ids = {.name = "ids", .setup = api_setup, .ctx = &a};
	const es_feature *list[] = {&ids};
	es_options o = {.features = list, .nfeatures = 1, .root = "R", .create_id = next_id, .create_id_ctx = &a.t};
	CHECK(es_create(&o, &e) == 0);
	CHECK(a.early == ES_NOT_YET);
	CHECK(strcmp(e->root, "R") == 0);
	char *id = NULL;
	CHECK(es_api_new_id(a.api, &id) == 0);
	CHECK(id != NULL && id[0] == 'n');
	free(id);
	CHECK(es_close(e) == 0);
	es_free(e);
}

int main(void) {
	every_change_takes_the_clock();
	the_host_gives_its_ids();
	if (!failed) puts("clock ok");
	return failed;
}
