// drv_sync.c: /drivers/sync, a document's
// history, from its blops on the card: each change in the order it was taken in, served while
// someone asks for it, as ephemeral nodes. Sync itself, the wiring, the transport and the card, is
// peer/peer.c's, which this reads (peer/peer.h); the network is net.c's, /dev/sync/link its; the
// link drv_link.c's.
//
//   /dev/sync/want/<name>      a reader's, ephemeral: the documents it wants the histories of, [id]
//   /dev/sync/history/<hex>    served while any want names it: {doc, count, changes}
//   /dev/sync/device           {key}: this device's, as a change's signer says it
//
// A change, one blop (BLOP.tex): {commit, parents, signer, lamport, time?, kind, name?, patches,
// base?, combine?, actor, reader?, site?, cause?, wallclock?, message?, value?}. A blop changes one
// object of the node: kind "write" its value, "info" or "children" that name's (name). commit is the
// blop's name, parents, base and signer as the blop holds them, each 64 hex digits; patches, actor,
// reader, site, cause, wallclock and message as it holds them. time: when this card first took it in,
// µs since 1970 (peer.c, the card's seen): a blop holds no time; left out for one the card stored
// before it kept times. value: the node's value after it, the side (APPLY.tex) of the last write up
// to it; left out when there is none, or when it is more than 4 KB as JSON.
//
// In order: each after its parents, then by time (one with none first: it was on the card before
// any with one), then Lamport number (one object's history's: two objects' numbers do not compare),
// then name.
//
// Fresh: peer.c tells of each document a change is taken in to, made here or come; one served posts
// irq 65 once, whose turn takes its new blops into its history. Nothing is read or made while no want
// names a document.
//
// Grown, not made again: the changes made are kept, and only the blops not yet in them are ordered
// and added, after the value the last left. A new one that sorts before one already made (a time
// earlier than its) makes the history again from the start.

#include "drivers.h"
#include "drv.h"
#include "peer/peer.h"

#include "../../../extensions/subduction/c/apply.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define IRQ 65
#define SMALL 4096 // bytes of JSON: a value kept with each change, at most

/** a served document's history, as far as it is made */
typedef struct Served {
	char *hex;
	op_value **changes; // made, in order, each held
	int count, room;
	ErmMap done;        // a name (hex) -> (void *)1, each blop in changes
	op_value *value;    // held: the node's value after the last; NULL: none
	bool small;         // value is SMALL or less as JSON
	int64_t time, lamport;
	char last[65];      // the greatest made, by order: its time, Lamport number and name; "": none
} Served;

static struct {
	Peer *peer;
	ERM_LIST(Served *) served; // the documents served
	ErmMap marks;              // a served document's hex -> (void *)1 when a change was taken in to it since irq 65
	bool posted;               // irq 65 posted and not yet taken
} hist;

/** a map's keys freed */
static void mapFree(ErmMap *m) {
	for (int i = 0; i < m->count; i++) free((void *)m->entries[i].key);
	free(m->entries);
	free(m->index);
	*m = (ErmMap){ 0 };
}

static void hex32(const uint8_t *bytes, char out[65]) {
	for (int i = 0; i < 32; i++) snprintf(out + 2 * i, 3, "%02x", bytes[i]);
}

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

/** a document a change was taken in to (peer.c): when it is served, irq 65 once */
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

/** a blop not yet in the history, as it is ordered */
typedef struct {
	Json *blop; // held
	uint8_t name[32];
	char hex[65];
	int64_t time, lamport;
} Fresh;

typedef struct {
	uint8_t name[32];
} Name;

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

/** bytes of 32 (a name, a key) as hex, else as they are */
static op_value *hexed(const Json *v) {
	if (!v || v->type != JSON_BYTES || v->bytes.length != 32) return valOf(v);
	char h[65];
	hex32(v->bytes.data, h);
	return op_str(h);
}

/** the blops of the document not yet made: from each object's heads, back through their parents to those made */
static int collect(const Served *s, histories *c, const Json *objects, Fresh **out) {
	ERM_LIST(Name) todo = { 0 };
	ERM_LIST(Fresh) fresh = { 0 };
	ErmMap visited = { 0 };
	for (int i = 0; i < objects->array.count; i++) {
		history_head *heads = NULL;
		size_t n = history_heads(c, objects->array.items[i], &heads);
		for (size_t k = 0; k < n; k++) {
			Name nm;
			memcpy(nm.name, heads[k].name, 32);
			ERM_PUSH(todo, nm);
		}
		free(heads);
	}
	while (todo.count) {
		Name nm = todo.items[--todo.count];
		char h[65];
		hex32(nm.name, h);
		if (ermMapHas(&s->done, h) || ermMapHas(&visited, h)) continue;
		ermMapPut(&visited, h, (void *)1);
		const Json *blop = history_get(c, nm.name);
		if (!blop) continue;
		Fresh f = { .blop = jsonRef((Json *)blop), .time = peerSeen(hist.peer, nm.name) };
		memcpy(f.name, nm.name, 32);
		memcpy(f.hex, h, sizeof h);
		jsonIsWhole(jsonGet(blop, "lamport"), &f.lamport);
		ERM_PUSH(fresh, f);
		const Json *ps = jsonGet(blop, "parents");
		for (int q = 0; jsonIsArray(ps) && q < ps->array.count; q++) {
			const Json *p = ps->array.items[q];
			if (p->type != JSON_BYTES || p->bytes.length != 32) continue;
			memcpy(nm.name, p->bytes.data, 32);
			ERM_PUSH(todo, nm);
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
	op_free(s->value);
	s->value = NULL;
	s->small = false;
	*s->last = 0;
}

static const char *const CARRIED[] = { "actor", "reader", "site", "cause", "wallclock", "message" };

/** a blop into the history, after the last: what it did, and the node's value after it */
static void add(Served *s, histories *c, const Fresh *f) {
	const Json *b = f->blop, *object = jsonGet(b, "object");
	bool write = jsonIsString(object);
	op_value *e = op_map(), *parents = op_list();
	op_set(e, "commit", op_str(f->hex));
	const Json *ps = jsonGet(b, "parents");
	for (int i = 0; jsonIsArray(ps) && i < ps->array.count; i++) op_push(parents, hexed(ps->array.items[i]));
	op_set(e, "parents", parents);
	op_set(e, "signer", hexed(jsonGet(b, "signer")));
	op_set(e, "lamport", op_num((double)f->lamport));
	if (f->time) op_set(e, "time", op_num((double)f->time));
	const Json *kind = write ? NULL : object->array.items[0];
	op_set(e, "kind", op_str(write ? "write" : jsonText(kind) ? jsonText(kind) : "?"));
	if (!write) op_set(e, "name", valOf(object->array.items[1]));
	op_set(e, "patches", valOf(jsonGet(b, "patches")));
	if (jsonGet(b, "base")) op_set(e, "base", hexed(jsonGet(b, "base")));
	if (jsonGet(b, "combine")) op_set(e, "combine", op_bool(1));
	for (size_t i = 0; i < sizeof CARRIED / sizeof *CARRIED; i++)
		if (jsonGet(b, CARRIED[i])) op_set(e, CARRIED[i], valOf(jsonGet(b, CARRIED[i])));
	// the value after it: a write's side; anything else leaves the value as it was
	if (write) {
		op_free(s->value);
		s->value = op_ref((op_value *)apply_side(c, f->name));
		Json *j = jsonOfVal(s->value);
		char *text = j ? jsonPrint(j) : NULL;
		s->small = text && strlen(text) <= SMALL;
		free(text);
		jsonFree(j);
	}
	if (s->value && s->small) op_set(e, "value", op_ref(s->value));
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
 * the blops not yet in the history, in order (each after its parents, then the least by time,
 * Lamport number and name), taken in; true when any was
 */
static bool grow(Served *s) {
	char *doc = formatString("ermine://%s", s->hex);
	histories *c = peerHistories(hist.peer, doc);
	Json *objects = peerObjects(hist.peer, doc);
	free(doc);
	Fresh *fresh = NULL;
	int m = c ? collect(s, c, objects, &fresh) : 0;
	bool behind = false;
	for (int k = 0; k < m && !behind; k++) behind = *s->last && order(fresh[k].time, fresh[k].lamport, fresh[k].hex, s->time, s->lamport, s->last) < 0;
	if (behind) {
		for (int k = 0; k < m; k++) jsonFree(fresh[k].blop);
		free(fresh);
		restart(s);
		m = collect(s, c, objects, &fresh);
	}
	jsonFree(objects);
	qsort(fresh, (size_t)m, sizeof *fresh, byOrder);
	// each one's parents not yet made, and the ones each is a parent of
	ErmMap at = { 0 }; // a name (hex) -> its place in the order + 1
	for (int k = 0; k < m; k++) ermMapPut(&at, fresh[k].hex, (void *)(intptr_t)(k + 1));
	int *waiting = calloc((size_t)m + 1, sizeof *waiting);
	ERM_LIST(int) *kids = calloc((size_t)m + 1, sizeof *kids);
	Heap ready = { 0 };
	for (int k = 0; k < m; k++) {
		const Json *ps = jsonGet(fresh[k].blop, "parents");
		for (int q = 0; jsonIsArray(ps) && q < ps->array.count; q++) {
			const Json *p = ps->array.items[q];
			if (p->type != JSON_BYTES || p->bytes.length != 32) continue;
			char h[65];
			hex32(p->bytes.data, h);
			intptr_t j = (intptr_t)ermMapGet(&at, h);
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
		add(s, c, &fresh[k]);
		for (int i = 0; i < kids[k].count; i++)
			if (!--waiting[kids[k].items[i]]) heapPush(&ready, kids[k].items[i]);
	}
	for (int k = 0; k < m; k++) free(kids[k].items), jsonFree(fresh[k].blop);
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

/** irq 65: each served history a change was taken in to grown, written only when it did */
static ErmErr historyIrq(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	hist.posted = false;
	for (int i = 0; i < hist.served.count; i++) {
		Served *s = hist.served.items[i];
		if (ermMapHas(&hist.marks, s->hex) && grow(s)) serve(g, s);
	}
	mapFree(&hist.marks);
	return ermOk();
}

ErmErr driverSync(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	*out = jsonNull();
	hist.peer = hostPeer(drvHost());
	peerTold(hist.peer, told, NULL);
	Json *dev = drvPath("/", "dev", "sync", NULL);
	drvMake(g->api, dev, "want", "sync/want", jsonNull());
	drvMake(g->api, dev, "history", "sync/history", jsonNull());
	// this device's key, as a change's signer says it: a reader tells this device's changes from another's
	drvMake(g->api, dev, "device", "sync/device", drvMap("key", jsonString(peerKey(hist.peer)), NULL));
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ historyIrq, NULL });
	drvClaim(g, here, IRQ);
	drvChild(g, here, "want", (ErmFn){ wantCompute, NULL }, (ErmFn){ wantEffect, NULL });
	return ermOk();
}
