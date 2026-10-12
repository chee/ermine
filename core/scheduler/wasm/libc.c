// a tiny libc for notify.c in wasm with no imports: memory comes from memory.grow, nothing else
// leaves the module. An allocation is a block of a power of two, its class kept before it;
// freed blocks wait on a list per class.
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAGE 65536
extern unsigned char __heap_base;
static unsigned char *top, *end;
static void *lists[48];

static unsigned class_of(size_t n) {
	unsigned c = 4;
	while (((size_t)1 << c) < n + 8) c++;
	return c;
}
void *malloc(size_t n) {
	unsigned c = class_of(n);
	void *b = lists[c];
	if (b != NULL) {
		lists[c] = *(void **)b;
		return b;
	}
	if (top == NULL) top = end = &__heap_base;
	size_t size = (size_t)1 << c;
	// blocks start 8 past an 8-aligned place: the class sits just before
	unsigned char *at = (unsigned char *)(((size_t)top + 7) & ~(size_t)7);
	if (at + size > end) {
		size_t pages = (size_t)(at + size - end + PAGE - 1) / PAGE;
		if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return NULL;
		end += pages * PAGE;
	}
	top = at + size;
	*(size_t *)at = c;
	return at + 8;
}
void free(void *p) {
	if (p == NULL) return;
	size_t c = *(size_t *)((unsigned char *)p - 8);
	*(void **)p = lists[c];
	lists[c] = p;
}
void *realloc(void *p, size_t n) {
	if (p == NULL) return malloc(n);
	size_t c = *(size_t *)((unsigned char *)p - 8);
	if (n + 8 <= ((size_t)1 << c)) return p;
	void *q = malloc(n);
	if (q == NULL) return NULL;
	memcpy(q, p, ((size_t)1 << c) - 8);
	free(p);
	return q;
}
_Noreturn void abort(void) { __builtin_trap(); }
// base 10 only: what notify.c asks
long strtol(const char *restrict s, char **restrict end, int base) {
	(void)base;
	const char *p = s;
	int minus = 0;
	if (*p == '-' || *p == '+') minus = *p++ == '-';
	const char *digits = p;
	long v = 0;
	while (*p >= '0' && *p <= '9') v = v * 10 + (*p++ - '0');
	if (p == digits) p = s;
	if (end) *end = (char *)p;
	return minus ? -v : v;
}

// with bulk memory these are one instruction each
void *memcpy(void *restrict d, const void *restrict s, size_t n) {
	__builtin_memcpy(d, s, n);
	return d;
}
void *memmove(void *d, const void *s, size_t n) {
	__builtin_memmove(d, s, n);
	return d;
}
void *memset(void *d, int c, size_t n) {
	__builtin_memset(d, c, n);
	return d;
}
size_t strlen(const char *s) {
	size_t n = 0;
	while (s[n]) n++;
	return n;
}
int strcmp(const char *a, const char *b) {
	while (*a && *a == *b) a++, b++;
	return (unsigned char)*a - (unsigned char)*b;
}

FILE *stderr;
int fputs(const char *s, FILE *f) {
	(void)s, (void)f;
	return 0;
}
int snprintf(char *restrict out, size_t size, const char *restrict format, ...) {
	va_list ap;
	va_start(ap, format);
	size_t n = 0;
	char digits[24];
	for (const char *f = format; *f; f++) {
		if (f[0] == '%' && f[1] == 'l' && f[2] == 'd') {
			long v = va_arg(ap, long);
			unsigned long u = v < 0 ? 0UL - (unsigned long)v : (unsigned long)v;
			int k = 0;
			do digits[k++] = (char)('0' + u % 10); while (u /= 10);
			if (v < 0) digits[k++] = '-';
			while (k) {
				if (n + 1 < size) out[n] = digits[k - 1];
				n++, k--;
			}
			f += 2;
		} else {
			if (n + 1 < size) out[n] = *f;
			n++;
		}
	}
	if (size) out[n < size ? n : size - 1] = 0;
	va_end(ap);
	return (int)n;
}
