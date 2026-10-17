// ermine-pigs: lab-pig's pigs (playground/demos/slaygrounds/examples/lab-pig) in a terminal, on the
// same nodes, the same server and the same room as the web page, so both show the same pigs and
// either picks them up. The format and the walking are program.ts's (its top says them exactly).
//   ermine-pigs [--server URL] [--service NAME] [--room ermine://...] [--offline] [--name NAME]
//               [--colour #rrggbb] [--look pixels|nethack] [--dump FILE] [--state FILE] [--log FILE]
//               [--quit-after SECONDS] [--aa N]
// --look nethack: the field as a NetHack room (hack.c says its keys); pixels, the default, as below
// keys: tab, shift-tab, arrows or hjkl choose a pig; space picks it up; arrows or hjkl carry it (shift
// or HJKL: further); space sets it down. a adds a pig, s settles nodes with several versions, q or C-c
// quits. mouse: press on a pig and drag it, let go to set it down; moving shows your pointer to the others.
// --dump: the screen as it is drawn, written to the file every second and at the end (escapes and all:
// cat it in a terminal). --state: what is shown, as JSON, four times a second (for a test). --aa: samples
// a pixel takes each way (2). PIGS_SIZE=ROWSxCOLS draws at that size whatever the terminal says; 24-bit
// colour when COLORTERM says so (or PIGS_TRUECOLOR is set), else the nearest of 256
#define _DARWIN_C_SOURCE
#include "device.h"
#include "screen.h"
#include "walk.h"

#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/json_text.h"

#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// ---- what program.ts says
static const char *FIRST = "ermine://f849ff1304dc7e0cba4d758258a6a907" "00000000000000000000000000000000";
static char ROOM[DV_ID] = "ermine://1a42463ee0b3694e305ac7dd448832e0" "00000000000000000000000000000000";
// web px: a pig's width at size 1 (its height 100/130 of it); a held pig's lift; how near the bottom
// right the bin comes out (and the top right, the corner of shame); the bin, from the bottom right
enum { W = 110, LIFT = 26, NEAR = 240 };
enum { BIN_RIGHT = 12, BIN_BOTTOM = 10, BIN_W = 54, BIN_H = 63, BIN_MARGIN = 26 };
// presence (host.ts): a row lasts TTL ms unless renewed, renewed every RENEW ms when nothing moves
enum { TTL = 6000, RENEW = 2000 };
static const char *NAMES[] = {"otter", "newt", "wren", "moth", "vole", "finch", "toad", "hare", "mole", "kiwi"};
static const char *COLOURS[] = {"#d1495b", "#2e86ab", "#3b8b5a", "#c27c0e", "#8e44ad", "#16a085", "#e4572e"};
static const double PAIR[4] = {1, 0, 0, 1};
static const double HIPS[4][2] = {{54.5, 64}, {84.5, 64}, {40.5, 64}, {99.5, 64}};
static const double LEGX[4] = {49, 79, 35, 94};

static const rgb FIELD = {0xff, 0xf8, 0xd6}, PAPER = {0xff, 0xfb, 0xe8}, INK = {0x11, 0x11, 0x11};
static const rgb WHITE = {0xff, 0xff, 0xff}, LEMON = {0xff, 0xe0, 0x66}, CHERRY = {0xd1, 0x24, 0x5b};
static const rgb SWEAT = {0x9f, 0xd3, 0xf5};

// ---- small things

static double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
static double ms_now(void) { return floor(dv_now() * 1000); }
static double mono(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}
static uint32_t rand32(void) { return arc4random(); }
// JavaScript's ToUint32 (what >>> 0 does)
static uint32_t u32(double v) {
	if (!isfinite(v)) return 0;
	double m = fmod(trunc(v), 4294967296.0);
	if (m < 0) m += 4294967296.0;
	return (uint32_t)m;
}
static bool is_pig(const char *k) {
	if (strncmp(k, "ermine://", 9) || strlen(k) != 9 + 64) return false;
	for (const char *p = k + 9; *p; p++)
		if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) return false;
	return true;
}
static bool is_map(const op_value *v) { return v && v->type == OP_MAP; }
static double num(const op_value *map, const char *key, double otherwise) {
	const op_value *v = is_map(map) ? op_get(map, key) : NULL;
	return v && v->type == OP_NUM && v->num == v->num ? v->num : otherwise;
}
static bool truth(const op_value *map, const char *key) {
	const op_value *v = is_map(map) ? op_get(map, key) : NULL;
	return v && v->type == OP_BOOL && v->bool_;
}
static const char *text(const op_value *map, const char *key) {
	const op_value *v = is_map(map) ? op_get(map, key) : NULL;
	return v && v->type == OP_STR ? v->str : NULL;
}
static rgb hex(const char *s, rgb otherwise) {
	unsigned r, g, b;
	if (s && strlen(s) == 7 && sscanf(s, "#%2x%2x%2x", &r, &g, &b) == 3) return (rgb){r, g, b};
	return otherwise;
}
static rgb hsl(double h, double s, double l) {
	h = fmod(h, 360) / 360, s /= 100, l /= 100;
	double q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
	double t[3] = {h + 1.0 / 3, h, h - 1.0 / 3}, c[3];
	for (int i = 0; i < 3; i++) {
		double x = t[i] < 0 ? t[i] + 1 : t[i] > 1 ? t[i] - 1 : t[i];
		c[i] = x < 1.0 / 6 ? p + (q - p) * 6 * x : x < 0.5 ? q : x < 2.0 / 3 ? p + (q - p) * (2.0 / 3 - x) * 6 : p;
	}
	return (rgb){(uint8_t)lround(c[0] * 255), (uint8_t)lround(c[1] * 255), (uint8_t)lround(c[2] * 255)};
}
static rgb mix(rgb a, rgb b, double t) {
	return (rgb){(uint8_t)lround(a.r + (b.r - a.r) * t), (uint8_t)lround(a.g + (b.g - a.g) * t),
		(uint8_t)lround(a.b + (b.b - a.b) * t)};
}
// approach target, as a CSS transition of about ms would
static double ease(double v, double target, double dt, double ms) { return v + (target - v) * (1 - exp(-dt / (ms / 3))); }

static FILE *logf_;
static void say(const char *f, ...) {
	if (!logf_) return;
	va_list a;
	va_start(a, f);
	fprintf(logf_, "%.3f ", dv_now());
	vfprintf(logf_, f, a);
	fputc('\n', logf_);
	fflush(logf_);
	va_end(a);
}

// ---- affine maps: x' = a x + c y + e, y' = b x + d y + f
typedef struct {
	double a, b, c, d, e, f;
} mat;
static mat mul(mat m, mat n) {
	return (mat){m.a * n.a + m.c * n.b, m.b * n.a + m.d * n.b, m.a * n.c + m.c * n.d, m.b * n.c + m.d * n.d,
		m.a * n.e + m.c * n.f + m.e, m.b * n.e + m.d * n.f + m.f};
}
static mat tr(double x, double y) { return (mat){1, 0, 0, 1, x, y}; }
static mat sc(double x, double y) { return (mat){x, 0, 0, y, 0, 0}; }
static mat ro(double deg) {
	double r = deg * M_PI / 180, c = cos(r), s = sin(r);
	return (mat){c, s, -s, c, 0, 0};
}
static mat about(double x, double y, mat m) { return mul(tr(x, y), mul(m, tr(-x, -y))); }
static mat inv(mat m) {
	double det = m.a * m.d - m.b * m.c;
	if (fabs(det) < 1e-12) return (mat){0, 0, 0, 0, 1e9, 1e9};
	mat r = {m.d / det, -m.b / det, -m.c / det, m.a / det, 0, 0};
	r.e = -(r.a * m.e + r.c * m.f), r.f = -(r.b * m.e + r.d * m.f);
	return r;
}
static void ap(mat m, double x, double y, double *ox, double *oy) {
	*ox = m.a * x + m.c * y + m.e, *oy = m.b * x + m.d * y + m.f;
}

// ---- shapes, as distances (negative inside)
static double sd_circle(double x, double y, double cx, double cy, double r) { return hypot(x - cx, y - cy) - r; }
static double sd_ellipse(double x, double y, double cx, double cy, double a, double b) {
	x = (x - cx), y = (y - cy);
	double k0 = hypot(x / a, y / b), k1 = hypot(x / (a * a), y / (b * b));
	return k1 < 1e-9 ? -fmin(a, b) : k0 * (k0 - 1) / k1;
}
static double sd_roundrect(double x, double y, double rx, double ry, double w, double h, double r) {
	double qx = fabs(x - (rx + w / 2)) - (w / 2 - r), qy = fabs(y - (ry + h / 2)) - (h / 2 - r);
	return hypot(fmax(qx, 0), fmax(qy, 0)) + fmin(fmax(qx, qy), 0) - r;
}
static double seg(double x, double y, double ax, double ay, double bx, double by) {
	double dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
	double t = l > 0 ? clampd(((x - ax) * dx + (y - ay) * dy) / l, 0, 1) : 0;
	return hypot(x - (ax + t * dx), y - (ay + t * dy));
}
static double sd_polygon(double x, double y, const double (*p)[2], int n) {
	double d = 1e9;
	bool in = false;
	for (int i = 0, j = n - 1; i < n; j = i++) {
		d = fmin(d, seg(x, y, p[j][0], p[j][1], p[i][0], p[i][1]));
		if ((p[i][1] > y) != (p[j][1] > y) && x < (p[j][0] - p[i][0]) * (y - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])
			in = !in;
	}
	return in ? -d : d;
}
// a polyline's points, from a path's curves
typedef struct {
	double p[40][2];
	int n;
	double x0, y0, x1, y1;
} line_t;
static void line_add(line_t *l, double x, double y) {
	l->p[l->n][0] = x, l->p[l->n][1] = y, l->n++;
	if (l->n == 1) l->x0 = l->x1 = x, l->y0 = l->y1 = y;
	l->x0 = fmin(l->x0, x), l->x1 = fmax(l->x1, x), l->y0 = fmin(l->y0, y), l->y1 = fmax(l->y1, y);
}
static void cubic(line_t *l, const double c[4][2], int steps) {
	if (!l->n) line_add(l, c[0][0], c[0][1]);
	for (int i = 1; i <= steps; i++) {
		double t = (double)i / steps, u = 1 - t;
		double a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
		line_add(l, a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]);
	}
}
static void quad(line_t *l, double x0, double y0, double x1, double y1, double x2, double y2, int steps) {
	if (!l->n) line_add(l, x0, y0);
	for (int i = 1; i <= steps; i++) {
		double t = (double)i / steps, u = 1 - t;
		line_add(l, u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
	}
}
static double d_line(const line_t *l, double x, double y, double half) {
	if (x < l->x0 - half || x > l->x1 + half || y < l->y0 - half || y > l->y1 + half) return 1e9;
	double d = 1e9;
	for (int i = 1; i < l->n; i++) d = fmin(d, seg(x, y, l->p[i - 1][0], l->p[i - 1][1], l->p[i][0], l->p[i][1]));
	return d;
}
static line_t TAIL, SHUT[2], MOUTH, FROWN, HANDLE;
static const double EAR_L[3][2] = {{21, 32}, {15, 11}, {32, 24}}, EAR_R[3][2] = {{40, 24}, {56, 11}, {51, 32}};
static const double BIN_BODY[6][2] = {{10, 22}, {14, 64}, {17, 67}, {43, 67}, {46, 64}, {50, 22}};
static void shapes(void) {
	const double c1[4][2] = {{105, 50}, {113, 47}, {120, 44}, {119, 37}};
	const double c2[4][2] = {{119, 37}, {118, 31}, {110, 32}, {112, 38}};
	const double c3[4][2] = {{112, 38}, {114, 43}, {121, 43}, {125, 38}};
	cubic(&TAIL, c1, 8), cubic(&TAIL, c2, 8), cubic(&TAIL, c3, 8);
	quad(&SHUT[0], 27, 37, 31, 40, 35, 37, 5);
	quad(&SHUT[1], 43, 37, 47, 40, 51, 37, 5);
	quad(&MOUTH, 28, 61, 33, 64.5, 38, 61, 5);
	quad(&FROWN, 29, 58, 33.5, 54.5, 38, 58, 5);
	quad(&HANDLE, 23, 13, 23, 7, 30, 7, 4);
	quad(&HANDLE, 30, 7, 37, 7, 37, 13, 4);
}

// ---- a pig

typedef struct {
	char id[DV_ID];
	double size;
	rgb skin, deep, snout;
	// what its node says: nothing yet (known false), resting or held
	bool known, held, shame, binned;
	double x, y, at;
	uint32_t seed;
	char by[64], who[65];
	rgb colour;
	pig_path path;
	// drawn: where (fractions), facing, how it hangs, its transitions
	double gx, gy;
	bool right, was;
	double since, sx, vx, swing, spin;
	double lift, face, shamed, gone, binned_at;
	double phase, stride;
	// the last frame's: where, and how much of each pixel is pig (for the mouse)
	int bx, by_, bw, bh;
	uint8_t *mask;
	bool drawn;
} pig;

static pig *pigs;
static size_t npigs;

static pig *pig_find(const char *id) {
	for (size_t i = 0; i < npigs; i++)
		if (!strcmp(pigs[i].id, id)) return &pigs[i];
	return NULL;
}

static pig *pig_add(dv *d, const char *id) {
	pig *had = pig_find(id);
	if (had) return had;
	pigs = realloc(pigs, (npigs + 1) * sizeof *pigs);
	if (!pigs) abort();
	pig *p = &pigs[npigs++];
	memset(p, 0, sizeof *p);
	snprintf(p->id, DV_ID, "%s", id);
	pig_random n = pig_random_of(pig_hash(id));
	p->size = 0.86 + 0.24 * pig_draw(&n);
	pig_random t = pig_random_of(pig_hash(id) ^ 0x9e3779b9u);
	double hue = 333 + 20 * pig_draw(&t), light = 81 + 6 * pig_draw(&t);
	p->skin = hsl(hue, 80, light), p->deep = hsl(hue, 76, light - 6), p->snout = hsl(hue - 2, 80, light - 7);
	p->face = 1, p->gx = 0.5, p->gy = 0.5;
	dv_follow(d, id);
	return p;
}

// ---- the world here

typedef struct {
	char who[65], name[64];
	rgb colour;
	bool pointer;
	double x, y, until;
	// its row says it is stuck in the corner of shame
	bool stuck;
	// its arrival told
	bool told;
} row_t;

static struct {
	dv *d;
	bool server;
	screen s;
	char name[64], colour_text[8], me[65];
	rgb colour;
	bool online;
	// the field, in terminal pixels (a cell is two, one above the other): px a web px is
	int fw, fh;
	double k;
	rgb *fb;
	// held here: which pig (by id), by the mouse or the keys, where on the pig it was taken
	char holding[DV_ID];
	bool by_mouse;
	double offx, offy;
	char selected[DV_ID];
	// a wave to send this frame; my pointer, and whether it moved since it was sent
	bool wave_due;
	bool pointer;
	double px, py, beat;
	bool pointer_due;
	// the bin: out (0 to 1), open, gulping until; the room's store after a binning
	double bin, bin_open, gulp_until;
	// the corner of shame: open (some pig in the room was last stored ashamed), shown (0 to 1)
	bool open;
	double corner;
	char bin_later[DV_ID];
	double bin_later_at;
	double mend_at;
	// the pig added here last (not told as wandering in); since when online
	char added[DV_ID];
	double online_at;
	row_t *rows;
	size_t nrows;
	int conflicts;
	char note[160];
	double note_until;
} w;

static volatile sig_atomic_t quit, resized = 1;
static void on_quit(int s) { (void)s, quit = 1; }
static void on_winch(int s) { (void)s, resized = 1; }

// which look: the pixels (pigs drawn in half-block pixels), or NetHack's (hack.c); NetHack's: stuck in
// the corner of shame (its presence row says so)
static bool hack_look, hack_stuck;

// what happened, as NetHack's message line says it (the nethack look shows the last of them)
typedef struct {
	char text[200];
	double at;
} said_t;
static said_t said[8];
static int nsaid;
static void tell(const char *f, ...) {
	if (nsaid == 8) memmove(said, said + 1, 7 * sizeof *said), nsaid--;
	va_list a;
	va_start(a, f);
	vsnprintf(said[nsaid].text, sizeof said[nsaid].text, f, a);
	va_end(a);
	said[nsaid].at = mono();
	say("tell %s", said[nsaid++].text);
}
// a pig's short name, as the messages and the status line say it
static const char *pig_name(const char *id) {
	static char out[4][16];
	static int at;
	at = (at + 1) % 4;
	snprintf(out[at], sizeof out[at], "pig-%.8s", strlen(id) > 9 ? id + 9 : id);
	return out[at];
}

static void set_note(const char *f, ...) {
	va_list a;
	va_start(a, f);
	vsnprintf(w.note, sizeof w.note, f, a);
	va_end(a);
	w.note_until = mono() + 4000;
}

// ---- the room

static const op_value *room_value(void) { return dv_value(w.d, "value", ROOM); }
static bool in_room(const op_value *v, const char *id) {
	if (!is_map(v)) return !strcmp(id, FIRST);
	const op_value *x = op_get(v, id);
	if (!strcmp(id, FIRST)) return !(x && x->type == OP_BOOL && !x->bool_);
	return x && x->type == OP_BOOL && x->bool_;
}

// a copy of the room's value, with id set to b (id NULL: none)
static op_value *room_with(const char *id, bool b) {
	const op_value *v = room_value();
	op_value *m = op_map();
	for (size_t i = 0; is_map(v) && i < v->count; i++)
		if (!id || strcmp(v->keys[i], id)) op_set(m, v->keys[i], op_ref(v->items[i]));
	if (id) op_set(m, id, op_bool(b));
	return m;
}

// the pigs here, as the room says: new ones followed, gone ones let go of
static void room_read(void) {
	const op_value *v = room_value();
	dv_follow(w.d, FIRST);
	if (in_room(v, FIRST)) pig_add(w.d, FIRST);
	for (size_t i = 0; is_map(v) && i < v->count; i++) {
		if (!is_pig(v->keys[i]) || !in_room(v, v->keys[i])) continue;
		bool new = !pig_find(v->keys[i]);
		pig_add(w.d, v->keys[i]);
		if (new && w.online_at && mono() - w.online_at > 4000 && strcmp(w.added, v->keys[i])) tell("A pig wanders in.");
	}
	for (size_t i = 0; i < npigs;) {
		if (in_room(v, pigs[i].id)) {
			i++;
			continue;
		}
		if (!strcmp(w.holding, pigs[i].id)) w.holding[0] = 0;
		if (!strcmp(w.selected, pigs[i].id)) w.selected[0] = 0;
		free(pigs[i].mask);
		pigs[i] = pigs[--npigs];
	}
}

// the room's other versions: a pig added in one put back, a pig binned in one stays binned
static op_value *mended(void) {
	const op_value *cs = dv_value(w.d, "conflicts", ROOM);
	if (!cs || cs->type != OP_LIST || !cs->count) return NULL;
	op_value *all = room_with(NULL, false);
	bool changed = false;
	for (size_t i = 0; i < cs->count; i++) {
		const op_value *tables = op_get(cs->items[i], "tables");
		const op_value *v = is_map(tables) ? op_get(tables, "value") : NULL;
		for (size_t k = 0; is_map(v) && k < v->count; k++) {
			const char *key = v->keys[k];
			if (!is_pig(key)) continue;
			const op_value *had = op_get(all, key), *their = v->items[k];
			bool next = !((had && had->type == OP_BOOL && !had->bool_) || (their->type == OP_BOOL && !their->bool_));
			if (!had || had->type != OP_BOOL || had->bool_ != next) op_set(all, key, op_bool(next)), changed = true;
		}
	}
	if (!changed) op_free(all), all = NULL;
	return all;
}

static void mend(void) {
	op_value *all = mended();
	if (!all) return;
	if (!w.mend_at) {
		// a while first, at random, so two devices rarely both mend at once
		w.mend_at = mono() + 300 + (rand32() % 1500);
		op_free(all);
		return;
	}
	if (mono() < w.mend_at) {
		op_free(all);
		return;
	}
	w.mend_at = 0;
	dv_store(w.d, ROOM, all);
	dv_settle(w.d, ROOM);
	say("mend room");
}

static void count_conflicts(void) {
	int n = 0;
	const op_value *c = dv_value(w.d, "conflicts", ROOM);
	if (c && c->type == OP_LIST && c->count) n++;
	for (size_t i = 0; i < npigs; i++) {
		c = dv_value(w.d, "conflicts", pigs[i].id);
		if (c && c->type == OP_LIST && c->count) n++;
	}
	w.conflicts = n;
}

static void settle_all(void) {
	const op_value *c = dv_value(w.d, "conflicts", ROOM);
	if (c && c->type == OP_LIST && c->count) dv_settle(w.d, ROOM);
	for (size_t i = 0; i < npigs; i++) {
		c = dv_value(w.d, "conflicts", pigs[i].id);
		if (c && c->type == OP_LIST && c->count) dv_settle(w.d, pigs[i].id);
	}
}

// ---- what a pig's node says (note, in program.ts)
static void pig_read(pig *p, double now) {
	const op_value *v = dv_value(w.d, "value", p->id);
	if (!is_map(v)) return;
	double x = clampd(num(v, "x", 0.5), 0, 1), y = clampd(num(v, "y", 0.5), 0, 1);
	if (truth(v, "held") || text(v, "by")) {
		if (!p->held) say("held %s by %s", p->id, text(v, "by") ? text(v, "by") : "?");
		const char *whose = text(v, "who");
		if (p->known && !p->held && !(whose && !strcmp(whose, w.me)))
			tell("%s picks up a pig (%s).", text(v, "by") ? text(v, "by") : "Someone", pig_name(p->id));
		p->known = true, p->held = true, p->x = x, p->y = y;
		const char *by = text(v, "by"), *who = text(v, "who");
		snprintf(p->by, sizeof p->by, "%s", by ? by : "someone");
		snprintf(p->who, sizeof p->who, "%s", who ? who : "");
		p->colour = hex(text(v, "colour"), (rgb){0x88, 0x88, 0x88});
		// ashamed as it was last stored: the stored value under the carry (sync's "ephemeral" table)
		const op_value *e = dv_value(w.d, "ephemeral", p->id), *under = is_map(e) ? op_get(e, "under") : NULL;
		const op_value *stored = is_map(under) ? op_get(under, "value") : NULL;
		if (is_map(stored)) p->shame = truth(stored, "shame");
		return;
	}
	double at = num(v, "at", 0);
	if (p->held || !p->known)
		say("rests %s at %.4f %.4f, %.0f, seed %.0f%s%s", p->id, x, y, at, num(v, "seed", -1), truth(v, "shame") ? ", shame" : "",
			truth(v, "binned") ? ", binned" : "");
	uint32_t seed = u32(num(v, "seed", pig_hash(p->id)));
	bool binned = truth(v, "binned");
	if (!p->known || p->held || p->x != x || p->y != y || p->at != at || p->seed != seed)
		p->path = pig_path_of(x, y, seed);
	// someone binned it: the bin comes out here too
	if (binned && !(p->known && !p->held && p->binned) && strcmp(w.holding, p->id)) w.gulp_until = now + 900;
	if (binned && !p->binned) p->binned_at = now;
	// what someone else did, told (what this device did is told where it does it)
	bool others = p->known && strcmp(p->who, w.me) && strcmp(w.holding, p->id);
	const char *by = p->held && p->by[0] ? p->by : "Someone";
	if (others && binned && !p->binned) tell("%s drops a pig into the bin. You hear a gulp.", by);
	else if (others && truth(v, "shame") && (p->held || !p->shame)) tell("%s puts a pig in the corner. The pig looks ashamed.", by);
	else if (others && p->held) tell("%s puts a pig down.", by);
	if (!p->held) p->who[0] = 0;
	p->known = true, p->held = false, p->x = x, p->y = y, p->at = at, p->seed = seed;
	p->shame = truth(v, "shame"), p->binned = binned;
}

// ---- the field's geometry, in terminal pixels

// a pig's width and height (px of the web, times k: terminal pixels)
static double pig_w(const pig *p) { return W * p->size; }
static double pig_h(const pig *p) { return pig_w(p) * 100 / 130; }
// a page's field, about (px): the bin's nearness, and the corner's, are fractions of it here
enum { PAGE_W = 1400, PAGE_H = 630 };
static bool in_shame(double gx, double gy) { return gx > PIG_SHAME_X && gy < PIG_SHAME_Y; }
static void bin_rect(double *x0, double *y0, double *x1, double *y1) {
	// NetHack's: in field units, as a page's bin is in its field (w.fw and w.fh are 1 then)
	if (hack_look) {
		*x1 = 1 - (double)BIN_RIGHT / PAGE_W, *x0 = *x1 - (double)BIN_W / PAGE_W;
		*y1 = 1 - (double)BIN_BOTTOM / PAGE_H, *y0 = *y1 - (double)BIN_H / PAGE_H;
		return;
	}
	*x1 = w.fw - BIN_RIGHT * w.k, *x0 = *x1 - BIN_W * w.k;
	*y1 = w.fh - BIN_BOTTOM * w.k, *y0 = *y1 - BIN_H * w.k;
}
static bool over_bin(double fx, double fy) {
	double x0, y0, x1, y1, m = BIN_MARGIN * w.k, x = fx * w.fw, y = fy * w.fh;
	bin_rect(&x0, &y0, &x1, &y1);
	if (hack_look) return x > x0 - (double)BIN_MARGIN / PAGE_W && y > y0 - (double)BIN_MARGIN / PAGE_H;
	return x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m;
}
static bool near_shame(double fx, double fy) { return hypot((1 - fx) * PAGE_W, fy * PAGE_H) < NEAR; }
static bool near_bin(double fx, double fy) {
	return hypot((1 - fx) * PAGE_W, (1 - fy) * PAGE_H) < NEAR;
}

// ---- presence: my row, over the device's channel on the room's topic (presence.ts's messages)

static void presence_send(bool gone) {
	char buf[512];
	if (gone) snprintf(buf, sizeof buf, "{\"gone\":true}");
	else if (w.pointer)
		snprintf(buf, sizeof buf, "{\"ttl\":%d,\"value\":{\"name\":\"%s\",\"colour\":\"%s\",\"look\":\"%s\",%s\"pointer\":{\"x\":%.5f,\"y\":%.5f}}}",
			TTL, w.name, w.colour_text, hack_look ? "nethack" : "pixels", hack_stuck ? "\"stuck\":true," : "", w.px, w.py);
	else
		snprintf(buf, sizeof buf, "{\"ttl\":%d,\"value\":{\"name\":\"%s\",\"colour\":\"%s\",\"look\":\"%s\"}}", TTL, w.name, w.colour_text,
			hack_look ? "nethack" : "pixels");
	dv_send(w.d, ROOM, (const uint8_t *)buf, strlen(buf));
	w.beat = mono(), w.pointer_due = false;
}

static void heard(void *context, const char *from, const uint8_t *bytes, size_t n) {
	(void)context;
	say("heard %.16s %.*s", from ? from : "?", (int)(n > 200 ? 200 : n), (const char *)bytes);
	char *why = NULL;
	Json *m = jsonParse((const char *)bytes, n, &why);
	free(why);
	if (!m || !jsonIsObject(m) || !from || strlen(from) > 64) {
		jsonFree(m);
		return;
	}
	size_t at = w.nrows;
	for (size_t i = 0; i < w.nrows; i++)
		if (!strcmp(w.rows[i].who, from)) at = i;
	Json *gone = jsonGet(m, "gone");
	if (gone) {
		if (at < w.nrows) tell("%s leaves.", w.rows[at].name), w.rows[at] = w.rows[--w.nrows];
		jsonFree(m);
		return;
	}
	if (at == w.nrows) {
		w.rows = realloc(w.rows, (w.nrows + 1) * sizeof *w.rows);
		if (!w.rows) abort();
		memset(&w.rows[at], 0, sizeof *w.rows);
		snprintf(w.rows[at].who, sizeof w.rows[at].who, "%s", from);
		w.nrows++;
	}
	row_t *r = &w.rows[at];
	Json *ttl = jsonGet(m, "ttl"), *v = jsonGet(m, "value");
	r->until = mono() + (ttl && jsonIsNumber(ttl) ? ttl->number : 0);
	const char *name = jsonText(jsonGet(v, "name")), *colour = jsonText(jsonGet(v, "colour"));
	snprintf(r->name, sizeof r->name, "%s", name ? name : "");
	if (!name) snprintf(r->name, sizeof r->name, "%.8s", from);
	r->colour = hex(colour, (rgb){0x88, 0x88, 0x88});
	if (!r->told) tell("%s arrives.", r->name), r->told = true;
	Json *stuck = jsonGet(v, "stuck");
	bool is_stuck = stuck && stuck->type == JSON_BOOLEAN && stuck->boolean;
	if (is_stuck && !r->stuck) tell("%s is stuck in the corner of shame.", r->name);
	if (!is_stuck && r->stuck) tell("%s is pulled out of the corner of shame.", r->name);
	r->stuck = is_stuck;
	Json *p = jsonGet(v, "pointer");
	r->pointer = p && jsonIsObject(p);
	if (r->pointer) {
		Json *x = jsonGet(p, "x"), *y = jsonGet(p, "y");
		r->x = clampd(x && jsonIsNumber(x) ? x->number : 0.5, 0, 1);
		r->y = clampd(y && jsonIsNumber(y) ? y->number : 0.5, 0, 1);
	}
	jsonFree(m);
}

static void sweep(void) {
	double now = mono();
	for (size_t i = 0; i < w.nrows;)
		if (w.rows[i].until <= now) tell("%s leaves.", w.rows[i].name), w.rows[i] = w.rows[--w.nrows];
		else i++;
}

static void pointer_at(double x, double y) {
	if (w.pointer && w.px == x && w.py == y) return;
	w.pointer = true, w.px = x, w.py = y, w.pointer_due = true;
}

// ---- picked up, carried, set down

static void wave_value(pig *p) {
	op_value *v = op_map();
	op_set(v, "x", op_num(p->gx));
	op_set(v, "y", op_num(p->gy));
	op_set(v, "held", op_bool(1));
	op_set(v, "by", op_str(w.name));
	op_set(v, "colour", op_str(w.colour_text));
	op_set(v, "who", op_str(w.me));
	dv_wave(w.d, p->id, v);
}

static void carry_to(pig *p, double x, double y) {
	// a lifted pig kept inside the field (NetHack's is not lifted)
	double top = hack_look ? 0.01 : (0.9 * pig_h(p) + LIFT + 4) * w.k / w.fh;
	p->gx = clampd(x, 0.03, 0.97), p->gy = clampd(y, top, 1);
	w.wave_due = true;
}

static void grab(pig *p, bool mouse, double px, double py) {
	if (w.holding[0] || !p->known) return;
	snprintf(w.holding, DV_ID, "%s", p->id);
	snprintf(w.selected, DV_ID, "%s", p->id);
	w.by_mouse = mouse;
	w.offx = mouse ? p->gx - px : 0, w.offy = mouse ? p->gy - py : 0;
	carry_to(p, p->gx, p->gy);
	if (!mouse) pointer_at(p->gx, p->gy);
	say("grab %s", p->id);
	tell("You pick up the pig (%s).", pig_name(p->id));
}

static void drop(void) {
	pig *p = pig_find(w.holding);
	w.holding[0] = 0;
	if (!p) return;
	w.wave_due = false;
	// where it was let go: the pointer, or the pig itself when carried by the keys
	double hx = w.by_mouse && w.pointer ? w.px : p->gx, hy = w.by_mouse && w.pointer ? w.py : p->gy;
	bool binned = over_bin(hx, hy);
	op_value *v = op_map();
	if (binned) {
		double x0, y0, x1, y1;
		bin_rect(&x0, &y0, &x1, &y1);
		p->gx = (x0 + x1) / 2 / w.fw, p->gy = (y0 + (y1 - y0) * 0.4) / w.fh;
	}
	op_set(v, "x", op_num(p->gx));
	op_set(v, "y", op_num(p->gy));
	op_set(v, "at", op_num(ms_now()));
	op_set(v, "seed", op_num(rand32()));
	if (binned) {
		op_set(v, "binned", op_bool(1));
		w.gulp_until = mono() + 900;
		// the room's false for it a moment later, as the page does
		snprintf(w.bin_later, DV_ID, "%s", p->id);
		w.bin_later_at = mono() + 420;
	} else if (in_shame(p->gx, p->gy)) op_set(v, "shame", op_bool(1));
	dv_store(w.d, p->id, v);
	say("drop %s at %.3f %.3f%s", p->id, p->gx, p->gy, binned ? " binned" : "");
	if (binned) tell("You drop the pig into the bin. You hear a gulp.");
	else if (in_shame(p->gx, p->gy)) tell("You put the pig in the corner. The pig looks ashamed.");
	else tell("You put the pig down.");
}

static void add_pig(void) {
	char id[DV_ID];
	dv_mint(w.d, id);
	pig_random r = pig_random_of(rand32());
	op_value *v = op_map();
	op_set(v, "x", op_num(0.15 + 0.7 * pig_draw(&r)));
	op_set(v, "y", op_num(0.3 + 0.6 * pig_draw(&r)));
	op_set(v, "at", op_num(ms_now()));
	op_set(v, "seed", op_num(floor(pig_draw(&r) * 4294967296.0)));
	dv_store(w.d, id, v);
	dv_store(w.d, ROOM, room_with(id, true));
	snprintf(w.selected, DV_ID, "%s", id);
	say("add %s", id);
	tell("You hear a pig grunt.");
	snprintf(w.added, DV_ID, "%s", id);
	set_note("a pig added");
}

// ---- choosing a pig with the keys

static bool shown(const pig *p) { return p->known && !(p->binned && !p->held) && in_room(room_value(), p->id); }

static void tab(int way) {
	// in order across the field
	pig *order[256];
	size_t n = 0;
	for (size_t i = 0; i < npigs && n < 256; i++)
		if (shown(&pigs[i])) order[n++] = &pigs[i];
	if (!n) return;
	for (size_t i = 1; i < n; i++)
		for (size_t j = i; j > 0 && order[j]->gx < order[j - 1]->gx; j--) {
			pig *t = order[j];
			order[j] = order[j - 1], order[j - 1] = t;
		}
	size_t at = 0;
	bool had = false;
	for (size_t i = 0; i < n; i++)
		if (!strcmp(order[i]->id, w.selected)) at = i, had = true;
	at = !had ? (way > 0 ? 0 : n - 1) : (at + n + (size_t)(way > 0 ? 1 : n - 1)) % n;
	snprintf(w.selected, DV_ID, "%s", order[at]->id);
}

static void look(double dx, double dy) {
	pig *from = pig_find(w.selected);
	if (!from || !shown(from)) {
		tab(1);
		return;
	}
	pig *best = NULL;
	double score = 1e18;
	for (size_t i = 0; i < npigs; i++) {
		pig *p = &pigs[i];
		if (p == from || !shown(p)) continue;
		double x = (p->gx - from->gx) * w.fw, y = (p->gy - from->gy) * w.fh;
		double along = x * dx + y * dy, across = fabs(x * dy - y * dx);
		if (along <= 0) continue;
		double s = along + 2 * across;
		if (s < score) score = s, best = p;
	}
	if (best) snprintf(w.selected, DV_ID, "%s", best->id);
}

static void arrow(double dx, double dy, bool far) {
	pig *p = pig_find(w.holding);
	if (!p) {
		look(dx, dy);
		return;
	}
	double step = far ? 4 : 1;
	carry_to(p, p->gx + dx * step * 2 / w.fw, p->gy + dy * step * 2 / w.fh);
	pointer_at(p->gx, p->gy);
}

// ---- the mouse

static double field_x(int col) { return (col + 0.5) / w.s.cols; }
static double field_y(int row) { return clampd((row - 1 + 0.5) / (w.s.rows - 1), 0, 1); }

// the pig under a cell, the one in front
static pig *hit(int col, int row) {
	int x = col, y0 = (row - 1) * 2;
	pig *best = NULL;
	int z = -1;
	for (size_t i = 0; i < npigs; i++) {
		pig *p = &pigs[i];
		if (!p->drawn || !p->mask) continue;
		for (int y = y0; y < y0 + 2; y++) {
			int lx = x - p->bx, ly = y - p->by_;
			if (lx < 0 || ly < 0 || lx >= p->bw || ly >= p->bh) continue;
			if (p->mask[ly * p->bw + lx] < 80) continue;
			int pz = (int)lround(p->gy * 1000) + (p->held || !strcmp(w.holding, p->id) ? 8000 : 0);
			if (pz > z) z = pz, best = p;
		}
	}
	return best;
}

static void mouse(const key *k) {
	if (k->wheel || k->row < 1) return;
	double x = field_x(k->col), y = field_y(k->row);
	pig *held = pig_find(w.holding);
	if (k->press && !k->motion && k->button == 0) {
		pig *p = hit(k->col, k->row);
		pointer_at(x, y);
		if (held) return;
		if (p) grab(p, true, x, y);
		else w.selected[0] = 0;
		return;
	}
	if (!k->press && held && w.by_mouse) {
		pointer_at(x, y);
		carry_to(held, x + w.offx, y + w.offy);
		drop();
		return;
	}
	if (k->motion) {
		pointer_at(x, y);
		if (held && w.by_mouse) carry_to(held, x + w.offx, y + w.offy);
	}
}

// ---- drawing: the field in terminal pixels, then cells of two pixels each (▀: top fg, bottom bg)

static void blend(int x, int y, rgb c, double a) {
	if (x < 0 || y < 0 || x >= w.fw || y >= w.fh || a <= 0) return;
	rgb *at = &w.fb[y * w.fw + x];
	*at = mix(*at, c, a > 1 ? 1 : a);
}

// a pig's pose for a frame: what is drawn where, in the svg's own units (viewBox 0 0 130 100)
typedef struct {
	const pig *p;
	mat leg[4], tail, head, earl, earr;
	bool shut, sweat;
	// an eye's radius, a pixel across at least
	double eye;
} pose;

// the pig's colour at a point of its svg, front first; false: nothing there
static bool pig_at(const pose *q, double x, double y, rgb *out) {
	const pig *p = q->p;
	double sx, sy;
	if (q->sweat && x > 54 && x < 66 && y > 10 && y < 27) {
		double d = sd_ellipse(x, y, 60, 19.5, 3.4, 4.6);
		if (d < 1) return *out = d < -1 ? SWEAT : INK, true;
	}
	// the head: its parts, front first
	ap(q->head, x, y, &sx, &sy);
	if (sx > 0 && sx < 72 && sy > 4 && sy < 72) {
		if (d_line(q->shut ? &FROWN : &MOUTH, sx, sy, 1.25) < 1.25) return *out = INK, true;
		if (q->shut) {
			if (d_line(&SHUT[0], sx, sy, 1.25) < 1.25 || d_line(&SHUT[1], sx, sy, 1.25) < 1.25) return *out = INK, true;
		} else if (sd_circle(sx, sy, 31, 35, q->eye) < 0 || sd_circle(sx, sy, 47, 35, q->eye) < 0) return *out = INK, true;
		if (sd_circle(sx, sy, 15, 50, 2.2) < 0 || sd_circle(sx, sy, 23, 50, 2.2) < 0) return *out = INK, true;
		double d = sd_ellipse(sx, sy, 19, 50, 11, 9);
		if (d < 1.5) return *out = p->snout, true;
		d = sd_circle(sx, sy, 36, 44, 22);
		if (d < 1.5) return *out = p->skin, true;
		double ex, ey;
		ap(q->earr, sx, sy, &ex, &ey);
		d = sd_polygon(ex, ey, EAR_R, 3);
		if (d < 1.5) return *out = p->deep, true;
		ap(q->earl, sx, sy, &ex, &ey);
		d = sd_polygon(ex, ey, EAR_L, 3);
		if (d < 1.5) return *out = p->deep, true;
	}
	double d = sd_ellipse(x, y, 72, 56, 40, 26);
	if (d < 1.5) return *out = p->skin, true;
	ap(q->tail, x, y, &sx, &sy);
	if (d_line(&TAIL, sx, sy, 3) < 3) return *out = p->deep, true;
	for (int i = 3; i >= 0; i--) {
		ap(q->leg[i], x, y, &sx, &sy);
		d = sd_roundrect(sx, sy, LEGX[i], 60, 11, 34, 4);
		if (d < 1.5) return *out = (i < 2 ? p->deep : p->skin), true;
	}
	return false;
}

// how many samples a pixel takes, each way
static int AA = 2;

// the pig drawn into the field, its mask kept; outline: the chosen one's ring
static void pig_draw_into(pig *p, double now, double clock, double dt, bool outline) {
	bool mine = !strcmp(w.holding, p->id), held = mine || p->held;
	bool shame = !held && p->shame, binned = !held && p->binned;
	if (held && !p->was) p->since = now;
	p->was = held;
	double phase = 0, stride = 0;
	if (mine) { /* where the pointer or the keys put it */
	} else if (p->held || p->shame || p->binned) p->gx = p->x, p->gy = p->y;
	else {
		pig_walked m = pig_walk(&p->path, p->at, clock, w.open);
		p->gx = m.x, p->gy = m.y, phase = m.phase, stride = m.stride;
		if (fabs(m.vx) > 0.003) p->right = m.vx > 0;
	}
	if (shame) p->right = true;
	// gone into the bin: smaller, fading, over .4s
	double gone = binned ? clampd((now - p->binned_at) / 400, 0, 1) : 0;
	if (binned && gone >= 1) {
		p->drawn = false;
		return;
	}
	// drawn whole inside the field (where it is stays as it is)
	double half = (pig_w(p) / 2 + 2) * w.k;
	double fx = clampd(p->gx * w.fw, half, w.fw - half), fy = p->gy * w.fh;
	// how fast it moves across the screen, in web px a 60th of a second, smoothed
	double moved = dt > 0 ? (fx - p->sx) / w.k * (16.7 / dt) : 0;
	p->vx += (moved - p->vx) * 0.3;
	p->sx = fx;
	p->lift = ease(p->lift, held ? LIFT : 0, dt, 180);
	p->face = ease(p->face, p->right ? -1 : 1, dt, 250);
	p->shamed = ease(p->shamed, shame ? 1 : 0, dt, 400);
	double flip = p->right ? -1 : 1, tilt = 0, bob = 0;
	double angle[4], down[4];
	if (held) {
		for (int r = 0; r < 2; r++) {
			p->spin += (clampd(p->vx * 4, -35, 35) - p->swing) * 0.12;
			p->spin *= 0.82;
			p->swing += p->spin;
		}
		tilt = p->swing * 0.22;
		double since = now - p->since;
		double kick = since < 400 ? 1 : fmax(0, 1 - (since - 400) / 160);
		for (int i = 0; i < 4; i++) {
			double kk = 32 * sin(since * 0.075 + i * 1.9);
			double hang = p->swing * flip + 2.5 * sin(now * 0.003 + i);
			angle[i] = kick * kk + (1 - kick) * hang, down[i] = 2.5 * (1 - kick);
		}
	} else {
		p->swing = p->spin = 0;
		bob = shame ? sin(clock * 0.0025) * 0.8 : -fabs(sin(phase)) * 2 * stride;
		for (int i = 0; i < 4; i++) angle[i] = 20 * stride * sin(phase + PAIR[i] * M_PI), down[i] = 0;
	}
	double wag = held || shame ? 0 : 8 * sin(clock * 0.006) * stride;
	p->phase = phase, p->stride = stride;

	// the pose: each part's map from the svg's units back into its own
	pose q = {.p = p, .shut = p->shamed > 0.5, .sweat = p->shamed > 0.5, .eye = fmax(3, 0.55 * 130 / (pig_w(p) * w.k))};
	for (int i = 0; i < 4; i++) q.leg[i] = inv(mul(tr(0, down[i]), about(HIPS[i][0], HIPS[i][1], ro(angle[i]))));
	q.tail = inv(about(106, 49, ro(38 * p->shamed + wag)));
	q.head = inv(about(54, 58, mul(ro(-22 * p->shamed), tr(2 * p->shamed, 4 * p->shamed))));
	q.earl = inv(about(26, 28, ro(-62 * p->shamed)));
	q.earr = inv(about(46, 28, ro(48 * p->shamed)));
	double pw = pig_w(p), ph = pig_h(p);
	// the svg into the field: scaled to the pig, faced, swayed, lifted (or binned), set at its feet
	mat lift = about(pw / 2, ph / 2, mul(tr(0, -p->lift + 14 * gone), mul(ro(30 * gone), sc(1 - 0.88 * gone, 1 - 0.88 * gone))));
	mat sway = about(0.5 * pw, 0.3 * ph, mul(tr(0, bob), ro(tilt)));
	mat face = about(pw / 2, ph / 2, sc(fabs(p->face) < 0.04 ? 0.04 : p->face, 1));
	mat m = mul(tr(fx, fy), mul(sc(w.k, w.k), mul(tr(-pw / 2, -0.9 * ph), mul(lift, mul(sway, mul(face, sc(pw / 130, ph / 100)))))));
	mat back = inv(m);

	// its shadow, on the ground at its feet: smaller and fainter held
	double held_by = p->lift / LIFT, shadow = (1 - 0.32 * held_by) * (1 - gone);
	double rx = 0.33 * pw * w.k * shadow, ry = 0.07 * pw * w.k * shadow, op = (1 - 0.5 * held_by) * (1 - gone);
	for (int y = (int)floor(fy - ry); y <= (int)ceil(fy + ry); y++)
		for (int x = (int)floor(fx - rx); x <= (int)ceil(fx + rx); x++) {
			double r = hypot((x + 0.5 - fx) / rx, (y + 0.5 - fy) / ry);
			double a = r < 0.6 ? 0.42 + (0.22 - 0.42) * r / 0.6 : r < 1 ? 0.22 * (1 - (r - 0.6) / 0.4) : 0;
			blend(x, y, (rgb){60, 40, 0}, a * op);
		}

	// where it is: the svg's corners, a little out (legs swing past them)
	double x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
	const double corners[4][2] = {{-12, -12}, {142, -12}, {-12, 112}, {142, 112}};
	for (int i = 0; i < 4; i++) {
		double cx, cy;
		ap(m, corners[i][0], corners[i][1], &cx, &cy);
		x0 = fmin(x0, cx), y0 = fmin(y0, cy), x1 = fmax(x1, cx), y1 = fmax(y1, cy);
	}
	int bx = (int)floor(x0) - 1, by = (int)floor(y0) - 1, bw = (int)ceil(x1) - bx + 2, bh = (int)ceil(y1) - by + 2;
	if (bw <= 0 || bh <= 0 || bw > 4 * w.fw + 8 || bh > 4 * w.fh + 8) {
		p->drawn = false;
		return;
	}
	if (bw != p->bw || bh != p->bh) {
		free(p->mask);
		p->mask = calloc((size_t)bw * bh, 1);
		if (!p->mask) abort();
	} else memset(p->mask, 0, (size_t)bw * bh);
	p->bx = bx, p->by_ = by, p->bw = bw, p->bh = bh, p->drawn = true;
	double alpha = 1 - gone;
	for (int y = 0; y < bh; y++) {
		int py = by + y;
		if (py < 0 || py >= w.fh) continue;
		for (int x = 0; x < bw; x++) {
			int px = bx + x;
			if (px < 0 || px >= w.fw) continue;
			// pig where half its samples are; its eyes where a quarter are
			int hits = 0, ink = 0, r = 0, g = 0, b = 0, all = AA * AA;
			for (int j = 0; j < AA; j++)
				for (int i = 0; i < AA; i++) {
					double sx, sy;
					ap(back, px + (i + 0.5) / AA, py + (j + 0.5) / AA, &sx, &sy);
					rgb c;
					if (sx < -15 || sx > 145 || sy < -15 || sy > 115 || !pig_at(&q, sx, sy, &c)) continue;
					hits++;
					if (!memcmp(&c, &INK, sizeof c)) ink++;
					else r += c.r, g += c.g, b += c.b;
				}
			if (2 * hits < all) continue;
			p->mask[y * bw + x] = 255;
			rgb c = 4 * ink >= all || hits == ink ? INK : (rgb){(uint8_t)(r / (hits - ink)), (uint8_t)(g / (hits - ink)), (uint8_t)(b / (hits - ink))};
			blend(px, py, c, alpha);
		}
	}
	for (int y = 0; y < bh; y++)
		for (int x = 0; x < bw; x++) {
			if (p->mask[y * bw + x] >= 64) continue;
			bool edge = false;
			for (int k = 0; k < 4 && !edge; k++) {
				int nx = x + (k == 0) - (k == 1), ny = y + (k == 2) - (k == 3);
				if (nx >= 0 && ny >= 0 && nx < bw && ny < bh && p->mask[ny * bw + nx] >= 128) edge = true;
			}
			if (edge) blend(bx + x, by + y, outline ? CHERRY : INK, (outline ? 1 : 0.85) * alpha);
		}
}

// the bin, out near the bottom right corner
static bool bin_at(double x, double y, rgb *out) {
	double sx, sy;
	ap(inv(about(52, 17, mul(ro(28 * w.bin_open), tr(4 * w.bin_open, -6 * w.bin_open)))), x, y, &sx, &sy);
	if (d_line(&HANDLE, sx, sy, 1.5) < 1.5) return *out = INK, true;
	double d = sd_roundrect(sx, sy, 5, 13, 50, 8, 3);
	if (d < 1.5) return *out = d < -1.5 ? LEMON : INK, true;
	if (seg(x, y, 22, 30, 23, 59) < 1.5 || seg(x, y, 30, 30, 30, 59) < 1.5 || seg(x, y, 38, 30, 37, 59) < 1.5)
		return *out = INK, true;
	d = sd_polygon(x, y, BIN_BODY, 6);
	if (d < 1.5) return *out = d < -1.5 ? WHITE : INK, true;
	return false;
}

static void bin_draw(void) {
	if (w.bin < 0.02) return;
	double x0, y0, x1, y1;
	bin_rect(&x0, &y0, &x1, &y1);
	double s = 0.7 + 0.3 * w.bin, off = (1 - w.bin) * 30 * w.k;
	// its svg (0 0 60 70) into its box, at .7 and pushed out to the corner while it comes out
	mat m = mul(tr(off, off), mul(about((x0 + x1) / 2, (y0 + y1) / 2, sc(s, s)), mul(tr(x0, y0), sc((x1 - x0) / 60, (y1 - y0) / 70))));
	mat back = inv(m);
	for (int py = (int)floor(y0 - 8 * w.k); py < (int)ceil(y1 + off) + 1; py++)
		for (int px = (int)floor(x0 - 4 * w.k); px < (int)ceil(x1 + off) + 1; px++) {
			int hits = 0, r = 0, g = 0, b = 0;
			for (int j = 0; j < AA; j++)
				for (int i = 0; i < AA; i++) {
					double sx, sy;
					rgb c;
					ap(back, px + (i + 0.5) / AA, py + (j + 0.5) / AA, &sx, &sy);
					if (!bin_at(sx, sy, &c)) continue;
					hits++, r += c.r, g += c.g, b += c.b;
				}
			if (hits)
				blend(px, py, (rgb){(uint8_t)(r / hits), (uint8_t)(g / hits), (uint8_t)(b / hits)},
					w.bin * hits / (AA * AA));
		}
}

static int cmp_z(const void *a, const void *b) {
	const pig *p = *(pig *const *)a, *q = *(pig *const *)b;
	int zp = (int)lround(p->gy * 1000) + (p->held || !strcmp(w.holding, p->id) ? 8000 : p->binned ? 6900 : 0);
	int zq = (int)lround(q->gy * 1000) + (q->held || !strcmp(w.holding, q->id) ? 8000 : q->binned ? 6900 : 0);
	return zp - zq;
}

// a label, centred on col, in a row: white on its colour
static void label(int row, int col, const char *name, rgb bg) {
	char buf[80];
	snprintf(buf, sizeof buf, " %s ", name);
	int n = (int)strlen(buf);
	int at = col - n / 2;
	if (at + n > w.s.cols) at = w.s.cols - n;
	if (at < 0) at = 0;
	screen_text(&w.s, row, at, buf, WHITE, &bg, false);
}

static void draw(double now, double clock, double dt) {
	screen *s = &w.s;
	w.fw = s->cols, w.fh = (s->rows - 1) * 2;
	// a pig about a twelfth of the field across, as on a page, but never too small to read
	double P = clampd(w.fw * 0.16, 18, 30);
	w.k = P / W;
	free(w.fb);
	w.fb = malloc((size_t)w.fw * w.fh * sizeof *w.fb);
	if (!w.fb) abort();
	pig *held = pig_find(w.holding);
	// the corner of shame, top right: shown while open, or while a pig is carried near it; tinted while
	// the pig carried is over it; its inner edges dashed
	double hx = w.pointer ? w.px : -1, hy = w.pointer ? w.py : -1;
	if (held && !w.by_mouse) hx = held->gx, hy = held->gy;
	bool on = held && in_shame(held->gx, held->gy);
	w.corner = ease(w.corner, w.open || (held && hx >= 0 && near_shame(hx, hy)) ? 1 : 0, dt, 300);
	double cw = (1 - PIG_SHAME_X) * w.fw, ch = PIG_SHAME_Y * w.fh;
	rgb ground = mix(FIELD, (rgb){209, 73, 91}, on ? 0.08 * w.corner : 0);
	for (int y = 0; y < w.fh; y++)
		for (int x = 0; x < w.fw; x++) w.fb[y * w.fw + x] = (x >= w.fw - cw && y < ch) ? ground : FIELD;
	for (int y = 0; y < (int)ch; y++)
		if ((y / 2) % 2 == 0) blend((int)(w.fw - cw), y, INK, 0.25 * w.corner);
	for (int x = (int)(w.fw - cw); x < w.fw; x++)
		if ((x / 2) % 2 == 0) blend(x, (int)ch, INK, 0.25 * w.corner);

	// the bin: out while the pointer (or the pig carried by keys) is near, or swallowing
	bool near = (hx >= 0 && near_bin(hx, hy)) || now < w.gulp_until;
	w.bin = ease(w.bin, near ? 1 : 0, dt, 220);
	w.bin_open = ease(w.bin_open, held && hx >= 0 && over_bin(hx, hy) ? 1 : 0, dt, 150);

	pig *order[512];
	size_t n = 0;
	const op_value *room = room_value();
	for (size_t i = 0; i < npigs && n < 512; i++) {
		pig *p = &pigs[i];
		p->drawn = false;
		if (!p->known || !in_room(room, p->id)) continue;
		order[n++] = p;
	}
	// where each is first (cmp_z sorts by it), then drawn back to front
	for (size_t i = 0; i < n; i++)
		if (strcmp(w.holding, order[i]->id) && !order[i]->held && !order[i]->shame && !order[i]->binned) {
			pig_walked m = pig_walk(&order[i]->path, order[i]->at, clock, w.open);
			order[i]->gy = m.y;
		}
	qsort(order, n, sizeof *order, cmp_z);
	for (size_t i = 0; i < n; i++) {
		// the bin goes over the pigs that aren't held, under the held one
		if (i > 0 && cmp_z(&order[i - 1], &order[i]) < 0 && (order[i]->held || !strcmp(w.holding, order[i]->id)) &&
			!(order[i - 1]->held || !strcmp(w.holding, order[i - 1]->id)))
			bin_draw();
		pig_draw_into(order[i], now, clock, dt, !strcmp(order[i]->id, w.selected));
	}
	bool bin_drawn = false;
	for (size_t i = 0; i < n; i++)
		if (order[i]->held || !strcmp(w.holding, order[i]->id)) bin_drawn = true;
	if (!bin_drawn) bin_draw();

	// the pixels into cells
	for (int r = 1; r < s->rows; r++)
		for (int c = 0; c < s->cols; c++) {
			cell *at = screen_at(s, r, c);
			rgb top = w.fb[(2 * (r - 1)) * w.fw + c], bottom = w.fb[(2 * (r - 1) + 1) * w.fw + c];
			*at = (cell){.ch = " ", .fg = top, .bg = bottom};
			if (memcmp(&top, &bottom, sizeof top)) snprintf(at->ch, sizeof at->ch, "%s", "\xe2\x96\x80");
			else at->bg = top;
		}
	// text on the field: over a cell's pixels, on their mean
	rgb faint = mix(FIELD, INK, 0.4);
	if (w.corner > 0.5) {
		const char *t = cw > 17 ? "corner of shame" : "shame";
		int col = w.fw - 1 - (int)strlen(t), row = 1;
		for (int i = 0; t[i]; i++) {
			cell *c = screen_at(s, row, col + i);
			if (!c) continue;
			rgb bg = mix(c->fg, c->bg, 0.5);
			char one[2] = {t[i], 0};
			screen_text(s, row, col + i, one, faint, &bg, false);
		}
	}
	for (size_t i = 0; i < n; i++) {
		pig *p = order[i];
		if (!p->drawn) continue;
		double half = (pig_w(p) / 2 + 2) * w.k, dx = clampd(p->gx * w.fw, half, w.fw - half);
		int col = (int)dx;
		double top = p->gy * w.fh + w.k * (-0.9 * pig_h(p) - p->lift);
		if (p->held || !strcmp(w.holding, p->id)) {
			bool mine = !strcmp(w.holding, p->id);
			int row = 1 + (int)floor(top / 2) - 1;
			if (row < 1) row = 1;
			label(row, col, mine ? w.name : p->by, mine ? w.colour : p->colour);
		} else if (p->shame && p->shamed > 0.5) {
			int row = 1 + (int)floor((top - 12 * w.k) / 2);
			int dc = (int)(dx + pig_w(p) * w.k * 0.18);
			cell *c = screen_at(s, row < 1 ? 1 : row, dc);
			if (c) {
				rgb bg = mix(c->fg, c->bg, 0.5);
				screen_text(s, row < 1 ? 1 : row, dc, "\xe2\x80\xa6", INK, &bg, true);
			}
		}
	}
	// the others' pointers: an arrow, and a name
	for (size_t i = 0; i < w.nrows; i++) {
		row_t *r = &w.rows[i];
		if (!r->pointer || !strcmp(r->who, w.me) || r->until <= now) continue;
		int col = (int)(r->x * s->cols), row = 1 + (int)(r->y * (s->rows - 1));
		if (row >= s->rows) row = s->rows - 1;
		if (col >= s->cols) col = s->cols - 1;
		cell *c = screen_at(s, row, col);
		if (!c) continue;
		rgb bg = mix(c->fg, c->bg, 0.5);
		screen_text(s, row, col, "\xe2\x9e\xa4", r->colour, &bg, true);
		char buf[80];
		snprintf(buf, sizeof buf, " %s ", r->name);
		screen_text(s, row, col + 1, buf, WHITE, &r->colour, false);
	}

	// the header: who I am, the server, the pigs, versions to settle, the keys
	for (int c = 0; c < s->cols; c++) *screen_at(s, 0, c) = (cell){.ch = " ", .fg = INK, .bg = PAPER};
	int col = 1;
	col += screen_text(s, 0, col, w.name, w.colour, &PAPER, true) + 2;
	int count = 0;
	for (size_t i = 0; i < npigs; i++)
		if (in_room(room, pigs[i].id)) count++;
	char line[256];
	snprintf(line, sizeof line, "%s  %d pig%s", !w.server ? "offline" : w.online ? "online" : "joining", count,
		count == 1 ? "" : "s");
	col += screen_text(s, 0, col, line, INK, &PAPER, false) + 2;
	if (w.conflicts) {
		snprintf(line, sizeof line, "%d with versions: s settles", w.conflicts);
		col += screen_text(s, 0, col, line, CHERRY, &PAPER, false) + 2;
	}
	if (now < w.note_until) col += screen_text(s, 0, col, w.note, INK, &PAPER, false) + 2;
	const char *help = held ? "arrows carry  space sets down" : "tab/arrows choose  space picks up  a adds  q quits";
	int hl = (int)strlen(help);
	if (s->cols - hl - 1 > col) screen_text(s, 0, s->cols - hl - 1, help, faint, &PAPER, false);
}

#include "hack.c"

// ---- the loop

// what is shown, as JSON, for a test to read: the pigs (where drawn, held by whom, ashamed), the others'
// pointers, who I am
static void state(const char *path) {
	if (!path) return;
	char tmp[1024];
	snprintf(tmp, sizeof tmp, "%s.tmp", path);
	FILE *f = fopen(tmp, "w");
	if (!f) return;
	fprintf(f, "{\"name\":\"%s\",\"me\":\"%s\",\"online\":%s,\"cols\":%d,\"rows\":%d,\"selected\":\"%s\",\"holding\":\"%s\",\"pigs\":[",
		w.name, w.me, w.online ? "true" : "false", w.s.cols, w.s.rows, w.selected, w.holding);
	const op_value *room = room_value();
	bool first = true;
	for (size_t i = 0; i < npigs; i++) {
		pig *p = &pigs[i];
		if (!p->known || !in_room(room, p->id)) continue;
		bool mine = !strcmp(w.holding, p->id);
		// the cell at the middle of what is drawn of it
		double sx = 0, sy = 0, n = 0;
		for (int y = 0; p->drawn && p->mask && y < p->bh; y++)
			for (int x = 0; x < p->bw; x++)
				if (p->mask[y * p->bw + x] >= 128) sx += p->bx + x, sy += p->by_ + y, n++;
		int col = n ? (int)(sx / n) : -1, row = n ? 1 + (int)(sy / n / 2) : -1;
		if (hack_look) col = h_col(p->gx), row = h_row(p->gy) - (mine || p->held ? 1 : 0);
		fprintf(f, "%s{\"id\":\"%s\",\"x\":%.5f,\"y\":%.5f,\"held\":%s,\"by\":\"%s\",\"shame\":%s,\"binned\":%s,\"right\":%s,\"drawn\":%s,\"col\":%d,\"row\":%d,\"size\":%.5f}",
			first ? "" : ",", p->id, p->gx, p->gy, mine || p->held ? "true" : "false", mine ? w.name : p->held ? p->by : "",
			p->shame ? "true" : "false", p->binned ? "true" : "false", p->right ? "true" : "false", p->drawn ? "true" : "false", col, row, p->size);
		first = false;
	}
	fprintf(f, "],\"look\":\"%s\",\"at\":[%d,%d],\"dragged_by\":\"%s\",\"stuck\":%s,\"px\":%.5f,\"py\":%.5f,\"pointers\":[",
		hack_look ? "nethack" : "pixels", H.col, H.row, H.dragged_by, H.stuck ? "true" : "false", w.px, w.py);
	first = true;
	for (size_t i = 0; i < w.nrows; i++) {
		row_t *r = &w.rows[i];
		if (!r->pointer || r->until <= mono()) continue;
		fprintf(f, "%s{\"who\":\"%s\",\"name\":\"%s\",\"x\":%.4f,\"y\":%.4f}", first ? "" : ",", r->who, r->name, r->x, r->y);
		first = false;
	}
	fprintf(f, "]}\n");
	fclose(f);
	rename(tmp, path);
}

static void dump(const char *path) {
	if (!path) return;
	size_t n;
	char *bytes = screen_dump(&w.s, &n);
	FILE *f = fopen(path, "w");
	if (f) fwrite(bytes, 1, n, f), fclose(f);
	free(bytes);
	w.s.full = true;
}

int main(int argc, char **argv) {
	const char *server = "wss://galaxy.observer", *service = NULL, *dump_path = NULL, *log_path = NULL, *state_path = NULL;
	double quit_after = 0;
	srand((unsigned)time(NULL));
	snprintf(w.name, sizeof w.name, "%s-%u", NAMES[rand32() % 10], rand32() % 100);
	snprintf(w.colour_text, sizeof w.colour_text, "%s", COLOURS[rand32() % 7]);
	for (int i = 1; i < argc; i++) {
		const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : NULL;
		if (!strcmp(a, "--server") && v) server = !strcmp(v, "none") ? NULL : v, i++;
		else if (!strcmp(a, "--service") && v) service = v, i++;
		else if (!strcmp(a, "--room") && v) snprintf(ROOM, sizeof ROOM, "%s", v), i++;
		else if (!strcmp(a, "--offline")) server = NULL;
		else if (!strcmp(a, "--name") && v) snprintf(w.name, sizeof w.name, "%s", v), i++;
		else if (!strcmp(a, "--colour") && v) snprintf(w.colour_text, sizeof w.colour_text, "%s", v), i++;
		else if (!strcmp(a, "--dump") && v) dump_path = v, i++;
		else if (!strcmp(a, "--log") && v) log_path = v, i++;
		else if (!strcmp(a, "--state") && v) state_path = v, i++;
		else if (!strcmp(a, "--quit-after") && v) quit_after = atof(v), i++;
		else if (!strcmp(a, "--look") && v) {
			if (!strcmp(v, "nethack") || !strcmp(v, "hack")) hack_look = true;
			else if (strcmp(v, "pixels")) {
				fprintf(stderr, "ermine-pigs: --look pixels or nethack\n");
				return 2;
			}
			i++;
		} else if (!strcmp(a, "--aa") && v) AA = atoi(v) < 1 ? 1 : atoi(v) > 4 ? 4 : atoi(v), i++;
		else {
			fprintf(stderr, "usage: ermine-pigs [--server URL|none] [--service NAME] [--room ermine://...] [--offline]\n"
				"                   [--name NAME] [--colour #rrggbb] [--look pixels|nethack] [--dump FILE] [--state FILE]\n"
				"                   [--log FILE] [--quit-after S] [--aa N]\n");
			return 2;
		}
	}
	if (!is_pig(ROOM)) {
		fprintf(stderr, "ermine-pigs: %s is no kept id (ermine:// and 64 hex digits)\n", ROOM);
		return 2;
	}
	w.colour = hex(w.colour_text, CHERRY);
	if (log_path) logf_ = fopen(log_path, "a");
	shapes();
	// galaxy stores an id only when its last 16 bytes are zero; a server here stores any
	bool zeros = server && !strstr(server, "//localhost") && !strstr(server, "//127.");
	const char *why = NULL;
	w.server = server != NULL;
	w.d = dv_new(server, service, zeros, w.name, &why);
	if (!w.d) {
		fprintf(stderr, "ermine-pigs: %s: %s\n", server ? server : "(none)", why ? why : "?");
		return 1;
	}
	snprintf(w.me, sizeof w.me, "%s", dv_key(w.d));
	say("start %s %s room %s server %s", w.name, w.me, ROOM, server ? server : "none");
	dv_follow(w.d, ROOM);
	dv_follow(w.d, FIRST);
	dv_listen(w.d, ROOM, heard, NULL);
	// someone dragging this NetHack player: their requests, on the room's move topic
	char moves[DV_ID + 8];
	snprintf(moves, sizeof moves, "%s/move", ROOM);
	if (hack_look) dv_listen(w.d, moves, hack_moved, NULL);
	signal(SIGPIPE, SIG_IGN);
	signal(SIGINT, on_quit);
	signal(SIGTERM, on_quit);
	signal(SIGHUP, on_quit);
	signal(SIGWINCH, on_winch);
	bool tty = screen_open(&w.s);
	if (!tty && !dump_path && !state_path) {
		fprintf(stderr, "ermine-pigs: stdin is no terminal (give --dump FILE to run without one)\n");
		screen_close(&w.s);
		dv_free(w.d);
		return 1;
	}
	resized = 0;
	char in[4096];
	size_t have = 0;
	double started = mono(), last = mono(), dumped = 0;
	bool was_online = false;
	while (!quit) {
		if (resized) resized = 0, screen_size(&w.s);
		struct pollfd fds[3];
		size_t nf = 0;
		if (tty) fds[nf++] = (struct pollfd){0, POLLIN, 0};
		size_t at_dev = nf;
		nf += dv_fds(w.d, fds + nf, 3 - nf);
		int wait = dv_turn(w.d);
		double next = last + 33 - mono();
		if (next < wait) wait = next < 0 ? 0 : (int)next;
		poll(fds, (nfds_t)nf, wait);
		if (tty && fds[0].revents & (POLLIN | POLLHUP)) {
			ssize_t got = read(0, in + have, sizeof in - have);
			if (got > 0) have += (size_t)got;
			else if (got == 0) quit = 1;
		}
		if (nf > at_dev) dv_ready(w.d);
		dv_turn(w.d);
		// the keys
		size_t used = 0;
		while (used < have) {
			key k;
			size_t took = key_read(in + used, have - used, &k);
			if (!took) break;
			used += took;
			bool held = w.holding[0];
			if (hack_look) hack_key(&k);
			else if (k.kind == K_CHAR && (k.ch == 'q' || k.ch == 3)) quit = 1;
			else if (k.kind == K_CHAR && k.ch == ' ') {
				if (held) drop();
				else {
					pig *p = pig_find(w.selected);
					if (p && shown(p)) grab(p, false, 0, 0);
					else tab(1);
				}
			} else if (k.kind == K_TAB && !held) tab(1);
			else if (k.kind == K_BACKTAB && !held) tab(-1);
			else if (k.kind == K_LEFT || (k.kind == K_CHAR && (k.ch == 'h' || k.ch == 'H'))) arrow(-1, 0, k.shift || k.ch == 'H');
			else if (k.kind == K_RIGHT || (k.kind == K_CHAR && (k.ch == 'l' || k.ch == 'L'))) arrow(1, 0, k.shift || k.ch == 'L');
			else if (k.kind == K_UP || (k.kind == K_CHAR && (k.ch == 'k' || k.ch == 'K'))) arrow(0, -1, k.shift || k.ch == 'K');
			else if (k.kind == K_DOWN || (k.kind == K_CHAR && (k.ch == 'j' || k.ch == 'J'))) arrow(0, 1, k.shift || k.ch == 'J');
			else if (k.kind == K_CHAR && k.ch == 'a') add_pig();
			else if (k.kind == K_CHAR && k.ch == 's') settle_all();
			else if (k.kind == K_ESC && !held) w.selected[0] = 0;
			else if (k.kind == K_MOUSE) mouse(&k);
		}
		memmove(in, in + used, have - used);
		have -= used;
		if (have == sizeof in) have = 0;
		double now = mono();
		if (quit_after > 0 && now - started > quit_after * 1000) quit = 1;
		if (now - last < 33 && !quit) continue;
		// a frame: what the nodes say, what goes out, the screen
		double dt = now - last;
		last = now;
		w.online = dv_online(w.d);
		if (w.online && !was_online) presence_send(false), say("online"), w.online_at = now;
		was_online = w.online;
		room_read();
		for (size_t i = 0; i < npigs; i++) pig_read(&pigs[i], now);
		w.open = false;
		for (size_t i = 0; i < npigs; i++)
			if (pigs[i].known && pigs[i].shame && in_room(room_value(), pigs[i].id)) w.open = true;
		mend();
		count_conflicts();
		if (w.bin_later[0] && now >= w.bin_later_at) {
			dv_store(w.d, ROOM, room_with(w.bin_later, false));
			say("binned %s", w.bin_later);
			w.bin_later[0] = 0;
		}
		pig *held = pig_find(w.holding);
		if (held && w.wave_due) wave_value(held), w.wave_due = false;
		if (w.pointer_due || now - w.beat >= RENEW) presence_send(false);
		sweep();
		if (hack_look) hack_draw(now, ms_now(), dt);
		else draw(now, ms_now(), dt);
		if (tty) screen_flush(&w.s, 1);
		if ((dump_path || state_path) && now - dumped > (state_path ? 250 : 1000)) dump(dump_path), state(state_path), dumped = now;
	}
	if (w.holding[0]) drop();
	presence_send(true);
	dv_turn(w.d);
	if (dump_path) dump(dump_path);
	state(state_path);
	screen_close(&w.s);
	dv_flush(w.d, 1500);
	say("quit");
	dv_free(w.d);
	for (size_t i = 0; i < npigs; i++) free(pigs[i].mask);
	free(pigs);
	free(w.rows);
	free(w.fb);
	if (logf_) fclose(logf_);
	return 0;
}
