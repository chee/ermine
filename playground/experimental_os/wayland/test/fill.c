// fill.c: a Wayland client for measuring: a toplevel W x H (default
// 1000 x 700) that draws a new frame at every frame callback, a band
// moving across it, from two buffers it waits on (wl_buffer.release).
// After S seconds (default 10) it says on stdout how many frames it drew
// and how many a second, and exits.
//
//   way_fill [W H [S]]

#define _DARWIN_C_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm;
static struct wl_surface *surface;
static int W = 1000, H = 700, frames, configured;
static double start, seconds = 10;

static struct buf {
	struct wl_buffer *b;
	uint32_t *px;
	int busy;
} bufs[2];

static double now(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void released(void *data, struct wl_buffer *b) {
	((struct buf *)data)->busy = 0;
}
static const struct wl_buffer_listener buffer_listener = { released };

static void make(struct buf *b) {
	char path[] = "/tmp/fill-XXXXXX";
	int fd = mkstemp(path), size = W * H * 4;
	if (fd < 0 || ftruncate(fd, size) < 0) exit(1);
	unlink(path);
	b->px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, size);
	b->b = wl_shm_pool_create_buffer(pool, 0, W, H, W * 4, WL_SHM_FORMAT_XRGB8888);
	wl_buffer_add_listener(b->b, &buffer_listener, b);
	wl_shm_pool_destroy(pool);
	close(fd);
}

static void draw(void);

static void done(void *data, struct wl_callback *cb, uint32_t t) {
	wl_callback_destroy(cb);
	draw();
}
static const struct wl_callback_listener frame_listener = { done };

static void draw(void) {
	if (now() - start > seconds) {
		printf("frames %d in %.1f s: %.1f a second (%dx%d)\n", frames, now() - start, frames / (now() - start), W, H);
		fflush(stdout);
		exit(0);
	}
	struct buf *b = !bufs[0].busy ? &bufs[0] : !bufs[1].busy ? &bufs[1] : NULL;
	if (!b) {
		fprintf(stderr, "fill: both buffers held\n");
		b = &bufs[0];
	}
	int band = (frames * 8) % W;
	for (int y = 0; y < H; y++)
		for (int x = 0; x < W; x++)
			b->px[y * W + x] = x >= band && x < band + 40 ? 0xffcc2244 : 0xff000000 | ((x * 255 / W) << 8) | (y * 255 / H);
	b->busy = 1;
	wl_surface_attach(surface, b->b, 0, 0);
	wl_surface_damage(surface, 0, 0, W, H);
	wl_callback_add_listener(wl_surface_frame(surface), &frame_listener, NULL);
	wl_surface_commit(surface);
	frames++;
}

static void ping(void *data, struct xdg_wm_base *base, uint32_t serial) { xdg_wm_base_pong(base, serial); }
static const struct xdg_wm_base_listener wm_listener = { ping };

static void configure(void *data, struct xdg_surface *s, uint32_t serial) {
	xdg_surface_ack_configure(s, serial);
	if (configured++) return;
	start = now();
	draw();
}
static const struct xdg_surface_listener xdg_listener = { configure };

static void top_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *s) {}
static void top_close(void *d, struct xdg_toplevel *t) { exit(0); }
static void top_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {}
static void top_caps(void *d, struct xdg_toplevel *t, struct wl_array *c) {}
static const struct xdg_toplevel_listener top_listener = { top_configure, top_close, top_bounds, top_caps };

static void global(void *data, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version) {
	if (!strcmp(iface, "wl_compositor")) compositor = wl_registry_bind(r, name, &wl_compositor_interface, 4);
	else if (!strcmp(iface, "wl_shm")) shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
	else if (!strcmp(iface, "xdg_wm_base")) {
		wm = wl_registry_bind(r, name, &xdg_wm_base_interface, 5);
		xdg_wm_base_add_listener(wm, &wm_listener, NULL);
	}
}
static void global_remove(void *data, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener registry_listener = { global, global_remove };

int main(int argc, char **argv) {
	if (argc >= 3) W = atoi(argv[1]), H = atoi(argv[2]);
	if (argc >= 4) seconds = atof(argv[3]);
	struct wl_display *display = wl_display_connect(NULL);
	if (!display) {
		fprintf(stderr, "fill: no display\n");
		return 1;
	}
	wl_registry_add_listener(wl_display_get_registry(display), &registry_listener, NULL);
	wl_display_roundtrip(display);
	if (!compositor || !shm || !wm) return 1;
	make(&bufs[0]);
	make(&bufs[1]);
	surface = wl_compositor_create_surface(compositor);
	struct xdg_surface *xdg = xdg_wm_base_get_xdg_surface(wm, surface);
	xdg_surface_add_listener(xdg, &xdg_listener, NULL);
	struct xdg_toplevel *top = xdg_surface_get_toplevel(xdg);
	xdg_toplevel_add_listener(top, &top_listener, NULL);
	xdg_toplevel_set_title(top, "fill");
	wl_surface_commit(surface);
	while (wl_display_dispatch(display) != -1)
		;
	return 1;
}
