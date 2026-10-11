// The cases of newcore/notify/c/bench.c, for wasm: no clock here, the caller times run().
// init() makes the content; setup(i) makes case i's notifier and reads; run(i, n) patches n times.
#include "../c/notify.h"

#include <stdio.h>
#include <stdlib.h>

#define N 10000
#define export __attribute__((visibility("default")))

static nt_value *content;
static const nt_value *get(void *ctx) {
	(void)ctx;
	return content;
}
static void nop(nt_kind kind, void *user) {
	(void)kind;
	(void)user;
}

static nt_key num(long n) { return (nt_key){.type = NT_NUM_KEY, .n = n}; }
static nt_key str(const char *s) { return (nt_key){.type = NT_STR_KEY, .s = s}; }
static nt_key span(long a, long b) { return (nt_key){.type = NT_SPAN, .a = a, .b = b}; }

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

static nt_key items_p[1], text_p[1], field_p[3], meta_new[2], last_p[2];
static nt_patch first, append, middle, field, newkey, typed, typed0, lastfirst;
static nt_notify *current;

export void init(void) {
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
	items_p[0] = str("items");
	text_p[0] = str("text");
	field_p[0] = str("rows"), field_p[1] = num(5000), field_p[2] = str("v");
	meta_new[0] = str("meta"), meta_new[1] = str("new");
	last_p[0] = str("items"), last_p[1] = num(N - 1);
	first = (nt_patch){.place = {items_p, 1, 1, 0, 0}, .has_value = 1, .value = t};
	append = (nt_patch){.place = {items_p, 1, 1, N, N}, .has_value = 1, .value = t};
	middle = (nt_patch){.place = {items_p, 1, 1, N / 2, N / 2 + 1}, .has_value = 1, .value = t};
	field = (nt_patch){.place = {field_p, 3, 0, 0, 0}, .has_value = 1, .value = one};
	newkey = (nt_patch){.place = {meta_new, 2, 0, 0, 0}, .has_value = 1, .value = one};
	typed = (nt_patch){.place = {text_p, 1, 1, 49999, 49999}, .has_value = 1, .value = a};
	typed0 = (nt_patch){.place = {text_p, 1, 1, 0, 0}, .has_value = 1, .value = a};
	lastfirst = (nt_patch){.place = {items_p, 1, 1, 0, 0}, .has_move = 1, .move = {last_p, 2, 0, 0, 0}};
}

// in the order of newcore/notify_bench.ts
static const nt_patch *patch_of(int i) {
	const nt_patch *ps[] = {&first, &field, &first, &append, &middle, &first, &append, &lastfirst,
		&field, &newkey, &typed, &typed0};
	return ps[i];
}
export int cases(void) { return 12; }

export void setup(int i) {
	if (current) nt_destroy(current);
	nt_notify *n = current = nt_create(get, NULL);
	char buf[32];
	nt_options chase = {.chase = 1};
	switch (i) {
	case 2: case 3: case 4:
		every_item(n, 0);
		break;
	case 5: case 6: case 7:
		every_item(n, 1);
		break;
	case 8:
		for (long j = 0; j < N; j++) {
			nt_key p[3] = {str("rows"), num(j), str("v")};
			listen(n, p, 3, NULL);
		}
		break;
	case 9: {
		for (long j = 0; j < N; j++) {
			snprintf(buf, sizeof buf, "k%ld", j);
			nt_key p[2] = {str("meta"), str(buf)};
			listen(n, p, 2, NULL);
		}
		nt_key meta_p[1] = {str("meta")};
		listen(n, meta_p, 1, NULL);
		break;
	}
	case 10: {
		nt_key caret[2] = {str("text"), span(50000, 50000)};
		listen(n, caret, 2, &chase);
		break;
	}
	case 11:
		for (long j = 0; j < 100; j++) {
			nt_key p[2] = {str("text"), span(j * 1000, j * 1000)};
			listen(n, p, 2, &chase);
		}
		break;
	}
}

export void run(int i, int times) {
	const nt_patch *p = patch_of(i);
	for (int k = 0; k < times; k++) nt_patched(current, p, content);
}
