// The presence channel over a device (channel.h), as playground/together/typescript/channel_test.ts tries
// it: two devices joined by a pipe (wires_harness.h). Prints each check that fails; exits 1 if any did. Its
// arguments are not read
#include "channel.h"
#include "wires_harness.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failed;

static void expect(int ok, const char *what) {
	if (ok) return;
	fprintf(stderr, "channel: %s\n", what);
	failed = 1;
}

typedef struct {
	char from[4][2 * SL_KEY + 1];
	uint8_t *bytes[4];
	size_t lengths[4];
	size_t count;
} heard_t;

static void heard(void *context, const char *from, const unsigned char *bytes, size_t n) {
	heard_t *h = context;
	if (h->count < 4) {
		snprintf(h->from[h->count], sizeof h->from[0], "%s", from);
		h->bytes[h->count] = malloc(n + 1);
		if (h->bytes[h->count] == NULL) abort();
		memcpy(h->bytes[h->count], bytes, n);
		h->lengths[h->count] = n;
	}
	h->count++;
}

static void heard_free(heard_t *h) {
	for (size_t i = 0; i < h->count && i < 4; i++) free(h->bytes[i]);
}

// both run, what they send crossing, until nothing does for five rounds
static void quiet(tp_device *a, tp_device *b) {
	size_t still = 0, last = (size_t)-1;
	for (int round = 0; round < 3000 && still < 5; round++) {
		tp_run(a), wr_drain(a);
		tp_run(b), wr_drain(b);
		wr_ms += 2;
		if (tp_idle(a) && tp_idle(b) && wr_moved == last) still++;
		else still = 0, last = wr_moved;
	}
}

// the stores: a memory store is never freed, so they stay where the program can reach them
static ErmStore sa, sb;

int main(void) {
	sa = ermStoreMemory(), sb = ermStoreMemory();
	tp_options oa = {.store = &sa, .now = wr_clock}, ob = {.store = &sb, .now = wr_clock};
	memset(oa.seed, 1, 32);
	memset(ob.seed, 2, 32);
	tp_device *a = tp_create(&oa), *b = tp_create(&ob);
	if (a == NULL || b == NULL) return fprintf(stderr, "channel: no device\n"), 1;
	wr_connect(a, b);
	for (int round = 0; round < 3000 && !wr_up(a, b); round++) tp_run(a), wr_drain(a), tp_run(b), wr_drain(b);
	expect(wr_up(a, b), "the devices connect");
	// each device's signer: its own key, from the same seed
	sl_seeded ka, kb, kc;
	sl_seeded_init(&ka, oa.seed), sl_seeded_init(&kb, ob.seed);
	sc_channel *ca = sc_create(a, &ka.signer), *cb = sc_create(b, &kb.signer);
	chn_channel *x = sc_channel_of(ca), *y = sc_channel_of(cb);
	char key[2 * SL_KEY + 1];
	for (int i = 0; i < SL_KEY; i++) snprintf(key + 2 * i, 3, "%02x", tp_key(a)[i]);
	expect(strcmp(x->name, key) == 0, "a channel's name is its device's key as hex");

	// bytes on a topic reach the other device's listeners, from the sender's key; another topic gets
	// nothing, nor the sender
	heard_t got = {0}, other = {0}, mine = {0};
	y->on(y, "cursor", heard, &got);
	y->on(y, "else", heard, &other);
	x->on(x, "cursor", heard, &mine);
	quiet(a, b);
	x->send(x, "cursor", (const unsigned char *)"hi", 2);
	quiet(a, b);
	expect(got.count == 1 && strcmp(got.from[0], key) == 0 && got.lengths[0] == 2 && memcmp(got.bytes[0], "hi", 2) == 0,
		"bytes reach the other's listener, from the sender's key");
	expect(other.count == 0, "another topic gets nothing");
	expect(mine.count == 0, "the sender hears nothing of its own");
	// a listener stopped is told nothing
	heard_t stopped = {0};
	chn_listener *l = y->on(y, "cursor", heard, &stopped);
	y->off(y, l);
	x->send(x, "cursor", (const unsigned char *)"again", 5);
	quiet(a, b);
	expect(got.count == 2, "the listener hears again");
	expect(stopped.count == 0, "a listener stopped hears nothing");

	// a payload over the limit arrives whole, as parts joined
	heard_t big = {0};
	y->on(y, "big", heard, &big);
	quiet(a, b);
	size_t n = 65536 * 2 + 5;
	uint8_t *bytes = malloc(n);
	if (bytes == NULL) abort();
	for (size_t i = 0; i < n; i++) bytes[i] = (uint8_t)(i % 251);
	x->send(x, "big", bytes, n);
	quiet(a, b);
	expect(big.count == 1 && big.lengths[0] == n && memcmp(big.bytes[0], bytes, n) == 0, "a payload over the limit arrives whole");
	free(bytes);

	// named by the key that sealed it, not the connection that carried it (c is not on it: a publishes
	// for it, a gateway's way); unsealed, badly sealed, or sealed for another topic: dropped
	uint8_t seed[32];
	memset(seed, 3, 32);
	sl_seeded_init(&kc, seed);
	char ckey[2 * SL_KEY + 1];
	for (int i = 0; i < SL_KEY; i++) snprintf(ckey + 2 * i, 3, "%02x", kc.signer.key[i]);
	heard_t room = {0};
	y->on(y, "dens:root", heard, &room);
	quiet(a, b);
	uint8_t *sealed;
	size_t length;
	sl_seal_message("dens:root", (const uint8_t *)"from c", 6, &kc.signer, &sealed, &length);
	tp_send(a, "dens:root", sealed, length);
	sealed[length - 1] ^= 1;
	tp_send(a, "dens:root", sealed, length);
	free(sealed);
	tp_send(a, "dens:root", (const uint8_t *)"unsealed", 8);
	sl_seal_message("elsewhere", (const uint8_t *)"moved", 5, &kc.signer, &sealed, &length);
	tp_send(a, "dens:root", sealed, length);
	free(sealed);
	quiet(a, b);
	expect(room.count == 1 && strcmp(room.from[0], ckey) == 0 && room.lengths[0] == 6 && memcmp(room.bytes[0], "from c", 6) == 0,
		"named by the key that sealed it; the rest dropped");

	heard_free(&got), heard_free(&other), heard_free(&mine), heard_free(&stopped), heard_free(&big), heard_free(&room);
	sc_free(ca);
	sc_free(cb);
	tp_free(a);
	tp_free(b);
	wr_free();
	if (!failed) puts("channel: ok");
	return failed;
}
