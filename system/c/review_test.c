// Cases from a review that the harness cannot show (a scope torn down as a wait is made, a hook
// calling next twice, a handler failing with no text); the memory ones run under AddressSanitizer.
// make test-review-system, test-check-review-system.
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

typedef struct {
	es_ermine *e;
	sc_scope *scope;
} going_t;
static char *waits_as_it_goes(void *data) {
	going_t *g = data;
	es_aim aim = {.id = "n9"};
	es_calls_wait(g->e, "caller", &aim, g->scope);
	return NULL;
}
static void wait_in_a_scope_going(void) {
	es_ermine *e = NULL;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	op_value *one = op_num(1);
	sc_pair info = {"call", one};
	sc_scope *s = sc_create_scope(e->scheduler, &info, 1, e->host_scope);
	going_t g = {e, s};
	free(sc_register_teardown(e->scheduler, s, waits_as_it_goes, &g));
	free(sc_teardown(s));
	size_t n = 0;
	es_wait *waits = es_calls_waits(e, "caller", &n);
	CHECK(n == 0);
	es_waits_free(waits, n);
	sc_release(s);
	op_free(one);
	CHECK(es_close(e) == 0);
	es_free(e);
}

typedef struct {
	// 0: the same record twice. 1: the record, then a changed one
	int mode;
	int told;
} hook_t;
static int calls_next_twice(void *ctx, const es_recorded *r, es_record_next *next) {
	hook_t *h = ctx;
	h->told++;
	int code = es_next_record(next, r);
	if (code || r->call == NULL) return code;
	if (h->mode == 0) return es_next_record(next, r);
	es_call changed = *r->call;
	changed.end = "failed";
	es_recorded again = *r;
	again.call = &changed;
	return es_next_record(next, &again);
}
static int hook_setup(void *ctx, es_feature_api *f) { return es_on_record(f, calls_next_twice, ctx); }

static es_out answers(es_context *c, void *ctx, const op_value *const *args, size_t n) {
	(void)c, (void)ctx, (void)args, (void)n;
	return es_out_of(op_num(1));
}
static es_out fails_with_no_text(es_context *c, void *ctx, const op_value *const *args, size_t n) {
	(void)c, (void)ctx, (void)args, (void)n;
	es_fail(ES_FAILED, "boom");
	return es_out_failed(NULL);
}
static es_out makes_actions(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *h;
	CHECK(es_create_action(c, es_text("ok"), answers, NULL, &h) == 0);
	CHECK(es_create_action(c, es_text("bad"), fails_with_no_text, NULL, &h) == 0);
	return es_out_of(NULL);
}
static es_ermine *with_actions(hook_t *hook, es_started **started) {
	es_feature f = {.name = "twice", .setup = hook_setup, .ctx = hook};
	const es_feature *list[1] = {&f};
	es_options o = {.features = list, .nfeatures = 1};
	es_ermine *e = NULL;
	CHECK(es_create(&o, &e) == 0);
	es_refused no = {0};
	CHECK(es_start(e, makes_actions, NULL, es_text("/code/p"), NULL, started, &no) == 0);
	return e;
}
static void next_called_twice(int mode) {
	hook_t hook = {mode, 0};
	es_started *started = NULL;
	es_ermine *e = with_actions(&hook, &started);
	for (int i = 0; i < 2; i++) {
		op_value *out = NULL;
		CHECK(es_execute_action(e->host_context, es_on_path(es_text("/code/p/ok")), NULL, 0, &out) == 0);
		op_free(out);
	}
	CHECK(hook.told > 0);
	es_stop(started, NULL);
	es_started_free(started);
	CHECK(es_close(e) == 0);
	es_free(e);
}
static void failing_with_no_text(void) {
	hook_t hook = {0, 0};
	es_started *started = NULL;
	es_ermine *e = with_actions(&hook, &started);
	op_value *out = NULL;
	CHECK(es_execute_action(e->host_context, es_on_path(es_text("/code/p/bad")), NULL, 0, &out) != 0);
	es_clear_thrown();
	es_stop(started, NULL);
	es_started_free(started);
	CHECK(es_close(e) == 0);
	es_free(e);
}

// a memo giving a promise on each run: an earlier one settling late leaves it awaiting the latest's
static es_promise *given[4];
static size_t ngiven;
static es_out gives_a_promise(es_context *c, void *ctx, const op_value *previous) {
	(void)ctx, (void)previous;
	const op_value *v;
	int code = es_read(c, es_on_path(es_text("/k")), NULL, 0, &v);
	if (code) return es_out_code(code);
	es_promise *p = es_promise_new(c->ermine);
	given[ngiven++] = p;
	return es_out_of(es_promise_value(p));
}
static es_out reads_the_memo(es_context *c, void *ctx, const op_value *previous) {
	(void)ctx, (void)previous;
	const op_value *v;
	int code = es_read(c, es_on_path(es_text("m")), NULL, 0, &v);
	if (code == ES_PENDING) return es_out_of(NULL);
	if (code) return es_out_code(code);
	return es_out_of(v == NULL ? NULL : op_ref((op_value *)v));
}
static int does_nothing(es_context *c, void *ctx, const op_value *value, const op_value *before) {
	(void)c, (void)ctx, (void)value, (void)before;
	return 0;
}
static es_handle *the_memo;
static es_out makes_a_memo(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *h;
	int code = es_create_memo(c, es_text("m"), gives_a_promise, NULL, NULL, &the_memo);
	CHECK(code == 0 || code == ES_PENDING);
	code = es_create_effect(c, es_text("e"), reads_the_memo, does_nothing, NULL, NULL, &h);
	CHECK(code == 0 || code == ES_PENDING);
	return es_out_of(NULL);
}
static int waits_on_a_promise(es_ermine *e) {
	es_status st = {0};
	CHECK(es_get_status(e->host_context, es_on_node(the_memo), &st) == 0);
	int yes = st.nwaiting == 1 && st.waiting[0].kind == ES_WAIT_PROMISE;
	es_status_free(&st);
	return yes;
}
static void stale_promise_settling(void) {
	es_ermine *e = NULL;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	es_handle *h;
	op_value *zero = op_num(0);
	CHECK(es_ensure_node(e->host_context, es_text("/k"), zero, &h) == 0);
	ngiven = 0;
	es_started *started = NULL;
	es_refused no = {0};
	CHECK(es_start(e, makes_a_memo, NULL, es_text("/code/p"), NULL, &started, &no) == 0);
	for (int i = 1; i <= 2; i++) {
		op_value *v = op_num(i);
		op_patch p = {.has_value = 1, .value = v};
		CHECK(es_patch(e->host_context, es_on_path(es_text("/k")), &p, 1) == 0);
		CHECK(es_pulse(e->host_context) == 0);
		op_free(v);
	}
	CHECK(ngiven == 3);
	CHECK(waits_on_a_promise(e));
	es_promise_resolve(given[1], op_num(1));
	CHECK(es_pulse(e->host_context) == 0);
	CHECK(waits_on_a_promise(e));
	es_promise_resolve(given[2], op_num(2));
	CHECK(es_pulse(e->host_context) == 0);
	CHECK(!waits_on_a_promise(e));
	for (size_t i = 0; i < ngiven; i++) es_promise_release(given[i]);
	es_stop(started, NULL);
	es_started_free(started);
	op_free(zero);
	CHECK(es_close(e) == 0);
	es_free(e);
}

// seen by another ermine's context: nothing, not the root
static es_feature_api *kept_api;
static int keeps_api(void *ctx, es_feature_api *f) {
	(void)ctx;
	kept_api = f;
	return 0;
}
static void seen_by_a_foreign_context(void) {
	es_feature f = {.name = "seen", .setup = keeps_api};
	const es_feature *list[1] = {&f};
	es_options o = {.features = list, .nfeatures = 1};
	es_ermine *e = NULL, *other = NULL;
	CHECK(es_create(&o, &e) == 0);
	CHECK(es_create(&(es_options){0}, &other) == 0);
	es_names seen = {0};
	CHECK(es_api_seen(kept_api, e->node, other->host_context, &seen) == ES_NOTHING_THERE);
	es_clear_thrown();
	CHECK(es_close(other) == 0);
	es_free(other);
	CHECK(es_close(e) == 0);
	es_free(e);
}

// a finding's name given: that one alone
// a process whose teardown throws: its stop and the ermine's close say so, as stop and close throw
static char *throws_boom(void *data) {
	(void)data;
	return strdup("boom");
}
static es_out tears_down_badly(es_context *c, void *ctx) {
	(void)ctx;
	free(sc_register_teardown(c->ermine->scheduler, c->scope, throws_boom, NULL));
	return es_out_of(NULL);
}
static void teardown_thrown(int closing) {
	es_ermine *e = NULL;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	es_started *started = NULL;
	es_refused no = {0};
	CHECK(es_start(e, tears_down_badly, NULL, es_text("/code/p"), NULL, &started, &no) == 0);
	CHECK(es_pulse(e->host_context) == 0);
	int code = closing ? es_close(e) : es_stop(started, NULL);
	CHECK(code == ES_FAILED);
	CHECK(code && strcmp(es_thrown()->message, "boom") == 0);
	es_clear_thrown();
	es_started_free(started);
	if (!closing) CHECK(es_close(e) == 0);
	es_free(e);
}

int main(int argc, char **argv) {
	const char *only = argc > 1 ? argv[1] : NULL;
#define RUN(name, call) \
	if (only == NULL || strcmp(only, name) == 0) call
	RUN("wait", wait_in_a_scope_going());
	RUN("next", next_called_twice(0));
	RUN("next-changed", next_called_twice(1));
	RUN("no-text", failing_with_no_text());
	RUN("stale-promise", stale_promise_settling());
	RUN("foreign-seen", seen_by_a_foreign_context());
	RUN("stop-thrown", teardown_thrown(0));
	RUN("close-thrown", teardown_thrown(1));
	if (!failed) puts("review: ok");
	return failed;
}
