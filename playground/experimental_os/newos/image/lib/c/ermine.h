// ermine.h: a C program's side of ermineOS (newos/CLOADER.md, The C side). A C
// program is compiled to wasm32 on the fly, freestanding: no libc yet, so this
// is all it includes (and clang's own stdint.h, stddef.h, stdarg.h, stdbool.h).
// It defines setup(), called once as its process starts, as a JavaScript
// program's default export is; what setup returns is the process's value.
//
// Native: the same source compiled for this machine (arm64, a dylib) when the
// program says so, its ermine.programs.loader "/loaders/clang-native" (CLOADER.md,
// Native). Then the entry points below are calls through the table its run is
// given (ermine_host.h), and this header defines the library's run, so a native
// program has no function of its own named run or stop. It runs in the OS's own
// process: a crash there is the OS's, not the part's.
//
//   #include <ermine.h>
//
//   er_value setup(void) {
//   	er_say("hello");
//   	return er_text("hello, world");
//   }
//
// Values: an er_value is one the loader holds for the part running (setup, a
// handler, a timer, a cleanup), good until that part returns, as a JavaScript
// part's are. er_none() is null. Addresses are lists of names: ER_AT("count")
// read from the process's place, ER_AT("/", "home", "count") from the root.
// Ids are text values.
//
// Every er_* acts through the part running: in a handler, the call's own. An
// operation that fails ends the part with its error, as an uncaught throw ends
// a JavaScript part; a trap ends it too ("crashed in click: out of bounds
// memory access"), and the process goes on.
//
// er_say(format, ...) adds a line to <process>/log, its last 50 lines: %d %i
// %u %x %c %s %f (%.3f), l and ll before d u x, %v a value as JSON, %%.
//
// Each process has its own instance, so its own statics; a handler is a
// function the loader calls by its table index: er_handler("click", click)
// places it at <process>/on/click.

#ifndef ERMINE_H
#define ERMINE_H

#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifndef __wasm__
#include "ermine_host.h"
#endif

/** a value the loader holds for the part running; er_none() is null */
typedef struct {
	int at;
} er_value;
/** what a handler is called with: its args, a list */
typedef er_value er_args;
/** a handler, a timer, a cleanup: called with its args (a timer's and a cleanup's: none) */
typedef void (*er_fn)(er_args args);
/** an address: names from the process's place, or from the root when the first is "/" */
typedef struct {
	const char *const *names;
	int n;
} er_address;
#define ER_AT(...) ((er_address){ (const char *const[]){ __VA_ARGS__ }, (int)(sizeof((const char *const[]){ __VA_ARGS__ }) / sizeof(const char *)) })

/** what a value is */
typedef enum { ER_NULL, ER_BOOL, ER_NUM, ER_TEXT, ER_BYTES, ER_LIST, ER_MAP, ER_OTHER } er_kind;

/** the program's: called once as its process starts; its value is the process's */
#ifdef __wasm__
__attribute__((export_name("setup")))
#endif
er_value setup(void);

// --- the loader's (import module "ermine"; native, the table run is given): not called directly

#ifdef __wasm__
#define ER__IMPORT(n) __attribute__((import_module("ermine"), import_name(n)))
ER__IMPORT("num") int er__num(double n);
ER__IMPORT("text") int er__text(const char *s, int n);
ER__IMPORT("bytes") int er__bytes(const void *p, int n);
ER__IMPORT("bool") int er__bool(int b);
ER__IMPORT("list") int er__list(void);
ER__IMPORT("map") int er__map(void);
ER__IMPORT("push") void er__push(int list, int v);
ER__IMPORT("put") void er__put(int map, const char *key, int n, int v);
ER__IMPORT("kind") int er__kind(int v);
ER__IMPORT("number") double er__number(int v);
ER__IMPORT("length") int er__length(int v);
ER__IMPORT("copy") int er__copy(int v, void *out, int room);
ER__IMPORT("item") int er__item(int v, int i);
ER__IMPORT("get") int er__get(int v, const char *key, int n);
ER__IMPORT("keys") int er__keys(int v);
ER__IMPORT("show") int er__show(int v, char *out, int room);
// an operation through the part's interface: its name, an address (n -1: none) and its other arguments, a list
ER__IMPORT("op") int er__op(const char *op, int nop, const char *const *names, int n, int args);
ER__IMPORT("say") void er__say(const char *s, int n);
/** a function of the program's, as a number: wasm, its index in the table; native, its address */
#define ER__FN(f) er_int((int)(uintptr_t)(f))
#else
static const er_host *er__host;
static inline int er__num(double n) { return er__host->num(er__host->ctx, n); }
static inline int er__text(const char *s, int n) { return er__host->text(er__host->ctx, s, n); }
static inline int er__bytes(const void *p, int n) { return er__host->bytes(er__host->ctx, p, n); }
static inline int er__bool(int b) { return er__host->bool_(er__host->ctx, b); }
static inline int er__list(void) { return er__host->list(er__host->ctx); }
static inline int er__map(void) { return er__host->map(er__host->ctx); }
static inline void er__push(int list, int v) { er__host->push(er__host->ctx, list, v); }
static inline void er__put(int map, const char *key, int n, int v) { er__host->put(er__host->ctx, map, key, n, v); }
static inline int er__kind(int v) { return er__host->kind(er__host->ctx, v); }
static inline double er__number(int v) { return er__host->number(er__host->ctx, v); }
static inline int er__length(int v) { return er__host->length(er__host->ctx, v); }
static inline int er__copy(int v, void *out, int room) { return er__host->copy(er__host->ctx, v, out, room); }
static inline int er__item(int v, int i) { return er__host->item(er__host->ctx, v, i); }
static inline int er__get(int v, const char *key, int n) { return er__host->get(er__host->ctx, v, key, n); }
static inline int er__keys(int v) { return er__host->keys(er__host->ctx, v); }
static inline int er__show(int v, char *out, int room) { return er__host->show(er__host->ctx, v, out, room); }
static inline int er__op(const char *op, int nop, const char *const *names, int n, int args) {
	return er__host->op(er__host->ctx, op, nop, names, n, args);
}
static inline void er__say(const char *s, int n) { er__host->say(er__host->ctx, s, n); }
/** a function of the program's, as a number: wasm, its index in the table; native, its address (exact in a double) */
#define ER__FN(f) er_num((double)(uintptr_t)(f))
#endif

static inline int er__len(const char *s) {
	int n = 0;
	while (s && s[n]) n++;
	return n;
}
static inline er_value er__v(int at) { return (er_value){ at }; }
static inline er_value er__do(const char *op, er_address a, int args) {
	return er__v(er__op(op, er__len(op), a.names, a.n, args));
}
static inline er_value er__do0(const char *op, int args) {
	return er__v(er__op(op, er__len(op), 0, -1, args));
}

// --- values

static inline er_value er_none(void) { return er__v(0); }
static inline er_value er_bool(bool b) { return er__v(er__bool(b)); }
static inline er_value er_num(double n) { return er__v(er__num(n)); }
static inline er_value er_int(long long n) { return er__v(er__num((double)n)); }
static inline er_value er_text(const char *s) { return er__v(er__text(s, er__len(s))); }
static inline er_value er_text_n(const char *s, int n) { return er__v(er__text(s, n)); }
static inline er_value er_bytes(const void *p, int n) { return er__v(er__bytes(p, n)); }
static inline er_value er_list(void) { return er__v(er__list()); }
static inline er_value er_map(void) { return er__v(er__map()); }
/** v at the end of list; list, for chaining */
static inline er_value er_push(er_value list, er_value v) {
	er__push(list.at, v.at);
	return list;
}
/** key set to v in map; map, for chaining */
static inline er_value er_put(er_value map, const char *key, er_value v) {
	er__put(map.at, key, er__len(key), v.at);
	return map;
}

static inline er_kind er_kind_of(er_value v) { return (er_kind)er__kind(v.at); }
static inline bool er_is_none(er_value v) { return er__kind(v.at) == ER_NULL; }
/** a number's value; anything else, 0 */
static inline double er_to_num(er_value v) { return er__number(v.at); }
static inline long long er_to_int(er_value v) { return (long long)er__number(v.at); }
/** a bool's value; a number not 0, text not empty, a list or map: true */
static inline bool er_to_bool(er_value v) {
	int k = er__kind(v.at);
	return k == ER_BOOL || k == ER_NUM ? er__number(v.at) != 0 : k == ER_TEXT || k == ER_BYTES ? er__length(v.at) > 0 : k == ER_LIST || k == ER_MAP;
}
/** text's UTF-8 bytes or bytes' bytes, into out (room bytes; text ends with a 0 if there is room); its whole length */
static inline int er_copy(er_value v, void *out, int room) { return er__copy(v.at, out, room); }
/** a list's items, a map's keys, text's or bytes' bytes */
static inline int er_len(er_value v) { return er__length(v.at); }
static inline er_value er_item(er_value list, int i) { return er__v(er__item(list.at, i)); }
static inline er_value er_get(er_value map, const char *key) { return er__v(er__get(map.at, key, er__len(key))); }
/** a map's keys, a list of text */
static inline er_value er_keys(er_value map) { return er__v(er__keys(map.at)); }
static inline bool er_same_text(er_value v, const char *s) {
	char b[256];
	int n = er__copy(v.at, b, sizeof b), k = er__len(s);
	if (er__kind(v.at) != ER_TEXT || n != k || n >= (int)sizeof b) return false;
	for (int i = 0; i < n; i++)
		if (b[i] != s[i]) return false;
	return true;
}

// --- the graph: core's words, through the part's interface

/** the first loaded node's value at an address, its first version not a status; null if none */
static inline er_value er_read(er_address a) { return er__do("read", a, 0); }
static inline long long er_int_at(er_address a) { return er_to_int(er_read(a)); }
static inline double er_num_at(er_address a) { return er_to_num(er_read(a)); }
/** the id of the first loaded node at an address; null if none */
static inline er_value er_id_at(er_address a) { return er__do("id", a, 0); }
/** v written whole at an address; made there (in its parent, by its last name) if nothing is. The change's time */
static inline long long er_write(er_address a, er_value v) {
	return er_to_int(er__do("write", a, er_push(er_list(), v).at));
}
/** core's write: a list of patches ({path, range?, value?}) */
static inline long long er_patch(er_address a, er_value patches) {
	return er_to_int(er__do("patch", a, er_push(er_list(), patches).at));
}
/** the info of that name written whole */
static inline long long er_set(er_address a, const char *name, er_value v) {
	return er_to_int(er__do("set", a, er_push(er_push(er_list(), er_text(name)), v).at));
}
/** items: [{id, route, node?, versions?}] */
static inline er_value er_look(er_address a) { return er__do("look", a, 0); }
static inline er_value er_lookup(er_address a) { return er__do("lookup", a, 0); }
static inline er_value er_lookups(er_address a) { return er__do("lookups", a, 0); }
static inline er_value er_content(er_address a) { return er__do("content", a, 0); }
static inline er_value er_info(er_address a, const char *name) { return er__do("info", a, er_push(er_list(), er_text(name)).at); }
/** name NULL: the names there; else that list's items */
static inline er_value er_children(er_address a, const char *name) {
	return er__do("children", a, name ? er_push(er_list(), er_text(name)).at : 0);
}
/** a node holding v; ephemeral, it goes when the process ends. Its id */
static inline er_value er_create(er_value v, bool ephemeral) { return er__do0("create", er_push(er_push(er_list(), v), er_bool(ephemeral)).at); }
static inline long long er_insert(er_value id, const char *name, er_value child) {
	return er_to_int(er__do0("insert", er_push(er_push(er_push(er_list(), id), er_text(name)), child).at));
}
static inline long long er_remove(er_value id, const char *name, int index) {
	return er_to_int(er__do0("remove", er_push(er_push(er_push(er_list(), id), er_text(name)), er_int(index)).at));
}
static inline long long er_pop(er_value id, const char *name, int slot) {
	return er_to_int(er__do0("pop", er_push(er_push(er_push(er_list(), id), er_text(name)), er_int(slot)).at));
}
static inline long long er_rename(er_value id, const char *name, const char *to) {
	return er_to_int(er__do0("rename", er_push(er_push(er_push(er_list(), id), er_text(name)), er_text(to)).at));
}
static inline long long er_move(er_value id, const char *name, int index, er_value toid, const char *toname) {
	er_value a = er_push(er_push(er_push(er_push(er_push(er_list(), id), er_text(name)), er_int(index)), toid), er_text(toname));
	return er_to_int(er__do0("move", a.at));
}
/** the whole node of an id: {id, value, info, children}, each a list of versions; null if not loaded */
static inline er_value er_node(er_value id) { return er__do0("node", er_push(er_list(), id).at); }
/** this part's changes carry cause, until it returns (er_none(): none) */
static inline void er_as(er_value cause) { er__do0("as", er_push(er_list(), cause).at); }

// --- processes

/** the process's id, and its name */
static inline er_value er_self(void) { return er__do0("self", 0); }
static inline er_value er_name(void) { return er__do0("name", 0); }
/** f as a handler, at <process>/on/<name>; its address from the process's place */
static inline er_value er_handler(const char *name, er_fn f) {
	return er__do0("handler", er_push(er_push(er_list(), er_text(name)), ER__FN(f)).at);
}
/** f called in ms, as a handler of the process */
static inline void er_after(double ms, er_fn f) { er__do0("after", er_push(er_push(er_list(), er_num(ms)), ER__FN(f)).at); }
/** f called as the process ends */
static inline void er_cleanup(er_fn f) { er__do0("cleanup", er_push(er_list(), ER__FN(f)).at); }
/** a process started at an address, running the program at path (looked up from there); name NULL: its pid. Its pid */
static inline er_value er_start(er_address at, er_address program, const char *name) {
	er_value names = er_list();
	for (int i = 0; i < program.n; i++) er_push(names, er_text(program.names[i]));
	return er__do("start", at, er_push(er_push(er_list(), names), name ? er_text(name) : er_none()).at);
}
/** the handler at an address called with args (a list); from a part it runs once the part returns, answering nothing */
static inline er_value er_call(er_address a, er_value args) { return er__do("call", a, er_push(er_list(), args).at); }
/** the process ends, once the part asking returns */
static inline void er_end(void) { er__do0("end", 0); }

// --- er_say: a line in <process>/log

typedef struct {
	char *out;
	int n, room;
} er__line;
static inline void er__ch(er__line *l, char c) {
	if (l->n < l->room - 1) l->out[l->n] = c;
	l->n++;
}
static inline void er__s(er__line *l, const char *s) {
	while (s && *s) er__ch(l, *s++);
}
static inline void er__u(er__line *l, unsigned long long u, int base) {
	char d[24];
	int k = 0;
	do d[k++] = "0123456789abcdef"[u % (unsigned)base];
	while ((u /= (unsigned)base) && k < 24);
	while (k) er__ch(l, d[--k]);
}
static inline void er__f(er__line *l, double x, int places) {
	if (x < 0) er__ch(l, '-'), x = -x;
	if (x != x || x > 1e18) {
		er__s(l, x != x ? "nan" : "inf");
		return;
	}
	double half = 0.5;
	for (int i = 0; i < places; i++) half /= 10;
	x += half;
	unsigned long long whole = (unsigned long long)x;
	er__u(l, whole, 10);
	if (!places) return;
	er__ch(l, '.');
	x -= (double)whole;
	for (int i = 0; i < places; i++) {
		x *= 10;
		int d = (int)x;
		er__ch(l, (char)('0' + d));
		x -= d;
	}
}
static inline void er_say(const char *format, ...) {
	char buf[512];
	er__line l = { buf, 0, sizeof buf };
	va_list ap;
	va_start(ap, format);
	for (const char *f = format; f && *f; f++) {
		if (*f != '%') {
			er__ch(&l, *f);
			continue;
		}
		int places = 6, longs = 0;
		if (f[1] == '.' && f[2] >= '0' && f[2] <= '9') places = f[2] - '0', f += 2;
		while (f[1] == 'l') longs++, f++;
		switch (*++f) {
		case 'd':
		case 'i': {
			long long v = longs > 1 ? va_arg(ap, long long) : longs ? va_arg(ap, long) : va_arg(ap, int);
			if (v < 0) er__ch(&l, '-'), v = -v;
			er__u(&l, (unsigned long long)v, 10);
			break;
		}
		case 'u':
		case 'x': er__u(&l, longs > 1 ? va_arg(ap, unsigned long long) : longs ? va_arg(ap, unsigned long) : va_arg(ap, unsigned), *f == 'x' ? 16 : 10); break;
		case 'c': er__ch(&l, (char)va_arg(ap, int)); break;
		case 's': er__s(&l, va_arg(ap, const char *)); break;
		case 'f': er__f(&l, va_arg(ap, double), places); break;
		case 'v': {
			er_value v = va_arg(ap, er_value);
			char shown[256];
			int n = er__show(v.at, shown, sizeof shown);
			for (int i = 0; i < n && i < (int)sizeof shown; i++) er__ch(&l, shown[i]);
			break;
		}
		case '%': er__ch(&l, '%'); break;
		case 0: f--; break;
		default: er__ch(&l, '%'), er__ch(&l, *f);
		}
	}
	va_end(ap);
	er__say(buf, l.n < l.room ? l.n : l.room - 1);
}

// --- native: the library's run (native.h's ABI), given the table as its api: setup run as the
// process's, through it. No stop: what the process placed goes with it, and its cleanups are called

#ifndef __wasm__
static int er__setup(void) { return setup().at; }
__attribute__((visibility("default"))) int run(const unsigned char *code, size_t n, void *api, void **state) {
	(void)code, (void)n;
	er__host = (const er_host *)api;
	*state = 0;
	return er__host->setup(er__host->ctx, er__setup);
}
#endif

#endif
