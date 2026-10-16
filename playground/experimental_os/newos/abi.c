// abi.c: the ABI's frames (abi.h).

#include "abi.h"

#include "../../../ermine/encoding/c/cbor.h"

#include <errno.h>
#include <stdlib.h>
#include <unistd.h>

static bool all(int fd, const unsigned char *bytes, size_t n) {
	while (n) {
		ssize_t w = write(fd, bytes, n);
		if (w < 0 && errno == EINTR) continue;
		if (w <= 0) return false;
		bytes += w;
		n -= (size_t)w;
	}
	return true;
}

static bool exactly(int fd, unsigned char *bytes, size_t n) {
	while (n) {
		ssize_t r = read(fd, bytes, n);
		if (r < 0 && errno == EINTR) continue;
		if (r <= 0) return false;
		bytes += r;
		n -= (size_t)r;
	}
	return true;
}

unsigned char *abiFrame(const Json *message, size_t *n, const char **why) {
	size_t size = 0;
	if (!cborEncode(message, NULL, 0, &size, why)) return NULL;
	if (size > ABI_MOST) {
		*why = "a frame larger than the ABI allows";
		return NULL;
	}
	unsigned char *frame = malloc(4 + size);
	for (int i = 0; i < 4; i++) frame[i] = (unsigned char)(size >> (8 * i));
	if (!cborEncode(message, frame + 4, size, &size, why)) {
		free(frame);
		return NULL;
	}
	*n = 4 + size;
	return frame;
}

Json *abiDecode(const unsigned char *body, size_t n, const char **why) {
	Json *message = cborDecode(body, n, why, NULL);
	if (message && !jsonIsObject(message)) {
		jsonFree(message);
		*why = "a frame that is not a map";
		return NULL;
	}
	return message;
}

bool abiWrite(int fd, const Json *message, const char **why) {
	size_t n = 0;
	unsigned char *frame = abiFrame(message, &n, why);
	if (!frame) return false;
	bool ok = all(fd, frame, n);
	if (!ok) *why = "the other end is gone";
	free(frame);
	return ok;
}

Json *abiRead(int fd, const char **why) {
	unsigned char head[4];
	if (!exactly(fd, head, 4)) {
		*why = "the other end is gone";
		return NULL;
	}
	size_t n = (size_t)head[0] | (size_t)head[1] << 8 | (size_t)head[2] << 16 | (size_t)head[3] << 24;
	if (n > ABI_MOST) {
		*why = "a frame larger than the ABI allows";
		return NULL;
	}
	unsigned char *body = malloc(n ? n : 1);
	if (!exactly(fd, body, n)) {
		free(body);
		*why = "the other end is gone";
		return NULL;
	}
	Json *message = abiDecode(body, n, why);
	free(body);
	return message;
}
