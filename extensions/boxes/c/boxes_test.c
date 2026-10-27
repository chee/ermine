// what a review of boxes proved in C and the harness cannot show: memory used after it was freed, under
// AddressSanitizer, and what the box keeps of the processes it started. the box's own file is
// included, to read what it keeps. make test-boxes-marks, test-check-boxes-marks (the sanitizers)
#include "boxes.c"

static int failed;
#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			failed = 1; \
		} \
	} while (0)

static int ENDED;
static void note(void *ctx, const char *why) {
	(void)ctx;
	(void)why;
	ENDED++;
}
static es_out setup(es_context *c, void *ctx) {
	(void)ctx;
	es_add_teardown(c, note, NULL);
	return es_out_of(NULL);
}

// the caller stops its process and lets it go, then closes the box: the box held no pointer of it
static void case_close_after_caller_freed(void) {
	es_ermine *e;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	bx_box *b;
	bx_create(e, &b);
	es_started *s;
	es_refused no;
	CHECK(bx_start(b, setup, NULL, es_text("/p"), NULL, &s, &no) == 0);
	CHECK(b->nrunning == 1);
	es_stop(s, NULL);
	CHECK(b->nrunning == 0);
	es_started_free(s);
	CHECK(bx_close(b) == 0);
	es_close(e);
	es_free(e);
	bx_free(b);
}

// many processes, each stopped as it goes: the box's list does not grow, and what is still running at
// close is stopped, told "box closed"
static void case_ended_leave_the_list(void) {
	es_ermine *e;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	bx_box *b;
	bx_create(e, &b);
	for (int i = 0; i < 50; i++) {
		es_started *s;
		es_refused no;
		CHECK(bx_start(b, setup, NULL, es_text("/p"), NULL, &s, &no) == 0);
		es_stop(s, NULL);
		es_started_free(s);
	}
	CHECK(b->nrunning == 0);
	es_started *keep;
	es_refused no;
	CHECK(bx_start(b, setup, NULL, es_text("/q"), NULL, &keep, &no) == 0);
	CHECK(bx_start(b, setup, NULL, es_text("/q"), NULL, &keep, &no) == ES_TAKEN);
	CHECK(b->nrunning == 1);
	int before = ENDED;
	CHECK(bx_close(b) == 0);
	CHECK(ENDED == before + 1);
	CHECK(b->nrunning == 0);
	es_started_free(keep);
	es_close(e);
	es_free(e);
	bx_free(b);
}

// done with the box: closed and let go, and the ermine goes on
static void case_box_freed_ermine_goes_on(void) {
	es_ermine *e;
	CHECK(es_create(&(es_options){0}, &e) == 0);
	bx_box *b;
	bx_create(e, &b);
	es_started *s;
	es_refused no;
	CHECK(bx_start(b, setup, NULL, es_text("/p"), NULL, &s, &no) == 0);
	CHECK(bx_close(b) == 0);
	bx_free(b);
	es_handle *n;
	CHECK(es_ensure_node(es_host_context(e), es_text("/after"), NULL, &n) == 0);
	es_started_free(s);
	es_close(e);
	es_free(e);
}

int main(void) {
	case_close_after_caller_freed();
	case_ended_leave_the_list();
	case_box_freed_ermine_goes_on();
	puts(failed ? "FAILED" : "ok");
	return failed;
}
