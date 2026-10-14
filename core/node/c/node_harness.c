// The C node on the line protocol (core/node/typescript/node_harness.ts documents it):
// {op: "make", value?, header?} -> {node: {value?, change}}.
#include <stdio.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../conformance/c/protocol.h"

void hh_answer(const op_value *request, FILE *out) {
	const char *op = hh_str(request, "op");
	if (op == NULL || strcmp(op, "make") != 0) {
		hh_unknown(out, request);
		return;
	}
	nd_node *n = hh_node(request);
	fputs("{\"node\":", out);
	hh_put_node(out, n);
	fputs("}", out);
	nd_free(n);
}
