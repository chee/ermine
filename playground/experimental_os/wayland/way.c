// way.c: the compositor way.h describes, on libwayland-server. The
// protocols' marshalling is libwayland's and wayland-scanner's (from
// wayland.xml and wayland-protocols' xdg-shell.xml); wl_shm is libwayland's
// (wl_display_init_shm). What is here is the compositor's state: surfaces and
// their double-buffered state, roles, the seat's focus, and copying each
// committed shm buffer into its window's image.

#define _DARWIN_C_SOURCE
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <wayland-server.h>
#include "xdg-shell-server-protocol.h"

#include "way.h"

extern const char way_keymap[]; // keymap.c, made from keymap/us.xkb
extern const unsigned way_keymap_size;

static const char empty[] = ""; // a window's title and app_id until set

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

struct way {
	struct wl_display *display;
	struct wl_event_loop *loop;
	const char *socket;
	char socket_name[64];
	struct way_hooks hooks;
	struct wl_list surfaces; // way_surface.link
	struct wl_list windows;  // way_xdg.link
	struct wl_list pointers, keyboards, outputs; // wl_resource links
	uint32_t next_id;
	int out_w, out_h, out_scale;
	int keymap_fd;
	uint32_t keymap_size;
	struct way_xdg *pointer_focus, *key_focus;
	double px, py;
	uint32_t mods_depressed, mods_locked;
};

enum role { ROLE_NONE, ROLE_XDG, ROLE_SUB, ROLE_CURSOR };

struct way_sub;
struct way_xdg;

struct way_surface {
	struct way *way;
	struct wl_resource *resource;
	struct wl_list link;
	// pending, applied by commit
	struct wl_resource *pending_buffer;
	bool pending_attach;
	struct wl_listener pending_buffer_destroy;
	struct wl_list pending_frames;
	int pending_scale;
	// current
	struct wl_list frames;
	uint32_t *pixels;
	int w, h, scale;
	bool opaque, has_buffer;
	enum role role;
	struct way_xdg *xdg;      // ROLE_XDG
	struct way_sub *sub;      // ROLE_SUB: this surface as a child
	struct wl_list children;  // way_sub.link, bottom to top
};

struct way_sub {
	struct wl_resource *resource;
	struct way_surface *surface, *parent;
	int x, y, px, py;
	struct wl_list link;
};

struct positioner {
	int w, h;
	int ax, ay, aw, ah;
	uint32_t anchor, gravity;
	int ox, oy;
};

struct way_xdg {
	struct way *way;
	struct wl_resource *resource;      // xdg_surface
	struct wl_resource *role_resource; // xdg_toplevel or xdg_popup
	struct way_surface *surface;
	struct way_window win;
	bool in_list;                      // in way->windows
	bool configure_sent, acked;
	uint32_t serial;
	bool pgeom;
	int pgx, pgy, pgw, pgh;
	int cw, ch;
	bool activated;
	struct way_xdg *parent;            // a popup's
	struct positioner pos;
	struct wl_list link;
};

static uint32_t
now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint32_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}

static void
unlink_resource(struct wl_resource *resource)
{
	wl_list_remove(wl_resource_get_link(resource));
}

static void
emit(struct way *way, struct way_xdg *xdg, enum way_event event)
{
	if (way->hooks.event)
		way->hooks.event(way->hooks.data, &xdg->win, event);
}

static struct way_xdg *
window_xdg(struct way_window *window)
{
	return window ? wl_container_of(window, (struct way_xdg *)NULL, win) : NULL;
}

// --- the image

static struct way_surface *
root_of(struct way_surface *s)
{
	while (s && s->role == ROLE_SUB && s->sub && s->sub->parent)
		s = s->sub->parent;
	return s;
}

static void
blend(uint32_t *dst, int dw, int dh, const struct way_surface *s, int x, int y)
{
	for (int j = 0; j < s->h; j++) {
		int ty = y + j;
		if (ty < 0 || ty >= dh)
			continue;
		const uint32_t *src = s->pixels + (size_t)j * s->w;
		uint32_t *row = dst + (size_t)ty * dw;
		for (int i = 0; i < s->w; i++) {
			int tx = x + i;
			if (tx < 0 || tx >= dw)
				continue;
			uint32_t p = src[i], a = p >> 24;
			if (a == 0xff) {
				row[tx] = p;
			} else if (a) {
				uint32_t q = row[tx], k = 255 - a, out = 0;
				for (int sh = 0; sh < 32; sh += 8) {
					uint32_t c = ((p >> sh) & 0xff) + (((q >> sh) & 0xff) * k + 127) / 255;
					out |= MIN(c, 255u) << sh;
				}
				row[tx] = out;
			}
		}
	}
}

static void
blend_children(uint32_t *dst, int dw, int dh, struct way_surface *s, int x, int y)
{
	struct way_sub *sub;

	wl_list_for_each(sub, &s->children, link) {
		if (!sub->surface || !sub->surface->has_buffer)
			continue;
		blend(dst, dw, dh, sub->surface, x + sub->x, y + sub->y);
		blend_children(dst, dw, dh, sub->surface, x + sub->x, y + sub->y);
	}
}

static void
compose(struct way_xdg *xdg)
{
	struct way_surface *s = xdg->surface;
	struct way_window *win = &xdg->win;
	size_t n = (size_t)s->w * s->h;

	if (win->w != s->w || win->h != s->h || !win->pixels) {
		free(win->pixels);
		win->pixels = malloc(n * 4 ? n * 4 : 4);
		win->w = s->w;
		win->h = s->h;
	}
	memcpy(win->pixels, s->pixels, n * 4);
	blend_children(win->pixels, s->w, s->h, s, 0, 0);
	win->scale = s->scale;
	win->opaque = s->opaque;
	win->dx = win->dy = 0;
	win->dw = s->w;
	win->dh = s->h;
	win->commits++;
}

// --- regions: kept by no one; wl_region's requests are taken and dropped

static void
resource_destroy(struct wl_client *client, struct wl_resource *resource)
{
	wl_resource_destroy(resource);
}

static void
region_rect(struct wl_client *client, struct wl_resource *resource,
	    int32_t x, int32_t y, int32_t w, int32_t h)
{
}

static const struct wl_region_interface region_impl = {
	.destroy = resource_destroy,
	.add = region_rect,
	.subtract = region_rect,
};

// --- surfaces

static void xdg_end(struct way_xdg *xdg);

static void
pending_buffer_gone(struct wl_listener *listener, void *data)
{
	struct way_surface *s = wl_container_of(listener, s, pending_buffer_destroy);

	s->pending_buffer = NULL;
	wl_list_remove(&listener->link);
	wl_list_init(&listener->link);
}

static void
surface_attach(struct wl_client *client, struct wl_resource *resource,
	       struct wl_resource *buffer, int32_t x, int32_t y)
{
	struct way_surface *s = wl_resource_get_user_data(resource);

	wl_list_remove(&s->pending_buffer_destroy.link);
	wl_list_init(&s->pending_buffer_destroy.link);
	s->pending_buffer = buffer;
	s->pending_attach = true;
	if (buffer)
		wl_resource_add_destroy_listener(buffer, &s->pending_buffer_destroy);
}

static void
surface_damage(struct wl_client *client, struct wl_resource *resource,
	       int32_t x, int32_t y, int32_t w, int32_t h)
{
	// every commit with a buffer is taken whole
}

static void
surface_frame(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct way_surface *s = wl_resource_get_user_data(resource);
	struct wl_resource *cb = wl_resource_create(client, &wl_callback_interface, 1, id);

	if (!cb) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(cb, NULL, NULL, unlink_resource);
	wl_list_insert(s->pending_frames.prev, wl_resource_get_link(cb));
}

static void
surface_region(struct wl_client *client, struct wl_resource *resource, struct wl_resource *region)
{
}

static void
surface_transform(struct wl_client *client, struct wl_resource *resource, int32_t transform)
{
}

static void
surface_scale(struct wl_client *client, struct wl_resource *resource, int32_t scale)
{
	struct way_surface *s = wl_resource_get_user_data(resource);

	if (scale < 1) {
		wl_resource_post_error(resource, WL_SURFACE_ERROR_INVALID_SCALE, "scale %d", scale);
		return;
	}
	s->pending_scale = scale;
}

static void
surface_offset(struct wl_client *client, struct wl_resource *resource, int32_t x, int32_t y)
{
}

/** takes the pending buffer into s's own pixels; false if the client erred */
static bool
take_buffer(struct way_surface *s)
{
	struct wl_resource *buffer = s->pending_buffer;
	struct wl_shm_buffer *shm;
	uint32_t format;
	int w, h, stride;

	if (!buffer) {
		s->has_buffer = false;
		return true;
	}
	shm = wl_shm_buffer_get(buffer);
	if (!shm) {
		wl_resource_post_error(s->resource, WL_SURFACE_ERROR_INVALID_SIZE,
				       "only wl_shm buffers are taken");
		return false;
	}
	w = wl_shm_buffer_get_width(shm);
	h = wl_shm_buffer_get_height(shm);
	stride = wl_shm_buffer_get_stride(shm);
	format = wl_shm_buffer_get_format(shm);
	if (format != WL_SHM_FORMAT_ARGB8888 && format != WL_SHM_FORMAT_XRGB8888) {
		wl_resource_post_error(s->resource, WL_SURFACE_ERROR_INVALID_SIZE,
				       "format %u is not taken", format);
		return false;
	}
	if (s->w != w || s->h != h || !s->pixels) {
		free(s->pixels);
		s->pixels = malloc((size_t)w * h * 4 ? (size_t)w * h * 4 : 4);
		s->w = w;
		s->h = h;
	}
	wl_shm_buffer_begin_access(shm);
	const uint8_t *data = wl_shm_buffer_get_data(shm);
	for (int y = 0; y < h; y++) {
		const uint32_t *src = (const uint32_t *)(data + (size_t)y * stride);
		uint32_t *dst = s->pixels + (size_t)y * w;
		if (format == WL_SHM_FORMAT_XRGB8888)
			for (int x = 0; x < w; x++)
				dst[x] = src[x] | 0xff000000u;
		else
			memcpy(dst, src, (size_t)w * 4);
	}
	wl_shm_buffer_end_access(shm);
	s->opaque = format == WL_SHM_FORMAT_XRGB8888;
	s->has_buffer = true;
	// copied: the client may have it back now
	wl_buffer_send_release(buffer);
	return true;
}

static void
send_enter_outputs(struct way_surface *s)
{
	struct wl_resource *out;
	struct wl_client *client = wl_resource_get_client(s->resource);

	wl_resource_for_each(out, &s->way->outputs)
		if (wl_resource_get_client(out) == client)
			wl_surface_send_enter(s->resource, out);
}

static void
send_configure(struct way_xdg *xdg)
{
	struct way *way = xdg->way;

	xdg->serial = wl_display_next_serial(way->display);
	if (xdg->win.popup) {
		xdg_popup_send_configure(xdg->role_resource, xdg->win.x, xdg->win.y,
					 xdg->pos.w, xdg->pos.h);
	} else {
		struct wl_array states;
		wl_array_init(&states);
		if (xdg->activated) {
			uint32_t *st = wl_array_add(&states, sizeof *st);
			if (st)
				*st = XDG_TOPLEVEL_STATE_ACTIVATED;
		}
		xdg_toplevel_send_configure(xdg->role_resource, xdg->cw, xdg->ch, &states);
		wl_array_release(&states);
	}
	xdg_surface_send_configure(xdg->resource, xdg->serial);
	xdg->configure_sent = true;
}

static void
xdg_commit(struct way_xdg *xdg)
{
	struct way_surface *s = xdg->surface;
	struct way *way = xdg->way;

	if (xdg->pgeom) {
		xdg->win.gx = xdg->pgx;
		xdg->win.gy = xdg->pgy;
		xdg->win.gw = xdg->pgw;
		xdg->win.gh = xdg->pgh;
		xdg->pgeom = false;
	}
	if (!xdg->role_resource) {
		if (s->has_buffer)
			wl_resource_post_error(xdg->resource, XDG_SURFACE_ERROR_NOT_CONSTRUCTED,
					       "a buffer before a role");
		return;
	}
	if (!xdg->configure_sent) {
		if (s->has_buffer) {
			wl_resource_post_error(xdg->resource, XDG_SURFACE_ERROR_UNCONFIGURED_BUFFER,
					       "a buffer before the first configure");
			return;
		}
		send_configure(xdg);
		return;
	}
	if (s->has_buffer && !xdg->acked) {
		wl_resource_post_error(xdg->resource, XDG_SURFACE_ERROR_UNCONFIGURED_BUFFER,
				       "a buffer before ack_configure");
		return;
	}
	if (s->has_buffer) {
		if (!xdg->pgeom && xdg->win.gw == 0) {
			xdg->win.gw = s->w / (s->scale ? s->scale : 1);
			xdg->win.gh = s->h / (s->scale ? s->scale : 1);
		}
		compose(xdg);
		if (!xdg->win.mapped) {
			xdg->win.mapped = true;
			send_enter_outputs(s);
			emit(way, xdg, WAY_MAP);
		} else {
			emit(way, xdg, WAY_COMMIT);
		}
	} else if (xdg->win.mapped) {
		// unmapped: the client starts again with an initial commit
		xdg->win.mapped = false;
		xdg->configure_sent = false;
		xdg->acked = false;
		emit(way, xdg, WAY_UNMAP);
	}
}

static void
surface_commit(struct wl_client *client, struct wl_resource *resource)
{
	struct way_surface *s = wl_resource_get_user_data(resource);
	struct way_sub *sub;

	if (s->pending_attach) {
		if (!take_buffer(s))
			return;
		s->pending_attach = false;
		wl_list_remove(&s->pending_buffer_destroy.link);
		wl_list_init(&s->pending_buffer_destroy.link);
		s->pending_buffer = NULL;
	}
	s->scale = s->pending_scale;
	wl_list_insert_list(s->frames.prev, &s->pending_frames);
	wl_list_init(&s->pending_frames);
	// a parent's commit places its children
	wl_list_for_each(sub, &s->children, link) {
		sub->x = sub->px;
		sub->y = sub->py;
	}

	if (s->role == ROLE_XDG && s->xdg) {
		xdg_commit(s->xdg);
	} else if (s->role == ROLE_SUB) {
		// desynchronized, always: the window's image is made again now
		struct way_surface *root = root_of(s);
		if (root && root != s && root->role == ROLE_XDG && root->xdg &&
		    root->xdg->win.mapped && root->has_buffer) {
			compose(root->xdg);
			emit(s->way, root->xdg, WAY_COMMIT);
		}
	}
}

static void
surface_gone(struct wl_resource *resource)
{
	struct way_surface *s = wl_resource_get_user_data(resource);
	struct wl_resource *cb, *tmp;
	struct way_sub *sub, *stmp;

	wl_resource_for_each_safe(cb, tmp, &s->pending_frames)
		wl_resource_destroy(cb);
	wl_resource_for_each_safe(cb, tmp, &s->frames)
		wl_resource_destroy(cb);
	wl_list_remove(&s->pending_buffer_destroy.link);
	if (s->xdg) {
		struct way_xdg *xdg = s->xdg;
		xdg_end(xdg);
		xdg->surface = NULL;
	}
	if (s->sub) {
		// this surface was a child: the subsurface stays, empty
		wl_list_remove(&s->sub->link);
		wl_list_init(&s->sub->link);
		s->sub->surface = NULL;
		s->sub->parent = NULL;
	}
	wl_list_for_each_safe(sub, stmp, &s->children, link) {
		wl_list_remove(&sub->link);
		wl_list_init(&sub->link);
		sub->parent = NULL;
	}
	wl_list_remove(&s->link);
	free(s->pixels);
	free(s);
}

static const struct wl_surface_interface surface_impl = {
	.destroy = resource_destroy,
	.attach = surface_attach,
	.damage = surface_damage,
	.frame = surface_frame,
	.set_opaque_region = surface_region,
	.set_input_region = surface_region,
	.commit = surface_commit,
	.set_buffer_transform = surface_transform,
	.set_buffer_scale = surface_scale,
	.damage_buffer = surface_damage,
	.offset = surface_offset,
};

static void
compositor_create_surface(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct way *way = wl_resource_get_user_data(resource);
	struct way_surface *s = calloc(1, sizeof *s);

	if (!s) {
		wl_client_post_no_memory(client);
		return;
	}
	s->resource = wl_resource_create(client, &wl_surface_interface,
					 wl_resource_get_version(resource), id);
	if (!s->resource) {
		free(s);
		wl_client_post_no_memory(client);
		return;
	}
	s->way = way;
	s->scale = s->pending_scale = 1;
	wl_list_init(&s->pending_frames);
	wl_list_init(&s->frames);
	wl_list_init(&s->children);
	wl_list_init(&s->pending_buffer_destroy.link);
	s->pending_buffer_destroy.notify = pending_buffer_gone;
	wl_list_insert(&way->surfaces, &s->link);
	wl_resource_set_implementation(s->resource, &surface_impl, s, surface_gone);
}

static void
compositor_create_region(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_region_interface,
						   wl_resource_get_version(resource), id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &region_impl, NULL, NULL);
}

static const struct wl_compositor_interface compositor_impl = {
	.create_surface = compositor_create_surface,
	.create_region = compositor_create_region,
};

static void
bind_compositor(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_compositor_interface, version, id);

	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &compositor_impl, data, NULL);
}

// --- subsurfaces: always desynchronized, drawn over their parent in order

static void
sub_position(struct wl_client *client, struct wl_resource *resource, int32_t x, int32_t y)
{
	struct way_sub *sub = wl_resource_get_user_data(resource);

	if (sub) {
		sub->px = x;
		sub->py = y;
	}
}

static void
sub_restack(struct wl_resource *resource, struct wl_resource *sibling, bool above)
{
	struct way_sub *sub = wl_resource_get_user_data(resource);
	struct way_surface *other = wl_resource_get_user_data(sibling);

	if (!sub || !sub->parent)
		return;
	wl_list_remove(&sub->link);
	if (other == sub->parent) {
		// the parent itself: children are drawn above it, so to the bottom
		wl_list_insert(&sub->parent->children, &sub->link);
	} else if (other->sub && other->sub->parent == sub->parent) {
		if (above)
			wl_list_insert(&other->sub->link, &sub->link);
		else
			wl_list_insert(other->sub->link.prev, &sub->link);
	} else {
		wl_list_insert(sub->parent->children.prev, &sub->link);
	}
}

static void
sub_above(struct wl_client *client, struct wl_resource *resource, struct wl_resource *sibling)
{
	sub_restack(resource, sibling, true);
}

static void
sub_below(struct wl_client *client, struct wl_resource *resource, struct wl_resource *sibling)
{
	sub_restack(resource, sibling, false);
}

static void
sub_sync(struct wl_client *client, struct wl_resource *resource)
{
}

static const struct wl_subsurface_interface sub_impl = {
	.destroy = resource_destroy,
	.set_position = sub_position,
	.place_above = sub_above,
	.place_below = sub_below,
	.set_sync = sub_sync,
	.set_desync = sub_sync,
};

static void
sub_gone(struct wl_resource *resource)
{
	struct way_sub *sub = wl_resource_get_user_data(resource);

	if (!sub)
		return;
	if (sub->surface) {
		sub->surface->sub = NULL;
		sub->surface->role = ROLE_NONE;
	}
	wl_list_remove(&sub->link);
	free(sub);
}

static void
subcompositor_get(struct wl_client *client, struct wl_resource *resource, uint32_t id,
		  struct wl_resource *surface, struct wl_resource *parent)
{
	struct way_surface *s = wl_resource_get_user_data(surface);
	struct way_surface *p = wl_resource_get_user_data(parent);
	struct way_sub *sub;

	if (s->role != ROLE_NONE || s == p) {
		wl_resource_post_error(resource, WL_SUBCOMPOSITOR_ERROR_BAD_SURFACE,
				       "the surface has a role already");
		return;
	}
	sub = calloc(1, sizeof *sub);
	if (!sub) {
		wl_client_post_no_memory(client);
		return;
	}
	sub->resource = wl_resource_create(client, &wl_subsurface_interface, 1, id);
	if (!sub->resource) {
		free(sub);
		wl_client_post_no_memory(client);
		return;
	}
	sub->surface = s;
	sub->parent = p;
	s->role = ROLE_SUB;
	s->sub = sub;
	wl_list_insert(p->children.prev, &sub->link);
	wl_resource_set_implementation(sub->resource, &sub_impl, sub, sub_gone);
}

static const struct wl_subcompositor_interface subcompositor_impl = {
	.destroy = resource_destroy,
	.get_subsurface = subcompositor_get,
};

static void
bind_subcompositor(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_subcompositor_interface, version, id);

	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &subcompositor_impl, data, NULL);
}

// --- output

static void
send_output(struct way *way, struct wl_resource *r)
{
	int version = wl_resource_get_version(r);

	wl_output_send_geometry(r, 0, 0, 0, 0, WL_OUTPUT_SUBPIXEL_UNKNOWN,
				"ermine", "ermine", WL_OUTPUT_TRANSFORM_NORMAL);
	wl_output_send_mode(r, WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED,
			    way->out_w, way->out_h, 60000);
	if (version >= WL_OUTPUT_SCALE_SINCE_VERSION)
		wl_output_send_scale(r, way->out_scale);
	if (version >= WL_OUTPUT_NAME_SINCE_VERSION)
		wl_output_send_name(r, "ermine-0");
	if (version >= WL_OUTPUT_DESCRIPTION_SINCE_VERSION)
		wl_output_send_description(r, "ermineOS's screen");
	if (version >= WL_OUTPUT_DONE_SINCE_VERSION)
		wl_output_send_done(r);
}

static const struct wl_output_interface output_impl = {
	.release = resource_destroy,
};

static void
bind_output(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct way *way = data;
	struct wl_resource *r = wl_resource_create(client, &wl_output_interface, version, id);

	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &output_impl, way, unlink_resource);
	wl_list_insert(&way->outputs, wl_resource_get_link(r));
	send_output(way, r);
}

void
way_output(struct way *way, int w, int h, int scale)
{
	struct wl_resource *r;

	way->out_w = w;
	way->out_h = h;
	way->out_scale = scale > 0 ? scale : 1;
	wl_resource_for_each(r, &way->outputs)
		send_output(way, r);
}

// --- seat

static void
pointer_set_cursor(struct wl_client *client, struct wl_resource *resource, uint32_t serial,
		   struct wl_resource *surface, int32_t x, int32_t y)
{
	// the host draws its own cursor; the client's surface takes the role and is not shown
	if (surface) {
		struct way_surface *s = wl_resource_get_user_data(surface);
		if (s->role == ROLE_NONE)
			s->role = ROLE_CURSOR;
	}
}

static const struct wl_pointer_interface pointer_impl = {
	.set_cursor = pointer_set_cursor,
	.release = resource_destroy,
};

static const struct wl_keyboard_interface keyboard_impl = {
	.release = resource_destroy,
};

static const struct wl_touch_interface touch_impl = {
	.release = resource_destroy,
};

static struct wl_client *
xdg_client(struct way_xdg *xdg)
{
	return xdg && xdg->surface ? wl_resource_get_client(xdg->surface->resource) : NULL;
}

static void
keyboard_enter(struct way *way, struct wl_resource *k)
{
	struct wl_array keys;

	wl_array_init(&keys);
	wl_keyboard_send_enter(k, wl_display_next_serial(way->display),
			       way->key_focus->surface->resource, &keys);
	wl_array_release(&keys);
	wl_keyboard_send_modifiers(k, wl_display_next_serial(way->display),
				   way->mods_depressed, 0, way->mods_locked, 0);
}

static void
seat_get_pointer(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct way *way = wl_resource_get_user_data(resource);
	struct wl_resource *r = wl_resource_create(client, &wl_pointer_interface,
						   wl_resource_get_version(resource), id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &pointer_impl, way, unlink_resource);
	wl_list_insert(&way->pointers, wl_resource_get_link(r));
	if (xdg_client(way->pointer_focus) == client) {
		wl_pointer_send_enter(r, wl_display_next_serial(way->display),
				      way->pointer_focus->surface->resource,
				      wl_fixed_from_double(way->px), wl_fixed_from_double(way->py));
		if (wl_resource_get_version(r) >= WL_POINTER_FRAME_SINCE_VERSION)
			wl_pointer_send_frame(r);
	}
}

static void
seat_get_keyboard(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct way *way = wl_resource_get_user_data(resource);
	struct wl_resource *r = wl_resource_create(client, &wl_keyboard_interface,
						   wl_resource_get_version(resource), id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &keyboard_impl, way, unlink_resource);
	wl_list_insert(&way->keyboards, wl_resource_get_link(r));
	wl_keyboard_send_keymap(r, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, way->keymap_fd, way->keymap_size);
	if (wl_resource_get_version(r) >= WL_KEYBOARD_REPEAT_INFO_SINCE_VERSION)
		wl_keyboard_send_repeat_info(r, 25, 600);
	if (xdg_client(way->key_focus) == client)
		keyboard_enter(way, r);
}

static void
seat_get_touch(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_touch_interface,
						   wl_resource_get_version(resource), id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &touch_impl, NULL, NULL);
}

static const struct wl_seat_interface seat_impl = {
	.get_pointer = seat_get_pointer,
	.get_keyboard = seat_get_keyboard,
	.get_touch = seat_get_touch,
	.release = resource_destroy,
};

static void
bind_seat(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_seat_interface, version, id);

	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &seat_impl, data, NULL);
	wl_seat_send_capabilities(r, WL_SEAT_CAPABILITY_POINTER | WL_SEAT_CAPABILITY_KEYBOARD);
	if (version >= WL_SEAT_NAME_SINCE_VERSION)
		wl_seat_send_name(r, "seat0");
}

static void
pointer_frame_all(struct way *way, struct wl_client *client)
{
	struct wl_resource *r;

	wl_resource_for_each(r, &way->pointers)
		if (wl_resource_get_client(r) == client &&
		    wl_resource_get_version(r) >= WL_POINTER_FRAME_SINCE_VERSION)
			wl_pointer_send_frame(r);
}

void
way_pointer(struct way *way, struct way_window *window, double x, double y)
{
	struct way_xdg *xdg = window_xdg(window);
	struct wl_resource *r;
	uint32_t t = now_ms();

	if (xdg && !xdg->surface)
		xdg = NULL;
	if (xdg != way->pointer_focus) {
		struct wl_client *old = xdg_client(way->pointer_focus);
		if (old) {
			uint32_t serial = wl_display_next_serial(way->display);
			wl_resource_for_each(r, &way->pointers)
				if (wl_resource_get_client(r) == old)
					wl_pointer_send_leave(r, serial, way->pointer_focus->surface->resource);
			pointer_frame_all(way, old);
		}
		way->pointer_focus = xdg;
		way->px = x;
		way->py = y;
		if (xdg) {
			uint32_t serial = wl_display_next_serial(way->display);
			wl_resource_for_each(r, &way->pointers)
				if (wl_resource_get_client(r) == xdg_client(xdg))
					wl_pointer_send_enter(r, serial, xdg->surface->resource,
							      wl_fixed_from_double(x), wl_fixed_from_double(y));
			pointer_frame_all(way, xdg_client(xdg));
		}
		return;
	}
	if (!xdg)
		return;
	way->px = x;
	way->py = y;
	wl_resource_for_each(r, &way->pointers)
		if (wl_resource_get_client(r) == xdg_client(xdg))
			wl_pointer_send_motion(r, t, wl_fixed_from_double(x), wl_fixed_from_double(y));
	pointer_frame_all(way, xdg_client(xdg));
}

void
way_button(struct way *way, uint32_t button, bool down)
{
	struct wl_client *client = xdg_client(way->pointer_focus);
	struct wl_resource *r;
	uint32_t serial, t = now_ms();

	if (!client)
		return;
	serial = wl_display_next_serial(way->display);
	wl_resource_for_each(r, &way->pointers)
		if (wl_resource_get_client(r) == client)
			wl_pointer_send_button(r, serial, t, button,
					       down ? WL_POINTER_BUTTON_STATE_PRESSED
						    : WL_POINTER_BUTTON_STATE_RELEASED);
	pointer_frame_all(way, client);
}

void
way_axis(struct way *way, double dx, double dy)
{
	struct wl_client *client = xdg_client(way->pointer_focus);
	struct wl_resource *r;
	uint32_t t = now_ms();

	if (!client)
		return;
	wl_resource_for_each(r, &way->pointers) {
		if (wl_resource_get_client(r) != client)
			continue;
		if (dy != 0)
			wl_pointer_send_axis(r, t, WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_double(dy));
		if (dx != 0)
			wl_pointer_send_axis(r, t, WL_POINTER_AXIS_HORIZONTAL_SCROLL, wl_fixed_from_double(dx));
	}
	pointer_frame_all(way, client);
}

void
way_focus(struct way *way, struct way_window *window)
{
	struct way_xdg *xdg = window_xdg(window);
	struct wl_resource *r;

	if (xdg && !xdg->surface)
		xdg = NULL;
	if (xdg == way->key_focus)
		return;
	if (way->key_focus) {
		struct wl_client *old = xdg_client(way->key_focus);
		uint32_t serial = wl_display_next_serial(way->display);
		wl_resource_for_each(r, &way->keyboards)
			if (wl_resource_get_client(r) == old)
				wl_keyboard_send_leave(r, serial, way->key_focus->surface->resource);
	}
	way->key_focus = xdg;
	if (xdg) {
		wl_resource_for_each(r, &way->keyboards)
			if (wl_resource_get_client(r) == xdg_client(xdg))
				keyboard_enter(way, r);
	}
}

// xkb's real modifiers, as the evdev keymap has them: Shift, Lock, Control, Mod1 (Alt), Mod4 (Super)
enum { M_SHIFT = 1 << 0, M_LOCK = 1 << 1, M_CTRL = 1 << 2, M_ALT = 1 << 3, M_SUPER = 1 << 6 };

static uint32_t
modifier_of(uint32_t key)
{
	switch (key) {
	case 42: case 54: return M_SHIFT;    // KEY_LEFTSHIFT, KEY_RIGHTSHIFT
	case 29: case 97: return M_CTRL;     // KEY_LEFTCTRL, KEY_RIGHTCTRL
	case 56: case 100: return M_ALT;     // KEY_LEFTALT, KEY_RIGHTALT
	case 125: case 126: return M_SUPER;  // KEY_LEFTMETA, KEY_RIGHTMETA
	default: return 0;
	}
}

void
way_key(struct way *way, uint32_t key, bool down)
{
	struct wl_client *client = xdg_client(way->key_focus);
	struct wl_resource *r;
	uint32_t before = way->mods_depressed, locked = way->mods_locked;
	uint32_t m = modifier_of(key);

	if (m)
		way->mods_depressed = down ? (way->mods_depressed | m) : (way->mods_depressed & ~m);
	if (key == 58 && down) // KEY_CAPSLOCK
		way->mods_locked ^= M_LOCK;
	if (!client)
		return;
	uint32_t serial = wl_display_next_serial(way->display), t = now_ms();
	wl_resource_for_each(r, &way->keyboards) {
		if (wl_resource_get_client(r) != client)
			continue;
		wl_keyboard_send_key(r, serial, t, key,
				     down ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
		if (before != way->mods_depressed || locked != way->mods_locked)
			wl_keyboard_send_modifiers(r, wl_display_next_serial(way->display),
						   way->mods_depressed, 0, way->mods_locked, 0);
	}
}

// --- data devices: there so toolkits that want them start; nothing is copied yet

static void
source_offer(struct wl_client *client, struct wl_resource *resource, const char *type)
{
}

static void
source_actions(struct wl_client *client, struct wl_resource *resource, uint32_t actions)
{
}

static const struct wl_data_source_interface source_impl = {
	.offer = source_offer,
	.destroy = resource_destroy,
	.set_actions = source_actions,
};

static void
device_drag(struct wl_client *client, struct wl_resource *resource, struct wl_resource *source,
	    struct wl_resource *origin, struct wl_resource *icon, uint32_t serial)
{
	if (source)
		wl_data_source_send_cancelled(source);
}

static void
device_selection(struct wl_client *client, struct wl_resource *resource,
		 struct wl_resource *source, uint32_t serial)
{
}

static const struct wl_data_device_interface device_impl = {
	.start_drag = device_drag,
	.set_selection = device_selection,
	.release = resource_destroy,
};

static void
ddm_create_source(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_data_source_interface,
						   wl_resource_get_version(resource), id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &source_impl, NULL, NULL);
}

static void
ddm_get_device(struct wl_client *client, struct wl_resource *resource, uint32_t id,
	       struct wl_resource *seat)
{
	struct wl_resource *r = wl_resource_create(client, &wl_data_device_interface,
						   wl_resource_get_version(resource), id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &device_impl, NULL, NULL);
}

static const struct wl_data_device_manager_interface ddm_impl = {
	.create_data_source = ddm_create_source,
	.get_data_device = ddm_get_device,
};

static void
bind_ddm(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &wl_data_device_manager_interface,
						   version, id);
	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &ddm_impl, data, NULL);
}

// --- xdg_shell

static void
positioner_gone(struct wl_resource *resource)
{
	free(wl_resource_get_user_data(resource));
}

static struct positioner *
positioner_of(struct wl_resource *resource)
{
	return wl_resource_get_user_data(resource);
}

static void
pos_size(struct wl_client *client, struct wl_resource *resource, int32_t w, int32_t h)
{
	if (w <= 0 || h <= 0) {
		wl_resource_post_error(resource, XDG_POSITIONER_ERROR_INVALID_INPUT, "size %dx%d", w, h);
		return;
	}
	positioner_of(resource)->w = w;
	positioner_of(resource)->h = h;
}

static void
pos_anchor_rect(struct wl_client *client, struct wl_resource *resource,
		int32_t x, int32_t y, int32_t w, int32_t h)
{
	struct positioner *p = positioner_of(resource);

	if (w < 0 || h < 0) {
		wl_resource_post_error(resource, XDG_POSITIONER_ERROR_INVALID_INPUT, "anchor rect");
		return;
	}
	p->ax = x;
	p->ay = y;
	p->aw = w;
	p->ah = h;
}

static void
pos_anchor(struct wl_client *client, struct wl_resource *resource, uint32_t anchor)
{
	positioner_of(resource)->anchor = anchor;
}

static void
pos_gravity(struct wl_client *client, struct wl_resource *resource, uint32_t gravity)
{
	positioner_of(resource)->gravity = gravity;
}

static void
pos_constraint(struct wl_client *client, struct wl_resource *resource, uint32_t adjustment)
{
}

static void
pos_offset(struct wl_client *client, struct wl_resource *resource, int32_t x, int32_t y)
{
	positioner_of(resource)->ox = x;
	positioner_of(resource)->oy = y;
}

static void
pos_reactive(struct wl_client *client, struct wl_resource *resource)
{
}

static void
pos_parent_size(struct wl_client *client, struct wl_resource *resource, int32_t w, int32_t h)
{
}

static void
pos_parent_configure(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
}

static const struct xdg_positioner_interface positioner_impl = {
	.destroy = resource_destroy,
	.set_size = pos_size,
	.set_anchor_rect = pos_anchor_rect,
	.set_anchor = pos_anchor,
	.set_gravity = pos_gravity,
	.set_constraint_adjustment = pos_constraint,
	.set_offset = pos_offset,
	.set_reactive = pos_reactive,
	.set_parent_size = pos_parent_size,
	.set_parent_configure = pos_parent_configure,
};

/** where a popup goes, relative to its parent's geometry: no constraints yet */
static void
place_popup(struct way_xdg *xdg)
{
	const struct positioner *p = &xdg->pos;
	int ax, ay, x, y;

	switch (p->anchor) {
	case XDG_POSITIONER_ANCHOR_LEFT: case XDG_POSITIONER_ANCHOR_TOP_LEFT:
	case XDG_POSITIONER_ANCHOR_BOTTOM_LEFT: ax = p->ax; break;
	case XDG_POSITIONER_ANCHOR_RIGHT: case XDG_POSITIONER_ANCHOR_TOP_RIGHT:
	case XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT: ax = p->ax + p->aw; break;
	default: ax = p->ax + p->aw / 2;
	}
	switch (p->anchor) {
	case XDG_POSITIONER_ANCHOR_TOP: case XDG_POSITIONER_ANCHOR_TOP_LEFT:
	case XDG_POSITIONER_ANCHOR_TOP_RIGHT: ay = p->ay; break;
	case XDG_POSITIONER_ANCHOR_BOTTOM: case XDG_POSITIONER_ANCHOR_BOTTOM_LEFT:
	case XDG_POSITIONER_ANCHOR_BOTTOM_RIGHT: ay = p->ay + p->ah; break;
	default: ay = p->ay + p->ah / 2;
	}
	switch (p->gravity) {
	case XDG_POSITIONER_GRAVITY_LEFT: case XDG_POSITIONER_GRAVITY_TOP_LEFT:
	case XDG_POSITIONER_GRAVITY_BOTTOM_LEFT: x = ax - p->w; break;
	case XDG_POSITIONER_GRAVITY_RIGHT: case XDG_POSITIONER_GRAVITY_TOP_RIGHT:
	case XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT: x = ax; break;
	default: x = ax - p->w / 2;
	}
	switch (p->gravity) {
	case XDG_POSITIONER_GRAVITY_TOP: case XDG_POSITIONER_GRAVITY_TOP_LEFT:
	case XDG_POSITIONER_GRAVITY_TOP_RIGHT: y = ay - p->h; break;
	case XDG_POSITIONER_GRAVITY_BOTTOM: case XDG_POSITIONER_GRAVITY_BOTTOM_LEFT:
	case XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT: y = ay; break;
	default: y = ay - p->h / 2;
	}
	xdg->win.x = x + p->ox;
	xdg->win.y = y + p->oy;
}

/** the window ends: unmapped, told, out of the list; xdg stays until its resource goes */
static void
xdg_end(struct way_xdg *xdg)
{
	struct way *way = xdg->way;
	struct way_xdg *other;

	if (!xdg->in_list)
		return;
	if (way->pointer_focus == xdg)
		way_pointer(way, NULL, 0, 0);
	if (way->key_focus == xdg)
		way_focus(way, NULL);
	// its popups are dismissed, and its dialogs lose their parent
	wl_list_for_each(other, &way->windows, link) {
		if (other->parent == xdg) {
			other->parent = NULL;
			other->win.parent = NULL;
			if (other->win.popup && other->role_resource)
				xdg_popup_send_popup_done(other->role_resource);
		} else if (other->win.parent == &xdg->win) {
			other->win.parent = NULL;
		}
	}
	if (xdg->win.mapped) {
		xdg->win.mapped = false;
		emit(way, xdg, WAY_UNMAP);
	}
	emit(way, xdg, WAY_DESTROY);
	wl_list_remove(&xdg->link);
	xdg->in_list = false;
	free(xdg->win.pixels);
	xdg->win.pixels = NULL;
	if (xdg->win.title != empty)
		free((char *)xdg->win.title);
	if (xdg->win.app_id != empty)
		free((char *)xdg->win.app_id);
	xdg->win.title = xdg->win.app_id = empty;
}

static void
role_gone(struct wl_resource *resource)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);

	if (!xdg)
		return;
	xdg_end(xdg);
	xdg->role_resource = NULL;
}

static struct way_xdg *
role_xdg(struct wl_resource *resource)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);

	return xdg && xdg->in_list ? xdg : NULL;
}

static void
top_parent(struct wl_client *client, struct wl_resource *resource, struct wl_resource *parent)
{
	struct way_xdg *xdg = role_xdg(resource);
	struct way_xdg *p = parent ? role_xdg(parent) : NULL;

	if (xdg)
		xdg->win.parent = p ? &p->win : NULL;
}

static void
set_text(const char **at, const char *text)
{
	char *t = strdup(text ? text : "");

	if (!t)
		return;
	if (*at != empty)
		free((char *)*at);
	*at = t;
}

static void
top_title(struct wl_client *client, struct wl_resource *resource, const char *title)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (!xdg)
		return;
	set_text(&xdg->win.title, title);
	emit(xdg->way, xdg, WAY_TITLE);
}

static void
top_app_id(struct wl_client *client, struct wl_resource *resource, const char *app_id)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (!xdg)
		return;
	set_text(&xdg->win.app_id, app_id);
	emit(xdg->way, xdg, WAY_TITLE);
}

static void
top_menu(struct wl_client *client, struct wl_resource *resource, struct wl_resource *seat,
	 uint32_t serial, int32_t x, int32_t y)
{
}

static void
top_move(struct wl_client *client, struct wl_resource *resource, struct wl_resource *seat, uint32_t serial)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (xdg)
		emit(xdg->way, xdg, WAY_MOVE);
}

static void
top_resize(struct wl_client *client, struct wl_resource *resource, struct wl_resource *seat,
	   uint32_t serial, uint32_t edges)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (xdg) {
		xdg->win.edges = edges;
		emit(xdg->way, xdg, WAY_RESIZE);
	}
}

static void
top_max_size(struct wl_client *client, struct wl_resource *resource, int32_t w, int32_t h)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (xdg) {
		xdg->win.max_w = w;
		xdg->win.max_h = h;
	}
}

static void
top_min_size(struct wl_client *client, struct wl_resource *resource, int32_t w, int32_t h)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (xdg) {
		xdg->win.min_w = w;
		xdg->win.min_h = h;
	}
}

static void
top_state(struct wl_client *client, struct wl_resource *resource)
{
	// maximized and minimized are the window manager's to grant; it is not asked yet
}

static void
top_fullscreen(struct wl_client *client, struct wl_resource *resource, struct wl_resource *output)
{
}

static const struct xdg_toplevel_interface toplevel_impl = {
	.destroy = resource_destroy,
	.set_parent = top_parent,
	.set_title = top_title,
	.set_app_id = top_app_id,
	.show_window_menu = top_menu,
	.move = top_move,
	.resize = top_resize,
	.set_max_size = top_max_size,
	.set_min_size = top_min_size,
	.set_maximized = top_state,
	.unset_maximized = top_state,
	.set_fullscreen = top_fullscreen,
	.unset_fullscreen = top_state,
	.set_minimized = top_state,
};

static void
popup_grab(struct wl_client *client, struct wl_resource *resource, struct wl_resource *seat, uint32_t serial)
{
}

static void
popup_reposition(struct wl_client *client, struct wl_resource *resource,
		 struct wl_resource *positioner, uint32_t token)
{
	struct way_xdg *xdg = role_xdg(resource);

	if (!xdg)
		return;
	xdg->pos = *positioner_of(positioner);
	place_popup(xdg);
	xdg_popup_send_repositioned(resource, token);
	send_configure(xdg);
}

static const struct xdg_popup_interface popup_impl = {
	.destroy = resource_destroy,
	.grab = popup_grab,
	.reposition = popup_reposition,
};

static bool
start_window(struct way_xdg *xdg, struct wl_resource *resource, uint32_t id,
	     const struct wl_interface *iface, const void *impl)
{
	struct wl_client *client = wl_resource_get_client(resource);

	if (xdg->role_resource || xdg->in_list) {
		wl_resource_post_error(resource, XDG_SURFACE_ERROR_ALREADY_CONSTRUCTED, "a role already");
		return false;
	}
	if (!xdg->surface) {
		wl_resource_post_error(resource, XDG_SURFACE_ERROR_DEFUNCT_ROLE_OBJECT, "no surface");
		return false;
	}
	xdg->role_resource = wl_resource_create(client, iface, wl_resource_get_version(resource), id);
	if (!xdg->role_resource) {
		wl_client_post_no_memory(client);
		return false;
	}
	wl_resource_set_implementation(xdg->role_resource, impl, xdg, role_gone);
	memset(&xdg->win, 0, sizeof xdg->win);
	xdg->win.id = xdg->way->next_id++;
	xdg->win.title = xdg->win.app_id = empty;
	xdg->win.scale = 1;
	wl_list_insert(xdg->way->windows.prev, &xdg->link);
	xdg->in_list = true;
	return true;
}

static void
xdg_get_toplevel(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);

	if (!start_window(xdg, resource, id, &xdg_toplevel_interface, &toplevel_impl))
		return;
	if (wl_resource_get_version(xdg->role_resource) >= XDG_TOPLEVEL_WM_CAPABILITIES_SINCE_VERSION) {
		struct wl_array caps;
		wl_array_init(&caps);
		xdg_toplevel_send_wm_capabilities(xdg->role_resource, &caps);
		wl_array_release(&caps);
	}
}

static void
xdg_get_popup(struct wl_client *client, struct wl_resource *resource, uint32_t id,
	      struct wl_resource *parent, struct wl_resource *positioner)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);
	struct way_xdg *p = parent ? wl_resource_get_user_data(parent) : NULL;

	if (!start_window(xdg, resource, id, &xdg_popup_interface, &popup_impl))
		return;
	xdg->win.popup = true;
	xdg->pos = *positioner_of(positioner);
	if (p && p->in_list) {
		xdg->parent = p;
		xdg->win.parent = &p->win;
	}
	place_popup(xdg);
}

static void
xdg_geometry(struct wl_client *client, struct wl_resource *resource,
	     int32_t x, int32_t y, int32_t w, int32_t h)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);

	if (w <= 0 || h <= 0) {
		wl_resource_post_error(resource, XDG_SURFACE_ERROR_INVALID_SIZE, "geometry %dx%d", w, h);
		return;
	}
	xdg->pgeom = true;
	xdg->pgx = x;
	xdg->pgy = y;
	xdg->pgw = w;
	xdg->pgh = h;
}

static void
xdg_ack(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);

	if (!xdg->configure_sent) {
		wl_resource_post_error(resource, XDG_SURFACE_ERROR_INVALID_SERIAL, "nothing to ack");
		return;
	}
	xdg->acked = true;
}

static const struct xdg_surface_interface xdg_surface_impl = {
	.destroy = resource_destroy,
	.get_toplevel = xdg_get_toplevel,
	.get_popup = xdg_get_popup,
	.set_window_geometry = xdg_geometry,
	.ack_configure = xdg_ack,
};

static void
xdg_surface_gone(struct wl_resource *resource)
{
	struct way_xdg *xdg = wl_resource_get_user_data(resource);

	xdg_end(xdg);
	if (xdg->role_resource)
		wl_resource_set_user_data(xdg->role_resource, NULL);
	if (xdg->surface) {
		xdg->surface->xdg = NULL;
		xdg->surface->role = ROLE_NONE;
	}
	free(xdg);
}

static void
wm_create_positioner(struct wl_client *client, struct wl_resource *resource, uint32_t id)
{
	struct positioner *p = calloc(1, sizeof *p);
	struct wl_resource *r = p ? wl_resource_create(client, &xdg_positioner_interface,
						       wl_resource_get_version(resource), id) : NULL;
	if (!r) {
		free(p);
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &positioner_impl, p, positioner_gone);
}

static void
wm_get_xdg_surface(struct wl_client *client, struct wl_resource *resource, uint32_t id,
		   struct wl_resource *surface)
{
	struct way *way = wl_resource_get_user_data(resource);
	struct way_surface *s = wl_resource_get_user_data(surface);
	struct way_xdg *xdg;

	if (s->role != ROLE_NONE || s->has_buffer) {
		wl_resource_post_error(resource, XDG_WM_BASE_ERROR_ROLE, "the surface has a role or a buffer");
		return;
	}
	xdg = calloc(1, sizeof *xdg);
	if (!xdg) {
		wl_client_post_no_memory(client);
		return;
	}
	xdg->resource = wl_resource_create(client, &xdg_surface_interface,
					   wl_resource_get_version(resource), id);
	if (!xdg->resource) {
		free(xdg);
		wl_client_post_no_memory(client);
		return;
	}
	xdg->way = way;
	xdg->surface = s;
	wl_list_init(&xdg->link);
	s->role = ROLE_XDG;
	s->xdg = xdg;
	wl_resource_set_implementation(xdg->resource, &xdg_surface_impl, xdg, xdg_surface_gone);
}

static void
wm_pong(struct wl_client *client, struct wl_resource *resource, uint32_t serial)
{
}

static const struct xdg_wm_base_interface wm_impl = {
	.destroy = resource_destroy,
	.create_positioner = wm_create_positioner,
	.get_xdg_surface = wm_get_xdg_surface,
	.pong = wm_pong,
};

static void
bind_wm(struct wl_client *client, void *data, uint32_t version, uint32_t id)
{
	struct wl_resource *r = wl_resource_create(client, &xdg_wm_base_interface, version, id);

	if (!r) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(r, &wm_impl, data, NULL);
}

void
way_configure(struct way *way, struct way_window *window, int w, int h, bool activated)
{
	struct way_xdg *xdg = window_xdg(window);

	if (!xdg || !xdg->in_list || xdg->win.popup)
		return;
	xdg->cw = w;
	xdg->ch = h;
	xdg->activated = activated;
	if (xdg->configure_sent && xdg->role_resource)
		send_configure(xdg);
}

void
way_close(struct way *way, struct way_window *window)
{
	struct way_xdg *xdg = window_xdg(window);

	if (!xdg || !xdg->in_list || !xdg->role_resource)
		return;
	if (xdg->win.popup)
		xdg_popup_send_popup_done(xdg->role_resource);
	else
		xdg_toplevel_send_close(xdg->role_resource);
}

void
way_frame(struct way *way, uint32_t ms)
{
	struct way_surface *s;
	struct wl_resource *cb, *tmp;

	wl_list_for_each(s, &way->surfaces, link) {
		wl_resource_for_each_safe(cb, tmp, &s->frames) {
			wl_callback_send_done(cb, ms);
			wl_resource_destroy(cb);
		}
	}
}

// --- the server

static int
keymap_file(struct way *way)
{
	const char *dir = getenv("XDG_RUNTIME_DIR");
	char path[1024];
	int fd;

	if (!dir)
		dir = getenv("TMPDIR");
	if (!dir)
		dir = "/tmp";
	snprintf(path, sizeof path, "%s/way-keymap-XXXXXX", dir);
	fd = mkstemp(path);
	if (fd < 0)
		return -1;
	unlink(path);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
	way->keymap_size = way_keymap_size; // the text and its NUL
	for (size_t at = 0; at < way->keymap_size;) {
		ssize_t n = write(fd, way_keymap + at, way->keymap_size - at);
		if (n < 0 && errno == EINTR)
			continue;
		if (n <= 0) {
			close(fd);
			return -1;
		}
		at += (size_t)n;
	}
	return fd;
}

struct way *
way_create(const char *socket, const struct way_hooks *hooks)
{
	struct way *way = calloc(1, sizeof *way);

	if (!way)
		return NULL;
	if (hooks)
		way->hooks = *hooks;
	wl_list_init(&way->surfaces);
	wl_list_init(&way->windows);
	wl_list_init(&way->pointers);
	wl_list_init(&way->keyboards);
	wl_list_init(&way->outputs);
	way->next_id = 1;
	way->out_w = 1280;
	way->out_h = 800;
	way->out_scale = 1;
	way->keymap_fd = keymap_file(way);
	way->display = wl_display_create();
	if (way->keymap_fd < 0 || !way->display)
		goto fail;
	way->loop = wl_display_get_event_loop(way->display);
	if (socket) {
		if (wl_display_add_socket(way->display, socket) < 0)
			goto fail;
		snprintf(way->socket_name, sizeof way->socket_name, "%s", socket);
		way->socket = way->socket_name;
	} else {
		way->socket = wl_display_add_socket_auto(way->display);
		if (!way->socket)
			goto fail;
	}
	if (wl_display_init_shm(way->display) < 0)
		goto fail;
	if (!wl_global_create(way->display, &wl_compositor_interface, 6, way, bind_compositor) ||
	    !wl_global_create(way->display, &wl_subcompositor_interface, 1, way, bind_subcompositor) ||
	    !wl_global_create(way->display, &wl_output_interface, 4, way, bind_output) ||
	    !wl_global_create(way->display, &wl_seat_interface, 7, way, bind_seat) ||
	    !wl_global_create(way->display, &wl_data_device_manager_interface, 3, way, bind_ddm) ||
	    !wl_global_create(way->display, &xdg_wm_base_interface, 5, way, bind_wm))
		goto fail;
	return way;
fail:
	way_destroy(way);
	return NULL;
}

void
way_destroy(struct way *way)
{
	if (!way)
		return;
	if (way->display) {
		wl_display_destroy_clients(way->display);
		wl_display_destroy(way->display);
	}
	if (way->keymap_fd >= 0)
		close(way->keymap_fd);
	free(way);
}

const char *
way_socket(struct way *way)
{
	return way->socket;
}

int
way_fd(struct way *way)
{
	return wl_event_loop_get_fd(way->loop);
}

int
way_dispatch(struct way *way, int timeout_ms)
{
	int r = wl_event_loop_dispatch(way->loop, timeout_ms);

	wl_display_flush_clients(way->display);
	return r;
}

struct wl_display *
way_display(struct way *way)
{
	return way->display;
}

// --- Mac virtual key codes (Carbon's kVK_*) to evdev's KEY_*

uint32_t
way_evdev_from_mac(int code)
{
	static const uint16_t table[128] = {
		[0x00] = 30, [0x01] = 31, [0x02] = 32, [0x03] = 33, [0x04] = 35, [0x05] = 34, // a s d f h g
		[0x06] = 44, [0x07] = 45, [0x08] = 46, [0x09] = 47, [0x0A] = 86, [0x0B] = 48, // z x c v § b
		[0x0C] = 16, [0x0D] = 17, [0x0E] = 18, [0x0F] = 19, [0x10] = 21, [0x11] = 20, // q w e r y t
		[0x12] = 2, [0x13] = 3, [0x14] = 4, [0x15] = 5, [0x16] = 7, [0x17] = 6,       // 1 2 3 4 6 5
		[0x18] = 13, [0x19] = 10, [0x1A] = 8, [0x1B] = 12, [0x1C] = 9, [0x1D] = 11,   // = 9 7 - 8 0
		[0x1E] = 27, [0x1F] = 24, [0x20] = 22, [0x21] = 26, [0x22] = 23, [0x23] = 25, // ] o u [ i p
		[0x24] = 28, [0x25] = 38, [0x26] = 36, [0x27] = 40, [0x28] = 37, [0x29] = 39, // return l j ' k ;
		[0x2A] = 43, [0x2B] = 51, [0x2C] = 53, [0x2D] = 49, [0x2E] = 50, [0x2F] = 52, // \ , / n m .
		[0x30] = 15, [0x31] = 57, [0x32] = 41, [0x33] = 14, [0x35] = 1,               // tab space ` backspace esc
		[0x36] = 126, [0x37] = 125, [0x38] = 42, [0x39] = 58, [0x3A] = 56,            // rcmd cmd shift caps option
		[0x3B] = 29, [0x3C] = 54, [0x3D] = 100, [0x3E] = 97, [0x3F] = 464,            // ctrl rshift ropt rctrl fn
		[0x40] = 187, [0x41] = 83, [0x43] = 55, [0x45] = 78, [0x47] = 69,             // f17 kp. kp* kp+ clear
		[0x48] = 115, [0x49] = 114, [0x4A] = 113, [0x4B] = 98, [0x4C] = 96,           // vol+ vol- mute kp/ kpenter
		[0x4E] = 74, [0x4F] = 188, [0x50] = 189, [0x51] = 117,                        // kp- f18 f19 kp=
		[0x52] = 82, [0x53] = 79, [0x54] = 80, [0x55] = 81, [0x56] = 75, [0x57] = 76, // kp0..kp5
		[0x58] = 77, [0x59] = 71, [0x5A] = 190, [0x5B] = 72, [0x5C] = 73,             // kp6 kp7 f20 kp8 kp9
		[0x60] = 63, [0x61] = 64, [0x62] = 65, [0x63] = 61, [0x64] = 66, [0x65] = 67, // f5 f6 f7 f3 f8 f9
		[0x67] = 87, [0x69] = 183, [0x6A] = 186, [0x6B] = 184, [0x6D] = 68,           // f11 f13 f16 f14 f10
		[0x6F] = 88, [0x71] = 185, [0x72] = 138, [0x73] = 102, [0x74] = 104,          // f12 f15 help home pgup
		[0x75] = 111, [0x76] = 62, [0x77] = 107, [0x78] = 60, [0x79] = 109,           // del f4 end f2 pgdn
		[0x7A] = 59, [0x7B] = 105, [0x7C] = 106, [0x7D] = 108, [0x7E] = 103,          // f1 left right down up
	};

	return code >= 0 && code < 128 ? table[code] : 0;
}
