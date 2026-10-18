// the counting allocator (count.h): a header of 16 bytes holds each block's size
#include <stdlib.h>
#include <string.h>

size_t lsc_bytes, lsc_blocks;

void *lsc_malloc(size_t n) {
	size_t *p = malloc(n + 16);
	if (p == NULL) return NULL;
	p[0] = n;
	lsc_bytes += n, lsc_blocks++;
	return p + 2;
}
void *lsc_calloc(size_t a, size_t b) {
	void *p = lsc_malloc(a * b);
	if (p != NULL) memset(p, 0, a * b);
	return p;
}
void lsc_free(void *q) {
	if (q == NULL) return;
	size_t *p = (size_t *)q - 2;
	lsc_bytes -= p[0], lsc_blocks--;
	free(p);
}
void *lsc_realloc(void *q, size_t n) {
	if (q == NULL) return lsc_malloc(n);
	size_t *p = (size_t *)q - 2, old = p[0];
	size_t *r = realloc(p, n + 16);
	if (r == NULL) return NULL;
	r[0] = n;
	lsc_bytes += n - old;
	return r + 2;
}
char *lsc_strdup(const char *s) {
	size_t n = strlen(s) + 1;
	char *p = lsc_malloc(n);
	if (p != NULL) memcpy(p, s, n);
	return p;
}
