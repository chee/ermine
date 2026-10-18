// the test build's allocator hook: -include'd into every file, so each malloc, calloc, realloc, free
// and strdup goes through a count of the bytes and blocks held (count.c)
#ifndef LS_COUNT_H
#define LS_COUNT_H
#include <stdlib.h>
#include <string.h>
extern size_t lsc_bytes, lsc_blocks;
void *lsc_malloc(size_t n);
void *lsc_calloc(size_t a, size_t b);
void *lsc_realloc(void *p, size_t n);
void lsc_free(void *p);
char *lsc_strdup(const char *s);
// function-like, so (free)(p) is the real one: for text op_json_text made with the C library's own
#define malloc(n) lsc_malloc(n)
#define calloc(a, b) lsc_calloc(a, b)
#define realloc(p, n) lsc_realloc(p, n)
#define free(p) lsc_free(p)
#define strdup(s) lsc_strdup(s)
#endif
