// the C store (store.h) on the line protocol of ../typescript/store_harness.ts, which documents it.
// State lasts for the process: one store, one node per name and one symbol per name, their
// addresses the identities.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "store.h"

static st_store *store;

// a name is a node or a symbol; the address is the thing
typedef struct named named;
struct named {
	named *next;
	char *name;
	nd_entry *node;
};
static named *nodes, *symbols;

static named *by_name(named **list, const char *name, int make_node) {
	for (named *n = *list; n != NULL; n = n->next) {
		if (strcmp(n->name, name) == 0) return n;
	}
	named *n = calloc(1, sizeof *n);
	if (n == NULL || (n->name = strdup(name)) == NULL) hh_fail("out of memory");
	if (make_node) n->node = nd_make_entry(NULL, NULL, NULL);
	n->next = *list;
	*list = n;
	return n;
}
static named *node_named(const nd_entry *node) {
	for (named *n = nodes; n != NULL; n = n->next) {
		if (n->node == node) return n;
	}
	return NULL;
}
static named *symbol_named(const void *token) {
	for (named *n = symbols; n != NULL; n = n->next) {
		if ((void *)n == token) return n;
	}
	return NULL;
}

// a key: a string, or {"symbol": name}. false when it is neither
static int key_of(const op_value *v, tb_key *out) {
	if (v != NULL && v->type == OP_STR) {
		*out = tb_string(v->str);
		return 1;
	}
	const char *symbol = hh_str(v, "symbol");
	if (symbol == NULL) return 0;
	*out = tb_symbol(by_name(&symbols, symbol, 0));
	return 1;
}
static void put_key(FILE *out, tb_key k) {
	if (k.symbol == NULL) {
		op_json_string(out, k.string);
		return;
	}
	fputs("{\"symbol\":", out);
	op_json_string(out, symbol_named(k.symbol)->name);
	putc('}', out);
}

// the events told since last asked, as the JSON text of a list's items
static FILE *events;
static char *told;
static size_t told_size, told_count;
static void event(void *ctx, tb_key source, const char *part, tb_key id) {
	(void)ctx;
	if (told_count++) putc(',', events);
	putc('[', events);
	put_key(events, source);
	putc(',', events);
	op_json_string(events, part);
	putc(',', events);
	put_key(events, id);
	putc(',', events);
	const nd_entry *node = st_get(store, source, part, id);
	if (node == NULL) fputs("null", events);
	else op_json_string(events, node_named(node)->name);
	putc(']', events);
}
static void open_events(void) {
	events = open_memstream(&told, &told_size);
	if (events == NULL) hh_fail("out of memory");
	told_count = 0;
}

// an answer is written to out only when there is no refusal: the refusal is the text returned
static const char *code(FILE *out, int c) {
	if (c != 0) return tb_code_name(c);
	fputs("{}", out);
	return NULL;
}
static const char *with_node(FILE *out, const nd_entry *node) {
	fputs("{", out);
	if (node != NULL) {
		fputs("\"node\":", out);
		op_json_string(out, node_named(node)->name);
	}
	fputs("}", out);
	return NULL;
}

static const char *run(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) return "no op";
	if (strcmp(op, "events") == 0) {
		fflush(events);
		fprintf(out, "{\"events\":[%s]}", told);
		fclose(events);
		free(told);
		open_events();
		return NULL;
	}
	tb_key source, id;
	if (!key_of(op_get(r, "source"), &source)) return "source: not a string or a symbol";
	if (strcmp(op, "drop") == 0) {
		st_drop(store, source);
		fputs("{}", out);
		return NULL;
	}
	if (strcmp(op, "who") == 0) {
		const char *name = hh_str(r, "node");
		if (name == NULL) return "node: not a name";
		size_t n;
		const st_key *keys = st_who(store, source, by_name(&nodes, name, 1)->node, &n);
		fputs("{\"keys\":[", out);
		for (size_t i = 0; i < n; i++) {
			if (i) putc(',', out);
			putc('[', out);
			op_json_string(out, keys[i].part);
			putc(',', out);
			put_key(out, keys[i].id);
			putc(']', out);
		}
		fputs("]}", out);
		return NULL;
	}
	if (!key_of(op_get(r, "id"), &id)) return "id: not a string or a symbol";
	if (strcmp(op, "children") == 0) return with_node(out, st_children(store, source, id));
	// any string is a part
	const char *part = hh_str(r, "part");
	if (part == NULL) return "part: not a string";
	if (strcmp(op, "get") == 0) return with_node(out, st_get(store, source, part, id));
	if (strcmp(op, "del") == 0) return code(out, st_del(store, source, part, id));
	if (strcmp(op, "add") == 0 || strcmp(op, "sub") == 0) {
		const char *name = hh_str(r, "node");
		if (name == NULL) return "node: not a name";
		nd_entry *node = by_name(&nodes, name, 1)->node;
		if (op[0] == 'a') return code(out, st_add(store, source, part, id, node));
		st_sub(store, source, part, id, node);
		fputs("{}", out);
		return NULL;
	}
	return "unknown op";
}

void hh_start(void) {
	store = st_new(event, NULL);
	open_events();
}

void hh_answer(const op_value *r, FILE *out) {
	const char *why = run(r, out);
	if (why) hh_error(out, "%s", why);
}

void hh_finish(void) {
	st_free(store);
	fclose(events);
	free(told);
	while (nodes != NULL) {
		named *x = nodes;
		nodes = x->next;
		nd_free_entry(x->node);
		free(x->name);
		free(x);
	}
	while (symbols != NULL) {
		named *x = symbols;
		symbols = x->next;
		free(x->name);
		free(x);
	}
}
