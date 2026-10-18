// a file store (littlesync.h): one file per name in a directory. For a Mac or a test, not a device
#include "littlesync.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

// the file for a name: anything but letters, digits, . and - becomes _
static void path_of(const char *dir, const char *name, char *out, size_t size) {
	size_t n = (size_t)snprintf(out, size, "%s/", dir);
	for (; *name && n + 1 < size; name++)
		out[n++] = (*name >= 'a' && *name <= 'z') || (*name >= 'A' && *name <= 'Z') || (*name >= '0' && *name <= '9') ||
				*name == '.' || *name == '-' ? *name : '_';
	out[n] = 0;
}

static int load(void *context, const char *name, uint8_t **out, size_t *length) {
	char path[1024];
	path_of(context, name, path, sizeof path);
	FILE *f = fopen(path, "rb");
	if (f == NULL) return 0;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	uint8_t *b = malloc(n > 0 ? (size_t)n : 1);
	if (b == NULL || (n > 0 && fread(b, 1, (size_t)n, f) != (size_t)n)) {
		free(b);
		fclose(f);
		return 0;
	}
	fclose(f);
	*out = b;
	*length = (size_t)n;
	return 1;
}

static int save(void *context, const char *name, const uint8_t *data, size_t length) {
	char path[1024], tmp[1100];
	path_of(context, name, path, sizeof path);
	snprintf(tmp, sizeof tmp, "%s.tmp", path);
	FILE *f = fopen(tmp, "wb");
	if (f == NULL) return 0;
	int ok = fwrite(data, 1, length, f) == length;
	ok = fclose(f) == 0 && ok;
	return ok && rename(tmp, path) == 0;
}

ls_store ls_store_file(const char *dir) {
	// each part of the path, made if it is not there
	char part[1024];
	snprintf(part, sizeof part, "%s", dir);
	for (char *p = part + 1; *p; p++)
		if (*p == '/') {
			*p = 0;
			mkdir(part, 0755);
			*p = '/';
		}
	mkdir(part, 0755);
	return (ls_store){load, save, strdup(dir)};
}

void ls_store_file_free(ls_store *store) {
	free(store->context);
	store->context = NULL;
}
