// Shown nodes on the line protocol, for the C harnesses (shown.c)
#ifndef SAVED_SHOWN_H
#define SAVED_SHOWN_H

#include "saved.h"

void fail(const char *why);
// everything one line allocates, freed by clear when its answer is written
void *take(size_t size);
void clear(void);
// at the end: clear, and the arena itself
void finish(void);

// reading JSON: values as spans of the line
const char *space(const char *p);
// past one value
const char *skip(const char *p);
// a JSON string at p, decoded
char *string(const char *p);
// a value's JSON text, as written
char *raw(const char *p);
// the value at key in the object at p; NULL when absent
const char *field(const char *p, const char *key);
// the items of the array at p: count, then each start
size_t items(const char *p, const char ***out);
sd_object object(const char *p, int lists);
size_t named(const char *p, int lists, const sd_entry **out);
sd_site site(const char *p);
sd_header parse_header(const char *p);
// a shown node, made by sd_make; sd_free it
sd_node *parse_node(const char *p);

// writing JSON
void text(const char *s);
void versions(sd_object o, int lists);
void entries(const sd_entry *es, size_t n, int lists);
void header(const sd_header *h);
void show_node(const sd_node *n);

#endif
