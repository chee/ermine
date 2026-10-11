// the little of stdio.h notify.c uses, for the wasm build (libc.c): no files, no output
#pragma once
#include <stddef.h>
typedef struct nt_file FILE;
extern FILE *stderr;
int fputs(const char *s, FILE *f);
// only "%ld" and plain text
int snprintf(char *restrict out, size_t size, const char *restrict format, ...);
