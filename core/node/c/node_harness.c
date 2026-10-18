// The C node on the line protocol (core/node/typescript/node_harness.ts documents it):
// {op: "entry", value?, header?} -> {entry: {value?, change}}
// {op: "node", values: {<table>: value}, header?} -> {node: {<table>: {value?, change}}}
#include <stdio.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../conformance/c/protocol_harness.h"

// a header whose metadata is there and no object: answered an error, 1
static int bad_header(const op_value *request, FILE *out) {
	const op_value *header = op_get(request, "header");
	const op_value *meta = header && header->type == OP_MAP ? op_get(header, "metadata") : NULL;
	if (meta == NULL || meta->type == OP_MAP) return 0;
	hh_error(out, "metadata is not an object");
	return 1;
}

static void entry(const op_value *request, FILE *out) {
	if (bad_header(request, out)) return;
	nd_entry *e = hh_entry(request);
	fputs("{\"entry\":", out);
	hh_put_entry(out, e);
	fputs("}", out);
	nd_free_entry(e);
}

static void node(const op_value *request, FILE *out) {
	const op_value *values = op_get(request, "values");
	if (values == NULL || values->type != OP_MAP) {
		hh_error(out, "no values");
		return;
	}
	if (bad_header(request, out)) return;
	size_t n = values->count;
	nd_value *given = hh_take((n ? n : 1) * sizeof *given);
	for (size_t i = 0; i < n; i++) given[i] = (nd_value){values->keys[i], values->items[i]};
	const op_value *header = op_get(request, "header");
	ch_header h = header ? hh_header(header) : (ch_header){0};
	nd_node *made = nd_make_node(given, n, &h);
	if (made == NULL) hh_fail("out of memory");
	fputs("{\"node\":", out);
	hh_put_node(out, made);
	fputs("}", out);
	nd_free_node(made);
}

void hh_answer(const op_value *request, FILE *out) {
	const char *op = hh_str(request, "op");
	if (op != NULL && strcmp(op, "entry") == 0) entry(request, out);
	else if (op != NULL && strcmp(op, "node") == 0) node(request, out);
	else hh_unknown(out, request);
}
