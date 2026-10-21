// platform_posix.c: platform.h on macOS and Linux.

#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#else
#define _DEFAULT_SOURCE
#endif

#include "platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>

void erm_host_random(uint8_t *out, size_t length) {
	while (length) {
		size_t n = length > 256 ? 256 : length; // getentropy's most at once
		if (getentropy(out, n) != 0) abort();
		out += n;
		length -= n;
	}
}

void *erm_host_malloc(size_t size) {
	return malloc(size);
}

void *erm_host_realloc(void *pointer, size_t size) {
	return realloc(pointer, size);
}

void erm_host_free(void *pointer) {
	free(pointer);
}

void erm_host_abort(void) {
	abort();
}

uint64_t erm_host_now(void) {
	struct timespec t;
	clock_gettime(CLOCK_REALTIME, &t);
	return (uint64_t)t.tv_sec * 1000 + (uint64_t)(t.tv_nsec / 1000000);
}

void erm_host_log(const char *line) {
	fprintf(stderr, "%s\n", line);
}
