// smoke.c: the library linked and alive, with no network: a node over a memory store adds a
// commit, then reads it and its blob back. The workflow runs it on each desktop target; so can
// anyone after make fetch.
#include "subduction.h"

#include <stdio.h>
#include <string.h>

static ErmSd *sd;

// runs until the call answers, the event into *e
static int await(uint64_t call, ErmSdEvent *e) {
	for (int round = 0; round < 1000; round++) {
		erm_sd_run(sd, erm_host_now());
		while (erm_sd_poll(sd, e)) {
			if (e->call == call) return 1;
			erm_sd_free_event(e);
		}
	}
	return 0;
}

static int fail(const char *why) {
	fprintf(stderr, "smoke: %s\n", why);
	return 1;
}

int main(void) {
	uint8_t seed[32] = {1}, doc[32] = {2}, commit[32] = {3}, blob[] = "a blop, sealed";
	static ErmStore store;
	store = ermStoreMemory();
	sd = erm_sd_new(seed, erm_host_now(), &store);
	if (sd == NULL) return fail("no node");
	ErmSdEvent e;
	if (!await(erm_sd_add_commit(sd, doc, commit, NULL, 0, blob, sizeof blob), &e) || !e.ok)
		return fail("add_commit");
	erm_sd_free_event(&e);
	if (!await(erm_sd_commits(sd, doc), &e) || e.kind != ERM_SD_COMMITS || !e.found || e.count != 1 ||
		memcmp(e.commits[0].id, commit, 32) != 0)
		return fail("commits");
	uint8_t digest[32];
	memcpy(digest, e.commits[0].digest, 32);
	erm_sd_free_event(&e);
	if (!await(erm_sd_blob(sd, doc, digest), &e) || e.bytes == NULL || e.length != sizeof blob ||
		memcmp(e.bytes, blob, sizeof blob) != 0)
		return fail("blob");
	erm_sd_free_event(&e);
	erm_sd_free(sd);
	printf("smoke: a commit stored and read back\n");
	return 0;
}
