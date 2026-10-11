// Making a node (newcore/NODE.tex), in C. Same shape as node.ts.
#ifndef NODE_H
#define NODE_H

#include <stddef.h>
#include <stdint.h>

// where in code: column 0 and function NULL when not known
typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
} nd_site;

// the site of the code writing it
#define ND_HERE (&(nd_site){__FILE__, __LINE__, 0, __func__})

// a change header's fields, each optional here: has_time, has_site, and NULL for the rest
// actor and cause: the caller's, never read here
typedef struct {
	int has_time;
	int64_t time;
	const void *actor;
	const char *reader;
	int has_site;
	nd_site site;
	const void *cause;
} nd_header;

// content: the caller's; under children, an nd_list. change and because: the caller's
typedef struct {
	const void *content;
	const void *change;
	const void *because;
} nd_version;

// a list: ids in order, and symbols, which name no node; one of id and symbol is set
typedef struct {
	const char *id;
	const char *symbol;
} nd_item;
typedef struct {
	const nd_item *items;
	size_t length;
} nd_list;

// versions in order; none: not there. The array given is the node's, not a copy
typedef struct {
	const nd_version *versions;
	size_t length;
} nd_object;

typedef struct {
	const char *name;
	nd_object object;
} nd_entry;

// entries in order, as new Map takes them
typedef struct {
	nd_object value;
	const nd_entry *info;
	size_t info_length;
	const nd_entry *children;
	size_t children_length;
} nd_contents;

typedef struct {
	const char *id;
	nd_object value;
	nd_entry *info;
	size_t info_length;
	nd_entry *children;
	size_t children_length;
	nd_header header; // about it being made; a copy, not changed after
} nd_node;

// kept by the caller; nothing checked: a name given twice keeps its first place and the last
// versions. contents and header may be NULL. outside: ND_HERE to capture the call's site when
// the header gives none, or NULL. NULL when out of memory
nd_node *nd_make(const char *id, const nd_contents *contents, const nd_header *header,
	const nd_site *outside);
// frees what nd_make allocated; nothing given to it
void nd_free(nd_node *n);

#endif
