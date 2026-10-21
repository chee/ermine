// lab-pig's format (pigs.h)
#include "pigs.h"

#include "../../../../playground/together/stacks/littlesync/littlesync.h"

#include <stdio.h>
#include <string.h>

int pig_id(const char *k) {
	size_t n = strlen(k);
	if (strncmp(k, "ermine:", 7) != 0 || (n != 7 + 36 && n != 7 + 68)) return 0;
	for (const char *p = k + 7; *p; p++)
		if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return 0;
	// its code says its length: 00 10 or 1e 10 and 16 bytes, ed 01 and 32
	if (n == 7 + 68) return strncmp(k + 7, "ed01", 4) == 0;
	return strncmp(k + 7, "0010", 4) == 0 || strncmp(k + 7, "1e10", 4) == 0;
}

static double number(const op_value *map, const char *key, double fallback) {
	const op_value *v = map != NULL && map->type == OP_MAP ? op_get(map, key) : NULL;
	return v != NULL && v->type == OP_NUM ? v->num : fallback;
}
static int flag(const op_value *map, const char *key) {
	const op_value *v = map != NULL && map->type == OP_MAP ? op_get(map, key) : NULL;
	return v != NULL && v->type == OP_BOOL && v->bool_;
}

void pig_read(const op_value *v, const char *id, pig_value *out) {
	out->x = number(v, "x", 0.5);
	out->y = number(v, "y", 0.5);
	out->at = number(v, "at", 0);
	double seed = number(v, "seed", -1);
	if (seed < 0) {
		uint32_t h = 2166136261u;
		for (const char *c = id; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
		out->seed = h;
	} else out->seed = (uint32_t)(uint64_t)seed;
	out->shame = flag(v, "shame");
	out->binned = flag(v, "binned");
}

op_value *pig_make(const pig_value *p) {
	op_value *m = op_map();
	op_set(m, "x", op_num(p->x));
	op_set(m, "y", op_num(p->y));
	op_set(m, "at", op_num(p->at));
	op_set(m, "seed", op_num((double)p->seed));
	if (p->shame) op_set(m, "shame", op_bool(1));
	if (p->binned) op_set(m, "binned", op_bool(1));
	return m;
}

static void text(const op_value *map, const char *key, char *out, size_t size) {
	const op_value *v = op_get(map, key);
	out[0] = 0;
	if (v != NULL && v->type == OP_STR) {
		strncpy(out, v->str, size - 1);
		out[size - 1] = 0;
	}
}

int pig_held_read(const op_value *v, pig_held *out) {
	if (v == NULL || v->type != OP_MAP || !flag(v, "held")) return 0;
	out->x = number(v, "x", 0.5);
	out->y = number(v, "y", 0.5);
	text(v, "by", out->by, sizeof out->by);
	text(v, "colour", out->colour, sizeof out->colour);
	text(v, "who", out->who, sizeof out->who);
	return 1;
}

op_value *pig_make_held(double x, double y, const char *by, const char *colour, const char *who) {
	op_value *m = op_map();
	op_set(m, "x", op_num(x));
	op_set(m, "y", op_num(y));
	op_set(m, "held", op_bool(1));
	op_set(m, "by", op_str(by));
	op_set(m, "colour", op_str(colour));
	op_set(m, "who", op_str(who));
	return m;
}

void pig_name(const char *id, char out[PIGS_NAME]) { snprintf(out, PIGS_NAME, "pig-%.8s", id + 11); }

// the i'th pig id among the room's names, or the name holding id (id given): its index into room
static long room_find(const op_value *room, const char *id, size_t i) {
	if (room == NULL || room->type != OP_MAP) return -1;
	for (size_t k = 0; k < room->count; k++) {
		const op_value *v = room->items[k];
		if (v->type != OP_STR || !pig_id(v->str)) continue;
		if (id != NULL ? strcmp(v->str, id) == 0 : i-- == 0) return (long)k;
	}
	return -1;
}

const char *pig_room_name(const op_value *room, const char *id) {
	long k = room_find(room, id, 0);
	return k < 0 ? NULL : room->keys[k];
}

int pig_room_has(const op_value *room, const char *id) { return room_find(room, id, 0) >= 0; }

size_t pig_room_count(const op_value *room) {
	size_t n = 0;
	while (room_find(room, NULL, n) >= 0) n++;
	return n;
}

const char *pig_room_at(const op_value *room, size_t i) {
	long k = room_find(room, NULL, i);
	return k < 0 ? NULL : room->items[k]->str;
}
