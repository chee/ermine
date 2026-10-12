// Making a change (newcore/nodes/CHANGE.tex), in C. Same shape as change.ts.
#ifndef CHANGE_H
#define CHANGE_H

#include <stdint.h>

// where in code: column 0 and function NULL when not known
typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
} ch_site;

// the site of the code writing it
#define CH_HERE (&(ch_site){__FILE__, __LINE__, 0, __func__})

// what a change says, given by the caller: has_time and has_site, and NULL for the rest = not given
// actor and cause: the caller's, never read here
typedef struct {
	int has_time;
	int64_t time;
	const void *actor;
	const char *reader;
	int has_site;
	ch_site site;
	const void *cause;
} ch_header;

// a version's change: its header and node, never its edits
// everything is borrowed: the caller keeps the node, reader, site strings, actor and cause alive
typedef struct {
	ch_header header;
	const char *node;
} ch_change;

// by value, the header's fields as given, node added; nothing checked
// outside: a site (CH_HERE) or NULL; used only when the header gives no site
ch_change ch_make(const char *node, ch_header header, const ch_site *outside);

#endif
