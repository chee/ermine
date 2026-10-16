// ermine_host.h: what a native program is given (newos/native.c; CLOADER.md, Native). ermine.h
// includes it when the program is compiled for this machine, not wasm32: its entry points are then
// calls through this table, which the library's run (extensions/programs/c/native.h's ABI) is given
// as its api. The same entry points as the wasm imports (module "ermine"), each with the host's ctx
// first, so one C source builds to either. A program includes ermine.h, never this.
//
// size: the table's, as the host made it; an entry past it is not there. Entries only grow at the end.
#ifndef ERMINE_HOST_H
#define ERMINE_HOST_H

/** a value held for the part running, as ermine.h's er_value; a handler's args, as its er_args */
typedef struct {
	int at;
} er_host_value;
/** a handler, a timer, a cleanup of the program's, as ermine.h's er_fn */
typedef void (*er_host_fn)(er_host_value args);

typedef struct er_host {
	unsigned size;
	void *ctx;
	int (*num)(void *ctx, double n);
	int (*text)(void *ctx, const char *s, int n);
	int (*bytes)(void *ctx, const void *p, int n);
	int (*bool_)(void *ctx, int b);
	int (*list)(void *ctx);
	int (*map)(void *ctx);
	void (*push)(void *ctx, int list, int v);
	void (*put)(void *ctx, int map, const char *key, int n, int v);
	int (*kind)(void *ctx, int v);
	double (*number)(void *ctx, int v);
	int (*length)(void *ctx, int v);
	int (*copy)(void *ctx, int v, void *out, int room);
	int (*item)(void *ctx, int v, int i);
	int (*get)(void *ctx, int v, const char *key, int n);
	int (*keys)(void *ctx, int v);
	int (*show)(void *ctx, int v, char *out, int room);
	int (*op)(void *ctx, const char *op, int nop, const char *const *names, int n, int args);
	void (*say)(void *ctx, const char *s, int n);
	// the program's setup run as its process's setup, its value the process's: 0, or not 0 failed
	int (*setup)(void *ctx, int (*setup)(void));
} er_host;

#endif
