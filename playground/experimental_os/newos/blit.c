// blit.c: the machine's 2D engine. See blit.h; js/blitter.ts is the
// model, and each function here does what its namesake there does, in the
// same order, so both draw the same pixels.

#include "blit.h"

#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// The limits of lines, polygons and ellipses, as blitter.ts has them: past
// them a number is held at them, so that the model's doubles and the
// integers here draw the same pixels, and a far point never runs long.
#define FAR (1 << 20)
#define RADIUS (1 << 16)
#define WIDEST 4096
// how far any other coordinate may be, so that two added never overflow
#define BIG (1 << 30)

struct Blitter {
	BlitRom rom;
	size_t length;   // the ROM's alpha's bytes: a glyph for each of its characters
	uint32_t *chars; // its code points, in order, each once
	size_t *at;      // where each one's glyph starts in alpha
	int count;
	long unknown;    // where '?''s glyph starts, or -1: the glyph of a character it has not
};

// numbers -----------------------------------------------------------------------

static int clampInt(int64_t n, int lo, int hi) {
	return n < lo ? lo : n > hi ? hi : (int)n;
}

/** n as a whole number (floor), from lo to hi; not a number is 0 */
static int whole(double n, int lo, int hi) {
	if (isnan(n)) n = 0;
	n = floor(n);
	return n < lo ? lo : n > hi ? hi : (int)n;
}

/** a number as JavaScript's ToUint32 has it: what a Uint32Array holds */
static uint32_t toUint32(double n) {
	if (!isfinite(n)) return 0;
	double m = fmod(trunc(n), 4294967296.0);
	if (m < 0) m += 4294967296.0;
	return (uint32_t)m;
}

/** JavaScript's Math.round: the nearest whole number, a half up */
static double roundHalfUp(double x) {
	double f = floor(x);
	return x - f >= 0.5 ? f + 1 : f;
}

/** n / d rounded up, for d > 0 */
static int64_t up(int64_t n, int64_t d) {
	return n / d + (n % d > 0);
}

static uint32_t mix(uint32_t bg, uint32_t fg, uint32_t a) {
	uint32_t out = 0;
	for (int s = 16; s >= 0; s -= 8) out |= ((((bg >> s) & 255) * (255 - a) + ((fg >> s) & 255) * a) / 255) << s;
	return out;
}

// text --------------------------------------------------------------------------

/**
 * The code point at text[*at], moving past it, while *left (UTF-16 units)
 * lasts; false at the end. U+0000 held as C0 80 is 0; a lone surrogate's
 * WTF-8 is that surrogate; a byte that starts nothing is U+FFFD. A character
 * past U+FFFF with one unit left is its first surrogate alone, as a
 * JavaScript slice through it leaves.
 */
static bool step(const char *text, size_t *at, size_t *left, uint32_t *cp) {
	const unsigned char *s = (const unsigned char *)text + *at;
	if (!*s || !*left) return false;
	uint32_t c = s[0];
	size_t n = 1;
	if (c >= 0x80) {
		n = c >= 0xf0 && c <= 0xf4 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 0;
		if (c >= 0xf5) n = 0;
		for (size_t i = 1; i < n; i++) {
			if ((s[i] & 0xc0) != 0x80) n = 0;
		}
		if (n == 2) c = ((c & 0x1f) << 6) | (s[1] & 0x3f);
		else if (n == 3) c = ((c & 0x0f) << 12) | ((uint32_t)(s[1] & 0x3f) << 6) | (s[2] & 0x3f);
		else if (n == 4) c = ((c & 0x07) << 18) | ((uint32_t)(s[1] & 0x3f) << 12) | ((uint32_t)(s[2] & 0x3f) << 6) | (s[3] & 0x3f);
		else {
			c = 0xfffd;
			n = 1;
		}
	}
	*at += n;
	if (c >= 0x10000 && *left == 1) {
		c = 0xd800 + ((c - 0x10000) >> 10);
		*left = 0;
	} else if (*left != SIZE_MAX) {
		*left -= c >= 0x10000 ? 2 : 1;
	}
	*cp = c;
	return true;
}

size_t blitUnits(const char *text) {
	size_t units = 0, at = 0, left = SIZE_MAX;
	uint32_t cp;
	while (step(text, &at, &left, &cp)) units += cp >= 0x10000 ? 2 : 1;
	return units;
}

/** the byte offset in text where its first `units` UTF-16 units end, at a code point's start */
static size_t byteAt(const char *text, size_t units) {
	size_t at = 0, seen = 0, left = SIZE_MAX;
	uint32_t cp;
	for (;;) {
		size_t before = at;
		if (!step(text, &at, &left, &cp)) return at;
		seen += cp >= 0x10000 ? 2 : 1;
		if (seen > units) return before;
	}
}

/** how far a character moves the pen, in font or the ROM's cells */
static double advance(const Blitter *blitter, uint32_t cp, const BlitFont *font) {
	if (!font) return blitter->rom.w;
	const BlitPage *page = font->page(font->data, (int)(cp >> 8));
	return page ? page->info[(cp & 255) * 4 + 3] : font->ascent / 2;
}

/** how wide the first `units` UTF-16 units of text are */
static int measureUnits(const Blitter *blitter, const char *text, size_t units, const BlitFont *font) {
	size_t at = 0, left = units;
	uint32_t cp;
	if (!font) {
		int64_t n = 0;
		while (step(text, &at, &left, &cp)) n++;
		return clampInt(n * blitter->rom.w, -BIG, BIG);
	}
	double pen = 0;
	while (step(text, &at, &left, &cp)) pen += advance(blitter, cp, font);
	return whole(roundHalfUp(pen), -BIG, BIG);
}

int blitMeasure(const Blitter *blitter, const char *text, const BlitFont *font) {
	return measureUnits(blitter, text, SIZE_MAX, font);
}

int blitHeight(const Blitter *blitter, const BlitFont *font) {
	return font ? font->h : blitter->rom.h;
}

size_t blitAt(const Blitter *blitter, const char *text, double dx, const BlitFont *font) {
	double pen = 0;
	size_t i = 0, at = 0, left = SIZE_MAX;
	uint32_t cp;
	while (step(text, &at, &left, &cp)) {
		double a = advance(blitter, cp, font);
		if (pen + a / 2 > dx) return i;
		pen += a;
		i += cp >= 0x10000 ? 2 : 1;
	}
	return i;
}

size_t blitFit(const Blitter *blitter, const char *text, double w, const BlitFont *font) {
	size_t n = 0, at = 0, left = SIZE_MAX;
	uint32_t cp;
	if (!font) {
		while (step(text, &at, &left, &cp)) n++;
		double cells = blitter->rom.w > 0 ? floor(w / blitter->rom.w) : 0;
		return cells <= 0 ? 0 : cells < (double)n ? (size_t)cells : n;
	}
	double pen = 0;
	while (step(text, &at, &left, &cp)) {
		pen += advance(blitter, cp, font);
		if (pen > w) break;
		n++;
	}
	return n;
}

// the blitter and forms ---------------------------------------------------------

static int byCodePoint(const void *a, const void *b) {
	const uint32_t *x = a, *y = b;
	return x[0] != y[0] ? (x[0] < y[0] ? -1 : 1) : (x[1] < y[1] ? -1 : x[1] > y[1]);
}

Blitter *blitNew(const BlitRom *rom) {
	Blitter *blitter = allocate(sizeof *blitter);
	blitter->rom = *rom;
	// each character's code point and place, sorted; of one twice, the last counts
	size_t at = 0, left = SIZE_MAX, n = 0;
	uint32_t cp;
	while (step(rom->chars, &at, &left, &cp)) n++;
	uint32_t *pairs = allocate((n ? n : 1) * 2 * sizeof *pairs);
	at = 0;
	left = SIZE_MAX;
	for (size_t i = 0; step(rom->chars, &at, &left, &cp); i++) {
		pairs[2 * i] = cp;
		pairs[2 * i + 1] = (uint32_t)i;
	}
	qsort(pairs, n, 2 * sizeof *pairs, byCodePoint);
	size_t cell = (size_t)rom->w * (size_t)rom->h;
	blitter->length = n * cell;
	blitter->chars = allocate((n ? n : 1) * sizeof *blitter->chars);
	blitter->at = allocate((n ? n : 1) * sizeof *blitter->at);
	blitter->unknown = -1;
	for (size_t i = 0; i < n; i++) {
		if (i + 1 < n && pairs[2 * i + 2] == pairs[2 * i]) continue;
		blitter->chars[blitter->count] = pairs[2 * i];
		blitter->at[blitter->count] = pairs[2 * i + 1] * cell;
		if (pairs[2 * i] == '?') blitter->unknown = (long)blitter->at[blitter->count];
		blitter->count++;
	}
	free(pairs);
	return blitter;
}

void blitFree(Blitter *blitter) {
	if (!blitter) return;
	free(blitter->chars);
	free(blitter->at);
	free(blitter);
}

/** where a character's glyph starts in the ROM's alpha: its own, or '?''s; -1 for none */
static long glyph(const Blitter *blitter, uint32_t cp) {
	int lo = 0, hi = blitter->count;
	while (lo < hi) {
		int mid = lo + (hi - lo) / 2;
		if (blitter->chars[mid] < cp) lo = mid + 1;
		else hi = mid;
	}
	return lo < blitter->count && blitter->chars[lo] == cp ? (long)blitter->at[lo] : blitter->unknown;
}

BlitForm blitForm(int w, int h, uint32_t fill) {
	w = w < 0 ? 0 : w;
	h = h < 0 ? 0 : h;
	BlitForm form = { .w = w, .h = h, .stride = w, .bits = allocate((size_t)w * (size_t)h * sizeof(uint32_t)) };
	for (size_t i = 0; fill && i < (size_t)w * (size_t)h; i++) form.bits[i] = fill;
	return form;
}

// recording ---------------------------------------------------------------------

static Json *opOf(const char *name) {
	Json *op = jsonObject();
	jsonAdd(op, "op", jsonString(name));
	return op;
}

static void addInt(Json *op, const char *key, int64_t n) {
	jsonAdd(op, key, jsonInteger(n));
}

static void addClip(Json *op, const BlitRect *clip) {
	if (!clip) return;
	Json *r = jsonObject();
	addInt(r, "x", clip->x);
	addInt(r, "y", clip->y);
	addInt(r, "w", clip->w);
	addInt(r, "h", clip->h);
	jsonAdd(op, "clip", r);
}

static Json *pointsOf(const int *points, int n) {
	Json *list = jsonArray();
	for (int i = 0; i < 2 * n; i++) jsonPush(list, jsonInteger(points[i]));
	return list;
}

/** fill and frame's op */
static void recordRect(BlitForm *dst, const char *name, int x, int y, int w, int h, uint32_t color, const BlitRect *clip) {
	Json *op = opOf(name);
	addInt(op, "x", x);
	addInt(op, "y", y);
	addInt(op, "w", w);
	addInt(op, "h", h);
	addInt(op, "color", color);
	addClip(op, clip);
	jsonPush(dst->ops, op);
}

BlitForm blitList(int w, int h, const uint32_t *fill) {
	BlitForm form = { .w = w, .h = h, .ops = jsonArray() };
	if (fill) recordRect(&form, "fill", 0, 0, w, h, *fill, NULL);
	return form;
}

// drawing -----------------------------------------------------------------------

/** the part of a rectangle inside a form, and inside clip if given */
static BlitRect clipped(const BlitForm *f, int64_t x, int64_t y, int64_t w, int64_t h, const BlitRect *clip) {
	int64_t x0 = x > 0 ? x : 0, y0 = y > 0 ? y : 0;
	int64_t x1 = x + w < f->w ? x + w : f->w, y1 = y + h < f->h ? y + h : f->h;
	if (clip) {
		if (clip->x > x0) x0 = clip->x;
		if (clip->y > y0) y0 = clip->y;
		if ((int64_t)clip->x + clip->w < x1) x1 = (int64_t)clip->x + clip->w;
		if ((int64_t)clip->y + clip->h < y1) y1 = (int64_t)clip->y + clip->h;
	}
	return (BlitRect){ (int)x0, (int)y0, x1 > x0 ? (int)(x1 - x0) : 0, y1 > y0 ? (int)(y1 - y0) : 0 };
}

/** the whole form, inside clip if given */
static BlitRect drawable(const BlitForm *f, const BlitRect *clip) {
	return clipped(f, 0, 0, f->w, f->h, clip);
}

/** fill's pixels */
static void area(BlitForm *dst, int64_t x, int64_t y, int64_t w, int64_t h, uint32_t color, const BlitRect *clip) {
	BlitRect r = clipped(dst, x, y, w, h, clip);
	for (int ty = r.y; ty < r.y + r.h; ty++) {
		uint32_t *row = dst->bits + (size_t)ty * (size_t)dst->stride;
		for (int tx = r.x; tx < r.x + r.w; tx++) row[tx] = color;
	}
}

void blitFill(BlitForm *dst, int x, int y, int w, int h, uint32_t color, const BlitRect *clip) {
	if (dst->ops) return recordRect(dst, "fill", x, y, w, h, color, clip);
	area(dst, x, y, w, h, color, clip);
}

void blitFrame(BlitForm *dst, int x, int y, int w, int h, uint32_t color, const BlitRect *clip) {
	if (dst->ops) return recordRect(dst, "frame", x, y, w, h, color, clip);
	area(dst, x, y, w, 1, color, clip);
	area(dst, x, (int64_t)y + h - 1, w, 1, color, clip);
	area(dst, x, y, 1, h, color, clip);
	area(dst, (int64_t)x + w - 1, y, 1, h, color, clip);
}

void blitBlit(BlitForm *dst, int dx, int dy, const BlitForm *src, int sx, int sy, int w, int h, BlitRule rule, const BlitRect *clip) {
	// the source rectangle, inside the source
	int64_t x = dx, y = dy, ww = w, hh = h;
	if (sx < 0) {
		x -= sx;
		ww += sx;
		sx = 0;
	}
	if (sy < 0) {
		y -= sy;
		hh += sy;
		sy = 0;
	}
	if (ww > (int64_t)src->w - sx) ww = (int64_t)src->w - sx;
	if (hh > (int64_t)src->h - sy) hh = (int64_t)src->h - sy;
	if (dst->ops) {
		// the rectangle's pixels, copied: the op is data, and the source may change
		int cw = ww > 0 ? (int)ww : 0, ch = hh > 0 ? (int)hh : 0;
		uint32_t *bits = allocate(((size_t)cw * (size_t)ch + 1) * sizeof *bits);
		for (int ty = 0; ty < ch; ty++) memcpy(bits + (size_t)ty * cw, src->bits + (size_t)(sy + ty) * src->stride + sx, (size_t)cw * sizeof *bits);
		Json *op = opOf("pixels");
		addInt(op, "x", clampInt(x, -BIG, BIG));
		addInt(op, "y", clampInt(y, -BIG, BIG));
		addInt(op, "w", cw);
		addInt(op, "h", ch);
		jsonAdd(op, "bits", jsonTyped(JSON_UINT32, bits, (size_t)cw * (size_t)ch));
		if (rule != BLIT_COPY) jsonAdd(op, "rule", jsonString(rule == BLIT_OVER ? "over" : "blend"));
		addClip(op, clip);
		jsonPush(dst->ops, op);
		free(bits);
		return;
	}
	BlitRect r = clipped(dst, x, y, ww, hh, clip);
	if (r.w <= 0 || r.h <= 0) return;
	int64_t ox = sx + (r.x - x), oy = sy + (r.y - y);
	for (int ty = 0; ty < r.h; ty++) {
		const uint32_t *s = src->bits + (size_t)(oy + ty) * (size_t)src->stride + ox;
		uint32_t *d = dst->bits + (size_t)(r.y + ty) * (size_t)dst->stride + r.x;
		if (rule == BLIT_COPY) {
			memmove(d, s, (size_t)r.w * sizeof *d);
			continue;
		}
		for (int tx = 0; tx < r.w; tx++) {
			uint32_t p = s[tx];
			if (rule == BLIT_OVER) {
				if (p != BLIT_TRANSPARENT) d[tx] = p & 0xffffff;
			} else {
				uint32_t a = 255 - ((p >> 24) & 255);
				if (a) d[tx] = a == 255 ? p & 0xffffff : mix(d[tx], p, a);
			}
		}
	}
}

// lines, polygons and ellipses ----------------------------------------------------

/** for each row of r, the leftmost and rightmost pixel marked on it; top to bottom, the rows marked */
typedef struct Spans {
	BlitRect r;
	int *lo, *hi;
	int top, bottom;
} Spans;

static Spans spansOf(BlitRect r) {
	Spans s = { .r = r, .lo = allocate(((size_t)r.h + 1) * sizeof(int)), .hi = allocate(((size_t)r.h + 1) * sizeof(int)), .top = r.h, .bottom = 0 };
	for (int k = 0; k < r.h; k++) {
		s.lo[k] = INT_MAX;
		s.hi[k] = INT_MIN;
	}
	return s;
}

static void spansFree(Spans *s) {
	free(s->lo);
	free(s->hi);
}

/** x0 to x1 on row y, if it is one of r's */
static void markRow(Spans *s, int y, int x0, int x1) {
	int k = y - s->r.y;
	if (k < 0 || k >= s->r.h) return;
	if (x0 < s->lo[k]) s->lo[k] = x0;
	if (x1 > s->hi[k]) s->hi[k] = x1;
	if (k < s->top) s->top = k;
	if (k + 1 > s->bottom) s->bottom = k + 1;
}

/** each marked row's span, inside r, in color; then no row is marked */
static void paint(BlitForm *dst, Spans *s, uint32_t color) {
	BlitRect r = s->r;
	for (int k = s->top; k < s->bottom; k++) {
		int a = s->lo[k] > r.x ? s->lo[k] : r.x, b = s->hi[k] < r.x + r.w - 1 ? s->hi[k] : r.x + r.w - 1;
		uint32_t *row = dst->bits + (size_t)(r.y + k) * (size_t)dst->stride;
		for (int x = a; x <= b; x++) row[x] = color;
		s->lo[k] = INT_MAX;
		s->hi[k] = INT_MIN;
	}
	s->top = r.h;
	s->bottom = 0;
}

/**
 * A round pen w pixels across: for each of its rows, how far in from its
 * box's left the row's span starts. A pixel is in when its centre is within
 * w / 2 of the box's centre.
 */
typedef struct Pen {
	int w;
	int *in;
} Pen;

static Pen penOf(int w) {
	Pen p = { .w = w, .in = allocate((size_t)w * sizeof(int)) };
	int c = w - 1, i = c >> 1;
	for (int j = 0; j <= c >> 1; j++) {
		while (i > 0 && (2 * i - 2 - c) * (2 * i - 2 - c) + (2 * j - c) * (2 * j - c) <= w * w) i--;
		p.in[j] = p.in[c - j] = i;
	}
	return p;
}

/**
 * The pen at x, y, its box's centre (an even pen's extra row and column
 * right and below), marked if its box meets r: it does not reach r
 * otherwise, and the pens around it fill each row's span.
 */
static void stamp(Spans *s, const Pen *p, int x, int y) {
	int w = p->w, bx = x - ((w - 1) >> 1), by = y - ((w - 1) >> 1);
	BlitRect r = s->r;
	if (bx >= r.x + r.w || bx + w <= r.x || by >= r.y + r.h || by + w <= r.y) return;
	int j0 = r.y - by > 0 ? r.y - by : 0, j1 = r.y + r.h - by < w ? r.y + r.h - by : w;
	for (int j = j0; j < j1; j++) markRow(s, by + j, bx + p->in[j], bx + w - 1 - p->in[j]);
}

/** the pen along a line, Bresenham's: a step in x, in y, or both, whichever stays nearer the line */
static void walk(Spans *s, const Pen *p, int x, int y, int ex, int ey) {
	int dx = abs(ex - x), dy = -abs(ey - y), sx = x < ex ? 1 : -1, sy = y < ey ? 1 : -1;
	int err = dx + dy;
	for (;;) {
		stamp(s, p, x, y);
		if (x == ex && y == ey) return;
		int e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			x += sx;
		}
		if (e2 <= dx) {
			err += dx;
			y += sy;
		}
	}
}

/** a quarter of an ellipse a across and b down, from (a, 0) to (0, b), each point a step from the last: Zingl's, its errors whole numbers */
static void arc(int64_t a, int64_t b, void (*plot)(void *context, int x, int y), void *context) {
	int64_t x = -a, y = 0, e2 = b * b, err = x * (2 * e2 + x) + e2;
	do {
		plot(context, (int)-x, (int)y);
		e2 = 2 * err;
		if (e2 >= (x * 2 + 1) * b * b) {
			x++;
			err += (x * 2 + 1) * b * b;
		}
		if (e2 <= (y * 2 + 1) * a * a) {
			y++;
			err += (y * 2 + 1) * a * a;
		}
	} while (x <= 0);
	// a flat ellipse stops early: its tip
	while (y++ < b) plot(context, 0, (int)y);
}

static void recordLine(BlitForm *dst, int x0, int y0, int x1, int y1, int width, uint32_t color, const BlitRect *clip) {
	Json *op = opOf("line");
	addInt(op, "x0", x0);
	addInt(op, "y0", y0);
	addInt(op, "x1", x1);
	addInt(op, "y1", y1);
	if (width != 1) addInt(op, "width", width);
	addInt(op, "color", color);
	addClip(op, clip);
	jsonPush(dst->ops, op);
}

void blitLine(BlitForm *dst, int x0, int y0, int x1, int y1, int width, uint32_t color, const BlitRect *clip) {
	if (dst->ops) return recordLine(dst, x0, y0, x1, y1, width, color, clip);
	BlitRect r = drawable(dst, clip);
	if (r.w <= 0 || r.h <= 0) return;
	Spans s = spansOf(r);
	Pen p = penOf(clampInt(width, 1, WIDEST));
	walk(&s, &p, clampInt(x0, -FAR, FAR), clampInt(y0, -FAR, FAR), clampInt(x1, -FAR, FAR), clampInt(y1, -FAR, FAR));
	paint(dst, &s, color);
	spansFree(&s);
	free(p.in);
}

void blitPoly(BlitForm *dst, const int *points, int n, int width, uint32_t color, const BlitRect *clip) {
	if (dst->ops) {
		Json *op = opOf("poly");
		jsonAdd(op, "points", pointsOf(points, n));
		if (width != 1) addInt(op, "width", width);
		addInt(op, "color", color);
		addClip(op, clip);
		jsonPush(dst->ops, op);
		return;
	}
	BlitRect r = drawable(dst, clip);
	if (r.w <= 0 || r.h <= 0 || n <= 0) return;
	Spans s = spansOf(r);
	Pen p = penOf(clampInt(width, 1, WIDEST));
	// one point is a dot; each line is painted alone, as its rows are one span each
	for (int i = 0; i < (n > 1 ? n - 1 : 1); i++) {
		int j = i + 1 < n - 1 ? i + 1 : n - 1;
		walk(&s, &p, clampInt(points[2 * i], -FAR, FAR), clampInt(points[2 * i + 1], -FAR, FAR), clampInt(points[2 * j], -FAR, FAR), clampInt(points[2 * j + 1], -FAR, FAR));
		paint(dst, &s, color);
	}
	spansFree(&s);
	free(p.in);
}

/** where an edge crosses a row's centre line: the first pixel whose centre is right of it; and which way the edge goes */
typedef struct Crossing {
	int64_t x;
	int dir;
} Crossing;

static int byX(const void *a, const void *b) {
	const Crossing *p = a, *q = b;
	return p->x < q->x ? -1 : p->x > q->x;
}

void blitFillpoly(BlitForm *dst, const int *points, int n, bool odd, uint32_t color, const BlitRect *clip) {
	if (dst->ops) {
		Json *op = opOf("fillpoly");
		jsonAdd(op, "points", pointsOf(points, n));
		if (odd) jsonAdd(op, "wind", jsonString("odd"));
		addInt(op, "color", color);
		addClip(op, clip);
		jsonPush(dst->ops, op);
		return;
	}
	BlitRect r = drawable(dst, clip);
	if (r.w <= 0 || r.h <= 0 || n <= 0) return;
	int64_t *xs = allocate((size_t)n * sizeof *xs), *ys = allocate((size_t)n * sizeof *ys);
	int64_t top = FAR, bottom = -FAR;
	for (int i = 0; i < n; i++) {
		xs[i] = clampInt(points[2 * i], -FAR, FAR);
		ys[i] = clampInt(points[2 * i + 1], -FAR, FAR);
		if (ys[i] < top) top = ys[i];
		if (ys[i] > bottom) bottom = ys[i];
	}
	if (top < r.y) top = r.y;
	if (bottom > r.y + r.h) bottom = r.y + r.h;
	Crossing *cross = allocate((size_t)n * sizeof *cross);
	for (int64_t y = top; y < bottom; y++) {
		int count = 0;
		for (int i = 0; i < n; i++) {
			int j = (i + 1) % n, dir = 1;
			int64_t x0 = xs[i], y0 = ys[i], x1 = xs[j], y1 = ys[j];
			if (y0 == y1) continue;
			if (y0 > y1) {
				x0 = xs[j], y0 = ys[j], x1 = xs[i], y1 = ys[i], dir = -1;
			}
			if (y < y0 || y >= y1) continue;
			// x at y + 1/2, less 1/2, rounded up: ((2x0 - 1)(y1 - y0) + (2y + 1 - 2y0)(x1 - x0)) / 2(y1 - y0)
			cross[count++] = (Crossing){ up((2 * x0 - 1) * (y1 - y0) + (2 * y + 1 - 2 * y0) * (x1 - x0), 2 * (y1 - y0)), dir };
		}
		qsort(cross, (size_t)count, sizeof *cross, byX);
		int turns = 0;
		uint32_t *row = dst->bits + (size_t)y * (size_t)dst->stride;
		for (int k = 0; k + 1 < count; k++) {
			turns += cross[k].dir;
			int64_t a = cross[k].x > r.x ? cross[k].x : r.x, b = cross[k + 1].x < r.x + r.w ? cross[k + 1].x : r.x + r.w;
			if (odd ? turns % 2 != 0 : turns != 0) {
				for (int64_t x = a; x < b; x++) row[x] = color;
			}
		}
	}
	free(cross);
	free(xs);
	free(ys);
}

typedef struct Quarters {
	Spans q[4];
	const Pen *pen;
	int cx, cy;
} Quarters;

static void plotQuarters(void *context, int x, int y) {
	Quarters *e = context;
	stamp(&e->q[0], e->pen, e->cx + x, e->cy + y);
	stamp(&e->q[1], e->pen, e->cx - x, e->cy + y);
	stamp(&e->q[2], e->pen, e->cx - x, e->cy - y);
	stamp(&e->q[3], e->pen, e->cx + x, e->cy - y);
}

void blitEllipse(BlitForm *dst, int x, int y, int rx, int ry, int width, uint32_t color, const BlitRect *clip) {
	if (dst->ops) {
		Json *op = opOf("ellipse");
		addInt(op, "x", x);
		addInt(op, "y", y);
		addInt(op, "rx", rx);
		addInt(op, "ry", ry);
		if (width != 1) addInt(op, "width", width);
		addInt(op, "color", color);
		addClip(op, clip);
		jsonPush(dst->ops, op);
		return;
	}
	int a = clampInt(rx, -1, RADIUS), b = clampInt(ry, -1, RADIUS);
	BlitRect r = drawable(dst, clip);
	if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return;
	Pen p = penOf(clampInt(width, 1, WIDEST));
	// a quarter at a time, so that each quarter's pixels on a row are one span
	Quarters e = { .pen = &p, .cx = clampInt(x, -FAR, FAR), .cy = clampInt(y, -FAR, FAR) };
	for (int i = 0; i < 4; i++) e.q[i] = spansOf(r);
	arc(a, b, plotQuarters, &e);
	for (int i = 0; i < 4; i++) {
		paint(dst, &e.q[i], color);
		spansFree(&e.q[i]);
	}
	free(p.in);
}

typedef struct Filled {
	Spans s;
	int cx, cy;
} Filled;

static void plotFilled(void *context, int x, int y) {
	Filled *e = context;
	markRow(&e->s, e->cy + y, e->cx - x, e->cx + x);
	markRow(&e->s, e->cy - y, e->cx - x, e->cx + x);
}

void blitFillellipse(BlitForm *dst, int x, int y, int rx, int ry, uint32_t color, const BlitRect *clip) {
	if (dst->ops) {
		Json *op = opOf("fillellipse");
		addInt(op, "x", x);
		addInt(op, "y", y);
		addInt(op, "rx", rx);
		addInt(op, "ry", ry);
		addInt(op, "color", color);
		addClip(op, clip);
		jsonPush(dst->ops, op);
		return;
	}
	int a = clampInt(rx, -1, RADIUS), b = clampInt(ry, -1, RADIUS);
	BlitRect r = drawable(dst, clip);
	if (a < 0 || b < 0 || r.w <= 0 || r.h <= 0) return;
	Filled e = { .s = spansOf(r), .cx = clampInt(x, -FAR, FAR), .cy = clampInt(y, -FAR, FAR) };
	arc(a, b, plotFilled, &e);
	paint(dst, &e.s, color);
	spansFree(&e.s);
}

// text --------------------------------------------------------------------------

/** w × h of coverage, from alpha (length bytes) at offset at with rows of stride, as fg onto dst at x, y, inside r */
static void coverage(BlitForm *dst, BlitRect r, int x, int y, const uint8_t *alpha, size_t length, int stride, int64_t at, int w, int h, uint32_t fg) {
	int64_t y0 = y > r.y ? y : r.y, y1 = (int64_t)y + h < (int64_t)r.y + r.h ? (int64_t)y + h : (int64_t)r.y + r.h;
	int64_t x0 = x > r.x ? x : r.x, x1 = (int64_t)x + w < (int64_t)r.x + r.w ? (int64_t)x + w : (int64_t)r.x + r.w;
	for (int64_t ty = y0; ty < y1; ty++) {
		int64_t row = at + (ty - y) * stride - x;
		uint32_t *d = dst->bits + (size_t)ty * (size_t)dst->stride;
		for (int64_t tx = x0; tx < x1; tx++) {
			int64_t i = row + tx;
			if (i < 0 || (uint64_t)i >= length) continue;
			uint32_t a = alpha[i];
			if (!a) continue;
			d[tx] = a == 255 ? fg : mix(d[tx], fg, a);
		}
	}
}

static int proportional(BlitForm *dst, int x, int y, const char *text, uint32_t fg, const uint32_t *bg, const BlitRect *clip, const BlitFont *font) {
	BlitRect r = drawable(dst, clip);
	double pen = x;
	size_t at = 0, left = SIZE_MAX;
	uint32_t cp;
	while (step(text, &at, &left, &cp)) {
		const BlitPage *page = font->page(font->data, (int)(cp >> 8));
		// a page still coming: a gap, until it comes and the text is drawn again
		if (!page) {
			pen += font->ascent / 2;
			continue;
		}
		const double *info = page->info + (cp & 255) * 4;
		double w = info[2], adv = info[3];
		int start = whole(roundHalfUp(pen), -BIG, BIG);
		if (bg) blitFill(dst, start, y, whole(roundHalfUp(pen + adv), -BIG, BIG) - start, font->h, *bg, clip);
		if (w != 0 && !isnan(w)) coverage(dst, r, clampInt((int64_t)start + whole(info[1], -BIG, BIG), -BIG, BIG), y, page->alpha, page->length, page->w, whole(info[0], -BIG, BIG), whole(w, -BIG, BIG), font->h, fg);
		pen += adv;
	}
	return whole(roundHalfUp(pen), -BIG, BIG);
}

int blitText(const Blitter *blitter, BlitForm *dst, int x, int y, const char *text, uint32_t fg, const uint32_t *bg, const BlitRect *clip, const BlitFont *font) {
	if (dst->ops) {
		Json *op = opOf("text");
		addInt(op, "x", x);
		addInt(op, "y", y);
		jsonAdd(op, "text", jsonString(text));
		addInt(op, "color", fg);
		jsonAdd(op, "font", font && font->role ? jsonString(font->role) : jsonNull());
		if (bg) addInt(op, "bg", *bg);
		addClip(op, clip);
		jsonPush(dst->ops, op);
		return clampInt((int64_t)x + blitMeasure(blitter, text, font), -BIG, BIG);
	}
	if (font) return proportional(dst, x, y, text, fg, bg, clip, font);
	int cw = blitter->rom.w, ch = blitter->rom.h;
	BlitRect r = drawable(dst, clip);
	size_t at = 0, left = SIZE_MAX;
	uint32_t cp;
	while (step(text, &at, &left, &cp)) {
		long g = glyph(blitter, cp);
		if (bg) blitFill(dst, x, y, cw, ch, *bg, clip);
		if (g >= 0) coverage(dst, r, x, y, blitter->rom.alpha, blitter->length, cw, g, cw, ch, fg);
		x = clampInt((int64_t)x + cw, -BIG, BIG);
	}
	return x;
}

// the draw device -----------------------------------------------------------------

/** an op's number, or 0 */
static double number(const Json *op, const char *key) {
	const Json *n = jsonGet(op, key);
	return jsonIsNumber(n) ? n->number : 0;
}

static int coordinate(const Json *op, const char *key) {
	return whole(number(op, key), -BIG, BIG);
}

static uint32_t colorOf(const Json *op, const char *key) {
	return toUint32(number(op, key));
}

/** an op's width: 1 when it has none */
static int widthOf(const Json *op) {
	const Json *n = jsonGet(op, "width");
	return jsonIsNumber(n) ? whole(n->number, -BIG, BIG) : 1;
}

/** an op's clip, if it has one, inside within, if given */
static const BlitRect *clipOf(const Json *op, BlitRect *out, const BlitRect *within) {
	const Json *c = jsonGet(op, "clip");
	if (!jsonIsObject(c)) {
		if (!within) return NULL;
		*out = *within;
		return out;
	}
	*out = (BlitRect){ coordinate(c, "x"), coordinate(c, "y"), coordinate(c, "w"), coordinate(c, "h") };
	if (within) {
		int x0 = out->x > within->x ? out->x : within->x, y0 = out->y > within->y ? out->y : within->y;
		int x1 = out->x + out->w < within->x + within->w ? out->x + out->w : within->x + within->w;
		int y1 = out->y + out->h < within->y + within->h ? out->y + out->h : within->y + within->h;
		*out = (BlitRect){ x0, y0, x1 > x0 ? x1 - x0 : 0, y1 > y0 ? y1 - y0 : 0 };
	}
	return out;
}

/** an op's points, x, y, x, y..., a list, bytes or a typed array, as whole numbers; *n the points */
static int *pointsIn(const Json *op, int *n) {
	const Json *p = jsonGet(op, "points");
	size_t count = jsonIsArray(p) ? (size_t)p->array.count : p && p->type == JSON_TYPED ? p->typed.count : p && p->type == JSON_BYTES ? p->bytes.length : 0;
	int *points = allocate((count + 1) * sizeof *points);
	for (size_t i = 0; i < count; i++) {
		double v = 0;
		if (jsonIsArray(p)) v = jsonIsNumber(p->array.items[i]) ? p->array.items[i]->number : 0;
		else if (p->type == JSON_BYTES) v = ((const uint8_t *)p->bytes.data)[i];
		else {
			const char *at = (const char *)p->typed.data + i * jsonKindSize(p->typed.kind);
			switch (p->typed.kind) {
				case JSON_INT8: v = *(const int8_t *)at; break;
				case JSON_INT16: v = *(const int16_t *)at; break;
				case JSON_UINT16: v = *(const uint16_t *)at; break;
				case JSON_INT32: v = *(const int32_t *)at; break;
				case JSON_UINT32: v = *(const uint32_t *)at; break;
				case JSON_INT64: v = (double)*(const int64_t *)at; break;
				case JSON_UINT64: v = (double)*(const uint64_t *)at; break;
				case JSON_FLOAT32: v = *(const float *)at; break;
				default: v = *(const double *)at; break;
			}
		}
		points[i] = whole(v, -BIG, BIG);
	}
	*n = (int)(count / 2);
	return points;
}

/** where JavaScript's text.slice(0, end) ends, in UTF-16 units of `units` */
static size_t sliceEnd(double end, size_t units) {
	if (isnan(end)) return 0;
	end = trunc(end);
	if (end < 0) return end + (double)units > 0 ? (size_t)(end + (double)units) : 0;
	return end < (double)units ? (size_t)end : units;
}

/** the mark on op i: the last of marks' [op, from, to] for it */
static const Json *markOf(const Json *marks, int i) {
	if (!jsonIsArray(marks)) return NULL;
	for (int k = marks->array.count; k-- > 0;) {
		const Json *m = marks->array.items[k];
		if (jsonIsArray(m) && m->array.count >= 1 && jsonIsNumber(m->array.items[0]) && m->array.items[0]->number == i) return m;
	}
	return NULL;
}

static const BlitFont *fontOf(BlitFonts fonts, void *data, const char *role) {
	return fonts && role && *role ? fonts(data, role) : NULL;
}

static void playText(const Blitter *blitter, BlitForm *dst, const Json *o, int i, BlitFonts fonts, void *data, const Json *marks, uint32_t mark, Json *runs, const BlitRect *within) {
	const Json *text = jsonGet(o, "text"), *role = jsonGet(o, "font"), *bg = jsonGet(o, "bg");
	if (!jsonIsString(text)) return;
	const BlitFont *font = fontOf(fonts, data, jsonText(role));
	int x = coordinate(o, "x"), y = coordinate(o, "y");
	int w = blitMeasure(blitter, text->string, font), h = blitHeight(blitter, font);
	BlitRect given;
	const BlitRect *clip = clipOf(o, &given, within);
	Json *run = jsonObject();
	jsonAdd(run, "op", jsonInteger(i));
	jsonAdd(run, "x", jsonNumber(number(o, "x")));
	jsonAdd(run, "y", jsonNumber(number(o, "y")));
	jsonAdd(run, "w", jsonInteger(w));
	jsonAdd(run, "h", jsonInteger(h));
	jsonAdd(run, "text", jsonStringOfLength(text->string, text->stringLength));
	jsonAdd(run, "font", jsonIsString(role) ? jsonStringOfLength(role->string, role->stringLength) : jsonNull());
	jsonPush(runs, run);
	if (bg) blitFill(dst, x, y, w, h, jsonIsNumber(bg) ? toUint32(bg->number) : 0, clip);
	const Json *m = markOf(marks, i);
	if (m && m->array.count >= 3 && jsonIsNumber(m->array.items[1]) && jsonIsNumber(m->array.items[2])) {
		size_t units = blitUnits(text->string);
		int64_t a = (int64_t)x + measureUnits(blitter, text->string, sliceEnd(m->array.items[1]->number, units), font);
		int64_t b = (int64_t)x + measureUnits(blitter, text->string, sliceEnd(m->array.items[2]->number, units), font);
		blitFill(dst, clampInt(a, -BIG, BIG), y, clampInt(b - a, -BIG, BIG), h, mark, clip);
	}
	blitText(blitter, dst, x, y, text->string, colorOf(o, "color"), NULL, clip, font);
}

Json *blitPlay(const Blitter *blitter, BlitForm *dst, const Json *ops, BlitFonts fonts, void *data, const Json *marks, uint32_t mark) {
	return blitPlayIn(blitter, dst, ops, fonts, data, marks, mark, NULL);
}

Json *blitPlayIn(const Blitter *blitter, BlitForm *dst, const Json *ops, BlitFonts fonts, void *data, const Json *marks, uint32_t mark, const BlitRect *within) {
	Json *runs = jsonArray();
	if (!jsonIsArray(ops)) return runs;
	for (int i = 0; i < ops->array.count; i++) {
		const Json *o = ops->array.items[i];
		const char *name = jsonText(jsonGet(o, "op"));
		if (!name) continue;
		BlitRect given;
		const BlitRect *clip = clipOf(o, &given, within);
		if (!strcmp(name, "fill")) blitFill(dst, coordinate(o, "x"), coordinate(o, "y"), coordinate(o, "w"), coordinate(o, "h"), colorOf(o, "color"), clip);
		else if (!strcmp(name, "frame")) blitFrame(dst, coordinate(o, "x"), coordinate(o, "y"), coordinate(o, "w"), coordinate(o, "h"), colorOf(o, "color"), clip);
		else if (!strcmp(name, "pixels")) {
			const Json *bits = jsonGet(o, "bits"), *rule = jsonGet(o, "rule"), *repl = jsonGet(o, "repl");
			int x = coordinate(o, "x"), y = coordinate(o, "y"), w = coordinate(o, "w"), h = coordinate(o, "h");
			// repl {w, h}: the bits are a tile that w × h repeats, from its corner at x, y (Plan 9's repl)
			int tw = repl ? coordinate(repl, "w") : w, th = repl ? coordinate(repl, "h") : h;
			// the bits must hold the form's pixels
			if (!bits || bits->type != JSON_TYPED || (bits->typed.kind != JSON_UINT32 && bits->typed.kind != JSON_INT32) || w <= 0 || h <= 0 || tw <= 0 || th <= 0) continue;
			if ((uint64_t)tw * (uint64_t)th > bits->typed.count) continue;
			BlitForm src = { .w = tw, .h = th, .stride = tw, .bits = bits->typed.data };
			// as the model's: none or "copy" is copy, "over" over, and anything else blend
			BlitRule how = !rule || rule->type == JSON_NULL ? BLIT_COPY : !jsonIsString(rule) ? BLIT_BLEND : !strcmp(rule->string, "copy") ? BLIT_COPY : !strcmp(rule->string, "over") ? BLIT_OVER : BLIT_BLEND;
			for (int ty = 0; ty < h; ty += th)
				for (int tx = 0; tx < w; tx += tw) blitBlit(dst, x + tx, y + ty, &src, 0, 0, tw < w - tx ? tw : w - tx, th < h - ty ? th : h - ty, how, clip);
		} else if (!strcmp(name, "text")) playText(blitter, dst, o, i, fonts, data, marks, mark, runs, within);
		else if (!strcmp(name, "line")) blitLine(dst, coordinate(o, "x0"), coordinate(o, "y0"), coordinate(o, "x1"), coordinate(o, "y1"), widthOf(o), colorOf(o, "color"), clip);
		else if (!strcmp(name, "ellipse")) blitEllipse(dst, coordinate(o, "x"), coordinate(o, "y"), coordinate(o, "rx"), coordinate(o, "ry"), widthOf(o), colorOf(o, "color"), clip);
		else if (!strcmp(name, "fillellipse")) blitFillellipse(dst, coordinate(o, "x"), coordinate(o, "y"), coordinate(o, "rx"), coordinate(o, "ry"), colorOf(o, "color"), clip);
		else if (!strcmp(name, "poly") || !strcmp(name, "fillpoly")) {
			int n;
			int *points = pointsIn(o, &n);
			const char *wind = jsonText(jsonGet(o, "wind"));
			if (name[0] == 'p') blitPoly(dst, points, n, widthOf(o), colorOf(o, "color"), clip);
			else blitFillpoly(dst, points, n, wind && !strcmp(wind, "odd"), colorOf(o, "color"), clip);
			free(points);
		}
	}
	return runs;
}

bool blitOpBox(const Blitter *blitter, const Json *o, BlitFonts fonts, void *data, BlitRect *out) {
	const char *name = jsonText(jsonGet(o, "op"));
	int64_t x0 = 0, y0 = 0, x1 = 0, y1 = 0, pad = 2;
	if (!name) {
		*out = (BlitRect){ 0 };
		return true;
	}
	if (!strcmp(name, "fill") || !strcmp(name, "frame") || !strcmp(name, "pixels")) {
		x0 = coordinate(o, "x"), y0 = coordinate(o, "y"), x1 = x0 + coordinate(o, "w"), y1 = y0 + coordinate(o, "h");
	} else if (!strcmp(name, "text")) {
		const Json *text = jsonGet(o, "text");
		if (!jsonIsString(text)) {
			*out = (BlitRect){ 0 };
			return true;
		}
		const BlitFont *font = fontOf(fonts, data, jsonText(jsonGet(o, "font")));
		x0 = coordinate(o, "x"), y0 = coordinate(o, "y");
		x1 = x0 + blitMeasure(blitter, text->string, font), y1 = y0 + blitHeight(blitter, font);
		// a glyph may reach past its advance (an italic's, a font's overhang): as far as the line is tall
		pad += y1 - y0;
	} else if (!strcmp(name, "line")) {
		int64_t ax = coordinate(o, "x0"), ay = coordinate(o, "y0"), bx = coordinate(o, "x1"), by = coordinate(o, "y1");
		x0 = ax < bx ? ax : bx, x1 = ax < bx ? bx : ax, y0 = ay < by ? ay : by, y1 = ay < by ? by : ay;
		pad += llabs((long long)widthOf(o));
	} else if (!strcmp(name, "ellipse") || !strcmp(name, "fillellipse")) {
		int64_t x = coordinate(o, "x"), y = coordinate(o, "y"), rx = llabs((long long)coordinate(o, "rx")), ry = llabs((long long)coordinate(o, "ry"));
		x0 = x - rx, x1 = x + rx, y0 = y - ry, y1 = y + ry;
		if (name[0] == 'e') pad += llabs((long long)widthOf(o));
	} else if (!strcmp(name, "poly") || !strcmp(name, "fillpoly")) {
		int n;
		int *points = pointsIn(o, &n);
		for (int i = 0; i < n; i++) {
			int64_t px = points[2 * i], py = points[2 * i + 1];
			if (!i || px < x0) x0 = px;
			if (!i || px > x1) x1 = px;
			if (!i || py < y0) y0 = py;
			if (!i || py > y1) y1 = py;
		}
		free(points);
		if (name[0] == 'p') pad += llabs((long long)widthOf(o));
	} else {
		// an op blitPlay does not know draws nothing
		*out = (BlitRect){ 0 };
		return true;
	}
	x0 -= pad, y0 -= pad, x1 += pad, y1 += pad;
	if (x0 < -BIG || y0 < -BIG || x1 > BIG || y1 > BIG) return false;
	BlitRect given;
	const BlitRect *clip = clipOf(o, &given, NULL);
	if (clip) {
		if (clip->x > x0) x0 = clip->x;
		if (clip->y > y0) y0 = clip->y;
		if (clip->x + clip->w < x1) x1 = clip->x + clip->w;
		if (clip->y + clip->h < y1) y1 = clip->y + clip->h;
	}
	*out = (BlitRect){ (int)x0, (int)y0, x1 > x0 ? (int)(x1 - x0) : 0, y1 > y0 ? (int)(y1 - y0) : 0 };
	return true;
}

/** a run, as select reads it */
typedef struct Run {
	double op, x, y, w, h;
	const char *text, *role;
	size_t units;
} Run;

/** sorts runs into reading order, top to bottom then left to right, keeping the order of runs at one place (a merge sort, stable as JavaScript's) */
static void readingOrder(Run **runs, Run **scratch, int n) {
	if (n < 2) return;
	int half = n / 2;
	readingOrder(runs, scratch, half);
	readingOrder(runs + half, scratch, n - half);
	int i = 0, j = half, k = 0;
	while (i < half && j < n) {
		const Run *a = runs[i], *b = runs[j];
		bool later = b->y < a->y || (b->y == a->y && b->x < a->x);
		scratch[k++] = later ? runs[j++] : runs[i++];
	}
	while (i < half) scratch[k++] = runs[i++];
	while (j < n) scratch[k++] = runs[j++];
	memcpy(runs, scratch, (size_t)n * sizeof *runs);
}

typedef struct Place {
	int k;
	size_t offset;
} Place;

/** a point's place: the run (in reading order) and the offset in it */
static Place place(const Blitter *blitter, Run **order, int n, double px, double py, BlitFonts fonts, void *data) {
	int first = -1, last = -1;
	for (int k = 0; k < n; k++) {
		if (py >= order[k]->y && py < order[k]->y + order[k]->h) {
			if (first < 0) first = k;
			last = k;
		}
	}
	if (first >= 0) {
		if (px < order[first]->x) return (Place){ first, 0 };
		for (int k = first; k <= last; k++) {
			const Run *r = order[k];
			if (!(py >= r->y && py < r->y + r->h)) continue;
			if (px < r->x + r->w) return (Place){ k, blitAt(blitter, r->text, px - r->x, fontOf(fonts, data, r->role)) };
		}
		return (Place){ last, order[last]->units };
	}
	for (int k = 0; k < n; k++) {
		if (order[k]->y > py) return (Place){ k, 0 };
	}
	return (Place){ n - 1, order[n - 1]->units };
}

/** text, grown */
typedef struct Text {
	char *bytes;
	size_t length, room;
} Text;

static void append(Text *t, const char *bytes, size_t length) {
	if (t->length + length + 1 > t->room) {
		t->room = (t->length + length + 1) * 2;
		char *more = allocate(t->room);
		if (t->bytes) memcpy(more, t->bytes, t->length);
		free(t->bytes);
		t->bytes = more;
	}
	memcpy(t->bytes + t->length, bytes, length);
	t->length += length;
	t->bytes[t->length] = 0;
}

Json *blitSelect(const Blitter *blitter, const Json *runs, const double from[2], const double to[2], BlitFonts fonts, void *data) {
	Json *out = jsonObject(), *ranges = jsonArray();
	int count = jsonIsArray(runs) ? runs->array.count : 0, n = 0;
	Run *all = allocate(((size_t)count + 1) * sizeof *all);
	Run **order = allocate(((size_t)count + 1) * sizeof *order), **scratch = allocate(((size_t)count + 1) * sizeof *scratch);
	for (int i = 0; i < count; i++) {
		const Json *r = runs->array.items[i], *text = jsonGet(r, "text");
		if (!jsonIsString(text)) continue;
		all[n] = (Run){ number(r, "op"), number(r, "x"), number(r, "y"), number(r, "w"), number(r, "h"), text->string, jsonText(jsonGet(r, "font")), blitUnits(text->string) };
		order[n] = &all[n];
		n++;
	}
	readingOrder(order, scratch, n);
	Text text = { 0 };
	append(&text, "", 0);
	if (n) {
		Place a = place(blitter, order, n, from[0], from[1], fonts, data), b = place(blitter, order, n, to[0], to[1], fonts, data);
		if (b.k < a.k || (b.k == a.k && b.offset < a.offset)) {
			Place t = a;
			a = b;
			b = t;
		}
		const Run *prev = NULL;
		for (int k = a.k; k <= b.k; k++) {
			const Run *r = order[k];
			size_t start = k == a.k ? a.offset : 0, end = k == b.k ? b.offset : r->units;
			if (end <= start) continue;
			if (prev) {
				if (r->y >= prev->y + prev->h / 2) append(&text, "\n", 1);
				else if (r->x - (prev->x + prev->w) > prev->h / 4) append(&text, " ", 1);
			}
			Json *range = jsonArray();
			jsonPush(range, jsonNumber(r->op));
			jsonPush(range, jsonInteger((int64_t)start));
			jsonPush(range, jsonInteger((int64_t)end));
			jsonPush(ranges, range);
			size_t s = byteAt(r->text, start), e = byteAt(r->text, end);
			append(&text, r->text + s, e - s);
			prev = r;
		}
	}
	jsonAdd(out, "ranges", ranges);
	jsonAdd(out, "text", jsonStringOfLength(text.bytes, text.length));
	free(text.bytes);
	free(all);
	free(order);
	free(scratch);
	return out;
}
