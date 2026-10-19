// the firmware's programs on the Mac: stdin is the keyboard (a line: its keys, then enter), the
// screen is printed, and the framebuffer written as a PNG (/tmp/dens/card/sim.png, and numbered
// beside it). ./sim.sh builds and runs it.
//
//   ./sim.sh          the shell and the den, typing into both: a line's letters go to /work/keys too
//   ./sim.sh dens     two dens in this one process over a channel pair (presence/c/channel.h): the
//                     cardputer's, and a second ("rabbit") as a browser's would be. the second asks
//                     the cardputer to restart /work/screen reading its /work/drawing, and /work/pigs
//                     reading its /work/button into babe; then draws, presses, and the PNGs show it
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "core/op/c/json.h"
#include "den.h"

// both dens in the room ACDE (the page's host.ts makes the same id from the same code)
#define SIM_ROOM "ACDE"
#include "drivers.h"
#include "fb.h"
#include "host.h"
#include "shell.h"
#include "things.h"

// the card's den id here: a made-up multikey's hex (on the device: its littlesync key's)
#define CARD_ID_FOR_SIM "ed01" "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00"

static int quiet;

void show(const op_value *screen) {
	if (quiet) return;
	const op_value *lines = op_get(screen, "lines"), *prompt = op_get(screen, "prompt");
	printf("+------------------------------+\n|%-30s|\n", "ermine");
	for (size_t i = 0; lines && i < lines->count; i++) printf("|%-30.30s|\n", lines->items[i]->str);
	printf("|> %-28.28s|\n+------------------------------+\n", prompt ? prompt->str : "");
}

// a PNG, no compression (stored deflate blocks) ----------------------------------------------------

static unsigned long crc_table[256];
static unsigned long crc(unsigned long c, const unsigned char *b, size_t n) {
	if (!crc_table[1])
		for (unsigned long k = 0; k < 256; k++) {
			unsigned long x = k;
			for (int j = 0; j < 8; j++) x = x & 1 ? 0xedb88320UL ^ (x >> 1) : x >> 1;
			crc_table[k] = x;
		}
	c ^= 0xffffffffUL;
	for (size_t i = 0; i < n; i++) c = crc_table[(c ^ b[i]) & 0xff] ^ (c >> 8);
	return c ^ 0xffffffffUL;
}
static void be32(unsigned char *p, unsigned long v) {
	p[0] = (unsigned char)(v >> 24), p[1] = (unsigned char)(v >> 16), p[2] = (unsigned char)(v >> 8);
	p[3] = (unsigned char)v;
}
static void chunk(FILE *f, const char *type, const unsigned char *data, size_t n) {
	unsigned char len[4], c[4];
	be32(len, (unsigned long)n);
	fwrite(len, 1, 4, f);
	unsigned char *both = malloc(n + 4);
	memcpy(both, type, 4);
	if (n) memcpy(both + 4, data, n);
	fwrite(both, 1, n + 4, f);
	be32(c, crc(0, both, n + 4));
	fwrite(c, 1, 4, f);
	free(both);
}

// the framebuffer, each pixel 3x3 (so it can be looked at)
#define ZOOM 3
static void png(const char *path) {
	int w = FB_W * ZOOM, h = FB_H * ZOOM;
	size_t row = 1 + (size_t)w * 3, raw_n = row * (size_t)h;
	unsigned char *raw = malloc(raw_n);
	for (int y = 0; y < h; y++) {
		unsigned char *r = raw + (size_t)y * row;
		r[0] = 0;
		for (int x = 0; x < w; x++) memcpy(r + 1 + x * 3, fb_rgb[fb_get(x / ZOOM, y / ZOOM)], 3);
	}
	size_t blocks = (raw_n + 65534) / 65535;
	size_t zn = 2 + raw_n + blocks * 5 + 4;
	unsigned char *z = malloc(zn), *p = z;
	*p++ = 0x78, *p++ = 0x01;
	unsigned long a = 1, b = 0;
	for (size_t i = 0; i < raw_n; i++) a = (a + raw[i]) % 65521, b = (b + a) % 65521;
	for (size_t off = 0; off < raw_n; off += 65535) {
		size_t n = raw_n - off < 65535 ? raw_n - off : 65535;
		*p++ = off + n == raw_n ? 1 : 0;
		*p++ = (unsigned char)n, *p++ = (unsigned char)(n >> 8);
		*p++ = (unsigned char)~n, *p++ = (unsigned char)(~n >> 8);
		memcpy(p, raw + off, n);
		p += n;
	}
	be32(p, b << 16 | a);
	FILE *f = fopen(path, "wb");
	if (f != NULL) {
		fwrite("\x89PNG\r\n\x1a\n", 1, 8, f);
		unsigned char ihdr[13];
		be32(ihdr, (unsigned long)w), be32(ihdr + 4, (unsigned long)h);
		ihdr[8] = 8, ihdr[9] = 2, ihdr[10] = ihdr[11] = ihdr[12] = 0;
		chunk(f, "IHDR", ihdr, 13);
		chunk(f, "IDAT", z, zn);
		chunk(f, "IEND", NULL, 0);
		fclose(f);
	}
	free(raw), free(z);
}

static int frames;
static char named_frame[64];

void frame_show(void) {
	mkdir("/tmp/dens", 0755), mkdir("/tmp/dens/card", 0755);
	char path[128];
	snprintf(path, sizeof path, "/tmp/dens/card/sim-%02d%s%s.png", frames++, named_frame[0] ? "-" : "", named_frame);
	png(path);
	png("/tmp/dens/card/sim.png");
	printf("frame: %s\n", path);
}

// a second den, a browser's as it would be, in its own world ---------------------------------------

static struct {
	sc_scheduler *s;
	tb_table *table;
	pt_paths *paths;
	pl *places;
	pr_processes rows, away;
	const pl_contributor *walk[3];
	sn *scopes;
	hf *functions;
	sc_scope *host;
	sc_pair info;
	dn *den;
	dn_link *link;
	int due;
	// what its things run: the drawing's, the button's
	sc_scope *drawing, *button;
	const char *drawing_id, *button_id;
	int presses;
} b;

static void b_marked(const void *const *keys, size_t nkeys, sc_run *run, sc_computer *const *due, size_t ndue,
	uint64_t tick, void *data) {
	(void)keys, (void)nkeys, (void)run, (void)due, (void)tick, (void)data;
	if (ndue) b.due = 1;
}
static void b_schedule(void *ctx, void (*f)(void *), void *data) { (void)ctx, (void)f, (void)data, b.due = 1; }
static void b_drop(void *v, void *data) { (void)data, op_free(v); }

typedef struct {
	const char *part, *id, *key;
	op_value *v;
} b_write;
static void b_write_now(void *data) {
	b_write *x = data;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(b.places, NULL, 0, NULL, &h, &made);
	if (bad) {
		fprintf(stderr, "rabbit: %s\n", bad), free(bad);
		return;
	}
	const char *path[1] = {x->key};
	pl_changed changed = {0};
	nd_entry *born = NULL;
	int code =
		pl_upsert(b.places, tb_string(x->part), tb_string(x->id), path, x->key ? 1 : 0, x->v, h, &changed, &born);
	if (code) fprintf(stderr, "rabbit: %s: %s\n", x->id, pl_code_name(code));
	if (changed.n) pl_commit(b.places, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(b.places, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (born) pl_hold(b.places, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}
static void b_put(sc_scope *scope, const char *part, const char *id, const char *key, op_value *v) {
	b_write x = {part, id, key, v};
	sc_run_with_scope(scope, b_write_now, &x);
	op_free(v);
}

static void b_stop(void *ctx) { (void)ctx; }
// its things: each keeps its scope and id, and writes its out when told
static hf_run b_thing(const op_value *code, void *api, void *data) {
	(void)code;
	const dn_starting *st = api;
	if (strcmp(data, "drawing") == 0) b.drawing = st->scope, b.drawing_id = st->process.id;
	else {
		b.button = st->scope, b.button_id = st->process.id;
		b_put(st->scope, "attributes", st->process.id, THING_OUT, op_int(0));
	}
	return (hf_run){.handle = {.stop = b_stop}};
}

static void b_make(void *data) {
	(void)data;
	b.functions = hf_new();
	hf_add_runner(b.functions, "drawing", b_thing, "drawing");
	hf_add_runner(b.functions, "button", b_thing, "button");
	const char *why;
	op_value *device = op_str("browser");
	b.den = dn_new(&(dn_setup){.scheduler = b.s, .table = b.table, .places = b.places, .scopes = b.scopes,
		.functions = b.functions, .id = "rabbit-2e4e", .name = "rabbit", .device = device, .may = pr_yes(),
		.schedule = b_schedule}, &why);
	op_free(device);
	if (b.den == NULL) {
		fprintf(stderr, "rabbit: %s\n", why);
		exit(1);
	}
	b_put(b.host, "children", "root", "things", op_str("things"));
	const char *kinds[2] = {"drawing", "button"}, *ids[2] = {"things/drawing", "things/button"};
	dn_refusal no;
	for (int i = 0; i < 2; i++) {
		char takes[32];
		snprintf(takes, sizeof takes, "thing.%s", kinds[i]);
		b_put(b.host, "children", "things", kinds[i], op_str(ids[i]));
		b_put(b.host, "value", ids[i], NULL, op_str(kinds[i]));
		op_value *a = op_map();
		op_set(a, DN_ATTRIBUTE, op_str(takes));
		b_put(b.host, "attributes", ids[i], NULL, a);
		op_value *t = op_map(), *fn = hf_value(kinds[i]);
		op_set(t, DN_TAKES, op_str(takes));
		dn_offer(b.den, NULL, DN_RUNNERS, kinds[i], t, fn, &no);
		op_free(t), op_free(fn);
		const char *runner[4] = {"system", "den", "runners", kinds[i]}, *prog[2] = {"things", kinds[i]},
			   *at[2] = {"work", kinds[i]};
		dn_program program = {.at = prog, .nat = 2, .has_at = 1};
		if (!dn_start(b.den, runner, 4, &program, at, 2, &(dn_options){0}, &no))
			fprintf(stderr, "rabbit: %s refused: %s\n", kinds[i], no.refused);
	}
}

static void b_init(void) {
	b.places = pl_new();
	b.s = sc_new((sc_options){.drop = b_drop});
	sc_on_tracking_end(b.s, pl_forget, b.places);
	sc_on_mark(b.s, b_marked, NULL);
	b.table = tb_make(pl_event, b.places);
	b.paths = pt_new();
	pr_processes_init(&b.rows, tb_string("root"));
	dn_away_init(&b.away, tb_string("root"));
	b.walk[0] = &b.rows.contributor, b.walk[1] = &b.away.contributor, b.walk[2] = &pl_children;
	pl_connect(b.places, &(pl_setup){.root = tb_string("root"), .table = b.table, .paths = b.paths, .scheduler = b.s,
		.contributors = b.walk, .ncontributors = 3});
	b.info = (sc_pair){"actor", op_str("rabbit")};
	b.host = sc_create_root_scope(b.s, &b.info, 1);
	b.scopes = sn_new(b.s, b.table);
	sc_run_with_scope(b.host, b_make, NULL);
}

// both worlds pulsed till neither has anything due
static void settle(void) {
	for (int i = 0; i < 50; i++) {
		host_settle();
		if (!b.due) break;
		b.due = 0;
		sc_pulse(b.s);
		free(sc_escaped(b.s));
	}
	host_settle();
}

typedef struct {
	chn_channel *c;
	dn_link *l;
} b_connecting;
static void b_connect_now(void *data) {
	b_connecting *x = data;
	static char id[DEN_ROOM_ID_LEN + 1];
	den_room_id(SIM_ROOM, id);
	x->l = dn_connect(b.den, x->c,
		&(dn_link_setup){.ttl = 10000, .topic = id, .publish = DN_PUBLISH_YES});
}

typedef struct {
	const op_value *ask;
	unsigned n;
} b_asking;
static void b_ask_now(void *data) {
	b_asking *x = data;
	x->n = dn_remote(b.link, CARD_ID_FOR_SIM, x->ask);
}

// the card's process at /work/<name>, as the rabbit den sees it (mirrored by away): its id
static const char *mirrored(const char *name) {
	const char *path[2] = {"work", name};
	tb_key id;
	if (!pl_get(b.places, path, 2, &id)) return NULL;
	return id.string;
}

static chn_pair *sim_pair;
static void ask(const char *what, op_value *m) {
	b_asking x = {m, 0};
	sc_run_with_scope(b.host, b_ask_now, &x);
	settle();
	const op_value *answer = dn_answer(b.link, x.n);
	if (getenv("SIM_DEBUG")) {
		size_t sent;
		const chn_sent *all = chn_pair_sent(sim_pair, &sent);
		for (size_t i = 0; i < sent; i++) printf("  sent %s -> %s (%zu bytes)\n", all[i].from, all[i].topic, all[i].n);
	}
	char *j = answer ? op_json_text(answer) : NULL;
	printf("ask %s: %s\n", what, j ? j : "(no answer)");
	free(j);
	op_free(m);
}

static op_value *strs(int n, ...) {
	va_list ap;
	va_start(ap, n);
	op_value *l = op_list();
	for (int i = 0; i < n; i++) op_push(l, op_str(va_arg(ap, const char *)));
	va_end(ap);
	return l;
}

// the card's /work/<name> stopped, then started again reading args: a wire, as the page makes one
static void rewire(const char *name, op_value *args) {
	const char *id = mirrored(name);
	if (id == NULL) {
		printf("rabbit sees no /work/%s\n", name);
		exit(1);
	}
	op_value *stop = op_map();
	op_set(stop, "op", op_str("stop"));
	op_set(stop, "process", op_str(id));
	ask("stop", stop);
	char runner[64], program[64], at[64];
	snprintf(runner, sizeof runner, "/system/den/runners/%s", name);
	snprintf(program, sizeof program, "/things/%s", name);
	snprintf(at, sizeof at, "/work/%s", name);
	op_value *start = op_map();
	op_set(start, "op", op_str("start"));
	op_set(start, "runner", op_str(runner));
	// over the wire a program is { id } (away.ts' Program): the card's node at /things/<name>
	op_value *prog = op_map();
	op_set(prog, "id", op_str(program + 1));
	op_set(start, "program", prog);
	op_set(start, "at", op_str(at));
	op_set(start, "args", args);
	ask("start", start);
}

static op_value *num_list(int n, const int *v) {
	op_value *l = op_list();
	for (int i = 0; i < n; i++) op_push(l, op_int(v[i]));
	return l;
}

static void card_out(const char *name) {
	const char *path[2] = {"work", name};
	host_world w = host_get();
	tb_key id;
	if (!pl_get(w.places, path, 2, &id)) {
		printf("card /work/%s: none\n", name);
		return;
	}
	op_key k = {.type = OP_STR_KEY, .s = THING_OUT};
	const op_value *v = pl_read(w.places, tb_string("attributes"), id, &k, 1);
	char *j = v ? op_json_text(v) : NULL;
	printf("card /work/%s out: %.120s\n", name, j ? j : "none");
	free(j);
}

static int dens_demo(void) {
	quiet = 1;
	b_init();
	settle();
	chn_pair *pair = chn_pair_new(CARD_ID_FOR_SIM, "rabbit-2e4e");
	sim_pair = pair;
	char id[DEN_ROOM_ID_LEN + 1];
	den_room_id(SIM_ROOM, id);
	printf("room %s: %s\n", SIM_ROOM, id);
	if (den_connect(chn_pair_a(pair)) == NULL) {
		printf("card: connect refused\n");
		return 1;
	}
	b_connecting x = {chn_pair_b(pair), NULL};
	sc_run_with_scope(b.host, b_connect_now, &x);
	b.link = x.l;
	settle();
	size_t sent;
	const chn_sent *all = chn_pair_sent(pair, &sent);
	size_t biggest = 0;
	for (size_t i = 0; i < sent; i++)
		if (strcmp(all[i].from, CARD_ID_FOR_SIM) == 0 && all[i].n > biggest) biggest = all[i].n;
	printf("card's row: %zu messages so far, the biggest from the card %zu bytes\n", sent, biggest);
	printf("rabbit sees: keys %s, screen %s, pigs %s\n", mirrored("keys") ? "yes" : "no",
		mirrored("screen") ? "yes" : "no", mirrored("pigs") ? "yes" : "no");

	// type on the card
	for (const char *k = "hello"; *k; k++) {
		char key[2] = {*k, 0};
		things_key(key);
		settle();
	}
	card_out("keys");

	// the rabbit draws: a wire into the card's screen, then strokes and three pig stamps
	strcpy(named_frame, "wired");
	rewire("screen", strs(3, "in", "rabbit-2e4e", "/work/drawing"));
	card_out("screen");
	op_value *d = op_map(), *lines = op_list();
	const int smile[] = {60, 40, 70, 30, 80, 40}, ground[] = {10, 120, 230, 120},
		  scribble[] = {150, 30, 170, 20, 190, 35, 210, 22, 228, 34};
	op_push(lines, num_list(6, smile));
	op_push(lines, num_list(4, ground));
	op_push(lines, num_list(10, scribble));
	op_set(d, "lines", lines);
	op_value *pigs = op_list();
	op_value *p1 = op_map(), *p2 = op_map(), *p3 = op_map();
	op_set(p1, "name", op_str("babe")), op_set(p1, "x", op_int(70)), op_set(p1, "y", op_int(95));
	op_set(p2, "name", op_str("wilbur")), op_set(p2, "x", op_int(170)), op_set(p2, "y", op_int(90));
	op_set(p3, "name", op_str("kevin")), op_set(p3, "x", op_int(120)), op_set(p3, "y", op_int(60));
	op_push(pigs, p1), op_push(pigs, p2), op_push(pigs, p3);
	op_set(d, "pigs", pigs);
	strcpy(named_frame, "drawn");
	b_put(b.drawing, "attributes", b.drawing_id, THING_OUT, d);
	settle();
	card_out("screen");

	// the rabbit's button into babe: two presses, and babe grows on the drawing
	strcpy(named_frame, "pigs-rewired");
	rewire("pigs", strs(3, "babe", "rabbit-2e4e", "/work/button"));
	for (int i = 0; i < 2; i++) {
		snprintf(named_frame, sizeof named_frame, "press-%d", i + 1);
		b_put(b.button, "attributes", b.button_id, THING_OUT, op_int(++b.presses));
		settle();
	}
	card_out("pigs");

	// text into the screen
	strcpy(named_frame, "text");
	b_put(b.drawing, "attributes", b.drawing_id, THING_OUT, op_str("hello pigs"));
	settle();
	printf("frames: %d\n", frames);
	return 0;
}

int main(int argc, char **argv) {
	host_init();
	api *keys = host_start("keyboard", keyboard);
	host_start("shell", shell);
	host_start("display", display);
	if (den_boot(CARD_ID_FOR_SIM, SIM_ROOM)) return 1;
	host_settle();
	if (argc > 1 && strcmp(argv[1], "dens") == 0) return dens_demo();
	char line[256];
	while (fgets(line, sizeof line, stdin)) {
		for (char *c = line; *c && *c != '\n'; c++) {
			char key[2] = {*c, 0};
			keyboard_press(keys, key);
			things_key(key);
			host_settle();
		}
		keyboard_press(keys, "enter");
		host_settle();
	}
	return 0;
}
