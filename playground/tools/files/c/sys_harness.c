// sys_harness: checks of sys.c's Trash (sys_trash_in, sys_trash_xdg, sys_fake) in a folder of its own, each against a home or
// data folder the check makes. It never calls sys_trash, so it never touches the person's Trash or asks Finder. The suites
// do not reach these; this is their test. Run it with any argument (the Makefile gives one); exit 0 when all hold.
#include "sys.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int failures;
#define CHECK(condition) \
	do { \
		if (!(condition)) fprintf(stderr, "sys_harness: %s:%d: %s\n", __FILE__, __LINE__, #condition), failures++; \
	} while (0)

static char *fmt(const char *format, const char *a, const char *b) {
	size_t room = strlen(format) + strlen(a) + strlen(b) + 1;
	char *s = malloc(room);
	if (!s) abort();
	snprintf(s, room, format, a, b);
	return s;
}

static void write_file(const char *path, const char *text) {
	FILE *f = fopen(path, "w");
	if (!f) abort();
	fputs(text, f), fclose(f);
}

static char *read_file(const char *path) {
	FILE *f = fopen(path, "r");
	if (!f) return NULL;
	char *s = calloc(1, 1024);
	size_t n = fread(s, 1, 1023, f);
	s[n] = 0;
	fclose(f);
	return s;
}

static int compare(const void *a, const void *b) {
	return strcmp(*(char *const *)a, *(char *const *)b);
}

// the names in a folder, sorted, as "a,b,c"
static char *names(const char *dir) {
	char *list[64];
	int n = 0;
	DIR *d = opendir(dir);
	if (!d) return strdup("");
	for (struct dirent *e; (e = readdir(d));)
		if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) list[n++] = strdup(e->d_name);
	closedir(d);
	qsort(list, (size_t)n, sizeof *list, compare);
	char *out = calloc(1, 1024);
	for (int i = 0; i < n; i++) strcat(out, i ? "," : ""), strcat(out, list[i]), free(list[i]);
	return out;
}

static void expect_names(const char *dir, const char *want) {
	char *got = names(dir);
	if (strcmp(got, want) != 0) fprintf(stderr, "sys_harness: %s holds [%s], not [%s]\n", dir, got, want), failures++;
	free(got);
}

static void expect_text(const char *path, const char *want) {
	char *got = read_file(path);
	if (!got || strcmp(got, want) != 0) fprintf(stderr, "sys_harness: %s holds [%s], not [%s]\n", path, got ? got : "(none)", want), failures++;
	free(got);
}

// the fake Trash: under its own name, then "stem 2.ext", and a dotfile whole
static void fake(const char *root) {
	char *store = fmt("%s/%s", root, "fakestore"), *bin = fmt("%s/%s", root, "fakebin");
	mkdir(store, 0777);
	char *a = fmt("%s/%s", store, "clock.txt"), *dot = fmt("%s/%s", store, ".hidden");
	write_file(a, "1");
	CHECK(sys_fake(bin, a) == 0);
	write_file(a, "2");
	CHECK(sys_fake(bin, a) == 0);
	write_file(dot, "3");
	CHECK(sys_fake(bin, dot) == 0);
	expect_names(bin, ".hidden,clock 2.txt,clock.txt");
	CHECK(sys_fake(bin, a) == -1 && errno == ENOENT);
	free(store), free(bin), free(a), free(dot);
}

// a given home's Trash: macOS's .Trash, under a free name, a link itself
#ifndef __linux__
static void bin(const char *root) {
	char *home = fmt("%s/%s", root, "home"), *store = fmt("%s/%s", root, "Store");
	mkdir(home, 0777), mkdir(store, 0777);
	char *file = fmt("%s/%s", store, "clock.txt"), *one = fmt("%s/%s", store, "1.txt"), *link = fmt("%s/%s", store, "pinned.txt");
	char *trash = fmt("%s/%s", home, ".Trash");
	write_file(file, "12:30");
	CHECK(sys_set(file, SYS_ID, (const uint8_t *)"c", 1) == 0);
	uint64_t id = 0, after = 0;
	CHECK(sys_id(file, &id) == 0);
	CHECK(sys_trash_in(home, file) == 0);
	write_file(file, "13:00");
	CHECK(sys_trash_in(home, file) == 0);
	write_file(one, "hello");
	CHECK(symlink("1.txt", link) == 0);
	CHECK(sys_trash_in(home, link) == 0);
	expect_names(store, "1.txt");
	expect_names(trash, "clock 2.txt,clock.txt,pinned.txt");
	char *kept = fmt("%s/%s", trash, "clock.txt"), *moved = fmt("%s/%s", trash, "pinned.txt");
	expect_text(kept, "12:30");
	CHECK(sys_id(kept, &after) == 0 && after == id);
	uint8_t *value;
	size_t length;
	CHECK(sys_get(kept, SYS_ID, &value, &length) == 0 && length == 1 && value[0] == 'c');
	free(value);
	char target[16] = {0};
	CHECK(readlink(moved, target, sizeof target - 1) > 0 && strcmp(target, "1.txt") == 0);
	char *missing = fmt("%s/%s", store, "missing");
	CHECK(sys_trash_in(home, missing) == -1 && errno == ENOENT);
	free(home), free(store), free(file), free(one), free(link), free(trash), free(kept), free(moved), free(missing);
}
#endif

// the freedesktop.org trash in a data folder of the check's
static void xdg(const char *root) {
	char *data = fmt("%s/%s", root, "data"), *store = fmt("%s/%s", root, "xdgstore");
	mkdir(data, 0777), mkdir(store, 0777);
	char *file = fmt("%s/%s", store, "my notes.txt"), *files = fmt("%s/%s", data, "Trash/files"), *info = fmt("%s/%s", data, "Trash/info");
	write_file(file, "a");
	CHECK(sys_trash_xdg(data, file) == 0);
	write_file(file, "b");
	CHECK(sys_trash_xdg(data, file) == 0);
	expect_names(store, "");
	expect_names(files, "my notes 2.txt,my notes.txt");
	expect_names(info, "my notes 2.txt.trashinfo,my notes.txt.trashinfo");
	char *first = fmt("%s/%s", files, "my notes.txt"), *second = fmt("%s/%s", files, "my notes 2.txt");
	expect_text(first, "a"), expect_text(second, "b");
	char *text = fmt("%s/%s", info, "my notes.txt.trashinfo");
	char *got = read_file(text);
	char *want = fmt("[Trash Info]\nPath=%s/my%%20notes.txt\nDeletionDate=", store, "");
	CHECK(got && strncmp(got, want, strlen(want)) == 0);
	// DeletionDate=YYYY-MM-DDTHH:MM:SS\n
	CHECK(got && strlen(got) == strlen(want) + 20 && got[strlen(got) - 1] == '\n' && got[strlen(want) + 10] == 'T');
	// a folder, and nothing: the missing one claims no info file
	char *folder = fmt("%s/%s", store, "docs"), *missing = fmt("%s/%s", store, "missing");
	mkdir(folder, 0777);
	CHECK(sys_trash_xdg(data, folder) == 0);
	CHECK(sys_trash_xdg(data, missing) == -1 && errno == ENOENT);
	expect_names(info, "docs.trashinfo,my notes 2.txt.trashinfo,my notes.txt.trashinfo");
	free(data), free(store), free(file), free(files), free(info), free(first), free(second), free(text), free(got), free(want);
	free(folder), free(missing);
}

int main(void) {
	char root[] = "/tmp/ermine-sys-XXXXXX";
	if (!mkdtemp(root)) return 2;
	fake(root);
#ifndef __linux__
	bin(root);
#endif
	xdg(root);
	char *rm = fmt("rm -rf '%s'%s", root, "");
	CHECK(system(rm) == 0);
	free(rm);
	puts(failures ? "failed" : "ok");
	return failures != 0;
}
