// A computer's status on its own node, in C (typescript/status.ts), in a table of its own.
// C has no Error or Symbol: pending is the string "ermine.pending" and an error is {"name": "Error",
// "message": text} (value.h). If cst_setup.write is given, patches and header are borrowed for the
// call and no nodes are kept; otherwise nodes made here are freed at cst_free, after the table.
#ifndef PLACES_STATUS_H
#define PLACES_STATUS_H

#include "../../places/c/places.h"

typedef struct cst cst;

typedef void (*cst_write_fn)(void *ctx, const char *part, tb_key id, const op_patch *patches,
	size_t n, const ch_header *header);

typedef struct {
	pl *places;
	tb_table *table;
	sc_scheduler *scheduler;
	cst_write_fn write;
	void *write_ctx;
} cst_setup;

#define CST_TABLE "status"
#define CST_ATTRIBUTE "ermine.computer.status"

cst *cst_new(const cst_setup *setup);
void cst_give(cst *s, sc_computer *c, tb_key id);
void cst_stop(cst *s);
void cst_free(cst *s);

const op_value *cst_status(pl *p, tb_key id);
int cst_pending(pl *p, tb_key id);
op_value *cst_pending_value(void);
int cst_is_pending(const op_value *status);
const char *cst_error(const op_value *status);

#endif
