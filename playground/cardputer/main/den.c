// the cardputer's den (den.h)
#include "den.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "core/op/c/json.h"
#include "ermine/encoding/c/blake3/blake3.h"
#include "host.h"
#include "things.h"

static const char *const KINDS[3] = {"keys", "screen", "pigs"};
static const char *const PROGRAMS[3] = {
	"keys: gives what was typed",
	"a screen: shows what it reads, big",
	"pigs: gives each pig's weight",
};

static struct {
	host_world w;
	hf *functions;
	pr_policy *may;
	dn *den;
	dn_link *link;
	int64_t beat, swept;
	int code;
} me;

dn *den_get(void) { return me.den; }

static char room_code[5], room_id[DEN_ROOM_ID_LEN + 1];
const char *den_room(void) { return room_code; }

// a write with the host's scope open: the value at path in (part, id), made when not there
typedef struct {
	const char *part, *id;
	const char *const *path;
	size_t n;
	const op_value *v;
} upserting;

static void upsert_now(void *data) {
	upserting *u = data;
	pl *p = me.w.places;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(p, NULL, 0, NULL, &h, &made);
	if (bad != NULL) {
		fprintf(stderr, "den: %s\n", bad);
		free(bad);
		return;
	}
	pl_changed changed = {0};
	nd_entry *born = NULL;
	int code = pl_upsert(p, tb_string(u->part), tb_string(u->id), u->path, u->n, u->v, h, &changed, &born);
	if (code) fprintf(stderr, "den: %s %s: %s\n", u->part, u->id, pl_code_name(code));
	if (changed.n > 0) pl_commit(p, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(p, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

static void upsert(const char *part, const char *id, const char *key, op_value *v) {
	const char *path[1] = {key};
	upserting u = {part, id, path, key ? 1 : 0, v};
	sc_run_with_scope(me.w.host, upsert_now, &u);
	op_free(v);
}

static op_value *attrs1(const char *k, op_value *v) {
	op_value *m = op_map();
	op_set(m, k, v);
	return m;
}

static void make_den(void *data) {
	const char *id = data;
	const char *why = NULL;
	op_value *device = op_str("cardputer");
	me.den = dn_new(&(dn_setup){.scheduler = me.w.s, .table = me.w.table, .places = me.w.places,
		.scopes = me.w.scopes, .functions = me.functions, .id = id, .name = "chee's cardputer", .device = device,
		.may = me.may, .schedule = me.w.schedule, .sites = me.w.sites}, &why);
	op_free(device);
	if (me.den == NULL) {
		fprintf(stderr, "den: not made: %s\n", why);
		me.code = 1;
		return;
	}
	dn_refusal no;
	for (int i = 0; i < 3; i++) {
		char takes[32];
		snprintf(takes, sizeof takes, "thing.%s", KINDS[i]);
		op_value *a = attrs1(DN_TAKES, op_str(takes)), *fn = hf_value(KINDS[i]);
		if (dn_offer(me.den, NULL, DN_RUNNERS, KINDS[i], a, fn, &no) == NULL)
			fprintf(stderr, "den: runner %s refused: %s\n", KINDS[i], no.refused);
		op_free(a), op_free(fn);
	}
	// what it draws on: the whole screen, 4 bits a pixel (fb.h)
	op_value *size = op_list();
	op_push(size, op_int(240));
	op_push(size, op_int(135));
	op_value *s = attrs1(DN_KIND, op_str("framebuffer"));
	op_set(s, DN_SIZE, size);
	if (dn_offer(me.den, NULL, DN_SURFACES, "screen", s, NULL, &no) == NULL)
		fprintf(stderr, "den: surface refused: %s\n", no.refused);
	op_free(s);
	// its hardware as things
	for (int i = 0; i < 3; i++) {
		const char *runner[4] = {"system", "den", "runners", KINDS[i]};
		const char *prog[2] = {"things", KINDS[i]};
		const char *at[2] = {"work", KINDS[i]};
		dn_program program = {.at = prog, .nat = 2, .has_at = 1};
		if (dn_start(me.den, runner, 4, &program, at, 2, &(dn_options){0}, &no) == NULL)
			fprintf(stderr, "den: /work/%s refused: %s\n", KINDS[i], no.refused);
	}
}

int den_boot(const char *id, const char *code) {
	snprintf(room_code, sizeof room_code, "%s", code);
	den_room_id(room_code, room_id);
	me.w = host_get();
	me.functions = hf_new();
	things_add(me.functions);
	me.may = pr_yes();
	// the programs, at /things/<kind>: a few words of what it is, its form the runner's takes
	upsert("children", HOST_ROOT, "things", op_str("things"));
	for (int i = 0; i < 3; i++) {
		char at[32], type[32];
		snprintf(at, sizeof at, "things/%s", KINDS[i]);
		snprintf(type, sizeof type, "thing.%s", KINDS[i]);
		// the table keeps the id: one string for the device's life
		char *id_kept = strdup(at);
		upsert("children", "things", KINDS[i], op_str(id_kept));
		upsert("value", id_kept, NULL, op_str(PROGRAMS[i]));
		upsert("attributes", id_kept, NULL, attrs1(DN_ATTRIBUTE, op_str(type)));
	}
	char *kept = strdup(id);
	sc_run_with_scope(me.w.host, make_den, kept);
	free(kept);
	host_settle();
	return me.code;
}


void den_room_id(const char *code, char out[DEN_ROOM_ID_LEN + 1]) {
	char text[64];
	int n = snprintf(text, sizeof text, "party.chee.ermine.dens.room:%s", code);
	uint8_t h[32];
	blake3_hasher b;
	blake3_hasher_init(&b);
	blake3_hasher_update(&b, text, (size_t)n);
	blake3_hasher_finalize(&b, h, sizeof h);
	strcpy(out, "ermine://");
	for (int i = 0; i < 32; i++) sprintf(out + 9 + 2 * i, "%02x", h[i]);
}

typedef struct {
	chn_channel *channel;
	dn_link *l;
} connecting;

static void connect_now(void *data) {
	connecting *c = data;
	// the room's id the topic; published though it is not the root (the page's the same)
	c->l = dn_connect(me.den, c->channel,
		&(dn_link_setup){.ttl = 10000, .topic = room_id, .publish = DN_PUBLISH_YES});
}

dn_link *den_connect(chn_channel *channel) {
	if (me.den == NULL) return NULL;
	connecting c = {channel, NULL};
	sc_run_with_scope(me.w.host, connect_now, &c);
	me.link = c.l;
	host_settle();
	return c.l;
}

static void beat_now(void *data) {
	(void)data;
	dn_beat(me.link);
}

void den_tick(int64_t now) {
	if (me.link == NULL) return;
	if (now - me.beat >= 3000) {
		me.beat = now;
		sc_run_with_scope(me.w.host, beat_now, NULL);
	}
	if (now - me.swept >= 1000) {
		me.swept = now;
		pres_swept gone = dn_sweep(me.link);
		pres_swept_free(&gone);
	}
	host_settle();
}

void den_print(void) {
	for (int i = 0; i < 3; i++) {
		const char *path[2] = {"work", KINDS[i]};
		tb_key id;
		const op_value *v = NULL;
		if (pl_get(me.w.places, path, 2, &id)) {
			op_key k = {.type = OP_STR_KEY, .s = THING_OUT};
			v = pl_read(me.w.places, tb_string("attributes"), id, &k, 1);
		}
		char *j = v ? op_json_text(v) : NULL;
		printf("/work/%s: %.80s\n", KINDS[i], j ? j : "-");
		free(j);
	}
}
