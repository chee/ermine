// patches, change headers and nodes on the line protocol (protocol.h)
#include "protocol.h"

#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// --- patches ---

// a patch place; anything malformed is one no patch can be: a negative key (not-a-patch)
static const op_key bad_key = {.type = OP_NUM_KEY, .n = -1};
static int whole(const op_value *x, long *out) {
	if (x->type != OP_NUM || !isfinite(x->num) || x->num != floor(x->num) || x->num < -1e15) return 0;
	// past what a long holds: the largest, which no list or string reaches
	*out = x->num > 1e15 ? LONG_MAX : (long)x->num;
	return 1;
}
static void place_of(const op_value *m, op_target *p) {
	memset(p, 0, sizeof *p);
	const op_value *path = m && m->type == OP_MAP ? op_get(m, "path") : NULL;
	if (path == NULL || path->type != OP_LIST) goto bad;
	op_key *ks = hh_take((path->count + 1) * sizeof *ks);
	for (size_t i = 0; i < path->count; i++) {
		const op_value *x = path->items[i];
		ks[i] = (op_key){0};
		if (x->type == OP_STR) ks[i] = (op_key){.type = OP_STR_KEY, .s = x->str};
		else if (x->type == OP_NUM && whole(x, &ks[i].n)) ks[i].type = OP_NUM_KEY;
		else goto bad;
	}
	p->path = ks;
	p->length = path->count;
	const op_value *r = op_get(m, "range");
	if (r != NULL) {
		if (r->type != OP_LIST || r->count != 2 || !whole(r->items[0], &p->from) ||
				!whole(r->items[1], &p->to)) goto bad;
		p->has_range = 1;
	}
	return;
bad:
	memset(p, 0, sizeof *p);
	p->path = &bad_key;
	p->length = 1;
}

void hh_patch(const op_value *m, op_patch *out) {
	memset(out, 0, sizeof *out);
	place_of(m, &out->place);
	if (m->type != OP_MAP) return;
	out->value = op_get(m, "value");
	out->has_value = out->value != NULL;
	const op_value *mv = op_get(m, "move");
	if (mv != NULL) {
		out->has_move = 1;
		place_of(mv, &out->move);
	}
}

// --- headers ---

static long whole_of(const op_value *x) { return x && x->type == OP_NUM ? (long)x->num : 0; }
static ch_site site_of(const op_value *p) {
	const op_value *column = op_get(p, "column"), *function = op_get(p, "function");
	const char *file = hh_str(p, "file");
	return (ch_site){
		file ? file : "",
		whole_of(op_get(p, "line")),
		whole_of(column),
		function && function->type == OP_STR ? function->str : NULL,
		column != NULL,
	};
}

ch_header hh_header(const op_value *p) {
	ch_header h = {0};
	const op_value *time = op_get(p, "time"), *actor = op_get(p, "actor"),
		       *at = op_get(p, "external"), *meta = op_get(p, "metadata");
	if (time) h.has_time = 1, h.time = (int64_t)time->num;
	h.actor = actor;
	h.reader = hh_str(p, "reader");
	if (at && at->type == OP_LIST) {
		ch_site *ss = hh_take((at->count ? at->count : 1) * sizeof *ss);
		for (size_t i = 0; i < at->count; i++) ss[i] = site_of(at->items[i]);
		h.external = ss;
		h.external_length = at->count;
	}
	if (meta && meta->type == OP_LIST) {
		ch_entry *es = hh_take((meta->count ? meta->count : 1) * sizeof *es);
		for (size_t i = 0; i < meta->count; i++) {
			const op_value *kv = meta->items[i];
			if (kv->type != OP_LIST || kv->count != 2 || kv->items[0]->type != OP_STR) {
				hh_fail("bad metadata entry");
			}
			es[i] = (ch_entry){kv->items[0]->str, kv->items[1]};
		}
		h.metadata = es;
		h.metadata_length = meta->count;
	}
	return h;
}

nd_node *hh_node(const op_value *p) {
	const op_value *given = op_get(p, "header");
	ch_header h = given ? hh_header(given) : (ch_header){0};
	nd_node *n = nd_make((op_value *)op_get(p, "value"), &h, NULL);
	if (n == NULL) hh_fail("out of memory");
	return n;
}

// --- writing ---

static void put_target(FILE *out, const op_target *t) {
	fputs("\"path\":[", out);
	for (size_t i = 0; i < t->length; i++) {
		if (i) putc(',', out);
		if (t->path[i].type == OP_STR_KEY) op_json_string(out, t->path[i].s);
		else fprintf(out, "%ld", t->path[i].n);
	}
	putc(']', out);
	if (t->has_range) fprintf(out, ",\"range\":[%ld,%ld]", t->from, t->to);
}

void hh_put_patch(FILE *out, const op_patch *p) {
	putc('{', out);
	put_target(out, &p->place);
	if (p->has_value) {
		fputs(",\"value\":", out);
		op_json_write(out, p->value);
	}
	if (p->has_move) {
		fputs(",\"move\":{", out);
		put_target(out, &p->move);
		putc('}', out);
	}
	putc('}', out);
}

static void put_patches(FILE *out, const op_patch *ps, size_t n) {
	putc('[', out);
	for (size_t i = 0; i < n; i++) {
		if (i) putc(',', out);
		hh_put_patch(out, &ps[i]);
	}
	putc(']', out);
}

void hh_put_header(FILE *out, const ch_header *h) {
	const char *comma = "";
	putc('{', out);
	if (h->has_time) fprintf(out, "\"time\":%lld", (long long)h->time), comma = ",";
	if (h->actor) {
		fprintf(out, "%s\"actor\":", comma);
		op_json_write(out, h->actor);
		comma = ",";
	}
	if (h->reader) fprintf(out, "%s\"reader\":", comma), op_json_string(out, h->reader), comma = ",";
	if (h->external) {
		fprintf(out, "%s\"external\":[", comma);
		for (size_t i = 0; i < h->external_length; i++) {
			const ch_site *s = &h->external[i];
			if (i) putc(',', out);
			fputs("{\"file\":", out);
			op_json_string(out, s->file ? s->file : "");
			fprintf(out, ",\"line\":%ld", s->line);
			if (s->has_column) fprintf(out, ",\"column\":%ld", s->column);
			if (s->function) fputs(",\"function\":", out), op_json_string(out, s->function);
			putc('}', out);
		}
		putc(']', out);
		comma = ",";
	}
	if (h->metadata) {
		fprintf(out, "%s\"metadata\":[", comma);
		for (size_t i = 0; i < h->metadata_length; i++) {
			if (i) putc(',', out);
			putc('[', out);
			op_json_string(out, h->metadata[i].key);
			putc(',', out);
			op_json_write(out, h->metadata[i].value);
			putc(']', out);
		}
		putc(']', out);
		comma = ",";
	}
	if (h->has_op) {
		fprintf(out, "%s\"op\":{\"patches\":", comma);
		put_patches(out, h->patches, h->patches_length);
		fputs(",\"undo\":", out);
		put_patches(out, h->undo, h->undo_length);
		putc('}', out);
	}
	putc('}', out);
}

void hh_put_node(FILE *out, const nd_node *n) {
	putc('{', out);
	if (n->value) {
		fputs("\"value\":", out);
		op_json_write(out, n->value);
		putc(',', out);
	}
	fputs("\"change\":", out);
	hh_put_header(out, &n->change);
	putc('}', out);
}
