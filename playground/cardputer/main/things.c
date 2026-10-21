// the things (things.h), and what the screen thing draws.
//
// the screen thing gives its "in" on as it is, and draws it on the framebuffer, the whole 240x135:
//   nothing wired in          the paper, and "wire something into its in"
//   a string or a number      big, in the middle
//   a drawing                 { lines: [[x0, y0, x1, y1, ...], ...], pigs: [{ name, x, y }, ...] }
//                             in screen pixels (0..239, 0..134): each line its points joined, a
//                             pen 2 wide; each pig stamp a pointer to a real pig, drawn at the
//                             weight this den's /work/pigs gives that name now (heavier, bigger:
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

#include "core/op/c/json.h"
#include "fb.h"

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
	// the den's, until dn_free (a table entry's id must outlive it)
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

// "/work/keys" as its steps
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

static char *let_go(void *data) {
	thing *t = data;
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
}

static thing *thing_of(void *api) {
	const dn_starting *st = api;
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
	char *pigs_at[2] = {"work", "pigs"};
	op_set(both, "pigs", out_at(d->t->places, pigs_at, 2));
	return (sc_out){.kind = SC_VALUE, .value = both};
}

static bool draw_equal(const void *a, const void *b, void *data) {
	(void)data;
	return heard_equal(op_get(a, "in"), op_get(b, "in"), NULL) &&
		heard_equal(op_get(a, "pigs"), op_get(b, "pigs"), NULL);
}

static int pig_scale(double w) {
	double k = round(1 + (w - 5) / 10);
	return k < 1 ? 1 : k > 3 ? 3 : (int)k;
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
	fb_text(4, 112, "wire into /work/screen", FB_GREY, 1);
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

void things_add(hf *fs) {
	hf_add_runner(fs, "keys", keys, NULL);
	hf_add_runner(fs, "screen", screen, NULL);
	hf_add_runner(fs, "pigs", pigs, NULL);
}
