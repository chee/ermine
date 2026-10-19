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
	// "ermine://" then the hex: the first 8 name it
	else snprintf(followed[nfollowed].path, sizeof followed[0].path, "/pigs/%.8s", id + 9);
	nfollowed++;
}

// the value at path made, or set: when the graph does not have it already
static void put(api *a, const char *path, const op_value *v) {
	const op_value *there = NULL;
	api_read(a, api_at(path), NULL, 0, &there);
	if (same(there, v)) return;
	op_value *value = v ? op_ref((op_value *)v) : op_null();
	if (there == NULL) {
		api_node n;
		if (api_open(a, path, value, &n) == API_OK) api_node_free(&n);
	} else {
		op_patch p = {.place = {NULL, 0}, .has_value = 1, .value = value};
		api_edit(a, api_at(path), &p, 1);
	}
	op_free(value);
}

void room_mirror(api *a) {
	if (dev == NULL) return;
	// the room's pigs followed: the first unless the room says no, any it says yes to
	const op_value *room = ls_value(followed[0].node);
	if (pig_room_has(room, PIGS_FIRST)) follow(PIGS_FIRST);
	for (size_t i = 0; i < pig_room_count(room); i++) {
		const char *id = pig_room_at(room, i);
		if (pig_room_has(room, id)) follow(id);
	}
	for (int i = 0; i < nfollowed; i++) {
		ls_node *n = followed[i].node;
		if (followed[i].mirrored && ls_version(n) == followed[i].seen) continue;
		followed[i].seen = ls_version(n), followed[i].mirrored = 1;
		put(a, followed[i].path, ls_value(n));
		if (i == 0) continue;
		last = n;
		char held[40];
		snprintf(held, sizeof held, "%s/held", followed[i].path);
		const op_value *h = NULL;
		for (size_t k = 0; k < ls_helds(n) && h == NULL; k++) h = ls_held_at(n, k)->value;
		put(a, held, h);
	}
}

// graph to littlesync: each followed node's value in the graph, tracked; acted on when littlesync
// does not have it
static sc_out values(api *a, const op_value *previous, void *ctx) {
	(void)previous, (void)ctx;
	op_value *out = op_list();
	for (int i = 0; i < nfollowed; i++) {
		const op_value *v = NULL;
		if (api_read(a, api_at(followed[i].path), NULL, 0, &v) == API_PENDING)
			return op_free(out), (sc_out){.kind = SC_PENDING};
		op_push(out, v ? op_ref((op_value *)v) : op_null());
	}
	return (sc_out){.kind = SC_VALUE, .value = out};
}

static void push(api *a, const op_value *value, const op_value *before, void *ctx) {
	(void)a, (void)before, (void)ctx;
	for (size_t i = 0; value && i < value->count && i < (size_t)nfollowed; i++) {
		const op_value *v = value->items[i];
		if (v->type == OP_NULL || same(v, ls_value(followed[i].node))) continue;
		ls_put(followed[i].node, v);
	}
}

int room(api *a) {
	if (dev == NULL) return API_OK;
	follow(PIGS_ROOM);
	room_mirror(a);
	api_node n;
	int code = api_effect(a, "push", values, push, NULL, NULL, &n);
	if (code == API_OK) api_node_free(&n);
	return code;
}
