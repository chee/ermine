// Small memory helpers shared by programs' C files: calloc and strdup that abort, and a growing
// array. Out of memory aborts, as everywhere in core.
#ifndef PROGRAMS_MEM_H
#define PROGRAMS_MEM_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static inline void *pg_alloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) {
		fputs("programs: out of memory\n", stderr);
		abort();
	}
	return p;
}
static inline char *pg_dup(const char *s) { return strcpy((char *)pg_alloc(strlen(s) + 1), s); }

#define PG_PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 8; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

// a random id: 8-4-4-4-12 hex, from the system's random bytes
static inline char *pg_uuid(void) {
	static const char hex[] = "0123456789abcdef";
	unsigned char b[16];
	arc4random_buf(b, sizeof b);
	char *id = (char *)pg_alloc(37);
	size_t at = 0;
	for (size_t i = 0; i < 16; i++) {
		if (i == 4 || i == 6 || i == 8 || i == 10) id[at++] = '-';
		id[at++] = hex[b[i] >> 4];
		id[at++] = hex[b[i] & 15];
	}
	return id;
}

#endif
