// patches, change headers, entries and nodes on the line protocol (protocol_harness.h)
#include "protocol_harness.h"

#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>


static const op_key bad_key = {.type = OP_NUM_KEY, .n = -1};
static int whole(const op_value *x, int64_t *out) {
	if (x->type != OP_NUM || !isfinite(x->num) || x->num != floor(x->num) || x->num < -1e15) return 0;
	*out = x->num > 1e15 ? INT64_MAX : (int64_t)x->num;
	return 1;
}
static int index_of(const op_value *x, long *out) {
	int64_t n;
	if (!whole(x, &n)) return 0;
	*out = n > LONG_MAX ? LONG_MAX : n < LONG_MIN ? LONG_MIN : (long)n;
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
		else if (x->type == OP_NUM && index_of(x, &ks[i].n)) ks[i].type = OP_NUM_KEY;
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


const char *hh_bad_header(const op_value *header) {
	const op_value *frame = header && header->type == OP_MAP ? op_get(header, "frame") : NULL;
	if (frame == NULL) return NULL;
	if (frame->type != OP_LIST || frame->count == 0) return "frame is not a list of objects";
	for (size_t i = 0; i < frame->count; i++) {
		if (frame->items[i]->type != OP_MAP) return "frame is not a list of objects";
	}
	return NULL;
}

static ch_frame *frame_of(const op_value *list) {
	ch_frame *up = NULL;
	for (size_t i = list->count; i > 0; i--) {
		const op_value *info = list->items[i - 1];
		ch_pair *pairs = hh_take((info->count ? info->count : 1) * sizeof *pairs);
		for (size_t k = 0; k < info->count; k++) pairs[k] = (ch_pair){info->keys[k], info->items[k]};
		ch_frame *f = ch_frame_make(pairs, info->count, up);
		ch_frame_free(up);
		up = f;
	}
	return up;
}

ch_header hh_header(const op_value *p) {
	ch_header h = {0};
	const op_value *time = op_get(p, "time"), *actor = op_get(p, "actor"), *frame = op_get(p, "frame");
	if (time) h.has_time = 1, h.time = (int64_t)time->num;
	h.actor = actor;
	h.reader = hh_str(p, "reader");
	if (frame) h.frame = frame_of(frame);
	return h;
}

nd_entry *hh_entry(const op_value *p) {
	const op_value *given = op_get(p, "header");
	ch_header h = given ? hh_header(given) : (ch_header){0};
	nd_entry *e = nd_make_entry((op_value *)op_get(p, "value"), &h);
	if (e == NULL) hh_fail("out of memory");
	ch_frame_free(h.frame);
	return e;
}


static void put_target(FILE *out, const op_target *t) {
	fputs("\"path\":[", out);
	for (size_t i = 0; i < t->length; i++) {
		if (i) putc(',', out);
		if (t->path[i].type == OP_STR_KEY) op_json_string(out, t->path[i].s);
		else fprintf(out, "%ld", t->path[i].n);
	}
	putc(']', out);
	if (t->has_range) fprintf(out, ",\"range\":[%lld,%lld]", (long long)t->from, (long long)t->to);
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
	if (h->frame) {
		fprintf(out, "%s\"frame\":[", comma);
		for (const ch_frame *f = h->frame; f != NULL; f = f->parent) {
			if (f != h->frame) putc(',', out);
			putc('{', out);
			for (size_t i = 0; i < f->n; i++) {
				if (i) putc(',', out);
				op_json_string(out, f->pairs[i].key);
				putc(':', out);
				op_json_write(out, f->pairs[i].value);
			}
			putc('}', out);
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

void hh_put_entry(FILE *out, const nd_entry *e) {
	putc('{', out);
	if (e->value) {
		fputs("\"value\":", out);
		op_json_write(out, e->value);
		putc(',', out);
	}
	fputs("\"change\":", out);
	hh_put_header(out, &e->change);
	putc('}', out);
}

void hh_put_node(FILE *out, const nd_node *n) {
	putc('{', out);
	for (size_t i = 0; i < n->length; i++) {
		if (i) putc(',', out);
		op_json_string(out, n->slots[i].table);
		putc(':', out);
		hh_put_entry(out, n->slots[i].entry);
	}
	putc('}', out);
}
