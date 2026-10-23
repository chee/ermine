// the things (things.h), and what the screen thing draws.
//
// the screen thing gives its "in" on as it is, and draws it on the framebuffer, the whole 240x135:
//   nothing wired in          the paper, and "wire something into its in"
//   a string or a number      big, in the middle
//   a drawing                 { lines: [[x0, y0, x1, y1, ...], ...], pigs: [{ name, x, y }, ...] }
//                             in screen pixels (0..239, 0..134): each line its points joined, a
//                             pen 2 wide; each pig stamp a pointer to a real pig, drawn at the
//                             weight this den's /home/pigs gives that name now (heavier, bigger:
//                             1x to 3x, as book/kit/farm.ts' pigScale), centred on x, y, its name
//                             and weight over it; a name the pigs don't give: drawn small and grey
//   a picture                 { width, height, squares: bytes }: squares on or off, row after row,
//                             the first of each byte its top bit (a pad's: 48x27, 5 pixels a square)
//   the pigs' weights         { babe: 9, ... }: the pigs in a field, each as big as it weighs
//   anything else             its JSON, wrapped
#include "things.h"
#include "den.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "core/op/c/json.h"
#include "fb.h"
#include "parts.h"

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}

// a thing running: its process's facts, kept for its life
typedef struct thing thing;
typedef void (*heard_fn)(thing *t, const op_value *v, int first, const char *input);
typedef struct {
	thing *t;
	const char *input;
	char **path;
	size_t npath;
	// the id last heard from (NULL: none yet)
	char *was;
	heard_fn heard;
} source;
struct thing {
	sc_scheduler *s;
	pl *places;
	sc_scope *scope;
	// the software's, until sw_free (a table entry's id must outlive it)
	const char *id;
	char **args;
	size_t nargs;
	source sources[5];
	size_t nsources;
	int stopped;
	// keys
	char text[19];
	// pigs
	double weights[3];
	unsigned turn;
	// a part's (parts.h): what it does each loop, and when next; what it lets go of at its stop; what
	// it gave last, and how many times (the speaker's, the IR's)
	void (*tick)(thing *t, int64_t now);
	void (*done)(thing *t);
	int64_t next, said;
	double x, y;
	char last[96];
	int n;
};

static const char *const PIGS[3] = {"babe", "peppa", "wilbur"};

// writes ------------------------------------------------------------------------------------------

typedef struct {
	thing *t;
	const char *name;
	const op_value *v;
} writing;

static void write_now(void *data) {
	writing *w = data;
	pl *p = w->t->places;
	ch_header h;
	pl_made *made;
	char *bad = pl_header(p, NULL, 0, NULL, &h, &made);
	if (bad != NULL) {
		fprintf(stderr, "things: %s\n", bad);
		free(bad);
		return;
	}
	const char *path[1] = {w->name};
	pl_changed changed = {0};
	nd_entry *born = NULL;
	int code = pl_upsert(p, tb_string("attributes"), tb_string(w->t->id), path, 1, w->v, h, &changed, &born);
	if (code != 0) fprintf(stderr, "things: %s not written: %s\n", w->name, pl_code_name(code));
	if (changed.n > 0) pl_commit(p, &changed);
	for (size_t i = 0; i < changed.n; i++) pl_hold_also(p, changed.entries[i], pl_made_ref(made), pl_made_free);
	if (born != NULL) pl_hold(p, born, pl_made_ref(made), pl_made_free);
	pl_made_free(made);
}

// its attribute name set, with its scope open; v taken
static void put(thing *t, const char *name, op_value *v) {
	if (!t->stopped) {
		writing w = {t, name, v};
		sc_run_with_scope(t->scope, write_now, &w);
	}
	op_free(v);
}
static void out(thing *t, op_value *v) { put(t, THING_OUT, v); }

// sources -----------------------------------------------------------------------------------------

// "/home/keys" as its steps
static size_t steps(const char *at, char ***out) {
	size_t n = 0;
	char **v = xalloc((strlen(at) / 2 + 2) * sizeof *v);
	for (const char *p = at; *p;) {
		while (*p == '/') p++;
		const char *e = p;
		while (*e && *e != '/') e++;
		if (e > p) {
			char *s = xalloc((size_t)(e - p) + 1);
			memcpy(s, p, (size_t)(e - p));
			v[n++] = s;
		}
		p = e;
	}
	*out = v;
	return n;
}

// the out of the node at path, tracked: { id, v } (none there: {})
static op_value *out_at(pl *places, char *const *path, size_t n) {
	op_value *got = op_map();
	tb_key id;
	if (!pl_get(places, (const char *const *)path, n, &id) || id.string == NULL) return got;
	op_key k = {.type = OP_STR_KEY, .s = THING_OUT};
	const op_value *v = pl_read(places, tb_string("attributes"), id, &k, 1);
	op_set(got, "id", op_str(id.string));
	if (v != NULL) op_set(got, "v", op_ref((op_value *)v));
	return got;
}

static sc_out source_f(void *previous, void *data) {
	(void)previous;
	source *src = data;
	return (sc_out){.kind = SC_VALUE, .value = out_at(src->t->places, src->path, src->npath)};
}

// the same node, the same value (as the page's: by identity)
static bool heard_equal(const void *a, const void *b, void *data) {
	(void)data;
	const op_value *x = a, *y = b;
	if (x == NULL || y == NULL) return x == y;
	const op_value *ix = op_get(x, "id"), *iy = op_get(y, "id");
	if ((ix == NULL) != (iy == NULL)) return false;
	if (ix != NULL && strcmp(ix->str, iy->str) != 0) return false;
	return op_get(x, "v") == op_get(y, "v");
}

static char *source_act(void *value, void *previous, void *data) {
	(void)previous;
	source *src = data;
	const op_value *id = op_get(value, "id"), *v = op_get(value, "v");
	if (id == NULL || v == NULL || src->t->stopped) return NULL;
	int first = src->was == NULL || strcmp(src->was, id->str) != 0;
	free(src->was);
	src->was = strdup(id->str);
	src->heard(src->t, v, first, src->input);
	return NULL;
}

static void make_effect(void *data) {
	source *src = data;
	sc_create_effect(src->t->s, (sc_def){.f = source_f, .effect = source_act, .equal = heard_equal, .data = src},
		NULL, 0);
}

// what is wired into input heard: its first triple [input, den, path] in args
static void reading(thing *t, const char *input, heard_fn heard) {
	for (size_t i = 0; i + 2 < t->nargs; i++) {
		if (strchr(t->args[i], '=') != NULL) continue;
		if (strcmp(t->args[i], input) != 0) {
			i += 2;
			continue;
		}
		if (t->nsources == sizeof t->sources / sizeof *t->sources) return;
		source *src = &t->sources[t->nsources++];
		src->t = t;
		src->input = input;
		src->heard = heard;
		src->npath = steps(t->args[i + 2], &src->path);
		sc_run_with_scope(t->scope, make_effect, src);
		return;
	}
}

// a setting, "name=value" in args; NULL: none
static const char *setting(thing *t, const char *name) {
	size_t n = strlen(name);
	for (size_t i = 0; i < t->nargs; i++) {
		const char *a = t->args[i];
		if (strchr(a, '=') == NULL) {
			i += 2;
			continue;
		}
		if (strncmp(a, name, n) == 0 && a[n] == '=') return a + n + 1;
	}
	return NULL;
}

// a thing's life ----------------------------------------------------------------------------------

static thing *keys_running;
// the parts' things running, ticked each loop
#define PARTS 12
static thing *ticking[PARTS];

static char *let_go(void *data) {
	thing *t = data;
	for (int i = 0; i < PARTS; i++)
		if (ticking[i] == t) ticking[i] = NULL;
	if (t->done) t->done(t), t->done = NULL;
	for (size_t i = 0; i < t->nsources; i++) {
		for (size_t k = 0; k < t->sources[i].npath; k++) free(t->sources[i].path[k]);
		free(t->sources[i].path);
		free(t->sources[i].was);
	}
	for (size_t i = 0; i < t->nargs; i++) free(t->args[i]);
	free(t->args);
	free(t);
	return NULL;
}

static void stopped(void *ctx) {
	thing *t = ctx;
	t->stopped = 1;
	if (keys_running == t) keys_running = NULL;
	for (int i = 0; i < PARTS; i++)
		if (ticking[i] == t) ticking[i] = NULL;
	if (t->done) t->done(t), t->done = NULL;
}

static thing *thing_of(void *api) {
	const sw_starting *st = api;
	thing *t = xalloc(sizeof *t);
	t->s = st->scheduler;
	t->places = st->places;
	t->scope = st->scope;
	t->id = st->process.id;
	t->nargs = st->process.nargs;
	t->args = xalloc((t->nargs + 1) * sizeof *t->args);
	for (size_t i = 0; i < t->nargs; i++) t->args[i] = strdup(st->process.args[i]);
	free(sc_register_teardown(t->s, t->scope, let_go, t));
	return t;
}

static hf_run running(thing *t) { return (hf_run){.handle = {.stop = stopped, .ctx = t}}; }

// keys: what was typed, the last 18 letters -------------------------------------------------------

static hf_run keys(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	out(t, op_str(""));
	keys_running = t;
	return running(t);
}

void things_key(const char *key) {
	thing *t = keys_running;
	if (t == NULL) return;
	size_t n = strlen(t->text);
	if (strcmp(key, "del") == 0) {
		if (n) t->text[n - 1] = 0;
	} else if (strlen(key) == 1) {
		if (n == 18) memmove(t->text, t->text + 1, n--);
		t->text[n] = key[0], t->text[n + 1] = 0;
	} else return;
	out(t, op_str(t->text));
}

// pigs: { name: weight }; a change into a pig's input feeds it; "say" goes round the pigs ---------

static op_value *weights(thing *t) {
	op_value *m = op_map();
	for (int i = 0; i < 3; i++) {
		double w = t->weights[i];
		op_set(m, PIGS[i], w == floor(w) ? op_int((int64_t)w) : op_num(w));
	}
	return m;
}

static void feed(thing *t, const op_value *v, int first, const char *input) {
	(void)v;
	if (first) return;
	for (int i = 0; i < 3; i++)
		if (strcmp(input, PIGS[i]) == 0) t->weights[i] += 1;
	out(t, weights(t));
}

// a value as the page's String(): a number without a needless .0
static char *text_of(const op_value *v) {
	if (v->type == OP_STR) return strdup(v->str);
	if (v->type == OP_NUM) {
		char b[32];
		snprintf(b, sizeof b, "%.15g", v->num);
		return strdup(b);
	}
	char *j = op_json_text(v);
	return j ? j : strdup("?");
}

static void say(thing *t, const op_value *v, int first, const char *input) {
	(void)input;
	if (first || v->type == OP_NULL) return;
	char *s = text_of(v);
	size_t n = strlen(s);
	op_value *m = op_map();
	op_set(m, "pig", op_str(PIGS[t->turn++ % 3]));
	op_set(m, "text", op_str(n > 24 ? s + n - 24 : s));
	op_set(m, "n", op_int(t->turn));
	free(s);
	put(t, THING_SAYS, m);
}

static hf_run pigs(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	const double start[3] = {9, 6, 12};
	for (int i = 0; i < 3; i++) {
		const char *s = setting(t, PIGS[i]);
		double w = s ? atof(s) : 0;
		t->weights[i] = w > 0 ? w : start[i];
	}
	out(t, weights(t));
	for (int i = 0; i < 3; i++) reading(t, PIGS[i], feed);
	reading(t, "say", say);
	return running(t);
}

// screen: gives its "in" on; draws it with the pigs as they weigh now -----------------------------

static void give(thing *t, const op_value *v, int first, const char *input) {
	(void)first, (void)input;
	out(t, op_ref((op_value *)v));
}

// what is drawn: the in's out, and this den's pigs', both tracked
typedef struct {
	thing *t;
	char **in;
	size_t nin;
} drawing;

static sc_out draw_f(void *previous, void *data) {
	(void)previous;
	drawing *d = data;
	op_value *both = op_map();
	if (d->nin) op_set(both, "in", out_at(d->t->places, d->in, d->nin));
	char *pigs_at[2] = {"home", "pigs"};
	op_set(both, "pigs", out_at(d->t->places, pigs_at, 2));
	return (sc_out){.kind = SC_VALUE, .value = both};
}

static bool draw_equal(const void *a, const void *b, void *data) {
	(void)data;
	return heard_equal(op_get(a, "in"), op_get(b, "in"), NULL) &&
		heard_equal(op_get(a, "pigs"), op_get(b, "pigs"), NULL);
}

// how big a pig of this weight is drawn: 1x to 4x (about 30 and over: the fattest), as the page's
static int pig_scale(double w) {
	double k = round(1 + (w - 5) / 10);
	return k < 1 ? 1 : k > 4 ? 4 : (int)k;
}

static op_value *map_of(const char *k, op_value *v) {
	op_value *m = op_map();
	op_set(m, k, v);
	return m;
}

static int number(const op_value *v, double *out) {
	if (v == NULL || v->type != OP_NUM) return 0;
	*out = v->num;
	return 1;
}

static void label(int cx, int y, const char *s, int ink) {
	int w = fb_text_width(s, 1);
	int x = cx - w / 2;
	fb_rect(x - 2, y - 1, w + 4, 10, ink);
	fb_text(x, y, s, FB_WHITE, 1);
}

static void draw_drawing(const op_value *v, const op_value *weights) {
	fb_clear(FB_CREAM);
	const op_value *lines = op_get(v, "lines"), *stamps = op_get(v, "pigs");
	for (size_t i = 0; lines && lines->type == OP_LIST && i < lines->count; i++) {
		const op_value *pts = lines->items[i];
		if (pts->type != OP_LIST) continue;
		double x0, y0, x1, y1;
		if (pts->count == 2 && number(pts->items[0], &x0) && number(pts->items[1], &y0)) {
			fb_line((int)x0, (int)y0, (int)x0, (int)y0, FB_INK, 2);
			continue;
		}
		for (size_t k = 0; k + 3 < pts->count; k += 2) {
			if (!number(pts->items[k], &x0) || !number(pts->items[k + 1], &y0) || !number(pts->items[k + 2], &x1) ||
				!number(pts->items[k + 3], &y1))
				break;
			fb_line((int)x0, (int)y0, (int)x1, (int)y1, FB_INK, 2);
		}
	}
	for (size_t i = 0; stamps && stamps->type == OP_LIST && i < stamps->count; i++) {
		const op_value *p = stamps->items[i];
		const op_value *name = op_get(p, "name");
		double x, y, w = 0;
		if (name == NULL || name->type != OP_STR || !number(op_get(p, "x"), &x) || !number(op_get(p, "y"), &y)) continue;
		int real = number(weights ? op_get(weights, name->str) : NULL, &w);
		int k = real ? pig_scale(w) : 1;
		int px = (int)x - FB_PIG_W * k / 2, py = (int)y - FB_PIG_H * k / 2;
		fb_rect(px + 2, py + FB_PIG_H * k - 1, FB_PIG_W * k - 4, 2, FB_MUD);
		fb_pig(px, py, k);
		char l[40];
		if (real) snprintf(l, sizeof l, "%s %.0f", name->str, w);
		else snprintf(l, sizeof l, "%s ?", name->str);
		label((int)x, py - 11, l, real ? FB_INK : FB_GREY);
	}
}

static void draw_text(const char *s) {
	fb_clear(FB_LEMON);
	size_t n = strlen(s);
	if (n > 29) s += n - 29, n = 29;
	if (n == 0) return;
	int k = (int)(232 / (n * 8));
	if (k > 6) k = 6;
	if (k < 1) k = 1;
	int w = fb_text_width(s, k);
	fb_text((FB_W - w) / 2, (FB_H - 8 * k) / 2, s, FB_INK, k);
}

static void draw_wrapped(const char *s) {
	fb_clear(FB_LEMON);
	char row[31];
	for (int y = 4; *s && y + 8 <= FB_H; y += 10) {
		size_t n = strlen(s) < 29 ? strlen(s) : 29;
		memcpy(row, s, n);
		row[n] = 0;
		fb_text(4, y, row, FB_INK, 1);
		s += n;
	}
}

// a picture's squares, as big as fit, in the middle: 1 if v is one
static int draw_squares(const op_value *v) {
	const op_value *sq = op_get(v, "squares");
	double w, h;
	if (sq == NULL || sq->type != OP_BYTES || !number(op_get(v, "width"), &w) || !number(op_get(v, "height"), &h) ||
		w < 1 || h < 1 || w > FB_W || h > FB_H || (size_t)w * (size_t)h > sq->bytes * 8)
		return 0;
	int across = (int)w, down = (int)h;
	int k = FB_W / across < FB_H / down ? FB_W / across : FB_H / down;
	int x0 = (FB_W - across * k) / 2, y0 = (FB_H - down * k) / 2;
	fb_clear(FB_LEMON);
	for (int y = 0; y < down; y++) {
		for (int x = 0; x < across; x++) {
			size_t i = (size_t)y * (size_t)across + (size_t)x;
			if (sq->data[i >> 3] >> (7 - (i & 7)) & 1) fb_rect(x0 + x * k, y0 + y * k, k, k, FB_INK);
		}
	}
	return 1;
}

// the pigs' weights, as pigs in a field, each as big as it weighs, its name and weight over it: 1 if
// v gives any of the pigs a number
static int draw_pigs(const op_value *v) {
	double w[3];
	int any = 0;
	for (int i = 0; i < 3; i++) any |= number(op_get(v, PIGS[i]), &w[i]);
	if (!any) return 0;
	fb_clear(FB_GRASS);
	fb_rect(0, 0, FB_W, 18, FB_SKY);
	for (int i = 0; i < 3; i++) {
		if (!number(op_get(v, PIGS[i]), &w[i])) continue;
		int k = pig_scale(w[i]);
		// three across, the middle one lower, as the page's field has them
		int cx = 40 + i * 80, cy = i == 1 ? 98 : 70;
		int px = cx - FB_PIG_W * k / 2, py = cy - FB_PIG_H * k / 2;
		fb_rect(px + 2, py + FB_PIG_H * k - 1, FB_PIG_W * k - 4, 3, FB_MUD);
		fb_pig(px, py, k);
		char l[32];
		snprintf(l, sizeof l, "%s %.0f", PIGS[i], w[i]);
		label(cx, py - 12, l, FB_INK);
	}
	return 1;
}

// nothing wired in: the room's code, big, to read off and type in on another screen
static void draw_empty(void) {
	fb_clear(FB_LEMON);
	fb_rect(0, 0, FB_W, 12, FB_CHERRY);
	fb_text(4, 2, "chee's cardputer", FB_WHITE, 1);
	const char *code = den_room();
	if (code[0]) {
		// the letters big and a little apart, on a white tag
		int n = (int)strlen(code), w = n * 40 + (n - 1) * 6, x = (FB_W - w) / 2;
		fb_rect(x - 10, 26, w + 20, 56, FB_WHITE);
		for (int i = 0; i < n; i++) {
			char one[2] = {code[i], 0};
			fb_text(x + i * 46, 34, one, FB_INK, 5);
		}
		fb_text((FB_W - fb_text_width("the room's code", 1)) / 2, 86, "the room's code", FB_INK, 1);
	}
	fb_text(4, 100, "wire into /home/screen", FB_GREY, 1);
}

// what the screen shows, kept to be drawn again strip by strip (fb.h): the in's out and the pigs'
// (held), and a number or anything else as its text, made at the first strip that wants it
static struct {
	op_value *in, *weights;
	char *text;
} scene;

static void scene_let_go(void) {
	if (scene.in) op_free(scene.in);
	if (scene.weights) op_free(scene.weights);
	free(scene.text);
	scene.in = scene.weights = NULL, scene.text = NULL;
}

// the scene into the framebuffer's strip
static void paint(void) {
	const op_value *in = scene.in;
	if (in == NULL || in->type == OP_NULL) draw_empty();
	else if (in->type == OP_STR) draw_text(in->str);
	else if (in->type == OP_NUM) draw_text(scene.text ? scene.text : (scene.text = text_of(in)));
	else if (in->type == OP_MAP && (op_get(in, "lines") || op_get(in, "pigs"))) draw_drawing(in, scene.weights);
	else if (in->type == OP_MAP && (draw_squares(in) || draw_pigs(in))) {
	} else draw_wrapped(scene.text ? scene.text : (scene.text = text_of(in)));
	// who's here, or what just happened, at the foot
	den_band();
}

static char *draw_act(void *value, void *previous, void *data) {
	(void)previous;
	drawing *d = data;
	if (d->t->stopped) return NULL;
	const op_value *in = op_get(op_get(value, "in"), "v");
	const op_value *weights = op_get(op_get(value, "pigs"), "v");
	scene_let_go();
	scene.in = in ? op_ref((op_value *)in) : NULL;
	scene.weights = weights ? op_ref((op_value *)weights) : NULL;
	frame_show(paint);
	return NULL;
}

static char *drawing_free(void *data) {
	drawing *d = data;
	scene_let_go();
	for (size_t i = 0; i < d->nin; i++) free(d->in[i]);
	free(d->in);
	free(d);
	return NULL;
}

static void make_drawing(void *data) {
	drawing *d = data;
	sc_create_effect(d->t->s, (sc_def){.f = draw_f, .effect = draw_act, .equal = draw_equal, .data = d}, NULL, 0);
}

static hf_run screen(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	op_value *nothing = op_null();
	out(t, nothing);
	reading(t, "in", give);
	drawing *d = xalloc(sizeof *d);
	d->t = t;
	for (size_t i = 0; i + 2 < t->nargs; i++) {
		if (strchr(t->args[i], '=') != NULL) continue;
		if (strcmp(t->args[i], "in") == 0) {
			d->nin = steps(t->args[i + 2], &d->in);
			break;
		}
		i += 2;
	}
	free(sc_register_teardown(t->s, t->scope, drawing_free, d));
	sc_run_with_scope(t->scope, make_drawing, d);
	return running(t);
}

// the parts (parts.h): each a thing, made only when added. what fails is said in words, as its out
// and on the screen -------------------------------------------------------------------------------

static void tick_me(thing *t, void (*tick)(thing *t, int64_t now), void (*done)(thing *t)) {
	t->tick = tick, t->done = done;
	for (int i = 0; i < PARTS; i++)
		if (ticking[i] == NULL) {
			ticking[i] = t;
			return;
		}
}

// a part that didn't start: its out the words, and the band says so
static hf_run failed(thing *t, const char *what) {
	char one[48];
	snprintf(one, sizeof one, "%s didn't start:", what);
	out(t, op_str(parts_why()));
	den_say(1, one, parts_why());
	frame_again();
	return running(t);
}

void things_tick(int64_t now) {
	parts_tick();
	for (int i = 0; i < PARTS; i++) {
		thing *t = ticking[i];
		if (t && !t->stopped && t->tick && now >= t->next) t->tick(t, now);
	}
}

// tilt: x and y, gravity's pull on each, -10 to 10 (tenths of g); given when one moves by 1 or more
// past what was given, at most twice a second (each is a step kept for good, on flash and in the
// room's log)
static void tilt_tick(thing *t, int64_t now) {
	float x, y;
	t->next = now + 100;
	if (parts_tilt_read(&x, &y)) return;
	double dx = x * 10 - t->x, dy = y * 10 - t->y;
	if ((fabs(dx) < 1 && fabs(dy) < 1 && t->n) || now - t->said < 500) return;
	t->x = round(x * 10), t->y = round(y * 10), t->said = now, t->n++;
	op_value *m = op_map();
	op_set(m, "x", op_int((int64_t)fmax(-10, fmin(10, t->x))));
	op_set(m, "y", op_int((int64_t)fmax(-10, fmin(10, t->y))));
	out(t, m);
}
static void tilt_done(thing *t) { (void)t, parts_tilt(0); }
static hf_run tilt(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	if (parts_tilt(1)) return failed(t, "tilt");
	tick_me(t, tilt_tick, tilt_done);
	return running(t);
}

// loudness: the mic's level, 0 to 10; given when it moves by 1 or more, at most twice a second
static void loud_tick(thing *t, int64_t now) {
	t->next = now + 100;
	int l = parts_loudness();
	if (l < 0) return;
	double v = l / 10.0;
	if ((fabs(v - t->x) < 1 && t->n) || now - t->said < 500) return;
	t->x = round(v), t->said = now, t->n++;
	out(t, op_int((int64_t)t->x));
}
static void loud_done(thing *t) { (void)t, parts_listen(0); }
static hf_run loudness(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	if (parts_listen(1)) return failed(t, "loudness");
	tick_me(t, loud_tick, loud_done);
	return running(t);
}

// a colour: "#rgb", "#rrggbb", a name, a number (0xrrggbb), { r, g, b } or [r, g, b]: 1 when it is one
static int colour_of(const op_value *v, uint8_t rgb[3]) {
	static const struct {
		const char *name;
		uint32_t c;
	} NAMES[] = {{"red", 0xff0000}, {"green", 0x00c000}, {"blue", 0x0040ff}, {"yellow", 0xffd000}, {"lemon", 0xfff68f},
		{"cherry", 0xd2042d}, {"pink", 0xff60a0}, {"purple", 0x9020ff}, {"orange", 0xff7000}, {"white", 0xffffff},
		{"black", 0}, {"off", 0}, {"cyan", 0x00e0ff}, {"mint", 0x60ffc0}};
	uint32_t c = 0;
	if (v->type == OP_STR && v->str[0] == '#') {
		size_t n = strlen(v->str + 1);
		char *end;
		unsigned long x = strtoul(v->str + 1, &end, 16);
		if (*end || (n != 3 && n != 6)) return 0;
		c = n == 6 ? (uint32_t)x : (uint32_t)((x >> 8 & 15) * 0x110000 + (x >> 4 & 15) * 0x1100 + (x & 15) * 0x11);
	} else if (v->type == OP_STR) {
		size_t i = 0;
		while (i < sizeof NAMES / sizeof *NAMES && strcasecmp(NAMES[i].name, v->str) != 0) i++;
		if (i == sizeof NAMES / sizeof *NAMES) return 0;
		c = NAMES[i].c;
	} else if (v->type == OP_NUM && v->num >= 0 && v->num <= 0xffffff) c = (uint32_t)v->num;
	else if (v->type == OP_MAP || (v->type == OP_LIST && v->count == 3)) {
		double p[3];
		for (int i = 0; i < 3; i++) {
			const op_value *x = v->type == OP_LIST ? v->items[i] : op_get(v, (const char *[]){"r", "g", "b"}[i]);
			if (!number(x, &p[i])) return 0;
		}
		c = (uint32_t)fmin(255, fmax(0, p[0])) << 16 | (uint32_t)fmin(255, fmax(0, p[1])) << 8 |
			(uint32_t)fmin(255, fmax(0, p[2]));
	} else return 0;
	rgb[0] = (uint8_t)(c >> 16), rgb[1] = (uint8_t)(c >> 8), rgb[2] = (uint8_t)c;
	return 1;
}

// led: shows the colour wired in (a quarter as bright: a WS2812 is very bright), gives it on as
// "#rrggbb"; anything not a colour said so
static void led_heard(thing *t, const op_value *v, int first, const char *input) {
	(void)first, (void)input;
	uint8_t c[3];
	if (!colour_of(v, c)) {
		out(t, op_str("not a colour: #rrggbb, a name, or { r, g, b }"));
		return;
	}
	parts_led_set(c[0] / 4, c[1] / 4, c[2] / 4);
	char hex[8];
	snprintf(hex, sizeof hex, "#%02x%02x%02x", c[0], c[1], c[2]);
	out(t, op_str(hex));
}
static void led_done(thing *t) { (void)t, parts_led(0); }
static hf_run led(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	if (parts_led(1)) return failed(t, "the LED");
	t->done = led_done;
	out(t, op_null());
	reading(t, "in", led_heard);
	return running(t);
}

// ir: each change wired in sent as NEC: a number (address << 8 | command, or 32 bits as sent), text
// of hex ("0x20df10ef"), or { address, command }; gives { code, n }
static void ir_heard(thing *t, const op_value *v, int first, const char *input) {
	(void)input;
	if (first) return;
	double a, c;
	uint32_t code;
	int raw = 0;
	if (number(v, &a) && a >= 0 && a <= 0xffffffff) code = (uint32_t)a, raw = a > 0xffff;
	else if (v->type == OP_STR && strtoul(v->str, NULL, 16) > 0) code = (uint32_t)strtoul(v->str, NULL, 16), raw = code > 0xffff;
	else if (number(op_get(v, "address"), &a) && number(op_get(v, "command"), &c))
		code = ((uint32_t)a & 0xff) << 8 | ((uint32_t)c & 0xff);
	else {
		out(t, op_str("not a code: a number, hex, or { address, command }"));
		return;
	}
	if (parts_ir_nec(code, raw)) {
		out(t, op_str(parts_why()));
		return;
	}
	char hex[12];
	snprintf(hex, sizeof hex, "0x%lx", (unsigned long)code);
	op_value *m = op_map();
	op_set(m, "code", op_str(hex));
	op_set(m, "n", op_int(++t->n));
	out(t, m);
}
static void ir_done(thing *t) { (void)t, parts_ir(0); }
static hf_run ir(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	if (parts_ir(1)) return failed(t, "IR");
	t->done = ir_done;
	out(t, op_null());
	reading(t, "in", ir_heard);
	return running(t);
}

// battery: how full, a percentage, now and every 30 s, given when it changes
static void battery_tick(thing *t, int64_t now) {
	t->next = now + 30000;
	int mv = parts_battery_mv();
	if (mv < 0) {
		if (strcmp(t->last, parts_why()) != 0) snprintf(t->last, sizeof t->last, "%s", parts_why()), out(t, op_str(t->last));
		return;
	}
	int l = parts_battery_level(mv);
	if (t->n && (int)t->x == l) return;
	t->x = l, t->n++;
	out(t, op_int(l));
}
static hf_run battery(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	tick_me(t, battery_tick, NULL);
	return running(t);
}

// sd: the card's top folder, its names (or words: no card), now and every 20 s when it changes
static void sd_tick(thing *t, int64_t now) {
	t->next = now + 20000;
	char names[24][13];
	int n = parts_sd_list(names, 24);
	char sum[96] = "";
	for (int i = 0; i < n; i++) {
		size_t l = strlen(sum);
		snprintf(sum + l, sizeof sum - l, "%s/", names[i]);
	}
	if (n < 0) snprintf(sum, sizeof sum, "%s", parts_why());
	if (t->n && strcmp(sum, t->last) == 0) return;
	snprintf(t->last, sizeof t->last, "%s", sum);
	t->n++;
	if (n < 0) {
		out(t, op_str(parts_why()));
		return;
	}
	op_value *l = op_list();
	for (int i = 0; i < n; i++) op_push(l, op_str(names[i]));
	out(t, l);
}
static hf_run sd(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	tick_me(t, sd_tick, NULL);
	return running(t);
}

// grove: the I2C addresses that answer on Port A ("0x3c"), now and every 5 s when they change
static void grove_tick(thing *t, int64_t now) {
	t->next = now + 5000;
	uint8_t a[32];
	int n = parts_grove_scan(a, 32);
	char sum[96] = "";
	for (int i = 0; i < n; i++) {
		size_t l = strlen(sum);
		snprintf(sum + l, sizeof sum - l, "%02x", a[i]);
	}
	if (t->n && strcmp(sum, t->last) == 0) return;
	snprintf(t->last, sizeof t->last, "%s", sum);
	t->n++;
	op_value *l = op_list();
	for (int i = 0; i < n; i++) {
		char h[8];
		snprintf(h, sizeof h, "0x%02x", a[i]);
		op_push(l, op_str(h));
	}
	out(t, l);
}
static void grove_done(thing *t) { (void)t, parts_grove(0); }
static hf_run grove(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	if (parts_grove(1)) return failed(t, "Grove");
	tick_me(t, grove_tick, grove_done);
	return running(t);
}

// speaker: the den's, on its card (/system/speaker): each change wired in played, in the voice a
// sound thing sent ({ sound }), else its own (setting sound=, else blip); gives { sound, n, heard }
// and its own voice as thing.state { sound }, as things.ts' speaker
static void speaker_heard(thing *t, const op_value *v, int first, const char *input) {
	(void)input;
	if (first) return;
	const op_value *s = op_get(v, "sound");
	const char *name = s && s->type == OP_STR ? s->str : t->last;
	int played = parts_play(name) == 0;
	if (!played) played = parts_play(t->last) == 0, name = t->last;
	op_value *m = op_map();
	op_set(m, "sound", op_str(name));
	op_set(m, "n", op_int(++t->n));
	op_set(m, "heard", op_str(played ? "played" : "silent"));
	out(t, m);
}
static hf_run speaker(const op_value *code, void *api, void *data) {
	(void)code, (void)data;
	thing *t = thing_of(api);
	const char *kept = setting(t, "sound");
	snprintf(t->last, sizeof t->last, "%s", kept ? kept : "blip");
	out(t, op_null());
	put(t, "thing.state", map_of("sound", op_str(t->last)));
	reading(t, "in", speaker_heard);
	return running(t);
}

void things_add(hf *fs) {
	hf_add_runner(fs, "speaker", speaker, NULL);
	hf_add_runner(fs, "tilt", tilt, NULL);
	hf_add_runner(fs, "loudness", loudness, NULL);
	hf_add_runner(fs, "led", led, NULL);
	hf_add_runner(fs, "ir", ir, NULL);
	hf_add_runner(fs, "battery", battery, NULL);
	hf_add_runner(fs, "sd", sd, NULL);
	hf_add_runner(fs, "grove", grove, NULL);
	hf_add_runner(fs, "keys", keys, NULL);
	hf_add_runner(fs, "screen", screen, NULL);
	hf_add_runner(fs, "pigs", pigs, NULL);
}
