// Installs (typescript/installs.ts), in C: who this install is, the same on every start. An install
// is a key pair and the store it is saved in (a browser profile, an app's install, the cardputer),
// stable across restarts; a machine may have many. It has one root. What it is called: its key, as
// an ermine id ("ermine:ed01" + the key's hex), never chosen. Same rules as installs.ts, which the
// suite in playground/installs/conformance/installs/ holds both to.
//   - the store holds two things: "secret" (32 bytes) and "root" (an ermine id's bytes). The first
//     open of an empty store makes both and writes them, the secret first; every later open reads them
//   - what is stored is never made again: a secret not 32 bytes, or a root that is no ermine id, is
//     an error (a new secret would be a new install, and everything the old one signed another's)
//   - everything is read and checked, and the public key worked out and checked, before anything is
//     written, so an error leaves the store as it was
//   - two opens of an empty store at once each make a secret: the host opens one at a time
//
// The store and the key are the host's, handed in; the library knows no Ed25519. Randomness is the
// caller's: inst_open is handed the bytes a fresh secret and a fresh root would be made of.
//
//   inst_install me;
//   int code = inst_open(&store, &public_key, NULL, random, &me);   // random: INST_RANDOM bytes
#ifndef INSTALLS_H
#define INSTALLS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../../ermine/ids/c/ids.h"

#define INST_SECRET "secret"
#define INST_ROOT "root"

// the bytes a secret (32) and a fresh root (16) are made of
#define INST_RANDOM 48

// the store, by name: bytes. read: false when there is none; else the first cap bytes in out and
// *length the whole length (it may be more than cap). write: false when it failed
typedef struct {
	bool (*read)(void *ctx, const char *name, uint8_t *out, size_t cap, size_t *length);
	bool (*write)(void *ctx, const char *name, const uint8_t *data, size_t length);
	void *ctx;
} inst_store;

// a secret's Ed25519 public key, 32 bytes; false when it cannot be worked out
typedef struct {
	bool (*public_key_of)(void *ctx, const uint8_t secret[32], uint8_t out[32]);
	void *ctx;
} inst_public_key;

typedef struct {
	// "ermine:ed01…", the same every time this store is opened
	char id[ID_TEXT];
	// the public key
	uint8_t key[32];
	uint8_t secret[32];
	// "ermine:0010…", made the first time (or the root given then)
	char root[ID_TEXT];
} inst_install;

typedef enum {
	INST_OK,
	INST_BAD_GIVEN,
	INST_BAD_SECRET,
	INST_BAD_ROOT,
	INST_BAD_KEY,
	INST_FAILED
} inst_code;

// why a code is an error, as installs.ts says it; "" for INST_OK
const char *inst_error(int code);

// the install of the store. root: the root an empty store's install has (text; NULL: a fresh id from
// random); a store with a root keeps its own. nothing is written on an error
int inst_open(const inst_store *store, const inst_public_key *public_key, const char *root, const uint8_t random[INST_RANDOM],
	inst_install *out);

#endif
