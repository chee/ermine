// Making a because (newcore/nodes/BECAUSE.tex), in C. Same shape as because.ts.
#ifndef BECAUSE_H
#define BECAUSE_H

// where in code: column 0 and function NULL when not known
typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
} bc_site;

// the site of the code writing it
#define BC_HERE (&(bc_site){__FILE__, __LINE__, 0, __func__})

// why a version is there: the layer that put it there, where it put it, and that layer's reason
// place and why: the layer's, never read here; why NULL = not given
// everything is borrowed: the caller keeps layer, place, why and the site's strings alive
typedef struct {
	const char *layer;
	const void *place;
	const void *why;
	int has_site;
	bc_site site;
} bc_because;

// by value, as given; nothing checked
// outside: a site (BC_HERE) or NULL
bc_because bc_make(const char *layer, const void *place, const void *why, const bc_site *outside);

#endif
