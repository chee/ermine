// way_test.c: way.c, headless, with real clients built for macOS against the
// patched libwayland. 1: weston's simple-shm, unchanged: each frame's pixels
// must be exactly what its paint_pixels draws for the time the frame callback
// gave it; Esc on the keyboard ends it. 2: probe.c: title, subsurface
// blending, configure, pointer, keyboard (keymap, modifiers), a popup, close.
// Run: ../mac/build/wayland/bin/way_test (build.sh builds it).

#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "way.h"

static struct way *way;
static int failures;
static char out[1 << 16]; // the client's stdout, so far
static size_t outn;
static int outfd = -1;

#define MAXW 16
static struct {
	struct way_window *w;
	int maps, unmaps, destroys, titles;
} seen[MAXW];
static int nseen;

static void
check(int ok, const char *fmt, ...)
{
	va_list ap;

	va_start(ap, fmt);
	printf("%s ", ok ? "ok  " : "FAIL");
	vprintf(fmt, ap);
	printf("\n");
	va_end(ap);
	if (!ok)
		failures++;
}

static int
slot(struct way_window *w)
{
	for (int i = 0; i < nseen; i++)
		if (seen[i].w == w && !seen[i].destroys)
			return i;
	if (nseen == MAXW)
		abort();
	seen[nseen].w = w;
	return nseen++;
}

static void
on_event(void *data, struct way_window *w, enum way_event e)
{
	int i = slot(w);

	switch (e) {
	case WAY_MAP: seen[i].maps++; break;
	case WAY_UNMAP: seen[i].unmaps++; break;
	case WAY_DESTROY: seen[i].destroys++; break;
	case WAY_TITLE: seen[i].titles++; break;
	default: break;
	}
}

static void
pump(int ms)
{
	struct pollfd p[2] = { { way_fd(way), POLLIN, 0 }, { outfd, POLLIN, 0 } };

	poll(p, outfd >= 0 ? 2 : 1, ms);
	way_dispatch(way, 0);
	if (outfd >= 0) {
		ssize_t n;
		while ((n = read(outfd, out + outn, sizeof out - 1 - outn)) > 0)
			outn += (size_t)n;
		out[outn] = 0;
	}
}

static long
now_ms(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

// pumps until cond holds, 5 s at most: whether it does
#define WAIT(cond)                                                                 \
	({                                                                         \
		long until_ = now_ms() + 5000;                                     \
		while (!(cond) && now_ms() < until_)                               \
			pump(20);                                                  \
		int ok_ = !!(cond);                                                \
		if (!ok_)                                                          \
			printf("     (gave up waiting for %s)\n", #cond);          \
		ok_;                                                               \
	})

static int
has_line(const char *line)
{
	size_t n = strlen(line);

	for (const char *at = out; (at = strstr(at, line)); at++)
		if ((at == out || at[-1] == '\n') && at[n] == '\n')
			return 1;
	return 0;
}

static pid_t
spawn(const char *path)
{
	int fds[2];
	pid_t pid;

	if (pipe(fds) < 0)
		return -1;
	pid = fork();
	if (pid == 0) {
		dup2(fds[1], 1);
		close(fds[0]);
		close(fds[1]);
		setenv("WAYLAND_DISPLAY", way_socket(way), 1);
		execl(path, path, (char *)NULL);
		perror(path);
		_exit(127);
	}
	close(fds[1]);
	fcntl(fds[0], F_SETFL, O_NONBLOCK);
	outfd = fds[0];
	outn = 0;
	out[0] = 0;
	return pid;
}

static int
reap(pid_t pid)
{
	int status = -1;
	long until = now_ms() + 5000;

	while (now_ms() < until) {
		pump(20);
		if (waitpid(pid, &status, WNOHANG) == pid) {
			pump(0);
			close(outfd);
			outfd = -1;
			return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
		}
	}
	kill(pid, SIGKILL);
	waitpid(pid, &status, 0);
	close(outfd);
	outfd = -1;
	return -1;
}

static struct way_window *
mapped(int popup)
{
	for (int i = 0; i < nseen; i++)
		if (seen[i].maps && !seen[i].destroys && seen[i].w->mapped && seen[i].w->popup == popup)
			return seen[i].w;
	return NULL;
}

// --- 1: weston's simple-shm

// weston's clients/simple-shm.c paint_pixels (MIT, Kristian Høgsberg, Intel):
// what it draws for time, padding 20, every pixel opaque here (an XRGB buffer)
static void
paint_pixels(uint32_t *image, int padding, int width, int height, uint32_t time)
{
	const int halfh = padding + (height - padding * 2) / 2;
	const int halfw = padding + (width - padding * 2) / 2;
	int ir, or;
	uint32_t *pixel = image;

	or = (halfw < halfh ? halfw : halfh) - 8;
	ir = or - 32;
	or *= or;
	ir *= ir;
	pixel += padding * width;
	for (int y = padding; y < height - padding; y++) {
		int y2 = (y - halfh) * (y - halfh);
		pixel += padding;
		for (int x = padding; x < width - padding; x++) {
			uint32_t v;
			int r2 = (x - halfw) * (x - halfw) + y2;
			if (r2 < ir)
				v = (r2 / 32 + time / 64) * 0x0080401;
			else if (r2 < or)
				v = (y + time / 32) * 0x0080401;
			else
				v = (x + time / 16) * 0x0080401;
			*pixel++ = (v & 0x00ffffff) | 0xff000000;
		}
		pixel += padding;
	}
}

static int
same_as_simple_shm(struct way_window *w, uint32_t time)
{
	static uint32_t want[250 * 250];
	int bad = 0, first = -1;

	if (w->w != 250 || w->h != 250)
		return 0;
	for (int i = 0; i < 250 * 250; i++)
		want[i] = 0xffffffff; // the padding, as simple-shm memsets it
	paint_pixels(want, 20, 250, 250, time);
	for (int i = 0; i < 250 * 250; i++)
		if (w->pixels[i] != want[i] && bad++ == 0)
			first = i;
	if (bad)
		printf("     %d pixels differ, the first at %d,%d: %08x, not %08x\n", bad, first % 250,
		       first / 250, w->pixels[first], want[first]);
	return bad == 0;
}

static void
test_simple_shm(const char *bin)
{
	char path[1024];
	pid_t pid;
	struct way_window *w;
	uint32_t commits, times[] = { 16, 1000, 123456 };
	int i;

	snprintf(path, sizeof path, "%s/weston-simple-shm", bin);
	pid = spawn(path);
	check(WAIT((w = mapped(0)) != NULL), "simple-shm maps a toplevel");
	if (!w) {
		kill(pid, SIGKILL);
		reap(pid);
		return;
	}
	i = slot(w);
	check(w->w == 250 && w->h == 250, "its image is 250 x 250 (%d x %d)", w->w, w->h);
	check(same_as_simple_shm(w, 0), "its first frame is paint_pixels at time 0, exactly");
	for (int i = 0; i < 3; i++) {
		commits = w->commits;
		way_frame(way, times[i]);
		check(WAIT(w->commits > commits), "frame done at %u: it draws again", times[i]);
		check(same_as_simple_shm(w, times[i]), "the frame is paint_pixels at time %u, exactly", times[i]);
	}
	way_focus(way, w);
	way_key(way, way_evdev_from_mac(0x35), true); // the Mac's Esc
	way_key(way, way_evdev_from_mac(0x35), false);
	check(reap(pid) == 0, "Esc ends it, exit status 0");
	check(seen[i].destroys == 1 && seen[i].unmaps == 1, "its window unmapped and gone");
}

// --- 2: the probe

static uint32_t
over(uint32_t src, uint32_t dst)
{
	uint32_t a = src >> 24, out = 0;

	for (int sh = 0; sh < 32; sh += 8) {
		uint32_t c = ((src >> sh) & 0xff) + (((dst >> sh) & 0xff) * (255 - a) + 127) / 255;
		out |= (c > 255 ? 255 : c) << sh;
	}
	return out;
}

static void
test_probe(const char *bin)
{
	char path[1024];
	pid_t pid;
	struct way_window *w, *p;
	int i;

	snprintf(path, sizeof path, "%s/way_probe", bin);
	pid = spawn(path);
	check(WAIT((w = mapped(0)) != NULL), "the probe maps a toplevel");
	if (!w) {
		kill(pid, SIGKILL);
		reap(pid);
		return;
	}
	i = slot(w);
	check(!strcmp(w->title, "probe") && !strcmp(w->app_id, "ermine.probe") && seen[i].titles == 2,
	      "title \"%s\", app_id \"%s\"", w->title, w->app_id);
	check(w->w == 100 && w->h == 80 && w->opaque, "100 x 80, opaque (%d x %d)", w->w, w->h);
	check(w->gw == 100 && w->gh == 80, "its geometry is its buffer (%d x %d)", w->gw, w->gh);
	check(w->pixels[0] == 0xff336699 && w->pixels[30 * 100 + 30] == 0xff336699, "the toplevel's own pixels");
	check(w->pixels[15 * 100 + 15] == over(0x80800000, 0xff336699) && w->pixels[29 * 100 + 29] == over(0x80800000, 0xff336699) &&
		      w->pixels[9 * 100 + 9] == 0xff336699,
	      "the subsurface blended over it at 10,10 (%08x)", w->pixels[15 * 100 + 15]);
	check(WAIT(has_line("keymap 1 xkb 1")), "the keymap: xkb_v1 text, NUL ended, mappable");
	check(WAIT(has_line("repeat 25 600")), "repeat info");
	check(WAIT(has_line("output mode 1280 800")), "the output's mode");
	check(WAIT(has_line("surface enter output")), "the surface entered the output");
	check(WAIT(has_line("wm_capabilities") && has_line("configure 0 0 0")), "first configure: the client chooses");

	way_configure(way, w, 300, 200, true);
	check(WAIT(has_line("configure 300 200 1")), "configure 300 x 200, activated");

	way_pointer(way, w, 5.5, 6.25);
	check(WAIT(has_line("pointer enter toplevel 5.50 6.25")), "pointer enter at 5.5, 6.25");
	way_pointer(way, w, 7, 8);
	check(WAIT(has_line("motion 7.00 8.00")), "pointer motion");
	way_axis(way, 0, 10);
	check(WAIT(has_line("axis 0 10.00")), "scroll");
	way_button(way, 0x110, true);
	check(WAIT(has_line("button 272 1")), "BTN_LEFT pressed");
	way_button(way, 0x110, false);
	check(WAIT((p = mapped(1)) != NULL), "the press opens a popup");
	if (p) {
		check(p->parent == w && p->x == 7 && p->y == 8 && p->w == 30 && p->h == 20 &&
			      p->pixels[0] == 0xff0000ff,
		      "the popup: at 7,8 of its parent, 30 x 20, blue");
		check(WAIT(has_line("popup 7 8 30 20")), "the popup's configure");
	}

	way_focus(way, w);
	check(WAIT(has_line("keyboard enter toplevel")) && WAIT(has_line("modifiers 0 0")), "keyboard enter");
	way_key(way, way_evdev_from_mac(0x38), true); // shift
	check(WAIT(has_line("key 42 1")) && WAIT(has_line("modifiers 1 0")), "Shift: key 42, Shift depressed");
	way_key(way, way_evdev_from_mac(0x00), true); // a
	check(WAIT(has_line("key 30 1")), "the Mac's a is evdev 30");
	way_key(way, way_evdev_from_mac(0x39), true); // caps lock
	check(WAIT(has_line("modifiers 1 2")), "Caps Lock locks");
	check(way_evdev_from_mac(0x7E) == 103 && way_evdev_from_mac(0x24) == 28 && way_evdev_from_mac(0x37) == 125,
	      "up, return, cmd: 103, 28, 125");

	if (p) {
		way_close(way, p);
		check(WAIT(has_line("popup_done")), "the popup dismissed");
	}
	way_close(way, w);
	check(WAIT(has_line("close")), "the toplevel asked to close");
	check(reap(pid) == 0, "the probe exits, status 0");
	check(seen[i].destroys == 1 && mapped(0) == NULL && mapped(1) == NULL, "its windows are gone");
}

// --- 3: a client killed with its windows up, focus on them: nothing dangles

static void
test_killed(const char *bin)
{
	char path[1024];
	pid_t pid;
	struct way_window *w, *p;

	snprintf(path, sizeof path, "%s/way_probe", bin);
	pid = spawn(path);
	check(WAIT((w = mapped(0)) != NULL), "a probe again");
	if (!w)
		return;
	way_pointer(way, w, 3, 4);
	way_button(way, 0x110, true);
	check(WAIT((p = mapped(1)) != NULL), "with its popup");
	if (p)
		way_pointer(way, p, 1, 1);
	way_focus(way, w);
	kill(pid, SIGKILL);
	check(reap(pid) == 128 + SIGKILL, "killed");
	check(WAIT(mapped(0) == NULL && mapped(1) == NULL), "its windows went with it");
	// input with nothing focused, and a new client: the compositor goes on
	way_key(way, 30, true);
	way_button(way, 0x110, true);
	snprintf(path, sizeof path, "%s/weston-simple-shm", bin);
	pid = spawn(path);
	check(WAIT((w = mapped(0)) != NULL), "simple-shm maps after it");
	kill(pid, SIGINT);
	way_frame(way, 1); // its loop wakes and sees SIGINT
	check(reap(pid) == 0, "and ends on SIGINT");
}

int
main(int argc, char **argv)
{
	char dir[] = "/tmp/way-test-XXXXXX";
	char bin[1024];
	struct way_hooks hooks = { on_event, NULL };
	const char *slash = strrchr(argv[0], '/');

	snprintf(bin, sizeof bin, "%.*s", slash ? (int)(slash - argv[0]) : 1, slash ? argv[0] : ".");
	signal(SIGPIPE, SIG_IGN);
	if (!mkdtemp(dir)) {
		perror("mkdtemp");
		return 1;
	}
	setenv("XDG_RUNTIME_DIR", dir, 1);
	way = way_create(NULL, &hooks);
	check(way != NULL, "a compositor on $XDG_RUNTIME_DIR/%s", way ? way_socket(way) : "?");
	if (!way)
		return 1;
	test_simple_shm(bin);
	test_probe(bin);
	test_killed(bin);
	way_destroy(way);
	rmdir(dir);
	printf("%s: %d failed\n", failures ? "FAIL" : "PASS", failures);
	return failures ? 1 : 0;
}
