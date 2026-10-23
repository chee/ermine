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
static wl_handle_t wl1 = WL_INVALID_HANDLE, wl2 = WL_INVALID_HANDLE;

int flash_mount(void) {
	wl_handle_t wl = WL_INVALID_HANDLE;
	if (esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, "den") == NULL) {
		const esp_partition_t *p;
		esp_err_t e = esp_partition_register_external(NULL, SPARE_AT, SPARE_SIZE, "den", ESP_PARTITION_TYPE_DATA,
			ESP_PARTITION_SUBTYPE_DATA_FAT, &p);
		printf("flash: no \"den\" partition in the table: one at 0x%x registered: %s\n", SPARE_AT, esp_err_to_name(e));
	}
	esp_vfs_fat_mount_config_t c = {.format_if_mount_failed = true, .max_files = 3,
		.allocation_unit_size = CONFIG_WL_SECTOR_SIZE};
	esp_err_t e = esp_vfs_fat_spiflash_mount_rw_wl(FLASH_DIR, "den", &c, &wl);
	wl1 = wl;
	if (e != ESP_OK) printf("flash: not mounted: %s\n", esp_err_to_name(e));
	// "den2", when the table has it: made the first time
	if (esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, "den2") != NULL) {
		esp_err_t e2 = esp_vfs_fat_spiflash_mount_rw_wl(FLASH_DIR2, "den2", &c, &wl2);
		mounted2 = e2 == ESP_OK;
		printf("flash: %s %s\n", FLASH_DIR2, mounted2 ? "mounted" : esp_err_to_name(e2));
	}
	return e == ESP_OK;
}

// once settled (flash_settle): the volume let go, the rooms on it and its bytes free, as they were
static int settled;
static char away[24][5];
static unsigned away_kb[24];
static int naway;
static size_t away_free;
static const char *gone_dir;

void flash_room_dir(const char *code, char out[16]) {
	struct stat st;
	if (settled) {
		for (int i = 0; i < naway; i++)
			if (strcasecmp(away[i], code) == 0) {
				snprintf(out, 16, "%s/t2%s", gone_dir, code);
				return;
			}
		// not on the one let go: on the one mounted, made there when new
		snprintf(out, 16, "%s/t2%s", strcmp(gone_dir, FLASH_DIR) == 0 ? FLASH_DIR2 : FLASH_DIR, code);
		return;
	}
	snprintf(out, 16, "%s/t2%s", FLASH_DIR, code);
	if (stat(out, &st) != 0 && mounted2) snprintf(out, 16, "%s/t2%s", FLASH_DIR2, code);
}

size_t flash_free_for(const char *code) {
	char dir[16];
	flash_room_dir(code, dir);
	const char *base = strncmp(dir, FLASH_DIR2, 2) == 0 ? FLASH_DIR2 : FLASH_DIR;
	if (settled && strcmp(base, gone_dir) == 0) return away_free;
	uint64_t total = 0, left = 0;
	return esp_vfs_fat_info(base, &total, &left) == ESP_OK ? (size_t)left : 0;
}

// a room's folder's files, in K (rounded up)
static unsigned room_kb(const char *base, const char *name) {
	char dir[300], file[600];
	snprintf(dir, sizeof dir, "%s/%s", base, name);
	DIR *d = opendir(dir);
	struct dirent *f;
	struct stat st;
	long n = 0;
	while (d && (f = readdir(d)) != NULL) {
		snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
		if (f->d_name[0] != '.' && stat(file, &st) == 0) n += (long)st.st_size;
	}
	if (d) closedir(d);
	return (unsigned)((n + 1023) / 1024);
}

int flash_rooms(flash_room *out, int most) {
	int n = 0;
	const char *bases[2] = {FLASH_DIR, FLASH_DIR2};
	for (int b = 0; b < 2; b++) {
		const char *base = bases[b];
		if (b == 1 && !mounted2) continue;
		if (settled && strcmp(base, gone_dir) == 0) continue;
		DIR *d = opendir(base);
		struct dirent *e;
		while (d && (e = readdir(d)) != NULL && n < most) {
			if (strncasecmp(e->d_name, "t2", 2) != 0 || strlen(e->d_name) != 6 || strchr(e->d_name, '.')) continue;
			snprintf(out[n].code, 5, "%s", e->d_name + 2);
			out[n].kb = room_kb(base, e->d_name);
			snprintf(out[n].fs, sizeof out[n].fs, "%s", base);
			n++;
		}
		if (d) closedir(d);
	}
	for (int i = 0; settled && i < naway && n < most; i++) {
		snprintf(out[n].code, 5, "%s", away[i]);
		out[n].kb = away_kb[i];
		snprintf(out[n].fs, sizeof out[n].fs, "%s", gone_dir);
		n++;
	}
	return n;
}

// every file in dir let go, then dir: 0, or -1 (errno)
static int remove_all(const char *dir) {
	DIR *d = opendir(dir);
	if (d == NULL) return errno == ENOENT ? 0 : -1;
	struct dirent *f;
	char file[64];
	int bad = 0;
	while ((f = readdir(d)) != NULL) {
		if (f->d_name[0] == '.') continue;
		snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
		if (unlink(file) != 0) bad = 1;
	}
	closedir(d);
	return bad || rmdir(dir) != 0 ? -1 : 0;
}

int flash_delete(const char *code, unsigned *left, char *why, size_t cap) {
	// on the file system let go for the heap: mounted again for it (about 10 KB, for a moment)
	int there = -1;
	for (int i = 0; settled && i < naway; i++)
		if (strcasecmp(away[i], code) == 0) there = i;
	const char *base = NULL;
	wl_handle_t wl = WL_INVALID_HANDLE;
	if (there >= 0) {
		esp_vfs_fat_mount_config_t c = {.format_if_mount_failed = false, .max_files = 3,
			.allocation_unit_size = CONFIG_WL_SECTOR_SIZE};
		esp_err_t e = esp_vfs_fat_spiflash_mount_rw_wl(gone_dir, strcmp(gone_dir, FLASH_DIR) == 0 ? "den" : "den2", &c, &wl);
		if (e != ESP_OK) return snprintf(why, cap, "%s won't mount: %s", gone_dir, esp_err_to_name(e)), -1;
		base = gone_dir;
	} else {
		char dir[16];
		flash_room_dir(code, dir);
		base = strncmp(dir, FLASH_DIR2, 2) == 0 ? FLASH_DIR2 : FLASH_DIR;
	}
	char dir[24], tmp[24];
	snprintf(dir, sizeof dir, "%s/t2%s", base, code);
	snprintf(tmp, sizeof tmp, "%s/t2%s.tmp", base, code);
	struct stat st;
	int ok = stat(dir, &st) == 0;
	if (!ok) snprintf(why, cap, "it isn't on %s", base);
	else if (remove_all(dir) != 0) ok = 0, snprintf(why, cap, "%s", strerror(errno));
	remove_all(tmp);
	uint64_t total = 0, free_bytes = 0;
	esp_vfs_fat_info(base, &total, &free_bytes);
	*left = (unsigned)(free_bytes / 1024);
	if (there >= 0) {
		esp_vfs_fat_spiflash_unmount_rw_wl(base, wl);
		away_free = (size_t)free_bytes;
		if (ok) {
			memmove(away[there], away[there + 1], (size_t)(naway - there - 1) * sizeof away[0]);
			memmove(&away_kb[there], &away_kb[there + 1], (size_t)(naway - there - 1) * sizeof away_kb[0]);
			naway--;
		}
	}
	return ok ? 0 : -1;
}

int flash_room_there(const char *code) {
	for (int i = 0; settled && i < naway; i++)
		if (strcasecmp(away[i], code) == 0) return 1;
	char dir[16];
	struct stat st;
	flash_room_dir(code, dir);
	return stat(dir, &st) == 0;
}

void flash_settle(const char *room) {
	if (!mounted2 || settled) return;
	char dir[16];
	flash_room_dir(room, dir);
	int on2 = strncmp(dir, FLASH_DIR2, 2) == 0;
	const char *other = on2 ? FLASH_DIR : FLASH_DIR2;
	DIR *d = opendir(other);
	struct dirent *e;
	while (d && (e = readdir(d)) != NULL && naway < 24)
		if (strncasecmp(e->d_name, "t2", 2) == 0 && strlen(e->d_name) == 6 && !strchr(e->d_name, '.')) {
			snprintf(away[naway], 5, "%s", e->d_name + 2);
			away_kb[naway++] = room_kb(other, e->d_name);
		}
	if (d) closedir(d);
	uint64_t total = 0, left = 0;
	esp_vfs_fat_info(other, &total, &left);
	away_free = (size_t)left;
	esp_err_t x = esp_vfs_fat_spiflash_unmount_rw_wl(other, on2 ? wl1 : wl2);
	if (x != ESP_OK) {
		printf("flash: %s not let go: %s\n", other, esp_err_to_name(x));
		naway = 0;
		return;
	}
	gone_dir = other, settled = 1;
	if (on2) wl1 = WL_INVALID_HANDLE;
	else wl2 = WL_INVALID_HANDLE, mounted2 = 0;
	printf("flash: %s let go for the heap (the room is on %s); %d rooms there\n", other, on2 ? FLASH_DIR2 : FLASH_DIR, naway);
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
	(void)keep, (void)nkeep;
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
