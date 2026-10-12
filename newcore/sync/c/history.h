// The blops of one node, each object's in a history of its own, and which are its heads
// (newcore/sync/HISTORY.tex), in C. Same shape as history.ts: blops already unsealed, no bytes, no
// signatures; patches only checked, through the check given (apply.h's).
//
// A blop is a json.h value (encoding/c/blop.h), its byte fields JSON_BYTES. Memory: a blop given
// to history_add is held here (jsonRef), never changed. With no loader every one is held as long as
// the histories; with one, only the waiting and the heads: another asked for (history_get) is loaded
// again, and one no longer needed is let go at the next history_trim, so what was given out stays
// good until then. Rows and lists given back are the caller's: history_rows_free.
#ifndef HISTORY_H
#define HISTORY_H

#include "../../encoding/c/json.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct histories histories;

// step 7's: whether the blop's patches apply to its base's side
typedef bool (*history_check)(void *context, histories *c, const Json *blop);

typedef enum {
	HISTORY_TAKEN,
	HISTORY_PASSED,
	HISTORY_WAITING, // names: the parents not taken in
	HISTORY_STUCK,   // names: the parents refused or stuck
	HISTORY_REFUSED, // refusal
} history_kind;

typedef enum {
	HISTORY_NODE = 1,
	HISTORY_HISTORY,
	HISTORY_LAMPORT,
	HISTORY_PATCHES,
} history_refusal;
// "node", "history", "lamport", "patches"
const char *history_refusal_name(history_refusal refusal);

// what add answers, and a row of waiting or refused. name: the row's blop (not set by add)
typedef struct {
	uint8_t name[32];
	history_kind kind;
	history_refusal refusal;
	uint8_t (*names)[32];
	size_t count;
} history_row;

typedef struct {
	uint8_t name[32];
	const Json *blop;
} history_head;

// the histories of one node, empty
histories *history_create(const char *node, history_check check, void *context);
// what history_free calls with each slot (history_slot) the caller set, to let it go; none by default
void history_release(histories *c, void (*release)(void *slot));
void history_free(histories *c);
// load: a blop taken in, by its name, decoded again (the histories hold what it gives back)
void history_loader(histories *c, Json *(*load)(void *context, const uint8_t name[32]), void *context);
// lets go of the blops no longer needed; called when nothing given out is held
void history_trim(histories *c);
// the steps of HISTORY.tex, Adding; names: free with history_row_free
history_row history_add(histories *c, const Json *blop, const uint8_t name[32]);
// the history's heads in the agreed order; none: NULL, 0. object: "value" or ["info", name]...
size_t history_heads(histories *c, const Json *object, history_head **out);
// a blop taken in, or NULL
const Json *history_get(histories *c, const uint8_t name[32]);
// sorted by name
size_t history_waiting(histories *c, history_row **out);
size_t history_refused(histories *c, history_row **out);
void history_row_free(history_row *row);
void history_rows_free(history_row *rows, size_t count);
// the caller's own pointer for a blop taken in, NULL at first; NULL when not taken in
void **history_slot(histories *c, const uint8_t name[32]);

#endif
