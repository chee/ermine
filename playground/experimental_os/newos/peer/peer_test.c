// peer_test.c: the card (peer.h) on today's places, table and scheduler: a graph written on a fresh card, the
// card opened again into a new graph, and what comes back. Given a card's folder, it opens that card
// instead and says what it reads (never fresh: the card's files are kept, but use a copy: taking a
// store in may write to it). sh test.sh builds and runs it.
#include "peer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int failures;
#define CHECK(c, ...) \
	do { \
		if (!(c)) { \
			failures++; \
			fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
			fprintf(stderr, __VA_ARGS__); \
			fputc('\n', stderr); \
		} \
	} while (0)

// a graph as a host makes one, its root the card's
typedef struct {
	pl *p;
	sc_scheduler *s;
	tb_table *table;
	pt_paths *paths;
	sc_scope *host;
	Peer *peer;
} Graph;

static Graph g;

static void drop(void *value, void *data) {
	(void)value;
	(void)data;
}

static int lines;
static void said(void *context, const char *line) {
	(void)context;
	lines++;
	fprintf(stderr, "  said: %s\n", line);
}

static bool boot(const char *sd, bool fresh) {
	const char *why = NULL;
	g.peer = peerOpen(sd, fresh, &why);
	if (!g.peer) {
		fprintf(stderr, "open: %s\n", why);
		exit(1);
	}
	g.p = pl_new();
	g.s = sc_new((sc_options){.drop = drop});
	sc_on_tracking_end(g.s, pl_forget, g.p);
	g.table = tb_make(pl_event, g.p);
	g.paths = pt_new();
	pl_connect(g.p, &(pl_setup){.root = tb_string(peerRoot(g.peer)), .table = g.table, .paths = g.paths, .scheduler = g.s});
	// the scope keeps the pairs, not a copy
	static sc_pair info;
	info = (sc_pair){"actor", op_str("test")};
	g.host = sc_create_root_scope(g.s, &info, 1);
	return peerStart(g.peer, g.p, g.table, g.s, &(peer_host){.say = said});
}

// turns till nothing is left to do
static void settle(void) {
	for (int i = 0; i < 64 && peerTurn(g.peer) == 0; i++);
}

static void down(void) {
	peerStop(g.peer);
	peerFree(g.peer);
}

// a write: a header made with the host's scope open, the write, its commit, and what it changed sent
typedef struct {
	int (*f)(void *ctx, ch_header header, pl_changed *changed, nd_entry **made);
	void *ctx;
	int code;
} Writing;

static void writing(void *data) {
	Writing *w = data;
	ch_header h;
	pl_made *made;
	char *e = pl_header(g.p, NULL, 0, CH_HERE, &h, &made);
	if (e) {
		fprintf(stderr, "header: %s\n", e);
		abort();
	}
	pl_changed changed = {0};
	nd_entry *node = NULL;
	w->code = w->f(w->ctx, h, &changed, &node);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(g.p, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (node) pl_hold_also(g.p, node, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
	pl_commit(g.p, &changed);
	peerWrote(g.peer, &changed);
	if (node) {
		size_t n;
		const tb_where *at = tb_who(g.table, node, &n);
		for (size_t i = 0; i < n; i++) peerAdded(g.peer, at[i].part, at[i].id);
	}
}

static int writes(int (*f)(void *, ch_header, pl_changed *, nd_entry **), void *ctx) {
	Writing w = {f, ctx, 0};
	sc_run_with_scope(g.host, writing, &w);
	sc_pulse(g.s);
	return w.code;
}

// a value put at a path of names in the entry under (part, id)
typedef struct {
	const char *part, *id, *name;
	op_value *value;
} Putting;

static int putting(void *ctx, ch_header h, pl_changed *changed, nd_entry **made) {
	Putting *u = ctx;
	const char *path[] = {u->name};
	return pl_upsert(g.p, tb_string(u->part), tb_string(u->id), path, u->name ? 1 : 0, u->value, h, changed, made);
}

static void put(const char *part, const char *id, const char *name, op_value *value) {
	Putting u = {part, id, name, value};
	CHECK(writes(putting, &u) == 0, "put %s %s", part, name ? name : "");
	op_free(value);
}

typedef struct {
	const char *parent, *name, *id, *to;
} Placing;

static int placing(void *ctx, ch_header h, pl_changed *changed, nd_entry **made) {
	Placing *m = ctx;
	(void)made;
	nd_entry *children = tb_get(g.table, tb_string("children"), tb_string(m->parent));
	if (m->to) return pl_rename(g.p, children, m->name, m->to, h, changed);
	if (!m->id) return pl_unplace(g.p, children, m->name, h, changed);
	return pl_place(g.p, children, m->name, tb_string(m->id), h, changed);
}

static int place(const char *parent, const char *name, const char *id) {
	Placing m = {parent, name, id, NULL};
	return writes(placing, &m);
}

static int rename_(const char *parent, const char *name, const char *to) {
	Placing m = {parent, name, NULL, to};
	return writes(placing, &m);
}

static const char *at(const char *const *path, size_t n) {
	tb_key id;
	return pl_get(g.p, path, n, &id) ? id.string : "";
}

static const op_value *valueOf(const char *part, const char *id, const char *name) {
	const nd_entry *e = tb_get(g.table, tb_string(part), tb_string(id));
	if (!e || !e->value) return NULL;
	return name ? (e->value->type == OP_MAP ? op_get(e->value, name) : NULL) : e->value;
}

static const char *text(const op_value *v) {
	return v && v->type == OP_STR ? v->str : "";
}

static size_t seenLines(const char *sd) {
	char path[1024];
	snprintf(path, sizeof path, "%s/seen", sd);
	FILE *f = fopen(path, "r");
	if (!f) return 0;
	size_t n = 0;
	int c;
	while ((c = fgetc(f)) != EOF) n += c == '\n';
	fclose(f);
	return n;
}

// a card given: opened, and what it reads said
static int read_card(const char *sd) {
	bool held = boot(sd, false);
	settle();
	printf("card %s\n  root %s: %s\n", sd, peerRoot(g.peer), held ? "the card holds it" : "the card does not hold it");
	Json *objects = peerObjects(g.peer, peerRoot(g.peer));
	char *o = jsonPrint(objects);
	printf("  the root's objects sync told of: %s\n", o);
	free(o);
	jsonFree(objects);
	pl_members names = pl_list(g.p, NULL, 0);
	printf("  names under the root: %zu\n", names.n);
	for (size_t i = 0; i < names.n && i < 20; i++) printf("    %s\n", names.items[i].name);
	pl_members_free(&names);
	size_t parts = 0;
	const char *list[] = {"value", "attributes", "children"};
	for (size_t k = 0; k < 3; k++) parts += tb_get(g.table, tb_string(list[k]), tb_string(peerRoot(g.peer))) != NULL;
	printf("  the root's entries in the table: %zu\n", parts);
	down();
	return 0;
}

int main(int argc, char **argv) {
	if (argc > 1) return read_card(argv[1]);
	char sd[1024];
	snprintf(sd, sizeof sd, "%s/peer-test-XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp");
	if (!mkdtemp(sd)) return 1;

	// a fresh card: nothing held
	CHECK(!boot(sd, true), "a fresh card holds no graph");
	char root[ID_LENGTH + 1];
	snprintf(root, sizeof root, "%s", peerRoot(g.peer));
	CHECK(id_is(root), "the root is a document (%s)", root);
	char doc[ID_LENGTH + 1], other[ID_LENGTH + 1];
	peerFresh(g.peer, doc);
	peerFresh(g.peer, other);

	// the root's children, a note's value and attributes, the note placed, an ephemeral node placed too
	put("children", root, NULL, op_map());
	op_value *note = op_map();
	op_set(note, "text", op_str("hello"));
	put("value", doc, NULL, note);
	put("attributes", doc, "colour", op_str("pink"));
	CHECK(place(root, "notes", doc) == 0, "place");
	put("value", other, NULL, op_str("a second"));
	CHECK(place(root, "second", other) == 0, "place the second");
	put("value", "e1", NULL, op_str("ephemeral"));
	CHECK(place(root, "window", "e1") == 0, "place the ephemeral");
	// changed after: a name in the value, the note renamed, the second taken out
	put("value", doc, "text", op_str("hello again"));
	CHECK(rename_(root, "notes", "letters") == 0, "rename");
	Placing out = {root, "second", NULL, NULL};
	CHECK(writes(placing, &out) == 0, "unplace");
	settle();
	Json *objects = peerObjects(g.peer, doc);
	char *o = jsonPrint(objects);
	CHECK(objects->array.count == 2, "the note's objects: value and info colour (%s)", o);
	free(o);
	jsonFree(objects);
	objects = peerObjects(g.peer, "e1");
	CHECK(objects->array.count == 0, "the ephemeral node is not sent");
	jsonFree(objects);
	down();
	size_t seen = seenLines(sd);
	CHECK(seen >= 8, "each change seen (%zu lines)", seen);

	// opened again into a new graph: what the card held comes back
	CHECK(boot(sd, false), "the card holds a graph");
	CHECK(!strcmp(peerRoot(g.peer), root), "the same root");
	const char *letters[] = {"letters"}, *notes[] = {"notes"}, *second[] = {"second"}, *window[] = {"window"};
	CHECK(!strcmp(at(letters, 1), doc), "the note under its new name (%s)", at(letters, 1));
	CHECK(!strcmp(at(notes, 1), ""), "not under its old one (%s)", at(notes, 1));
	CHECK(!strcmp(at(second, 1), ""), "the second taken out (%s)", at(second, 1));
	CHECK(!strcmp(text(valueOf("value", doc, "text")), "hello again"), "the note's text (%s)", text(valueOf("value", doc, "text")));
	CHECK(!strcmp(text(valueOf("attributes", doc, "colour")), "pink"), "the note's colour");
	CHECK(valueOf("value", other, NULL) == NULL, "the second, reached by nothing, not loaded");
	// the ephemeral one was placed in a document's list: the placement is stored, the node is not
	CHECK(!strcmp(at(window, 1), "e1"), "the window's placement (%s)", at(window, 1));
	CHECK(valueOf("value", "e1", NULL) == NULL, "the ephemeral node is gone");
	const nd_entry *e = tb_get(g.table, tb_string("value"), tb_string(doc));
	const op_value *actor = e ? e->change.actor : NULL;
	CHECK(actor && actor->type == OP_STR && !strcmp(actor->str, "test"), "who wrote it comes back as the actor");
	CHECK(e && e->change.external_length == 1 && strstr(e->change.external[0].file, "peer_test.c"), "and where");

	// a write after reopening goes out, and comes back the next time
	put("value", doc, "text", op_str("third"));
	settle();
	down();
	CHECK(boot(sd, false), "again");
	CHECK(!strcmp(text(valueOf("value", doc, "text")), "third"), "the third text (%s)", text(valueOf("value", doc, "text")));
	down();

	char command[1100];
	snprintf(command, sizeof command, "rm -rf '%s'", sd);
	if (system(command) != 0) fprintf(stderr, "could not remove %s\n", sd);
	if (failures) {
		fprintf(stderr, "%d failed\n", failures);
		return 1;
	}
	puts("peer: all passed");
	return 0;
}
