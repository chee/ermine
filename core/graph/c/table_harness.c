// the C table (table.h) on the line protocol of core/graph/typescript/table_harness.ts, which
// documents it. State lasts for the process: one table, one object per node name and one per symbol
// name, their addresses the nodes and the tokens.
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "table.h"
#include "../../../conformance/c/harness.h"

// named things: a node and a symbol are each an object whose address is the identity
typedef struct named named;
struct named {
	named *next;
	char *name;
};
static named *nodes, *symbols;
static named *intern(named **list, const char *name) {
	for (named *n = *list; n; n = n->next) if (!strcmp(n->name, name)) return n;
	named *n = calloc(1, sizeof *n);
	if (!n) abort();
	n->name = strdup(name);
	if (!n->name) abort();
	n->next = *list;
	*list = n;
	return n;
}

static named *node_of(const op_value *v, int *bad) {
	if (!v || v->type != OP_STR) { *bad = 1; return NULL; }
	return intern(&nodes, v->str);
}
// a key: a string, or {"symbol": name}
static tb_key key_of(const op_value *v, int *bad) {
	if (v && v->type == OP_STR) return tb_string(v->str);
	if (v && v->type == OP_MAP) {
		const char *s = hh_str(v, "symbol");
		if (s) return tb_symbol(intern(&symbols, s));
	}
	*bad = 1;
	return tb_string("");
}

static void put_key(FILE *out, tb_key k) {
	if (k.symbol == NULL) {
		op_json_string(out, k.string);
		return;
	}
	fputs("{\"symbol\":", out);
	op_json_string(out, ((const named *)k.symbol)->name);
	putc('}', out);
}

static void result(FILE *out, int code) {
	if (code) hh_error(out, "%s", tb_code_name(code));
	else fputs("{}", out);
}

static tb_table *table;

// every table event until asked: the keys, strings copied
typedef struct {
	tb_key part, id;
} event;
static event *events;
static size_t nevents, capevents;
static tb_key copy_key(tb_key k) {
	if (k.symbol) return k;
	char *s = strdup(k.string);
	if (!s) abort();
	return tb_string(s);
}
static void forget_events(void) {
	for (size_t i = 0; i < nevents; i++) {
		if (!events[i].part.symbol) free((char *)events[i].part.string);
		if (!events[i].id.symbol) free((char *)events[i].id.string);
	}
	nevents = 0;
}
static void told(void *ctx, tb_key part, tb_key id) {
	(void)ctx;
	if (nevents == capevents) {
		capevents = capevents ? capevents * 2 : 16;
		events = realloc(events, capevents * sizeof *events);
		if (!events) abort();
	}
	events[nevents++] = (event){copy_key(part), copy_key(id)};
}

void hh_start(void) { table = tb_make(told, NULL); }

void hh_answer(const op_value *r, FILE *out) {
	const char *o = hh_str(r, "op");
	if (!o) {
		hh_unknown(out, r);
		return;
	}
	const op_value *vpart = op_get(r, "part"), *vid = op_get(r, "id"), *vnode = op_get(r, "node");
	int bad = 0;
	if (!strcmp(o, "add") || !strcmp(o, "sub")) {
		tb_key part = key_of(vpart, &bad), id = key_of(vid, &bad);
		named *n = node_of(vnode, &bad);
		if (bad) { hh_error(out, "bad key or node"); return; }
		if (o[0] == 'a') {
			result(out, tb_add(table, part, id, n));
			return;
		}
		tb_sub(table, part, id, n);
		fputs("{}", out);
	} else if (!strcmp(o, "get")) {
		tb_key part = key_of(vpart, &bad), id = key_of(vid, &bad);
		if (bad) { hh_error(out, "bad key"); return; }
		named *n = tb_get(table, part, id);
		if (n == NULL) {
			fputs("{}", out);
			return;
		}
		fputs("{\"node\":", out);
		op_json_string(out, n->name);
		putc('}', out);
	} else if (!strcmp(o, "ids")) {
		tb_key part = key_of(vpart, &bad);
		named *n = node_of(vnode, &bad);
		if (bad) { hh_error(out, "bad key or node"); return; }
		size_t len;
		const tb_key *ids = tb_ids(table, part, n, &len);
		fputs("{\"ids\":[", out);
		for (size_t i = 0; i < len; i++) {
			if (i) putc(',', out);
			put_key(out, ids[i]);
		}
		fputs("]}", out);
	} else if (!strcmp(o, "at")) {
		tb_key id = key_of(vid, &bad);
		if (bad) { hh_error(out, "bad key"); return; }
		size_t len;
		const tb_entry *es = tb_at(table, id, &len);
		fputs("{\"entries\":[", out);
		for (size_t i = 0; i < len; i++) {
			if (i) putc(',', out);
			putc('[', out);
			put_key(out, es[i].part);
			putc(',', out);
			op_json_string(out, ((const named *)es[i].node)->name);
			putc(']', out);
		}
		fputs("]}", out);
	} else if (!strcmp(o, "who")) {
		named *n = node_of(vnode, &bad);
		if (bad) { hh_error(out, "bad node"); return; }
		size_t len;
		const tb_where *ws = tb_who(table, n, &len);
		fputs("{\"keys\":[", out);
		for (size_t i = 0; i < len; i++) {
			if (i) putc(',', out);
			putc('[', out);
			put_key(out, ws[i].part);
			putc(',', out);
			put_key(out, ws[i].id);
			putc(']', out);
		}
		fputs("]}", out);
	} else if (!strcmp(o, "events")) {
		fputs("{\"events\":[", out);
		for (size_t i = 0; i < nevents; i++) {
			if (i) putc(',', out);
			putc('[', out);
			put_key(out, events[i].part);
			putc(',', out);
			put_key(out, events[i].id);
			putc(']', out);
		}
		fputs("]}", out);
		forget_events();
	} else if (!strcmp(o, "del")) {
		if (!vpart) {
			named *n = node_of(vnode, &bad);
			if (bad) { hh_error(out, "bad node"); return; }
			result(out, tb_del_node(table, n));
			return;
		}
		tb_key part = key_of(vpart, &bad);
		if (vnode) {
			named *n = node_of(vnode, &bad);
			if (bad) { hh_error(out, "bad key or node"); return; }
			result(out, tb_del_part(table, part, n));
			return;
		}
		tb_key id = key_of(vid, &bad);
		if (bad) { hh_error(out, "bad key"); return; }
		result(out, tb_del(table, part, id));
	} else {
		hh_unknown(out, r);
	}
}

void hh_finish(void) {
	tb_free(table);
	forget_events();
	free(events);
	while (nodes) { named *n = nodes; nodes = n->next; free(n->name); free(n); }
	while (symbols) { named *n = symbols; symbols = n->next; free(n->name); free(n); }
}
