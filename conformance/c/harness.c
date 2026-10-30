// The loop shared by every suite's C harness; see harness.h.
#define _POSIX_C_SOURCE 200809L
#include "harness.h"

#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

void hh_fail(const char *why) {
	fprintf(stderr, "harness: %s\n", why);
	exit(1);
}

struct hh_line {
	char *text;
	op_value *request;
	void **blocks;
	size_t length, capacity;
	op_value **held;
	size_t held_length, held_capacity;
	int retained;
};
static hh_line *current;

static void *grow(void *p, size_t *capacity, size_t size) {
	*capacity = *capacity ? *capacity * 2 : 16;
	p = realloc(p, *capacity * size);
	if (p == NULL) hh_fail("out of memory");
	return p;
}

void *hh_take(size_t size) {
	void *p = malloc(size ? size : 1);
	if (p == NULL) hh_fail("out of memory");
	if (current->length == current->capacity) {
		current->blocks = grow(current->blocks, &current->capacity, sizeof *current->blocks);
	}
	return current->blocks[current->length++] = p;
}
op_value *hh_hold(op_value *v) {
	if (current->held_length == current->held_capacity) {
		current->held = grow(current->held, &current->held_capacity, sizeof *current->held);
	}
	return current->held[current->held_length++] = v;
}
const char *hh_text(void) { return current->text; }

void hh_release(hh_line *line) {
	if (line == NULL) return;
	for (size_t i = 0; i < line->length; i++) free(line->blocks[i]);
	for (size_t i = 0; i < line->held_length; i++) op_free(line->held[i]);
	op_free(line->request);
	free(line->blocks);
	free(line->held);
	free(line->text);
	free(line);
}
hh_line *hh_retain(void) {
	current->retained = 1;
	return current;
}

void hh_error(FILE *out, const char *why, ...) {
	char *text;
	size_t size;
	FILE *s = open_memstream(&text, &size);
	if (s == NULL) hh_fail("out of memory");
	va_list args;
	va_start(args, why);
	vfprintf(s, why, args);
	va_end(args);
	fclose(s);
	fputs("{\"error\":", out);
	op_json_string(out, text);
	fputc('}', out);
	free(text);
}
void hh_unknown(FILE *out, const op_value *request) {
	const char *op = hh_str(request, "op");
	hh_error(out, "unknown op %s", op ? op : "(none)");
}
const char *hh_str(const op_value *map, const char *key) {
	const op_value *v = op_get(map, key);
	return v && v->type == OP_STR ? v->str : NULL;
}

__attribute__((weak)) void hh_start(void) {}
__attribute__((weak)) void hh_finish(void) {}

int main(void) {
	char *text = NULL;
	size_t capacity = 0;
	ssize_t n;
	hh_start();
	while ((n = getline(&text, &capacity, stdin)) != -1) {
		if (strspn(text, " \t\r\n") == (size_t)n) continue;
		hh_line *line = calloc(1, sizeof *line);
		if (line == NULL) hh_fail("out of memory");
		line->text = strdup(text);
		if (line->text == NULL) hh_fail("out of memory");
		current = line;
		char *answer;
		size_t size;
		FILE *out = open_memstream(&answer, &size);
		if (out == NULL) hh_fail("out of memory");
		const char *why = NULL;
		line->request = op_json_read(text, &why);
		if (line->request == NULL) hh_error(out, "%s", why);
		else if (line->request->type != OP_MAP) hh_error(out, "not an object");
		else hh_answer(line->request, out);
		fclose(out);
		fputs(answer, stdout);
		fputc('\n', stdout);
		fflush(stdout);
		free(answer);
		if (!line->retained) hh_release(line);
		current = NULL;
	}
	free(text);
	hh_finish();
	return 0;
}
