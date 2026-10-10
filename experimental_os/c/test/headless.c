// headless.c: ermineOS's OS with no window, as typescript/metal.ts's
// headless metal was: a device tree for no Mac in particular, frame
// buffers in memory, a font ROM and a font chip of boxes, vsync answered at
// once, the serial line on stdin and stdout. A line starting "!" is a hand
// on the machine:
//
//   !key Enter [mods...]   !type text   !click x y   !move x y   !drag x0 y0 x1 y1   !post {record}
//   !compose text   !commit text   !shot file.ppm   !wait ms   !stats label
//
// !stats says what the OS commanded since the last: each op's count, bytes
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
// menu first, titled ermine), with their chords; a choice there is
// !post {"irq": 33, "event": "menu", "n": n, "menu": m, "item": i}.
//
//   headless [--w W] [--h H] [--unit U] [--sd DIR] [--image DIR] [--runner FILE] [--fresh]

#define _DARWIN_C_SOURCE

#include "../os.h"

#include "../../../core/graph/c/json.h"
#include "../drv.h"

#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static int W = 800, H = 500, U = 1;
static uint32_t *buffers[2];
static uint32_t *planes[2]; // web pages' planes: a page mirrored is a test colour, as no page draws here
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
} tiles[256];
static int ntiles;
/** web pages placed in tiles (overlay with layer): each shows as the mirror's test colour, live, in its tile, as WebKit's view would */
static struct Page {
	char id[128], layer[128];
	int x, y, w, h;
	bool visible;
} pages[16];
static int npages;

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
		for (int k = 0; k < npages; k++) {
			struct Page *pg = &pages[k];
			if (!pg->visible || strcmp(pg->layer, t->id)) continue;
			for (int y = pg->y; y < pg->y + pg->h && y < t->h; y++)
				for (int x = pg->x; x < pg->x + pg->w && x < t->w; x++)
					if (y >= 0 && x >= 0 && t->y + y >= 0 && t->y + y < H && t->x + x >= 0 && t->x + x < W) out[(t->y + y) * W + t->x + x] = 0x3366cc;
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

/** the page being mirrored, as the Mac's webmirror copies it fps times a second */
static struct {
	char id[128];
	int64_t slot, fps;
} mirror;

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
	char head[64], body[1 << 16];
	va_list ap;
	va_start(ap, format);
	vsnprintf(body, sizeof body, format, ap);
	va_end(ap);
	snprintf(head, sizeof head, "{\"at\": %lld, ", (long long)now());
	char *rec = formatString("%s%s", head, body + 1);
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
	memset(&stats, 0, sizeof stats);
	pthread_mutex_unlock(&lock);
}

static int64_t area(const Json *r) {
	return r ? (int64_t)(jsonGet(r, "w") ? jsonGet(r, "w")->number : 0) * (int64_t)(jsonGet(r, "h") ? jsonGet(r, "h")->number : 0) : 0;
}

/** what the OS commands the hardware */
static void command(void *data, const char *json) {
	(void)data;
	char *why = NULL;
	Json *c = jsonParse(json, strlen(json), &why);
	const char *op = jsonText(jsonGet(c, "op"));
	if (op && !strcmp(op, "overlay") && jsonText(jsonGet(c, "layer"))) {
		// a page in a tile: where, to stack it there
		const char *id = jsonText(jsonGet(c, "id"));
		pthread_mutex_lock(&lock);
		int k = 0;
		while (k < npages && strcmp(pages[k].id, id ? id : "")) k++;
		if (k < 16) {
			if (k == npages) npages++;
			struct Page *pg = &pages[k];
			snprintf(pg->id, sizeof pg->id, "%s", id ? id : "");
			snprintf(pg->layer, sizeof pg->layer, "%s", jsonText(jsonGet(c, "layer")));
			pg->x = (int)number(c, "x", 0), pg->y = (int)number(c, "y", 0), pg->w = (int)number(c, "w", 0), pg->h = (int)number(c, "h", 0);
			Json *v = jsonGet(c, "visible");
			pg->visible = !v || v->type != JSON_BOOLEAN || v->boolean;
		}
		pthread_mutex_unlock(&lock);
	}
	if (op && !strcmp(op, "overlay") && !jsonText(jsonGet(c, "layer"))) {
		// out of a tile (hidden, or placed over the frame buffer)
		const char *id = jsonText(jsonGet(c, "id"));
		pthread_mutex_lock(&lock);
		for (int k = 0; k < npages; k++)
			if (!strcmp(pages[k].id, id ? id : "")) pages[k] = pages[--npages];
		pthread_mutex_unlock(&lock);
	}
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
	if (!strcmp(op, "webmirror")) {
		// a page's pixels copied to its plane: here a colour, and a frame record, as WebKit's copy would give
		int64_t slot = (int64_t)(jsonGet(c, "slot") ? jsonGet(c, "slot")->number : -1), fps = (int64_t)(jsonGet(c, "fps") ? jsonGet(c, "fps")->number : 0);
		fprintf(stderr, "[metal] %.120s\n", json);
		if (slot >= 0 && slot < 2 && fps > 0) {
			for (int i = 0; i < W * H; i++) planes[slot][i] = 0x3366cc;
			post("{\"irq\": 49, \"event\": \"frame\", \"id\": \"%s\", \"slot\": %lld, \"w\": %d, \"h\": %d, \"n\": 1}", jsonText(jsonGet(c, "id")), (long long)slot, W, H);
		}
		// and again at its fps, as the Mac copies a live page, until it is stopped
		pthread_mutex_lock(&lock);
		snprintf(mirror.id, sizeof mirror.id, "%s", jsonText(jsonGet(c, "id")) ? jsonText(jsonGet(c, "id")) : "");
		mirror.slot = slot, mirror.fps = slot >= 0 && slot < 2 ? fps : 0;
		pthread_mutex_unlock(&lock);
		return;
	}
	if (!strcmp(op, "display")) {
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
		char *p = page(size, b, n);
		post("{\"irq\": 50, \"font\": \"%s\", \"size\": %g, \"bold\": %s, \"synthetic\": false, \"page\": %d, %s", font ? font : "", size, b ? "true" : "false", n, p + 1);
		free(p);
	} else if (!strcmp(op, "menus")) {
		// what the Mac's menu bar would show after its own menus
		Json *menus = jsonGet(c, "menus");
		fprintf(stderr, "[menus] %g", jsonGet(c, "n") ? jsonGet(c, "n")->number : -1);
		for (int i = 0; jsonIsArray(menus) && i < menus->array.count; i++) {
			Json *m = menus->array.items[i], *items = jsonGet(m, "items");
			fprintf(stderr, "%s%s:", i ? " ;; " : " ", jsonText(jsonGet(m, "title")) ? jsonText(jsonGet(m, "title")) : "?");
			for (int k = 0; jsonIsArray(items) && k < items->array.count; k++) {
				const char *label = jsonText(jsonGet(items->array.items[k], "label")), *key = jsonText(jsonGet(items->array.items[k], "key"));
				fprintf(stderr, " | %s%s%s", label ? label : "-", key ? " " : "", key ? key : "");
			}
		}
		fprintf(stderr, "\n");
	} else if (!strcmp(op, "web") && jsonText(jsonGet(c, "url"))) {
		// a page asked for: there at once, titled by its host, as WebKit's would say; a page it would
		// open beside it is !post {"irq": 49, "event": "open", "id": id, "url": url, "behind": false}
		const char *id = jsonText(jsonGet(c, "id")), *url = jsonText(jsonGet(c, "url")), *host = strstr(url, "://");
		host = host ? host + 3 : url;
		fprintf(stderr, "[metal] %.120s\n", json);
		if (!strpbrk(url, "\"\\")) {
			post("{\"irq\": 49, \"event\": \"url\", \"id\": \"%s\", \"url\": \"%s\"}", id ? id : "", url);
			post("{\"irq\": 49, \"event\": \"title\", \"id\": \"%s\", \"title\": \"%.*s\"}", id ? id : "", (int)strcspn(host, "/?#"), host);
		}
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
	char text[8] = "";
	if (strlen(name) == 1) snprintf(text, sizeof text, "%s", name);
	else if (!strcmp(name, "Enter")) strcpy(text, "\\r");
	for (int down = 1; down >= 0; down--)
		post("{\"irq\": 34, \"event\": \"key\", \"down\": %s, \"code\": 0, \"key\": \"%s\", \"text\": \"%s\", \"mods\": [%s], \"repeat\": false}",
		     down ? "true" : "false", name, down ? text : "", mods);
}

/** the mirror's frames, fps a second, while one is asked for */
static void *mirroring(void *arg) {
	(void)arg;
	for (;;) {
		pthread_mutex_lock(&lock);
		int64_t fps = mirror.fps, slot = mirror.slot;
		char id[128];
		memcpy(id, mirror.id, sizeof id);
		pthread_mutex_unlock(&lock);
		if (fps > 0) post("{\"irq\": 49, \"event\": \"frame\", \"id\": \"%s\", \"slot\": %lld, \"w\": %d, \"h\": %d, \"n\": 1}", id, (long long)slot, W, H);
		usleep(fps > 0 ? (useconds_t)(1000000 / fps) : 50000);
	}
	return NULL;
}

int main(int argc, char **argv) {
	const char *sd = "/tmp/ermineOS-headless", *image = "experimental_os/image", *runner = "experimental_os/deno/runner.ts";
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
	buffers[0] = calloc((size_t)(W * H), 4);
	buffers[1] = calloc((size_t)(W * H), 4);
	pthread_t mirrorThread;
	pthread_create(&mirrorThread, NULL, mirroring, NULL);
	pthread_detach(mirrorThread);
	planes[0] = calloc((size_t)(W * H), 4);
	planes[1] = calloc((size_t)(W * H), 4);
	char *font = rom(8 * U, 16 * U);
	char *dt = formatString(
	    "{\"model\": \"headless\", \"cpu\": \"\", \"cores\": 1, \"memory\": 0, \"os\": \"none\", \"host\": \"headless\", \"user\": \"%s\", \"home\": \"/\","
	    " \"screens\": [{\"name\": \"none (headless)\", \"w\": %d, \"h\": %d, \"scale\": 1, \"main\": true}],"
	    " \"fb\": {\"path\": \"(memory)\", \"maxw\": %d, \"maxh\": %d, \"buffers\": 2, \"offset\": 0, \"format\": \"xrgb8888\", \"scale\": %g, \"unit\": %d},"
	    " \"font\": %s,"
	    " \"devices\": [{\"name\": \"display\", \"irq\": 33}, {\"name\": \"keyboard\", \"irq\": 34}, {\"name\": \"pointer\", \"irq\": 35}, {\"name\": \"uart0\", \"irq\": 36},"
	    " {\"name\": \"power\", \"irq\": 40}, {\"name\": \"thermal\", \"irq\": 41}, {\"name\": \"usb\", \"irq\": 44}, {\"name\": \"clipboard\", \"irq\": 46},"
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
