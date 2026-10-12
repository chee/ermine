// the little of stdlib.h notify.c uses, for the wasm build (libc.c)
#pragma once
#include <stddef.h>
void *malloc(size_t n);
void *realloc(void *p, size_t n);
void free(void *p);
_Noreturn void abort(void);
long strtol(const char *restrict s, char **restrict end, int base);
