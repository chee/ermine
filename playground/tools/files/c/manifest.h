// The manifest's folder, .ermine (newcore/files/FILES.tex, The manifest), in C. Same functions as
// manifest.ts (the header there has the format): the log of frames in "manifest", each value kept
// once in "values/<hex>", "tmp/" for what is being written, and "id/", always empty.
//
// Values are json.h's, nodes pack's form (nodes/c/node.h) with each content, change, because,
// actor and cause a Json *, records bytes. A record that is a layout, a plan, a step list or the
// store record is a Json in the TS type's shape (hashes as 64 hex digits, a layout's entries an
// object). A hash is BLAKE3 as 64 lowercase hex digits.
//
// Values are never freed (json.h): what a function returns as a Json is the caller's to free only
// where it says so; the node a restore gives and the values in it are not freed by anyone.
//
// The folder is written with POSIX calls in the order manifest.ts makes them; sync is told each
// path it must sync, in order, so a host can record them or a test can.
#ifndef MANIFEST_H
#define MANIFEST_H

#include "../../../ermine/encoding/c/json.h"
#include "saved_pack.h"
#include "saved.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// a bin value's first bytes kept in a shape: names.ts's HEAD
#define MF_HEAD 12
// a log's default slack: how far past four times what it holds it may grow
#define MF_SLACK (1 << 20)

typedef enum {
	MF_OK,
	MF_STORE, // StoreError: what is kept is not a store's, or is missing or wrong
	MF_FORM,  // FormError: a file that does not read as its form
	MF_WRONG, // render: a value not in the form given, or with no notation
	MF_IO,    // a call failed: errno is its
} mf_code;

// a hash and form, as 64 hex digits and a static name; a bin value's first bytes when there are some
typedef struct {
	char hash[65];
	const char *form;
	bool has_head;
	uint8_t *head;
	size_t head_length;
} mf_kept;
typedef char mf_hex[65];

// values ---------------------------------------------------------------------------------------

// the form a value is kept and shown in: txt, bin, a typed array's kind, else cbor
const char *mf_form(const Json *value);
// a value's file in its form: UTF-8, the bytes, the elements little-endian, or diagnostic
// notation for cbor, appended to out. MF_WRONG for a value not in the form
mf_code mf_render(const Json *value, const char *form, sp_bytes *out);
// the value a file holds in its form, a new value (it is the caller's). MF_FORM when it does not
// read: text not UTF-8, notation that does not parse, bytes that are not whole elements
mf_code mf_parse(const uint8_t *bytes, size_t length, const char *form, Json **out);
void mf_digest(const uint8_t *bytes, size_t length, char out[65]);
// the BLAKE3 of the value's deterministic CBOR; false when it has none
bool mf_hash(const Json *value, char out[65]);
// null's hash
void mf_null(char out[65]);
// a content's hash and form; false for one with no encoding (head is not set)
bool mf_keptof(const Json *content, mf_kept *out);

// node records ---------------------------------------------------------------------------------

typedef bool (*mf_skip)(void *context, const char *id);
typedef struct {
	char hash[65];
	const Json *value; // the node's
} mf_value;

typedef struct {
	char *name;
	char hash[65];
	const char *form;
} mf_info;
typedef struct {
	char *name;
	char **ids;
	size_t length;
} mf_slot;
// a node as the layout needs it
typedef struct {
	mf_kept kept;
	mf_kept *sides;
	size_t sides_length;
	mf_info *info;
	size_t info_length;
	mf_slot *directory;
	size_t directory_length;
} mf_node;
void mf_shape_free(mf_node *shape);

typedef struct {
	sp_bytes record; // free(record.data)
	mf_value *values; // sorted by hash
	size_t values_length;
	mf_node shape;
} mf_saving;
// a node's record, as pack writes it, each value's and info's content kept by its hash. A
// version whose content has no encoding is left out, as is each symbol and each id skip says yes
// to in a list. A change, because or header with no encoding: MF_STORE. skip may be NULL
mf_code mf_save(const sd_node *node, mf_skip skip, void *context, mf_saving *out);
void mf_saving_free(mf_saving *saving);
// as mf_save, with the shape left out: mf_saving_shape builds it, for a record that is kept
mf_code mf_save_record(const sd_node *node, mf_skip skip, void *context, mf_saving *out);
mf_code mf_saving_shape(mf_saving *saving);

// each [hash, form] a record keeps, in order: its value's versions, then each info's. free(*out)
mf_code mf_kepts(const uint8_t *record, size_t length, mf_kept **out, size_t *count);

// the value of a hash, or NULL when there is none (MF_STORE)
typedef const Json *(*mf_values)(void *context, const char *hash);
// the node a record keeps, each content from values; out as sp_decode gives it: nodes[0], sp_free it
mf_code mf_restore(const uint8_t *record, size_t length, mf_values values, void *context, sp_graph *out);

// a record decoded once, to give its kepts and then restore it: mf_open_record checks it and gives each
// [hash, form] it keeps, free(*kepts); mf_restore_opened is mf_restore on it, which uses it up
typedef struct {
	Json *record;
} mf_opened;
mf_code mf_open_record(const uint8_t *record, size_t length, mf_opened *out, mf_kept **kepts, size_t *count);
mf_code mf_restore_opened(mf_opened *opened, mf_values values, void *context, sp_graph *out);

// a bin value's first bytes by its hash: true and head, length when there are some
typedef bool (*mf_heads)(void *context, const char *hash, const uint8_t **head, size_t *length);
// a node's shape from its record: its first value's kept, or null's, each later version's, each
// info's first version, and each child name's first list, empty ones left out
mf_code mf_shape(const uint8_t *record, size_t length, mf_heads heads, void *context, mf_node *out);

// the other records ----------------------------------------------------------------------------

typedef enum { MF_META, MF_SHOWN, MF_PLAN, MF_STATE } mf_codec;
// a record's deterministic CBOR, appended to out; MF_STORE for one that is not
mf_code mf_encode(mf_codec codec, const Json *record, sp_bytes *out);
// a record from its CBOR, a new value (free it with jsonFree); MF_STORE for bytes that are not one
mf_code mf_decode(mf_codec codec, const uint8_t *bytes, size_t length, Json **record);

// a record of the log: its key (C text) and bytes; in a frame, data NULL says the key goes
typedef struct {
	const char *key;
	const uint8_t *data;
	size_t length;
} mf_record;
void mf_records_free(mf_record *records, size_t count);

// the hashes the records name: each node's, and each file and info a plan has; sorted, once each.
// free(*hashes)
mf_code mf_named(const mf_record *records, size_t count, mf_hex **hashes, size_t *length);

// the folder ------------------------------------------------------------------------------------

typedef struct mf_manifest mf_manifest;
// sync is given each absolute path to sync (the folder dir, a file in it) and returns 0, or -1
// with errno; NULL: F_FULLFSYNC of it, else fsync
typedef int (*mf_sync)(void *context, const char *path);
// the manifest in the folder dir, touching nothing
mf_manifest *mf_open(const char *dir, mf_sync sync, void *context, size_t slack);
void mf_close(mf_manifest *manifest);
// makes the folder and values/, tmp/ and id/ in it, if missing
mf_code mf_make(mf_manifest *manifest);
// as mf_make; kept false: a mirror's, with no values/ (nothing is kept)
mf_code mf_make_kept(mf_manifest *manifest, bool kept);
// whether it has a manifest file
mf_code mf_exists(mf_manifest *manifest, bool *exists);
// every frame, folded into records; a last frame cut short is dropped; a broken one before it:
// MF_STORE. Changes nothing on disk. mf_records_free(*records, *count)
mf_code mf_read(mf_manifest *manifest, mf_record **records, size_t *count);
// appends one frame, synced, cutting off first a last frame read as cut short
mf_code mf_append(mf_manifest *manifest, const mf_record *frame, size_t count);
// whether the log has grown past four times what it holds, and slack
bool mf_grown(const mf_manifest *manifest);
// writes the records as one frame to tmp/, synced, renamed over the log, synced; then removes
// the kept files no record names
mf_code mf_fold(mf_manifest *manifest, const mf_record *records, size_t count);
// keeps a value with no kept file: its file in tmp/, synced, renamed into values/, synced. hash
// NULL: the value's own
mf_code mf_put(mf_manifest *manifest, const Json *value, const char *hash, mf_kept *kept);
// a kept value, a new value; MF_STORE when its file is missing or does not hash to its name
mf_code mf_get(mf_manifest *manifest, const char *hash, const char *form, Json **value);

#endif
