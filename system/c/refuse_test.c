// a refused start (the path is taken): the scope it made is let go of at once, freed by the
// scheduler, not held till es_close. a feature counts the scheduler's frees. make test-refuse-system
// (and its -check, with the sanitizers)
#include "ermine.h"

#include <stdio.h>
#include <string.h>

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static long freed;
static void counted(sc_scope *o, void *data) {
	(void)o, (void)data;
	freed++;
}
static int counting(void *ctx, es_feature_api *f) {
	(void)ctx;
	return es_listened(f, sc_on_free(f->scheduler, counted, NULL));
}

static es_out nothing(es_context *c, void *ctx) {
	(void)c, (void)ctx;
	return es_out_of(NULL);
}

int main(void) {
	es_feature count = {.name = "count", .setup = counting};
	const es_feature *features[] = {&count};
	es_ermine *e = NULL;
	CHECK(es_create(&(es_options){.features = features, .nfeatures = 1}, &e) == 0);
	es_started *first;
	es_refused no = {0};
	CHECK(es_start(e, nothing, NULL, es_text("/p"), NULL, &first, &no) == 0);
	es_pulse(es_host_context(e));
	// each refusal frees the scope its start made
	for (int i = 0; i < 5; i++) {
		long before = freed;
		es_started *again;
		CHECK(es_start(e, nothing, NULL, es_text("/p"), NULL, &again, &no) != 0);
		CHECK(no.refused != NULL && strcmp(no.refused, "taken") == 0);
		es_refused_free(&no);
		no = (es_refused){0};
		es_pulse(es_host_context(e));
		CHECK(freed > before);
	}
	es_close(e);
	puts("ok");
	return 0;
}
