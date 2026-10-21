// store.h: where Subduction keeps what it holds (subduction_core's Storage),
// given by the host to the library (erm_sd_new) as a small table of
// functions: the backend is chosen when the program runs (--store), and a
// host may run more than one node, each with its own.
//
// Four kinds of record, each 32-byte keyed, the bytes Subduction's own
// encodings (the store treats them as bytes):
//
//   ERM_STORE_TREE      a sedimentree id it holds              key: the id          bytes: none
//   ERM_STORE_COMMIT    a loose commit of a tree              key: tree, commit id  bytes: Signed<LooseCommit>
//   ERM_STORE_FRAGMENT  a fragment of a tree                  key: tree, its head   bytes: Signed<Fragment>
//   ERM_STORE_BLOB      a commit's or fragment's blob         key: its digest       bytes: the blob
//
// A blob is kept by its digest (BLAKE3), across trees; the library puts a
// commit's or fragment's blob before the commit or fragment, so one that is
// there has its blob. `tree` is NULL for TREE and BLOB.
//
// Backends: store_memory.c (tests, the default), store_files.c (a folder of
// files, desktop). A board's would keep the same records in flash (NOTES.md).

#ifndef ERM_STORE_H
#define ERM_STORE_H

#include <stddef.h>
#include <stdint.h>

enum { ERM_STORE_TREE = 0, ERM_STORE_COMMIT = 1, ERM_STORE_FRAGMENT = 2, ERM_STORE_BLOB = 3 };

typedef struct ErmStore {
	void *self;
	/** keeps bytes under (kind, tree, id), replacing what was there: 0, or -1 when it could not */
	int (*put)(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length);
	/**
	 * what is kept under (kind, tree, id): 1, with *bytes from erm_host_malloc
	 * (the caller frees it with erm_host_free; NULL for no bytes) and *length;
	 * 0 when nothing is; -1 when it could not read
	 */
	int (*get)(void *self, int kind, const uint8_t *tree, const uint8_t id[32], uint8_t **bytes, size_t *length);
	/** each(context, id) for every id kept of the kind (in the tree): 0, or -1 */
	int (*list)(void *self, int kind, const uint8_t *tree, void (*each)(void *context, const uint8_t id[32]), void *context);
	/** forgets (kind, tree, id), or with id NULL every id of the kind in the tree: 0, or -1 */
	int (*remove)(void *self, int kind, const uint8_t *tree, const uint8_t *id);
} ErmStore;

/** a store in memory, empty, never freed (store_memory.c) */
ErmStore ermStoreMemory(void);

/** a store in the folder root, made if it is not there (store_files.c): 0, or -1 with why in *error */
int ermStoreFiles(const char *root, ErmStore *out, const char **error);

#endif
