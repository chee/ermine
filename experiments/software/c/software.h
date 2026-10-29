// software (software.ts), in C: run a program through a loader. a program is a node: its value is
// the code. a loader is an action (es_create_action) that, called with (program, at), starts a
// process at `at` whose setup is what the loader made of the code. the process is started inside
// the loader's action, so it belongs to the scope that placed the loader: end that, and what the
// loader ran goes with it. finding a loader is not software's: run is handed one.
//
//   static sw_loader mine = {.load = load, .ctx = NULL};
//   sw_place_loader(c, es_text("/loaders/mine"), &mine, NULL);
//   op_value *r;  sw_run(c, es_text("/loaders/mine"), es_text("/apps/a"), es_text("/work/a"), &r);
//   // r: {"id", "at": [names]} or {"refused": "taken", "at"}; sw_stop(c, r, NULL) stops it
#ifndef SOFTWARE_H
#define SOFTWARE_H

#include "../../../system/c/ermine.h"

// on a program's node, written by whoever placed it: what it needs to run
#define SW_NEEDS "love.ermine.software.needs"
// on a loader's node, written by whoever placed it: what it provides
#define SW_PROVIDES "love.ermine.software.provides"

// the setup a loader made of the code: run once, as the process; what it gives is the process's value
typedef struct {
	es_program fn;
	void *ctx;
} sw_setup;

// a loader: code in, setup out; or a refusal (es_fail_text, and its code returned): the caller gets
// the error and nothing starts. the caller owns it, and keeps it as long as the loader is placed
typedef struct {
	int (*load)(void *ctx, es_context *c, const op_value *code, sw_setup *out);
	void *ctx;
} sw_loader;

// the loader at `name`, placed by c (what it starts belongs to c's owner)
int sw_place_loader(es_context *c, es_at name, sw_loader *loader, es_handle **out);

// the loader at `loader` run on `program` at `at` (paths): its action called. *out the caller's to
// op_free. code not there yet is pending: the process starts and waits for it, then runs once. an
// effect's act makes no memos or effects, so a program that waited can write and read but not make
// computes, and its return is not the process's value
int sw_run(es_context *c, es_at loader, es_at program, es_at at, op_value **out);

// what sw_run gave: the process stopped (why NULL: "ended"), its status; a refused one: nothing
int sw_stop(es_context *c, const op_value *run, const char *why);
int sw_status(es_context *c, const op_value *run, es_status *out);

#endif
