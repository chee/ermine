// headless.c: ermineOS's OS with no window, as typescript/metal.ts's
// headless metal was: a device tree for no Mac in particular, frame
// buffers in memory, a font ROM and a font chip of boxes, vsync answered at
// once, the serial line on stdin and stdout. A line starting "!" is a hand
// on the machine:
//
//   !key Enter [mods...]   !type text   !click x y   !move x y   !drag x0 y0 x1 y1   !post {record}
//   !compose text   !commit text   !shot file.ppm   !wait ms
//
//   headless [--w W] [--h H] [--unit U] [--sd DIR] [--image DIR] [--runner FILE] [--fresh]

#define _DARWIN_C_SOURCE

#include "../os.h"

#include "../../../core/graph/c/json.h"
#include "../drv.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int W = 800, H = 500, U = 1;
static uint32_t *buffers[2];
static uint32_t *planes[2]; // web pages' planes: a page mirrored is a test colour, as no page draws here
static struct {
	int buffer, w, h;
} shown;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

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

/** what the OS commands the hardware */
static void command(void *data, const char *json) {
	(void)data;
	char *why = NULL;
	Json *c = jsonParse(json, strlen(json), &why);
	const char *op = jsonText(jsonGet(c, "op"));
	// HEADLESS_CURSOR: every cursor command (a shape: the metal moves the plane) and flip, with when it came
	if (op && !strcmp(op, "cursor") && getenv("HEADLESS_CURSOR")) fprintf(stderr, "[cursor] %lld %g %g\n", (long long)now(), jsonGet(c, "x") ? jsonGet(c, "x")->number : -1, jsonGet(c, "y") ? jsonGet(c, "y")->number : -1);
	if (op && !strcmp(op, "flip") && getenv("HEADLESS_CURSOR")) fprintf(stderr, "[flip] %lld\n", (long long)now());
	if (!op) return;
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

static void shot(const char *path) {
	pthread_mutex_lock(&lock);
	int b = shown.buffer, w = shown.w ? shown.w : W, h = shown.h ? shown.h : H;
	pthread_mutex_unlock(&lock);
	FILE *f = fopen(path, "wb");
	if (!f) return;
	fprintf(f, "P6 %d %d 255\n", w, h);
	for (int y = 0; y < h; y++)
		for (int x = 0; x < w; x++) {
			uint32_t p = buffers[b][y * W + x];
			unsigned char rgb[3] = { (unsigned char)(p >> 16), (unsigned char)(p >> 8), (unsigned char)p };
			fwrite(rgb, 1, 3, f);
		}
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
	    " {\"name\": \"font\", \"irq\": 50, \"families\": [\"blocks\"]}, {\"name\": \"web\", \"irq\": 49, \"engine\": \"none\"}, {\"name\": \"speech\"}]}",
	    getenv("USER") ? getenv("USER") : "person", W, H, W, H, 1.0 / U, U, font);
	ErmosConfig config = { .dt = dt, .buffers = { buffers[0], buffers[1] }, .planes = planes, .nplanes = 2, .sd = sd, .image = image, .runner = runner, .fresh = fresh, .command = command };
	ermosStart(&config);
	post("{\"irq\": 33, \"event\": \"mode\", \"w\": %d, \"h\": %d, \"scale\": %g, \"unit\": %d, \"screen\": \"none\", \"fullscreen\": false}", W, H, 1.0 / U, U);
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
