// the den's place on flash (flash.h)
#include "flash.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <strings.h>
#include <sys/stat.h>
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

static int mounted2;

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
	// "den2", when the table has it: made the first time
	static wl_handle_t wl2 = WL_INVALID_HANDLE;
	if (esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, "den2") != NULL) {
		esp_err_t e2 = esp_vfs_fat_spiflash_mount_rw_wl(FLASH_DIR2, "den2", &c, &wl2);
		mounted2 = e2 == ESP_OK;
		printf("flash: %s %s\n", FLASH_DIR2, mounted2 ? "mounted" : esp_err_to_name(e2));
	}
	return e == ESP_OK;
}

void flash_room_dir(const char *code, char out[16]) {
	struct stat st;
	snprintf(out, 16, "%s/t2%s", FLASH_DIR, code);
	if (stat(out, &st) != 0 && mounted2) snprintf(out, 16, "%s/t2%s", FLASH_DIR2, code);
}

size_t flash_free_for(const char *code) {
	char dir[16];
	flash_room_dir(code, dir);
	uint64_t total = 0, left = 0;
	return esp_vfs_fat_info(strncmp(dir, FLASH_DIR2, 2) == 0 ? FLASH_DIR2 : FLASH_DIR, &total, &left) == ESP_OK
		? (size_t)left : 0;
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

// the file system's bytes free, said
static void say_free(const char *when) {
	uint64_t total = 0, free_bytes = 0;
	if (esp_vfs_fat_info(FLASH_DIR, &total, &free_bytes) == ESP_OK)
		printf("flash: %s: %llu of %llu bytes free\n", when, (unsigned long long)free_bytes, (unsigned long long)total);
}

unsigned flash_sweep(const char *const *keep, int nkeep) {
	say_free("mounted");
	uint64_t total = 0, free_bytes = 0;
	esp_vfs_fat_info(FLASH_DIR, &total, &free_bytes);
	int low = free_bytes < FLASH_LOW;
	DIR *d = opendir(FLASH_DIR);
	if (d == NULL) return (unsigned)(free_bytes / 1024);
	struct dirent *e;
	char dir[300], file[600];
	while ((e = readdir(d)) != NULL) {
		if (strncasecmp(e->d_name, "t2", 2) == 0) {
			// a room's log: its files' bytes, said
			snprintf(dir, sizeof dir, "%s/%s", FLASH_DIR, e->d_name);
			DIR *in = opendir(dir);
			long total = 0;
			char each[160] = "";
			struct dirent *f;
			struct stat st;
			while (in && (f = readdir(in)) != NULL) {
				snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
				if (f->d_name[0] == '.' || stat(file, &st)) continue;
				total += (long)st.st_size;
				size_t l = strlen(each);
				snprintf(each + l, sizeof each - l, " %s %ld", f->d_name, (long)st.st_size);
			}
			if (in) closedir(in);
			printf("flash: %s: %ld bytes:%s\n", dir, total, each);
			int kept = 0;
			for (int i = 0; i < nkeep; i++) kept |= strcasecmp(e->d_name + 2, keep[i]) == 0;
			if (low && !kept) {
				snprintf(file, sizeof file, "%s/snapshot", dir);
				if (unlink(file) == 0) printf("flash: %s let go (the flash nearly full; made again there)\n", file);
			}
			continue;
		}
		if (e->d_name[0] == '.') continue;
		snprintf(dir, sizeof dir, "%s/%s", FLASH_DIR, e->d_name);
		DIR *in = opendir(dir);
		if (in == NULL) continue;
		struct dirent *f;
		while ((f = readdir(in)) != NULL) {
			if (f->d_name[0] == '.') continue;
			snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
			unlink(file);
		}
		closedir(in);
		printf("flash: %s let go (a log in tippet's old format, never read now): %s\n", dir,
			rmdir(dir) == 0 ? "done" : strerror(errno));
	}
	closedir(d);
	say_free("swept");
	if (mounted2 && (d = opendir(FLASH_DIR2)) != NULL) {
		while ((e = readdir(d)) != NULL) {
			if (e->d_name[0] == '.') continue;
			snprintf(dir, sizeof dir, "%s/%s", FLASH_DIR2, e->d_name);
			DIR *in = opendir(dir);
			long n = 0;
			struct dirent *f;
			struct stat st;
			while (in && (f = readdir(in)) != NULL) {
				snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
				if (f->d_name[0] != '.' && stat(file, &st) == 0) n += (long)st.st_size;
			}
			if (in) closedir(in);
			printf("flash: %s: %ld bytes\n", dir, n);
		}
		closedir(d);
		uint64_t t2 = 0, f2 = 0;
		if (esp_vfs_fat_info(FLASH_DIR2, &t2, &f2) == ESP_OK)
			printf("flash: %s: %llu of %llu bytes free\n", FLASH_DIR2, (unsigned long long)f2, (unsigned long long)t2);
	}
	esp_vfs_fat_info(FLASH_DIR, &total, &free_bytes);
	return (unsigned)(free_bytes / 1024);
}

// a file copied whole: 0, or -1 (what was made let go by the caller)
static int copy_file(const char *from, const char *to) {
	FILE *a = fopen(from, "rb"), *b = a ? fopen(to, "wb") : NULL;
	int ok = a && b;
	static uint8_t buf[2048];
	size_t n;
	while (ok && (n = fread(buf, 1, sizeof buf, a)) > 0) ok = fwrite(buf, 1, n, b) == n;
	if (a && ferror(a)) ok = 0;
	if (b) ok = fflush(b) == 0 && fsync(fileno(b)) == 0 && ok, ok = fclose(b) == 0 && ok;
	if (a) fclose(a);
	// read back the same
	if (ok) {
		a = fopen(from, "rb"), b = fopen(to, "rb");
		static uint8_t other[2048];
		size_t m;
		ok = a && b;
		while (ok && (n = fread(buf, 1, sizeof buf, a)) > 0) ok = (m = fread(other, 1, n, b)) == n && memcmp(buf, other, n) == 0;
		if (ok && fread(other, 1, 1, b) != 0) ok = 0;
		if (a) fclose(a);
		if (b) fclose(b);
	}
	return ok ? 0 : -1;
}

int flash_move(const char *code) {
	char from[16], tmp[24], to[16], f[48], t[48];
	snprintf(from, sizeof from, "%s/t2%s", FLASH_DIR, code);
	snprintf(to, sizeof to, "%s/t2%s", FLASH_DIR2, code);
	snprintf(tmp, sizeof tmp, "%s/t2%s.tmp", FLASH_DIR2, code);
	struct stat st;
	if (!mounted2 || stat(from, &st) != 0) return 0;
	// a copy left by a reset in the middle, let go; one finished, but the old not yet let go: go on
	DIR *d;
	struct dirent *e;
	if ((d = opendir(tmp)) != NULL) {
		while ((e = readdir(d)) != NULL) {
			snprintf(t, sizeof t, "%s/%s", tmp, e->d_name);
			if (e->d_name[0] != '.') unlink(t);
		}
		closedir(d);
		rmdir(tmp);
	}
	if (stat(to, &st) != 0) {
		if (mkdir(tmp, 0777) != 0 || (d = opendir(from)) == NULL) return -1;
		int ok = 1;
		while (ok && (e = readdir(d)) != NULL) {
			if (e->d_name[0] == '.') continue;
			snprintf(f, sizeof f, "%s/%s", from, e->d_name), snprintf(t, sizeof t, "%s/%s", tmp, e->d_name);
			ok = copy_file(f, t) == 0;
		}
		closedir(d);
		if (!ok || rename(tmp, to) != 0) {
			printf("flash: %s not copied to %s (%s): it stays where it is\n", from, FLASH_DIR2, strerror(errno));
			return -1;
		}
	}
	// the copy whole and in place: the old let go
	if ((d = opendir(from)) != NULL) {
		while ((e = readdir(d)) != NULL) {
			snprintf(f, sizeof f, "%s/%s", from, e->d_name);
			if (e->d_name[0] != '.') unlink(f);
		}
		closedir(d);
	}
	rmdir(from);
	printf("flash: %s moved to %s, whole\n", from, to);
	return 1;
}
