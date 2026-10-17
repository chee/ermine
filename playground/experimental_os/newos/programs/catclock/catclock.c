/* Copyright 1985 Massachusetts Institute of Technology */

// catclock: Plan 9's cat clock (9front,
// /sys/src/games/catclock.c, after X11's Kit-Cat Klock), on ermineOS. A
// program the exec loader runs (../../exec.c), a client of the OS through
// libermine: it places a window, a layer of its own
// in /dev/display/layers, and draws sixteen times a second, as catclock
// draws on its screen: the cat, its hands, and its tail and eyes swinging.
// It draws into a plane (/dev/vram), shared memory the compositor shows: the
// cat once, then each step only where the tail and eyes move (and the hands,
// when the minute turns), saying that rectangle changed. -d draws with the
// draw device's ops instead, as it first did (and does on an OS with no
// /dev/vram): the still ones once, those that move written again each step.
// Everything is drawn at the screen's unit, so the cat is its usual size on
// a Retina screen. -c makes it cross-eyed, as catclock's does.
//
// The bitmaps, catback.p and eyes.p, are 9front's, unchanged: rows of whole
// bytes, the leftmost pixel in a byte's high bit, as Plan 9's GREY1 holds
// them, a set bit black (catclock inverts them for GREY1, where 1 is white).

#include "../../lib/libermine.h"
#include "../../../../../ermine/encoding/c/json_text.h"
#include "../../blit.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef unsigned char uchar;
#include "catback.p"
#include "eyes.p"

#define CATWID 150  /* width of body bitmap */
#define CATHGT 300  /* height of body bitmap */
#define TAILWID 150 /* width of tail bitmap */
#define TAILHGT 89  /* height of tail bitmap */
#define MINULEN 27  /* length of minute hand */
#define HOURLEN 15  /* length of hour hand */
#define HANDWID 4   /* width of clock hands */
#define NTAIL 16
#define UPDATE (1000 / NTAIL) /* ms/update -- tail waves at roughly 1/2 hz */
#define NTP 7
#define PI 3.14159265358979323846
#define PIO2 (PI / 2)
#define BLACK 0x000000
#define WHITE 0xffffff
#define MARGIN 20 /* paper around the cat */

typedef struct Point {
	int x, y;
} Point;

static Point tp[NTP] = { /* tail polygon */
	{ 0, 0 }, { 0, 76 }, { 3, 82 }, { 10, 84 }, { 18, 82 }, { 21, 76 }, { 21, 70 },
};
static Point toffs = { 74, -15 };   /* tail polygon offset */
static Point tailoffs = { 0, 211 }; /* tail bitmap offset, relative to body */
static Point eyeoffs = { 49, 30 };  /* eye bitmap offset, relative to body */
static Point catoffs;               /* cat offset, relative to the window */
static int crosseyed;
static int u = 1; /* pixels a point */
static int W, H;

static int rnd(double x) {
	return x >= 0. ? (int)(x + .5) : (int)(x - .5);
}

// drawing, by the blitter (../../blit.h): into the plane, or recorded as
// the draw device's ops when the form records

static BlitForm *pen; /* what is drawn on */

static void fill(int x, int y, int w, int h, uint32_t color) {
	blitFill(pen, x, y, w, h, color, NULL);
}
/** n points at an offset, in pixels */
static int *pixelsOf(const Point *p, int n, Point at, int *out) {
	for (int i = 0; i < n; i++) {
		out[2 * i] = (p[i].x + at.x) * u;
		out[2 * i + 1] = (p[i].y + at.y) * u;
	}
	return out;
}
static void fillpoly(const Point *p, int n, Point at, uint32_t color) {
	int xy[2 * 100];
	blitFillpoly(pen, pixelsOf(p, n, at, xy), n, true, color, NULL);
}
static void poly(const Point *p, int n, Point at, int width, uint32_t color) {
	int xy[2 * 100];
	blitPoly(pen, pixelsOf(p, n, at, xy), n, width * u > 1 ? width * u : 1, color, NULL);
}
/** an X bitmap, each pixel u × u, as a form */
static BlitForm bitmap(const uchar *bits, int w, int h) {
	int stride = (w + 7) / 8;
	BlitForm f = blitForm(w * u, h * u, WHITE);
	for (int y = 0; y < f.h; y++)
		for (int x = 0; x < f.w; x++) {
			int bx = x / u, by = y / u;
			f.bits[y * f.w + x] = bits[by * stride + bx / 8] >> (7 - bx % 8) & 1 ? BLACK : WHITE;
		}
	return f;
}
static void put(const BlitForm *f, Point at) {
	blitBlit(pen, at.x * u, at.y * u, f, 0, 0, f->w, f->h, BLIT_COPY, NULL);
}

static Point add(Point a, Point b) {
	return (Point){ a.x + b.x, a.y + b.y };
}

/*
 * Draw a clock hand, theta is clockwise angle from noon
 */
static void drawhand(int length, int width, double theta) {
	double c = cos(theta), s = sin(theta);
	double ws = width * s, wc = width * c;
	Point vhand[4];
	vhand[0] = add(catoffs, (Point){ CATWID / 2 + rnd(length * s), CATHGT / 2 - rnd(length * c) });
	vhand[1] = add(catoffs, (Point){ CATWID / 2 - rnd(ws + wc), CATHGT / 2 + rnd(wc - ws) });
	vhand[2] = add(catoffs, (Point){ CATWID / 2 - rnd(ws - wc), CATHGT / 2 + rnd(wc + ws) });
	vhand[3] = vhand[0];
	fillpoly(vhand, 4, (Point){ 0, 0 }, WHITE);
	poly(vhand, 4, (Point){ 0, 0 }, 0, BLACK);
}

/*
 * draw a cat tail, t is time (mod 1 second)
 */
static void drawtail(double t) {
	double theta = .4 * sin(t + 3. * PIO2) - .08; /* an assymetric tail leans to one side */
	double s = sin(theta), c = cos(theta);
	Point rtp[NTP], at = add(catoffs, tailoffs);
	for (int i = 0; i != NTP; i++)
		rtp[i] = add((Point){ (int)(tp[i].x * c + tp[i].y * s), (int)(-tp[i].x * s + tp[i].y * c) }, toffs);
	fill(at.x * u, at.y * u, TAILWID * u, TAILHGT * u, WHITE);
	fillpoly(rtp, NTP, at, BLACK);
}

/** one eye's pupils' outline, looking at angle */
static int pupils(Point *pts, double angle) {
	int i = 0;
	struct {
		double x, y, z;
	} pt;
	for (double v = -PI / 2.0; v < PI / 2.0; i++, v += 0.25) {
		pt.x = cos(v) * cos(angle + PI / 7.0);
		pt.y = sin(v);
		pt.z = 2. + cos(v) * sin(angle + PI / 7.0);
		pts[i].x = (int)((pt.z == 0.0 ? pt.x : pt.x / pt.z) * 23.0 + 12.0);
		pts[i].y = (int)((pt.z == 0.0 ? pt.y : pt.y / pt.z) * 23.0 + 11.0);
	}
	for (double v = PI / 2.0; v > -PI / 2.0; i++, v -= 0.25) {
		pt.x = cos(v) * cos(angle - PI / 7.0);
		pt.y = sin(v);
		pt.z = 2. + cos(v) * sin(angle - PI / 7.0);
		pts[i].x = (int)((pt.z == 0.0 ? pt.x : pt.x / pt.z) * 23.0 + 12.0);
		pts[i].y = (int)((pt.z == 0.0 ? pt.y : pt.y / pt.z) * 23.0 + 11.0);
	}
	return i;
}

/*
 * draw the cat's eyes, t is time (mod 1 second)
 */
static void draweye(const BlitForm *eyes, double t) {
	Point pts[100], at = add(catoffs, eyeoffs);
	put(eyes, at);
	int i = pupils(pts, 0.7 * sin(t + 3 * PIO2) + PI / 2.0);
	fillpoly(pts, i, at, BLACK);
	if (crosseyed) i = pupils(pts, 0.7 * sin(PI - t + 3 * PIO2) + PI / 2.0);
	for (int j = 0; j < i; j++) pts[j].x += 31;
	fillpoly(pts, i, at, BLACK);
}

/** what stays: paper, a border, the cat */
/** a and b mixed, t of b */
static uint32_t mix(uint32_t a, uint32_t b, double t) {
	uint32_t out = 0;
	for (int k = 16; k >= 0; k -= 8) out |= (uint32_t)(((a >> k) & 255) * (1 - t) + ((b >> k) & 255) * t + 0.5) << k;
	return out;
}

/** the window's paper at t down it: catclock's page's sky, a pale blue, a lilac, a pink */
static uint32_t sky(double t) {
	return t < 0.6 ? mix(0xe3f1ff, 0xf7f3fb, t / 0.6) : mix(0xf7f3fb, 0xfdeef5, (t - 0.6) / 0.4);
}

/**
 * what stays: the paper a sky, as catclock's page has it, and the cat on it as a card ringed in white, a
 * hairline round that and its shadow soft under it (only into a plane: as ops, a pixel each is too many)
 */
static void drawstill(const BlitForm *cat) {
	for (int y = 0; y < H; y++) fill(0, y, W, 1, sky(H > 1 ? (double)y / (H - 1) : 0));
	int x0 = catoffs.x * u, y0 = catoffs.y * u, cw = CATWID * u, ch = CATHGT * u, ring = 5 * u;
	if (!pen->ops) {
		// box-shadow: 0 10px 28px rgba(40, 40, 120, 0.18), each pixel's share of the card blurred
		double s = 14.0 * u * 1.4142135623730951, dy = 10.0 * u;
		for (int y = 0; y < H; y++)
			for (int x = 0; x < W; x++) {
				double ax = 0.5 * (erf((x + 0.5 - (x0 - ring)) / s) - erf((x + 0.5 - (x0 + cw + ring)) / s));
				double ay = 0.5 * (erf((y + 0.5 - (y0 - ring + dy)) / s) - erf((y + 0.5 - (y0 + ch + ring + dy)) / s));
				uint32_t *p = &pen->bits[(size_t)y * (size_t)pen->stride + (size_t)x];
				*p = mix(*p, 0x282878, 0.18 * ax * ay);
			}
	}
	fill(x0 - ring - u, y0 - ring - u, cw + 2 * ring + 2 * u, ch + 2 * ring + 2 * u, 0xe9e6ec);
	fill(x0 - ring, y0 - ring, cw + 2 * ring, ch + 2 * ring, WHITE);
	put(cat, catoffs);
}

/** what moves, over what stays: its hands, then its tail and eyes at step t */
static void drawclock(const BlitForm *eyes, int t, const struct tm *tm) {
	drawhand(MINULEN, HANDWID, 2. * PI * tm->tm_min / 60.);
	drawhand(HOURLEN, HANDWID, 2. * PI * (tm->tm_hour + tm->tm_min / 60.) / 12.);
	drawtail(t * PI / NTAIL);
	draweye(eyes, t * PI / NTAIL);
}

/** the time, its hours on the dial */
static struct tm now12(void) {
	time_t now = time(0);
	struct tm tm = *localtime(&now);
	tm.tm_hour %= 12;
	return tm;
}

/** a rectangle in points from the cat's corner, in pixels in the window */
static BlitRect area(int x, int y, int w, int h) {
	return (BlitRect){ (catoffs.x + x) * u, (catoffs.y + y) * u, w * u, h * u };
}

static BlitRect unite(BlitRect a, BlitRect b) {
	int x0 = a.x < b.x ? a.x : b.x, y0 = a.y < b.y ? a.y : b.y;
	int x1 = a.x + a.w > b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h > b.y + b.h ? a.y + a.h : b.y + b.h;
	return (BlitRect){ x0, y0, x1 - x0, y1 - y0 };
}

int main(int argc, char *argv[]) {
	bool list = false;
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "-c") == 0) crosseyed++;
		else if (strcmp(argv[i], "-d") == 0) list = true;
		else {
			fprintf(stderr, "Usage: %s [-c] [-d]\n", argv[0]);
			return 1;
		}
	}
	Erm *erm = ermOpen();
	if (!erm) {
		fprintf(stderr, "catclock: no OS: run it in ermineOS\n");
		return 1;
	}
	const Json *mode = ermGet(erm, ermPath("/", "dev", "display", "mode", NULL));
	int64_t unit = 1;
	if (mode && jsonIsWhole(jsonGet(mode, "unit"), &unit) && unit > 0) u = (int)unit;
	W = (CATWID + 2 * MARGIN) * u;
	H = (CATHGT + 2 * MARGIN) * u;
	catoffs = (Point){ MARGIN, MARGIN };

	BlitForm cat = bitmap(catback_bits, CATWID, CATHGT);
	BlitForm eyes = bitmap(eyes_bits, eyes_width, eyes_height);

	// the window: a layer of its own, its owner this process's node, so the window manager can close it
	const char *pid = getenv("ERMINE_PID"), *node = getenv("ERMINE_NODE");
	char name[64];
	snprintf(name, sizeof name, "catclock-%s", pid ? pid : "here");
	Json *layer = jsonObject();
	jsonAdd(layer, "x", jsonNumber(120 * u));
	jsonAdd(layer, "y", jsonNumber(90 * u));
	jsonAdd(layer, "w", jsonNumber(W));
	jsonAdd(layer, "h", jsonNumber(H));
	jsonAdd(layer, "title", jsonString("cat clock"));
	// the desk's star, as catclock's page has its clock: its chrome /etc/theme's star, where the theme has one
	jsonAdd(layer, "star", jsonBoolean(true));
	if (node) {
		Json *owner = jsonArray();
		jsonPush(owner, jsonString("/"));
		char *path = strdup(node);
		for (char *part = strtok(path, "/"); part; part = strtok(NULL, "/")) jsonPush(owner, jsonString(part));
		free(path);
		jsonAdd(layer, "owner", owner);
	}
	Json *error = NULL;
	struct tm tm = now12();
	// -d: the draw device's ops, the still ones, then those that move, which alone each write replaces;
	// else a plane (/dev/vram): the cat drawn once, then only where the tail, eyes and hands move
	ErmPlane *plane = list ? NULL : ermPlane(erm, name, W, H, &error);
	if (!list && !plane) {
		// an OS with no /dev/vram: the ops, as before
		char *why = jsonPrint(error);
		fprintf(stderr, "catclock: no plane (%s): drawing with ops\n", why);
		free(why);
		list = true;
	}
	BlitForm still = { 0 }, screen = { 0 };
	int nstill = 0, moved = 0;
	if (list) {
		BlitForm f = blitList(W, H, NULL);
		pen = &f;
		drawstill(&cat);
		nstill = f.ops->array.count;
		drawclock(&eyes, 0, &tm);
		moved = f.ops->array.count - nstill;
		jsonAdd(layer, "draw", f.ops);
	} else {
		still = blitForm(W, H, WHITE);
		pen = &still;
		drawstill(&cat);
		screen = (BlitForm){ plane->w, plane->h, plane->stride, plane->bits, NULL };
		pen = &screen;
		blitBlit(pen, 0, 0, &still, 0, 0, W, H, BLIT_COPY, NULL);
		drawclock(&eyes, 0, &tm);
		jsonAdd(layer, "plane", ermPlaneValue(plane));
	}
	char *made = ermMake(erm, ermPath("/", "dev", "display", "layers", NULL), name, layer, true, &error);
	if (!made) {
		char *why = jsonPrint(error);
		fprintf(stderr, "catclock: no window: %s\n", why);
		return 1;
	}
	free(made);
	// where what moves goes, in points from the cat's corner: the pupils reach 12 points past
	// the eyes' bitmap, the tail 26 above its box; the hands, the dial's middle
	BlitRect eyesAt = area(eyeoffs.x - 12, eyeoffs.y - 13, eyes_width + 26, eyes_height + 26);
	BlitRect tailAt = area(tailoffs.x, tailoffs.y - 26, TAILWID, TAILHGT + 26);
	int reach = MINULEN + HANDWID + 2;
	BlitRect handsAt = area(CATWID / 2 - reach, CATHGT / 2 - reach, 2 * reach, 2 * reach);
	int minute = tm.tm_min;
	// steps on the clock, not after each write: a slow write skips steps, so the tail keeps its pace
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	int64_t next = (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
	for (int t = 0, dt = 1;;) {
		next += UPDATE * 1000;
		clock_gettime(CLOCK_MONOTONIC, &ts);
		int64_t now = (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
		int steps = 1;
		if (next > now) usleep((useconds_t)(next - now));
		else steps += (int)((now - next) / (UPDATE * 1000)), next += (int64_t)(steps - 1) * UPDATE * 1000;
		for (int k = 0; k < steps; k++) {
			t += dt;
			if (t < 0 || t > NTAIL) {
				t -= 2 * dt;
				dt = -dt;
			}
		}
		tm = now12();
		Json *at = ermPath("/", "dev", "display", "layers", name, NULL);
		if (plane) {
			// what stays, back where things move; the hands only when the minute turns
			BlitRect dirty = unite(eyesAt, tailAt);
			if (tm.tm_min != minute) dirty = unite(dirty, handsAt), minute = tm.tm_min;
			blitBlit(pen, dirty.x, dirty.y, &still, dirty.x, dirty.y, dirty.w, dirty.h, BLIT_COPY, NULL);
			drawclock(&eyes, t, &tm);
			// the window gone, or the OS: the clock stops
			if (!ermDrawn(erm, plane, at, dirty.x, dirty.y, dirty.w, dirty.h, &error)) return 0;
			continue;
		}
		BlitForm f = blitList(W, H, NULL);
		pen = &f;
		drawclock(&eyes, t, &tm);
		// those that move, in place of the last: a splice of draw
		Json *fields = jsonObject(), *patches = jsonArray(), *splice = jsonObject(), *range = jsonArray();
		jsonPush(range, jsonInteger(nstill));
		jsonPush(range, jsonInteger(nstill + moved));
		jsonAdd(splice, "path", ermPath("draw", NULL));
		jsonAdd(splice, "range", range);
		moved = f.ops->array.count;
		jsonAdd(splice, "value", f.ops);
		jsonPush(patches, splice);
		jsonAdd(fields, "address", at);
		jsonAdd(fields, "patches", patches);
		Json *time = ermDo(erm, "write", fields, &error);
		if (!time) return 0;
		jsonFree(time);
	}
}
