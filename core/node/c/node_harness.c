// The C node on the line protocol (conformance/node/harness.ts): one JSON request per line in,
// one answer per line out. {op: "make", value?, header?} -> {node: {value?, change}}.
// Values are op_values (typed arrays and bytes too); actor and metadata values are kept as their JSON text
// and written back as is.
#include "shown.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void make(const char *line) {
	const char *v = field(line, "value"), *given = field(line, "header");
	op_value *value = v ? read_value(v) : NULL;
	ch_header h = given ? parse_header(given) : (ch_header){0};
	nd_node *n = nd_make(value, given ? &h : NULL);
	if (n == NULL) fail("out of memory");
	fputs("{\"node\":", stdout);
	show_node(n);
	puts("}");
	nd_free(n);
	op_free(value);
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
		fflush(stdout);
		clear();
	}
	free(line);
	finish();
	return 0;
}
