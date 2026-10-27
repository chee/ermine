// what a review found that the harness cannot show (it needs a scope torn down as a wait is made, a
// hook calling next twice, a handler failing with no text, a policy answering pending). each is
// checked here, and the memory ones under AddressSanitizer. make test-review-system,
// test-check-review-system (the sanitizers)
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

// a wait made by a scope as it goes: taken out at once, its waiter let go of with nothing read after
typedef struct {
	es_ermine *e;
	sc_scope *scope;
} going_t;
static char *waits_as_it_goes(void *data) {
	going_t *g = data;
	es_aim aim = {.id = "n9"};
	es_calls_wait(g->e, "caller", &aim, "R", g->scope);
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

// an action begun by the host, its records told to a hook that calls next as the test says
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
// no text: the thrown error says what
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

// a pipe's from read: allowed as it is made, then the policy answers as the test says
static int answer;
static int told;
static pr_answer reads_as_asked(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)ctx, (void)read;
	if (strcmp(ask->op, "read") == 0 && answer != PR_YES) return (pr_answer){.verdict = answer};
	return (pr_answer){.verdict = PR_YES};
}
static int counts(es_context *c, void *ctx, const es_watched *w) {
	(void)c, (void)ctx, (void)w;
	told++;
	return 0;
}
static es_out makes_a_pipe(es_context *c, void *ctx) {
	(void)ctx;
	es_pipe_options o = {.tell = counts};
	es_handle *h;
	CHECK(es_pipe(c, es_on_path(es_text("/src")), &o, &h) == 0);
	return es_out_of(NULL);
}
static void pipe_heard_with(int verdict) {
	pr_policy *may = pr_call(reads_as_asked, NULL);
	es_options o = {.may = may};
	es_ermine *e = NULL;
	answer = PR_YES;
	told = 0;
	CHECK(es_create(&o, &e) == 0);
	es_handle *h;
	op_value *zero = op_num(0);
	CHECK(es_ensure_node(e->host_context, es_text("/src"), zero, &h) == 0);
	es_started *started = NULL;
	es_refused no = {0};
	CHECK(es_start(e, makes_a_pipe, NULL, es_text("/code/p"), NULL, &started, &no) == 0);
	CHECK(es_pulse(e->host_context) == 0);
	answer = verdict;
	op_value *five = op_num(5);
	op_patch p = {.has_value = 1, .value = five};
	CHECK(es_patch(e->host_context, es_on_path(es_text("/src")), &p, 1) == 0);
	CHECK(es_pulse(e->host_context) == 0);
	// neither pending nor failed is an answer of yes
	CHECK(told == 0);
	es_stop(started, NULL);
	es_started_free(started);
	op_free(five);
	op_free(zero);
	CHECK(es_close(e) == 0);
	es_free(e);
	pr_policy_free(may);
}

// a finding's name given: that one alone
int main(int argc, char **argv) {
	const char *only = argc > 1 ? argv[1] : NULL;
#define RUN(name, call) \
	if (only == NULL || strcmp(only, name) == 0) call
	RUN("wait", wait_in_a_scope_going());
	RUN("next", next_called_twice(0));
	RUN("next-changed", next_called_twice(1));
	RUN("no-text", failing_with_no_text());
	RUN("pipe-pending", pipe_heard_with(PR_PENDING));
	if (!failed) puts("review: ok");
	return failed;
}
