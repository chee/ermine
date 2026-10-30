// Checks when the scheduler frees scopes (see the memory section of scheduler.h). Exits 1 at the
// first failure. Run it under the sanitizers.
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

static op_value text = {.type = OP_STR, .str = "free", .bytes = 4, .ascii = 1};
static const sc_pair info[] = {{"test", &text}};

// What was freed, in order.
static sc_scope *freed[16];
static size_t nfreed;
static void told(sc_scope *o, void *data) {
	(void)data;
	CHECK(sc_scope_frame(o) != NULL);
	freed[nfreed++] = o;
}
static int was_freed(const sc_scope *o) {
	for (size_t i = 0; i < nfreed; i++)
		if (freed[i] == o) return 1;
	return 0;
}

static sc_out one(void *previous, void *data) {
	(void)previous, (void)data;
	return (sc_out){.kind = SC_VALUE};
}
static char *set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}
static sc_scheduler *s;
static sc_computer *made;
static void make_computer(void *data) {
	(void)data;
	made = sc_create_computer(s, (sc_def){.f = one, .set = set}, NULL, 0);
}

int main(void) {
	s = sc_new((sc_options){0});
	sc_on_free(s, told, NULL);
	sc_scope *root = sc_create_root_scope(s, info, 1);

	// A plain scope stays while the tree holds it; once torn down and unheld it is freed at once.
	sc_scope *a = sc_create_scope(s, info, 1, root);
	sc_release(a);
	CHECK(nfreed == 0);
	free(sc_teardown(a));
	CHECK(nfreed == 1 && freed[0] == a);

	// Torn down but held: freed only when the last hold goes.
	nfreed = 0;
	sc_scope *b = sc_create_scope(s, info, 1, root);
	free(sc_teardown(b));
	CHECK(!was_freed(b) && !sc_scope_alive(b));
	sc_retain(b);
	sc_release(b);
	CHECK(!was_freed(b));
	sc_release(b);
	CHECK(was_freed(b));

	nfreed = 0;
	sc_scope *p = sc_create_scope(s, info, 1, root);
	sc_scope *c = sc_create_scope(s, info, 1, p);
	free(sc_teardown(p));
	sc_release(p);
	CHECK(nfreed == 0);
	CHECK(sc_scope_parent(c) == p);
	sc_release(c);
	CHECK(nfreed == 2 && freed[0] == c && freed[1] == p);

	// A computer is freed as the pulse ends, not at once.
	nfreed = 0;
	sc_scope *own = sc_create_scope(s, info, 1, root);
	CHECK(sc_run_with_scope(own, make_computer, NULL) == NULL);
	sc_pulse(s);
	sc_computer *m = made;
	free(sc_teardown(own));
	sc_release(m);
	sc_release(own);
	CHECK(nfreed == 0);
	sc_pulse(s);
	CHECK(nfreed == 2 && freed[0] == m && freed[1] == own);

	nfreed = 0;
	own = sc_create_scope(s, info, 1, root);
	CHECK(sc_run_with_scope(own, make_computer, NULL) == NULL);
	sc_pulse(s);
	m = made;
	sc_run *r = sc_run_ref(sc_latest(m));
	free(sc_teardown(own));
	sc_release(m);
	sc_release(own);
	sc_pulse(s);
	CHECK(nfreed == 0);
	CHECK(sc_run_computer(r) == m && !sc_scope_alive(m));
	sc_run_unref(r);
	sc_pulse(s);
	CHECK(nfreed == 2 && freed[0] == m && freed[1] == own);

	// A maker that never lets go keeps it until sc_free.
	nfreed = 0;
	sc_scope *kept = sc_create_scope(s, info, 1, root);
	free(sc_teardown(kept));
	sc_pulse(s);
	CHECK(nfreed == 0 && !sc_scope_alive(kept));

	own = sc_create_scope(s, info, 1, root);
	CHECK(sc_run_with_scope(own, make_computer, NULL) == NULL);
	sc_pulse(s);
	sc_run *late = sc_run_ref(sc_latest(made));

	free(sc_teardown(root));
	sc_free(s);
	sc_run_unref(late);
	puts("ok");
	return 0;
}
