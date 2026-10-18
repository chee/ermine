// lab-pig's format (playground/demos/slaygrounds/examples/lab-pig/program.ts), for a littlesync device
// (extensions/together/stacks/littlesync) that reads and writes it: the room, what a pig's value and a
// carried pig look like. Plain functions on op_values.
#ifndef PIGS_H
#define PIGS_H

#include "../../../../core/op/c/value.h"

#include <stddef.h>
#include <stdint.h>

// the default room, and the first pig (lab-pig's), ids as the graph has them
#define PIGS_ROOM "ermine://bf04115f9b284145026eab6801219d6e" "00000000000000000000000000000000"
#define PIGS_FIRST "ermine://d3b583537595c9a6de0110781d4566d1" "00000000000000000000000000000000"

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

// whether the text is ermine://<64 lowercase hex>
int pig_id(const char *key);
// a pig's value with lab-pig's defaults (missing x, y: 0.5; at: 0; seed: FNV-1a of id). v may be NULL
void pig_read(const op_value *v, const char *id, pig_value *out);
op_value *pig_make(const pig_value *p);
// 1 when v is a carried pig (held: true), read into out
int pig_held_read(const op_value *v, pig_held *out);
op_value *pig_make_held(double x, double y, const char *by, const char *colour, const char *who);
// whether the room (its value, NULL: none) has the pig: PIGS_FIRST unless it says false, any other
// when it says true
int pig_room_has(const op_value *room, const char *id);
// a room's pig ids in order: how many keys of the room's value are pigs, and the i'th such key
size_t pig_room_count(const op_value *room);
const char *pig_room_at(const op_value *room, size_t i);

#endif
