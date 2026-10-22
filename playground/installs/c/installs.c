// Installs (installs.h), after typescript/installs.ts.
#include "installs.h"

#include <string.h>

const char *inst_error(int code) {
	switch (code) {
	case INST_BAD_GIVEN: return "the root given is not an ermine id";
	case INST_BAD_SECRET: return "the stored secret is not 32 bytes";
	case INST_BAD_ROOT: return "the stored root is not an ermine id";
	case INST_BAD_KEY: return "an Ed25519 public key is 32 bytes";
	case INST_FAILED: return "the store could not write";
	default: return "";
	}
}

int inst_open(const inst_store *store, const inst_public_key *public_key, const char *root, const uint8_t random[INST_RANDOM],
	inst_install *out) {
	uint8_t given[ID_MAX], secret[32], stored[ID_MAX];
	size_t given_length = 0, length;
	if (root != NULL) {
		given_length = id_parse(root, strlen(root), given);
		if (given_length == 0) return INST_BAD_GIVEN;
	}
	// a stored secret is read with room for one byte more: a longer one is not 32 either
	uint8_t read_secret[33];
	bool has_secret = store->read(store->ctx, INST_SECRET, read_secret, sizeof read_secret, &length);
	if (has_secret) {
		if (length != 32) return INST_BAD_SECRET;
		memcpy(secret, read_secret, 32);
	}
	size_t root_length = 0;
	uint8_t read_root[ID_MAX + 1];
	bool has_root = store->read(store->ctx, INST_ROOT, read_root, sizeof read_root, &root_length);
	if (has_root) {
		if (root_length > ID_MAX || id_kind_of(read_root, root_length) == ID_NONE) return INST_BAD_ROOT;
		memcpy(stored, read_root, root_length);
	}
	// what is missing is made in memory, and the key worked out and checked, before anything is written
	if (!has_secret) memcpy(secret, random, 32);
	if (!has_root) {
		if (given_length > 0) {
			memcpy(stored, given, given_length);
			root_length = given_length;
		} else {
			id_fresh(random + 32, stored);
			root_length = ID_SHORT;
		}
	}
	uint8_t raw[32], id[34] = {0xed, 0x01};
	if (!public_key->public_key_of(public_key->ctx, secret, raw)) return INST_BAD_KEY;
	if (!has_secret && !store->write(store->ctx, INST_SECRET, secret, 32)) return INST_FAILED;
	if (!has_root && !store->write(store->ctx, INST_ROOT, stored, root_length)) return INST_FAILED;
	memcpy(id + 2, raw, 32);
	memcpy(out->key, raw, 32);
	memcpy(out->secret, secret, 32);
	id_text(id, sizeof id, out->id);
	id_text(stored, root_length, out->root);
	return INST_OK;
}
