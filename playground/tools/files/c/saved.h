// Making a node (newcore/nodes/NODE.tex), in C. Same shape as node.ts.
#ifndef SAVED_H
#define SAVED_H

#include <stddef.h>
#include <stdint.h>

// where in code: column only when has_column, function NULL when not known
typedef struct {
	const char *file;
	long line;
	long column;
	const char *function;
	int has_column;
} sd_site;

// the site of the code writing it
#define SD_HERE (&(sd_site){__FILE__, __LINE__, 0, __func__, 0})

// a change header's fields, each optional here: has_time, has_site, and NULL for the rest
// actor and cause: the caller's, never read here
typedef struct {
	int has_time;
	int64_t time;
	const void *actor;
	const char *reader;
	int has_site;
	sd_site site;
	const void *cause;
	// the author's clock, whole seconds since 1970, and a message (CHANGE.tex): optional
	int has_wallclock;
	int64_t wallclock;
	const char *message;
} sd_header;

// content: the caller's; under children, an sd_list. change and because: the caller's
typedef struct {
	const void *content;
	const void *change;
	const void *because;
} sd_version;

// a list: ids in order, and symbols, which name no node; one of id and symbol is set
typedef struct {
	const char *id;
	const char *symbol;
} sd_item;
typedef struct {
	const sd_item *items;
	size_t length;
} sd_list;

// versions in order; none: not there. The array given is the node's, not a copy
typedef struct {
	const sd_version *versions;
	size_t length;
} sd_object;

typedef struct {
	const char *name;
	sd_object object;
} sd_entry;

// entries in order, as new Map takes them
typedef struct {
	sd_object value;
	const sd_entry *info;
	size_t info_length;
	const sd_entry *children;
	size_t children_length;
} sd_contents;

typedef struct {
	const char *id;
	sd_object value;
	sd_entry *info;
	size_t info_length;
	sd_entry *children;
	size_t children_length;
	sd_header header; // about it being made; a copy, not changed after
} sd_node;

// kept by the caller; nothing checked: a name given twice keeps its first place and the last
// versions. contents and header may be NULL. outside: SD_HERE to capture the call's site when
// the header gives none, or NULL. NULL when out of memory
sd_node *sd_make(const char *id, const sd_contents *contents, const sd_header *header,
	const sd_site *outside);
// frees what sd_make allocated; nothing given to it
void sd_free(sd_node *n);

#endif
