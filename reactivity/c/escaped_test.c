// Checks what sc_escaped returns for calls that leave it: the first is read, the rest are let go.
// Exits 1 at the first failure.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scheduler.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static op_value text = {.type = OP_STR, .str = "escaped", .bytes = 7, .ascii = 1};
static const sc_pair info[] = {{"test", &text}};
static sc_scheduler *s;

static char *copy(const char *x) { return strcpy(malloc(strlen(x) + 1), x); }

// Each settling throws "first", then "second".
static int told;
static void settled(void *data) {
	(void)data;
	sc_throw(s, copy(told++ ? "second" : "first"));
}

static sc_out awaits(void *previous, void *data) {
	(void)previous;
	return (sc_out){.kind = SC_AWAIT, .promise = data};
}
static char *set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}
static sc_promise *ps[2];
static void make_two(void *data) {
	(void)data;
	for (int i = 0; i < 2; i++) sc_create_computer(s, (sc_def){.f = awaits, .set = set, .data = ps[i]}, NULL, 0);
}

int main(void) {
	s = sc_new((sc_options){0});
	sc_on_settle(s, settled, NULL);
	sc_scope *root = sc_create_root_scope(s, info, 1);
	ps[0] = sc_promise_new(s);
	ps[1] = sc_promise_new(s);
	CHECK(sc_run_with_scope(root, make_two, NULL) == NULL);
	sc_pulse(s);
	CHECK(sc_escaped(s) == NULL);
	sc_resolve(ps[0], NULL);
	sc_resolve(ps[1], NULL);
	char *e = sc_escaped(s);
	CHECK(e != NULL && strcmp(e, "first") == 0);
	free(e);
	CHECK(sc_escaped(s) == NULL);

	free(sc_teardown(root));
	sc_promise_free(ps[0]);
	sc_promise_free(ps[1]);
	sc_free(s);
	puts("ok");
	return 0;
}
