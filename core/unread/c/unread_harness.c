// the C unread (unread.h) on the line protocol of typescript/unread_harness.ts, which documents
// it (conformance/c/harness.h has the loop). one entry and its unread last for the process, and
// what was held and marked: each kept alive (op_ref) and compared by pointer
#define _POSIX_C_SOURCE 200809L // strdup
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/protocol_harness.h"
#include "unread.h"

static un_unread *unread;
static nd_entry *entry;
// a name and what it stands for (NULL: nothing)
typedef struct {
	char *name;
	op_value *value;
} named;
typedef struct {
	named *items;
	size_t count, capacity;
} names;
static names held, marked;
// the undo the entry's last change refers to as its patches, when an unwrite wrote it: kept
// alive while the entry refers to it
static op_undo spare;

static void drop(void *value, void *data) {
	(void)data;
	op_free(value);
}
static struct {
	sc_scheduler *s;
	op_value *k;
	// keep's writes (NULL: none), and whether the run writes them (else its set)
	const op_value *writes;
	int by_run;
} run;
static ch_header change(void);
// keep's writes written to the entry, by the set or the run; refused: nothing written
static void writes(void) {
	if (run.writes == NULL || run.writes->type != OP_LIST) return;
	size_t n = run.writes->count;
	op_patch *patches = hh_take((n + 1) * sizeof *patches);
	for (size_t i = 0; i < n; i++) hh_patch(run.writes->items[i], &patches[i]);
	un_update(unread, entry, patches, n, change(), NULL);
}
// the key a computation tracks; handed (keeping's) names what is at path by it
static char tracked;
static const op_value *handed_by(const void *key, void *ctx) { return key == &tracked ? ctx : NULL; }
// what a computer returns, one reference given to the scheduler
static sc_out compute(void *previous, void *data) {
	(void)previous;
	sc_track(run.s, &tracked);
	if (run.by_run) writes();
	return (sc_out){.kind = SC_VALUE, .value = op_ref(data)};
}
static char *set_nothing(void *value, void *data) {
	(void)value, (void)data;
	if (!run.by_run) writes();
	return NULL;
}
static char *set_fails(void *value, void *data) {
	(void)value, (void)data;
	if (!run.by_run) writes();
	return strdup("set failed");
}
static char *act_nothing(void *value, void *previous, void *data) {
	(void)value, (void)previous, (void)data;
	return NULL;
}
static const char *mode;
static void make_computer(void *data) {
	(void)data;
	if (strcmp(mode, "effect") == 0) sc_create_effect(run.s, (sc_def){.f = compute, .effect = act_nothing, .data = run.k}, NULL, 0);
	else if (strcmp(mode, "fails") == 0) sc_create_computer(run.s, (sc_def){.f = compute, .set = set_fails, .data = run.k}, NULL, 0);
	else sc_create_computer(run.s, (sc_def){.f = compute, .set = set_nothing, .data = run.k}, NULL, 0);
}
// k kept as a computation's result at its run's end: a scheduler wired by un_keeping, a computer
// returning k (mode: "compute", "fails": its set fails, "effect": an effect), a pulse
static void keep_through_scheduler(op_value *k, const char *how, const op_value *handed) {
	mode = how;
	sc_scheduler *s = sc_new((sc_options){.drop = drop});
	un_wiring *wired = un_keeping(s, unread, handed != NULL ? handed_by : NULL, (void *)handed);
	sc_pair info = {"actor", "test"};
	run.s = s, run.k = k;
	sc_run_with_scope(sc_create_root_scope(s, &info, 1), make_computer, NULL);
	sc_pulse(s);
	un_unwire(wired);
	sc_free(s);
}

static ch_header change(void) {
	return (ch_header){.has_time = 1, .time = 1, .actor = "test"};
}

static void keep(names *n, const char *name, op_value *value) {
	for (size_t i = 0; i < n->count; i++) {
		if (strcmp(n->items[i].name, name) != 0) continue;
		op_free(n->items[i].value);
		n->items[i].value = value;
		return;
	}
	if (n->count == n->capacity) {
		n->capacity = n->capacity ? 2 * n->capacity : 8;
		n->items = realloc(n->items, n->capacity * sizeof *n->items);
		if (n->items == NULL) abort();
	}
	n->items[n->count++] = (named){strdup(name), value};
}
static named *look(names *n, const char *name) {
	for (size_t i = 0; i < n->count; i++)
		if (strcmp(n->items[i].name, name) == 0) return &n->items[i];
	return NULL;
}
static void forget(names *n) {
	for (size_t i = 0; i < n->count; i++) free(n->items[i].name), op_free(n->items[i].value);
	free(n->items);
	*n = (names){0};
}

static void reset(void) {
	if (entry != NULL) nd_free_entry(entry);
	un_free(unread);
	op_undo_free(&spare);
	forget(&held);
	forget(&marked);
	entry = NULL;
}

void hh_start(void) {
	unread = un_new();
	entry = nd_make_entry(NULL, &(ch_header){.has_time = 1, .time = 1, .actor = "test"});
}

void hh_finish(void) {
	reset();
	unread = NULL;
}

// what is at a path of keys, NULL when nothing
static const op_value *at(const op_value *v, const op_value *path) {
	for (size_t i = 0; path != NULL && i < path->count; i++) {
		const op_value *k = path->items[i];
		if (v == NULL) return NULL;
		if (k->type == OP_NUM && v->type == OP_LIST && k->num >= 0 && (size_t)k->num < v->count) {
			v = v->items[(size_t)k->num];
		} else if (k->type == OP_STR && v->type == OP_MAP) {
			v = op_get(v, k->str);
		} else {
			return NULL;
		}
	}
	return v;
}

// as === has it: a number, string, boolean or null by content, any other value by identity
static int same(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL || a->type != b->type) return 0;
	switch (a->type) {
		case OP_NULL: return 1;
		case OP_BOOL: return a->bool_ == b->bool_;
		case OP_NUM: return op_same_num(a, b);
		case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
		default: return 0;
	}
}

static void put_value(FILE *out, const op_value *v) {
	if (v == NULL) {
		fputs("{}", out);
		return;
	}
	fputs("{\"value\":", out);
	op_json_write(out, v);
	putc('}', out);
}

// unread's update of the patches: the undo, or the error and the patch
static void write(FILE *out, const op_patch *patches, size_t n, const char *hold) {
	if (hold != NULL) {
		op_value *list = op_list();
		for (size_t i = 0; i < n; i++)
			if (patches[i].has_value) op_push(list, op_ref((op_value *)patches[i].value));
		keep(&held, hold, list);
	}
	size_t failed = 0;
	int code = un_update(unread, entry, patches, n, change(), &failed);
	if (code != OP_OK) {
		fprintf(out, "{\"error\":\"%s\",\"patch\":%zu}", op_code_name(code), failed);
		return;
	}
	fputs("{\"undo\":[", out);
	for (size_t i = 0; i < entry->undo.n; i++) {
		if (i) putc(',', out);
		hh_put_patch(out, &entry->undo.patches[i]);
	}
	fputs("]}", out);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	const char *hold = hh_str(r, "hold");
	if (op == NULL) {
		hh_unknown(out, r);
	} else if (strcmp(op, "start") == 0) {
		reset();
		unread = un_new();
		entry = nd_make_entry(op_get(r, "value"), &(ch_header){.has_time = 1, .time = 1, .actor = "test"});
		fputs("{}", out);
	} else if (strcmp(op, "write") == 0) {
		const op_value *list = op_get(r, "patches");
		if (list == NULL || list->type != OP_LIST) {
			hh_error(out, "write: patches is not a list");
			return;
		}
		size_t n = list->count;
		op_patch *patches = hh_take((n + 1) * sizeof *patches);
		for (size_t i = 0; i < n; i++) hh_patch(list->items[i], &patches[i]);
		// marked: patch i given what was marked under marked[i] (nothing: a removal)
		const op_value *names = op_get(r, "marked");
		for (size_t i = 0; names != NULL && names->type == OP_LIST && i < n && i < names->count; i++) {
			if (names->items[i]->type != OP_STR) continue;
			named *m = look(&marked, names->items[i]->str);
			patches[i].value = m != NULL ? m->value : NULL;
			patches[i].has_value = patches[i].value != NULL;
		}
		write(out, patches, n, hold);
	} else if (strcmp(op, "unwrite") == 0) {
		if (!entry->change.has_op) {
			fputs("{\"error\":\"nothing-written\"}", out);
			return;
		}
		// the undo is the next change's patches: the entry lets go of it, this keeps it alive
		op_undo undo = entry->undo;
		entry->undo = (op_undo){0};
		write(out, undo.patches, undo.n, hold);
		if (entry->change.patches == undo.patches) {
			op_undo_free(&spare);
			spare = undo;
		} else {
			entry->undo = undo;
		}
	} else if (strcmp(op, "read") == 0) {
		un_read(unread, entry);
		if (hold != NULL) keep(&held, hold, op_ref(entry->value));
		put_value(out, entry->value);
	} else if (strcmp(op, "keep") == 0) {
		const op_value *v = at(entry->value, op_get(r, "path"));
		op_value *k = op_ref((op_value *)v);
		const op_value *hd = op_get(r, "handed");
		int handed = hd != NULL && hd->type == OP_BOOL && hd->bool_;
		const op_value *wrap = op_get(r, "wrap"), *sched = op_get(r, "scheduler");
		const char *by = hh_str(r, "by");
		run.writes = op_get(r, "writes"), run.by_run = by != NULL && strcmp(by, "run") == 0;
		if (wrap != NULL && wrap->type == OP_BOOL && wrap->bool_) {
			// nothing there, in a list: null, as the line has it
			op_value *list = op_list();
			op_push(list, k != NULL ? k : op_null());
			k = list;
		}
		if (sched != NULL && sched->type == OP_BOOL && sched->bool_) keep_through_scheduler(k, "compute", handed ? v : NULL);
		else if (sched != NULL && sched->type == OP_STR) keep_through_scheduler(k, sched->str, handed ? v : NULL);
		else un_kept(unread, k, handed ? &v : NULL, handed ? 1 : 0);
		run.writes = NULL, run.by_run = 0;
		if (hold != NULL) keep(&held, hold, k);
		else op_free(k);
		fputs("{}", out);
	} else if (strcmp(op, "held") == 0) {
		const char *name = hh_str(r, "name");
		named *h = name ? look(&held, name) : NULL;
		put_value(out, h ? h->value : NULL);
	} else if (strcmp(op, "value") == 0) {
		put_value(out, entry->value);
	} else if (strcmp(op, "mark") == 0) {
		const char *name = hh_str(r, "name");
		if (name == NULL) hh_error(out, "mark: no name");
		else {
			keep(&marked, name, op_ref((op_value *)at(entry->value, op_get(r, "path"))));
			fputs("{}", out);
		}
	} else if (strcmp(op, "same") == 0) {
		const char *name = hh_str(r, "name");
		named *m = name ? look(&marked, name) : NULL;
		fprintf(out, "{\"same\":%s}", same(m ? m->value : NULL, at(entry->value, op_get(r, "path"))) ? "true" : "false");
	} else {
		hh_unknown(out, r);
	}
}
