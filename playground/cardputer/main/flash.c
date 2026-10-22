// the den's place on flash (flash.h)
#include "flash.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "playground/cardputer/components/ermine/iovec.h"
#include "core/ed25519/c/ed25519.h"
#include "esp_partition.h"
#include "esp_random.h"
#include "esp_vfs_fat.h"
#include "nvs.h"

// the install's store: NVS's "install" namespace, a blob a name
static bool nvs_read(void *ctx, const char *name, uint8_t *out, size_t cap, size_t *length) {
	(void)ctx;
	nvs_handle_t h;
	if (nvs_open("install", NVS_READONLY, &h) != ESP_OK) return false;
	size_t n = 0;
	bool ok = nvs_get_blob(h, name, NULL, &n) == ESP_OK;
	if (ok && n <= cap) ok = nvs_get_blob(h, name, out, &n) == ESP_OK;
	nvs_close(h);
	if (ok) *length = n;
	return ok;
}

static bool nvs_write(void *ctx, const char *name, const uint8_t *data, size_t length) {
	(void)ctx;
	nvs_handle_t h;
	if (nvs_open("install", NVS_READWRITE, &h) != ESP_OK) return false;
	bool ok = nvs_set_blob(h, name, data, length) == ESP_OK && nvs_commit(h) == ESP_OK;
	nvs_close(h);
	return ok;
}

static bool public_key_of(void *ctx, const uint8_t secret[32], uint8_t out[32]) {
	(void)ctx;
	ermEd25519Public(secret, out);
	return true;
}

int flash_install(inst_install *out) {
	uint8_t random[INST_RANDOM];
	esp_fill_random(random, sizeof random);
	// the key littlesync made for this device, the den's key before tippet: the same den
	nvs_handle_t h;
	if (nvs_open("littlesync", NVS_READONLY, &h) == ESP_OK) {
		size_t n = 32;
		uint8_t seed[32];
		if (nvs_get_blob(h, "key", seed, &n) == ESP_OK && n == 32) memcpy(random, seed, 32);
		nvs_close(h);
	}
	inst_store store = {nvs_read, nvs_write, NULL};
	inst_public_key key = {public_key_of, NULL};
	return inst_open(&store, &key, NULL, random, out);
}

// where the "den" partition is when the partition table has none (sdkconfig's single-app-large: the
// app ends by 1.5 MB, so 4 MB on is free on the 8 MB chip): registered there at boot, the same place
// every time
#define SPARE_AT 0x400000
#define SPARE_SIZE 0x100000

int flash_mount(void) {
	static wl_handle_t wl = WL_INVALID_HANDLE;
	if (esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, "den") == NULL) {
		const esp_partition_t *p;
		esp_err_t e = esp_partition_register_external(NULL, SPARE_AT, SPARE_SIZE, "den", ESP_PARTITION_TYPE_DATA,
			ESP_PARTITION_SUBTYPE_DATA_FAT, &p);
		printf("flash: no \"den\" partition in the table: one at 0x%x registered: %s\n", SPARE_AT, esp_err_to_name(e));
	}
	esp_vfs_fat_mount_config_t c = {.format_if_mount_failed = true, .max_files = 3,
		.allocation_unit_size = CONFIG_WL_SECTOR_SIZE};
	esp_err_t e = esp_vfs_fat_spiflash_mount_rw_wl(FLASH_DIR, "den", &c, &wl);
	if (e != ESP_OK) printf("flash: not mounted: %s\n", esp_err_to_name(e));
	return e == ESP_OK;
}

// ESP-IDF names writev (sys/uio.h) but has none: tippet's store_file appends a record's length and
// the record with one, so here it gathers them and writes once (a record whole, or not)
int writev(int fd, const struct iovec *iov, int count) {
	size_t total = 0;
	for (int i = 0; i < count; i++) total += iov[i].iov_len;
	uint8_t *b = malloc(total ? total : 1);
	if (b == NULL) return -1;
	for (size_t i = 0, at = 0; i < (size_t)count; at += iov[i++].iov_len) memcpy(b + at, iov[i].iov_base, iov[i].iov_len);
	ssize_t wrote = write(fd, b, total);
	free(b);
	return (int)wrote;
}
