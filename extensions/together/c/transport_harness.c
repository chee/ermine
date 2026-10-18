// Devices (transport.h) on the line protocol (conformance/c/harness.h): commits over Subduction, with
// no table, joined by in-memory pipes (wires_harness.h), as extensions/together/typescript/transport_harness.ts
// has them; its header lists the requests and answers. State lasts for the process.
//
// A device here checks nothing (every commit applies) and gives every fragment it builds a snapshot:
// the tables at its head (replay.h), packed. A commit a request makes is signed by its seed, default
// the device's, sealed for each document it is used in. doc: an ermine:// id, default ermine://2a...2a00...00 (16 bytes each). A commit in an
// answer: its label (for its name and its seal's stored id alike), else hex. Deterministic: the
// devices run on the harness's clock (wires_harness.h), which quiet moves 2 ms a round
#include "commits_harness.h"
#include "ids.h"
#include "packer.h"
#include "snapshot.h"
#include "transport.h"
#include "transport_conformance_hook.h"
#include "wires_harness.h"

#include "../../../conformance/c/protocol_harness.h"
#include "../../../ermine/encoding/c/cbor.h"
#include "../../../ermine/encoding/c/commit_form_harness.h"

#include <stdlib.h>
#include <string.h>

static const char DOC[] = "ermine://2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a00000000000000000000000000000000";

// ---- devices

typedef struct {
	char *doc;
	tp_layer layer;
	uint8_t name[CM_NAME];
	bool heard;
} arrival_t;

typedef struct {
	char *name;
	uint8_t seed[32];
	tp_device *t;
	const ErmStore *store;
	arrival_t *arrived;
	size_t arrived_count, arrived_room;
} device_t;

static device_t **devices;
static size_t device_count;

// every store made, and those labelled (a device made with the label takes in what it holds). Kept
// while the process lives: a memory store is never freed
static ErmStore **stores;
static size_t store_count;
static struct {
	char *label;
	const ErmStore *store;
} *storages;
static size_t storage_count;

static device_t *of(const op_value *r, const char *key, FILE *out) {
	const char *name = hh_str(r, key);
	for (size_t i = 0; name != NULL && i < device_count; i++)
		if (strcmp(devices[i]->name, name) == 0) return devices[i];
	hh_error(out, "no device %s", name ? name : "(none)");
	return NULL;
}

// ---- commits: labels for names and stored ids alike

static cs_commits *commits;
// a commit's seal for a document (a seal is good in its own only)
typedef struct {
	char *label;
	uint8_t doc[32];
	uint8_t *bytes;
	size_t length;
} seal_t;
static seal_t *seals;
static size_t seal_count, seal_room;
// the document of the request being answered: what a label is sealed for
static uint8_t here[32];
// a name, or a stored id, to its label (the first given)
static im_map labels = {.width = CM_NAME}, stored_labels;

// id: a name (CM_NAME bytes) or a stored id (32)
static void put_label(FILE *out, const uint8_t *id, size_t length) {
	const char *label = im_get(length == CM_NAME ? &labels : &stored_labels, id);
	if (label != NULL) op_json_string(out, label);
	else cf_put_hex(out, id, length);
}

static const seal_t *sealed(const cs_made *m);

// a label's seal for the request's document, made then if it is not yet
static const seal_t *seal_of(const char *label) {
	for (size_t i = 0; label != NULL && i < seal_count; i++)
		if (strcmp(seals[i].label, label) == 0 && memcmp(seals[i].doc, here, 32) == 0) return &seals[i];
	const cs_made *m = label != NULL ? cs_get(commits, label) : NULL;
	return m != NULL ? sealed(m) : NULL;
}

// the made commit's seal for the request's document, made once
static const seal_t *sealed(const cs_made *m) {
	for (size_t i = 0; i < seal_count; i++)
		if (strcmp(seals[i].label, m->label) == 0 && memcmp(seals[i].doc, here, 32) == 0) return &seals[i];
	if (seal_count == seal_room) {
		seal_room = seal_room ? seal_room * 2 : 16;
		seals = realloc(seals, seal_room * sizeof *seals);
		if (seals == NULL) abort();
	}
	seal_t *n = &seals[seal_count++];
	n->label = copyString(m->label);
	memcpy(n->doc, here, 32);
	cs_sealed(m, here, &n->bytes, &n->length);
	uint8_t stored[32];
	sl_stored(n->bytes, n->length, stored);
	if (!im_has(&labels, m->name)) im_set(&labels, m->name, n->label);
	if (!im_has(&stored_labels, stored)) im_set(&stored_labels, stored, n->label);
	return n;
}

// made under its label, signed by its seed (default: seed, when given); made already, that one
static const cs_made *make(const op_value *r, const uint8_t *seed, FILE *out) {
	const char *label = hh_str(r, "name");
	op_value *given = NULL;
	if (label != NULL && cs_get(commits, label) == NULL && seed != NULL && op_get(r, "seed") == NULL) {
		given = op_map();
		for (size_t i = 0; i < r->count; i++) op_set(given, r->keys[i], op_ref(r->items[i]));
		char hex[65];
		for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", seed[i]);
		op_set(given, "seed", op_str(hex));
	}
	cs_failure why;
	const cs_made *m = cs_make(commits, given ? given : r, &why);
	op_free(given);
	if (m == NULL) {
		if (why.text != NULL) hh_error(out, "%s", why.text);
		else cf_put_refusal(out, why.code, why.field);
		free(why.field);
		return NULL;
	}
	sealed(m);
	return m;
}

// a label's seal's stored id, or 64 hex digits
static bool stored_id(const op_value *x, uint8_t id[32], FILE *out) {
	const char *s = x != NULL && x->type == OP_STR ? x->str : NULL;
	const seal_t *seal = seal_of(s);
	if (seal != NULL) {
		sl_stored(seal->bytes, seal->length, id);
		return true;
	}
	uint8_t *b;
	size_t n;
	if (s != NULL && strlen(s) == 64 && cf_unhex(s, &b, &n)) {
		memcpy(id, b, 32);
		return true;
	}
	hh_error(out, "no commit %s", s ? s : "(none)");
	return false;
}

// ---- running

static void run(device_t *d) {
	tp_run(d->t);
	wr_drain(d->t);
}

static void run_all(void) {
	for (size_t i = 0; i < device_count; i++) run(devices[i]);
}

// every device idle, and no message crossing for five rounds of 2 ms
static bool quiet(void) {
	size_t still = 0, last = (size_t)-1;
	for (int round = 0; round < 3000; round++) {
		run_all();
		bool idle = true;
		for (size_t i = 0; i < device_count; i++) idle = idle && tp_idle(devices[i]->t);
		wr_ms += 2;
		if (idle && wr_moved == last) {
			if (++still >= 5) return true;
		} else still = 0, last = wr_moved;
	}
	return false;
}

// everything runs until the device has what it waits on: what the store held taken in, its fetches
// and puts answered, nothing queued
static void settle(device_t *d) {
	for (int round = 0; round < 3000; round++) {
		run_all();
		if (tp_ready(d->t) && tp_idle(d->t) && tp_fetching(d->t) == 0 && tp_conformance_hook_putting(d->t) == 0) return;
		wr_ms += 1;
	}
}

// ---- the integration's, here

static bool snapshot_of(void *context, const char *doc, const hy_kept *head, uint8_t **out, size_t *length) {
	device_t *d = context;
	rp_tables tables;
	rp_code code = rp_replay(tp_history(d->t, doc, TP_STORED), head->name, NULL, NULL, NULL, &tables);
	if (code == RP_NOT_TAKEN) rp_init(&tables);
	else if (code != RP_OK) return false;
	pk_code packed = sn_snapshot(&tables, out, length);
	rp_free(&tables);
	return packed == PK_OK;
}

static void arrived(void *context, const tp_arrival *a) {
	device_t *d = context;
	if (d->arrived_count == d->arrived_room) {
		d->arrived_room = d->arrived_room ? d->arrived_room * 2 : 16;
		d->arrived = realloc(d->arrived, d->arrived_room * sizeof *d->arrived);
		if (d->arrived == NULL) abort();
	}
	arrival_t *x = &d->arrived[d->arrived_count++];
	x->doc = copyString(a->doc);
	x->layer = a->layer;
	memcpy(x->name, a->kept->name, CM_NAME);
	x->heard = a->heard;
}

static void device_free(device_t *d) {
	tp_free(d->t);
	for (size_t i = 0; i < d->arrived_count; i++) free(d->arrived[i].doc);
	free(d->arrived);
	free(d->name);
	free(d);
}

// ---- requests

static void device(const op_value *r, FILE *out) {
	const char *name = hh_str(r, "name"), *seed = hh_str(r, "seed"), *label = hh_str(r, "storage");
	for (size_t i = 0; name != NULL && i < device_count; i++) {
		if (strcmp(devices[i]->name, name) == 0) {
			hh_error(out, "a device %s already", name);
			return;
		}
	}
	uint8_t *b;
	size_t n;
	if (name == NULL || seed == NULL || !cf_unhex(seed, &b, &n) || n != 32) {
		hh_error(out, "a device needs a name and a seed");
		return;
	}
	device_t *d = calloc(1, sizeof *d);
	if (d == NULL) abort();
	d->name = copyString(name);
	memcpy(d->seed, b, 32);
	for (size_t i = 0; label != NULL && i < storage_count; i++)
		if (strcmp(storages[i].label, label) == 0) d->store = storages[i].store;
	if (d->store == NULL) {
		ErmStore *s = malloc(sizeof *s);
		if (s == NULL) abort();
		*s = ermStoreMemory();
		stores = realloc(stores, (store_count + 1) * sizeof *stores);
		if (stores == NULL) abort();
		stores[store_count++] = s;
		d->store = s;
		if (label != NULL) {
			storages = realloc(storages, (storage_count + 1) * sizeof *storages);
			if (storages == NULL) abort();
			storages[storage_count].label = copyString(label);
			storages[storage_count++].store = s;
		}
	}
	tp_options o = {.store = d->store, .now = wr_clock, .snapshot = snapshot_of, .context = d};
	memcpy(o.seed, d->seed, 32);
	const op_value *lazy = op_get(r, "lazy");
	o.lazy = lazy != NULL && lazy->type == OP_BOOL && lazy->bool_;
	const op_value *limits = op_get(r, "limits");
	if (limits != NULL && limits->type == OP_MAP) {
		const char *names[] = {"pending", "refused", "waiting", "joins", "parts"};
		size_t *at[] = {&o.limits.pending, &o.limits.refused, &o.limits.waiting, &o.limits.joins, &o.limits.parts};
		for (size_t i = 0; i < 5; i++) {
			const op_value *n = op_get(limits, names[i]);
			if (n != NULL && n->type == OP_NUM && n->num >= 1) *at[i] = (size_t)n->num;
		}
	}
	d->t = tp_create(&o);
	if (d->t == NULL) hh_fail("Subduction would not make a node");
	tp_arrived(d->t, arrived, d);
	// follow: documents followed before its first run
	const op_value *follow = op_get(r, "follow");
	for (size_t i = 0; follow != NULL && follow->type == OP_LIST && i < follow->count; i++)
		if (follow->items[i]->type == OP_STR) tp_follow(d->t, follow->items[i]->str);
	devices = realloc(devices, (device_count + 1) * sizeof *devices);
	if (devices == NULL) abort();
	devices[device_count++] = d;
	settle(d);
	fputs("{\"key\":", out);
	cf_put_hex(out, tp_key(d->t), SL_KEY);
	fputc('}', out);
}

static void close_device(const op_value *r, FILE *out) {
	device_t *d = of(r, "device", out);
	if (d == NULL) return;
	wr_close(d->t);
	for (int round = 0; round < 3000 && !tp_idle(d->t); round++) {
		tp_run(d->t);
		wr_drain(d->t);
	}
	for (size_t i = 0; i < device_count; i++) {
		if (devices[i] != d) continue;
		memmove(&devices[i], &devices[i + 1], (device_count - i - 1) * sizeof *devices);
		device_count--;
		break;
	}
	device_free(d);
	fputs("{}", out);
}

static void join_devices(const op_value *r, FILE *out) {
	device_t *a = of(r, "a", out), *b = a ? of(r, "b", out) : NULL;
	if (b == NULL) return;
	wr_connect(a->t, b->t);
	// the handshake done, and what each follows fetched over it
	for (int round = 0; round < 3000; round++) {
		run_all();
		if (wr_up(a->t, b->t) && tp_fetching(a->t) == 0 && tp_fetching(b->t) == 0) break;
		wr_ms += 1;
	}
	fputs("{}", out);
}

static void disconnect(const op_value *r, FILE *out) {
	device_t *a = of(r, "a", out), *b = a ? of(r, "b", out) : NULL;
	if (b == NULL) return;
	tp_disconnect(a->t, tp_key(b->t));
	tp_disconnect(b->t, tp_key(a->t));
	wr_cut(a->t, b->t);
	run(a);
	run(b);
	fputs("{}", out);
}

static const char *doc_of(const op_value *r) {
	const char *doc = hh_str(r, "doc");
	return doc ? doc : DOC;
}

static tp_layer layer_of(const op_value *r) {
	const char *layer = hh_str(r, "layer");
	return layer != NULL && strcmp(layer, "ephemeral") == 0 ? TP_EPHEMERAL : TP_STORED;
}

static void follow(const op_value *r, FILE *out) {
	device_t *d = of(r, "device", out);
	if (d == NULL) return;
	if (!tp_follow(d->t, doc_of(r))) {
		hh_error(out, "not a document id: %s", doc_of(r));
		return;
	}
	settle(d);
	fputs("{}", out);
}

static void take(const op_value *r, FILE *out) {
	device_t *d = of(r, "device", out);
	if (d == NULL) return;
	const cs_made *m = make(r, d->seed, out);
	if (m == NULL) return;
	if (tp_history(d->t, doc_of(r), TP_STORED) == NULL) {
		hh_error(out, "not a document id: %s", doc_of(r));
		return;
	}
	hy_added a = tp_take(d->t, doc_of(r), m->bytes, m->length, layer_of(r), NULL);
	fputs("{\"added\":", out);
	switch (a.kind) {
	case HY_TAKEN: fputs("\"taken\"", out); break;
	case HY_PASSED: fputs("\"passed\"", out); break;
	case HY_REFUSED: fprintf(out, "{\"refused\":\"%s\"}", hy_refusal_name(a.refusal)); break;
	case HY_WAITING:
		fputs("{\"waiting\":[", out);
		for (size_t i = 0; i < a.waiting_length; i++) {
			if (i) fputc(',', out);
			put_label(out, a.waiting[i], CM_NAME);
		}
		fputs("]}", out);
		break;
	}
	fputc('}', out);
	hy_added_free(&a);
}

// stored ids from a list of labels (or hex); NULL with the answer written when one is not
static uint8_t (*ids_of(const op_value *list, size_t *count, FILE *out))[32] {
	*count = list != NULL && list->type == OP_LIST ? list->count : 0;
	uint8_t(*ids)[32] = hh_take(*count * 32 + 1);
	for (size_t i = 0; i < *count; i++)
		if (!stored_id(list->items[i], ids[i], out)) return NULL;
	return ids;
}

static void put(const op_value *r, FILE *out) {
	device_t *d = of(r, "device", out);
	if (d == NULL) return;
	const char *label = hh_str(r, "commit"), *blob_hex = hh_str(r, "blob");
	const cs_made *m = label ? cs_get(commits, label) : NULL;
	uint8_t *blob;
	size_t length;
	if (op_get(r, "blob") != NULL) {
		if (blob_hex == NULL || !cf_unhex(blob_hex, &blob, &length)) {
			hh_error(out, "not hex");
			return;
		}
	} else {
		const seal_t *s = seal_of(label);
		if (s == NULL) {
			hh_error(out, "no commit %s", label ? label : "(none)");
			return;
		}
		blob = s->bytes;
		length = s->length;
	}
	uint8_t head[32];
	if (op_get(r, "head") != NULL) {
		if (!stored_id(op_get(r, "head"), head, out)) return;
	} else sl_stored(blob, length, head);
	size_t count;
	uint8_t(*parents)[32];
	if (op_get(r, "parents") != NULL) {
		if ((parents = ids_of(op_get(r, "parents"), &count, out)) == NULL) return;
	} else {
		// the commit's parents, each its label's seal's stored id
		cm_commit c = {0};
		count = 0;
		if (m != NULL && cm_decode(m->bytes, m->length, &c, NULL) == CM_OK) count = c.parents_length;
		parents = hh_take(count * 32 + 1);
		for (size_t i = 0; i < count; i++) {
			const char *l = im_get(&labels, c.parents[i]);
			const seal_t *s = seal_of(l);
			if (s != NULL) sl_stored(s->bytes, s->length, parents[i]);
			// a name not made here: its digest, raw, as Subduction has it
			else memcpy(parents[i], c.parents[i] + 2, 32);
		}
		cm_free(&c);
	}
	if (!tp_conformance_hook_put(d->t, doc_of(r), head, (const uint8_t(*)[32])parents, count, blob, length)) {
		hh_error(out, "not a document id: %s", doc_of(r));
		return;
	}
	settle(d);
	fputs("{}", out);
}

// a request's tables, {table: {value, change}}, packed: written when they cannot be
static bool packed(const op_value *given, uint8_t **bytes, size_t *length, FILE *out) {
	rp_tables t;
	rp_init(&t);
	for (size_t i = 0; given != NULL && given->type == OP_MAP && i < given->count; i++) {
		const op_value *e = given->items[i];
		ch_header *h = hh_take(sizeof *h);
		*h = e->type == OP_MAP && op_get(e, "change") ? hh_header(op_get(e, "change")) : (ch_header){0};
		rp_put(&t, given->keys[i], e->type == OP_MAP ? op_get(e, "value") : NULL, h);
	}
	pk_code code = sn_snapshot(&t, bytes, length);
	rp_free(&t);
	if (code == PK_OK) return true;
	fprintf(out, "{\"error\":\"%s\"}", pk_code_name(code));
	return false;
}

static void fragment_op(const op_value *r, FILE *out) {
	device_t *d = of(r, "device", out);
	if (d == NULL) return;
	const op_value *members = op_get(r, "members");
	size_t count = members != NULL && members->type == OP_LIST ? members->count : 0;
	const seal_t **ms = hh_take((count + 1) * sizeof *ms);
	const op_value *tamper = op_get(r, "tamper");
	for (size_t i = 0; i < count; i++) {
		const op_value *x = members->items[i];
		if ((ms[i] = seal_of(x->type == OP_STR ? x->str : NULL)) == NULL) {
			hh_error(out, "no commit %s", x->type == OP_STR ? x->str : "(none)");
			return;
		}
		// tampered: its signature's last byte flipped
		for (size_t k = 0; tamper != NULL && tamper->type == OP_LIST && k < tamper->count; k++) {
			if (tamper->items[k]->type != OP_STR || strcmp(tamper->items[k]->str, x->str) != 0) continue;
			Json *o = cborDecode(ms[i]->bytes, ms[i]->length, NULL, NULL);
			Json *sig = (Json *)jsonGet(o, "signature");
			sig->bytes.data[sig->bytes.length - 1] ^= 1;
			seal_t *t = hh_take(sizeof *t);
			t->label = ms[i]->label;
			t->length = 0;
			cborEncode(o, NULL, 0, &t->length, NULL);
			t->bytes = hh_take(t->length + 1);
			cborEncode(o, t->bytes, t->length, &t->length, NULL);
			jsonFree(o);
			ms[i] = t;
		}
	}
	const char *form = hh_str(r, "form");
	uint8_t *blob;
	size_t length;
	if (op_get(r, "blob") != NULL) {
		if (!cf_value_bytes(op_get(r, "blob"), &blob, &length)) {
			hh_error(out, "no encoding");
			return;
		}
	} else {
		Json *list = jsonArray();
		for (size_t i = 0; i < count; i++) jsonPush(list, jsonBytes(ms[i]->bytes, ms[i]->length));
		Json *o;
		if (form != NULL && strcmp(form, "list") == 0) o = list;
		else {
			o = jsonObject();
			if (form != NULL && strcmp(form, "members") == 0) jsonAdd(o, "members", list);
			else {
				jsonFree(list);
				pk_item *items = hh_take((count + 1) * sizeof *items);
				for (size_t i = 0; i < count; i++) items[i] = (pk_item){ms[i]->bytes, ms[i]->length, NULL};
				uint8_t *run;
				size_t n;
				if (pk_pack(items, count, &run, &n) != PK_OK) {
					jsonFree(o);
					hh_error(out, "not sealed commits");
					return;
				}
				jsonAdd(o, "run", jsonBytes(run, n));
				free(run);
			}
			if (op_get(r, "tables") != NULL) {
				uint8_t *snapshot;
				size_t n;
				if (!packed(op_get(r, "tables"), &snapshot, &n, out)) {
					jsonFree(o);
					return;
				}
				jsonAdd(o, "snapshot", jsonBytes(snapshot, n));
				free(snapshot);
			}
		}
		length = 0;
		cborEncode(o, NULL, 0, &length, NULL);
		blob = hh_take(length + 1);
		cborEncode(o, blob, length, &length, NULL);
		jsonFree(o);
	}
	uint8_t head[32];
	if (!stored_id(op_get(r, "head"), head, out)) return;
	size_t bn, cn = 0;
	uint8_t(*boundary)[32] = ids_of(op_get(r, "boundary"), &bn, out);
	if (boundary == NULL) return;
	// checkpoints: given, else each member but the head with a leading zero byte
	uint8_t(*checkpoints)[32];
	if (op_get(r, "checkpoints") != NULL) {
		if ((checkpoints = ids_of(op_get(r, "checkpoints"), &cn, out)) == NULL) return;
	} else {
		checkpoints = hh_take(count * 32 + 1);
		for (size_t i = 0; i < count; i++) {
			uint8_t id[32];
			sl_stored(ms[i]->bytes, ms[i]->length, id);
			if (id[0] == 0 && memcmp(id, head, 32) != 0) memcpy(checkpoints[cn++], id, 32);
		}
	}
	if (!tp_conformance_hook_put_fragment(d->t, doc_of(r), head, (const uint8_t(*)[32])boundary, bn,
		    (const uint8_t(*)[32])checkpoints, cn, blob, length)) {
		hh_error(out, "not a document id: %s", doc_of(r));
		return;
	}
	settle(d);
	fputs("{}", out);
}

static hy_history *history_of(const op_value *r, FILE *out, device_t **d) {
	*d = of(r, "device", out);
	if (*d == NULL) return NULL;
	hy_history *h = tp_history((*d)->t, doc_of(r), layer_of(r));
	if (h == NULL) hh_error(out, "not a document id: %s", doc_of(r));
	return h;
}

static void heads(const op_value *r, FILE *out) {
	device_t *d;
	hy_history *h = history_of(r, out, &d);
	if (h == NULL) return;
	const hy_kept **list;
	size_t n = hy_heads(h, &list);
	fputs("{\"heads\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		put_label(out, list[i]->name, CM_NAME);
	}
	fputs("]}", out);
	free(list);
}

static void refused(const op_value *r, FILE *out) {
	device_t *d;
	hy_history *h = history_of(r, out, &d);
	if (h == NULL) return;
	hy_refused_row *rows;
	size_t n = hy_refused(h, &rows);
	fputs("{\"refused\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputs("{\"name\":", out);
		put_label(out, rows[i].name, CM_NAME);
		fprintf(out, ",\"refused\":\"%s\"}", hy_refusal_name(rows[i].refusal));
	}
	fputs("]}", out);
	free(rows);
}

// n ids of width bytes each (names or stored ids)
static void put_labels(FILE *out, const uint8_t *ids, size_t n, size_t width) {
	fputc('[', out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		put_label(out, ids + i * width, width);
	}
	fputc(']', out);
}

static void taking(const op_value *r, FILE *out) {
	device_t *d;
	if (history_of(r, out, &d) == NULL) return;
	tp_conformance_hook_taking t = tp_conformance_hook_taking_of(d->t, doc_of(r), layer_of(r));
	fputs("{\"waiting\":[", out);
	for (size_t i = 0; i < t.waiting_count; i++) {
		if (i) fputc(',', out);
		fputs("{\"commit\":", out);
		put_label(out, t.waiting[i].commit, 32);
		fputs(",\"waiting\":", out);
		put_labels(out, (const uint8_t *)t.waiting[i].names, t.waiting[i].count, CM_NAME);
		fputc('}', out);
	}
	fputs("],\"refused\":[", out);
	for (size_t i = 0; i < t.refused_count; i++) {
		const tp_conformance_hook_refused *x = &t.refused[i];
		if (i) fputc(',', out);
		fprintf(out, "{\"%s\":", x->fragment ? "fragment" : "commit");
		put_label(out, x->id, x->id_length);
		if (x->stuck) {
			fputs(",\"stuck\":", out);
			put_labels(out, (const uint8_t *)x->names, x->count, CM_NAME);
		} else fprintf(out, ",\"refused\":\"%s\"", tp_code_name(x->code));
		fputc('}', out);
	}
	fputs("]}", out);
	tp_conformance_hook_taking_free(&t);
}

static void arrivals(const op_value *r, FILE *out) {
	device_t *d = of(r, "device", out);
	if (d == NULL) return;
	fputs("{\"arrived\":[", out);
	for (size_t i = 0; i < d->arrived_count; i++) {
		const arrival_t *a = &d->arrived[i];
		if (i) fputc(',', out);
		fputc('[', out);
		op_json_string(out, a->doc);
		fprintf(out, ",\"%s\",", tp_layer_name(a->layer));
		put_label(out, a->name, CM_NAME);
		fprintf(out, ",%s]", a->heard ? "true" : "false");
		free(a->doc);
	}
	fputs("]}", out);
	d->arrived_count = 0;
}

static int by_id(const void *a, const void *b) {
	return memcmp(a, b, 32);
}

static void stored(const op_value *r, FILE *out) {
	device_t *d;
	if (history_of(r, out, &d) == NULL) return;
	uint8_t(*ids)[32];
	size_t n = tp_stored(d->t, doc_of(r), &ids);
	qsort(ids, n, 32, by_id);
	fputs("{\"stored\":", out);
	put_labels(out, (const uint8_t *)ids, n, 32);
	fputc('}', out);
	free(ids);
}

static int by_head(const void *a, const void *b) {
	return memcmp((*(const fragment *const *)a)->head, (*(const fragment *const *)b)->head, 32);
}

static void fragments(const op_value *r, FILE *out) {
	device_t *d;
	if (history_of(r, out, &d) == NULL) return;
	const fragment **fs;
	size_t n = tp_fragments(d->t, doc_of(r), &fs);
	qsort(fs, n, sizeof *fs, by_head);
	fputs("{\"fragments\":[", out);
	for (size_t i = 0; i < n; i++) {
		if (i) fputc(',', out);
		fputs("{\"head\":", out);
		put_label(out, fs[i]->head, 32);
		fputs(",\"members\":", out);
		put_labels(out, (const uint8_t *)fs[i]->members.ids, fs[i]->members.count, 32);
		fputs(",\"boundary\":", out);
		put_labels(out, (const uint8_t *)fs[i]->boundary.ids, fs[i]->boundary.count, 32);
		fputc('}', out);
	}
	fputs("]}", out);
	free(fs);
}

static void put_tables(FILE *out, const rp_tables *t) {
	fputc('{', out);
	for (size_t i = 0; i < t->length; i++) {
		if (i) fputc(',', out);
		op_json_string(out, t->slots[i].table);
		fputc(':', out);
		hh_put_entry(out, t->slots[i].entry);
	}
	fputc('}', out);
}

typedef struct {
	uint8_t (*ids)[32];
	size_t count;
} found_t;

static void found(void *context, const uint8_t id[32]) {
	found_t *f = context;
	f->ids = realloc(f->ids, (f->count + 1) * 32);
	if (f->ids == NULL) abort();
	memcpy(f->ids[f->count++], id, 32);
}

// the stored fragment's blob, read from the device's store: its run's commits in order, its
// snapshot's tables, BLAKE3 of its bytes
static void blob(const op_value *r, FILE *out) {
	device_t *d;
	if (history_of(r, out, &d) == NULL) return;
	uint8_t head[32], tree[32];
	if (!stored_id(op_get(r, "head"), head, out)) return;
	tp_doc(doc_of(r), tree);
	found_t ids = {0};
	d->store->list(d->store->self, ERM_STORE_FRAGMENT, tree, found, &ids);
	uint8_t *bytes = NULL;
	size_t length = 0;
	bool got = false;
	for (size_t i = 0; i < ids.count && !got; i++) {
		uint8_t *record;
		size_t n;
		if (d->store->get(d->store->self, ERM_STORE_FRAGMENT, tree, ids.ids[i], &record, &n) != 1) continue;
		ErmSdRecord rec;
		if (erm_sd_decode(ERM_STORE_FRAGMENT, record, n, &rec)) {
			if (memcmp(rec.id, head, 32) == 0)
				got = d->store->get(d->store->self, ERM_STORE_BLOB, NULL, rec.digest, &bytes, &length) == 1;
			erm_sd_free_record(&rec);
		}
		erm_host_free(record);
	}
	free(ids.ids);
	if (!got) {
		fputs("{}", out);
		return;
	}
	Json *x = cborDecode(bytes, length, NULL, NULL);
	const Json *run = jsonGet(x, "run"), *snapshot = jsonGet(x, "snapshot");
	pk_unpacked u = {0};
	if (run == NULL || run->type != JSON_BYTES || pk_unpack(run->bytes.data, run->bytes.length, &u, NULL) != PK_OK) {
		hh_error(out, "not a run");
		jsonFree(x);
		erm_host_free(bytes);
		return;
	}
	fputs("{\"members\":[", out);
	for (size_t i = 0; i < u.count; i++) {
		if (i) fputc(',', out);
		put_label(out, u.members[i].stored, 32);
	}
	fputc(']', out);
	pk_free(&u);
	if (snapshot != NULL && snapshot->type == JSON_BYTES) {
		rp_tables t;
		rp_init(&t);
		if (sn_tables(snapshot->bytes.data, snapshot->bytes.length, &t) == PK_OK) {
			fputs(",\"snapshot\":", out);
			put_tables(out, &t);
		}
		rp_free(&t);
	}
	uint8_t hash[32];
	cm_digest(bytes, length, hash);
	fputs(",\"hash\":", out);
	cf_put_hex(out, hash, 32);
	fputc('}', out);
	jsonFree(x);
	erm_host_free(bytes);
}

static void snapshot(const op_value *r, FILE *out) {
	device_t *d;
	if (history_of(r, out, &d) == NULL) return;
	uint8_t name[CM_NAME];
	const char *error = NULL;
	if (!cs_resolve(commits, op_get(r, "commit"), name, &error)) {
		hh_error(out, "%s", error);
		return;
	}
	rp_tables t;
	rp_init(&t);
	if (tp_snapshot(d->t, doc_of(r), name, &t)) {
		fputs("{\"tables\":", out);
		put_tables(out, &t);
		fputc('}', out);
	} else fputs("{}", out);
	rp_free(&t);
}

void hh_start(void) {
	commits = cs_create();
}

void hh_finish(void) {
	for (size_t i = 0; i < device_count; i++) device_free(devices[i]);
	free(devices);
	wr_free();
	for (size_t i = 0; i < seal_count; i++) free(seals[i].label), free(seals[i].bytes);
	free(seals);
	im_free(&labels);
	for (size_t i = 0; i < storage_count; i++) free(storages[i].label);
	free(storages);
	cs_destroy(commits);
}

void hh_answer(const op_value *r, FILE *out) {
	const char *op = hh_str(r, "op");
	if (!tp_doc(doc_of(r), here)) memset(here, 0, 32);
	if (op == NULL) hh_unknown(out, r);
	else if (strcmp(op, "device") == 0) device(r, out);
	else if (strcmp(op, "close") == 0) close_device(r, out);
	else if (strcmp(op, "connect") == 0) join_devices(r, out);
	else if (strcmp(op, "disconnect") == 0) disconnect(r, out);
	else if (strcmp(op, "follow") == 0) follow(r, out);
	else if (strcmp(op, "make") == 0) {
		if (make(r, NULL, out) != NULL) fputs("{}", out);
	} else if (strcmp(op, "take") == 0) take(r, out);
	else if (strcmp(op, "put") == 0) put(r, out);
	else if (strcmp(op, "fragment") == 0) fragment_op(r, out);
	else if (strcmp(op, "quiet") == 0) {
		if (quiet()) fputs("{}", out);
		else hh_error(out, "never quiet");
	} else if (strcmp(op, "heads") == 0) heads(r, out);
	else if (strcmp(op, "refused") == 0) refused(r, out);
	else if (strcmp(op, "taking") == 0) taking(r, out);
	else if (strcmp(op, "arrived") == 0) arrivals(r, out);
	else if (strcmp(op, "stored") == 0) stored(r, out);
	else if (strcmp(op, "fragments") == 0) fragments(r, out);
	else if (strcmp(op, "blob") == 0) blob(r, out);
	else if (strcmp(op, "snapshot") == 0) snapshot(r, out);
	else hh_unknown(out, r);
}
