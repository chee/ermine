// promises: a then on a settled promise is told with the promise held, so a callback letting go of
// the maker's hold frees nothing it was handed (a review's finding: freed under AddressSanitizer).
// make test-promise-system (and its -check, with the sanitizers)
#include "ermine.h"

#include <stdio.h>
#include <string.h>

static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			failed = 1; \
		} \
	} while (0)

typedef struct {
	es_promise *p;
	int told, ok;
	char error[32];
	char value[32];
} told_t;

// let go of the maker's hold, then read what it was handed
static void lets_go(void *ctx, int ok, const op_value *value, const char *error) {
	told_t *t = ctx;
	es_promise_release(t->p);
	t->told++;
	t->ok = ok;
	if (error != NULL) snprintf(t->error, sizeof t->error, "%s", error);
	const char *s = value == NULL || value->type != OP_STR ? NULL : value->str;
	if (s != NULL) snprintf(t->value, sizeof t->value, "%s", s);
}

int main(void) {
	es_ermine *e = NULL;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	// rejected, then a then that lets go of the maker's hold and reads the error
	told_t a = {0};
	a.p = es_promise_new(e);
	es_promise_reject(a.p, "it broke");
	es_promise_then(a.p, lets_go, &a);
	CHECK(a.told == 1 && a.ok == 0 && strcmp(a.error, "it broke") == 0);
	// resolved, the same with its value
	told_t b = {0};
	b.p = es_promise_new(e);
	es_promise_resolve(b.p, op_str("done"));
	es_promise_then(b.p, lets_go, &b);
	CHECK(b.told == 1 && b.ok == 1 && strcmp(b.value, "done") == 0);
	CHECK(es_close(e) == 0);
	es_free(e);
	if (!failed) puts("promise: ok");
	return failed;
}
