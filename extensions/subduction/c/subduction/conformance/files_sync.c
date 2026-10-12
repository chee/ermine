// files_sync.c: store_files.c's put syncs the folder a record is renamed
// into, so the rename survives a crash, not only the record's bytes. fsync
// is counted here, by whether it is given a folder.
#define _POSIX_C_SOURCE 200809L
#include <sys/stat.h>
#include <unistd.h>

static int folders, files;

static int counted(int fd) {
	struct stat about;
	if (fstat(fd, &about) == 0 && S_ISDIR(about.st_mode)) folders++;
	else files++;
	return 0;
}

#define fsync counted
#include "../store_files.c"
#undef fsync

int main(void) {
	char root[64];
	snprintf(root, sizeof root, "/tmp/erm-files-sync-%d", (int)getpid());
	ErmStore s;
	const char *error;
	if (ermStoreFiles(root, &s, &error) != 0) return 2;
	uint8_t tree[32] = {1}, id[32] = {2}, bytes[] = "record";
	if (s.put(s.self, ERM_STORE_COMMIT, tree, id, bytes, sizeof bytes) != 0) return 2;
	printf("files_sync: %d file fsyncs, %d folder fsyncs\n", files, folders);
	if (folders == 0) {
		fprintf(stderr, "files_sync: the folder a record was renamed into was never synced\n");
		return 1;
	}
	return 0;
}
