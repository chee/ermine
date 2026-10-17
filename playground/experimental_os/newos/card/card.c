// card.c: the card (card.h), on extensions/sync. Sync holds the table: what the card's store held
// is written to it at boot (every document on the card, whole: sync takes in all the store holds
// on its first run), and what comes over the network after; a change the host makes to a kept
// table goes out as one commit. What this file adds is the OS's: the card's folder, the root,
// which documents are followed (the root, every document a children entry reached from it names,
// and what drivers bring), the places told of what sync wrote, and the counts /dev/sync/link shows.
//
// The card's folder, sync/ inside the folder the metal gives (~/.ermine/disk): a new name, so a
// card of the old layout beside it (device/, subduction/, seen) is never read:
//   sync/key      the device's Ed25519 seed, 64 hex digits, made at the first boot
//   sync/root     the root's id, made at the first boot
//   sync/store/   what Subduction holds (subduction/store_files.c): trees, commits, fragments, blobs
//
// Parts: value, attributes and children are sync's tables; any other part (fronts.h's "front") is
// never sent. A node whose id is not a document's is never sent either: that is what ephemeral is.
// Ids are minted with their last 16 bytes zero (sync.h, zeros): galaxy.observer stores no other
// until Keyhive.
//
// What sync writes: an entry it replaces or takes out of the table is told through drop; the host's
// entries are the places' own (pl_own), let go of at pl_free, so drop lets nothing go. An entry
// sync updates in place is told through commit; the places are told of each such key after the run
// (pl_event: every spot of the key said changed, the watches told), never inside sync's callback,
// where a watch's write would be lost (sync is applying).

#include "card.h"

#include "../../../../extensions/sync/c/ids.h"
#include "../../../../extensions/subduction/c/subduction/platform.h"
#include "../../../../extensions/subduction/c/subduction/store.h"

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// a key of the table whose places are to be told
typedef struct {
	char *part, *id;
} Key;

struct Card {
	char *folder; // sd/sync
	uint8_t seed[32];
	char hex[65]; // the key's
	char root[ID_LENGTH + 1];
	ErmStore store;
	sy_sync *sync;
	pl *l;
	tb_table *table;
	sc_scheduler *s;
	card_host host;
	im_map followed; // the documents followed, by their bytes
	im_map brought;  // the documents drivers bring (cardFollow): reached as the root is
	Key *keys;       // the keys sync changed in place this run, the places to be told
	size_t nkeys, keys_room;
	bool reach;      // a children entry changed or came: what lists name, followed again
	bool wrote;      // the table written by sync since the last pulse
	bool booting;    // what the card holds being taken in: not counted
	void (*told)(void *context, const char *doc);
	void *told_context;
};

static const char *const PARTS[] = {"value", "attributes", "children"};

bool id_is(const char *text) {
	uint8_t bytes[32];
	return text != NULL && tp_doc(text, bytes);
}

static void say(Card *c, const char *format, ...) {
	char line[512];
	va_list a;
	va_start(a, format);
	vsnprintf(line, sizeof line, format, a);
	va_end(a);
	if (c->host.say) c->host.say(c->host.context, line);
	else fprintf(stderr, "[os] %s\n", line);
}

static void count(Card *c, int made, int stored, int heard) {
	if (c->host.count) c->host.count(c->host.context, c->followed.count, made, stored, heard);
}

static void hex(const uint8_t *bytes, size_t n, char *out) {
	for (size_t i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02x", bytes[i]);
}

static bool unhex(const char *text, size_t n, uint8_t *out) {
	for (size_t i = 0; i < n; i++) {
		unsigned v;
		if (sscanf(text + 2 * i, "%2x", &v) != 1) return false;
		out[i] = (uint8_t)v;
	}
	return true;
}

static char *joined(const char *a, const char *b) {
	size_t n = strlen(a) + strlen(b) + 2;
	char *s = malloc(n);
	if (!s) abort();
	snprintf(s, n, "%s/%s", a, b);
	return s;
}

// --- the card's folder

static bool made(const char *path) {
	return mkdir(path, 0700) == 0 || errno == EEXIST;
}

/** a small file's text, trimmed: fresh, or NULL */
static char *readText(const char *path) {
	FILE *f = fopen(path, "r");
	if (!f) return NULL;
	char text[128] = {0};
	size_t n = fread(text, 1, sizeof text - 1, f);
	fclose(f);
	while (n && (text[n - 1] == '\n' || text[n - 1] == ' ' || text[n - 1] == '\r')) text[--n] = 0;
	return strdup(text);
}

static bool writeText(const char *path, const char *text) {
	int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (fd < 0) return false;
	size_t n = strlen(text);
	bool ok = write(fd, text, n) == (ssize_t)n && write(fd, "\n", 1) == 1;
	close(fd);
	return ok;
}

/** everything under path removed (a fresh card) */
static void wipe(const char *path) {
	size_t n = strlen(path) + 16;
	char *command = malloc(n);
	if (!command) abort();
	snprintf(command, n, "rm -rf '%s'", path);
	if (system(command) != 0) fprintf(stderr, "[os] card: could not empty %s\n", path);
	free(command);
}

/** a new document's id: 16 random bytes, then 16 zero bytes (sync.h, zeros) */
static void fresh(char out[ID_LENGTH + 1]) {
	uint8_t bytes[16];
	erm_host_random(bytes, sizeof bytes);
	char h[33];
	hex(bytes, 16, h);
	snprintf(out, ID_LENGTH + 1, "ermine://%s%032d", h, 0);
}

Card *cardOpen(const char *sd, bool clean, const char **why) {
	Card *c = calloc(1, sizeof *c);
	if (!c) abort();
	c->folder = joined(sd, "sync");
	if (clean) wipe(c->folder);
	char *keyPath = joined(c->folder, "key"), *rootPath = joined(c->folder, "root"), *storage = joined(c->folder, "store");
	bool ok = made(sd) && made(c->folder);
	if (!ok) *why = "the card's folder could not be made";
	char *key = ok ? readText(keyPath) : NULL;
	if (ok && key) {
		if (strlen(key) != 64 || !unhex(key, 32, c->seed)) ok = false, *why = "sync/key is not 64 hex digits";
	} else if (ok) {
		erm_host_random(c->seed, 32);
		char text[65];
		hex(c->seed, 32, text);
		if (!writeText(keyPath, text)) ok = false, *why = "sync/key could not be written";
	}
	char *root = ok ? readText(rootPath) : NULL;
	if (ok && root) {
		if (!id_is(root)) ok = false, *why = "sync/root is not a document's id";
		else snprintf(c->root, sizeof c->root, "%s", root);
	} else if (ok) {
		fresh(c->root);
		if (!writeText(rootPath, c->root)) ok = false, *why = "sync/root could not be written";
	}
	if (ok && ermStoreFiles(storage, &c->store, why) != 0) ok = false;
	free(key), free(root), free(keyPath), free(rootPath), free(storage);
	if (!ok) {
		free(c->folder), free(c);
		return NULL;
	}
	return c;
}

const char *cardRoot(Card *c) {
	return c->root;
}

void cardFresh(Card *c, char out[ID_LENGTH + 1]) {
	(void)c;
	fresh(out);
}

// --- what sync tells

/** a key sync changed in place: the places told after the run */
static void keyChanged(Card *c, const char *part, const char *id) {
	for (size_t i = 0; i < c->nkeys; i++)
		if (!strcmp(c->keys[i].part, part) && !strcmp(c->keys[i].id, id)) return;
	if (c->nkeys == c->keys_room) {
		c->keys_room = c->keys_room ? c->keys_room * 2 : 16;
		c->keys = realloc(c->keys, sizeof *c->keys * c->keys_room);
		if (!c->keys) abort();
	}
	c->keys[c->nkeys++] = (Key){strdup(part), strdup(id)};
}

static void committed(void *context, nd_entry *const *changed, size_t n) {
	Card *c = context;
	for (size_t i = 0; i < n; i++) {
		size_t k;
		const tb_where *w = tb_who(c->table, changed[i], &k);
		for (size_t j = 0; j < k; j++) {
			if (!w[j].part.string || !w[j].id.string) continue;
			keyChanged(c, w[j].part.string, w[j].id.string);
			if (!strcmp(w[j].part.string, "children")) c->reach = true;
		}
	}
	c->wrote = true;
}

/** an entry sync replaced or took out: the places' own (pl_own), let go of with them; a table event told the places */
static void dropped(void *context, nd_entry *e) {
	(void)context, (void)e;
}

/** a commit taken in from the card or elsewhere: counted, told; what its document's lists name followed (reach) */
static void arrived(void *context, const tp_arrival *a) {
	Card *c = context;
	if (!c->booting) count(c, 0, a->layer == TP_STORED && !a->heard, a->heard);
	if (a->layer != TP_STORED) return;
	c->reach = true;
	c->wrote = true;
	if (c->told) c->told(c->told_context, a->doc);
}

/** the places told of each key sync changed in place this run */
static void tellPlaces(Card *c) {
	for (size_t i = 0; i < c->nkeys; i++) {
		pl_event(c->l, tb_string(c->keys[i].part), tb_string(c->keys[i].id));
		free(c->keys[i].part), free(c->keys[i].id);
	}
	c->nkeys = 0;
}

// --- following

static bool follow(Card *c, const char *id) {
	uint8_t bytes[32];
	if (!tp_doc(id, bytes)) return false;
	if (im_has(&c->followed, bytes)) return true;
	im_set(&c->followed, bytes, (void *)1);
	if (!sy_follow(c->sync, id)) say(c, "card: %s is not a document", id);
	return true;
}

// a stack of ids
typedef struct {
	char **items;
	size_t count, room;
} Ids;

static void push(Ids *s, const char *id) {
	if (s->count == s->room) {
		s->room = s->room ? s->room * 2 : 16;
		s->items = realloc(s->items, sizeof *s->items * s->room);
		if (!s->items) abort();
	}
	s->items[s->count++] = strdup(id);
}

/**
 * every document a children entry reached from the root, or from one a driver brings, names:
 * followed, so it is synced with the server (what the card holds of it is in the table already)
 */
static void reach(Card *c) {
	im_map seen = {0};
	Ids todo = {0};
	uint8_t bytes[32];
	tp_doc(c->root, bytes);
	im_set(&seen, bytes, (void *)1);
	push(&todo, c->root);
	for (size_t i = 0; i < c->brought.slots; i++) {
		if (!c->brought.used[i] || im_has(&seen, c->brought.keys[i])) continue;
		im_set(&seen, c->brought.keys[i], (void *)1);
		char id[ID_LENGTH + 1];
		memcpy(id, "ermine://", 9);
		hex(c->brought.keys[i], 32, id + 9);
		push(&todo, id);
	}
	while (todo.count) {
		char *id = todo.items[--todo.count];
		follow(c, id);
		const nd_entry *children = tb_get(c->table, tb_string("children"), tb_string(id));
		free(id);
		const op_value *names = children ? children->value : NULL;
		for (size_t i = 0; names && names->type == OP_MAP && i < names->count; i++) {
			const op_value *v = names->items[i];
			if (v->type != OP_STR || !tp_doc(v->str, bytes) || im_has(&seen, bytes)) continue;
			im_set(&seen, bytes, (void *)1);
			push(&todo, v->str);
		}
	}
	im_free(&seen);
	free(todo.items);
}

// --- sync

/** sync run until nothing more can go on this turn, what it asks sent; ms until it must run again */
static int64_t run(Card *c) {
	int64_t wait = -1;
	for (int round = 0; round < 16; round++) {
		wait = sy_run(c->sync);
		bool did = false;
		tp_out o;
		while (tp_next(cardDevice(c), &o)) {
			did = true;
			if (c->host.send) c->host.send(c->host.context, &o);
			tp_out_free(&o);
		}
		if (!did && wait != 0) break;
	}
	return wait;
}

static bool isPart(const char *part) {
	for (size_t i = 0; part && i < 3; i++)
		if (!strcmp(part, PARTS[i])) return true;
	return false;
}

void cardWrote(Card *c, const pl_changed *changed, const card_born *born, size_t nborn) {
	if (!c->sync) return;
	int made = 0;
	// an entry born in the write: its value whole, at its key (sync asks the table). One holding nothing
	// yet: no commit (a removal at the root of nothing would not replay); its first patch is its first
	for (size_t i = 0; i < nborn; i++) {
		if (!born[i].entry || !born[i].entry->value || !isPart(born[i].part) || !id_is(born[i].id)) continue;
		sy_table_changed(c->sync, tb_string(born[i].part), tb_string(born[i].id));
		made++;
		if (!strcmp(born[i].part, "children")) c->reach = true;
		if (c->told) c->told(c->told_context, born[i].id);
	}
	for (size_t i = 0; changed && i < changed->n; i++) {
		nd_entry *e = changed->entries[i];
		bool new = false;
		for (size_t k = 0; k < nborn && !new; k++) new = born[k].entry == e;
		if (new || !e->change.has_op) continue;
		size_t n;
		const tb_where *w = tb_who(c->table, e, &n);
		bool kept = false;
		for (size_t j = 0; j < n; j++) {
			if (!isPart(w[j].part.string) || !id_is(w[j].id.string)) continue;
			kept = true;
			made++;
			if (!strcmp(w[j].part.string, "children")) c->reach = true;
			if (c->told) c->told(c->told_context, w[j].id.string);
		}
		if (kept) sy_wrote(c->sync, &e, 1);
	}
	if (made) count(c, made, 0, 0);
}

int64_t cardTurn(Card *c) {
	int64_t wait = run(c);
	tellPlaces(c);
	if (c->reach) {
		c->reach = false;
		reach(c);
	}
	// what was written, run
	if (c->wrote) c->wrote = false, sc_pulse(c->s);
	if (!c->booting) count(c, 0, 0, 0);
	return wait;
}

bool cardStart(Card *c, pl *places, tb_table *table, sc_scheduler *s, const card_host *host) {
	c->l = places, c->table = table, c->s = s;
	if (host) c->host = *host;
	sy_options o = {.table = table, .store = &c->store, .zeros = true, .commit = committed, .drop = dropped, .context = c};
	memcpy(o.seed, c->seed, 32);
	c->sync = sy_create(&o);
	if (!c->sync) {
		say(c, "card: Subduction would not make a device");
		return false;
	}
	hex(tp_key(sy_device(c->sync)), 32, c->hex);
	tp_arrived(sy_device(c->sync), arrived, c);
	// what the card holds, taken in before anything else: sync writes every document on it to the table
	c->booting = true;
	for (int round = 0; round < 10000; round++) {
		run(c);
		if (tp_ready(sy_device(c->sync)) && sy_idle(c->sync)) break;
	}
	tellPlaces(c);
	c->booting = false;
	c->reach = false;
	follow(c, c->root);
	reach(c);
	if (c->wrote) c->wrote = false, sc_pulse(c->s);
	size_t n = 0;
	tb_at(table, tb_string(c->root), &n);
	return n > 0;
}

void cardStop(Card *c) {
	if (!c->sync) return;
	for (int round = 0; round < 1000 && !sy_idle(c->sync); round++) run(c);
	tellPlaces(c);
}

void cardFree(Card *c) {
	if (!c) return;
	sy_free(c->sync);
	for (size_t i = 0; i < c->nkeys; i++) free(c->keys[i].part), free(c->keys[i].id);
	free(c->keys);
	im_free(&c->followed), im_free(&c->brought);
	free(c->folder), free(c);
}

sy_sync *cardSync(Card *c) {
	return c->sync;
}

tp_device *cardDevice(Card *c) {
	return c->sync ? sy_device(c->sync) : NULL;
}

const char *cardKey(Card *c) {
	return c->hex;
}

void cardFollow(Card *c, const char *doc) {
	uint8_t bytes[32];
	if (!c->sync || !tp_doc(doc, bytes) || im_has(&c->brought, bytes)) return;
	im_set(&c->brought, bytes, (void *)1);
	c->reach = true;
}

void cardTold(Card *c, void (*told)(void *context, const char *doc), void *context) {
	c->told = told;
	c->told_context = context;
}
