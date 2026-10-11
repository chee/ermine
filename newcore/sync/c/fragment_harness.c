// The C fragment on the line protocol (newcore/conformance/fragment/harness.ts): one JSON request
// per line in, one answer per line out. Ids are 32 bytes in lowercase hex.
//   {op: "build", commits, heads, known}: {fragments: [{head, members, boundary, checkpoints}]},
//     sorted by head, each list sorted
//   {op: "walk", commits, head, known}: {members, boundary, checkpoints} or {error}
// commits: [{id, parents}]; known: [{head, members, boundary, checkpoints}]
#include "fragment.h"
#include "../../encoding/c/json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
	uint8_t id[32];
	uint8_t (*parents)[32];
	size_t count;
} commit;

typedef struct {
	commit *commits;
	size_t commit_count;
	fragment *known;
	size_t known_count;
} world;

static bool unhex(const char *s, uint8_t out[32]) {
	if (s == NULL || strlen(s) != 64) return false;
	for (int i = 0; i < 32; i++) {
		unsigned x;
		if (sscanf(s + 2 * i, "%2x", &x) != 1) return false;
		out[i] = (uint8_t)x;
	}
	return true;
}

static void need(const char *s, uint8_t out[32]) {
	if (!unhex(s, out)) fputs("bad id\n", stderr), exit(1);
}

static void hex(const uint8_t *b) {
	for (int i = 0; i < 32; i++) printf("%02x", b[i]);
}

static bool lookup(void *context, const uint8_t id[32], const uint8_t (**parents)[32], size_t *count) {
	world *w = context;
	for (size_t i = 0; i < w->commit_count; i++) {
		if (memcmp(w->commits[i].id, id, 32) != 0) continue;
		*parents = (const uint8_t(*)[32])w->commits[i].parents;
		*count = w->commits[i].count;
		return true;
	}
	return false;
}

static const fragment *known(void *context, const uint8_t head[32]) {
	world *w = context;
	for (size_t i = 0; i < w->known_count; i++)
		if (memcmp(w->known[i].head, head, 32) == 0) return &w->known[i];
	return NULL;
}

static void ids_from(const Json *list, fragment_ids *out) {
	for (int i = 0; list && i < list->array.count; i++) {
		uint8_t id[32];
		need(jsonText(list->array.items[i]), id);
		fragment_add(out, id);
	}
}

static void load(world *w, const Json *request) {
	const Json *commits = jsonGet(request, "commits"), *fragments = jsonGet(request, "known");
	w->commit_count = commits ? commits->array.count : 0;
	w->commits = calloc(w->commit_count + 1, sizeof(commit));
	for (size_t i = 0; i < w->commit_count; i++) {
		const Json *c = commits->array.items[i], *parents = jsonGet(c, "parents");
		need(jsonText(jsonGet(c, "id")), w->commits[i].id);
		w->commits[i].count = parents ? parents->array.count : 0;
		w->commits[i].parents = calloc(w->commits[i].count + 1, 32);
		for (size_t p = 0; p < w->commits[i].count; p++)
			need(jsonText(parents->array.items[p]), w->commits[i].parents[p]);
	}
	w->known_count = fragments ? fragments->array.count : 0;
	w->known = calloc(w->known_count + 1, sizeof(fragment));
	for (size_t i = 0; i < w->known_count; i++) {
		const Json *f = fragments->array.items[i];
		need(jsonText(jsonGet(f, "head")), w->known[i].head);
		ids_from(jsonGet(f, "members"), &w->known[i].members);
		ids_from(jsonGet(f, "boundary"), &w->known[i].boundary);
		ids_from(jsonGet(f, "checkpoints"), &w->known[i].checkpoints);
	}
}

static void unload(world *w) {
	for (size_t i = 0; i < w->commit_count; i++) free(w->commits[i].parents);
	free(w->commits);
	for (size_t i = 0; i < w->known_count; i++) fragment_free(&w->known[i]);
	free(w->known);
}

static void list(const char *name, const fragment_ids *ids) {
	printf("\"%s\":[", name);
	for (size_t i = 0; i < ids->count; i++) {
		if (i) putchar(',');
		putchar('"');
		hex(ids->ids[i]);
		putchar('"');
	}
	putchar(']');
}

static void body(const fragment *f) {
	list("members", &f->members);
	putchar(',');
	list("boundary", &f->boundary);
	putchar(',');
	list("checkpoints", &f->checkpoints);
}

static int by_head(const void *a, const void *b) {
	return memcmp(((const fragment *)a)->head, ((const fragment *)b)->head, 32);
}

static const char *errors[] = {"", "missing", "depth-zero"};

static void walk_op(const Json *request) {
	world w = {0};
	load(&w, request);
	uint8_t head[32];
	need(jsonText(jsonGet(request, "head")), head);
	fragment f;
	fragment_code code = fragment_walk(head, lookup, known, &w, &f);
	if (code != FRAGMENT_OK) printf("{\"error\":\"%s\"}\n", errors[code]);
	else {
		putchar('{');
		body(&f);
		puts("}");
		fragment_free(&f);
	}
	unload(&w);
}

static void build_op(const Json *request) {
	world w = {0};
	load(&w, request);
	const Json *list_of = jsonGet(request, "heads");
	size_t n = list_of ? list_of->array.count : 0;
	uint8_t (*heads)[32] = calloc(n + 1, 32);
	for (size_t i = 0; i < n; i++) need(jsonText(list_of->array.items[i]), heads[i]);
	fragment *made;
	size_t count;
	fragment_build((const uint8_t(*)[32])heads, n, lookup, known, &w, &made, &count);
	qsort(made, count, sizeof *made, by_head);
	fputs("{\"fragments\":[", stdout);
	for (size_t i = 0; i < count; i++) {
		if (i) putchar(',');
		fputs("{\"head\":\"", stdout);
		hex(made[i].head);
		fputs("\",", stdout);
		body(&made[i]);
		putchar('}');
	}
	puts("]}");
	fragment_release(made, count);
	free(heads);
	unload(&w);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		char *why = NULL;
		Json *request = jsonParse(line, strlen(line), &why);
		if (request == NULL) fprintf(stderr, "bad request: %s\n", why), exit(1);
		const char *op = jsonText(jsonGet(request, "op"));
		if (op && strcmp(op, "walk") == 0) walk_op(request);
		else if (op && strcmp(op, "build") == 0) build_op(request);
		else printf("{\"error\":\"unknown op %s\"}\n", op ? op : "");
		jsonFree(request);
	}
	fflush(stdout);
	free(line);
	return 0;
}
