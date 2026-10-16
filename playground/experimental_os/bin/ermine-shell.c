// ermine-shell.c: the client bin/ermine-shell builds and runs. Connects to
// ermineOS's shell socket (drv_sock.c), the path its one argument. On a
// terminal: raw mode, restored on the way out, and the terminal's size sent
// as a terminal reports its own, CSI 8 ; rows ; cols t, at the start and with
// each SIGWINCH. Otherwise a pipe both ways: what comes in is sent, and its
// end is the socket's sending side shut, which the shell takes as ctrl-d.
// It ends when ermineOS closes the connection.

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <termios.h>
#include <unistd.h>

static struct termios was;
static int raw;
static volatile sig_atomic_t resized;

static void restore(void) {
	if (raw) tcsetattr(0, TCSAFLUSH, &was);
	raw = 0;
}

static void winch(int sig) {
	(void)sig;
	resized = 1;
}

static int all(int fd, const char *bytes, size_t n) {
	while (n) {
		ssize_t w = write(fd, bytes, n);
		if (w < 0 && errno == EINTR) continue;
		if (w <= 0) return -1;
		bytes += w, n -= (size_t)w;
	}
	return 0;
}

static void size(int fd) {
	struct winsize ws;
	if (ioctl(0, TIOCGWINSZ, &ws) < 0 || !ws.ws_row || !ws.ws_col) return;
	char say[32];
	int n = snprintf(say, sizeof say, "\x1b[8;%d;%dt", ws.ws_row, ws.ws_col);
	all(fd, say, (size_t)n);
}

int main(int argc, char **argv) {
	if (argc != 2) {
		fprintf(stderr, "usage: ermine-shell-client <socket>\n");
		return 2;
	}
	struct sockaddr_un addr = { .sun_family = AF_UNIX };
	if (strlen(argv[1]) >= sizeof addr.sun_path) {
		fprintf(stderr, "ermine-shell: %s: too long for a socket's path\n", argv[1]);
		return 1;
	}
	strcpy(addr.sun_path, argv[1]);
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0 || connect(fd, (struct sockaddr *)&addr, sizeof addr) < 0) {
		fprintf(stderr, "ermine-shell: %s: %s (is ermineOS running?)\n", argv[1], strerror(errno));
		return 1;
	}
	signal(SIGPIPE, SIG_IGN);
	if (isatty(0) && tcgetattr(0, &was) == 0) {
		struct termios t = was;
		cfmakeraw(&t);
		if (tcsetattr(0, TCSAFLUSH, &t) == 0) raw = 1;
		atexit(restore);
		struct sigaction sa = { .sa_handler = winch };
		sigaction(SIGWINCH, &sa, NULL);
		size(fd);
	}
	char buf[65536];
	int in = 1;
	for (;;) {
		if (resized) resized = 0, size(fd);
		struct pollfd fds[2] = { { fd, POLLIN, 0 }, { 0, in ? POLLIN : 0, 0 } };
		if (poll(fds, in ? 2 : 1, -1) < 0) {
			if (errno == EINTR) continue;
			break;
		}
		if (fds[0].revents) {
			ssize_t r = read(fd, buf, sizeof buf);
			if (r < 0 && errno == EINTR) continue;
			if (r <= 0 || all(1, buf, (size_t)r) < 0) break;
		}
		if (in && fds[1].revents) {
			ssize_t r = read(0, buf, sizeof buf);
			if (r < 0 && errno == EINTR) continue;
			if (r <= 0) {
				in = 0;
				shutdown(fd, SHUT_WR);
			} else if (all(fd, buf, (size_t)r) < 0) break;
		}
	}
	restore();
	return 0;
}
