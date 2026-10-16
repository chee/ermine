// way.h: a small Wayland compositor on libwayland-server, made to be embedded:
// it owns no window, no screen and no thread. The host (a test, or ermineOS's
// driver) polls way_fd, calls way_dispatch, reads each window's pixels, and
// hands input in. wl_shm is libwayland's own (wl_display_init_shm); the rest
// is here: wl_compositor, wl_region, wl_subcompositor, wl_output, wl_seat
// (pointer, keyboard), wl_data_device_manager (stubs) and xdg_shell
// (toplevels and popups).

#ifndef WAY_H
#define WAY_H

#include <stdbool.h>
#include <stdint.h>

struct way;

/** a toplevel or a popup: what the host shows */
struct way_window {
	uint32_t id;              // from 1, never reused
	const char *title, *app_id; // "" until set
	struct way_window *parent; // a popup's (or a dialog's) parent, else NULL
	bool popup;
	int x, y;                 // a popup: its place, relative to parent's geometry
	bool mapped;
	// the image: the root surface's buffer with its subsurfaces over it,
	// premultiplied 0xAARRGGBB (wl_shm's ARGB8888), rows of w pixels
	int w, h, scale;          // buffer pixels; scale the client's buffer scale
	uint32_t *pixels;
	bool opaque;              // every pixel's alpha is 0xff (an XRGB buffer)
	int gx, gy, gw, gh;       // the window geometry (xdg_surface), in surface units
	int dx, dy, dw, dh;       // the last commit's damage, buffer pixels (whole image for now)
	uint32_t commits;         // commits that changed the image
	int min_w, min_h, max_w, max_h; // the client's size hints, 0 none
	uint32_t edges;           // WAY_RESIZE: xdg_toplevel's resize_edge
	void *user;               // the host's
};

enum way_event {
	WAY_MAP,      // the window has its first image
	WAY_COMMIT,   // its image changed
	WAY_TITLE,    // title or app_id
	WAY_UNMAP,    // it has no image now
	WAY_DESTROY,  // it is going; the pointer is no good after this
	WAY_MOVE,     // the client asks for an interactive move (a press on its title bar)
	WAY_RESIZE,   // the client asks for an interactive resize
	WAY_ACTIVATE, // the client asks to be shown (set_minimized undone, etc.)
};

struct way_hooks {
	void (*event)(void *data, struct way_window *window, enum way_event event);
	void *data;
};

/** listens on $XDG_RUNTIME_DIR/<socket> (socket NULL: the first free wayland-N) */
struct way *way_create(const char *socket, const struct way_hooks *hooks);
void way_destroy(struct way *way);
/** the socket's name, for WAYLAND_DISPLAY */
const char *way_socket(struct way *way);
/** an fd that is readable when way_dispatch has work */
int way_fd(struct way *way);
/** runs what is ready, waiting at most timeout_ms (-1 forever), then flushes the clients; -1 on error */
int way_dispatch(struct way *way, int timeout_ms);
/** the whole server, for what way.h does not cover */
struct wl_display *way_display(struct way *way);

/** the output's size in pixels, and its scale */
void way_output(struct way *way, int w, int h, int scale);
/** a toplevel's configure: the size the host gives it (0 0: the client chooses) and whether it is in front */
void way_configure(struct way *way, struct way_window *window, int w, int h, bool activated);
/** frame callbacks done, for every surface that asked: ms a clock in milliseconds */
void way_frame(struct way *way, uint32_t ms);
/** asks the window to close (a toplevel's close, a popup's popup_done) */
void way_close(struct way *way, struct way_window *window);

/** the pointer is over window at x, y (surface pixels from its top left); NULL: over none */
void way_pointer(struct way *way, struct way_window *window, double x, double y);
/** a button (evdev: BTN_LEFT 0x110, BTN_RIGHT 0x111, BTN_MIDDLE 0x112) to the window under the pointer */
void way_button(struct way *way, uint32_t button, bool down);
/** scrolling, in surface pixels */
void way_axis(struct way *way, double dx, double dy);
/** the keyboard goes to window (NULL: to none) */
void way_focus(struct way *way, struct way_window *window);
/** a key (an evdev code) to the window with the keyboard */
void way_key(struct way *way, uint32_t key, bool down);

/** the evdev code of a Mac virtual key code, 0 for none */
uint32_t way_evdev_from_mac(int code);

#endif
