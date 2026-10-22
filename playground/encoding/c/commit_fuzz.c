// libFuzzer target (fuzz.sh commit): the input bytes decoded as a commit with cm_decode. Checked:
// - taken: the bytes are a canonical encoding (cborCheck); encoding the commit again gives them
//   exactly, from the cm_commit and from its Json form; cm_check takes that form;
// - taken, then changed each of a few ways a rule or the encoding says no to (or yes): cm_encode
//   answers as its Json form does, the same code, field and bytes;
// - refused: a not-a-commit, nothing else; a field named only for bytes that are a map;
// - nothing leaks, ASan and UBSan quiet.
#include "../../../ermine/encoding/c/cbor.h"
#include "commit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
}

static bool same_text(const char *a, const char *b) { return a == b || (a != NULL && b != NULL && strcmp(a, b) == 0); }

// cm_encode as cm_encode_json of cm_to_json: code, field, bytes
static void as_json(const cm_commit *c) {
	uint8_t *a = NULL, *b = NULL;
	size_t an = 0, bn = 0;
	char *af = NULL, *bf = NULL;
	cm_code ac = cm_encode(c, &a, &an, &af), bc = CM_CANNOT_CARRY;
	Json *j = cm_to_json(c);
	if (j) bc = cm_encode_json(j, &b, &bn, &bf);
	jsonFree(j);
	if (ac != bc || !same_text(af, bf)) die("cm_encode answers otherwise than its Json form");
	if (ac == CM_OK && (an != bn || memcmp(a, b, an) != 0)) die("cm_encode writes other bytes than its Json form");
	free(a), free(b), free(af), free(bf);
}

// the commit changed one way (how), each change a rule's or the encoding's
static void changed(const cm_commit *given, int how) {
	cm_commit c = *given;
	ch_header *h = &c.change;
	op_patch patches[2];
	op_key keys[2];
	uint8_t names[3][CM_NAME];
	cm_replaces replaces[2];
	ch_site site = {"f.c", 1, 0, NULL, 0};
	ch_entry twice[2] = {{"k", NULL}, {"k", NULL}};
	if (c.patches_length > 0) memcpy(patches, c.patches, sizeof *patches), c.patches = patches, c.patches_length = 1;
	if (c.parents_length > 0) memcpy(names[0], c.parents[0], CM_NAME);
	else names[0][0] = 0x1e, names[0][1] = 0x20, memset(names[0] + 2, 7, 32);
	memcpy(names[1], names[0], CM_NAME), names[1][CM_NAME - 1] ^= 1;
	memcpy(names[2], names[0], CM_NAME), names[2][0] = 0x55;
	const uint8_t(*two)[CM_NAME] = (const uint8_t(*)[CM_NAME])names;
	switch (how) {
	case 0: h->time = -1; break;
	case 1: h->time = (int64_t)1 << 53; break;
	case 2: c.nonce = -5; break;
	case 3: c.lamport = 0; break;
	case 4: c.lamport = ((int64_t)1 << 53) - 1; break;
	case 5: c.table = ""; break;
	case 6: c.table = "\xff"; break;
	case 7: c.signer_length = 1; break;
	case 8: c.parents = two, c.parents_length = 2, c.has_base = 0, c.merge = NULL; break;
	case 9: c.parents = two, c.parents_length = 2, c.has_base = 1, memcpy(c.base, names[1], CM_NAME); break;
	case 10: c.parents = two, c.parents_length = 2, c.has_base = 1, memcpy(c.base, names[2], CM_NAME); break;
	case 11: c.parents = two, c.parents_length = 2, c.has_base = 0, c.merge = "m"; break;
	case 12: c.parents = two, c.parents_length = 2, c.has_base = 0, c.merge = ""; break;
	case 13: c.parents = two + 1, c.parents_length = 1, c.has_base = 0, c.merge = "m"; break;
	case 14: c.parents = two + 1, c.parents_length = 2; break;
	case 15: c.parents = two, c.parents_length = 2, c.has_base = 1, memcpy(c.base, names[0], CM_NAME), c.merge = "m"; break;
	case 16: c.parents = (const uint8_t(*)[CM_NAME])names[2], c.parents_length = 1; break;
	case 17: h->reader = "\xc3"; break;
	case 18: h->external = &site, h->external_length = 1, site.line = -1; break;
	case 19: h->external = &site, h->external_length = 1, site.has_column = 1, site.column = 2147483648L; break;
	case 20: h->external = &site, h->external_length = 1, site.function = "fn"; break;
	case 21: h->metadata = twice, h->metadata_length = 2; break;
	case 22: h->metadata = twice, h->metadata_length = 1; break;
	default:
		if (c.patches_length == 0) return;
		switch (how) {
		case 23: keys[0] = (op_key){.type = OP_NUM_KEY, .n = -1}, patches[0].place.path = keys, patches[0].place.length = 1; break;
		case 24: keys[0] = (op_key){.type = OP_NUM_KEY, .n = 3}, patches[0].place.path = keys, patches[0].place.length = 1; break;
		case 25: patches[0].place.has_range = 1, patches[0].place.from = -1, patches[0].place.to = 2; break;
		case 26: patches[0].place.has_range = 1, patches[0].place.from = 1, patches[0].place.to = 2; break;
		case 27: patches[0].has_move = 1, patches[0].move = patches[0].place; break;
		case 28: patches[0].has_value = 1, patches[0].value = NULL; break;
		case 29: keys[0] = (op_key){.type = OP_STR_KEY, .s = "\xc3"}, patches[0].place.path = keys, patches[0].place.length = 1; break;
		case 30:
			replaces[0] = (cm_replaces){1, (const uint8_t(*)[CM_NAME])names[1], 2};
			memcpy(names[2], names[0], CM_NAME);
			c.replaces = replaces;
			break;
		case 31: replaces[0] = (cm_replaces){1, two, 2}, c.replaces = replaces; break;
		default: return;
		}
	}
	as_json(&c);
}

int LLVMFuzzerTestOneInput(const unsigned char *data, size_t size) {
	uint8_t *input = malloc(size ? size : 1);
	memcpy(input, data, size);
	cm_commit c;
	char *field = NULL;
	cm_code code = cm_decode(input, size, &c, &field);
	if (code != CM_OK) {
		if (code != CM_NOT_A_COMMIT) die("refused, not as not-a-commit");
		if (field && (size == 0 || input[0] >> 5 != 5)) die("a field named for what is no map");
		free(field);
		free(input);
		return 0;
	}
	if (field) die("taken, and a field named");
	if (!cborCheck(input, size, NULL, NULL)) die("taken, and no canonical encoding");
	uint8_t *out = NULL;
	size_t length = 0;
	if (cm_encode(&c, &out, &length, &field) != CM_OK) die("a commit read is refused when written");
	// a key no commit has is left out when read, metadata in the old form is written as a map:
	// written again, other bytes, then
	Json *in = cborDecode(input, size, NULL, NULL);
	Json *back = cborDecode(out, length, NULL, NULL);
	const Json *metadata = in ? jsonGet(in, "metadata") : NULL;
	bool same = in && back && in->object.count == back->object.count && !(metadata && metadata->type == JSON_ARRAY);
	jsonFree(in), jsonFree(back);
	if (same && (length != size || memcmp(out, input, size) != 0)) die("written again, other bytes");
	free(out);
	as_json(&c);
	for (int how = 0; how < 32; how++) changed(&c, how);
	Json *j = cm_to_json(&c);
	if (j) {
		if (cm_check(j, &field) != CM_OK) die("its Json form is refused by cm_check");
		if (cm_encode_json(j, &out, &length, &field) != CM_OK) die("its Json form is refused when written");
		if (same && (length != size || memcmp(out, input, size) != 0)) die("its Json form written, other bytes");
		free(out);
		jsonFree(j);
	}
	cm_free(&c);
	free(input);
	return 0;
}
