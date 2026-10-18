// drv_sync.c: /drivers/sync, a document's history, from its commits on the card: each change in
// order, served while someone asks for it, as ephemeral nodes. Sync itself, the device and the card
// are card.c's, which this reads (card.h); the network is net.c's, /dev/sync/link its; the link
// drv_link.c's.
//
//   /dev/sync/want/<name>      a reader's, ephemeral: the documents it wants the histories of, [id]
//   /dev/sync/history/<hex>    served while any want names it: {doc, count, changes}
//   /dev/sync/device           {key}: this device's, as a commit's signer says it
//   /dev/sync/live             {on}: whether this device's presence goes out with its live state (below)
//   /dev/sync/presence/<hex>/<key>   a peer's live state standing at the shared document hex, by the peer's key:
//                              {pointer: {x, y}, focus, drag: {id, how, x, y, w, h}, presence: {device, name}, seen}, as
//                              it sent it; gone when its commit stops standing (sync.h's ttl). Shown only while
//                              /etc/sync's presence (on unless set off) and the document's choice say so
//
// Live state (the `live` part, irq 68): what this device shows and never stores, sent to the peers
// of each shared document as ephemeral commits of its `live` table (card.h, Live state) when the
// person chose so, in all three places: /etc/sync's live (off unless set), the device's switch
// (/dev/pointer/live, /dev/display/live, /dev/sync/live, each {on}, on at boot), and the document's
// (/dev/sync/shared's value, {<hex>: {live}}: the shell's share and mount with the word live). The
// part reads them tracked, with /dev/pointer/at, /dev/display/focus, /dev/wm/hand's drag (and the
// dragged window's place, /dev/display/windows/<id>) and /hw's user, and gives the card the state,
// {pointer?, focus?, drag?, presence?, seen}, for each document it goes to; the card sends it at
// most every beat. Nothing read while /etc/sync's live is off or no document's is on, so a pointer
// move then runs nothing here. The card tells (cardLived) when what stands at a shared document
// changed, and irq 68's turn writes /dev/sync/presence from it. Receiving is chosen too, mirroring
// sending: /etc/sync's presence (on unless set off) and the document's ({<hex>: {presence}}, the
// shell's word nopresence): off, the document is not watched and its presence nodes go, so nothing
// is read, decoded or drawn for it; on again, built from what stands.
//
// A change, one commit (ermine/encoding/c/commit.h): {commit, parents, signer, lamport, time, kind,
// name?, patches, base?, merge?, actor, reader?, site?, cause?, wallclock?, message?, value?}. A
// commit changes one table of the node: kind "write" its value, "info" its attributes, "children"
// its children; name is the one name every patch is under, when there is one. commit is the
// commit's name, parents, base and signer as it holds them, in hex (a name 68 digits); patches as it holds
// them; actor, reader, site (its first external), cause, wallclock and message from its change.
// time: the change's, µs since 1970 (a commit always has one: sync stamps what has none). value:
// the node's value after it; left out when there is none, or when it is more than 4 KB as JSON.
//
// In order: each after its parents, then by time, then Lamport number, then name.
//
// Fresh: card.c tells of each document a commit is taken in to, made here or come; one served posts
// irq 65 once, whose turn takes its new commits into its history. Nothing is read or made while no
// want names a document.
//
// Grown, not made again: the changes made are kept, and only the commits not yet in them are ordered
// and added, the value after each from the value after what it follows (a merge, or one not kept:
// sync's replay). A new one that sorts before one already made (a time earlier than its) makes the
// history again from the start.

#include "../drivers.h"
#include "../../../../ermine/encoding/c/json_text.h"
#include "../drv.h"
#include "net.h"
#include "card.h"
#include "../../../../extensions/subduction/c/subduction/platform.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// HEX: a name's hex digits and the end (CM_NAME bytes: 0x1e 0x20, then the BLAKE3 digest)
#define HEX (2 * CM_NAME + 1)

#define IRQ 65
#define LIVE_IRQ 68
#define SMALL 4096 // bytes of JSON: a value kept with each change, at most

/** a served document's history, as far as it is made */
typedef struct Served {
	char *hex;
	op_value **changes; // made, in order, each held
	int count, room;
	ErmMap done;        // a name (hex) -> (void *)1, each commit in changes
	ErmMap values;      // a name (hex) -> the node's value after it, held; a commit after which there is none has no entry
	int64_t time, lamport;
	char last[HEX];      // the greatest made, by order: its time, Lamport number and name; "": none
} Served;

static struct {
	Card *card;
	ERM_LIST(Served *) served; // the documents served
	ErmMap marks;              // a served document's hex -> (void *)1 when a commit was taken in to it since irq 65
	bool posted;               // irq 65 posted and not yet taken
} hist;

static struct {
	ErmMap watching; // a shared document's hex -> (void *)1: watched for peers' live state
	ErmMap going;    // a document's hex -> (void *)1: this device's live state was given for it last
	ErmMap stood;    // a watched document's hex -> (void *)1: what stands there changed since irq 68
	bool posted;     // irq 68 posted and not yet taken
	char *last;      // the state last given to the card, printed; NULL: none
} live;

/** a map's keys freed */
static void mapFree(ErmMap *m) {
	for (int i = 0; i < m->count; i++) free((void *)m->entries[i].key);
	free(m->entries);
	free(m->index);
	*m = (ErmMap){ 0 };
}

/** a map of held values freed */
static void valuesFree(ErmMap *m) {
	for (int i = 0; i < m->count; i++) op_free(m->entries[i].value);
	mapFree(m);
}

static void hexOfBytes(const uint8_t *bytes, size_t length, char *out) {
	for (size_t i = 0; i < length; i++) snprintf(out + 2 * i, 3, "%02x", bytes[i]);
	out[2 * length] = 0;
}
static void hexName(const uint8_t *bytes, char out[HEX]) { hexOfBytes(bytes, CM_NAME, out); }

/** an id as a want names it, "ermine://<hex>" or the bare hex, to its hex; NULL for anything else */
static const char *hexOf(const char *id) {
	if (id && strncmp(id, "ermine://", 9) == 0) id += 9;
	if (!id || strlen(id) != 64) return NULL;
	for (const char *c = id; *c; c++)
		if (!strchr("0123456789abcdef", *c)) return NULL;
	return id;
}

static Served *servedOf(const char *hex) {
	for (int i = 0; i < hist.served.count; i++)
		if (!strcmp(hist.served.items[i]->hex, hex)) return hist.served.items[i];
	return NULL;
}

/** a document a commit was taken in to (card.c): when it is served, irq 65 once */
static void told(void *context, const char *doc) {
	(void)context;
	const char *hex = hexOf(doc);
	if (!hex || !servedOf(hex)) return;
	ermMapPut(&hist.marks, hex, (void *)1);
	if (hist.posted) return;
	hist.posted = true;
	ermosPost("{\"irq\": 65}");
}

// --- a history, grown

/** a commit not yet in the history, as it is ordered */
typedef struct {
	const hy_kept *kept;
	char hex[HEX];
	int64_t time, lamport;
} Fresh;

/** one's order against another's: by time, then Lamport number, then name */
static int order(int64_t ta, int64_t la, const char *na, int64_t tb, int64_t lb, const char *nb) {
	if (ta != tb) return ta < tb ? -1 : 1;
	if (la != lb) return la < lb ? -1 : 1;
	return strcmp(na, nb);
}

static int byOrder(const void *a, const void *b) {
	const Fresh *x = a, *y = b;
	return order(x->time, x->lamport, x->hex, y->time, y->lamport, y->hex);
}

/** a commit's time, µs since 1970 */
static int64_t timeOf(const hy_kept *k) {
	cm_commit c;
	if (cm_decode(k->bytes, k->length, &c, NULL) != CM_OK) return 0;
	int64_t t = c.change.has_time ? c.change.time * 1000000 : 0;
	cm_free(&c);
	return t;
}

/** the commits of the document not yet made: from its heads, back through their parents to those made */
static int collect(const Served *s, const hy_history *h, Fresh **out) {
	ERM_LIST(const hy_kept *) todo = { 0 };
	ERM_LIST(Fresh) fresh = { 0 };
	ErmMap visited = { 0 };
	const hy_kept **heads = NULL;
	size_t n = hy_heads(h, &heads);
	for (size_t k = 0; k < n; k++) ERM_PUSH(todo, heads[k]);
	free(heads);
	while (todo.count) {
		const hy_kept *k = todo.items[--todo.count];
		char x[HEX];
		hexName(k->name, x);
		if (ermMapHas(&s->done, x) || ermMapHas(&visited, x)) continue;
		ermMapPut(&visited, x, (void *)1);
		Fresh f = { .kept = k, .time = timeOf(k), .lamport = k->lamport };
		memcpy(f.hex, x, sizeof x);
		ERM_PUSH(fresh, f);
		for (size_t q = 0; q < k->parents_length; q++) {
			const hy_kept *p = hy_get(h, k->parents[q]);
			if (p) ERM_PUSH(todo, p);
		}
	}
	free(todo.items);
	mapFree(&visited);
	*out = fresh.items;
	return fresh.count;
}

/** made again from the start: nothing made */
static void restart(Served *s) {
	for (int i = 0; i < s->count; i++) op_free(s->changes[i]);
	s->count = 0;
	mapFree(&s->done);
	valuesFree(&s->values);
	*s->last = 0;
}

static const char *const CARRIED[] = { "cause", "wallclock", "message" };

/** the node's value after the commit, held: from the value after what it follows, else sync's replay; NULL: none */
static op_value *valueAfter(Served *s, const char *doc, const Fresh *f, const cm_commit *c) {
	const uint8_t (*from)[CM_NAME];
	size_t n = hy_follows(f->kept, &from);
	bool write = !strcmp(c->table, "value");
	if (n <= 1) {
		char h[HEX];
		if (n) hexName(from[0], h);
		const op_value *before = n ? ermMapGet(&s->values, h) : NULL;
		bool known = n == 0 || ermMapHas(&s->done, h);
		if (known && !write) return before ? op_ref((op_value *)before) : NULL;
		op_value *after = NULL;
		size_t failed;
		if (known && op_apply(before, c->patches, c->patches_length, NULL, &after, &failed) == OP_OK) return after;
	}
	// a merge, or one whose way here is not kept: the tables at it, replayed
	rp_tables t;
	rp_init(&t);
	op_value *v = NULL;
	if (sy_get(cardSync(hist.card), doc, f->kept->name, &t) == RP_OK) {
		const nd_entry *e = rp_find(&t, "value");
		if (e && e->value) v = op_ref(e->value);
	}
	rp_free(&t);
	return v;
}

/** a commit into the history, after the last: what it did, and the node's value after it */
static void add(Served *s, const char *doc, const Fresh *f) {
	cm_commit c;
	if (cm_decode(f->kept->bytes, f->kept->length, &c, NULL) != CM_OK) return;
	Json *j = cm_to_json(&c);
	op_value *e = op_map(), *parents = op_list();
	op_set(e, "commit", op_str(f->hex));
	for (size_t i = 0; i < c.parents_length; i++) {
		char h[HEX];
		hexName(c.parents[i], h);
		op_push(parents, op_str(h));
	}
	op_set(e, "parents", parents);
	char signer[2 * CM_SIGNER_MAX + 1];
	hexOfBytes(c.signer, c.signer_length, signer);
	op_set(e, "signer", op_str(signer));
	op_set(e, "lamport", op_num((double)c.lamport));
	if (f->time) op_set(e, "time", op_num((double)f->time));
	bool write = !strcmp(c.table, "value");
	op_set(e, "kind", op_str(write ? "write" : !strcmp(c.table, "attributes") ? "info" : c.table));
	// the one name every patch is under, when there is one
	const char *name = NULL;
	for (size_t i = 0; i < c.patches_length; i++) {
		const op_patch *p = &c.patches[i];
		const char *first = p->place.length && p->place.path[0].type == OP_STR_KEY ? p->place.path[0].s : NULL;
		if (!first || (name && strcmp(name, first)) || (p->has_move && (!p->move.length || p->move.path[0].type != OP_STR_KEY || strcmp(first, p->move.path[0].s)))) {
			name = NULL;
			break;
		}
		name = first;
	}
	if (name && !write) op_set(e, "name", op_str(name));
	op_set(e, "patches", j ? valOf(jsonGet(j, "patches")) : op_list());
	if (c.has_base) {
		char base[HEX];
		hexName(c.base, base);
		op_set(e, "base", op_str(base));
	}
	if (c.merge) op_set(e, "merge", op_str(c.merge));
	if (j && jsonGet(j, "actor")) op_set(e, "actor", valOf(jsonGet(j, "actor")));
	if (c.change.reader) op_set(e, "reader", op_str(c.change.reader));
	if (c.change.external_length) {
		const ch_site *site = &c.change.external[0];
		op_value *where = op_map();
		op_set(where, "file", op_str(site->file ? site->file : ""));
		op_set(where, "line", op_num((double)site->line));
		if (site->has_column) op_set(where, "column", op_num((double)site->column));
		if (site->function) op_set(where, "function", op_str(site->function));
		op_set(e, "site", where);
	}
	for (size_t i = 0; i < c.change.metadata_length; i++) {
		const ch_entry *m = &c.change.metadata[i];
		for (size_t k = 0; k < sizeof CARRIED / sizeof *CARRIED; k++)
			if (!strcmp(m->key, CARRIED[k]) && m->value && !op_get(e, CARRIED[k])) op_set(e, CARRIED[k], op_ref((op_value *)m->value));
	}
	// the value after it, kept by name for what follows it
	op_value *value = valueAfter(s, doc, f, &c);
	if (value) {
		Json *v = jsonOfVal(value);
		char *text = v ? jsonPrint(v) : NULL;
		if (text && strlen(text) <= SMALL) op_set(e, "value", op_ref(value));
		free(text);
		jsonFree(v);
		ermMapPut(&s->values, f->hex, value);
	}
	jsonFree(j);
	cm_free(&c);
	s->changes = growArray(s->changes, s->count, &s->room, sizeof *s->changes);
	s->changes[s->count++] = e;
	ermMapPut(&s->done, f->hex, (void *)1);
	if (!*s->last || order(f->time, f->lamport, f->hex, s->time, s->lamport, s->last) > 0) {
		s->time = f->time, s->lamport = f->lamport;
		memcpy(s->last, f->hex, sizeof s->last);
	}
}

/** a heap of places in the order, the least on top */
typedef ERM_LIST(int) Heap;

static void heapPush(Heap *h, int v) {
	ERM_PUSH(*h, v);
	for (int i = h->count - 1; i > 0 && h->items[(i - 1) / 2] > h->items[i]; i = (i - 1) / 2) {
		int t = h->items[i];
		h->items[i] = h->items[(i - 1) / 2];
		h->items[(i - 1) / 2] = t;
	}
}

static int heapPop(Heap *h) {
	int top = h->items[0];
	h->items[0] = h->items[--h->count];
	for (int i = 0;;) {
		int l = 2 * i + 1, r = l + 1, least = i;
		if (l < h->count && h->items[l] < h->items[least]) least = l;
		if (r < h->count && h->items[r] < h->items[least]) least = r;
		if (least == i) break;
		int t = h->items[i];
		h->items[i] = h->items[least];
		h->items[least] = t;
		i = least;
	}
	return top;
}

/**
 * the commits not yet in the history, in order (each after its parents, then the least by time,
 * Lamport number and name), taken in; true when any was
 */
static bool grow(Served *s) {
	char doc[96];
	snprintf(doc, sizeof doc, "ermine://%s", s->hex);
	const hy_history *h = tp_history(cardDevice(hist.card), doc, TP_STORED);
	Fresh *fresh = NULL;
	int m = h ? collect(s, h, &fresh) : 0;
	bool behind = false;
	for (int k = 0; k < m && !behind; k++) behind = *s->last && order(fresh[k].time, fresh[k].lamport, fresh[k].hex, s->time, s->lamport, s->last) < 0;
	if (behind) {
		free(fresh);
		restart(s);
		m = collect(s, h, &fresh);
	}
	qsort(fresh, (size_t)m, sizeof *fresh, byOrder);
	// each one's parents not yet made, and the ones each is a parent of
	ErmMap at = { 0 }; // a name (hex) -> its place in the order + 1
	for (int k = 0; k < m; k++) ermMapPut(&at, fresh[k].hex, (void *)(intptr_t)(k + 1));
	int *waiting = calloc((size_t)m + 1, sizeof *waiting);
	ERM_LIST(int) *kids = calloc((size_t)m + 1, sizeof *kids);
	Heap ready = { 0 };
	for (int k = 0; k < m; k++) {
		const hy_kept *c = fresh[k].kept;
		for (size_t q = 0; q < c->parents_length; q++) {
			char x[HEX];
			hexName(c->parents[q], x);
			intptr_t j = (intptr_t)ermMapGet(&at, x);
			if (!j || j - 1 == k) continue;
			waiting[k]++;
			ERM_PUSH(kids[j - 1], k);
		}
	}
	for (int k = 0; k < m; k++)
		if (!waiting[k]) heapPush(&ready, k);
	// of those whose parents are all made, the first in the order; one left waiting is in a cycle, never made
	while (ready.count) {
		int k = heapPop(&ready);
		add(s, doc, &fresh[k]);
		for (int i = 0; i < kids[k].count; i++)
			if (!--waiting[kids[k].items[i]]) heapPush(&ready, kids[k].items[i]);
	}
	for (int k = 0; k < m; k++) free(kids[k].items);
	free(kids);
	free(waiting);
	free(ready.items);
	free(fresh);
	mapFree(&at);
	return behind || m > 0;
}

/** the node's value: the changes made, each held by the list too */
static op_value *historyOf(const Served *s) {
	char doc[96];
	snprintf(doc, sizeof doc, "ermine://%s", s->hex);
	op_value *v = op_map(), *list = op_list();
	for (int i = 0; i < s->count; i++) op_push(list, op_ref(s->changes[i]));
	op_set(v, "doc", op_str(doc));
	op_set(v, "count", op_num(s->count));
	op_set(v, "changes", list);
	return v;
}

// --- serving

/**
 * a history's node at /dev/sync/history/<hex>: written; else placed, made if need be (an ephemeral
 * node unplaced is still its maker's, so one served before is placed again), and written
 */
static void serve(const ErmGiven *g, const Served *s) {
	Host *h = drvHost();
	ap_api *api = g->api;
	op_value *value = historyOf(s);
	size_t n;
	const char *const *at = hostPath(h, &n, "/", "dev", "sync", "history", s->hex, NULL);
	const ap_item *folder = hostLook(api, at, n - 1);
	char id[96];
	snprintf(id, sizeof id, "sync/history/%s", s->hex);
	const char *made = id;
	if (hostLook(api, at, n)) hostFailed(h, hostSnap(api, at, n, value), "sync: writing a history");
	else if (!folder) hostSay(h, "sync: no /dev/sync/history");
	else if (!hostFailed(h, ap_create(api, value, id, 1, &made), "sync: making a history"))
		hostFailed(h, ap_insert(api, folder->id, s->hex, made, NULL, NULL), "sync: placing a history");
	op_free(value);
}

/** no longer wanted: its node unplaced, the rest let go */
static void unserve(const ErmGiven *g, Served *s) {
	char *id = formatString("sync/history/%s", s->hex);
	drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "sync", "history", NULL), "name", jsonString(s->hex), "id", jsonString(id), NULL));
	free(id);
	restart(s);
	free(s->changes);
	free(s->hex);
	free(s);
}

/** each want's ids, read tracked: the documents wanted, hex, sorted, once each */
static ErmErr wantCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	ErmMap seen = { 0 };
	Json *hexes = jsonArray();
	Json *names = drvNames(g->api, drvPath("/", "dev", "sync", "want", NULL));
	for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
		Json *ids = drvRead(g->api, drvPath("/", "dev", "sync", "want", jsonText(names->array.items[i]), NULL));
		for (int k = 0; jsonIsArray(ids) && k < ids->array.count; k++) {
			const char *hex = hexOf(jsonText(ids->array.items[k]));
			if (!hex || ermMapHas(&seen, hex)) continue;
			ermMapPut(&seen, hex, (void *)1);
			jsonPush(hexes, jsonString(hex));
		}
	}
	// sorted, so the same wants in another order are the same value
	for (int i = 1; i < hexes->array.count; i++)
		for (int k = i; k > 0 && strcmp(jsonText(hexes->array.items[k - 1]), jsonText(hexes->array.items[k])) > 0; k--) {
			Json *t = hexes->array.items[k];
			hexes->array.items[k] = hexes->array.items[k - 1];
			hexes->array.items[k - 1] = t;
		}
	mapFree(&seen);
	*out = hexes;
	return ermOk();
}

/** the histories wanted served, those no longer wanted unplaced */
static ErmErr wantEffect(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	ErmMap wanted = { 0 };
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) ermMapPut(&wanted, jsonText(g->value->array.items[i]), (void *)1);
	int k = 0;
	for (int i = 0; i < hist.served.count; i++) {
		Served *s = hist.served.items[i];
		if (ermMapHas(&wanted, s->hex)) hist.served.items[k++] = s;
		else unserve(g, s);
	}
	hist.served.count = k;
	mapFree(&wanted);
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		const char *hex = jsonText(g->value->array.items[i]);
		if (servedOf(hex)) continue;
		Served *s = calloc(1, sizeof *s);
		s->hex = copyString(hex);
		grow(s);
		serve(g, s);
		ERM_PUSH(hist.served, s);
	}
	return ermOk();
}

/** /etc/sync, read tracked: the server and service named, so the effect runs only when they change */
static ErmErr serverCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *v = drvRead(g->api, drvPath("/", "etc", "sync", NULL));
	Json *server = jsonGet(v, "server"), *service = jsonGet(v, "service");
	*out = drvMap("server", server ? jsonShallow(server) : jsonNull(), "service", service ? jsonShallow(service) : jsonNull(), NULL);
	return ermOk();
}

/** the network told /etc/sync changed: it reads the server again and connects anew */
static ErmErr serverEffect(void *data, const ErmGiven *g, Json **out) {
	(void)data, (void)g;
	*out = jsonNull();
	Net *n = hostNet(drvHost());
	if (n) netTarget(n);
	return ermOk();
}

// --- live state

static bool on(const Json *v) {
	return v && v->type == JSON_BOOLEAN && v->boolean;
}

/** a device's switch, /dev/<device>/live's on: on unless it says off */
static bool switched(const ErmGiven *g, const char *device) {
	Json *v = drvRead(g->api, drvPath("/", "dev", device, "live", NULL));
	Json *o = jsonGet(v, "on");
	return !o || on(o);
}

/** a borrowed value for a map of the turn's: copied shallow, or null */
static Json *given(Json *v) {
	return v ? jsonShallow(v) : jsonNull();
}

/** a document's choice of name (live, presence) in /dev/sync/shared's value; unless: when it says nothing */
static bool chose(const Json *choices, const char *hex, const char *name, bool unless) {
	Json *v = jsonGet(jsonGet(choices, hex), name);
	return v ? on(v) : unless;
}

/**
 * read tracked: every shared document whose peers' live state is to be shown (watched), those this
 * device's goes to (the three choices on), and the state itself, read only when it goes somewhere
 */
static ErmErr liveCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *shared = drvPath("/", "dev", "sync", "shared", NULL);
	Json *choices = drvRead(g->api, shared), *etc = drvRead(g->api, drvPath("/", "etc", "sync", NULL));
	bool global = on(jsonGet(etc, "live"));
	Json *showing = jsonGet(etc, "presence");
	bool show = !showing || on(showing);
	Json *watch = jsonArray(), *docs = jsonArray();
	// every name in the list, a mounted document not yet come too (its name is its hex): drvNames would leave it out
	size_t n;
	const char *const *at = hostPath(drvHost(), &n, "/", "dev", "sync", "shared", NULL);
	ap_namelist list = { 0 };
	if (ap_names(g->api, at, n, &list)) list.n = 0;
	for (size_t i = 0; i < list.n; i++) {
		const char *hex = hexOf(list.names[i]);
		if (!hex) continue;
		if (show && chose(choices, hex, "presence", true)) jsonPush(watch, jsonString(hex));
		if (global && chose(choices, hex, "live", false)) jsonPush(docs, jsonString(hex));
	}
	Json *state = docs->array.count ? jsonObject() : jsonNull();
	if (docs->array.count) {
		if (switched(g, "pointer")) {
			Json *at = drvRead(g->api, drvPath("/", "dev", "pointer", "at", NULL));
			// a map of the kit's is the turn's: a hold of this object's own taken
			jsonAdd(state, "pointer", jsonRef(drvMap("x", given(jsonGet(at, "x")), "y", given(jsonGet(at, "y")), NULL)));
		}
		if (switched(g, "display")) {
			jsonAdd(state, "focus", given(drvRead(g->api, drvPath("/", "dev", "display", "focus", NULL))));
			Json *drag = jsonGet(drvRead(g->api, drvPath("/", "dev", "wm", "hand", NULL)), "drag");
			const char *id = jsonText(jsonGet(drag, "id"));
			if (id) {
				Json *w = drvRead(g->api, drvPath("/", "dev", "display", "windows", id, NULL));
				jsonAdd(state, "drag", jsonRef(drvMap("id", jsonString(id), "how", given(jsonGet(drag, "how")), "x", given(jsonGet(w, "x")), "y", given(jsonGet(w, "y")),
				                                      "w", given(jsonGet(w, "w")), "h", given(jsonGet(w, "h")), NULL)));
			}
		}
		if (switched(g, "sync")) {
			Json *user = jsonGet(drvRead(g->api, drvPath("/", "hw", NULL)), "user");
			jsonAdd(state, "presence", jsonRef(drvMap("device", jsonString(cardKey(hist.card)), "name", given(user), NULL)));
		}
	}
	*out = drvMap("watch", watch, "docs", docs, "state", state, NULL);
	return ermOk();
}

/** the documents watched as the value says, the state given to the card for each it goes to, withdrawn from those it went to before */
static ErmErr liveEffect(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	Json *watch = jsonGet(g->value, "watch"), *docs = jsonGet(g->value, "docs"), *state = jsonGet(g->value, "state");
	char doc[96];
	ErmMap now = { 0 };
	for (int i = 0; jsonIsArray(watch) && i < watch->array.count; i++) {
		const char *hex = jsonText(watch->array.items[i]);
		ermMapPut(&now, hex, (void *)1);
		if (ermMapHas(&live.watching, hex)) continue;
		snprintf(doc, sizeof doc, "ermine://%s", hex);
		cardWatch(hist.card, doc, true);
	}
	for (int i = 0; i < live.watching.count; i++) {
		const char *hex = live.watching.entries[i].key;
		if (ermMapHas(&now, hex)) continue;
		snprintf(doc, sizeof doc, "ermine://%s", hex);
		cardWatch(hist.card, doc, false);
		ermMapPut(&live.stood, hex, (void *)1);
	}
	mapFree(&live.watching);
	live.watching = now;
	// this device's: the state as given, stamped seen (wall ms), one value for every document; the same
	// state as last given (a compute run by something else moving) is not given again
	op_value *v = NULL;
	char *printed = NULL;
	if (jsonIsObject(state)) {
		printed = jsonPrint(state);
		Json *stamped = jsonShallow(state);
		jsonAdd(stamped, "seen", jsonInteger((int64_t)erm_host_now()));
		v = valOf(stamped);
		jsonFree(stamped);
	}
	ErmMap going = { 0 };
	for (int i = 0; v && jsonIsArray(docs) && i < docs->array.count; i++) {
		const char *hex = jsonText(docs->array.items[i]);
		ermMapPut(&going, hex, (void *)1);
		if (live.last && printed && !strcmp(live.last, printed) && ermMapHas(&live.going, hex)) continue;
		snprintf(doc, sizeof doc, "ermine://%s", hex);
		cardLive(hist.card, doc, v);
	}
	free(live.last);
	live.last = printed;
	for (int i = 0; i < live.going.count; i++) {
		const char *hex = live.going.entries[i].key;
		if (ermMapHas(&going, hex)) continue;
		snprintf(doc, sizeof doc, "ermine://%s", hex);
		cardLive(hist.card, doc, NULL);
	}
	mapFree(&live.going);
	live.going = going;
	op_free(v);
	// a document no longer watched: its presence nodes go (irq 68's turn)
	if (live.stood.count && !live.posted) {
		live.posted = true;
		ermosPost("{\"irq\": 68}");
	}
	return ermOk();
}

/** what stands at a watched document changed (card.c): irq 68 once */
static void lived(void *context, const char *doc) {
	(void)context;
	const char *hex = hexOf(doc);
	if (!hex) return;
	ermMapPut(&live.stood, hex, (void *)1);
	if (live.posted) return;
	live.posted = true;
	ermosPost("{\"irq\": 68}");
}

/** /dev/sync/presence/<hex>: a node a standing peer, written as its state, those standing no more unplaced; none standing: the folder unplaced */
static void presence(const ErmGiven *g, const char *hex) {
	Json *at = drvPath("/", "dev", "sync", "presence", NULL), *folder = drvUnder(at, hex, NULL);
	char doc[96];
	snprintf(doc, sizeof doc, "ermine://%s", hex);
	card_stand *stands = NULL;
	size_t n = ermMapHas(&live.watching, hex) ? cardStanding(hist.card, doc, &stands) : 0;
	bool there = drvHas(g->api, folder);
	if (n && !there) {
		char *id = formatString("sync/presence/%s", hex);
		drvMake(g->api, at, hex, id, jsonNull());
		free(id);
		there = drvHas(g->api, folder);
	}
	ErmMap standing = { 0 };
	for (size_t i = 0; i < n; i++) {
		ermMapPut(&standing, stands[i].key, (void *)1);
		Json *value = jsonOfVal(stands[i].value), *node = drvUnder(folder, stands[i].key, NULL);
		if (!there) jsonFree(value);
		else if (drvHas(g->api, node)) drvSnap(g->api, node, value);
		else {
			char *id = formatString("sync/presence/%s/%s", hex, stands[i].key);
			drvMake(g->api, folder, stands[i].key, id, value);
			free(id);
		}
		op_free(stands[i].value);
	}
	free(stands);
	if (there) {
		Json *names = drvNames(g->api, folder);
		for (int i = 0; jsonIsArray(names) && i < names->array.count; i++) {
			const char *key = jsonText(names->array.items[i]);
			if (ermMapHas(&standing, key)) continue;
			char *id = formatString("sync/presence/%s/%s", hex, key);
			drvOp(g->api, "unplace", drvMap("address", folder, "name", jsonString(key), "id", jsonString(id), NULL));
			free(id);
		}
		if (!n) {
			char *id = formatString("sync/presence/%s", hex);
			drvOp(g->api, "unplace", drvMap("address", at, "name", jsonString(hex), "id", jsonString(id), NULL));
			free(id);
		}
	}
	mapFree(&standing);
}

/** irq 65: each served history a commit was taken in to grown, written only when it did; irq 68: /dev/sync/presence written for what changed */
static ErmErr historyIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	hist.posted = false;
	for (int i = 0; i < hist.served.count; i++) {
		Served *s = hist.served.items[i];
		if (ermMapHas(&hist.marks, s->hex) && grow(s)) serve(g, s);
	}
	mapFree(&hist.marks);
	live.posted = false;
	for (int i = 0; i < live.stood.count; i++) presence(g, live.stood.entries[i].key);
	mapFree(&live.stood);
	return ermOk();
}

ErmErr driverSync(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	hist.card = hostCard(drvHost());
	cardTold(hist.card, told, NULL);
	Json *dev = drvPath("/", "dev", "sync", NULL);
	drvMake(g->api, dev, "want", "sync/want", jsonNull());
	drvMake(g->api, dev, "history", "sync/history", jsonNull());
	// this device's key, as a commit's signer says it: a reader tells this device's changes from another's
	drvMake(g->api, dev, "device", "sync/device", drvMap("key", jsonString(cardKey(hist.card)), NULL));
	// live state: this device's presence switch, and the peers' standing live state
	drvMake(g->api, dev, "live", "sync/live", drvMap("on", jsonBoolean(true), NULL));
	drvMake(g->api, dev, "presence", "sync/presence", jsonNull());
	cardLived(hist.card, lived, NULL);
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ historyIrq, NULL });
	drvClaim(g, here, IRQ);
	drvClaim(g, here, LIVE_IRQ);
	drvChild(g, here, "want", (ErmFn){ wantCompute, NULL }, (ErmFn){ wantEffect, NULL });
	drvChild(g, here, "server", (ErmFn){ serverCompute, NULL }, (ErmFn){ serverEffect, NULL });
	drvChild(g, here, "live", (ErmFn){ liveCompute, NULL }, (ErmFn){ liveEffect, NULL });
	return ermOk();
}
