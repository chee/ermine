// the little of string.h notify.c uses, for the wasm build (libc.c)
#pragma once
#include <stddef.h>
void *memcpy(void *restrict d, const void *restrict s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
size_t strlen(const char *s);
int strcmp(const char *a, const char *b);
