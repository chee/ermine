// Trust (typescript/trust.ts), in C: whether to believe what a session signed. The installs trusted
// are a value: a map from an install's id to what is said of it, from wherever the caller keeps it (a
// node's value, as one idea to try; the host's own list; a file). Only its keys are looked at;
// anything that is no map trusts no one. It only reads the value given. Same rules as trust.ts, which the suite in
// playground/trust/conformance/trust/ holds both to.
//   - believed: the install is in keys, it vouched for the session (sess_vouched), and the session
//     signed the message
//   - what a session signs, and how it is carried, is whoever signs it's: no domain is added to the
//     message, and an install in keys may vouch for any number of sessions
//   - ids that are no key ids: not believed, never a crash
//
// The library knows no Ed25519: the host hands in a verifier (sessions').
//
//   trust_claim claim = {.session = me.id, .install = me.install};
//   memcpy(claim.vouch, me.vouch, 64);
//   bool ok = trust_check(keys, &claim, message, length, signature, &verifying);
#ifndef TRUST_H
#define TRUST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../../sessions/c/sessions.h"

// the session's id (its key's), its install's id, the install's vouch for it; borrowed
typedef struct {
	const char *session;
	const char *install;
	uint8_t vouch[64];
} trust_claim;

// whether the claim's session signed message[0 .. length) with signature, and its install, which is a
// key of keys, vouched for it. keys: the trusted value (NULL: none); not a map: no one
bool trust_check(const op_value *keys, const trust_claim *claim, const uint8_t *message, size_t length,
	const uint8_t signature[64], const sess_verifying *verifying);

#endif
