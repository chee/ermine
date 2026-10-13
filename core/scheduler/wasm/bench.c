// The cases of newcore/notify/c/bench.c, for wasm: no clock here, the caller times run().
// init() makes the content; setup(i) makes case i's notifier and reads; run(i, n) patches n times.
#include "../c/notify.h"

#include <stdio.h>
#include <stdlib.h>

#define N 10000
#define export __attribute__((visibility("default")))

static op_value *content;
static const op_value *get(void *ctx) {
	(void)ctx;
	return content;
}
static void nop(nt_kind kind, void *user) {
	(void)kind;
	(void)user;
}

static op_key num(long n) { return (op_key){.type = OP_NUM_KEY, .n = n}; }
static op_key str(const char *s) { return (op_key){.type = OP_STR_KEY, .s = s}; }
static op_key span(long a, long b) { return (op_key){.type = OP_SPAN, .a = a, .b = b}; }

static void listen(nt_notify *n, const op_key *path, size_t length, const nt_options *o) {
	nt_on(nt_open(n, path, length, o), nop, NULL);
}
static void every_item(nt_notify *n, int chase) {
	nt_options o = {.chase = chase};
	for (long i = 0; i < N; i++) {
		op_key p[2] = {str("items"), num(i)};
		listen(n, p, 2, &o);
	}
}

static op_key items_p[1], text_p[1], field_p[3], meta_new[2], last_p[2];
static op_patch first, append, middle, field, newkey, typed, typed0, lastfirst;
static nt_notify *current;

export void init(void) {
	char buf[32];
	op_value *items = op_list(), *rows = op_list(), *meta = op_map();
	for (long i = 0; i < N; i++) {
		snprintf(buf, sizeof buf, "e%ld", i);
		op_push(items, op_str(buf));
		op_value *row = op_map();
		snprintf(buf, sizeof buf, "r%ld", i);
		op_set(row, "id", op_str(buf));
		op_set(row, "v", op_num((double)i));
		op_push(rows, row);
		snprintf(buf, sizeof buf, "k%ld", i);
		op_set(meta, buf, op_num((double)i));
	}
	char *x = malloc(100001);
	for (int i = 0; i < 100000; i++) x[i] = 'x';
	x[100000] = 0;
	content = op_map();
	op_set(content, "items", items);
	op_set(content, "rows", rows);
	op_set(content, "text", op_str(x));
	op_set(content, "meta", meta);
	free(x);

	op_value *t = op_list();
	op_push(t, op_str("t"));
	op_value *one = op_num(1);
	op_value *a = op_str("a");
	items_p[0] = str("items");
	text_p[0] = str("text");
	field_p[0] = str("rows"), field_p[1] = num(5000), field_p[2] = str("v");
	meta_new[0] = str("meta"), meta_new[1] = str("new");
	last_p[0] = str("items"), last_p[1] = num(N - 1);
	first = (op_patch){.place = {items_p, 1, 1, 0, 0}, .has_value = 1, .value = t};
	append = (op_patch){.place = {items_p, 1, 1, N, N}, .has_value = 1, .value = t};
	middle = (op_patch){.place = {items_p, 1, 1, N / 2, N / 2 + 1}, .has_value = 1, .value = t};
	field = (op_patch){.place = {field_p, 3, 0, 0, 0}, .has_value = 1, .value = one};
	newkey = (op_patch){.place = {meta_new, 2, 0, 0, 0}, .has_value = 1, .value = one};
	typed = (op_patch){.place = {text_p, 1, 1, 49999, 49999}, .has_value = 1, .value = a};
	typed0 = (op_patch){.place = {text_p, 1, 1, 0, 0}, .has_value = 1, .value = a};
	lastfirst = (op_patch){.place = {items_p, 1, 1, 0, 0}, .has_move = 1, .move = {last_p, 2, 0, 0, 0}};
}

// in the order of newcore/notify/ts/notify_bench.ts
static const op_patch *patch_of(int i) {
	const op_patch *ps[] = {&first, &field, &first, &append, &middle, &first, &append, &lastfirst,
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
			op_key p[3] = {str("rows"), num(j), str("v")};
			listen(n, p, 3, NULL);
		}
		break;
	case 9: {
		for (long j = 0; j < N; j++) {
			snprintf(buf, sizeof buf, "k%ld", j);
			op_key p[2] = {str("meta"), str(buf)};
			listen(n, p, 2, NULL);
		}
		op_key meta_p[1] = {str("meta")};
		listen(n, meta_p, 1, NULL);
		break;
	}
	case 10: {
		op_key caret[2] = {str("text"), span(50000, 50000)};
		listen(n, caret, 2, &chase);
		break;
	}
	case 11:
		for (long j = 0; j < 100; j++) {
			op_key p[2] = {str("text"), span(j * 1000, j * 1000)};
			listen(n, p, 2, &chase);
		}
		break;
	}
}

export void run(int i, int times) {
	const op_patch *p = patch_of(i);
	for (int k = 0; k < times; k++) nt_patched(current, p, content);
}
