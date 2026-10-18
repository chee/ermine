// libFuzzer target (fuzz.sh commit): the input bytes decoded as a commit with cm_decode. Checked:
// - taken: the bytes are a canonical encoding (cborCheck); encoding the commit again gives them
//   exactly, from the cm_commit and from its Json form; cm_check takes that form;
// - refused: a not-a-commit, nothing else; a field named only for bytes that are a map;
// - nothing leaks, ASan and UBSan quiet.
#include "cbor.h"
#include "commit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void die(const char *why) {
	fprintf(stderr, "fuzz: %s\n", why);
	abort();
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
	// a key no commit has is left out when read: written again, other bytes, then
	Json *in = cborDecode(input, size, NULL, NULL);
	Json *back = cborDecode(out, length, NULL, NULL);
	bool same = in && back && in->object.count == back->object.count;
	jsonFree(in), jsonFree(back);
	if (same && (length != size || memcmp(out, input, size) != 0)) die("written again, other bytes");
	free(out);
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
