// The C node on the line protocol (core/node/typescript/node_harness.ts documents it):
// {op: "entry", value?, header?} -> {entry: {value?, change}}
// {op: "node", entries: {<table>: {value?, header?}}} -> {node: {<table>: {value?, change}}}
#include <stdio.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../conformance/c/protocol.h"

static void entry(const op_value *request, FILE *out) {
	nd_entry *e = hh_entry(request);
	fputs("{\"entry\":", out);
	hh_put_entry(out, e);
	fputs("}", out);
	nd_free_entry(e);
}

static void node(const op_value *request, FILE *out) {
	const op_value *entries = op_get(request, "entries");
	if (entries == NULL || entries->type != OP_MAP) hh_fail("no entries");
	size_t n = entries->count;
	nd_slot *slots = hh_take((n ? n : 1) * sizeof *slots);
	for (size_t i = 0; i < n; i++) {
		slots[i] = (nd_slot){entries->keys[i], hh_entry(entries->items[i])};
	}
	nd_node made = nd_make_node(slots, n);
	fputs("{\"node\":", out);
	hh_put_node(out, &made);
	fputs("}", out);
	for (size_t i = 0; i < n; i++) nd_free_entry(slots[i].entry);
}

void hh_answer(const op_value *request, FILE *out) {
	const char *op = hh_str(request, "op");
	if (op != NULL && strcmp(op, "entry") == 0) entry(request, out);
	else if (op != NULL && strcmp(op, "node") == 0) node(request, out);
	else hh_unknown(out, request);
}
