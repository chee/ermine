// sites: where in the code a scope, computer or effect was made, recorded once when it was, so an
// inspector can show a memo made at program.c:12 inside the process started at host.c:40. the C of
// typescript/sites.ts. each macro is the scheduler's create call, and notes the call's __FILE__,
// __LINE__ and __func__ on what it made:
//
//   st_sites *t = st_new(s);
//   sc_scope *p = st_create_scope(t, info, n, parent);   // p's site is this line
//   const st_site *site = st_site_of(t, p);               // NULL: made without the macro
//   const st_site *chain[8];
//   size_t n = st_sites_of(t, p, chain, 8);               // p's own, then each parent's that has one
//
// a site is kept until its scope is torn down (a teardown registered on the scope, the last to run:
// the site is there for the scope's own teardowns); st_free lets go of those not yet. the strings
// are the compiler's: static, never freed. t is evaluated twice by a macro.
//
// core candidate: the scheduler could keep the site on the scope itself, so one made without these
// macros has one too, and no table is needed
#ifndef SITES_H
#define SITES_H

#include <stddef.h>

#include "../../../core/scheduler/c/scheduler.h"

typedef struct st_sites st_sites;

// where a scope was made: static strings, good as long as the program
typedef struct st_site {
	const char *file;
	int line;
	const char *func;
} st_site;

// sites of the scopes of scheduler s. st_free: any time, even before the scheduler is freed (sc_free
// runs no teardowns; a scope torn down after st_free is a use after free, so free it when scopes are done)
st_sites *st_new(sc_scheduler *s);
void st_free(st_sites *t);

// the scheduler it was made for
sc_scheduler *st_scheduler(const st_sites *t);

// what the macros call: scope, noted as made at file:line in func. NULL (none made): NULL
sc_scope *st_note(st_sites *t, sc_scope *scope, const char *file, int line, const char *func);

#define st_create_root_scope(t, info, n) \
	st_note((t), sc_create_root_scope(st_scheduler(t), (info), (n)), __FILE__, __LINE__, __func__)
#define st_create_scope(t, info, n, parent) \
	st_note((t), sc_create_scope(st_scheduler(t), (info), (n), (parent)), __FILE__, __LINE__, __func__)
#define st_create_computer(t, def) \
	st_note((t), sc_create_computer(st_scheduler(t), (def)), __FILE__, __LINE__, __func__)
#define st_create_effect(t, def) \
	st_note((t), sc_create_effect(st_scheduler(t), (def)), __FILE__, __LINE__, __func__)

// its own site; NULL: none (made without the macros, or torn down)
const st_site *st_site_of(const st_sites *t, const sc_scope *scope);
// the chain: its own site if it has one, then each parent's that has one, up to the root. up to cap
// into out; how many there are
size_t st_sites_of(const st_sites *t, const sc_scope *scope, const st_site **out, size_t cap);

// how many sites are kept (not torn down yet)
size_t st_count(const st_sites *t);

#endif
