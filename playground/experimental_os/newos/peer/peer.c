// peer.c: the card, as sync's store (peer.h), ported from newos/peer.c. The card's folder, the seen
// table, following, reaching and syncing again are that file's, unchanged; what goes in and out is
// today's: a write the host made becomes records as wiring.ts's fromFact makes them, and an object's
// versions are written to the table as world.ts's versions writes them.
//
// The card's folder:
//   device/key    the device's Ed25519 seed, 64 hex digits, made at the first boot
//   device/root   the root's id, made at the first boot
//   subduction/   what Subduction holds (subduction/store_files.c)
//   seen          when each change was first taken in here, a line each: its blop's name, 64 hex
//                 digits, and µs since 1970; appended each turn
//
// Parts: "value" is a blop's object "value"; "attributes" its ["info", name] and "children" its
// ["children", name], one object a name. Any other part (fronts.h's "front") is never sent. A node
// whose id is not a document's is never sent either: that is what ephemeral is now.
//
// In memory: a document with an entry in the table, or the root. Versions of one not in memory are
// not written (only reachable exists); reach loads it, from its histories, when a list names it.
//
// Headers: the table's are places' (an op_value actor, metadata op_values); a blop's are json.h's
// (wiring.h). Each way, the pieces a blop carries are made again: actor, reader, the site, time,
// cause, wallclock and message. What sync adds (lamport, the blop's name, its signer) stays in the
// histories: no entry holds it.

#include "peer.h"

#include "../../../../extensions/subduction/c/apply.h"
#include "../../../../extensions/subduction/c/ed25519/ed25519.h"
#include "../../../../extensions/subduction/c/subduction/platform.h"
#include "../../../../extensions/subduction/c/subduction/store.h"
#include "../../../../extensions/subduction/c/wiring.h"

#include <errno.h>
#include <openssl/evp.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

// an object of a document, as sync told of it: what a document loaded later is filled from
typedef struct {
	char *doc;
	wiring_where where;
	char *name;
} Object;

// a set of ids
typedef struct {
	char **items;
	size_t count, room;
} Ids;

// when a change was first taken in here, by its blop's name; time 0: an empty slot
typedef struct {
	uint8_t name[32];
	int64_t time;
} Seen;

struct Peer {
	char *sd;
	uint8_t seed[32], key[32];
	char hex[65]; // the key's
	char root[ID_LENGTH + 1];
	ErmStore store;
	transport *t;
	wiring *w;
	pl *l;
	tb_table *table;
	sc_scheduler *s;
	peer_host host;
	Object *objects;
	size_t nobjects, objects_room;
	Ids followed;
	bool reach; // something arrived: what lists name, loaded again
	// the card's seen: a table by name (room a power of two), and the lines not yet appended
	Seen *seen;
	size_t nseen, seen_room;
	char *unsaved;
	size_t nunsaved, unsaved_room;
	void (*told)(void *context, const char *doc);
	void *told_context;
	bool booting; // what the card holds being taken in: seen gives what it lists, and no more
	bool making;  // a change of this machine's being committed: the blop versions is told of is its
	const char *loading; // a document being loaded: its versions written though it is not in memory yet
	bool wrote;   // the table written since the last pulse
	Ids brought;  // the documents drivers bring (peerBring): reached as the root is
	// synced again (resync): the documents made here since, and those reached that have not come; when
	// (µs, monotonic, 0: not due), and how long the next wait for those not come is
	Ids sent, due;
	int64_t again, wait;
};

static const char *VALUE = "value", *ATTRIBUTES = "attributes", *CHILDREN = "children";

static void say(Peer *p, const char *format, ...) {
	char line[512];
	va_list a;
	va_start(a, format);
	vsnprintf(line, sizeof line, format, a);
	va_end(a);
	if (p->host.say) p->host.say(p->host.context, line);
	else fprintf(stderr, "[os] %s\n", line);
}

static int64_t now(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static void count(Peer *p, int made, int stored, int heard) {
	if (p->host.count) p->host.count(p->host.context, p->followed.count, made, stored, heard);
}

static void drop(Ids *s, const char *id) {
	for (size_t i = 0; i < s->count; i++)
		if (!strcmp(s->items[i], id)) {
			free(s->items[i]);
			s->items[i] = s->items[--s->count];
			return;
		}
}

static bool has(const Ids *s, const char *id) {
	for (size_t i = 0; i < s->count; i++)
		if (!strcmp(s->items[i], id)) return true;
	return false;
}

static bool add(Ids *s, const char *id) {
	if (has(s, id)) return false;
	if (s->count == s->room) {
		s->room = s->room ? s->room * 2 : 16;
		s->items = realloc(s->items, sizeof *s->items * s->room);
	}
	s->items[s->count++] = strdup(id);
	return true;
}

static void let(Ids *s) {
	for (size_t i = 0; i < s->count; i++) free(s->items[i]);
	free(s->items);
	*s = (Ids){ 0 };
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
	char text[128] = { 0 };
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
	snprintf(command, n, "rm -rf '%s'", path);
	if (system(command) != 0) fprintf(stderr, "[os] card: could not empty %s\n", path);
	free(command);
}

/** a new document's id, for a server with no Keyhive grant for it (fresh.ts): 16 random bytes, then 16 zero bytes */
static void fresh(char out[ID_LENGTH + 1]) {
	uint8_t bytes[16];
	erm_host_random(bytes, sizeof bytes);
	char h[33];
	hex(bytes, 16, h);
	snprintf(out, ID_LENGTH + 1, "ermine://%s%032d", h, 0);
}

// --- the card's seen

static int64_t wall(void) {
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

/** a name's slot in the table: its own, or the empty one it would take */
static size_t slot(const Peer *p, const uint8_t name[32]) {
	uint64_t h;
	memcpy(&h, name, sizeof h);
	size_t mask = p->seen_room - 1, i = (size_t)h & mask;
	while (p->seen[i].time && memcmp(p->seen[i].name, name, 32)) i = (i + 1) & mask;
	return i;
}

/** a name's time kept, unless it has one: true if it had none */
static bool keep(Peer *p, const uint8_t name[32], int64_t time) {
	if ((p->nseen + 1) * 2 > p->seen_room) {
		Seen *was = p->seen;
		size_t room = p->seen_room;
		p->seen_room = room ? room * 2 : 1024;
		p->seen = calloc(p->seen_room, sizeof *p->seen);
		for (size_t i = 0; i < room; i++)
			if (was[i].time) p->seen[slot(p, was[i].name)] = was[i];
		free(was);
	}
	size_t i = slot(p, name);
	if (p->seen[i].time) return false;
	memcpy(p->seen[i].name, name, 32);
	p->seen[i].time = time;
	p->nseen++;
	return true;
}

/** a change taken in: now, the first time, kept and appended to the card's seen at the turn's end */
static void see(Peer *p, const uint8_t name[32]) {
	int64_t at = wall();
	if (!keep(p, name, at)) return;
	char line[96];
	hex(name, 32, line);
	size_t n = 64 + (size_t)snprintf(line + 64, sizeof line - 64, " %lld\n", (long long)at);
	if (p->nunsaved + n > p->unsaved_room) {
		p->unsaved_room = (p->nunsaved + n) * 2;
		p->unsaved = realloc(p->unsaved, p->unsaved_room);
	}
	memcpy(p->unsaved + p->nunsaved, line, n);
	p->nunsaved += n;
}

/** the card's seen taken in: a line cut short (power gone while appending) passed over */
static void readSeen(Peer *p) {
	char *path = joined(p->sd, "seen");
	FILE *f = fopen(path, "r");
	free(path);
	if (!f) return;
	char line[128];
	while (fgets(line, sizeof line, f)) {
		uint8_t name[32];
		long long time;
		if (strlen(line) < 67 || line[64] != ' ' || !unhex(line, 32, name) || sscanf(line + 65, "%lld", &time) != 1 || time <= 0) continue;
		keep(p, name, time);
	}
	fclose(f);
}

static void saveSeen(Peer *p) {
	if (!p->nunsaved) return;
	char *path = joined(p->sd, "seen");
	int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
	free(path);
	if (fd < 0 || write(fd, p->unsaved, p->nunsaved) != (ssize_t)p->nunsaved) say(p, "card: seen could not be written");
	if (fd >= 0) close(fd);
	p->nunsaved = 0;
}

Peer *peerOpen(const char *sd, bool clean, const char **why) {
	Peer *p = calloc(1, sizeof *p);
	p->sd = strdup(sd);
	if (clean) wipe(sd);
	char *device = joined(sd, "device"), *keyPath = joined(device, "key"), *rootPath = joined(device, "root");
	char *storage = joined(sd, "subduction");
	bool ok = made(sd) && made(device);
	if (!ok) *why = "the card's folder could not be made";
	char *key = ok ? readText(keyPath) : NULL;
	if (ok && key) {
		if (strlen(key) != 64 || !unhex(key, 32, p->seed)) ok = false, *why = "device/key is not 64 hex digits";
	} else if (ok) {
		erm_host_random(p->seed, 32);
		char text[65];
		hex(p->seed, 32, text);
		if (!writeText(keyPath, text)) ok = false, *why = "device/key could not be written";
	}
	char *root = ok ? readText(rootPath) : NULL;
	if (ok && root) {
		if (!id_is(root)) ok = false, *why = "device/root is not a document's id";
		else snprintf(p->root, sizeof p->root, "%s", root);
	} else if (ok) {
		fresh(p->root);
		if (!writeText(rootPath, p->root)) ok = false, *why = "device/root could not be written";
	}
	if (ok && ermStoreFiles(storage, &p->store, why) != 0) ok = false;
	free(key), free(root), free(device), free(keyPath), free(rootPath), free(storage);
	if (!ok) {
		free(p->sd), free(p);
		return NULL;
	}
	ermEd25519Public(p->seed, p->key);
	hex(p->key, 32, p->hex);
	readSeen(p);
	return p;
}

const char *peerRoot(Peer *p) {
	return p->root;
}

void peerFresh(Peer *p, char out[ID_LENGTH + 1]) {
	(void)p;
	fresh(out);
}

// --- values and headers

/** the same content; a map's keys in any order (fuzz_values.h's) */
static bool same(const op_value *a, const op_value *b) {
	if (a == NULL || b == NULL) return a == b;
	if (a->type != b->type) return false;
	switch (a->type) {
	case OP_NULL: return true;
	case OP_BOOL: return a->bool_ == b->bool_;
	case OP_NUM: return a->num == b->num;
	case OP_STR: return a->bytes == b->bytes && memcmp(a->str, b->str, a->bytes) == 0;
	case OP_TYPED:
		if (a->kind != b->kind) return false;
		// fall through
	case OP_BYTES: return a->bytes == b->bytes && (a->bytes == 0 || memcmp(a->data, b->data, a->bytes) == 0);
	case OP_STAND: return same(a->items[0], b->items[0]);
	case OP_LIST:
		if (a->count != b->count) return false;
		for (size_t i = 0; i < a->count; i++)
			if (!same(a->items[i], b->items[i])) return false;
		return true;
	case OP_MAP:
		if (a->count != b->count) return false;
		for (size_t i = 0; i < a->count; i++)
			if (!same(a->items[i], op_get(b, a->keys[i]))) return false;
		return true;
	}
	return false;
}

/** a value of the table's own: a history's side is shared with the sides after it, and an entry
 * changes its value in place, so what goes in is a copy (made through json.h's, as the blop held it) */
static op_value *copied(const op_value *v) {
	Json *j = apply_json(v);
	op_value *c = apply_value(j);
	jsonFree(j);
	return c;
}

// a version's header made the table's: what the entry refers to, held by it (pl_hold) till its next update
typedef struct {
	ch_header header;
	op_value *actor;
	char *reader, *file, *function;
	ch_site site;
	ch_entry metadata[3];
	op_value *values[3];
	size_t nvalues;
} Said;

static void saidFree(void *block) {
	Said *s = block;
	op_free(s->actor);
	for (size_t i = 0; i < s->nvalues; i++) op_free(s->values[i]);
	free(s->reader), free(s->file), free(s->function), free(s);
}

static Said *saidOf(const apply_version *v, const wiring_from *from) {
	Said *s = calloc(1, sizeof *s);
	const ch_header *h = v ? &v->change : NULL;
	const Json *actor = h ? h->actor : from ? from->actor : NULL;
	s->actor = actor ? apply_value(actor) : NULL;
	s->header.actor = s->actor;
	if (h && h->has_time) s->header.has_time = 1, s->header.time = h->time;
	else s->header.has_time = 1, s->header.time = 0;
	if (h && h->reader) s->header.reader = s->reader = strdup(h->reader);
	if (h && h->external_length) {
		const ch_site *site = &h->external[0];
		s->site = *site;
		s->site.file = s->file = strdup(site->file ? site->file : "");
		s->site.function = s->function = site->function ? strdup(site->function) : NULL;
		s->header.external = &s->site;
		s->header.external_length = 1;
	}
	for (size_t i = 0; h && i < h->metadata_length && s->nvalues < 3; i++) {
		const ch_entry *e = &h->metadata[i];
		op_value *value = NULL;
		if (!strcmp(e->key, "cause")) value = apply_value(e->value);
		else if (!strcmp(e->key, "wallclock")) value = op_num((double)*(const int64_t *)e->value);
		else if (!strcmp(e->key, "message")) value = op_str(e->value);
		if (!value) continue;
		s->values[s->nvalues] = value;
		s->metadata[s->nvalues] = (ch_entry){ !strcmp(e->key, "cause") ? "cause" : !strcmp(e->key, "wallclock") ? "wallclock" : "message", value };
		s->nvalues++;
	}
	if (s->nvalues) s->header.metadata = s->metadata, s->header.metadata_length = s->nvalues;
	return s;
}

// a table header made a record's for the call (wiring.h): actor and cause as json.h's, wallclock a
// number, message a string; the rest of places' pairs are not a blop's
typedef struct {
	ch_header header;
	Json *actor, *cause;
	int64_t wallclock;
	ch_entry metadata[3];
} Saying;

static void sayingOf(const ch_header *h, Saying *s) {
	*s = (Saying){ 0 };
	s->header = *h;
	s->actor = h->actor ? apply_json(h->actor) : NULL;
	s->header.actor = s->actor;
	size_t n = 0;
	bool cause = false, wallclock = false, message = false;
	for (size_t i = 0; i < h->metadata_length; i++) {
		const ch_entry *e = &h->metadata[i];
		const op_value *v = e->value;
		if (!v) continue;
		if (!cause && !strcmp(e->key, "cause")) s->cause = apply_json(v), s->metadata[n++] = (ch_entry){ "cause", s->cause }, cause = true;
		else if (!wallclock && !strcmp(e->key, "wallclock") && v->type == OP_NUM) s->wallclock = (int64_t)v->num, s->metadata[n++] = (ch_entry){ "wallclock", &s->wallclock }, wallclock = true;
		else if (!message && !strcmp(e->key, "message") && v->type == OP_STR) s->metadata[n++] = (ch_entry){ "message", v->str }, message = true;
	}
	s->header.metadata = n ? s->metadata : NULL;
	s->header.metadata_length = n;
}

static void sayingFree(Saying *s) {
	if (s->actor) jsonFree(s->actor);
	if (s->cause) jsonFree(s->cause);
}

// --- sync

static void remember(Peer *p, const char *doc, wiring_where where, const char *name) {
	for (size_t i = 0; i < p->nobjects; i++) {
		const Object *o = &p->objects[i];
		if (o->where == where && !strcmp(o->doc, doc) && (where == WIRING_VALUE || !strcmp(o->name, name))) return;
	}
	if (p->nobjects == p->objects_room) {
		p->objects_room = p->objects_room ? p->objects_room * 2 : 64;
		p->objects = realloc(p->objects, sizeof *p->objects * p->objects_room);
	}
	p->objects[p->nobjects++] = (Object){ strdup(doc), where, where == WIRING_VALUE ? NULL : strdup(name) };
}

static void follow(Peer *p, const char *id) {
	if (!add(&p->followed, id)) return;
	if (transport_follow(p->t, id) != TRANSPORT_OK) say(p, "card: %s is not a document", id);
}

// Subduction sends a commit only to peers subscribed to its tree, and a follow made before a tree held
// anything may leave the server, or this device, unsubscribed: so each document made here is synced
// again once its first change is stored, and each one reached that has not come is asked for again,
// 1 s later, then 2, 4 ... at most 30 s apart, till it comes. Not while there is no connection: each
// one syncs every document followed

static void soon(Peer *p, int64_t us) {
	int64_t at = now() + us;
	if (!p->again || at < p->again) p->again = at;
}

static void resync(Peer *p) {
	p->again = 0;
	if (p->host.joined && p->host.joined(p->host.context)) {
		// what is left of sealing and storing first, so the follow syncs it
		wiring_idle(p->w);
		for (size_t i = 0; i < p->sent.count; i++) transport_follow(p->t, p->sent.items[i]);
		for (size_t i = 0; i < p->due.count; i++)
			if (!has(&p->sent, p->due.items[i])) transport_follow(p->t, p->due.items[i]);
	}
	let(&p->sent);
	if (!p->due.count) return;
	soon(p, p->wait);
	p->wait = p->wait * 2 > 30000000 ? 30000000 : p->wait * 2;
}

/** an object as a blop names it */
static Json *objectOf(wiring_where where, const char *name) {
	if (where == WIRING_VALUE) return jsonString("value");
	Json *object = jsonArray();
	jsonPush(object, jsonString(where == WIRING_INFO ? "info" : "children"));
	jsonPush(object, jsonString(name));
	return object;
}

static const char *partOf(wiring_where where) {
	return where == WIRING_VALUE ? VALUE : where == WIRING_INFO ? ATTRIBUTES : CHILDREN;
}

/** whether a document is in memory: an entry in the table, or the root */
static bool inMemory(Peer *p, const char *doc) {
	if (!strcmp(doc, p->root)) return true;
	size_t n = 0;
	tb_at(p->table, tb_string(doc), &n);
	return n > 0;
}

// what a removal's patch refers to: kept by the entry till its next update
typedef struct {
	op_patch patch;
	op_key key;
	char *name;
} Taken;

static void takenFree(void *block) {
	Taken *t = block;
	free(t->name);
	free(t);
}

/** the first head of an object's versions written to the table, as world.ts's show: the same there already, nothing */
static void show(Peer *p, const char *doc, wiring_where where, const char *name, const apply_version *list, size_t n, const wiring_from *from) {
	const char *part = partOf(where);
	const op_value *content = n ? list[0].content : NULL;
	nd_entry *entry = tb_get(p->table, tb_string(part), tb_string(doc));
	const op_value *held = entry ? entry->value : NULL;
	bool map = held && held->type == OP_MAP;
	const op_value *there = where == WIRING_VALUE ? held : map ? op_get(held, name) : NULL;
	if (same(there, content)) return;
	Said *said = saidOf(n ? &list[0] : NULL, from);
	pl_changed changed = { 0 };
	nd_entry *made = NULL;
	// a value is changed copy-on-write (newos's api.c): what is not changed stays the same value
	if (entry && where == WIRING_VALUE) entry->in_place = 0;
	if (content) {
		op_value *value = copied(content);
		const char *path[] = { name };
		pl_upsert(p->l, tb_string(part), tb_string(doc), path, where == WIRING_VALUE ? 0 : 1, value, said->header, &changed, &made);
		op_free(value);
	} else if (entry && (where == WIRING_VALUE || (map && op_get(held, name)))) {
		// taken out: the whole value, or the name
		Taken *t = calloc(1, sizeof *t);
		if (where != WIRING_VALUE) {
			t->name = strdup(name);
			t->key = (op_key){ .type = OP_STR_KEY, .s = t->name };
			t->patch = (op_patch){ .place = { .path = &t->key, .length = 1 } };
		}
		size_t failed;
		if (nd_update(entry, &t->patch, 1, said->header, &failed) != OP_OK) {
			takenFree(t);
			saidFree(said);
			say(p, "card: %s could not be taken out of %s", name ? name : "the value", doc);
			return;
		}
		pl_hold(p->l, entry, t, takenFree);
		changed.entries[changed.n++] = entry;
	}
	if (made && where == WIRING_VALUE) made->in_place = 0;
	if (made) pl_hold(p->l, made, said, saidFree);
	else if (changed.n) pl_hold_also(p->l, changed.entries[0], said, saidFree);
	else saidFree(said);
	if (changed.n) pl_commit(p->l, &changed);
	p->wrote = true;
}

/** the wiring's versions: a blop this machine just made, by its name (from), seen; the table holds it
 * already. One from elsewhere, written, if its document is in memory */
static void versions(void *context, const char *doc, wiring_where where, const char *name, const apply_version *list, size_t n, const wiring_from *from) {
	Peer *p = context;
	uint8_t blop[32];
	if (p->making) {
		if (from && from->name && strlen(from->name) == 64 && unhex(from->name, 32, blop)) see(p, blop);
		return;
	}
	if (!inMemory(p, doc) && !(p->loading && !strcmp(p->loading, doc))) return;
	show(p, doc, where, name, list, n, from);
}

/** a record to the wiring: a document's. Its blop is seen as the wiring settles it (versions) */
static void record(Peer *p, const wiring_record *r) {
	remember(p, r->node, r->where, r->name);
	// one followed first now, empty still: synced again once this is stored (resync)
	if (!has(&p->followed, r->node)) add(&p->sent, r->node), soon(p, 20000);
	follow(p, r->node);
	bool was = p->making;
	p->making = true;
	wiring_changed(p->w, r);
	p->making = was;
	count(p, 1, 0, 0);
	// a list changed may name a document not here yet: followed at the turn's end (reach)
	if (r->where == WIRING_CHILDREN) p->reach = true;
	if (p->told) p->told(p->told_context, r->node);
}

static bool whereOf(tb_key part, wiring_where *where) {
	if (!part.string) return false;
	if (!strcmp(part.string, VALUE)) *where = WIRING_VALUE;
	else if (!strcmp(part.string, ATTRIBUTES)) *where = WIRING_INFO;
	else if (!strcmp(part.string, CHILDREN)) *where = WIRING_CHILDREN;
	else return false;
	return true;
}

// a name's patches, for one record each
typedef struct {
	char *name;
	op_patch *patches;
	size_t n, room;
} Named;

static Named *named(Named **all, size_t *n, const char *name) {
	for (size_t i = 0; i < *n; i++)
		if (!strcmp((*all)[i].name, name)) return &(*all)[i];
	*all = realloc(*all, sizeof **all * (*n + 1));
	Named *k = &(*all)[(*n)++];
	*k = (Named){ strdup(name), NULL, 0, 0 };
	return k;
}

static void put(Named *k, op_patch patch) {
	if (k->n == k->room) {
		k->room = k->room ? k->room * 2 : 4;
		k->patches = realloc(k->patches, sizeof *k->patches * k->room);
	}
	k->patches[k->n++] = patch;
}

static const char *keyName(const op_key *key, char *buffer, size_t size) {
	if (key->type == OP_STR_KEY) return key->s;
	snprintf(buffer, size, "%ld", key->n);
	return buffer;
}

/**
 * a fact as records, as fromFact makes them: the value table is the object "value"; attributes and
 * children an object each name, the patches' first step the name taken off. What cannot be put in
 * one name is left out: a patch at the table itself, and a move that is not a rename
 */
static void fact(Peer *p, const pl_fact *f) {
	wiring_where where;
	if (!f->change || !f->id.string || !id_is(f->id.string) || !whereOf(f->part, &where)) return;
	Saying saying;
	sayingOf(f->change, &saying);
	wiring_record r = { .node = f->id.string, .where = where, .header = saying.header, .at = WIRING_AT_VERSION };
	if (where == WIRING_VALUE) {
		r.patches = f->patches, r.patch_count = f->patches_length;
		record(p, &r);
		sayingFree(&saying);
		return;
	}
	const op_value *held = f->entry ? f->entry->value : NULL;
	Named *all = NULL;
	size_t n = 0;
	char a[32], b[32];
	for (size_t i = 0; i < f->patches_length; i++) {
		const op_patch *patch = &f->patches[i];
		if (!patch->place.length) continue;
		const char *name = keyName(&patch->place.path[0], a, sizeof a);
		if (!patch->has_move) {
			op_patch under = *patch;
			under.place.path = patch->place.path + 1;
			under.place.length = patch->place.length - 1;
			put(named(&all, &n, name), under);
		} else if (patch->place.length == 1 && patch->move.length == 1 && !patch->place.has_range && !patch->move.has_range) {
			// a rename: the name taken out, the new one put
			put(named(&all, &n, keyName(&patch->move.path[0], b, sizeof b)), (op_patch){ 0 });
			const op_value *value = held && held->type == OP_MAP ? op_get(held, name) : NULL;
			put(named(&all, &n, name), (op_patch){ .has_value = 1, .value = value });
		}
	}
	for (size_t i = 0; i < n; i++) {
		r.name = all[i].name, r.patches = all[i].patches, r.patch_count = all[i].n;
		record(p, &r);
		free(all[i].name), free(all[i].patches);
	}
	free(all);
	sayingFree(&saying);
}

void peerWrote(Peer *p, const pl_changed *changed) {
	if (!p->w || !changed || !changed->n) return;
	pl_facts facts = pl_each_entry_change(p->l, changed);
	for (size_t i = 0; i < facts.n; i++) fact(p, &facts.items[i]);
	pl_facts_free(&facts);
}

void peerAdded(Peer *p, tb_key part, tb_key id) {
	wiring_where where;
	if (!p->w || !id.string || !id_is(id.string) || !whereOf(part, &where)) return;
	const nd_entry *e = tb_get(p->table, part, id);
	if (!e) return;
	Saying saying;
	sayingOf(&e->change, &saying);
	wiring_record r = { .node = id.string, .where = where, .header = saying.header, .at = WIRING_AT_VERSION };
	if (where == WIRING_VALUE) {
		op_patch whole = { .has_value = e->value != NULL, .value = e->value };
		r.patches = &whole, r.patch_count = 1;
		record(p, &r);
	} else if (e->value && e->value->type == OP_MAP)
		for (size_t i = 0; i < e->value->count; i++) {
			op_patch whole = { .has_value = 1, .value = e->value->items[i] };
			r.name = e->value->keys[i], r.patches = &whole, r.patch_count = 1;
			record(p, &r);
		}
	sayingFree(&saying);
}

static int64_t noTime(void *context, const char *name) {
	(void)context, (void)name;
	return 0;
}

/** an object's versions, as its histories hold them, written (as the wiring settles an arrival) */
static void settle(Peer *p, const char *doc, wiring_where where, const char *name) {
	histories *c = transport_histories(p->t, doc, TRANSPORT_STORED);
	if (!c) return;
	Json *object = objectOf(where, name);
	apply_version *vs = NULL;
	size_t n = apply_versions(c, object, noTime, NULL, &vs);
	jsonFree(object);
	if (n) show(p, doc, where, name, vs, n, NULL);
	free(vs);
}

/** a document the card (or another device) holds: filled from its histories, followed */
static void load(Peer *p, const char *id) {
	p->loading = id;
	for (size_t i = 0; i < p->nobjects; i++)
		if (!strcmp(p->objects[i].doc, id)) {
			char *name = p->objects[i].name ? strdup(p->objects[i].name) : NULL;
			settle(p, id, p->objects[i].where, name);
			free(name);
		}
	p->loading = NULL;
	follow(p, id);
}

/** whether sync has told of any object of a document */
static bool known(const Peer *p, const char *doc) {
	for (size_t i = 0; i < p->nobjects; i++)
		if (!strcmp(p->objects[i].doc, doc)) return true;
	return false;
}

/**
 * every document a children entry reached from the root, or from one a driver brings, names: loaded
 * if the card holds it, else followed, so it comes from the server, and is loaded when it has
 */
static void reach(Peer *p) {
	Ids seen = { 0 }, todo = { 0 };
	add(&seen, p->root), add(&todo, p->root);
	for (size_t i = 0; i < p->brought.count; i++)
		if (add(&seen, p->brought.items[i])) add(&todo, p->brought.items[i]);
	while (todo.count) {
		char *id = todo.items[--todo.count];
		bool here = inMemory(p, id);
		if (!here && known(p, id)) load(p, id), here = true;
		else if (!here) {
			follow(p, id);
			// asked for again till it comes (resync)
			if (add(&p->due, id)) p->wait = 1000000, soon(p, p->wait);
		}
		const nd_entry *children = here ? tb_get(p->table, tb_string(CHILDREN), tb_string(id)) : NULL;
		free(id);
		const op_value *names = children ? children->value : NULL;
		for (size_t i = 0; names && names->type == OP_MAP && i < names->count; i++) {
			const op_value *c = names->items[i];
			if (c->type != OP_STR || !id_is(c->str) || has(&seen, c->str)) continue;
			add(&seen, c->str), add(&todo, c->str);
		}
	}
	let(&seen);
	free(todo.items);
}

/** a blop taken in: its object remembered, it seen (from elsewhere: the card's own are seen as listed); the root's, or a followed document's, loaded on the next turn */
static void arrived(void *context, const transport_arrival *a) {
	Peer *p = context;
	if (!p->booting) count(p, 0, a->layer == TRANSPORT_STORED, a->heard);
	if (a->layer != TRANSPORT_STORED) return;
	const Json *o = jsonGet(a->blop, "object");
	if (o && jsonIsString(o)) remember(p, a->doc, WIRING_VALUE, NULL);
	else if (o && jsonIsArray(o) && o->array.count == 2 && jsonIsString(o->array.items[0]) && jsonIsString(o->array.items[1]))
		remember(p, a->doc, !strcmp(o->array.items[0]->string, "info") ? WIRING_INFO : WIRING_CHILDREN, o->array.items[1]->string);
	if (!p->booting) see(p, a->name);
	drop(&p->due, a->doc);
	p->reach = true;
	if (p->told) p->told(p->told_context, a->doc);
}

int64_t peerTurn(Peer *p) {
	int64_t wait = -1;
	if (!p->booting && p->again && now() >= p->again) resync(p);
	for (int round = 0; round < 16; round++) {
		bool did = wiring_idle(p->w);
		wait = transport_run(p->t);
		transport_out o;
		// what the transport asks, sent on the connection (none: dropped; each connection syncs again)
		while (transport_next(p->t, &o)) {
			did = true;
			if (p->host.send) p->host.send(p->host.context, &o);
			transport_out_free(&o);
		}
		if (!did) break;
	}
	const char *trouble = wiring_trouble(p->w);
	if (trouble) say(p, "card: %s", trouble);
	if (p->reach) {
		p->reach = false;
		reach(p);
	}
	saveSeen(p);
	// what was written, run
	if (p->wrote) p->wrote = false, sc_pulse(p->s);
	if (!p->booting) {
		count(p, 0, 0, 0);
		// a resync due
		int64_t at = now(), due = !p->again ? -1 : p->again <= at ? 0 : (p->again - at + 999) / 1000;
		if (due >= 0 && (wait < 0 || due < wait)) wait = due;
	}
	return wait;
}

/** the signer: Ed25519 by libcrypto (linked for the transport's TLS), the same 64 bytes as ed25519.c's
 * in a thirtieth of the time (ed25519.c is small and slow on purpose; a fresh card seals some 1,300
 * commits at boot). ed25519.c when libcrypto will not */
static size_t sign(void *context, const uint8_t *message, size_t length, uint8_t signature[64]) {
	size_t n = 64;
	EVP_PKEY *key = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, context, 32);
	EVP_MD_CTX *c = key ? EVP_MD_CTX_new() : NULL;
	bool signed_ = c && EVP_DigestSignInit(c, NULL, NULL, NULL, key) == 1 && EVP_DigestSign(c, signature, &n, message, length) == 1 && n == 64;
	EVP_MD_CTX_free(c);
	EVP_PKEY_free(key);
	if (!signed_) ermEd25519Sign(context, message, length, signature);
	return 64;
}

static void randomBytes(void *context, size_t n, uint8_t *out) {
	(void)context;
	erm_host_random(out, n);
}

bool peerStart(Peer *p, pl *places, tb_table *table, sc_scheduler *s, const peer_host *host) {
	p->l = places, p->table = table, p->s = s;
	if (host) p->host = *host;
	p->t = transport_create_told(p->seed, &p->store, arrived, p);
	wiring_options wo = { 0 };
	wo.versions = versions;
	wo.context = p;
	memcpy(wo.signer.key, p->key, 32);
	wo.signer.sign = sign;
	wo.signer.context = p->seed;
	wo.random = randomBytes;
	p->w = wiring_create(p->t, &wo);
	// what the card holds, taken in before anything else: the root settled by the wiring, the rest loaded
	p->booting = true;
	peerTurn(p);
	p->booting = false;
	follow(p, p->root);
	reach(p);
	if (p->wrote) p->wrote = false, sc_pulse(p->s);
	return known(p, p->root);
}

void peerStop(Peer *p) {
	peerTurn(p);
	wiring_idle(p->w);
	saveSeen(p);
}

void peerFree(Peer *p) {
	if (!p) return;
	wiring_free(p->w);
	transport_free(p->t);
	for (size_t i = 0; i < p->nobjects; i++) free(p->objects[i].doc), free(p->objects[i].name);
	free(p->objects);
	let(&p->followed), let(&p->brought), let(&p->sent), let(&p->due);
	free(p->seen), free(p->unsaved), free(p->sd), free(p);
}

transport *peerTransport(Peer *p) {
	return p->t;
}

void peerBring(Peer *p, const char *doc, bool brought) {
	if (!id_is(doc)) return;
	if (brought) {
		if (add(&p->brought, doc)) p->reach = true;
		return;
	}
	drop(&p->brought, doc);
}

// --- for the histories

const char *peerKey(Peer *p) {
	return p->hex;
}

histories *peerHistories(Peer *p, const char *doc) {
	return id_is(doc) ? transport_histories(p->t, doc, TRANSPORT_STORED) : NULL;
}

Json *peerObjects(Peer *p, const char *doc) {
	Json *out = jsonArray();
	for (size_t i = 0; i < p->nobjects; i++)
		if (!strcmp(p->objects[i].doc, doc)) jsonPush(out, objectOf(p->objects[i].where, p->objects[i].name));
	return out;
}

int64_t peerSeen(Peer *p, const uint8_t name[32]) {
	return p->seen_room ? p->seen[slot(p, name)].time : 0;
}

void peerTold(Peer *p, void (*told)(void *context, const char *doc), void *context) {
	p->told = told;
	p->told_context = context;
}
