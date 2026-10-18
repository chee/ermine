// lab-pig's format (playground/demos/slaygrounds/examples/lab-pig/program.ts), for a device that
// reads and writes it: what a pig's value and a carried pig look like. Plain functions on op_values.
#ifndef LS_PIGS_H
#define LS_PIGS_H

#include "../../../../core/op/c/value.h"

#include <stdint.h>

// a pig's stored value: {x, y, at, seed, shame?, binned?}
typedef struct {
	double x, y;
	double at; // ms since 1970 (the setter's clock)
	uint32_t seed;
	int shame, binned;
} ls_pig;
// a carried pig: {x, y, held: true, by, colour, who}
typedef struct {
	double x, y;
	char by[32], colour[16], who[80];
} ls_pig_held;

// whether the text is ermine://<64 lowercase hex>
int ls_pig_id(const char *key);
// a pig's value with lab-pig's defaults (missing x, y: 0.5; at: 0; seed: FNV-1a of id). v may be NULL
void ls_pig_read(const op_value *v, const char *id, ls_pig *out);
op_value *ls_pig_make(const ls_pig *pig);
// 1 when v is a carried pig (held: true), read into out
int ls_pig_held_read(const op_value *v, ls_pig_held *out);
op_value *ls_pig_make_held(double x, double y, const char *by, const char *colour, const char *who);
// whether the room (its value, NULL: none) has the pig: LS_FIRST unless it says false, any other
// when it says true
int ls_room_has(const op_value *room, const char *id);
// a room's pig ids in order: how many keys of the room's value are pigs, and the i'th such key
size_t ls_room_pigs(const op_value *room);
const char *ls_room_pig(const op_value *room, size_t i);

#endif
