// drv_wayland.c: /drivers/wayland (../wayland/NOTES.md). A Wayland
// compositor (way.c) on a real Unix socket, so any Mac process built against libwayland-client is a client: weston's clients,
// waypipe-darwin carrying Linux clients. Each toplevel is a window as
// wmii knows one: a layer in /dev/display/layers, its owner a node of the
// driver's, /dev/wayland/windows/<id>, whose on/key and on/pointer wmii
// calls; a popup is a layer with no title, over its parent.
//
//   /dev/wayland/socket     {display, runtime}: WAYLAND_DISPLAY and XDG_RUNTIME_DIR for a client
//   /dev/wayland/windows/<id>  {title, app_id}, the owner of window <id>'s layer: on/key,
//                           on/pointer, on/hover (moves with no button down); unplaced
//                           (wmii's close): the client is asked to close
//   /dev/display/layers/wayland-<id>  {x, y, w, h, z, title, owner, drags, plane}
//
// A layer's pixels are not in the graph: plane {source: "wayland", id,
// serial} names the window's plane, /dev/wayland/planes/<id> {id, w, h,
// stride, shm}: POSIX shared memory of the window's geometry, which the
// compositor (drv_display.c's render) finds by that node and copies from
// (host.h's hostPlane); serial is the window's commits, so each new image
// is a change to the layer. The image is way.c's copy of the client's
// buffer, made at commit, after which the buffer was released: a client
// never waits on the compositor, and never sees release before its pixels
// are copied. Each commit this driver copies the geometry into the plane,
// on the OS's thread, in its turn.
//
// The thread: polls the compositor's fd; something there posts {"irq": 62}
// and waits for the host's turn to take it, then at least 1/60 s, which
// paces every client's frames. The turn (on/irq): way_dispatch, each
// window's layer brought up to date, then frame callbacks done.

#include "drivers.h"
#include "drv.h"
#include "way.h"

#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define IRQ 62

typedef struct Win {
	struct way_window *w;
	uint32_t id;
	bool placed, gone, retitled;
	uint32_t shown; // the commits the layer has
	int lw, lh;     // the layer's size as last written
	char shm[32];   // the plane: shared memory of the geometry, bw × bh
	uint32_t *bits;
	size_t bytes;
	int bw, bh;
} Win;

typedef struct Wayland {
	Host *host;
	struct way *way;
	const char *self;
	int unit;
	ERM_LIST(Win *) wins;
	pthread_t watcher;
	pthread_mutex_t lock;
	pthread_cond_t taken;
	bool posted;
	uint32_t under; // the window the pointer was last said to be over, 0 none
	double ux, uy;  // where in it, surface units
	unsigned cascade; // toplevels placed so far
} Wayland;

typedef struct Handle {
	Wayland *wl;
	uint32_t id;
} Handle;

static Win *winOf(Wayland *wl, uint32_t id) {
	for (int i = 0; i < wl->wins.count; i++)
		if (wl->wins.items[i]->id == id && !wl->wins.items[i]->gone) return wl->wins.items[i];
	return NULL;
}

static char *layerName(uint32_t id) {
	return formatString("wayland-%u", id);
}

static Json *windowNode(uint32_t id) {
	char n[16];
	snprintf(n, sizeof n, "%u", id);
	return drvPath("/", "dev", "wayland", "windows", n, NULL);
}

// --- what way.c says, during way_dispatch: kept on the window, done after

static void onEvent(void *data, struct way_window *w, enum way_event e) {
	Wayland *wl = data;
	Win *win = w->user;
	if (!win) {
		win = calloc(1, sizeof *win);
		win->w = w;
		win->id = w->id;
		w->user = win;
		ERM_PUSH(wl->wins, win);
	}
	if (e == WAY_TITLE) win->retitled = true;
	if (e == WAY_UNMAP || e == WAY_DESTROY) win->gone = true, win->w = NULL;
	// WAY_MOVE and WAY_RESIZE (a client-side title bar's drag) are wmii's to take: not yet
}

// --- the layer: the window's geometry, cropped from its image, a plane

/** the window's geometry in its image: buffer pixels */
static void cropOf(const struct way_window *w, int *x0, int *y0, int *cw, int *ch) {
	int s = w->scale > 0 ? w->scale : 1;
	*x0 = w->gx * s, *y0 = w->gy * s, *cw = w->gw * s, *ch = w->gh * s;
	if (*cw <= 0 || *ch <= 0 || *x0 < 0 || *y0 < 0 || *x0 + *cw > w->w || *y0 + *ch > w->h) *x0 = *y0 = 0, *cw = w->w, *ch = w->h;
}

static Json *planeOf(const Win *win) {
	return drvMap("source", jsonString("wayland"), "id", jsonInteger(win->id), "serial", jsonInteger(win->w->commits), NULL);
}

static Json *planesAt(void) {
	return drvPath("/", "dev", "wayland", "planes", NULL);
}

/** the plane let go: its memory unmapped and its name unlinked; its node unplaced, given an api */
static void planeGone(const ErmPartApi *api, Win *win) {
	if (win->bits) {
		munmap(win->bits, win->bytes);
		shm_unlink(win->shm);
		win->bits = NULL;
	}
	char n[16];
	snprintf(n, sizeof n, "%u", win->id);
	if (api && drvHas(api, drvUnder(planesAt(), n, NULL))) {
		char *id = formatString("wayland/plane/%u", win->id);
		drvOp(api, "unplace", drvMap("address", planesAt(), "name", jsonString(n), "id", jsonString(id), NULL));
		free(id);
	}
}

/**
 * the window's image, where its geometry is, copied into its plane: shared memory made (again) at
 * the geometry's size and said in /dev/wayland/planes/<id>, {id, w, h, stride, shm}
 */
static void image(Wayland *wl, const ErmGiven *g, Win *win) {
	struct way_window *w = win->w;
	if (!w || !w->pixels) return;
	int x0, y0, cw, ch;
	cropOf(w, &x0, &y0, &cw, &ch);
	if (cw <= 0 || ch <= 0) return;
	if (!win->bits || cw != win->bw || ch != win->bh) {
		planeGone(NULL, win);
		snprintf(win->shm, sizeof win->shm, "/ermwl.%d.%u", (int)getpid(), win->id);
		shm_unlink(win->shm);
		win->bytes = (size_t)cw * (size_t)ch * 4;
		int fd = shm_open(win->shm, O_RDWR | O_CREAT | O_EXCL, 0600);
		void *bits = MAP_FAILED;
		if (fd >= 0 && !ftruncate(fd, (off_t)win->bytes)) bits = mmap(NULL, win->bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
		if (fd >= 0) close(fd);
		if (bits == MAP_FAILED) {
			hostSay(wl->host, "wayland: no shared memory for window %u (%d × %d)", win->id, cw, ch);
			if (fd >= 0) shm_unlink(win->shm);
			return;
		}
		win->bits = bits, win->bw = cw, win->bh = ch;
		char n[16];
		snprintf(n, sizeof n, "%u", win->id);
		Json *said = drvMap("id", jsonInteger(win->id), "w", jsonInteger(cw), "h", jsonInteger(ch), "stride", jsonInteger(cw), "shm", jsonString(win->shm), NULL);
		if (drvHas(g->api, drvUnder(planesAt(), n, NULL))) drvSnap(g->api, drvUnder(planesAt(), n, NULL), said);
		else {
			char *id = formatString("wayland/plane/%u", win->id);
			drvMake(g->api, planesAt(), n, id, said);
			free(id);
		}
	}
	for (int y = 0; y < ch; y++) memcpy(win->bits + (size_t)y * (size_t)cw, w->pixels + (size_t)(y0 + y) * (size_t)w->w + x0, (size_t)cw * 4);
}

static ErmErr onKey(void *data, const ErmGiven *g, Json **out);
static ErmErr onPointer(void *data, const ErmGiven *g, Json **out);
static ErmErr onHover(void *data, const ErmGiven *g, Json **out);

static void handlerAt(Wayland *wl, const ErmGiven *g, Json *node, uint32_t id, const char *name, ErmErr (*fn)(void *, const ErmGiven *, Json **)) {
	// ids of their own: drvHandler's are the part's, one set for every window
	char *on = formatString("%s.wayland.%u.on", wl->self, id), *nid = formatString("%s.wayland.%u.on.%s", wl->self, id, name);
	Handle *h = calloc(1, sizeof *h);
	h->wl = wl;
	h->id = id;
	drvMake(g->api, node, "on", on, jsonNull());
	drvMakeLive(g->api, drvUnder(node, "on", NULL), name, nid, ermFunction((ErmFn){ fn, h }));
	free(on);
	free(nid);
}

static void place(Wayland *wl, const ErmGiven *g, Win *win) {
	struct way_window *w = win->w;
	char n[16], *name = layerName(win->id), *id;
	snprintf(n, sizeof n, "%u", win->id);
	Json *node = windowNode(win->id);
	id = formatString("wayland/windows/%u", win->id);
	drvMake(g->api, drvPath("/", "dev", "wayland", "windows", NULL), n, id, drvMap("title", jsonString(w->title), "app_id", jsonString(w->app_id), NULL));
	free(id);
	handlerAt(wl, g, node, win->id, "key", onKey);
	handlerAt(wl, g, node, win->id, "pointer", onPointer);
	handlerAt(wl, g, node, win->id, "hover", onHover);
	int x0, y0, lw, lh;
	cropOf(w, &x0, &y0, &lw, &lh);
	image(wl, g, win);
	Json *plane = planeOf(win), *layer;
	Win *parent = w->parent ? w->parent->user : NULL;
	if (w->popup && parent && parent->w) {
		// over its parent's layer, where the positioner put it
		Json *pl = drvRead(g->api, drvPath("/", "dev", "display", "layers", layerName(parent->id), NULL));
		int64_t px = 0, py = 0, pz = 0;
		jsonIsWhole(jsonGet(pl, "x"), &px);
		jsonIsWhole(jsonGet(pl, "y"), &py);
		jsonIsWhole(jsonGet(pl, "z"), &pz);
		int s = w->scale > 0 ? w->scale : 1;
		layer = drvMap("x", jsonInteger(px + w->x * s), "y", jsonInteger(py + w->y * s), "w", jsonInteger(lw), "h", jsonInteger(lh),
		               "z", jsonInteger(pz + 1), "owner", node, "plane", plane, NULL);
	} else {
		// each new window a step down and right of the last, so none hides another
		int k = (int)(wl->cascade++ % 8);
		layer = drvMap("x", jsonInteger((80 + 24 * k) * wl->unit), "y", jsonInteger((60 + 24 * k) * wl->unit), "w", jsonInteger(lw), "h", jsonInteger(lh),
		               "title", jsonString(*w->title ? w->title : *w->app_id ? w->app_id : "wayland"), "owner", node,
		               "drags", jsonBoolean(true), "plane", plane, NULL);
	}
	id = formatString("wayland/layer/%u", win->id);
	drvMake(g->api, drvPath("/", "dev", "display", "layers", NULL), name, id, layer);
	free(id);
	free(name);
	win->placed = true;
	win->shown = w->commits;
	win->lw = lw;
	win->lh = lh;
}

static void unplace(const ErmGiven *g, Win *win) {
	char n[16], *name = layerName(win->id), *id = formatString("wayland/layer/%u", win->id);
	drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "display", "layers", NULL), "name", jsonString(name), "id", jsonString(id), NULL));
	free(id);
	snprintf(n, sizeof n, "%u", win->id);
	id = formatString("wayland/windows/%u", win->id);
	if (drvHas(g->api, windowNode(win->id)))
		drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "wayland", "windows", NULL), "name", jsonString(n), "id", jsonString(id), NULL));
	free(id);
	free(name);
	planeGone(g->api, win);
}

static void update(Wayland *wl, const ErmGiven *g, Win *win) {
	struct way_window *w = win->w;
	char *name = layerName(win->id);
	Json *at = drvPath("/", "dev", "display", "layers", name, NULL);
	free(name);
	if (w->commits != win->shown) {
		int x0, y0, lw, lh;
		cropOf(w, &x0, &y0, &lw, &lh);
		image(wl, g, win);
		drvSet(g->api, at, "plane", planeOf(win));
		if (lw != win->lw || lh != win->lh) {
			drvSet(g->api, at, "w", jsonInteger(lw));
			drvSet(g->api, at, "h", jsonInteger(lh));
			win->lw = lw;
			win->lh = lh;
		}
		win->shown = w->commits;
	}
	if (win->retitled && !w->popup) {
		drvSet(g->api, at, "title", jsonString(*w->title ? w->title : *w->app_id ? w->app_id : "wayland"));
		win->retitled = false;
	}
	(void)wl;
}

static uint32_t clockMs(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

/** irq 62: the compositor's turn */
static ErmErr wlIrq(void *data, const ErmGiven *g, Json **out) {
	Wayland *wl = data;
	*out = jsonNull();
	way_dispatch(wl->way, 0);
	int k = 0;
	for (int i = 0; i < wl->wins.count; i++) {
		Win *win = wl->wins.items[i];
		if (win->gone) {
			if (win->placed) unplace(g, win);
			else planeGone(g->api, win);
			free(win);
			continue;
		}
		if (win->w && win->w->mapped) {
			if (!win->placed) place(wl, g, win);
			else update(wl, g, win);
		}
		wl->wins.items[k++] = win;
	}
	wl->wins.count = k;
	way_frame(wl->way, clockMs());
	way_dispatch(wl->way, 0); // flushes the frame events
	pthread_mutex_lock(&wl->lock);
	wl->posted = false;
	pthread_cond_signal(&wl->taken);
	pthread_mutex_unlock(&wl->lock);
	return ermOk();
}

static void *watch(void *data) {
	Wayland *wl = data;
	for (;;) {
		struct pollfd p = { way_fd(wl->way), POLLIN, 0 };
		if (poll(&p, 1, -1) < 0) continue;
		pthread_mutex_lock(&wl->lock);
		wl->posted = true;
		ermosPost("{\"irq\": 62}");
		while (wl->posted) pthread_cond_wait(&wl->taken, &wl->lock);
		pthread_mutex_unlock(&wl->lock);
		usleep(16000); // at most 60 turns a second: every client's frames
	}
	return NULL;
}

// --- input, from wmii: the window's owner node's handlers

/** the pointer over win at layer pixels x, y: surface units, from the surface's top left; a motion only when it moved */
static void pointAt(Wayland *wl, Win *win, double x, double y) {
	struct way_window *w = win->w;
	double s = w->scale > 0 ? w->scale : 1, sx = x / s + w->gx, sy = y / s + w->gy;
	if (wl->under == win->id && wl->ux == sx && wl->uy == sy) return;
	way_pointer(wl->way, w, sx, sy);
	wl->under = win->id, wl->ux = sx, wl->uy = sy;
}

static Json *recsOf(const ErmGiven *g) {
	return g->args && g->args->array.count ? g->args->array.items[0] : NULL;
}

static ErmErr onKey(void *data, const ErmGiven *g, Json **out) {
	Handle *h = data;
	*out = jsonNull();
	Win *win = winOf(h->wl, h->id);
	Json *recs = recsOf(g);
	if (!win || !win->w) return ermOk();
	way_focus(h->wl->way, win->w);
	for (int i = 0; jsonIsArray(recs) && i < recs->array.count; i++) {
		Json *r = recs->array.items[i], *down = jsonGet(r, "down");
		int64_t code;
		const char *e = jsonText(jsonGet(r, "event"));
		if (!e || strcmp(e, "key") || !jsonIsWhole(jsonGet(r, "code"), &code)) continue; // compose, commit: not yet
		uint32_t key = way_evdev_from_mac((int)code);
		if (key) way_key(h->wl->way, key, down && down->type == JSON_BOOLEAN && down->boolean);
	}
	way_dispatch(h->wl->way, 0);
	return ermOk();
}

static ErmErr onPointer(void *data, const ErmGiven *g, Json **out) {
	Handle *h = data;
	*out = jsonNull();
	Win *win = winOf(h->wl, h->id);
	Json *recs = recsOf(g);
	if (!win || !win->w) return ermOk();
	struct way_window *w = win->w;
	double s = w->scale > 0 ? w->scale : 1;
	for (int i = 0; jsonIsArray(recs) && i < recs->array.count; i++) {
		Json *r = recs->array.items[i];
		const char *e = jsonText(jsonGet(r, "event"));
		Json *x = jsonGet(r, "x"), *y = jsonGet(r, "y");
		if (!e || !jsonIsNumber(x) || !jsonIsNumber(y)) continue;
		pointAt(h->wl, win, x->number, y->number);
		int64_t b = 0;
		jsonIsWhole(jsonGet(r, "button"), &b);
		uint32_t button = b == 1 ? 0x111 : b == 2 ? 0x112 : 0x110;
		if (!strcmp(e, "down")) way_button(h->wl->way, button, true);
		else if (!strcmp(e, "up")) way_button(h->wl->way, button, false);
		else if (!strcmp(e, "scroll")) {
			Json *dx = jsonGet(r, "dx"), *dy = jsonGet(r, "dy");
			// the metal's dx, dy: frame buffer pixels, positive dy scrolling the content down, as wl_pointer.axis has it
			way_axis(h->wl->way, jsonIsNumber(dx) ? dx->number / s : 0, jsonIsNumber(dy) ? dy->number / s : 0);
		}
	}
	way_dispatch(h->wl->way, 0);
	return ermOk();
}

/** wmii's hover: {event: "move", x, y} over the window, no button down; {event: "leave"} when the pointer goes */
static ErmErr onHover(void *data, const ErmGiven *g, Json **out) {
	Handle *h = data;
	*out = jsonNull();
	Win *win = winOf(h->wl, h->id);
	Json *recs = recsOf(g);
	if (!win || !win->w) return ermOk();
	for (int i = 0; jsonIsArray(recs) && i < recs->array.count; i++) {
		Json *r = recs->array.items[i], *x = jsonGet(r, "x"), *y = jsonGet(r, "y");
		const char *e = jsonText(jsonGet(r, "event"));
		if (!e) continue;
		if (!strcmp(e, "leave") && h->wl->under == h->id) {
			way_pointer(h->wl->way, NULL, 0, 0);
			h->wl->under = 0;
		} else if (!strcmp(e, "move") && jsonIsNumber(x) && jsonIsNumber(y)) pointAt(h->wl, win, x->number, y->number);
	}
	way_dispatch(h->wl->way, 0);
	return ermOk();
}

// --- wmii's side: want {w, h} on a layer is a configure; a window node unplaced is a close

/** [[id, want or null, node there], ...], read tracked */
static ErmErr wantsCompute(void *data, const ErmGiven *g, Json **out) {
	Wayland *wl = data;
	*out = jsonArray();
	// read so a window placed since runs this again
	drvNames(g->api, drvPath("/", "dev", "wayland", "windows", NULL));
	for (int i = 0; i < wl->wins.count; i++) {
		Win *win = wl->wins.items[i];
		if (!win->placed || win->gone) continue;
		char *name = layerName(win->id);
		Json *l = drvRead(g->api, drvPath("/", "dev", "display", "layers", name, NULL)), *row = jsonArray();
		free(name);
		jsonPush(row, jsonInteger(win->id));
		jsonPush(row, l && jsonGet(l, "want") ? jsonShallow(jsonGet(l, "want")) : jsonNull());
		jsonPush(row, jsonBoolean(drvHas(g->api, windowNode(win->id))));
		jsonPush(*out, row);
	}
	return ermOk();
}

static ErmErr wantsEffect(void *data, const ErmGiven *g, Json **out) {
	Wayland *wl = data;
	*out = jsonNull();
	for (int i = 0; jsonIsArray(g->value) && i < g->value->array.count; i++) {
		Json *row = g->value->array.items[i], *want = row->array.items[1];
		int64_t id, w, h;
		if (!jsonIsWhole(row->array.items[0], &id)) continue;
		Win *win = winOf(wl, (uint32_t)id);
		if (!win || !win->w) continue;
		if (!row->array.items[2]->boolean) way_close(wl->way, win->w);
		else if (jsonIsWhole(jsonGet(want, "w"), &w) && jsonIsWhole(jsonGet(want, "h"), &h)) {
			int s = win->w->scale > 0 ? win->w->scale : 1;
			way_configure(wl->way, win->w, (int)(w / s), (int)(h / s), true);
		}
	}
	way_dispatch(wl->way, 0);
	return ermOk();
}

/** /dev/display/focus, read tracked: wmii's focused window */
static ErmErr focusCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *f = drvRead(g->api, drvPath("/", "dev", "display", "focus", NULL));
	*out = f ? jsonShallow(f) : jsonNull();
	return ermOk();
}

/** the keyboard follows wmii's focus: a Wayland window's layer, or none of them */
static ErmErr focusEffect(void *data, const ErmGiven *g, Json **out) {
	Wayland *wl = data;
	*out = jsonNull();
	const char *f = jsonText(g->value);
	Win *win = f && !strncmp(f, "wayland-", 8) ? winOf(wl, (uint32_t)strtoul(f + 8, NULL, 10)) : NULL;
	way_focus(wl->way, win ? win->w : NULL);
	way_dispatch(wl->way, 0);
	return ermOk();
}

ErmErr driverWayland(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Wayland *wl = calloc(1, sizeof *wl);
	wl->host = data;
	wl->self = copyString(jsonText(g->self));
	Json *mode = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
	int64_t unit = 1, w = 1280, h = 800;
	jsonIsWhole(jsonGet(mode, "unit"), &unit);
	jsonIsWhole(jsonGet(mode, "w"), &w);
	jsonIsWhole(jsonGet(mode, "h"), &h);
	wl->unit = unit > 0 ? (int)unit : 1;
	// the socket's folder: $XDG_RUNTIME_DIR, else ~/.ermine/wayland, the same every boot (wayland/run)
	const char *runtime = getenv("XDG_RUNTIME_DIR");
	if (!runtime || !*runtime) {
		const char *home = getenv("HOME") && *getenv("HOME") ? getenv("HOME") : "/tmp";
		char *top = formatString("%s/.ermine", home), *dir = formatString("%s/.ermine/wayland", home);
		mkdir(top, 0700);
		if (mkdir(dir, 0700) < 0) chmod(dir, 0700);
		setenv("XDG_RUNTIME_DIR", dir, 1);
		runtime = getenv("XDG_RUNTIME_DIR");
		free(top);
		free(dir);
	}
	// wayland-0 unless another compositor holds it: a crashed run's socket goes, as its lock is free (libwayland's wl_socket_lock)
	wl->way = way_create(NULL, &(struct way_hooks){ onEvent, wl });
	if (!wl->way) {
		hostSay(wl->host, "wayland: no socket in %s", runtime);
		return ermOk();
	}
	way_output(wl->way, (int)w, (int)h, wl->unit);
	Json *dev = drvPath("/", "dev", "wayland", NULL);
	drvMake(g->api, dev, "socket", "wayland/socket", drvMap("display", jsonString(way_socket(wl->way)), "runtime", jsonString(runtime), NULL));
	drvMake(g->api, dev, "windows", "wayland/windows", jsonNull());
	drvMake(g->api, dev, "planes", "wayland/planes", jsonNull());
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ wlIrq, wl });
	drvClaim(g, here, IRQ);
	drvChild(g, here, "wants", (ErmFn){ wantsCompute, wl }, (ErmFn){ wantsEffect, wl });
	drvChild(g, here, "focus", (ErmFn){ focusCompute, wl }, (ErmFn){ focusEffect, wl });
	pthread_mutex_init(&wl->lock, NULL);
	pthread_cond_init(&wl->taken, NULL);
	pthread_create(&wl->watcher, NULL, watch, wl);
	hostSay(wl->host, "wayland: WAYLAND_DISPLAY=%s XDG_RUNTIME_DIR=%s", way_socket(wl->way), runtime);
	return ermOk();
}
