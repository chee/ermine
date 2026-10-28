// what a review of marks (writers, started children, cleanup) proved in C and the harness cannot show:
// memory used after it was freed, under AddressSanitizer. each case is a probe the reviewer ran, kept.
// make test-marks-system, test-check-marks-system (the sanitizers)
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

static es_ermine *E;
static es_context *P;
static op_value *WRITER;
static es_started *STARTED;
static es_promise *PROM;
static char *KID;

static void fresh(void) {
	E = NULL;
	P = NULL;
	WRITER = NULL;
	STARTED = NULL;
	PROM = NULL;
	free(KID);
	KID = NULL;
	CHECK(es_create(&(es_options){0}, &E) == 0);
}
static void finish(void) {
	CHECK(es_close(E) == 0);
	es_free(E);
	free(KID);
	KID = NULL;
}

static es_out writer_fn(es_context *c, void *ctx, const op_value *const *args, size_t n) {
	(void)ctx, (void)args, (void)n;
	op_value *w;
	int code = es_create_writer(c, &w);
	if (code) return es_out_code(code);
	return es_out_of(w);
}

static es_out setup(es_context *c, void *ctx) {
	(void)ctx;
	P = c;
	es_handle *h;
	CHECK(es_create_action(c, es_text("writer"), writer_fn, NULL, &h) == 0);
	CHECK(es_create_writer(c, &WRITER) == 0);
	return es_out_of(NULL);
}

static es_out plain(es_context *c, void *ctx) {
	(void)ctx;
	P = c;
	return es_out_of(NULL);
}

// f lets its own writer go (a timer that fired)
static int drops_itself(void *ctx) {
	(void)ctx;
	es_drop_writer(E, WRITER);
	return 0;
}
// f stops the process the writer was made in
static int stops_parent(void *ctx) {
	(void)ctx;
	es_stop(STARTED, "bye");
	return 0;
}
static int nothing(void *ctx) {
	(void)ctx;
	return 0;
}

static void case_writer_dropped_in_f(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, setup, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	CHECK(es_with_writer(E, WRITER, drops_itself, NULL) == 0);
	op_free(WRITER);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

static void case_parent_stopped_in_f(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, setup, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	CHECK(es_with_writer(E, WRITER, stops_parent, NULL) == 0);
	op_free(WRITER);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// a writer made in an action, used under the call's mark (its own scope), dropped by f
static void case_marked_writer_dropped_in_f(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, setup, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	op_value *r = NULL;
	CHECK(es_execute_action(es_host_context(E), es_on_path(es_text("/code/p/writer")), NULL, 0, &r) == 0);
	op_free(WRITER);
	WRITER = r;
	CHECK(es_with_writer(E, WRITER, drops_itself, NULL) == 0);
	op_free(WRITER);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// no function: not-a-function, as the TypeScript says
static void case_no_function(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, setup, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	CHECK(es_with_writer(E, WRITER, NULL, NULL) == ES_NOT_A_FUNCTION);
	es_clear_thrown();
	CHECK(es_with_writer(E, WRITER, nothing, NULL) == 0);
	op_free(WRITER);
	es_started_free(STARTED);
	finish();
}

// a child whose setup unplaces its own node
static es_out kid_unplaces(es_context *c, void *ctx) {
	(void)ctx;
	CHECK(es_unplace(c, es_text("/code/kid")) == 0);
	return es_out_of(NULL);
}
static es_out starts_unplacing_kid(es_context *c, void *ctx) {
	(void)ctx;
	es_child k;
	es_refused no = {0};
	CHECK(es_start_in(c, kid_unplaces, NULL, es_text("/code/kid"), NULL, &k, &no) == 0);
	CHECK(k.id != NULL);
	es_child_free(&k);
	return es_out_of(NULL);
}
static void case_child_unplaces_itself(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, starts_unplacing_kid, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// a child whose setup gives a promise: it stays while the promise is out, and is done when it settles
static es_out async_kid(es_context *c, void *ctx) {
	(void)c, (void)ctx;
	PROM = es_promise_new(E);
	return es_out_of(es_promise_value(PROM));
}
static es_out plain_kid(es_context *c, void *ctx) {
	(void)c, (void)ctx;
	return es_out_of(NULL);
}
static es_out parent_async(es_context *c, void *ctx) {
	(void)ctx;
	P = c;
	es_child k;
	es_refused no = {0};
	CHECK(es_start_in(c, async_kid, NULL, es_text("/kid"), NULL, &k, &no) == 0);
	KID = es_dup(k.id);
	es_child_free(&k);
	return es_out_of(NULL);
}
static const char *state_of(es_context *c, const char *id, int *code) {
	static char state[32];
	es_status s;
	*code = es_child_status(c, id, &s);
	snprintf(state, sizeof state, "%s", s.state != NULL ? s.state : "");
	es_status_free(&s);
	return state;
}
static void case_child_promise_settles(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, parent_async, NULL, es_text("/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	int code;
	CHECK(strcmp(state_of(P, KID, &code), "pending") == 0 && code == 0);
	es_promise_resolve(PROM, op_num(7));
	es_pulse(es_host_context(E));
	CHECK(strcmp(state_of(P, KID, &code), "done") == 0 && code == 0);
	es_stop(STARTED, NULL);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// a child with its promise out, its parent ended: the record waits, then close
static void case_parent_ends_child_pending(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, parent_async, NULL, es_text("/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	es_stop(STARTED, NULL);
	es_started_free(STARTED);
	es_pulse(es_host_context(E));
	finish();
}

// close with a parent in procs above its children
static es_out parent_two(es_context *c, void *ctx) {
	(void)ctx;
	es_child k;
	es_refused no = {0};
	CHECK(es_start_in(c, plain_kid, NULL, es_text("/c1"), NULL, &k, &no) == 0);
	es_child_free(&k);
	CHECK(es_start_in(c, plain_kid, NULL, es_text("/c2"), NULL, &k, &no) == 0);
	es_child_free(&k);
	return es_out_of(NULL);
}
static void case_close_with_children(void) {
	fresh();
	es_refused no = {0};
	es_started *x, *y, *p;
	CHECK(es_start(E, plain_kid, NULL, es_text("/x"), NULL, &x, &no) == 0);
	CHECK(es_start(E, plain_kid, NULL, es_text("/y"), NULL, &y, &no) == 0);
	CHECK(es_start(E, parent_two, NULL, es_text("/p"), NULL, &p, &no) == 0);
	es_pulse(es_host_context(E));
	es_started_free(x);
	es_started_free(y);
	es_pulse(es_host_context(E));
	CHECK(es_close(E) == 0);
	es_started_free(p);
	es_free(E);
}

// a writer made, a child started, in what has ended: gone
static void case_ended_owner(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, plain, NULL, es_text("/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	es_stop(STARTED, NULL);
	op_value *w = NULL;
	CHECK(es_create_writer(P, &w) == ES_GONE);
	CHECK(w == NULL);
	es_clear_thrown();
	es_child k;
	CHECK(es_start_in(P, plain_kid, NULL, es_text("/late"), NULL, &k, &no) == ES_GONE);
	CHECK(k.id == NULL);
	es_clear_thrown();
	es_started_free(STARTED);
	es_pulse(es_host_context(E));
	finish();
}

// stop and status are for the child the caller started
static void case_child_of_another(void) {
	fresh();
	es_refused no = {0};
	es_started *q;
	CHECK(es_start(E, parent_async, NULL, es_text("/p"), NULL, &STARTED, &no) == 0);
	es_context *parent = NULL;
	es_pulse(es_host_context(E));
	parent = P;
	CHECK(es_start(E, plain, NULL, es_text("/q"), NULL, &q, &no) == 0);
	es_pulse(es_host_context(E));
	int code;
	// another process, and the host, are refused; the starter is not; an id none has is no one's to stop
	state_of(parent, KID, &code);
	CHECK(code == 0);
	CHECK(es_child_stop(P, KID, NULL) == ES_NOT_HERE);
	es_clear_thrown();
	es_status s;
	CHECK(es_child_status(es_host_context(E), KID, &s) == ES_NOT_HERE);
	es_clear_thrown();
	CHECK(es_child_stop(es_host_context(E), KID, NULL) == ES_NOT_HERE);
	es_clear_thrown();
	CHECK(es_child_stop(parent, "no-such-process", NULL) == 0);
	es_started_free(q);
	es_stop(STARTED, NULL);
	es_started_free(STARTED);
	es_pulse(es_host_context(E));
	finish();
}

// a cleanup is the act's own: not from an action the act called
static int cleanup_code = -1;
static void cleaned(void *ctx, const char *why) { (void)ctx, (void)why; }
static es_out cleans_up(es_context *c, void *ctx, const op_value *const *args, size_t n) {
	(void)ctx, (void)args, (void)n;
	cleanup_code = es_cleanup(c, cleaned, NULL);
	return es_out_of(NULL);
}
static es_out effect_in(es_context *c, void *ctx, const op_value *previous) {
	(void)c, (void)ctx, (void)previous;
	return es_out_of(op_num(1));
}
static int act_calls_action(es_context *c, void *ctx, const op_value *value, const op_value *before) {
	(void)ctx, (void)value, (void)before;
	op_value *r = NULL;
	int code = es_execute_action(c, es_on_path(es_text("/code/p/cleans")), NULL, 0, &r);
	op_free(r);
	return code;
}
static es_out effect_setup(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *h;
	CHECK(es_create_action(c, es_text("cleans"), cleans_up, NULL, &h) == 0);
	int code = es_create_effect(c, es_text("fx"), effect_in, act_calls_action, NULL, NULL, &h);
	CHECK(code == 0 || code == ES_PENDING);
	return es_out_of(NULL);
}
static void case_cleanup_through_action(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, effect_setup, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	CHECK(cleanup_code == ES_NOT_HERE);
	es_clear_thrown();
	es_started_free(STARTED);
	finish();
}

// addTeardown in an action is not-here (it would pile onto the scope that placed it, one a call); in
// setup it is added as ever
static int teardown_in_action = -1;
static void torn(void *ctx, const char *why) { (void)ctx, (void)why; }
static es_out adds_teardown(es_context *c, void *ctx, const op_value *const *args, size_t n) {
	(void)ctx, (void)args, (void)n;
	teardown_in_action = es_add_teardown(c, torn, NULL);
	return es_out_of(NULL);
}
static es_out teardown_setup(es_context *c, void *ctx) {
	(void)ctx;
	es_handle *h;
	CHECK(es_add_teardown(c, torn, NULL) == 0);
	CHECK(es_create_action(c, es_text("adds"), adds_teardown, NULL, &h) == 0);
	return es_out_of(NULL);
}
static void case_teardown_not_in_an_action(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, teardown_setup, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	op_value *r = NULL;
	CHECK(es_execute_action(es_host_context(E), es_on_path(es_text("/code/p/adds")), NULL, 0, &r) == 0);
	op_free(r);
	CHECK(teardown_in_action == ES_NOT_HERE);
	es_clear_thrown();
	es_started_free(STARTED);
	finish();
}

// a writer is a power, never data: shown as "[writer]" in a call's args and returned, where a record is
// shown (es_show, es_call_view_of)
static es_handle *ACTION;
static es_out setup_keeping(es_context *c, void *ctx) {
	(void)ctx;
	P = c;
	CHECK(es_create_action(c, es_text("writer"), writer_fn, NULL, &ACTION) == 0);
	CHECK(es_create_writer(c, &WRITER) == 0);
	return es_out_of(NULL);
}
static int is_marker(const op_value *v) { return v != NULL && v->type == OP_STR && strcmp(v->str, "[writer]") == 0; }
static void case_writer_hidden_in_records(void) {
	fresh();
	es_refused no = {0};
	CHECK(es_start(E, setup_keeping, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	op_value *r = NULL;
	const op_value *args[1] = {WRITER};
	CHECK(es_execute_action(es_host_context(E), es_on_path(es_text("/code/p/writer")), args, 1, &r) == 0);
	// shown through lists and maps too
	op_value *list = op_list();
	op_push(list, op_ref(r));
	op_value *shown = es_show(P, list);
	CHECK(shown != NULL && shown->count == 1 && is_marker(shown->items[0]));
	op_free(shown);
	op_free(list);
	// the call's record: args and returned
	const es_handle_data *d = es_handle_lookup(E, ACTION);
	const char *id = NULL;
	CHECK(d != NULL && es_handle_id(E, &d->node, &id));
	const es_call *call = id == NULL ? NULL : es_records_call(E, id);
	CHECK(call != NULL);
	if (call != NULL) {
		es_call_view *v = es_call_view_of(es_host_context(E), call);
		CHECK(v->nargs == 1 && is_marker(v->args[0]));
		CHECK(v->has_returned && is_marker(v->returned));
		es_call_view_free(v);
	}
	op_free(r);
	op_free(WRITER);
	es_stop(STARTED, NULL);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// a program's start taken says where only: a stopped child's row a feature held is no business of the
// starter's (the host's own start names it)
static int hold_rows;
static int row_holder_write(void *ctx, es_context *o, const es_write *w, es_write_next *next) {
	(void)ctx;
	int takes = w->gone;
	if (!takes) {
		takes = 1;
		for (size_t i = 0; i < w->npatches; i++) {
			if (w->patches[i].has_value || w->patches[i].has_move) takes = 0;
		}
	}
	if (hold_rows && strcmp(w->part, "process") == 0 && takes) return 0;
	return es_next_write(next, o, w);
}
static int row_holder_setup(void *ctx, es_feature_api *f) {
	(void)ctx;
	return es_on_write(f, row_holder_write, NULL);
}
static es_refused TAKEN_BY_PROGRAM;
static es_out starts_stops_restarts(es_context *c, void *ctx) {
	(void)ctx;
	es_child k;
	es_refused no = {0};
	CHECK(es_start_in(c, plain_kid, NULL, es_text("/work/c"), NULL, &k, &no) == 0 && k.id != NULL);
	hold_rows = 1;
	CHECK(es_child_stop(c, k.id, NULL) == 0);
	es_child_free(&k);
	CHECK(es_start_in(c, plain_kid, NULL, es_text("/work/c"), NULL, &k, &TAKEN_BY_PROGRAM) == 0);
	CHECK(k.id == NULL);
	return es_out_of(NULL);
}
static void case_taken_names_no_holder_to_a_program(void) {
	es_feature holder = {.name = "holder", .setup = row_holder_setup};
	const es_feature *features[] = {&holder};
	E = NULL;
	free(KID);
	KID = NULL;
	hold_rows = 0;
	TAKEN_BY_PROGRAM = (es_refused){0};
	CHECK(es_create(&(es_options){.features = features, .nfeatures = 1}, &E) == 0);
	es_refused no = {0};
	CHECK(es_start(E, starts_stops_restarts, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	CHECK(TAKEN_BY_PROGRAM.refused != NULL && strcmp(TAKEN_BY_PROGRAM.refused, "taken") == 0);
	CHECK(TAKEN_BY_PROGRAM.nat == 2 && strcmp(TAKEN_BY_PROGRAM.at[0], "work") == 0);
	CHECK(!TAKEN_BY_PROGRAM.has_held && TAKEN_BY_PROGRAM.held_process == NULL &&
		TAKEN_BY_PROGRAM.held_feature == NULL);
	es_refused_free(&TAKEN_BY_PROGRAM);
	// the host's own start there names the stopped process and the feature
	es_started *again;
	es_refused host = {0};
	CHECK(es_start(E, plain_kid, NULL, es_text("/work/c"), NULL, &again, &host) != 0);
	es_clear_thrown();
	CHECK(host.refused != NULL && host.has_held && host.held_process != NULL);
	CHECK(host.held_feature != NULL && strcmp(host.held_feature, "holder") == 0);
	es_refused_free(&host);
	hold_rows = 0;
	es_stop(STARTED, NULL);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// a writer's own mark never carries userActivated: a writer made inside a writer run while the page is user-activated
// does not run its changes as activated, unless it is when it is called
static int event_now;
static int in_event(void *ctx) {
	(void)ctx;
	return event_now;
}
static op_value *INNER;
static int makes_inner(void *ctx) {
	(void)ctx;
	return es_create_writer(P, &INNER);
}
static int writes_k(void *ctx) {
	(void)ctx;
	op_value *seven = op_num(7);
	op_patch pt = {.has_value = 1, .value = seven};
	int code = es_patch(P, es_on_path(es_text("/k")), &pt, 1);
	op_free(seven);
	return code;
}
static es_out setup_with_k(es_context *c, void *ctx) {
	(void)ctx;
	P = c;
	es_handle *h;
	op_value *zero = op_num(0);
	CHECK(es_ensure_node(c, es_text("/k"), zero, &h) == 0);
	op_free(zero);
	CHECK(es_create_writer(c, &WRITER) == 0);
	return es_out_of(NULL);
}
static void case_writer_mark_has_no_user_activated(void) {
	fresh();
	es_close(E);
	es_free(E);
	E = NULL;
	event_now = 0;
	CHECK(es_create(&(es_options){.user_activated = in_event}, &E) == 0);
	es_refused no = {0};
	CHECK(es_start(E, setup_with_k, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	INNER = NULL;
	event_now = 1;
	CHECK(es_with_writer(E, WRITER, makes_inner, NULL) == 0);
	event_now = 0;
	CHECK(INNER != NULL);
	CHECK(es_with_writer(E, INNER, writes_k, NULL) == 0);
	es_explained *x = NULL;
	CHECK(es_explain(es_host_context(E), es_on_path(es_text("/k")), NULL, 0, &x) == 0);
	CHECK(x != NULL && x->change != NULL && !x->change->user_activated);
	es_explained_free(x);
	// control: the same writer run during an event does say so
	event_now = 1;
	CHECK(es_with_writer(E, INNER, writes_k, NULL) == 0);
	event_now = 0;
	x = NULL;
	CHECK(es_explain(es_host_context(E), es_on_path(es_text("/k")), NULL, 0, &x) == 0);
	CHECK(x != NULL && x->change != NULL && x->change->user_activated);
	es_explained_free(x);
	op_free(INNER);
	op_free(WRITER);
	es_stop(STARTED, NULL);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
}

// a child's stop is asked as the starter, whoever calls it: the policy sees the starter's context
static op_value *START_WHO, *STOP_WHO;
static op_value **record_into;
static pr_answer remembers_who(void *ctx, const pr_ask *ask, const pr_read *read) {
	(void)ctx, (void)read;
	if (record_into != NULL && strcmp(ask->op, "place") == 0 && ask->who != NULL) {
		op_free(*record_into);
		*record_into = op_ref((op_value *)ask->who);
	}
	return (pr_answer){.verdict = PR_YES};
}
static es_out starts_kid_work(es_context *c, void *ctx) {
	(void)ctx;
	P = c;
	es_child k;
	es_refused no = {0};
	record_into = &START_WHO;
	CHECK(es_start_in(c, plain_kid, NULL, es_text("/work/c"), NULL, &k, &no) == 0 && k.id != NULL);
	record_into = NULL;
	KID = es_dup(k.id);
	es_child_free(&k);
	return es_out_of(NULL);
}
static void case_child_stop_asks_as_starter(void) {
	free(KID);
	KID = NULL;
	pr_policy *may = pr_call(remembers_who, NULL);
	CHECK(es_create(&(es_options){.may = may}, &E) == 0);
	es_refused no = {0};
	CHECK(es_start(E, starts_kid_work, NULL, es_text("/code/p"), NULL, &STARTED, &no) == 0);
	es_pulse(es_host_context(E));
	CHECK(START_WHO != NULL);
	// the host is no one's to stop it; the starter's stop is asked, as the starter
	record_into = &STOP_WHO;
	CHECK(es_child_stop(es_host_context(E), KID, NULL) == ES_NOT_HERE);
	es_clear_thrown();
	CHECK(STOP_WHO == NULL);
	CHECK(es_child_stop(P, KID, NULL) == 0);
	record_into = NULL;
	CHECK(STOP_WHO != NULL && START_WHO != NULL && pr_same(START_WHO, STOP_WHO));
	op_free(START_WHO);
	op_free(STOP_WHO);
	START_WHO = STOP_WHO = NULL;
	es_stop(STARTED, NULL);
	es_pulse(es_host_context(E));
	es_started_free(STARTED);
	finish();
	pr_policy_free(may);
}

int main(void) {
	case_writer_dropped_in_f();
	case_parent_stopped_in_f();
	case_marked_writer_dropped_in_f();
	case_no_function();
	case_child_unplaces_itself();
	case_child_promise_settles();
	case_parent_ends_child_pending();
	case_close_with_children();
	case_ended_owner();
	case_child_of_another();
	case_cleanup_through_action();
	case_teardown_not_in_an_action();
	case_writer_hidden_in_records();
	case_taken_names_no_holder_to_a_program();
	case_writer_mark_has_no_user_activated();
	case_child_stop_asks_as_starter();
	puts(failed ? "FAILED" : "ok");
	return failed;
}
