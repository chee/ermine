// The C trackgraph on the line protocol (newcore/conformance/trackgraph/harness.ts): one JSON request per
// line in, one answer per line out. A node's owner is its name. Reads only the fixed shape the
// tests send: a flat object of string fields.
#include "trackgraph.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
	char *name;
	tg_node *node;
} entry;

static entry *entries;
static size_t count, capacity;

static void fail(const char *why) {
	fprintf(stderr, "harness: %s\n", why);
	exit(1);
}

static tg_node *node(const char *name) {
	for (size_t i = 0; i < count; i++)
		if (strcmp(entries[i].name, name) == 0) return entries[i].node;
	if (count == capacity) {
		capacity = capacity ? capacity * 2 : 16;
		entries = realloc(entries, capacity * sizeof *entries);
		if (entries == NULL) fail("out of memory");
	}
	char *copy = strdup(name);
	tg_node *n = copy ? tg_node_new(copy) : NULL;
	if (n == NULL) fail("out of memory");
	entries[count++] = (entry){copy, n};
	return n;
}

// the string value of "key" in a flat object, unescaped into out; 0 when absent
static int field(const char *line, const char *key, char *out, size_t size) {
	char pattern[64];
	snprintf(pattern, sizeof pattern, "\"%s\"", key);
	const char *p = strstr(line, pattern);
	if (p == NULL) return 0;
	p += strlen(pattern);
	while (*p == ' ' || *p == ':') p++;
	if (*p++ != '"') return 0;
	size_t n = 0;
	for (; *p && *p != '"'; p++) {
		if (*p == '\\' && p[1]) p++;
		if (n + 1 < size) out[n++] = *p;
	}
	out[n] = 0;
	return 1;
}

static void string(const char *s) {
	putchar('"');
	for (; *s; s++) {
		if (*s == '"' || *s == '\\') putchar('\\');
		putchar(*s);
	}
	putchar('"');
}

int main(void) {
	char line[4096], op[64], from[1024], to[1024], of[1024];
	while (fgets(line, sizeof line, stdin)) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		if (!field(line, "op", op, sizeof op)) fail("no op");
		int has_from = field(line, "from", from, sizeof from);
		int has_to = field(line, "to", to, sizeof to);
		int has_of = field(line, "of", of, sizeof of);
		if (strcmp(op, "reads") == 0 && has_of) {
			fputs("{\"names\":[", stdout);
			for (tg_link *l = node(of)->reads; l != NULL; l = l->next) {
				string(l->to->owner);
				if (l->next != NULL) putchar(',');
			}
			puts("]}");
			continue;
		}
		if (strcmp(op, "readers") == 0 && has_of) {
			size_t length;
			tg_link *const *rs = tg_readers(node(of), &length);
			fputs("{\"names\":[", stdout);
			for (size_t i = 0; i < length; i++) {
				if (i) putchar(',');
				string(rs[i]->from->owner);
			}
			puts("]}");
			continue;
		}
		if (!has_from) fail("no from");
		tg_node *f = node(from);
		int ok = 0;
		if (strcmp(op, "begin") == 0) tg_begin(f);
		else if (strcmp(op, "end") == 0) tg_end(f);
		else if (strcmp(op, "track") == 0 && has_to) ok = tg_track(f, node(to));
		else if (strcmp(op, "add") == 0 && has_to) ok = tg_add(f, node(to));
		else if (strcmp(op, "untrack") == 0) tg_untrack(f, has_to ? node(to) : NULL);
		else {
			printf("{\"error\":\"unknown op %s\"}\n", op);
			continue;
		}
		if (ok != 0) fail("out of memory");
		puts("{}");
	}
	return 0;
}
