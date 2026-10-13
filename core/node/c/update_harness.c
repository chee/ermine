// The C update on the line protocol (conformance/update/harness.ts): one JSON request per line
// in, one answer per line out. State lasts for the process: one node.
//   {op: "start", value?, header?} -> {}
//   {op: "update", patches, header?, list?} -> {} | {error: {code, patch}}
//   {op: "node"} -> {node: {value?, change}}, change.op as {patches, undo}
// Values and patches as shown.h reads them (typed arrays and bytes too). The node's change
// refers to the patches and the header's pieces: they are kept (the arena, the request's values)
// until the next update that works, or start.
#include "update.h"
#include "shown.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static nd_node *node;
// what the node's change refers to: the values of the patches of the latest update that worked
static op_value **owners;
static size_t owners_length;

static void let_go(op_value ***os, size_t *n) {
	for (size_t i = 0; i < *n; i++) op_free((*os)[i]);
	free(*os);
	*os = NULL;
	*n = 0;
}

static int flag(const char *line, const char *name) {
	const char *f = field(line, name);
	return f && strncmp(f, "true", 4) == 0;
}

static void start(const char *line) {
	nd_free(node);
	let_go(&owners, &owners_length);
	clear();
	const char *v = field(line, "value"), *given = field(line, "header");
	op_value *value = v ? read_value(v) : NULL;
	ch_header h = given ? parse_header(given) : (ch_header){0};
	node = nd_make(value, &h);
	if (node == NULL) fail("out of memory");
	// the node holds the value now
	op_free(value);
	puts("{}");
}

static void update(const char *line) {
	const char **xs;
	size_t n = items(field(line, "patches"), &xs);
	op_patch *patches = take((n ? n : 1) * sizeof *patches);
	op_value **mine = malloc((n ? n : 1) * sizeof *mine);
	if (mine == NULL) fail("out of memory");
	for (size_t i = 0; i < n; i++) mine[i] = read_patch(xs[i], &patches[i]);
	const char *given = field(line, "header");
	ch_header h = given ? parse_header(given) : (ch_header){.has_time = 1, .time = 1, .actor = "\"me\""};
	nd_update_options o = {.list = flag(line, "list")};
	size_t at = 0;
	int code = nd_update(node, patches, n, h, &o, &at);
	if (code != OP_OK) {
		printf("{\"error\":{\"code\":\"%s\",\"patch\":%zu}}\n", op_code_name(code), at);
		let_go(&mine, &n);
		return;
	}
	let_go(&owners, &owners_length);
	owners = mine;
	owners_length = n;
	puts("{}");
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	node = nd_make(NULL, NULL);
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		const char *op = field(line, "op");
		if (op == NULL) fail("no op");
		char *name = string(op);
		if (strcmp(name, "start") == 0) start(line);
		else if (strcmp(name, "update") == 0) update(line);
		else if (strcmp(name, "node") == 0) {
			fputs("{\"node\":", stdout);
			show_node(node);
			puts("}");
		} else printf("{\"error\":\"unknown op %s\"}\n", name);
		fflush(stdout);
	}
	nd_free(node);
	let_go(&owners, &owners_length);
	free(line);
	finish();
	return 0;
}
