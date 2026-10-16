// probe.c: a Wayland client for way_test. A toplevel, 100 x 80, opaque
// 0xff336699, titled "probe" (app_id "ermine.probe"), with a subsurface 20 x 20
// at 10, 10, premultiplied half red 0x80800000. It says on stdout, a line each,
// what the compositor sends it: keymap, output mode, pointer and keyboard
// events. A button press opens a popup, 30 x 20, at the pointer; close exits.

#define _DARWIN_C_SOURCE
#include <errno.h>
#include <stdarg.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor *compositor;
static struct wl_subcompositor *subcompositor;
static struct wl_shm *shm;
static struct xdg_wm_base *wm;
static struct wl_seat *seat;
static struct wl_surface *surface, *child, *popup_surface;
static struct xdg_surface *xdg, *popup_xdg;
static struct xdg_toplevel *toplevel;
static struct xdg_popup *popup;
static double px, py;
static int running = 1;

static void
say(const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	vprintf(fmt, ap);
	va_end(ap);
	putchar('\n');
	fflush(stdout);
}

static struct wl_buffer *
solid(int w, int h, uint32_t pixel, uint32_t format)
{
	char path[] = "/tmp/probe-XXXXXX";
	int fd = mkstemp(path), size = w * h * 4;
	uint32_t *data;
	struct wl_shm_pool *pool;
	struct wl_buffer *buffer;

	if (fd < 0 || ftruncate(fd, size) < 0) {
		perror("probe: buffer");
		exit(1);
	}
	unlink(path);
	data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (data == MAP_FAILED) {
		perror("probe: mmap");
		exit(1);
	}
	for (int i = 0; i < w * h; i++)
		data[i] = pixel;
	munmap(data, size);
	pool = wl_shm_create_pool(shm, fd, size);
	buffer = wl_shm_pool_create_buffer(pool, 0, w, h, w * 4, format);
	wl_shm_pool_destroy(pool);
	close(fd);
	return buffer;
}

// --- xdg

static void
wm_ping(void *data, struct xdg_wm_base *base, uint32_t serial)
{
	xdg_wm_base_pong(base, serial);
}

static const struct xdg_wm_base_listener wm_listener = { wm_ping };

static void
xdg_configure(void *data, struct xdg_surface *s, uint32_t serial)
{
	static int drawn;

	xdg_surface_ack_configure(s, serial);
	if (drawn++)
		return;
	wl_surface_attach(child, solid(20, 20, 0x80800000, WL_SHM_FORMAT_ARGB8888), 0, 0);
	wl_surface_commit(child);
	wl_surface_attach(surface, solid(100, 80, 0xff336699, WL_SHM_FORMAT_XRGB8888), 0, 0);
	wl_surface_commit(surface);
}

static const struct xdg_surface_listener xdg_listener = { xdg_configure };

static void
top_configure(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *states)
{
	uint32_t *st;
	int activated = 0;

	wl_array_for_each(st, states)
		if (*st == XDG_TOPLEVEL_STATE_ACTIVATED)
			activated = 1;
	say("configure %d %d %d", w, h, activated);
}

static void
top_close(void *data, struct xdg_toplevel *t)
{
	say("close");
	running = 0;
}

static void
top_bounds(void *data, struct xdg_toplevel *t, int32_t w, int32_t h)
{
}

static void
top_caps(void *data, struct xdg_toplevel *t, struct wl_array *caps)
{
	say("wm_capabilities");
}

static const struct xdg_toplevel_listener top_listener = { top_configure, top_close, top_bounds, top_caps };

static void
popup_xdg_configure(void *data, struct xdg_surface *s, uint32_t serial)
{
	xdg_surface_ack_configure(s, serial);
	wl_surface_attach(popup_surface, solid(30, 20, 0xff0000ff, WL_SHM_FORMAT_XRGB8888), 0, 0);
	wl_surface_commit(popup_surface);
}

static const struct xdg_surface_listener popup_xdg_listener = { popup_xdg_configure };

static void
popup_configure(void *data, struct xdg_popup *p, int32_t x, int32_t y, int32_t w, int32_t h)
{
	say("popup %d %d %d %d", x, y, w, h);
}

static void
popup_done(void *data, struct xdg_popup *p)
{
	say("popup_done");
}

static void
popup_repositioned(void *data, struct xdg_popup *p, uint32_t token)
{
}

static const struct xdg_popup_listener popup_listener = { popup_configure, popup_done, popup_repositioned };

static void
open_popup(void)
{
	struct xdg_positioner *pos = xdg_wm_base_create_positioner(wm);

	xdg_positioner_set_size(pos, 30, 20);
	xdg_positioner_set_anchor_rect(pos, (int)px, (int)py, 1, 1);
	xdg_positioner_set_anchor(pos, XDG_POSITIONER_ANCHOR_TOP_LEFT);
	xdg_positioner_set_gravity(pos, XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT);
	popup_surface = wl_compositor_create_surface(compositor);
	popup_xdg = xdg_wm_base_get_xdg_surface(wm, popup_surface);
	xdg_surface_add_listener(popup_xdg, &popup_xdg_listener, NULL);
	popup = xdg_surface_get_popup(popup_xdg, xdg, pos);
	xdg_popup_add_listener(popup, &popup_listener, NULL);
	xdg_positioner_destroy(pos);
	wl_surface_commit(popup_surface);
}

// --- seat

static void
p_enter(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *s, wl_fixed_t x, wl_fixed_t y)
{
	px = wl_fixed_to_double(x);
	py = wl_fixed_to_double(y);
	say("pointer enter %s %.2f %.2f", s == surface ? "toplevel" : "other", px, py);
}

static void
p_leave(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *s)
{
	say("pointer leave");
}

static void
p_motion(void *data, struct wl_pointer *p, uint32_t time, wl_fixed_t x, wl_fixed_t y)
{
	px = wl_fixed_to_double(x);
	py = wl_fixed_to_double(y);
	say("motion %.2f %.2f", px, py);
}

static void
p_button(void *data, struct wl_pointer *p, uint32_t serial, uint32_t time, uint32_t button, uint32_t state)
{
	say("button %u %u", button, state);
	if (state && !popup)
		open_popup();
}

static void
p_axis(void *data, struct wl_pointer *p, uint32_t time, uint32_t axis, wl_fixed_t value)
{
	say("axis %u %.2f", axis, wl_fixed_to_double(value));
}

static void p_frame(void *data, struct wl_pointer *p) {}
static void p_source(void *data, struct wl_pointer *p, uint32_t s) {}
static void p_stop(void *data, struct wl_pointer *p, uint32_t t, uint32_t a) {}
static void p_discrete(void *data, struct wl_pointer *p, uint32_t a, int32_t d) {}

static const struct wl_pointer_listener pointer_listener = {
	p_enter, p_leave, p_motion, p_button, p_axis, p_frame, p_source, p_stop, p_discrete,
	NULL, NULL, NULL,
};

static void
k_keymap(void *data, struct wl_keyboard *k, uint32_t format, int fd, uint32_t size)
{
	char *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);

	if (map == MAP_FAILED) {
		say("keymap unreadable %s", strerror(errno));
	} else {
		say("keymap %u %s %d", format, strncmp(map, "xkb_keymap", 10) == 0 ? "xkb" : "other",
		    map[size - 1] == 0);
		munmap(map, size);
	}
	close(fd);
}

static void
k_enter(void *data, struct wl_keyboard *k, uint32_t serial, struct wl_surface *s, struct wl_array *keys)
{
	say("keyboard enter %s", s == surface ? "toplevel" : "other");
}

static void
k_leave(void *data, struct wl_keyboard *k, uint32_t serial, struct wl_surface *s)
{
	say("keyboard leave");
}

static void
k_key(void *data, struct wl_keyboard *k, uint32_t serial, uint32_t time, uint32_t key, uint32_t state)
{
	say("key %u %u", key, state);
}

static void
k_mods(void *data, struct wl_keyboard *k, uint32_t serial, uint32_t depressed, uint32_t latched,
       uint32_t locked, uint32_t group)
{
	say("modifiers %u %u", depressed, locked);
}

static void
k_repeat(void *data, struct wl_keyboard *k, int32_t rate, int32_t delay)
{
	say("repeat %d %d", rate, delay);
}

static const struct wl_keyboard_listener keyboard_listener = { k_keymap, k_enter, k_leave, k_key, k_mods, k_repeat };

static void
seat_caps(void *data, struct wl_seat *s, uint32_t caps)
{
	if (caps & WL_SEAT_CAPABILITY_POINTER)
		wl_pointer_add_listener(wl_seat_get_pointer(s), &pointer_listener, NULL);
	if (caps & WL_SEAT_CAPABILITY_KEYBOARD)
		wl_keyboard_add_listener(wl_seat_get_keyboard(s), &keyboard_listener, NULL);
}

static void
seat_name(void *data, struct wl_seat *s, const char *name)
{
}

static const struct wl_seat_listener seat_listener = { seat_caps, seat_name };

static void o_geometry(void *d, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph, int32_t sp,
		       const char *make, const char *model, int32_t t) {}
static void
o_mode(void *d, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh)
{
	say("output mode %d %d", w, h);
}
static void o_done(void *d, struct wl_output *o) {}
static void o_scale(void *d, struct wl_output *o, int32_t f) {}
static void o_name(void *d, struct wl_output *o, const char *n) {}
static void o_description(void *d, struct wl_output *o, const char *n) {}

static const struct wl_output_listener output_listener = { o_geometry, o_mode, o_done, o_scale, o_name, o_description };

static void
s_enter(void *data, struct wl_surface *s, struct wl_output *o)
{
	say("surface enter output");
}

static void s_leave(void *data, struct wl_surface *s, struct wl_output *o) {}

static const struct wl_surface_listener surface_listener = { s_enter, s_leave, NULL, NULL };

static void
global(void *data, struct wl_registry *r, uint32_t name, const char *iface, uint32_t version)
{
	if (!strcmp(iface, "wl_compositor"))
		compositor = wl_registry_bind(r, name, &wl_compositor_interface, 4);
	else if (!strcmp(iface, "wl_subcompositor"))
		subcompositor = wl_registry_bind(r, name, &wl_subcompositor_interface, 1);
	else if (!strcmp(iface, "wl_shm"))
		shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
	else if (!strcmp(iface, "xdg_wm_base")) {
		wm = wl_registry_bind(r, name, &xdg_wm_base_interface, 5);
		xdg_wm_base_add_listener(wm, &wm_listener, NULL);
	} else if (!strcmp(iface, "wl_seat")) {
		seat = wl_registry_bind(r, name, &wl_seat_interface, 5);
		wl_seat_add_listener(seat, &seat_listener, NULL);
	} else if (!strcmp(iface, "wl_output")) {
		struct wl_output *o = wl_registry_bind(r, name, &wl_output_interface, 2);
		wl_output_add_listener(o, &output_listener, NULL);
	}
}

static void
global_remove(void *data, struct wl_registry *r, uint32_t name)
{
}

static const struct wl_registry_listener registry_listener = { global, global_remove };

int
main(void)
{
	struct wl_display *display = wl_display_connect(NULL);
	struct wl_subsurface *sub;

	if (!display) {
		fprintf(stderr, "probe: no display\n");
		return 1;
	}
	wl_registry_add_listener(wl_display_get_registry(display), &registry_listener, NULL);
	wl_display_roundtrip(display);
	if (!compositor || !subcompositor || !shm || !wm || !seat) {
		fprintf(stderr, "probe: a global is missing\n");
		return 1;
	}
	surface = wl_compositor_create_surface(compositor);
	wl_surface_add_listener(surface, &surface_listener, NULL);
	child = wl_compositor_create_surface(compositor);
	sub = wl_subcompositor_get_subsurface(subcompositor, child, surface);
	wl_subsurface_set_position(sub, 10, 10);
	wl_subsurface_set_desync(sub);
	xdg = xdg_wm_base_get_xdg_surface(wm, surface);
	xdg_surface_add_listener(xdg, &xdg_listener, NULL);
	toplevel = xdg_surface_get_toplevel(xdg);
	xdg_toplevel_add_listener(toplevel, &top_listener, NULL);
	xdg_toplevel_set_title(toplevel, "probe");
	xdg_toplevel_set_app_id(toplevel, "ermine.probe");
	wl_surface_commit(surface);
	while (running && wl_display_dispatch(display) != -1)
		;
	wl_display_disconnect(display);
	say("bye");
	return running ? 1 : 0;
}
