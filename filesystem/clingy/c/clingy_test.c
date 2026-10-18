// the C clingy (clingy.h) on a real scheduler, as clingy_test.ts. exits 1 at the first thing that is
// not so. run under the sanitizers and leaks for the frees
#include <stdio.h>
#include <stdlib.h>

#include "clingy.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static const sc_pair info[] = {{"actor", "test"}};
static sc_scheduler *s;
static sc_scope *root;
static const char on = 0;

// what go was told
static const void *gone[8];
static int ngone;
static void go(const void *key, void *data) {
	(void)data;
	gone[ngone++] = key;
}

// a reader of key while its switch is on
typedef struct {
	const void *key;
	bool reading;
	sc_computer *c;
} reader;
static sc_out run(void *previous, void *data) {
	(void)previous;
	reader *r = data;
	sc_track(s, &on);
	if (r->reading) sc_track(s, r->key);
	return (sc_out){.kind = SC_VALUE};
}
static char *set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}
static void making(void *data) {
	reader *r = data;
	r->c = sc_create_computer(s, (sc_def){.f = run, .set = set, .data = r}, NULL, 0);
}
static void start(reader *r, const void *key) {
	*r = (reader){key, true, NULL};
	sc_run_with_scope(root, making, r);
	sc_pulse(s);
}
static void stop(reader *r) {
	r->reading = false;
	sc_mark(s, (const void *[]){&on}, 1, NULL);
	sc_pulse(s);
}

static cl_clingy *setup(void) {
	s = sc_new((sc_options){0});
	root = sc_create_root_scope(s, info, 1);
	ngone = 0;
	return cl_new(s, go, NULL);
}
static void done(cl_clingy *c) {
	cl_free(c);
	sc_free(s);
}

int main(void) {
	static const char k = 0, other = 0;
	reader a, b;

	// tracked while a run tracks it; its last tracker gone, go told
	cl_clingy *c = setup();
	cl_add(c, &k);
	CHECK(cl_has(c, &k) && !cl_tracked(c, &k));
	start(&a, &k), start(&b, &k);
	CHECK(cl_tracked(c, &k));
	stop(&a);
	CHECK(cl_tracked(c, &k) && ngone == 0);
	stop(&b);
	CHECK(!cl_tracked(c, &k) && ngone == 1 && gone[0] == &k);
	done(c);

	// told on each last tracker, and it stays added till dropped
	c = setup();
	cl_add(c, &k);
	start(&a, &k), stop(&a);
	start(&b, &k), stop(&b);
	CHECK(ngone == 2);
	cl_drop(c, &k);
	start(&a, &k), stop(&a);
	CHECK(!cl_has(c, &k) && ngone == 2);
	done(c);

	// a torn-down tracker lets go too
	c = setup();
	cl_add(c, &k);
	start(&a, &k);
	free(sc_teardown(a.c));
	CHECK(!cl_tracked(c, &k) && ngone == 1);
	done(c);

	// keys not added are not told; a read outside a run tracks nothing
	c = setup();
	cl_add(c, &k);
	start(&a, &other), stop(&a);
	sc_track(s, &k);
	CHECK(!cl_tracked(c, &k) && ngone == 0);
	done(c);

	// adding again keeps what it knows; freed: told nothing more
	c = setup();
	cl_add(c, &k);
	start(&a, &k);
	cl_add(c, &k);
	CHECK(cl_tracked(c, &k));
	cl_free(c);
	stop(&a);
	CHECK(ngone == 0);
	sc_free(s);

	puts("clingy: ok");
	return 0;
}
