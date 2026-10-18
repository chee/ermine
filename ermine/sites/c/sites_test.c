// the C sites (sites.h): where each call was, the chain, and a torn-down scope's site gone. exits
// 1 at the first thing that is not so. run under the sanitizers and leaks for the frees
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sites.h"

#define CHECK(x) \
	do { \
		if (!(x)) { \
			fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); \
			exit(1); \
		} \
	} while (0)

static const sc_pair info[] = {{"owner", "test"}};
static st_sites *sites;
static sc_scope *made;

static sc_out one(void *previous, void *data) {
	(void)previous, (void)data;
	return (sc_out){.kind = SC_VALUE};
}
static char *set(void *value, void *data) {
	(void)value, (void)data;
	return NULL;
}
static int line_of_computer;
static void in_scope(void *data) {
	(void)data;
	line_of_computer = __LINE__ + 1;
	made = st_create_computer(sites, ((sc_def){.f = one, .set = set}), NULL, 0);
}
static void bare(void *data) {
	(void)data;
	made = sc_create_computer(st_scheduler(sites), (sc_def){.f = one, .set = set}, NULL, 0);
}
static int torn;
static char *count_teardown(void *data) {
	(void)data;
	// the scope's own teardowns run while its site is still there
	torn = 1;
	return NULL;
}

int main(void) {
	sc_scheduler *s = sc_new((sc_options){0});
	sites = st_new(s);

	int line_of_root = __LINE__ + 1;
	sc_scope *root = st_create_root_scope(sites, info, 1);
	const st_site *site = st_site_of(sites, root);
	CHECK(site != NULL);
	CHECK(strstr(site->file, "sites_test.c") != NULL);
	CHECK(site->line == line_of_root);
	CHECK(strcmp(site->func, "main") == 0);

	CHECK(sc_run_with_scope(root, in_scope, NULL) == NULL);
	sc_scope *c = made;
	site = st_site_of(sites, c);
	CHECK(site != NULL && site->line == line_of_computer);
	CHECK(strcmp(site->func, "in_scope") == 0);
	const st_site *chain[4];
	CHECK(st_sites_of(sites, c, chain, 4) == 2);
	CHECK(chain[0] == st_site_of(sites, c) && chain[1] == st_site_of(sites, root));
	// cap: the count is whole, out is filled to cap
	CHECK(st_sites_of(sites, c, chain, 1) == 2 && chain[0] == st_site_of(sites, c));

	// without the macro: none, and the parent still shows
	CHECK(sc_run_with_scope(root, bare, NULL) == NULL);
	sc_scope *plain = made;
	CHECK(st_site_of(sites, plain) == NULL);
	CHECK(st_sites_of(sites, plain, chain, 4) == 1 && chain[0] == st_site_of(sites, root));

	// torn down: its sites go, its children's too, the root's stay
	sc_scope *inner = st_create_scope(sites, info, 1, root);
	sc_register_teardown(s, inner, count_teardown, NULL);
	sc_scope *leaf = st_create_scope(sites, info, 1, inner);
	CHECK(st_count(sites) == 4);
	CHECK(st_sites_of(sites, leaf, chain, 4) == 3);
	CHECK(sc_teardown(inner) == NULL);
	CHECK(torn);
	CHECK(st_count(sites) == 2);
	CHECK(st_site_of(sites, root) != NULL);
	CHECK(sc_teardown(root) == NULL);
	CHECK(st_count(sites) == 0);

	// none made: none noted
	CHECK(st_create_scope(sites, info, 1, root) == NULL);
	CHECK(st_count(sites) == 0);

	// many: the table grows
	sc_scope *top = st_create_root_scope(sites, info, 1);
	for (int i = 0; i < 1000; i++) CHECK(st_create_scope(sites, info, 1, top) != NULL);
	CHECK(st_count(sites) == 1001);
	CHECK(sc_teardown(top) == NULL);
	CHECK(st_count(sites) == 0);

	// not torn down: st_free lets go
	CHECK(st_create_root_scope(sites, info, 1) != NULL);
	st_free(sites);
	sc_free(s);
	puts("ok");
	return 0;
}
