// probe.c: can two ErmSd in one process be linked by an in-memory pipe (TRANSPORT.tex)?
//   cc -std=c11 -Ic/subduction -o probe extensions/subduction/conformance/transport_probe.c \
//      c/subduction/store_memory.c c/subduction/platform_posix.c c/subduction/lib/libsubduction_c.a -lc -lm -liconv
// subduction.h has only the initiator's handshake (erm_sd_connect); erm_sd_received drops bytes
// for a connection the node did not open. So each side opens one and the pipe crosses them.
// Then a commit added on a, both syncing the tree: does b hold it? Then the same offline: b's
// connection closed (erm_sd_closed both sides), a commit on a; a new pair of connections.
// Found 2026-10-11: both handshakes finish (two initiators, crossed); the commit crosses, seen
// by b's store's put; offline it does not; relinked and synced, it does; an ephemeral message
// is heard (ERM_SD_HEARD). Built against lib/ (smoke's link line).
#include "subduction.h"

#include <stdio.h>
#include <string.h>

static ErmSd *a, *b;
static ErmStore inner;

// b's store, watched: each commit or fragment it saves
static int watched(void *self, int kind, const uint8_t *tree, const uint8_t id[32], const uint8_t *bytes, size_t length) {
	if (kind == ERM_STORE_COMMIT || kind == ERM_STORE_FRAGMENT) printf("b: saves a %s %02x..\n", kind == ERM_STORE_COMMIT ? "commit" : "fragment", id[0]);
	return inner.put(self, kind, tree, id, bytes, length);
}
static uint64_t ca, cb;
static int done, sent, live = 1;

// runs both until quiet, piping SEND across while live
static void pump(int rounds) {
	for (int round = 0; round < rounds; round++) {
		ErmSd *sds[2] = {a, b};
		for (int i = 0; i < 2; i++) {
			erm_sd_run(sds[i], erm_host_now());
			ErmSdEvent e;
			while (erm_sd_poll(sds[i], &e)) {
				if (e.kind == ERM_SD_SEND) {
					sent++;
					if (live) erm_sd_received(i ? a : b, i ? ca : cb, e.bytes, e.length);
				} else if (e.kind == ERM_SD_CONNECTED) {
					printf("%c: connected ok=%d %s\n", i ? 'b' : 'a', e.ok, e.ok ? "" : e.error);
					done++;
				} else if (e.kind == ERM_SD_DONE && !e.ok) {
					printf("%c: call %llu failed: %s\n", i ? 'b' : 'a', (unsigned long long)e.call, e.error);
				} else if (e.kind == ERM_SD_HEARD) {
					printf("%c: heard %.*s\n", i ? 'b' : 'a', (int)e.length, (const char *)e.bytes);
				} else if (e.kind == ERM_SD_COMMITS) {
					printf("%c: holds %zu commits\n", i ? 'b' : 'a', e.count);
				}
				erm_sd_free_event(&e);
			}
		}
	}
}

int main(void) {
	uint8_t sa[32] = {1}, sb[32] = {2}, doc[32] = {7}, c1[32] = {1}, c2[32] = {2};
	static ErmStore ma, mb;
	ma = ermStoreMemory(), inner = mb = ermStoreMemory();
	mb.put = watched;
	a = erm_sd_new(sa, erm_host_now(), &ma), b = erm_sd_new(sb, erm_host_now(), &mb);
	ca = erm_sd_connect(a, "ermine"), cb = erm_sd_connect(b, "ermine");
	pump(50);
	printf("messages piped: %d; handshakes answered: %d of 2\n", sent, done);
	erm_sd_sync(a, doc, 1, 2000), erm_sd_sync(b, doc, 1, 2000);
	pump(50);
	erm_sd_add_commit(a, doc, c1, NULL, 0, (const uint8_t *)"one", 3);
	pump(50);
	erm_sd_commits(b, doc);
	pump(5);
	// offline
	live = 0;
	erm_sd_closed(a, ca), erm_sd_closed(b, cb);
	erm_sd_add_commit(a, doc, c2, c1, 1, (const uint8_t *)"two", 3);
	pump(50);
	erm_sd_commits(b, doc);
	pump(5);
	live = 1;
	ca = erm_sd_connect(a, "ermine"), cb = erm_sd_connect(b, "ermine");
	pump(50);
	erm_sd_sync(b, doc, 1, 2000);
	pump(50);
	erm_sd_commits(b, doc);
	pump(5);
	erm_sd_subscribe(a, doc), erm_sd_subscribe(b, doc);
	pump(20);
	erm_sd_publish(a, doc, (const uint8_t *)"hi", 2);
	pump(20);
	return 0;
}
