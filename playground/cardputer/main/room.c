// the room driver (room.h)
#include "room.h"

#include "pigs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "core/op/c/json.h"

#define MAX 32

static ls_dev *dev;
// the nodes followed: the room first, then pigs. the version last put in the graph
static struct {
	ls_node *node;
	char path[24];
	uint32_t seen;
	int mirrored;
} followed[MAX];
static int nfollowed;
static const ls_node *last;

const ls_node *room_last(void) { return last; }

void room_device(ls_dev *d) { dev = d; }

static int same(const op_value *a, const op_value *b) {
	if (a == b) return 1;
	if (a == NULL || b == NULL) return 0;
	char *x = op_json_text(a), *y = op_json_text(b);
	int is = x && y && strcmp(x, y) == 0;
	free(x), free(y);
	return is;
}

static void follow(const char *id) {
	if (ls_find(dev, id)) {
		for (int i = 0; i < nfollowed; i++)
			if (followed[i].node == ls_find(dev, id)) return;
	}
	if (nfollowed == MAX) return;
	ls_node *n = ls_follow(dev, id);
	if (n == NULL) return;
	followed[nfollowed].node = n;
	if (strcmp(id, PIGS_ROOM) == 0) snprintf(followed[nfollowed].path, sizeof followed[0].path, "/pigs/room");
	// "ermine:", the code (4 hex), then the hex: the first 8 after the code name it (pigs.c's pig_name)
	else snprintf(followed[nfollowed].path, sizeof followed[0].path, "/pigs/%.8s", id + 11);
	nfollowed++;
}

// the value at path made, or set: when the graph does not have it already
static void put(es_context *c, const char *path, const op_value *v) {
	const op_value *there = NULL;
	es_read(c, es_on_path(es_text(path)), NULL, 0, &there);
	if (same(there, v)) return;
	op_value *value = v ? op_ref((op_value *)v) : op_null();
	if (there == NULL) {
		es_handle *n;
		es_ensure_node(c, es_text(path), value, &n);
	} else {
		op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = value};
		es_patch(c, es_on_path(es_text(path)), &p, 1);
	}
	op_free(value);
}

// the others' pointers at the room (their presence rows, littlesync's: web pigs' and devices'), as web
// pigs' /pointers: [{who, name, colour, x, y, ...}], what else a row says kept, x and y 0 to 1
static op_value *pointers(const ls_node *room) {
	op_value *out = op_list();
	for (size_t i = 0, k = ls_rows(room); i < k; i++) {
		const ls_row *r = ls_row_at(room, i);
		const op_value *v = r->value, *p = v->type == OP_MAP ? op_get(v, "pointer") : NULL;
		if (r->own || p == NULL || p->type != OP_MAP) continue;
		op_value *o = op_map();
		for (size_t j = 0; j < v->count; j++)
			if (strcmp(v->keys[j], "pointer") != 0) op_set(o, v->keys[j], op_ref(v->items[j]));
		char who[2 * LS_KEY_LEN + 1];
		for (size_t j = 0; j < r->who_length; j++) snprintf(who + 2 * j, 3, "%02x", r->who[j]);
		op_set(o, "who", op_str(who));
		const char *xy[] = {"x", "y"};
		for (int j = 0; j < 2; j++) {
			const op_value *n = op_get(p, xy[j]);
			double d = n && n->type == OP_NUM && n->num == n->num ? n->num : 0.5;
			op_set(o, xy[j], op_num(d < 0 ? 0 : d > 1 ? 1 : d));
		}
		op_push(out, o);
	}
	return out;
}

static int mirror(void *data) {
	es_context *c = data;
	if (dev == NULL) return 0;
	// the room's pigs followed: each placed in its children
	const op_value *room = ls_children(followed[0].node);
	for (size_t i = 0; i < pig_room_count(room); i++) follow(pig_room_at(room, i));
	for (int i = 0; i < nfollowed; i++) {
		ls_node *n = followed[i].node;
		if (followed[i].mirrored && ls_version(n) == followed[i].seen) continue;
		followed[i].seen = ls_version(n), followed[i].mirrored = 1;
		put(c, followed[i].path, ls_value(n));
		if (i == 0) {
			op_value *ps = pointers(n);
			put(c, "/pigs/room/pointers", ps);
			op_free(ps);
			continue;
		}
		last = n;
		char held[40];
		snprintf(held, sizeof held, "%s/held", followed[i].path);
		const op_value *h = NULL;
		for (size_t k = 0; k < ls_helds(n) && h == NULL; k++) h = ls_held_at(n, k)->value;
		put(c, held, h);
		// a clash (two devices dropped it at once): the other drop, the pig drawn again
		ls_item items[2];
		snprintf(held, sizeof held, "%s/also", followed[i].path);
		put(c, held, ls_values(n, NULL, 0, items, 2) > 1 ? items[1].value : NULL);
	}
	return 0;
}

// outside a run: with the room's process open
void room_mirror(es_context *c) { es_within(c, mirror, c); }

// graph to littlesync: each followed node's value in the graph, tracked; acted on when littlesync
// does not have it
static es_out values(es_context *c, void *ctx, const op_value *previous) {
	(void)previous, (void)ctx;
	op_value *out = op_list();
	for (int i = 0; i < nfollowed; i++) {
		const op_value *v = NULL;
		if (es_read(c, es_on_path(es_text(followed[i].path)), NULL, 0, &v) == ES_PENDING)
			return op_free(out), es_out_pending();
		op_push(out, v ? op_ref((op_value *)v) : op_null());
	}
	return es_out_of(out);
}

static int push(es_context *c, void *ctx, const op_value *value, const op_value *before) {
	(void)c, (void)before, (void)ctx;
	for (size_t i = 0; value && i < value->count && i < (size_t)nfollowed; i++) {
		const op_value *v = value->items[i];
		if (v->type == OP_NULL || same(v, ls_value(followed[i].node))) continue;
		// a person's edit: this is the value, every item replaced (a clash ends)
		ls_pick(followed[i].node, v);
	}
	return 0;
}

es_out room(es_context *c, void *ctx) {
	(void)ctx;
	if (dev == NULL) return es_out_of(NULL);
	follow(PIGS_ROOM);
	room_mirror(c);
	es_handle *n;
	int code = es_create_effect(c, es_text("push"), values, push, NULL, NULL, &n);
	return code ? es_out_code(code) : es_out_of(NULL);
}
