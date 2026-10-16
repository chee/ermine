// The device (device.h): playground/term/host.c's, cut down to whole-value writes, with sync's
// ephemeral option and presence's messages on the device's connection
#define _DARWIN_C_SOURCE
#include "device.h"

#include "../../../../core/node/c/update.h"
#include "../../../../ermine/encoding/c/json.h"
#include "../../../../extensions/subduction/c/subduction/platform.h"
#include "../../../../extensions/subduction/c/subduction/store.h"
#include "../../../../extensions/subduction/c/subduction/transport.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

// one write's patch: the whole value put (path empty), and the site its change refers to
typedef struct {
	op_patch patch;
	op_key none[1];
	ch_site site;
} put_t;

static put_t *put_new(op_value *value) {
	put_t *p = calloc(1, sizeof *p);
	if (!p) abort();
	p->patch = (op_patch){.place = {.path = p->none, .length = 0}, .has_value = 1, .value = value};
	return p;
}

static void put_free(put_t *p) {
	if (!p) return;
	op_free((op_value *)p->patch.value);
	free(p);
}

// an entry written here, and the last write's patch its change refers to; owned: made here (sync
// gives it back through drop when it takes it out or replaces it)
typedef struct {
	nd_entry *entry;
	put_t *held;
	bool owned;
} hold_t;

typedef struct {
	char id[DV_ID];
} follow_t;

struct dv {
	uint8_t seed[32];
	char key[65];
	tb_table *table;
	sy_sync *sync;
	op_value *actor;
	uint64_t changes;
	hold_t *holds;
	size_t nholds, holdroom;
	char *server, *service;
	ErmTransport *ws;
	uint64_t conn;
	double retry;
	unsigned long sent;
	follow_t *follows;
	size_t nfollows, followroom;
	// the id being written ephemerally, for the length of that one write
	const char *waving;
	// the listeners: one a topic
	struct listen_t {
		tp_listener *on;
		dv_heard_fn fn;
		void *context;
	} listens[4];
	size_t nlistens;
};

// Subduction's memory store has no free (store.h): each one made stays reachable while the process lives
static ErmStore **stores;
static size_t nstores;

static const ErmStore *store_new(void) {
	stores = realloc(stores, (nstores + 1) * sizeof *stores);
	ErmStore *s = malloc(sizeof *s);
	if (!stores || !s) abort();
	*s = ermStoreMemory();
	return stores[nstores++] = s;
}

double dv_now(void) {
	struct timeval tv;
	gettimeofday(&tv, NULL);
	return (double)tv.tv_sec + tv.tv_usec / 1e6;
}

static hold_t *hold_of(dv *d, const nd_entry *e) {
	for (size_t i = 0; i < d->nholds; i++)
		if (d->holds[i].entry == e) return &d->holds[i];
	return NULL;
}

static hold_t *hold_new(dv *d, nd_entry *e, bool owned) {
	if (d->nholds == d->holdroom) {
		d->holdroom = d->holdroom ? d->holdroom * 2 : 16;
		d->holds = realloc(d->holds, d->holdroom * sizeof *d->holds);
		if (!d->holds) abort();
	}
	d->holds[d->nholds] = (hold_t){e, NULL, owned};
	return &d->holds[d->nholds++];
}

static void unhold(dv *d, hold_t *k) {
	put_free(k->held);
	if (k->owned) nd_free_entry(k->entry);
	*k = d->holds[--d->nholds];
}

static void event(void *ctx, tb_key part, tb_key id) {
	dv *d = ctx;
	d->changes++;
	if (d->sync) sy_table_changed(d->sync, part, id);
}

static void committed(void *ctx, nd_entry *const *changed, size_t count) {
	(void)changed, (void)count;
	((dv *)ctx)->changes++;
}

static void dropped(void *ctx, nd_entry *e) {
	dv *d = ctx;
	hold_t *k = hold_of(d, e);
	if (k && k->owned) unhold(d, k);
}

static bool ephemeral(void *ctx, const char *doc, const char *table) {
	dv *d = ctx;
	return d->waving && !strcmp(doc, d->waving) && !strcmp(table, "value");
}

static void lost(dv *d) {
	if (!d->ws) return;
	ermTransportClose(d->ws);
	d->ws = NULL;
	tp_closed(sy_device(d->sync), d->conn);
	d->retry = dv_now() + 3;
}

static bool open_server(dv *d, const char **why) {
	d->ws = ermTransportOpen(d->server, why);
	if (!d->ws) return false;
	d->conn = tp_connect(sy_device(d->sync), d->service);
	return true;
}

dv *dv_new(const char *server, const char *service, bool zeros, const char *actor, const char **why) {
	dv *d = calloc(1, sizeof *d);
	if (!d) abort();
	erm_host_random(d->seed, 32);
	d->table = tb_make(event, d);
	sy_options o = {.table = d->table, .store = store_new(), .zeros = zeros, .ephemeral = ephemeral,
		.commit = committed, .drop = dropped, .context = d};
	memcpy(o.seed, d->seed, 32);
	d->sync = sy_create(&o);
	if (!d->sync) {
		*why = "Subduction would not make a device";
		dv_free(d);
		return NULL;
	}
	const uint8_t *key = tp_key(sy_device(d->sync));
	for (int i = 0; i < 32; i++) snprintf(d->key + 2 * i, 3, "%02x", key[i]);
	d->actor = op_str(actor);
	if (server) {
		d->server = copyString(server);
		char host[256];
		if (!service || !*service) tp_service(server, host, sizeof host), service = host;
		d->service = copyString(service);
		if (!open_server(d, why)) {
			dv_free(d);
			return NULL;
		}
	}
	return d;
}

void dv_free(dv *d) {
	if (!d) return;
	if (d->ws) ermTransportClose(d->ws);
	for (size_t i = 0; i < d->nlistens; i++) tp_unlisten(sy_device(d->sync), d->listens[i].on);
	sy_free(d->sync);
	d->sync = NULL;
	while (d->nholds) unhold(d, &d->holds[d->nholds - 1]);
	free(d->holds);
	tb_free(d->table);
	free(d->follows);
	op_free(d->actor);
	free(d->server);
	free(d->service);
	free(d);
}

sy_sync *dv_sync(dv *d) { return d->sync; }
const char *dv_key(dv *d) { return d->key; }
bool dv_online(dv *d) { return d->ws && tp_connected(sy_device(d->sync), d->conn, NULL); }
uint64_t dv_changes(dv *d) { return d->changes; }

const op_value *dv_value(dv *d, const char *part, const char *id) {
	nd_entry *e = tb_get(d->table, tb_string(part), tb_string(id));
	return e ? e->value : NULL;
}

void dv_mint(dv *d, char out[DV_ID]) { sy_mint(d->sync, out); }

void dv_follow(dv *d, const char *id) {
	uint8_t bytes[32];
	if (!id || !tp_doc(id, bytes)) return;
	for (size_t i = 0; i < d->nfollows; i++)
		if (!strcmp(d->follows[i].id, id)) return;
	if (d->nfollows == d->followroom) {
		d->followroom = d->followroom ? d->followroom * 2 : 16;
		d->follows = realloc(d->follows, d->followroom * sizeof *d->follows);
		if (!d->follows) abort();
	}
	snprintf(d->follows[d->nfollows++].id, DV_ID, "%s", id);
	sy_follow(d->sync, id);
}

static int write(dv *d, const char *id, op_value *value, const ch_site *site) {
	dv_follow(d, id);
	put_t *p = put_new(value);
	p->site = *site;
	ch_header header = {.has_time = 1, .time = (int64_t)dv_now(), .actor = d->actor, .external = &p->site,
		.external_length = 1};
	tb_key pk = tb_string("value"), ik = tb_string(id);
	nd_entry *e = tb_get(d->table, pk, ik);
	if (!e) {
		// none there: one made holding the value (its event tells sync)
		e = nd_make_entry(value, &header, NULL);
		if (!e) abort();
		hold_t *stale = hold_of(d, e);
		if (stale) unhold(d, stale);
		hold_new(d, e, true)->held = p;
		d->changes++;
		tb_add(d->table, pk, ik, e);
		return 0;
	}
	size_t failed;
	int code = nd_update(e, &p->patch, 1, header, &failed);
	if (code != OP_OK) {
		put_free(p);
		return code;
	}
	hold_t *k = hold_of(d, e);
	if (!k) k = hold_new(d, e, false);
	put_free(k->held);
	k->held = p;
	d->changes++;
	sy_wrote(d->sync, &e, 1);
	return 0;
}

int dv_store(dv *d, const char *id, op_value *value) { return write(d, id, value, CH_HERE); }

int dv_wave(dv *d, const char *id, op_value *value) {
	d->waving = id;
	int code = write(d, id, value, CH_HERE);
	d->waving = NULL;
	return code;
}

void dv_settle(dv *d, const char *id) {
	ch_header header = {.has_time = 1, .time = (int64_t)dv_now(), .actor = d->actor};
	sy_settle(d->sync, id, &header);
	d->changes++;
}

void dv_send(dv *d, const char *topic, const uint8_t *bytes, size_t n) {
	tp_send(sy_device(d->sync), topic, bytes, n);
}

static void told(void *context, const char *from, const uint8_t *bytes, size_t n) {
	struct listen_t *l = context;
	l->fn(l->context, from, bytes, n);
}

void dv_listen(dv *d, const char *topic, dv_heard_fn fn, void *context) {
	if (d->nlistens == sizeof d->listens / sizeof *d->listens) abort();
	struct listen_t *l = &d->listens[d->nlistens++];
	l->fn = fn, l->context = context;
	l->on = tp_listen(sy_device(d->sync), topic, told, l);
}

size_t dv_fds(dv *d, struct pollfd *fds, size_t room) {
	if (!d->ws || !room) return 0;
	int fd = ermTransportFd(d->ws);
	if (fd < 0) return 0;
	fds[0] = (struct pollfd){.fd = fd, .events = POLLIN};
	return 1;
}

void dv_ready(dv *d) {
	while (d->ws) {
		uint8_t *bytes;
		size_t length;
		int got = ermTransportReceive(d->ws, &bytes, &length);
		if (got == 0) break;
		if (got < 0) {
			lost(d);
			break;
		}
		tp_received(sy_device(d->sync), d->conn, bytes, length);
		erm_host_free(bytes);
	}
}

int dv_turn(dv *d) {
	if (d->server && !d->ws && dv_now() >= d->retry) {
		const char *why;
		if (!open_server(d, &why)) d->retry = dv_now() + 3;
	}
	tp_device *t = sy_device(d->sync);
	int64_t wait = -1;
	for (int round = 0; round < 16; round++) {
		wait = sy_run(d->sync);
		bool did = false;
		tp_out out;
		while (tp_next(t, &out)) {
			did = true;
			if (out.kind == TP_SEND && d->ws && out.conn == d->conn) {
				if (!ermTransportSend(d->ws, out.bytes, out.length)) lost(d);
				d->sent++;
			} else if (out.kind == TP_CLOSE && d->ws && out.conn == d->conn) lost(d);
			tp_out_free(&out);
		}
		dv_ready(d);
		if (!did && wait != 0) break;
	}
	return wait < 0 || wait > 1000 ? 1000 : (int)wait;
}

void dv_flush(dv *d, int ms) {
	double end = dv_now() + ms / 1000.0, quiet = dv_now();
	while (dv_now() < end && d->ws) {
		struct pollfd fds[2];
		size_t n = dv_fds(d, fds, 2);
		unsigned long before = d->sent;
		int wait = dv_turn(d);
		poll(fds, (nfds_t)n, wait > 20 ? 20 : wait);
		dv_ready(d);
		dv_turn(d);
		if (d->sent != before || !sy_idle(d->sync)) quiet = dv_now();
		else if (dv_now() - quiet > 0.4) return;
	}
}
