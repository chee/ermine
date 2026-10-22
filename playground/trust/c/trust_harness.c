// The C trust (trust.h) on the line protocol of typescript/trust_harness.ts, which documents it
// (conformance/c/harness.h has the loop). Installs and sessions are named in requests. An install
// named N has the secret BLAKE3 of N's UTF-8, its id its key's; Ed25519 is the repo's
// (core/ed25519/c: this harness's only, trust knows none). What the harness can't say, a claim whose
// ids are no key ids, is tried at the end (hh_finish), where a failure is hh_fail.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../conformance/c/harness.h"
#include "../../../core/ed25519/c/ed25519.h"
#include "../../../ermine/encoding/c/blake3/blake3.h"
#include "trust.h"

#define PUSH(v, n, cap, x) \
	do { \
		if ((n) == (cap)) { \
			(cap) = (cap) ? (cap) * 2 : 16; \
			(v) = realloc((v), (cap) * sizeof *(v)); \
			if ((v) == NULL) abort(); \
		} \
		(v)[(n)++] = (x); \
	} while (0)

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static bool ed25519_of(void *ctx, const uint8_t secret[32], uint8_t out[32]) {
	(void)ctx;
	ermEd25519Public(secret, out);
	return true;
}

static bool ed25519_sign(void *ctx, const uint8_t secret[32], const uint8_t *message, size_t length, uint8_t out[64]) {
	(void)ctx;
	ermEd25519Sign(secret, message, length, out);
	return true;
}

static bool ed25519_verify(void *ctx, const uint8_t key[32], const uint8_t *message, size_t length,
	const uint8_t signature[64]) {
	(void)ctx;
	return ermEd25519Verify(key, message, length, signature);
}

static const sess_signing signing = {.public_key_of = ed25519_of, .sign = ed25519_sign};
static const sess_verifying verifying = {.verify = ed25519_verify};

// the installs, by name: each kept whole, a session borrows its id
typedef struct {
	char *name;
	char id[ID_TEXT];
	sess_install install;
} installed;
static installed **installs;
static size_t ninstalls, capinstalls;

static installed *install_named(const char *name) {
	for (size_t i = 0; i < ninstalls; i++) {
		if (strcmp(installs[i]->name, name) == 0) return installs[i];
	}
	installed *in = xalloc(sizeof *in);
	in->name = xdup(name);
	blake3_hasher h;
	blake3_hasher_init(&h);
	blake3_hasher_update(&h, name, strlen(name));
	blake3_hasher_finalize(&h, in->install.secret, 32);
	uint8_t id[34] = {0xed, 0x01};
	ermEd25519Public(in->install.secret, id + 2);
	id_text(id, sizeof id, in->id);
	in->install.id = in->id;
	PUSH(installs, ninstalls, capinstalls, in);
	return in;
}

// the sessions, by name
typedef struct {
	char *name;
	sess_session session;
} named;
static named *sessions;
static size_t nsessions, capsessions;

static named *session_named(const char *name) {
	for (size_t i = 0; name != NULL && i < nsessions; i++) {
		if (strcmp(sessions[i].name, name) == 0) return &sessions[i];
	}
	return NULL;
}

// the trusted node's value, as set
static op_value *keys;

void hh_start(void) {}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (op == NULL) {
		hh_unknown(out, r);
		return;
	}
	if (strcmp(op, "session") == 0) {
		const char *name = hh_str(r, "name"), *install = hh_str(r, "install");
		if (name == NULL || install == NULL) {
			hh_error(out, "session: no name or install");
			return;
		}
		uint8_t random[32];
		arc4random_buf(random, sizeof random);
		sess_session s;
		if (sess_start(random, &install_named(install)->install, &signing, &s) != SESS_OK) {
			hh_error(out, "session: no session");
			return;
		}
		PUSH(sessions, nsessions, capsessions, ((named){xdup(name), s}));
		fputs("{}", out);
	} else if (strcmp(op, "keys") == 0) {
		const op_value *value = op_get(r, "value");
		op_free(keys);
		keys = NULL;
		if (value != NULL && value->type == OP_MAP) {
			// a key that names an install is that install's id; anything else as it is
			keys = op_map();
			for (size_t i = 0; i < value->count; i++) {
				bool known = false;
				for (size_t j = 0; j < ninstalls; j++) known = known || strcmp(installs[j]->name, value->keys[i]) == 0;
				op_set(keys, known ? install_named(value->keys[i])->id : value->keys[i],
					op_ref((op_value *)value->items[i]));
			}
		} else if (value != NULL) keys = op_ref((op_value *)value);
		fputs("{}", out);
	} else if (strcmp(op, "check") == 0) {
		named *s = session_named(hh_str(r, "session"));
		const char *signer_name = hh_str(r, "signer"), *as = hh_str(r, "as"), *from = hh_str(r, "from");
		const char *message = hh_str(r, "message"), *signed_ = hh_str(r, "signed");
		named *signer = signer_name ? session_named(signer_name) : s;
		named *voucher = from ? session_named(from) : s;
		if (s == NULL || signer == NULL || voucher == NULL || message == NULL) {
			hh_error(out, "check: no such session or no message");
			return;
		}
		if (signed_ == NULL) signed_ = message;
		uint8_t signature[64];
		ermEd25519Sign(signer->session.secret, (const uint8_t *)signed_, strlen(signed_), signature);
		trust_claim claim = {.session = s->session.id, .install = as ? install_named(as)->id : s->session.install};
		memcpy(claim.vouch, voucher->session.vouch, 64);
		bool ok = trust_check(keys, &claim, (const uint8_t *)message, strlen(message), signature, &verifying);
		fprintf(out, "{\"trusted\":%s}", ok ? "true" : "false");
	} else hh_unknown(out, r);
}

// ids that are no key ids: not believed, never a crash (trust_test.ts)
static void no_key_ids(void) {
	installed *in = install_named("I1");
	uint8_t random[32] = {1}, signature[64];
	sess_session s;
	if (sess_start(random, &in->install, &signing, &s) != SESS_OK) hh_fail("no session");
	const char *fresh = "ermine:00100123456789abcdef0123456789abcdef";
	ermEd25519Sign(s.secret, (const uint8_t *)"hello", 5, signature);
	op_value *ks = op_map();
	op_set(ks, in->id, op_map());
	op_set(ks, fresh, op_map());
	trust_claim claim = {.session = s.id, .install = s.install};
	memcpy(claim.vouch, s.vouch, 64);
	if (!trust_check(ks, &claim, (const uint8_t *)"hello", 5, signature, &verifying)) hh_fail("own claim not believed");
	const char *bad[] = {fresh, "nonsense", "", "ermine:"};
	for (size_t i = 0; i < 4; i++) {
		trust_claim c = claim;
		c.session = bad[i];
		if (trust_check(ks, &c, (const uint8_t *)"hello", 5, signature, &verifying)) hh_fail("a session that is no key id is believed");
		c = claim;
		c.install = bad[i];
		if (trust_check(ks, &c, (const uint8_t *)"hello", 5, signature, &verifying)) hh_fail("an install that is no key id is believed");
	}
	op_free(ks);
}

void hh_finish(void) {
	no_key_ids();
	op_free(keys);
	for (size_t i = 0; i < nsessions; i++) free(sessions[i].name);
	free(sessions);
	for (size_t i = 0; i < ninstalls; i++) {
		free(installs[i]->name);
		free(installs[i]);
	}
	free(installs);
}
