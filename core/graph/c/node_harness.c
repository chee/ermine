// The C node on the line protocol (newcore/conformance/node/harness.ts): one JSON request per
// line in, one answer per line out. Content, change, because, actor and cause are kept as their
// JSON text and written back as is; in a list, {"symbol": name} is a symbol.
#include "shown.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void make(const char *line) {
	nd_contents c = {0};
	const char *contents = field(line, "contents");
	if (contents) {
		const char *value = field(contents, "value"), *info = field(contents, "info"),
			   *children = field(contents, "children");
		if (value) c.value = object(value, 0);
		if (info) c.info_length = named(info, 0, &c.info);
		if (children) c.children_length = named(children, 1, &c.children);
	}
	const char *given = field(line, "header");
	nd_header h = given ? parse_header(given) : (nd_header){0};
	const char *outside = field(line, "outside");
	int out = outside && strncmp(outside, "true", 4) == 0;
	nd_node *n = nd_make(string(field(line, "id")), &c, given ? &h : NULL, out ? ND_HERE : NULL);
	if (n == NULL) fail("out of memory");
	fputs("{\"node\":", stdout);
	show_node(n);
	puts("}");
	nd_free(n);
}

int main(void) {
	char *line = NULL;
	size_t capacity = 0;
	while (getline(&line, &capacity, stdin) != -1) {
		if (strspn(line, " \t\r\n") == strlen(line)) continue;
		const char *op = field(line, "op");
		if (op == NULL) fail("no op");
		char *name = string(op);
		if (strcmp(name, "make") == 0) make(line);
		else printf("{\"error\":\"unknown op %s\"}\n", name);
		clear();
	}
	free(line);
	finish();
	return 0;
}
