// The cases of newcore/notify_bench.ts, in C. Times nt_patched() only: the content is made once,
// the patch never applied. Each case runs until it has taken a fifth of a second (at least 3 runs).
#include "notify.h"

#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#define N 10000

static nt_value *content;
static const nt_value *get(void *ctx) {
	(void)ctx;
	return content;
}
static void nop(nt_kind kind, void *user) {
	(void)kind;
	(void)user;
}
static double now(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (double)t.tv_sec * 1e9 + (double)t.tv_nsec;
}

static nt_key num(long n) { return (nt_key){.type = NT_NUM_KEY, .n = n}; }
static nt_key str(const char *s) { return (nt_key){.type = NT_STR_KEY, .s = s}; }
static nt_key span(long a, long b) { return (nt_key){.type = NT_SPAN, .a = a, .b = b}; }

static nt_notify *fresh(void) { return nt_create(get, NULL); }
static void listen(nt_notify *n, const nt_key *path, size_t length, const nt_options *o) {
	nt_on(nt_open(n, path, length, o), nop, NULL);
}
static void every_item(nt_notify *n, int chase) {
	nt_options o = {.chase = chase};
	for (long i = 0; i < N; i++) {
		nt_key p[2] = {str("items"), num(i)};
		listen(n, p, 2, &o);
	}
}

static void run(const char *group, const char *name, nt_notify *n, const nt_patch *patch) {
	nt_patched(n, patch, content);
	long runs = 0;
	double start = now(), end = start;
	while (runs < 3 || end - start < 2e8) {
		nt_patched(n, patch, content);
		runs++;
		end = now();
	}
	double ns = (end - start) / (double)runs;
	if (ns >= 1e6) printf("%-20s %-44s %9.2f ms\n", group, name, ns / 1e6);
	else if (ns >= 1e3) printf("%-20s %-44s %9.2f us\n", group, name, ns / 1e3);
	else printf("%-20s %-44s %9.0f ns\n", group, name, ns);
	nt_destroy(n);
}

int main(void) {
	char buf[32];
	nt_value *items = nt_list(), *rows = nt_list(), *meta = nt_map();
	for (long i = 0; i < N; i++) {
		snprintf(buf, sizeof buf, "e%ld", i);
		nt_push(items, nt_str(buf));
		nt_value *row = nt_map();
		snprintf(buf, sizeof buf, "r%ld", i);
		nt_set(row, "id", nt_str(buf));
		nt_set(row, "v", nt_num((double)i));
		nt_push(rows, row);
		snprintf(buf, sizeof buf, "k%ld", i);
		nt_set(meta, buf, nt_num((double)i));
	}
	char *x = malloc(100001);
	for (int i = 0; i < 100000; i++) x[i] = 'x';
	x[100000] = 0;
	content = nt_map();
	nt_set(content, "items", items);
	nt_set(content, "rows", rows);
	nt_set(content, "text", nt_str(x));
	nt_set(content, "meta", meta);
	free(x);

	nt_value *t = nt_list();
	nt_push(t, nt_str("t"));
	nt_value *one = nt_num(1);
	nt_value *a = nt_str("a");

	nt_key items_p[1] = {str("items")};
	nt_key text_p[1] = {str("text")};
	nt_key field_p[3] = {str("rows"), num(5000), str("v")};
	nt_key meta_new[2] = {str("meta"), str("new")};
	nt_patch first = {.place = {items_p, 1, 1, 0, 0}, .has_value = 1, .value = t};
	nt_patch append = {.place = {items_p, 1, 1, N, N}, .has_value = 1, .value = t};
	nt_patch middle = {.place = {items_p, 1, 1, N / 2, N / 2 + 1}, .has_value = 1, .value = t};
	nt_patch field = {.place = {field_p, 3, 0, 0, 0}, .has_value = 1, .value = one};
	nt_patch newkey = {.place = {meta_new, 2, 0, 0, 0}, .has_value = 1, .value = one};
	nt_patch typed = {.place = {text_p, 1, 1, 49999, 49999}, .has_value = 1, .value = a};
	nt_patch typed0 = {.place = {text_p, 1, 1, 0, 0}, .has_value = 1, .value = a};
	nt_key last_p[2] = {str("items"), num(N - 1)};
	nt_patch lastfirst = {.place = {items_p, 1, 1, 0, 0}, .has_move = 1, .move = {last_p, 2, 0, 0, 0}};

	run("no reads", "insert first, no reads", fresh(), &first);
	run("no reads", "put a row's field, no reads", fresh(), &field);
	nt_notify *n;
	every_item(n = fresh(), 0);
	run("10k item reads", "insert first: every one fires", n, &first);
	every_item(n = fresh(), 0);
	run("10k item reads", "append: none fire", n, &append);
	every_item(n = fresh(), 0);
	run("10k item reads", "same-length put in the middle", n, &middle);
	every_item(n = fresh(), 1);
	run("10k chased reads", "insert first, chased: every one moves", n, &first);
	every_item(n = fresh(), 1);
	run("10k chased reads", "append, chased: none move", n, &append);
	n = fresh();
	for (long i = 0; i < N; i++) {
		nt_key p[3] = {str("rows"), num(i), str("v")};
		listen(n, p, 3, NULL);
	}
	run("10k row field reads", "put one row's field", n, &field);
	n = fresh();
	for (long i = 0; i < N; i++) {
		snprintf(buf, sizeof buf, "k%ld", i);
		nt_key p[2] = {str("meta"), str(buf)};
		listen(n, p, 2, NULL);
	}
	nt_key meta_p[1] = {str("meta")};
	listen(n, meta_p, 1, NULL);
	run("10k key reads", "put a new key", n, &newkey);
	n = fresh();
	nt_key caret[2] = {str("text"), span(50000, 50000)};
	nt_options chase = {.chase = 1};
	listen(n, caret, 2, &chase);
	run("text", "type before a caret in 100k chars", n, &typed);
	n = fresh();
	for (long i = 0; i < 100; i++) {
		nt_key p[2] = {str("text"), span(i * 1000, i * 1000)};
		listen(n, p, 2, &chase);
	}
	run("text", "type, 100 carets", n, &typed0);
	every_item(n = fresh(), 1);
	run("10k chased reads", "move last to first, chased", n, &lastfirst);
	nt_free(t);
	nt_free(one);
	nt_free(a);
	nt_free(content);
	return 0;
}
