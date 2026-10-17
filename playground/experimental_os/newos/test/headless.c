// headless.c: ermineOS with no window, as the old OS's
// headless metal was: a device tree for no Mac in particular, frame
// buffers in memory, a font ROM and a font chip of boxes, vsync answered at
// once, the serial line on stdin and stdout. A line starting "!" is a hand
// on the machine:
//
//   !key Enter [mods...]   !type text   !click x y   !move x y   !drag x0 y0 x1 y1   !post {record}
//   !compose text   !commit text   !shot file.ppm   !wait ms   !stats label
//   !page id rrggbb [x y w h]   a web page's next frame: that rectangle (all of it) painted, with dirty
//   !nav id url   !replace id url   a web page going there itself (a link, pushState), or its URL replaced (a redirect)
//
// !stats says what the OS commanded since the last, and the CPU it took: each op's count, bytes
// and the pixels it had the metal copy; then counts again.
//
// Layers mode, as the Mac's: the mode record says layers: true, and the
// compositor sends each layer as a tile (layers); this keeps each tile's
// pixels, place, depth and shadow, and !shot stacks them, shadows drawn as
// a Gaussian blur of their box. HEADLESS_LAYERS=0: the frame buffer, flipped,
// as before; HEADLESS_SHADOWS=0: tiles stacked without their shadows, to
// compare with it pixel for pixel. HEADLESS_CURSOR logs each layers command,
// [layers], with flips.
//
// The Mac menu bar's menus command is logged, [menus] n, each menu's title and items (the world
// menu first, titled ermine), with their chords, (on) when checked, a submenu's items in { };
// a choice there is !post {"irq": 33, "event": "menu", "n": n, "menu": m, "item": i, "sub"?: [j]}.
//
//   headless [--w W] [--h H] [--unit U] [--sd DIR] [--image DIR] [--runner FILE] [--fresh]

#define _DARWIN_C_SOURCE

#include "../os.h"

#include "../../../../ermine/encoding/c/json.h"
#include "../../../../ermine/encoding/c/json_text.h"
#include "../drv.h"

#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <sys/resource.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <CoreText/CoreText.h>

static int W = 800, H = 500, U = 1;
static uint32_t *buffers[2];
static uint32_t *planes[2]; // the device tree's page planes, unused: a web page's plane is its driver's file
static struct {
	int buffer, w, h;
} shown;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void post(const char *format, ...) __attribute__((format(printf, 1, 2)));
static int64_t now(void);

/** windows mode: the Mac windows the OS made, as the metal keeps them */
static bool windowsMode;
static struct Surf {
	char id[128];
	int w, h;
	uint32_t *bits;
} surfs[64];
static int nsurfs;

static struct Surf *surf(const char *id) {
	for (int i = 0; i < nsurfs; i++) if (!strcmp(surfs[i].id, id)) return &surfs[i];
	return NULL;
}

static void unsurfaceAll(void) {
	for (int i = 0; i < nsurfs; i++) free(surfs[i].bits);
	if (nsurfs) fprintf(stderr, "[unsurface] all %d, back to the monitor\n", nsurfs);
	nsurfs = 0;
}

/** layers mode: the tiles stacked, as the metal keeps them; pixels 0xff000000 are none (BLIT_TRANSPARENT) */
static bool layersOn = true, stacking;
static struct Tile {
	char id[128];
	int x, y, w, h;
	double z;
	bool painted, shadowed;
	uint32_t *bits;
	uint32_t color;
	double opacity, radius, sx, sy;
	int bx, by, bw, bh;
	int corner[4]; // the shadow's box rounded: top left, top right, bottom right, bottom left
} tiles[256];
static int ntiles;
/** web pages: each one's plane file, mapped, as the metal maps it; no engine draws here, so a page is a
 * test colour, 0x3366cc, at the size the compositor shows it, and !page paints a rectangle into its next frame */
static struct Page {
	char id[128];
	uint32_t *bits;
	int mw, mh, w, h, half;
	int64_t n, took;
} pages[16];
static int npages;

/** each page's back and forward list, as WebKit keeps one: a load drops what is ahead and adds its URL; a go moves
 * along it; each change said (list), with the URL and a title (its host) */
static struct List {
	char id[128];
	char *urls[64];
	int n, at;
} lists[32];
static int nlists;
static pthread_mutex_t listing = PTHREAD_MUTEX_INITIALIZER; // the lists: the OS's commands and the hand's !nav, !replace

static struct List *listOf(const char *id) {
	for (int i = 0; id && i < nlists; i++) if (!strcmp(lists[i].id, id)) return &lists[i];
	if (!id || nlists == 32) return NULL;
	struct List *l = &lists[nlists++];
	*l = (struct List){ .at = -1 };
	snprintf(l->id, sizeof l->id, "%s", id);
	return l;
}

/** the page at its list's current URL: url, title and list said */
static void listed(const struct List *l) {
	const char *url = l->urls[l->at], *host = strstr(url, "://");
	host = host ? host + 3 : url;
	post("{\"irq\": 49, \"event\": \"url\", \"id\": \"%s\", \"url\": \"%s\"}", l->id, url);
	post("{\"irq\": 49, \"event\": \"title\", \"id\": \"%s\", \"title\": \"%.*s\"}", l->id, (int)strcspn(host, "/?#"), host);
	char urls[64 * 260] = "", *o = urls;
	for (int i = 0; i < l->n; i++) o += snprintf(o, (size_t)(urls + sizeof urls - o), "%s\"%s\"", i ? ", " : "", l->urls[i]);
	post("{\"irq\": 49, \"event\": \"list\", \"id\": \"%s\", \"urls\": [%s], \"at\": %d}", l->id, urls, l->at);
}

/** a load: what is ahead dropped, the URL added, current */
static void pushed(struct List *l, const char *url) {
	for (int i = l->at + 1; i < l->n; i++) free(l->urls[i]);
	l->n = l->at + 1 < l->n ? l->at + 1 : l->n;
	if (l->n == 64) {
		free(l->urls[0]);
		memmove(l->urls, l->urls + 1, sizeof l->urls[0] * 63);
		l->n--;
	}
	l->urls[l->n++] = strdup(url);
	l->at = l->n - 1;
}

/** !nav id url: the page goes there itself (a link, pushState); !replace id url: its current URL replaced (a redirect, replaceState) */
static void navPage(const char *rest, bool replace) {
	char id[128], url[250];
	if (sscanf(rest, "%127s %249s", id, url) < 2 || strpbrk(url, "\"\\")) return;
	pthread_mutex_lock(&listing);
	struct List *l = listOf(id);
	if (l && l->at >= 0) {
		if (replace) {
			free(l->urls[l->at]);
			l->urls[l->at] = strdup(url);
		} else pushed(l, url);
		listed(l);
	}
	pthread_mutex_unlock(&listing);
}

static struct Page *pageOf(const char *id) {
	for (int i = 0; id && i < npages; i++) if (!strcmp(pages[i].id, id)) return &pages[i];
	return NULL;
}

static struct Tile *tileOf(const char *id) {
	for (int i = 0; i < ntiles; i++) if (!strcmp(tiles[i].id, id)) return &tiles[i];
	return NULL;
}

/** the stack emptied, as the metal empties it off the monitor (lock held) */
static void unlayerAll(void) {
	for (int i = 0; i < ntiles; i++) free(tiles[i].bits);
	ntiles = 0;
}

static double number(const Json *o, const char *key, double otherwise) {
	Json *v = jsonGet(o, key);
	return jsonIsNumber(v) ? v->number : otherwise;
}

/** a layers command: tiles set (placed, painted) and dropped, as the metal's stack takes them; the pixels painted */
static int64_t layers(const Json *c) {
	int b = (int)number(c, "buffer", 0), moved = 0, painted = 0;
	int64_t pixels = 0;
	Json *set = jsonGet(c, "set"), *drop = jsonGet(c, "drop");
	pthread_mutex_lock(&lock);
	for (int i = 0; jsonIsArray(set) && i < set->array.count; i++) {
		Json *item = set->array.items[i];
		const char *id = jsonText(jsonGet(item, "id"));
		if (!id) continue;
		struct Tile *t = tileOf(id);
		if (!t && ntiles < 256) {
			t = &tiles[ntiles++];
			*t = (struct Tile){ 0 };
			snprintf(t->id, sizeof t->id, "%s", id);
		}
		if (!t) continue;
		if (jsonGet(item, "x")) {
			moved++;
			int w = (int)number(item, "w", 0), h = (int)number(item, "h", 0);
			if (w != t->w || h != t->h) {
				free(t->bits);
				t->bits = w > 0 && h > 0 ? malloc((size_t)(w * h) * 4) : NULL;
				for (int k = 0; k < w * h; k++) t->bits[k] = 0xff000000u;
				t->w = w, t->h = h, t->painted = false;
			}
			t->x = (int)number(item, "x", 0), t->y = (int)number(item, "y", 0), t->z = number(item, "z", 0);
			Json *sh = jsonGet(item, "shadow"), *box = jsonGet(sh, "box");
			t->shadowed = jsonIsObject(sh);
			if (t->shadowed) {
				t->color = (uint32_t)number(sh, "color", 0), t->opacity = number(sh, "opacity", 0), t->radius = number(sh, "radius", 0);
				t->sx = number(sh, "x", 0), t->sy = number(sh, "y", 0);
				t->bx = (int)number(box, "x", 0), t->by = (int)number(box, "y", 0), t->bw = (int)number(box, "w", t->w), t->bh = (int)number(box, "h", t->h);
				Json *cs = jsonGet(sh, "corners");
				for (int q = 0; q < 4; q++) t->corner[q] = jsonIsArray(cs) && cs->array.count == 4 && jsonIsNumber(cs->array.items[q]) ? (int)cs->array.items[q]->number : 0;
			}
		}
		Json *p = jsonGet(item, "paint");
		if (p) {
			int sx = (int)number(p, "sx", 0), sy = (int)number(p, "sy", 0), x = (int)number(p, "x", 0), y = (int)number(p, "y", 0), w = (int)number(p, "w", 0), h = (int)number(p, "h", 0);
			bool ok = t->bits && b >= 0 && b < 2 && x >= 0 && y >= 0 && x + w <= t->w && y + h <= t->h && sx >= 0 && sy >= 0 && sx + w <= W && sy + h <= H;
			if (!ok) fprintf(stderr, "[layers] %s: paint %dx%d at %d,%d from %d,%d OUT OF RANGE\n", id, w, h, x, y, sx, sy);
			else {
				for (int row = 0; row < h; row++) memcpy(t->bits + (size_t)(y + row) * (size_t)t->w + x, buffers[b] + (size_t)(sy + row) * (size_t)W + sx, (size_t)w * 4);
				t->painted = true;
				painted++;
				pixels += (int64_t)w * h;
			}
		}
	}
	for (int i = 0; jsonIsArray(drop) && i < drop->array.count; i++) {
		struct Tile *t = tileOf(jsonText(drop->array.items[i]) ? jsonText(drop->array.items[i]) : "");
		if (!t) continue;
		free(t->bits);
		*t = tiles[--ntiles];
	}
	pthread_mutex_unlock(&lock);
	if (getenv("HEADLESS_CURSOR"))
		fprintf(stderr, "[layers] %lld set %d (moved %d, painted %d: %lld pixels), dropped %d\n", (long long)now(), jsonIsArray(set) ? set->array.count : 0, moved, painted, (long long)pixels,
		        jsonIsArray(drop) ? drop->array.count : 0);
	return pixels;
}

static int byZ(const void *a, const void *b) {
	const struct Tile *ta = *(struct Tile *const *)a, *tb = *(struct Tile *const *)b;
	return ta->z < tb->z ? -1 : ta->z > tb->z ? 1 : (ta < tb ? -1 : ta > tb);
}

/** a Gaussian's share of [a, b], sigma s: how much of a blurred edge covers a point */
static double within(double a, double b, double s) {
	return s <= 0 ? (a <= 0 && b > 0) : 0.5 * (erf(b / (s * sqrt(2))) - erf(a / (s * sqrt(2))));
}

/** how many pixels of row k, from a corner's edge, are outside its curve of radius r (drv_display.c's) */
static int notch(int r, int k) {
	if (k < 0 || k >= r) return 0;
	double dy = r - (k + 0.5), n = r - sqrt((double)r * r - dy * dy) - 0.5;
	return n > 0 ? (int)ceil(n) : 0;
}

/** what a box's rounded corners do not cast at pixel x, y: each corner's notched rows, blurred (drv_display.c's) */
static double notched(const int r[4], double x0, double y0, int w, int h, double s, int x, int y) {
	double sum = 0, px = x + 0.5, py = y + 0.5, reach = 3 * s + 1;
	for (int q = 0; q < 4; q++) {
		if (r[q] <= 0) continue;
		bool left = q == 0 || q == 3, top = q < 2;
		double cx = left ? x0 : x0 + w, cy = top ? y0 : y0 + h;
		if (fabs(px - cx) > r[q] + reach || fabs(py - cy) > r[q] + reach) continue;
		for (int k = 0; k < r[q]; k++) {
			int n = notch(r[q], k);
			if (!n) break;
			double ya = top ? y0 + k : y0 + h - 1 - k, xa = left ? x0 : x0 + w - n;
			sum += within(ya - py, ya + 1 - py, s) * within(xa - px, xa + n - px, s);
		}
	}
	return sum;
}

/** the tiles stacked, as the metal's GPU shows them: each one's shadow (its box blurred, as Core Animation's shadowRadius), then its pixels (lock held) */
static void stack(uint32_t *out) {
	for (int i = 0; i < W * H; i++) out[i] = 0;
	struct Tile *order[256];
	for (int i = 0; i < ntiles; i++) order[i] = &tiles[i];
	qsort(order, (size_t)ntiles, sizeof *order, byZ);
	const char *e = getenv("HEADLESS_SHADOWS");
	bool shadows = !e || strcmp(e, "0");
	for (int i = 0; i < ntiles; i++) {
		struct Tile *t = order[i];
		if (!t->painted) continue;
		if (shadows && t->shadowed && t->opacity > 0) {
			double s = t->radius / 2, x0 = t->x + t->bx + t->sx, y0 = t->y + t->by + t->sy;
			int reach = (int)ceil(3 * s) + 1;
			for (int y = (int)floor(y0) - reach; y < y0 + t->bh + reach; y++) {
				if (y < 0 || y >= H) continue;
				double fy = within(y0 - (y + 0.5), y0 + t->bh - (y + 0.5), s);
				for (int x = (int)floor(x0) - reach; x < x0 + t->bw + reach; x++) {
					if (x < 0 || x >= W) continue;
					double a = t->opacity * fy * within(x0 - (x + 0.5), x0 + t->bw - (x + 0.5), s);
					if (t->corner[0] || t->corner[1] || t->corner[2] || t->corner[3]) {
						a -= t->opacity * notched(t->corner, x0, y0, t->bw, t->bh, s, x, y);
						if (a < 0) a = 0;
					}
					uint32_t p = out[y * W + x];
					int r = (int)(((p >> 16) & 255) * (1 - a) + ((t->color >> 16) & 255) * a + 0.5), g = (int)(((p >> 8) & 255) * (1 - a) + ((t->color >> 8) & 255) * a + 0.5),
					    bl = (int)((p & 255) * (1 - a) + (t->color & 255) * a + 0.5);
					out[y * W + x] = (uint32_t)(r << 16 | g << 8 | bl);
				}
			}
		}
		for (int y = 0; y < t->h; y++) {
			if (t->y + y < 0 || t->y + y >= H) continue;
			for (int x = 0; x < t->w; x++) {
				uint32_t p = t->bits[y * t->w + x];
				if (p != 0xff000000u && t->x + x >= 0 && t->x + x < W) out[(t->y + y) * W + t->x + x] = p;
			}
		}
	}
}

/** the mode record the metal sends: in windows mode the main screen's size; on the monitor, layers when it stacks them */
static bool takeover; // as the metal's: full screen, the Mac's ways out off too

static void sendMode(void) {
	pthread_mutex_lock(&lock);
	stacking = layersOn && !windowsMode;
	if (!stacking) unlayerAll();
	pthread_mutex_unlock(&lock);
	post("{\"irq\": 33, \"event\": \"mode\", \"w\": %d, \"h\": %d, \"scale\": %g, \"unit\": %d, \"screen\": \"none\", \"fullscreen\": false, \"windows\": %s, \"layers\": %s, \"takeover\": %s}", W, H, 1.0 / U, U,
	     windowsMode ? "true" : "false", stacking ? "true" : "false", takeover ? "true" : "false");
}

static int64_t now(void) {
	static int64_t start;
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	int64_t t = (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
	if (!start) start = t;
	return t - start;
}

static void post(const char *format, ...) __attribute__((format(printf, 1, 2)));
static void post(const char *format, ...) {
	// as long as it is: a page of a real font (HEADLESS_FONTS) is far past 64 KB
	char head[64], *body = NULL;
	va_list ap;
	va_start(ap, format);
	int n = vasprintf(&body, format, ap);
	va_end(ap);
	if (n < 1 || !body) return;
	snprintf(head, sizeof head, "{\"at\": %lld, ", (long long)now());
	char *rec = formatString("%s%s", head, body + 1);
	free(body);
	ermosPost(rec);
	free(rec);
}

/** a font ROM of boxes: each printable character a box, w × h */
static char *rom(int w, int h) {
	int n = 127 - 32;
	uint8_t *alpha = calloc((size_t)(n * w * h), 1);
	for (int i = 1; i < n; i++)
		for (int y = 3; y < h - 3; y++)
			for (int x = 1; x < w - 1; x++)
				if (y == 3 || y == h - 4 || x == 1 || x == w - 2) alpha[i * w * h + y * w + x] = 200;
	char *b64 = drvBase64(alpha, (size_t)(n * w * h));
	free(alpha);
	char chars[128];
	for (int i = 0; i < n; i++) chars[i] = (char)(32 + i);
	chars[n] = 0;
	Json *f = drvMap("name", jsonString("blocks"), "w", jsonInteger(w), "h", jsonInteger(h), "chars", jsonString(chars), "alpha", jsonString(b64), NULL);
	free(b64);
	char *text = jsonPrint(f);
	return text;
}

/** a page of the font chip, of boxes as wide as the character usually is (metal.ts's blockPage) */
static char *page(double size, bool bold, int n) {
	int ascent = (int)(size * 0.8 + 0.999), descent = (int)(size * 0.25 + 0.999), h = ascent + descent;
	struct G {
		int w, left, top, bottom;
		double advance;
	} g[256];
	int sw = 0;
	for (int i = 0; i < 256; i++) {
		int cp = n * 256 + i;
		if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0xd800 && cp < 0xe000)) {
			g[i] = (struct G){ 0, 0, 0, 0, 0 };
			continue;
		}
		char c = cp < 128 ? (char)cp : 'a';
		double em = c == ' ' ? 0.3 : strchr("iljI.,:;'!|", c) ? 0.28 : strchr("mwMW@", c) ? 0.85 : (c >= 'A' && c <= 'Z') ? 0.68 : (c >= '0' && c <= '9') ? 0.55 : 0.52;
		double advance = (double)(long)(size * em * 64 + 0.5) / 64 + (bold ? size * 0.04 : 0);
		int w = c == ' ' ? 0 : (int)(advance + 0.5) - (int)(size / 12 + 0.5 > 1 ? size / 12 + 0.5 : 1);
		if (c != ' ' && w < 2) w = 2;
		bool small = c >= 'a' && c <= 'z' && !strchr("bdfhklt", c);
		int top = small ? ascent - (int)(size * 0.5 + 0.5) : ascent - (int)(size * 0.7 + 0.5);
		int bottom = strchr("gjpqy", c) ? h - 1 : ascent;
		g[i] = (struct G){ w, 1, top, bottom, advance };
		sw += w;
	}
	if (sw < 1) sw = 1;
	uint8_t *alpha = calloc((size_t)(sw * h), 1);
	Json *info = jsonArray();
	int x = 0, line = bold ? 2 : 1;
	for (int i = 0; i < 256; i++) {
		jsonPush(info, jsonInteger(x));
		jsonPush(info, jsonInteger(g[i].left));
		jsonPush(info, jsonInteger(g[i].w));
		jsonPush(info, jsonNumber(g[i].advance));
		for (int y = g[i].top; y < g[i].bottom; y++)
			for (int gx = 0; gx < g[i].w; gx++)
				if (y < g[i].top + line || y >= g[i].bottom - line || gx < line || gx >= g[i].w - line) alpha[y * sw + x + gx] = 220;
		x += g[i].w;
	}
	char *b64 = drvBase64(alpha, (size_t)(sw * h));
	free(alpha);
	Json *r = drvMap("event", jsonString("glyphs"), "family", jsonString("blocks"), "ascent", jsonInteger(ascent), "descent", jsonInteger(descent),
	                 "leading", jsonInteger(0), "w", jsonInteger(sw), "h", jsonInteger(h), "alpha", jsonString(b64), "info", info, NULL);
	free(b64);
	return jsonPrint(r);
}

// HEADLESS_FONTS=1: the font ROM and the font chip drawn by CoreText, as the Mac's are (../mac/metal's
// FontROM.swift and FontServer.swift), so a shot shows the type a theme names; else boxes, as always

static bool realFonts(void) {
	const char *v = getenv("HEADLESS_FONTS");
	return v && *v && strcmp(v, "0");
}

/** one code point as a line of text in a font, white; in text presentation past ASCII, as the metal's */
static CTLineRef inkLine(CTFontRef font, uint32_t cp, double stroke) {
	UniChar u[3];
	CFIndex n = 0;
	if (cp >= 0x10000) {
		u[n++] = (UniChar)(0xd800 + ((cp - 0x10000) >> 10));
		u[n++] = (UniChar)(0xdc00 + ((cp - 0x10000) & 0x3ff));
	} else u[n++] = (UniChar)cp;
	if (cp >= 0x80) u[n++] = 0xfe0e;
	CFStringRef s = CFStringCreateWithCharacters(NULL, u, n);
	CGColorRef white = CGColorCreateGenericGray(1, 1);
	double width = -4.0;
	CFNumberRef sw = CFNumberCreate(NULL, kCFNumberDoubleType, &width);
	const void *keys[] = { kCTFontAttributeName, kCTForegroundColorAttributeName, kCTStrokeWidthAttributeName, kCTStrokeColorAttributeName };
	const void *vals[] = { font, white, sw, white };
	CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, vals, stroke > 0 ? 4 : 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFAttributedStringRef a = CFAttributedStringCreate(NULL, s, attrs);
	CTLineRef line = CTLineCreateWithAttributedString(a);
	CFRelease(a);
	CFRelease(attrs);
	CFRelease(sw);
	CGColorRelease(white);
	CFRelease(s);
	return line;
}

static CGContextRef inkContext(uint8_t *alpha, int w, int h) {
	CGColorSpaceRef gray = CGColorSpaceCreateDeviceGray();
	CGContextRef ctx = CGBitmapContextCreate(alpha, (size_t)w, (size_t)h, 8, (size_t)w, gray, (CGBitmapInfo)kCGImageAlphaNone);
	CGColorSpaceRelease(gray);
	if (!ctx) return NULL;
	CGContextSetGrayFillColor(ctx, 0, 1);
	CGContextFillRect(ctx, CGRectMake(0, 0, w, h));
	CGContextSetShouldAntialias(ctx, true);
	CGContextSetShouldSmoothFonts(ctx, false);
	CGContextSetAllowsFontSubpixelPositioning(ctx, false);
	CGContextSetShouldSubpixelPositionFonts(ctx, false);
	CGContextSetTextMatrix(ctx, CGAffineTransformIdentity);
	return ctx;
}

/** the font ROM, Monaco's, in w × h cells, as FontROM.swift makes it: ASCII and its extra characters */
static char *inkRom(int w, int h) {
	static const char *extra = "·•●○◆◇▲▼◀▶←↑→↓…°±×÷─│┌┐└┘├┤┬┴┼═║╔╗╚╝╭╮╯╰█▀▄▌▐░▒▓■□▪▫✓✗⏻⚡";
	uint32_t cps[256];
	int n = 0;
	for (int c = 32; c < 127; c++) cps[n++] = (uint32_t)c;
	for (const unsigned char *p = (const unsigned char *)extra; *p && n < 256;) {
		int k = *p >= 0xf0 ? 4 : *p >= 0xe0 ? 3 : 2;
		uint32_t cp = *p & (k == 4 ? 0x07 : k == 3 ? 0x0f : 0x1f);
		for (int j = 1; j < k; j++) cp = (cp << 6) | (p[j] & 0x3f);
		cps[n++] = cp;
		p += k;
	}
	CTFontRef base = CTFontCreateWithName(CFSTR("Monaco"), 12, NULL);
	UniChar m = 'M';
	CGGlyph glyph = 0;
	CGSize advance = { 0, 0 };
	CTFontGetGlyphsForCharacters(base, &m, &glyph, 1);
	CTFontGetAdvancesForGlyphs(base, kCTFontOrientationHorizontal, &glyph, &advance, 1);
	double size = w / (advance.width / 12), line = (CTFontGetAscent(base) + CTFontGetDescent(base)) / 12;
	if (line * size > h) size = h / line;
	CTFontRef font = CTFontCreateCopyWithAttributes(base, size, NULL, NULL);
	double ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font);
	double baseline = h - round((h - (ascent + descent)) / 2 + ascent);
	uint8_t *alpha = calloc((size_t)(n * w * h), 1);
	for (int i = 0; i < n; i++) {
		CGContextRef ctx = inkContext(alpha + (size_t)i * (size_t)(w * h), w, h);
		if (!ctx) continue;
		CTLineRef l = inkLine(font, cps[i], 0);
		// one wider than the cell, from a fallback font, squeezed into it; a narrower one centred
		double width = CTLineGetTypographicBounds(l, NULL, NULL, NULL);
		if (width > w * 1.05) {
			CGContextTranslateCTM(ctx, 0, baseline);
			CGContextScaleCTM(ctx, w / width, 1);
			CGContextSetTextPosition(ctx, 0, 0);
		} else CGContextSetTextPosition(ctx, fabs(width - w) > 0.5 ? round((w - width) / 2) : 0, baseline);
		CTLineDraw(l, ctx);
		CGContextFlush(ctx);
		CFRelease(l);
		CGContextRelease(ctx);
	}
	CFRelease(font);
	CFRelease(base);
	char *b64 = drvBase64(alpha, (size_t)(n * w * h));
	free(alpha);
	char chars[1024];
	snprintf(chars, sizeof chars, "%s", "");
	for (int c = 32; c < 127; c++) chars[c - 32] = (char)c;
	snprintf(chars + 95, sizeof chars - 95, "%s", extra);
	Json *f = drvMap("name", jsonString("Monaco"), "w", jsonInteger(w), "h", jsonInteger(h), "chars", jsonString(chars), "alpha", jsonString(b64), NULL);
	free(b64);
	return jsonPrint(f);
}

/** a page of the font chip, as FontServer.swift renders it: the bold face if there is one, else the outlines stroked */
static char *inkPage(const char *name, double size, bool bold, int n) {
	if (size < 1) size = 1;
	CFStringRef nm = CFStringCreateWithCString(NULL, name && *name ? name : "Helvetica", kCFStringEncodingUTF8);
	CTFontRef font = CTFontCreateWithName(nm, size, NULL);
	CFRelease(nm);
	bool synthetic = false;
	if (bold) {
		CTFontRef b = CTFontCreateCopyWithSymbolicTraits(font, size, NULL, kCTFontTraitBold, kCTFontTraitBold);
		if (b) {
			CFRelease(font);
			font = b;
		} else synthetic = true;
	}
	int ascent = (int)ceil(CTFontGetAscent(font)), descent = (int)ceil(CTFontGetDescent(font)), h = ascent + descent > 1 ? ascent + descent : 1;
	double stroke = synthetic ? size * 0.04 : 0;
	struct G {
		CTLineRef line;
		int left, w;
		double advance;
	} g[256];
	int sw = 0;
	for (int i = 0; i < 256; i++) {
		uint32_t cp = (uint32_t)(n * 256 + i);
		g[i] = (struct G){ NULL, 0, 0, 0 };
		if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0xd800 && cp < 0xe000)) continue;
		CTLineRef line = inkLine(font, cp, stroke);
		g[i].advance = CTLineGetTypographicBounds(line, NULL, NULL, NULL) + stroke * 0.75;
		CGRect ink = CTLineGetBoundsWithOptions(line, kCTLineBoundsUseGlyphPathBounds);
		if (!CGRectIsEmpty(ink) && ink.size.width > 0) {
			int pad = 1 + (int)ceil(stroke);
			g[i].left = (int)floor(CGRectGetMinX(ink)) - pad;
			g[i].w = (int)ceil(CGRectGetMaxX(ink)) + pad - g[i].left;
			g[i].line = line;
			sw += g[i].w;
		} else CFRelease(line);
	}
	if (sw < 1) sw = 1;
	uint8_t *alpha = calloc((size_t)(sw * h), 1);
	CGContextRef ctx = inkContext(alpha, sw, h);
	Json *info = jsonArray();
	int x = 0;
	for (int i = 0; i < 256; i++) {
		jsonPush(info, jsonInteger(x));
		jsonPush(info, jsonInteger(g[i].left));
		jsonPush(info, jsonInteger(g[i].w));
		jsonPush(info, jsonNumber(round(g[i].advance * 64) / 64));
		if (!g[i].line) continue;
		if (ctx) {
			CGContextSaveGState(ctx);
			CGContextClipToRect(ctx, CGRectMake(x, 0, g[i].w, h));
			CGContextSetTextPosition(ctx, x - g[i].left, descent);
			CTLineDraw(g[i].line, ctx);
			CGContextRestoreGState(ctx);
		}
		CFRelease(g[i].line);
		x += g[i].w;
	}
	if (ctx) {
		CGContextFlush(ctx);
		CGContextRelease(ctx);
	}
	char family[256] = "";
	CFStringRef fam = CTFontCopyFamilyName(font);
	CFStringGetCString(fam, family, sizeof family, kCFStringEncodingUTF8);
	CFRelease(fam);
	CFRelease(font);
	char *b64 = drvBase64(alpha, (size_t)(sw * h));
	free(alpha);
	Json *r = drvMap("event", jsonString("glyphs"), "family", jsonString(family), "ascent", jsonInteger(ascent), "descent", jsonInteger(descent),
	                 "leading", jsonInteger(0), "w", jsonInteger(sw), "h", jsonInteger(h), "alpha", jsonString(b64), "info", info, NULL);
	free(b64);
	return jsonPrint(r);
}

/** what the OS has commanded since the last !stats: commands by op, their bytes, and the pixels they had copied */
static struct {
	char op[32][16];
	int64_t n[32], bytes[32], pixels[32];
	int ops;
} stats;

static void count(const char *op, size_t bytes, int64_t pixels) {
	pthread_mutex_lock(&lock);
	int i = 0;
	while (i < stats.ops && strcmp(stats.op[i], op)) i++;
	if (i == stats.ops && stats.ops < 32) snprintf(stats.op[stats.ops++], sizeof stats.op[0], "%s", op);
	if (i < 32) stats.n[i]++, stats.bytes[i] += (int64_t)bytes, stats.pixels[i] += pixels;
	pthread_mutex_unlock(&lock);
}

/** !stats label: what was counted, then counting again */
static void report(const char *label) {
	pthread_mutex_lock(&lock);
	int64_t n = 0, bytes = 0, pixels = 0;
	for (int i = 0; i < stats.ops; i++) {
		fprintf(stderr, "[stats] %s %s: %lld, %lld bytes, %lld pixels\n", label, stats.op[i], (long long)stats.n[i], (long long)stats.bytes[i], (long long)stats.pixels[i]);
		n += stats.n[i], bytes += stats.bytes[i], pixels += stats.pixels[i];
	}
	fprintf(stderr, "[stats] %s all: %lld commands, %lld bytes, %lld pixels copied\n", label, (long long)n, (long long)bytes, (long long)pixels);
	// and the CPU this process took since the last (user and system, ms)
	static double was;
	struct rusage ru;
	getrusage(RUSAGE_SELF, &ru);
	double now = (double)ru.ru_utime.tv_sec * 1000 + ru.ru_utime.tv_usec / 1000.0 + (double)ru.ru_stime.tv_sec * 1000 + ru.ru_stime.tv_usec / 1000.0;
	fprintf(stderr, "[stats] %s cpu: %.0f ms since the last\n", label, now - was);
	was = now;
	memset(&stats, 0, sizeof stats);
	pthread_mutex_unlock(&lock);
}

static int64_t area(const Json *r) {
	return r ? (int64_t)(jsonGet(r, "w") ? jsonGet(r, "w")->number : 0) * (int64_t)(jsonGet(r, "h") ? jsonGet(r, "h")->number : 0) : 0;
}

/** a menu's items, logged: label and chord, (on) when checked, a submenu's in { } */
static void menuItems(const Json *items) {
	for (int k = 0; jsonIsArray(items) && k < items->array.count; k++) {
		const Json *it = items->array.items[k];
		const char *label = jsonText(jsonGet(it, "label")), *key = jsonText(jsonGet(it, "key"));
		const Json *on = jsonGet(it, "on");
		fprintf(stderr, " | %s%s%s%s", label ? label : "-", key ? " " : "", key ? key : "", on && on->type == JSON_BOOLEAN && on->boolean ? " (on)" : "");
		if (jsonIsArray(jsonGet(it, "items"))) {
			fprintf(stderr, " {");
			menuItems(jsonGet(it, "items"));
			fprintf(stderr, " }");
		}
	}
}

/** what the OS commands the hardware */
static void commanded(Json *c, const char *json);

/** what the OS commands the hardware: parsed, done, let go */
static void command(void *data, const char *json) {
	(void)data;
	char *why = NULL;
	Json *c = jsonParse(json, strlen(json), &why);
	commanded(c, json);
	jsonFree(c);
	free(why);
}

static void commanded(Json *c, const char *json) {
	const char *op = jsonText(jsonGet(c, "op"));
	if (op && !strcmp(op, "layers")) {
		if (getenv("HEADLESS_LAYERSLOG")) fprintf(stderr, "[metal] %.400s\n", json);
		count(op, strlen(json), layers(c));
		return;
	}
	if (op) count(op, strlen(json), !strcmp(op, "flip") || !strcmp(op, "present") ? area(jsonGet(c, "dirty")) : 0);
	// HEADLESS_CURSOR: every cursor command (a shape: the metal moves the plane) and flip (the size of what changed, the buffer), with when it came
	if (op && !strcmp(op, "cursor") && getenv("HEADLESS_CURSOR")) fprintf(stderr, "[cursor] %lld %g %g\n", (long long)now(), jsonGet(c, "x") ? jsonGet(c, "x")->number : -1, jsonGet(c, "y") ? jsonGet(c, "y")->number : -1);
	if (op && !strcmp(op, "flip") && getenv("HEADLESS_CURSOR")) {
		Json *d = jsonGet(c, "dirty");
		fprintf(stderr, "[flip] %lld %gx%g %g\n", (long long)now(), jsonGet(d, "w") ? jsonGet(d, "w")->number : -1, jsonGet(d, "h") ? jsonGet(d, "h")->number : -1, jsonGet(c, "buffer")->number);
	}
	if (!op) return;
	if (!strcmp(op, "keychain")) {
		// the Mac's keychain, in memory: said by account, never the password
		static struct {
			char *account, *password;
		} kept[16];
		const char *act = jsonText(jsonGet(c, "act")), *account = jsonText(jsonGet(c, "account")), *password = jsonText(jsonGet(c, "password"));
		if (!act || !account) return;
		int at = -1, room = -1;
		for (int i = 0; i < 16; i++) {
			if (kept[i].account && !strcmp(kept[i].account, account)) at = i;
			if (!kept[i].account && room < 0) room = i;
		}
		fprintf(stderr, "[keychain] %s %s%s\n", act, account, !strcmp(act, "get") ? (at >= 0 ? " (found)" : " (none)") : "");
		if (!strcmp(act, "get")) {
			Json *r = jsonObject();
			jsonAdd(r, "irq", jsonInteger(66));
			jsonAdd(r, "event", jsonString("keychain"));
			jsonAdd(r, "account", jsonString(account));
			jsonAdd(r, "password", at >= 0 ? jsonString(kept[at].password) : jsonNull());
			char *text = jsonPrint(r);
			post("%s", text);
			free(text);
		} else if (!strcmp(act, "set") && password) {
			if (at < 0) at = room;
			if (at < 0) return;
			free(kept[at].account);
			free(kept[at].password);
			kept[at].account = strdup(account);
			kept[at].password = strdup(password);
		} else if (!strcmp(act, "drop") && at >= 0) {
			free(kept[at].account);
			free(kept[at].password);
			kept[at].account = kept[at].password = NULL;
		}
		return;
	}
	if (!strcmp(op, "capture")) {
		// a Mac window captured: its plane file mapped, half 0 a test colour, the view live and its first frame, as ScreenCaptureKit's would give
		const char *path = jsonText(jsonGet(c, "path")), *view = jsonText(jsonGet(c, "view"));
		int64_t mw = (int64_t)(jsonGet(c, "maxw") ? jsonGet(c, "maxw")->number : 0), mh = (int64_t)(jsonGet(c, "maxh") ? jsonGet(c, "maxh")->number : 0);
		fprintf(stderr, "[metal] %.120s\n", json);
		int fd = path ? open(path, O_RDWR) : -1;
		size_t bytes = (size_t)(mw * mh * 4 * 2);
		uint32_t *bits = fd >= 0 && bytes ? mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0) : MAP_FAILED;
		if (fd >= 0) close(fd);
		if (bits == MAP_FAILED || !view || mw < 320 || mh < 200) {
			fprintf(stderr, "[capture] no plane %s\n", path ? path : "?");
			return;
		}
		for (int y = 0; y < 200; y++)
			for (int x = 0; x < 320; x++) bits[y * mw + x] = 0x00cc6633;
		munmap(bits, bytes);
		post("{\"irq\": 51, \"event\": \"view\", \"view\": \"%s\", \"state\": \"live\"}", view);
		post("{\"irq\": 51, \"event\": \"frame\", \"view\": \"%s\", \"n\": 1, \"half\": 0, \"w\": 320, \"h\": 200}", view);
		return;
	}
	if (!strcmp(op, "macdo") && jsonText(jsonGet(c, "act")) && !strcmp(jsonText(jsonGet(c, "act")), "launch")) {
		// an app launched: none is here, so a fake one at pid 15100, named as asked, answers, then
		// comes as NSWorkspace and AX would give it, a window after; "nothing" is no app (bad)
		const char *app = jsonText(jsonGet(c, "app"));
		int64_t req = (int64_t)(jsonGet(c, "req") ? jsonGet(c, "req")->number : 0);
		char name[64];
		int k = 0;
		for (const char *p = app ? app : ""; *p && k < (int)sizeof name - 1; p++)
			if (*p != '"' && *p != '\\') name[k++] = *p;
		name[k] = 0;
		fprintf(stderr, "[metal] %.120s\n", json);
		if (!strcmp(name, "nothing")) {
			post("{\"irq\": 51, \"event\": \"done\", \"req\": %lld, \"error\": \"bad\"}", (long long)req);
			return;
		}
		post("{\"irq\": 51, \"event\": \"done\", \"req\": %lld, \"value\": 15100}", (long long)req);
		post("{\"irq\": 51, \"event\": \"app\", \"pid\": 15100, \"n\": 200000, \"name\": \"%s\", \"bundle\": \"test.launched\", \"path\": \"/x\", \"policy\": \"regular\", \"active\": true, "
		     "\"hidden\": false, \"state\": \"running\", \"electron\": false}", name);
		post("{\"irq\": 51, \"event\": \"tree\", \"pid\": 15100, \"items\": [{\"add\": 200001, \"parent\": 0, \"name\": \"window-1\", \"value\": {\"role\": \"AXWindow\", \"title\": \"%s\", "
		     "\"x\": 100, \"y\": 100, \"w\": 320, \"h\": 200}}]}", name);
		return;
	}
	if (!strcmp(op, "web") && jsonText(jsonGet(c, "path"))) {
		// a page made: its plane file mapped, as the metal maps it
		const char *id = jsonText(jsonGet(c, "id")), *path = jsonText(jsonGet(c, "path"));
		int mw = (int)number(c, "maxw", 0), mh = (int)number(c, "maxh", 0);
		int fd = open(path, O_RDWR);
		size_t bytes = (size_t)mw * (size_t)mh * 4 * 2;
		uint32_t *bits = fd >= 0 && bytes ? mmap(NULL, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0) : MAP_FAILED;
		if (fd >= 0) close(fd);
		if (bits != MAP_FAILED && id && npages < 16) {
			unlink(path);
			pthread_mutex_lock(&lock);
			struct Page *pg = &pages[npages++];
			*pg = (struct Page){ .bits = bits, .mw = mw, .mh = mh, .half = 1 };
			snprintf(pg->id, sizeof pg->id, "%s", id);
			pthread_mutex_unlock(&lock);
		} else fprintf(stderr, "[web] no plane %s\n", path ? path : "?");
		if (jsonText(jsonGet(c, "state"))) fprintf(stderr, "[web] %s brought back from its state (%zu bytes)\n", id ? id : "?", strlen(jsonText(jsonGet(c, "state"))));
	}
	if (!strcmp(op, "webshow")) {
		// shown at a new size: a whole frame of the test colour, as the engine's first at that size
		const char *id = jsonText(jsonGet(c, "id"));
		int w = (int)number(c, "w", 0), h = (int)number(c, "h", 0);
		fprintf(stderr, "[webshow] %s %dx%d\n", id ? id : "?", w, h);
		pthread_mutex_lock(&lock);
		struct Page *pg = pageOf(id);
		bool fresh = pg && w > 0 && h > 0 && w <= pg->mw && h <= pg->mh && (w != pg->w || h != pg->h);
		int64_t n = 0;
		int half = 0;
		if (fresh) {
			half = pg->half = 1 - pg->half;
			uint32_t *dst = pg->bits + (size_t)half * (size_t)pg->mw * (size_t)pg->mh;
			for (int y = 0; y < h; y++)
				for (int x = 0; x < w; x++) dst[(size_t)y * (size_t)pg->mw + x] = 0x3366cc;
			pg->w = w, pg->h = h;
			n = ++pg->n;
		}
		pthread_mutex_unlock(&lock);
		if (fresh) post("{\"irq\": 49, \"event\": \"frame\", \"id\": \"%s\", \"n\": %lld, \"half\": %d, \"w\": %d, \"h\": %d}", id, (long long)n, half, w, h);
		return;
	}
	if (!strcmp(op, "webtook")) {
		pthread_mutex_lock(&lock);
		struct Page *pg = pageOf(jsonText(jsonGet(c, "id")));
		if (pg) pg->took = (int64_t)number(c, "n", 0);
		pthread_mutex_unlock(&lock);
		count(op, strlen(json), 0);
		fprintf(stderr, "[webtook] %s %lld\n", pg ? pg->id : "?", (long long)number(c, "n", 0));
		return;
	}
	if (!strcmp(op, "webinput") || !strcmp(op, "webdo")) {
		// said; an act answered done, as the page's script would
		fprintf(stderr, "[%s] %.300s\n", op, json);
		if (!strcmp(op, "webdo"))
			post("{\"irq\": 49, \"event\": \"done\", \"id\": \"%s\", \"req\": %lld}", jsonText(jsonGet(c, "id")) ? jsonText(jsonGet(c, "id")) : "", (long long)number(c, "req", 0));
		return;
	}
	if (!strcmp(op, "webclose")) {
		fprintf(stderr, "[metal] %.120s\n", json);
		pthread_mutex_lock(&lock);
		struct Page *pg = pageOf(jsonText(jsonGet(c, "id")));
		if (pg) {
			munmap(pg->bits, (size_t)pg->mw * (size_t)pg->mh * 4 * 2);
			*pg = pages[--npages];
		}
		pthread_mutex_unlock(&lock);
		// its list goes with the engine's page
		pthread_mutex_lock(&listing);
		struct List *l = listOf(jsonText(jsonGet(c, "id")));
		for (int i = 0; l && i < l->n; i++) free(l->urls[i]);
		if (l) l->n = 0, l->at = -1;
		pthread_mutex_unlock(&listing);
		return;
	}
	if (!strcmp(op, "display")) {
		// /etc/keys' chords for the Mac's tap: said, nothing else (no tap here)
		Json *keys = jsonGet(c, "keys");
		if (jsonIsObject(keys) && !jsonGet(c, "takeover") && !jsonGet(c, "windows")) {
			Json *chords = jsonGet(keys, "chords"), *system = jsonGet(keys, "system");
			fprintf(stderr, "[display] keys %d chords%s\n", jsonIsArray(chords) ? chords->array.count : 0,
			        system && system->type == JSON_BOOLEAN && system->boolean ? ", system" : "");
			return;
		}
		Json *take = jsonGet(c, "takeover");
		if (take && take->type == JSON_BOOLEAN) {
			takeover = take->boolean;
			fprintf(stderr, "[display] takeover %s\n", takeover ? "on" : "off");
			if (!jsonGet(c, "windows")) {
				sendMode();
				return;
			}
		}
		Json *on = jsonGet(c, "windows");
		bool want = on && on->type == JSON_BOOLEAN && on->boolean;
		fprintf(stderr, "[display] windows %s\n", want ? "on" : "off");
		if (want == windowsMode) return;
		pthread_mutex_lock(&lock);
		windowsMode = want;
		if (!want) unsurfaceAll();
		pthread_mutex_unlock(&lock);
		sendMode(); // the stack emptied going to windows, and started again coming back
		return;
	}
	if (!strcmp(op, "surface")) {
		const char *id = jsonText(jsonGet(c, "id"));
		int w = (int)(jsonGet(c, "w") ? jsonGet(c, "w")->number : 0), h = (int)(jsonGet(c, "h") ? jsonGet(c, "h")->number : 0);
		Json *key = jsonGet(c, "key");
		fprintf(stderr, "[surface] %s %dx%d at %g,%g \"%s\"%s%s\n", id ? id : "?", w, h, jsonGet(c, "x") ? jsonGet(c, "x")->number : 0, jsonGet(c, "y") ? jsonGet(c, "y")->number : 0,
		        jsonText(jsonGet(c, "title")) ? jsonText(jsonGet(c, "title")) : "", key && key->type == JSON_BOOLEAN && key->boolean ? " key" : "",
		        windowsMode ? "" : " (screen mode: ignored)");
		if (!id || !windowsMode || w < 1 || h < 1 || w > W || h > H) return;
		// made key: the window server says so, as the Mac's does
		if (key && key->type == JSON_BOOLEAN && key->boolean) post("{\"irq\": 33, \"event\": \"key\", \"id\": \"%s\"}", id);
		pthread_mutex_lock(&lock);
		struct Surf *s = surf(id);
		if (!s && nsurfs < 64) {
			s = &surfs[nsurfs++];
			*s = (struct Surf){ 0 };
			snprintf(s->id, sizeof s->id, "%s", id);
		}
		if (s && (s->w != w || s->h != h)) {
			free(s->bits);
			s->bits = calloc((size_t)(w * h), 4);
			s->w = w, s->h = h;
		}
		pthread_mutex_unlock(&lock);
		return;
	}
	if (!strcmp(op, "present")) {
		// the piece at sx, sy of the buffer, dirty's w × h of it (the whole surface without one), to dirty's place in the surface
		const char *id = jsonText(jsonGet(c, "id"));
		int b = (int)(jsonGet(c, "buffer") ? jsonGet(c, "buffer")->number : 0), sx = (int)(jsonGet(c, "sx") ? jsonGet(c, "sx")->number : 0), sy = (int)(jsonGet(c, "sy") ? jsonGet(c, "sy")->number : 0);
		pthread_mutex_lock(&lock);
		struct Surf *s = id ? surf(id) : NULL;
		Json *dirty = jsonGet(c, "dirty");
		int dx = 0, dy = 0, dw = s ? s->w : 0, dh = s ? s->h : 0;
		if (dirty) {
			dx = (int)jsonGet(dirty, "x")->number, dy = (int)jsonGet(dirty, "y")->number, dw = (int)jsonGet(dirty, "w")->number, dh = (int)jsonGet(dirty, "h")->number;
		}
		uint32_t sum = 0;
		bool ok = s && b >= 0 && b < 2 && dx >= 0 && dy >= 0 && dx + dw <= s->w && dy + dh <= s->h && sx + dw <= W && sy + dh <= H;
		if (ok)
			for (int y = 0; y < dh; y++)
				for (int x = 0; x < dw; x++) {
					uint32_t p = buffers[b][(sy + y) * W + sx + x];
					s->bits[(dy + y) * s->w + dx + x] = p;
					sum = sum * 31 + p;
				}
		pthread_mutex_unlock(&lock);
		fprintf(stderr, "[present] %s %dx%d at %d,%d from buffer %d at %d,%d%s%s\n", id ? id : "?", dw, dh, dx, dy, b, sx, sy, dirty ? "" : " (whole)",
		        ok ? "" : s ? " OUT OF RANGE" : " NO SURFACE");
		(void)sum;
		return;
	}
	if (!strcmp(op, "unsurface")) {
		const char *id = jsonText(jsonGet(c, "id"));
		fprintf(stderr, "[unsurface] %s\n", id ? id : "?");
		pthread_mutex_lock(&lock);
		struct Surf *s = id ? surf(id) : NULL;
		if (s) {
			free(s->bits);
			*s = surfs[--nsurfs];
		}
		pthread_mutex_unlock(&lock);
		return;
	}
	if (!strcmp(op, "tx")) {
		size_t n;
		uint8_t *bytes = drvUnbase64(jsonText(jsonGet(c, "bytes")), &n);
		fwrite(bytes, 1, n, stdout);
		fflush(stdout);
		free(bytes);
	} else if (!strcmp(op, "flip")) {
		pthread_mutex_lock(&lock);
		shown.buffer = (int)jsonGet(c, "buffer")->number;
		shown.w = (int)jsonGet(c, "w")->number;
		shown.h = (int)jsonGet(c, "h")->number;
		pthread_mutex_unlock(&lock);
		// HEADLESS_COPY: a copy of the whole frame, as the Mac's flip makes on the OS's thread
		if (getenv("HEADLESS_COPY")) {
			void *copy = malloc((size_t)(W * H) * 4);
			memcpy(copy, buffers[shown.buffer], (size_t)(W * H) * 4);
			__asm__ volatile("" : : "r"(copy) : "memory");
			free(copy);
		}
	} else if (!strcmp(op, "vsync")) {
		Json *on = jsonGet(c, "on");
		if (on && on->type == JSON_BOOLEAN && on->boolean) post("{\"irq\": 33, \"event\": \"vsync\", \"frame\": 0}");
	} else if (!strcmp(op, "glyphs")) {
		const char *font = jsonText(jsonGet(c, "font"));
		double size = jsonGet(c, "size") ? jsonGet(c, "size")->number : 12;
		Json *bold = jsonGet(c, "bold");
		bool b = bold && bold->type == JSON_BOOLEAN && bold->boolean;
		int n = (int)(jsonGet(c, "page") ? jsonGet(c, "page")->number : 0);
		char *p = realFonts() ? inkPage(font, size, b, n) : page(size, b, n);
		post("{\"irq\": 50, \"font\": \"%s\", \"size\": %g, \"bold\": %s, \"synthetic\": false, \"page\": %d, %s", font ? font : "", size, b ? "true" : "false", n, p + 1);
		free(p);
	} else if (!strcmp(op, "menus")) {
		// what the Mac's menu bar would show after its own menus
		Json *menus = jsonGet(c, "menus");
		fprintf(stderr, "[menus] %g", jsonGet(c, "n") ? jsonGet(c, "n")->number : -1);
		for (int i = 0; jsonIsArray(menus) && i < menus->array.count; i++) {
			Json *m = menus->array.items[i], *items = jsonGet(m, "items");
			fprintf(stderr, "%s%s:", i ? " ;; " : " ", jsonText(jsonGet(m, "title")) ? jsonText(jsonGet(m, "title")) : "?");
			menuItems(items);
		}
		fprintf(stderr, "\n");
	} else if (!strcmp(op, "web") && jsonText(jsonGet(c, "url"))) {
		// a page asked for: there at once, titled by its host, as WebKit's would say; a page it would
		// open beside it is !post {"irq": 49, "event": "open", "id": id, "url": url, "behind": false}
		const char *id = jsonText(jsonGet(c, "id")), *url = jsonText(jsonGet(c, "url")), *host = strstr(url, "://");
		host = host ? host + 3 : url;
		(void)host;
		fprintf(stderr, "[metal] %.120s\n", json);
		pthread_mutex_lock(&listing);
		struct List *l = listOf(id);
		if (!strpbrk(url, "\"\\") && strlen(url) < 250 && l) {
			// brought back from its state: the list it had is the engine's, so here the URL alone
			if (jsonText(jsonGet(c, "state"))) {
				for (int i = 0; i < l->n; i++) free(l->urls[i]);
				l->n = 0;
				l->at = -1;
			}
			pushed(l, url);
			listed(l);
		}
		pthread_mutex_unlock(&listing);
	} else if (!strcmp(op, "web") && jsonGet(c, "go")) {
		// back, forward, or that far along the list
		pthread_mutex_lock(&listing);
		struct List *l = listOf(jsonText(jsonGet(c, "id")));
		const char *go = jsonText(jsonGet(c, "go"));
		int to = !l ? -1 : l->at + (go && !strcmp(go, "back") ? -1 : go && !strcmp(go, "forward") ? 1 : go ? 0 : (int)number(c, "go", 0));
		fprintf(stderr, "[metal] %.120s\n", json);
		if (l && to != l->at && to >= 0 && to < l->n) {
			l->at = to;
			listed(l);
		}
		pthread_mutex_unlock(&listing);
	} else if (!strcmp(op, "quit")) {
		post("{\"irq\": 1, \"why\": \"os\"}");
	} else if (!strcmp(op, "cursor") && jsonGet(c, "shape")) {
		// a new image for the cursor plane: said, as the metal draws it
		Json *shape = jsonGet(c, "shape");
		fprintf(stderr, "[metal] cursor shape %gx%g, hot %g %g\n", jsonGet(shape, "w")->number, jsonGet(shape, "h")->number, jsonGet(shape, "hotx")->number, jsonGet(shape, "hoty")->number);
	} else if (strcmp(op, "cursor") && strcmp(op, "ready") && strcmp(op, "access") && strcmp(op, "textinput")) {
		fprintf(stderr, "[metal] %.120s\n", json);
	}
}

/** a surface's pixels, as its Mac window shows them */
static void shotSurface(const char *path, const char *id) {
	pthread_mutex_lock(&lock);
	struct Surf *s = surf(id);
	FILE *f = s ? fopen(path, "wb") : NULL;
	if (f) {
		fprintf(f, "P6 %d %d 255\n", s->w, s->h);
		for (int i = 0; i < s->w * s->h; i++) {
			uint32_t p = s->bits[i];
			unsigned char rgb[3] = { (unsigned char)(p >> 16), (unsigned char)(p >> 8), (unsigned char)p };
			fwrite(rgb, 1, 3, f);
		}
		fclose(f);
	} else fprintf(stderr, "[shot] no surface %s\n", id);
	pthread_mutex_unlock(&lock);
}

static void shot(const char *path) {
	const char *id = strchr(path, ' ');
	if (id) {
		char file[1024];
		snprintf(file, sizeof file, "%.*s", (int)(id - path), path);
		shotSurface(file, id + 1);
		return;
	}
	FILE *f = fopen(path, "wb");
	if (!f) return;
	// held while it is read: the next flip waits, and so the compose after it, which draws into this buffer
	pthread_mutex_lock(&lock);
	uint32_t *stacked = NULL;
	if (stacking) {
		stacked = malloc((size_t)(W * H) * 4);
		stack(stacked);
	}
	int b = shown.buffer, w = stacked ? W : shown.w ? shown.w : W, h = stacked ? H : shown.h ? shown.h : H;
	fprintf(f, "P6 %d %d 255\n", w, h);
	for (int y = 0; y < h; y++)
		for (int x = 0; x < w; x++) {
			uint32_t p = stacked ? stacked[y * W + x] : buffers[b][y * W + x];
			unsigned char rgb[3] = { (unsigned char)(p >> 16), (unsigned char)(p >> 8), (unsigned char)p };
			fwrite(rgb, 1, 3, f);
		}
	pthread_mutex_unlock(&lock);
	free(stacked);
	fclose(f);
}

static void key(const char *name, const char *mods) {
	char text[8] = "", quoted[8] = "";
	// a quote or a backslash typed, escaped in the record's JSON
	if (strlen(name) == 1) snprintf(quoted, sizeof quoted, "%s%s", *name == '"' || *name == '\\' ? "\\" : "", name);
	if (*quoted) strcpy(text, quoted);
	else if (!strcmp(name, "Enter")) strcpy(text, "\\r");
	for (int down = 1; down >= 0; down--)
		post("{\"irq\": 34, \"event\": \"key\", \"down\": %s, \"code\": 0, \"key\": \"%s\", \"text\": \"%s\", \"mods\": [%s], \"repeat\": false}",
		     down ? "true" : "false", *quoted ? quoted : name, down ? text : "", mods);
}

/** !page id color [x y w h]: the page's next frame, its last with that rectangle (all of it, without one) painted, said with dirty */
static void paintPage(const char *rest) {
	char id[128];
	unsigned color = 0;
	int x = 0, y = 0, w = -1, h = -1;
	if (sscanf(rest, "%127s %x %d %d %d %d", id, &color, &x, &y, &w, &h) < 2) return;
	pthread_mutex_lock(&lock);
	struct Page *pg = pageOf(id);
	if (!pg || pg->w <= 0) {
		pthread_mutex_unlock(&lock);
		fprintf(stderr, "[page] %s not shown\n", id);
		return;
	}
	if (w < 0) x = 0, y = 0, w = pg->w, h = pg->h;
	if (pg->took != pg->n) fprintf(stderr, "[page] %s: frame %lld not taken yet\n", id, (long long)pg->n);
	size_t half = (size_t)pg->mw * (size_t)pg->mh;
	uint32_t *last = pg->bits + (size_t)pg->half * half, *next = pg->bits + (size_t)(1 - pg->half) * half;
	for (int r = 0; r < pg->h; r++) memcpy(next + (size_t)r * (size_t)pg->mw, last + (size_t)r * (size_t)pg->mw, (size_t)pg->w * 4);
	for (int r = y; r < y + h && r < pg->h; r++)
		for (int k = x; k < x + w && k < pg->w; k++) next[(size_t)r * (size_t)pg->mw + k] = color;
	pg->half = 1 - pg->half;
	int64_t n = ++pg->n;
	int fh = pg->half, fw = pg->w, fhh = pg->h;
	pthread_mutex_unlock(&lock);
	post("{\"irq\": 49, \"event\": \"frame\", \"id\": \"%s\", \"n\": %lld, \"half\": %d, \"w\": %d, \"h\": %d, \"dirty\": {\"x\": %d, \"y\": %d, \"w\": %d, \"h\": %d}}", id,
	     (long long)n, fh, fw, fhh, x, y, w, h);
}

int main(int argc, char **argv) {
	const char *sd = "/tmp/ermineOS-headless", *image = "playground/experimental_os/newos/image", *runner = "playground/experimental_os/newos/js/runner.js";
	bool fresh = false;
	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--w") && i + 1 < argc) W = atoi(argv[++i]);
		else if (!strcmp(argv[i], "--h") && i + 1 < argc) H = atoi(argv[++i]);
		else if (!strcmp(argv[i], "--unit") && i + 1 < argc) U = atoi(argv[++i]);
		else if (!strcmp(argv[i], "--sd") && i + 1 < argc) sd = argv[++i];
		else if (!strcmp(argv[i], "--image") && i + 1 < argc) image = argv[++i];
		else if (!strcmp(argv[i], "--runner") && i + 1 < argc) runner = argv[++i];
		else if (!strcmp(argv[i], "--fresh")) fresh = true;
	}
	// a Wayland socket of its own, so a test never meets the person's ermineOS on ~/.ermine/wayland
	if (!getenv("XDG_RUNTIME_DIR")) {
		char *dir = NULL;
		if (asprintf(&dir, "%s/ermine-headless-XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp") > 0 && mkdtemp(dir)) setenv("XDG_RUNTIME_DIR", dir, 1);
		free(dir);
	}
	// and the shell's socket (drv_sock.c), never the person's ~/.ermine/shell.sock
	if (!getenv("ERMINE_SOCK")) {
		char *dir = NULL, *path = NULL;
		if (asprintf(&dir, "%s/ermine-headless-XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp") > 0 && mkdtemp(dir) && asprintf(&path, "%s/shell.sock", dir) > 0)
			setenv("ERMINE_SOCK", path, 1);
		free(dir);
		free(path);
	}
	buffers[0] = calloc((size_t)(W * H), 4);
	buffers[1] = calloc((size_t)(W * H), 4);
	planes[0] = calloc((size_t)(W * H), 4);
	planes[1] = calloc((size_t)(W * H), 4);
	char *font = realFonts() ? inkRom(8 * U, 16 * U) : rom(8 * U, 16 * U);
	char *dt = formatString(
	    "{\"model\": \"headless\", \"cpu\": \"\", \"cores\": 1, \"memory\": 0, \"os\": \"none\", \"host\": \"headless\", \"user\": \"%s\", \"home\": \"/\","
	    " \"screens\": [{\"name\": \"none (headless)\", \"w\": %d, \"h\": %d, \"scale\": 1, \"main\": true}],"
	    " \"fb\": {\"path\": \"(memory)\", \"maxw\": %d, \"maxh\": %d, \"buffers\": 2, \"offset\": 0, \"format\": \"xrgb8888\", \"scale\": %g, \"unit\": %d},"
	    " \"font\": %s,"
	    " \"devices\": [{\"name\": \"display\", \"irq\": 33}, {\"name\": \"keyboard\", \"irq\": 34}, {\"name\": \"pointer\", \"irq\": 35}, {\"name\": \"uart0\", \"irq\": 36},"
	    " {\"name\": \"power\", \"irq\": 40}, {\"name\": \"thermal\", \"irq\": 41}, {\"name\": \"cpu\", \"irq\": 43}, {\"name\": \"usb\", \"irq\": 44},"
	    " {\"name\": \"net\", \"irq\": 45}, {\"name\": \"clipboard\", \"irq\": 46}, {\"name\": \"volumes\", \"irq\": 48},"
	    " {\"name\": \"font\", \"irq\": 50, \"families\": [\"blocks\"]}, {\"name\": \"web\", \"irq\": 49, \"engine\": \"none\"},"
	    " {\"name\": \"mac\", \"irq\": 51, \"ax\": false, \"capture\": false}, {\"name\": \"speech\"}]}",
	    getenv("USER") ? getenv("USER") : "person", W, H, W, H, 1.0 / U, U, font);
	ErmosConfig config = { .dt = dt, .buffers = { buffers[0], buffers[1] }, .planes = planes, .nplanes = 2, .sd = sd, .image = image, .runner = runner, .fresh = fresh, .command = command };
	const char *lo = getenv("HEADLESS_LAYERS");
	layersOn = !lo || strcmp(lo, "0");
	ermosStart(&config);
	sendMode();
	post("{\"irq\": 40, \"ac\": true, \"battery\": true, \"percent\": 100, \"charging\": false, \"minutes\": null}");
	post("{\"irq\": 41, \"state\": \"nominal\", \"lowPower\": false}");
	char line[4096];
	while (fgets(line, sizeof line, stdin)) {
		size_t n = strlen(line);
		if (line[0] != '!') {
			char *b64 = drvBase64((const uint8_t *)line, n);
			post("{\"irq\": 36, \"rx\": \"%s\"}", b64);
			free(b64);
			continue;
		}
		if (n && line[n - 1] == '\n') line[--n] = 0;
		char *word = line + 1, *rest = strchr(word, ' ');
		if (rest) *rest++ = 0;
		else rest = "";
		if (!strcmp(word, "wait")) usleep((useconds_t)atoi(rest) * 1000);
		else if (!strcmp(word, "shot")) shot(rest);
		else if (!strcmp(word, "stats")) report(rest);
		else if (!strcmp(word, "page")) paintPage(rest);
		else if (!strcmp(word, "nav")) navPage(rest, false);
		else if (!strcmp(word, "replace")) navPage(rest, true);
		else if (!strcmp(word, "type")) {
			for (char *c = rest; *c; c++) {
				char k[2] = { *c, 0 };
				key(k, "");
			}
		} else if (!strcmp(word, "key")) {
			char *mods = strchr(rest, ' '), list[256] = "";
			if (mods) {
				*mods++ = 0;
				for (char *m = strtok(mods, " "); m; m = strtok(NULL, " ")) {
					char item[64];
					snprintf(item, sizeof item, "%s\"%s\"", list[0] ? ", " : "", m);
					strncat(list, item, sizeof list - strlen(list) - 1);
				}
			}
			key(rest, list);
		} else if (!strcmp(word, "click")) {
			int x = 0, y = 0;
			sscanf(rest, "%d %d", &x, &y);
			if (getenv("HEADLESS_CURSOR")) fprintf(stderr, "[move] %lld %d %d\n", (long long)now(), x, y);
			post("{\"irq\": 35, \"event\": \"move\", \"x\": %d, \"y\": %d, \"buttons\": [], \"mods\": []}", x, y);
			post("{\"irq\": 35, \"event\": \"down\", \"x\": %d, \"y\": %d, \"button\": 0, \"buttons\": [0], \"mods\": []}", x, y);
			post("{\"irq\": 35, \"event\": \"up\", \"x\": %d, \"y\": %d, \"button\": 0, \"buttons\": [], \"mods\": []}", x, y);
		} else if (!strcmp(word, "post")) {
			// a record as the metal would send it, as it is: {"irq": n, ...}
			if (getenv("HEADLESS_CURSOR")) fprintf(stderr, "[post] %lld\n", (long long)now());
			// a mode record switches windows mode here, as the metal's own would
			Json *r = jsonParse(rest, strlen(rest), NULL);
			const char *e = jsonText(jsonGet(r, "event"));
			Json *on = jsonGet(r, "windows"), *ls = jsonGet(r, "layers");
			if (e && !strcmp(e, "mode") && on && on->type == JSON_BOOLEAN) {
				pthread_mutex_lock(&lock);
				windowsMode = on->boolean;
				if (!windowsMode) unsurfaceAll();
				pthread_mutex_unlock(&lock);
			}
			if (e && !strcmp(e, "mode")) {
				// stacking as the record says, as the OS takes it
				pthread_mutex_lock(&lock);
				stacking = !windowsMode && ls && ls->type == JSON_BOOLEAN && ls->boolean;
				if (!stacking) unlayerAll();
				pthread_mutex_unlock(&lock);
			}
			jsonFree(r);
			post("%s", rest);
		} else if (!strcmp(word, "move")) {
			int x = 0, y = 0;
			sscanf(rest, "%d %d", &x, &y);
			post("{\"irq\": 35, \"event\": \"move\", \"x\": %d, \"y\": %d, \"buttons\": [], \"mods\": []}", x, y);
		} else if (!strcmp(word, "drag")) {
			int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
			sscanf(rest, "%d %d %d %d", &x0, &y0, &x1, &y1);
			post("{\"irq\": 35, \"event\": \"down\", \"x\": %d, \"y\": %d, \"button\": 0, \"buttons\": [0], \"mods\": []}", x0, y0);
			post("{\"irq\": 35, \"event\": \"move\", \"x\": %d, \"y\": %d, \"buttons\": [0], \"mods\": []}", x1, y1);
			post("{\"irq\": 35, \"event\": \"up\", \"x\": %d, \"y\": %d, \"button\": 0, \"buttons\": [], \"mods\": []}", x1, y1);
		} else if (!strcmp(word, "compose")) post("{\"irq\": 34, \"event\": \"compose\", \"text\": \"%s\", \"selected\": [0, 0]}", rest);
		else if (!strcmp(word, "commit")) post("{\"irq\": 34, \"event\": \"commit\", \"text\": \"%s\"}", rest);
	}
	post("{\"irq\": 1, \"why\": \"stdin\"}");
	ermosStop();
	return 0;
}
