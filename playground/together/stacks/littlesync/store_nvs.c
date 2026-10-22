// an NVS store (littlesync.h), for ESP-IDF: a blob for each name, under a key made of the name's hash
// (NVS keys are 15 characters at most). A node's blob is its seals: a few hundred bytes each, so the
// NVS partition wants room for them (the default 24 KB holds about 40 nodes of a map of 4 numbers, a
// lab-pig pig)
#ifdef ESP_PLATFORM
#include "littlesync.h"

#include "../../../../playground/encoding/c/commit.h"

#include "nvs.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
	nvs_handle_t handle;
} space;

static void key_of(const char *name, char key[16]) {
	uint8_t h[32];
	cm_digest((const uint8_t *)name, strlen(name), h);
	key[0] = 'k';
	for (int i = 0; i < 7; i++) sprintf(key + 1 + 2 * i, "%02x", h[i]);
}

static int load(void *context, const char *name, uint8_t **out, size_t *length) {
	space *s = context;
	char key[16];
	key_of(name, key);
	size_t n = 0;
	if (nvs_get_blob(s->handle, key, NULL, &n) != ESP_OK) return 0;
	uint8_t *b = malloc(n ? n : 1);
	if (b == NULL) return 0;
	if (nvs_get_blob(s->handle, key, b, &n) != ESP_OK) {
		free(b);
		return 0;
	}
	*out = b;
	*length = n;
	return 1;
}

static int save(void *context, const char *name, const uint8_t *data, size_t length) {
	space *s = context;
	char key[16];
	key_of(name, key);
	return nvs_set_blob(s->handle, key, data, length) == ESP_OK && nvs_commit(s->handle) == ESP_OK;
}

ls_store ls_store_nvs(const char *space_name) {
	space *s = calloc(1, sizeof *s);
	if (s == NULL || nvs_open(space_name, NVS_READWRITE, &s->handle) != ESP_OK) {
		free(s);
		return (ls_store){0};
	}
	return (ls_store){load, save, s};
}
#endif
