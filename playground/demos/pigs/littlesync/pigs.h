// lab-pig's format (playground/demos/slaygrounds/examples/lab-pig/program.ts), for a littlesync device
// (playground/together/stacks/littlesync) that reads and writes it: the room, what a pig's value and a
// carried pig look like. Plain functions on op_values.
#ifndef PIGS_H
#define PIGS_H

#include "../../../../core/changeable/c/value.h"

#include <stddef.h>
#include <stdint.h>

// the default room, as the graph has it
#define PIGS_ROOM "ermine:0010bf04115f9b284145026eab6801219d6e"
// a pig's name in the room: "pig-", the first 8 hex of its id after the code, and the 0
#define PIGS_NAME 13

// a pig's stored value: {x, y, at, seed, shame?, binned?}
typedef struct {
	double x, y;
	double at; // ms since 1970 (the setter's clock)
	uint32_t seed;
	int shame, binned;
} pig_value;
// a carried pig: {x, y, held: true, by, colour, who}
typedef struct {
	double x, y;
	char by[32], colour[16], who[80];
} pig_held;

// whether the text is an ermine id: "ermine:" and lowercase hex, its code saying its length (ermine/ids)
int pig_id(const char *key);
// a pig's value with lab-pig's defaults (missing x, y: 0.5; at: 0; seed: FNV-1a of id). v may be NULL
void pig_read(const op_value *v, const char *id, pig_value *out);
op_value *pig_make(const pig_value *p);
// 1 when v is a carried pig (held: true), read into out
int pig_held_read(const op_value *v, pig_held *out);
op_value *pig_make_held(double x, double y, const char *by, const char *colour, const char *who);
// the room is its children (ls_children; NULL: none): {pig-<its id's 8 hex after the code>: pig id}, each pig in the
// room placed there; added: placed (pig_name), binned: unplaced. A name not holding a pig id is ignored.
// pig_name: the name a pig is placed under
void pig_name(const char *id, char out[PIGS_NAME]);
// the name holding the pig in the room; NULL: not in it
const char *pig_room_name(const op_value *room, const char *id);
int pig_room_has(const op_value *room, const char *id);
// the room's pigs in order: how many names hold a pig id, and the i'th such id
size_t pig_room_count(const op_value *room);
const char *pig_room_at(const op_value *room, size_t i);

#endif
