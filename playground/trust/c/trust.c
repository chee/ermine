// Trust in C: see trust.h.
#include "trust.h"

#include <string.h>

bool trust_check(const op_value *keys, const trust_claim *claim, const uint8_t *message, size_t length,
	const uint8_t signature[64], const sess_verifying *verifying) {
	if (keys == NULL || keys->type != OP_MAP || claim->session == NULL || claim->install == NULL) return false;
	if (op_get(keys, claim->install) == NULL) return false;
	if (!sess_vouched(claim->session, claim->install, claim->vouch, verifying)) return false;
	// a key id: ed 01, then the key's 32 bytes
	uint8_t id[ID_MAX];
	size_t n = id_parse(claim->session, strlen(claim->session), id);
	if (n != 34 || id_kind_of(id, n) != ID_KEY) return false;
	return verifying->verify(verifying->ctx, id + 2, message, length, signature);
}
