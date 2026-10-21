// null_lists.c: a call given NULL for a list or bytes with a nonzero count is
// refused (call number 0), never read from (subduction.h).
#include "subduction.h"

#include <stdio.h>

static int failed;

static void expect(const char *what, uint64_t call) {
	if (call != 0) {
		fprintf(stderr, "null_lists: %s was taken as call %llu, not refused\n", what, (unsigned long long)call);
		failed = 1;
	}
}

int main(void) {
	uint8_t seed[32] = {1}, doc[32] = {2}, id[32] = {3}, blob[] = "b";
	static ErmStore store;
	store = ermStoreMemory();
	ErmSd *sd = erm_sd_new(seed, erm_host_now(), &store);
	expect("add_commit, parents NULL, count 2", erm_sd_add_commit(sd, doc, id, NULL, 2, blob, sizeof blob));
	expect("add_commit, blob NULL, length 5", erm_sd_add_commit(sd, doc, id, NULL, 0, NULL, 5));
	expect("add_fragment, boundary NULL, count 2", erm_sd_add_fragment(sd, doc, id, NULL, 2, NULL, 0, blob, sizeof blob));
	expect("add_fragment, checkpoints NULL, checks 2", erm_sd_add_fragment(sd, doc, id, NULL, 0, NULL, 2, blob, sizeof blob));
	expect("add_fragment, blob NULL, length 5", erm_sd_add_fragment(sd, doc, id, NULL, 0, NULL, 0, NULL, 5));
	expect("publish, payload NULL, length 3", erm_sd_publish(sd, doc, NULL, 3));
	erm_sd_free(sd);
	if (!failed) printf("null_lists: each refused\n");
	return failed;
}
