// a post for http.h over plain sockets: HTTP/1.1, Content-Length both ways, the connection kept between
// posts. https:// through libcurl when built with LS_HTTP_CURL (macOS ships it: -DLS_HTTP_CURL -lcurl;
// Linux: libcurl's dev package), its handle kept so its connection is too; without, https fails (-1).
// For a Mac or a test, not a device (esp_http_client there)
#define _DARWIN_C_SOURCE
#define _DEFAULT_SOURCE
#include "http.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <unistd.h>
#ifdef LS_HTTP_CURL
#include <curl/curl.h>
#endif

// dialling, and sending, give up after this long; an answer after the wait and this
#define DIAL_MS 5000
#define SLACK_MS 10000

typedef struct {
	int fd;
	char host[256], port[8];
	// bytes read past a header, kept for the body
	char head[2048];
	size_t had;
#ifdef LS_HTTP_CURL
	CURL *curl; // https: made on the first, kept
	struct curl_slist *headers;
#endif
} conn;

void *ls_http_socket_open(void) {
	conn *c = calloc(1, sizeof *c);
	if (c != NULL) c->fd = -1;
#ifdef LS_HTTP_CURL
	static int curl_up;
	if (c != NULL && !curl_up) curl_up = curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK;
#endif
	return c;
}

static void hang_up(conn *c) {
	if (c->fd >= 0) close(c->fd);
	c->fd = -1;
}

void ls_http_socket_close(void *context) {
	if (context == NULL) return;
	hang_up(context);
#ifdef LS_HTTP_CURL
	conn *c = context;
	if (c->curl) curl_easy_cleanup(c->curl);
	curl_slist_free_all(c->headers);
#endif
	free(context);
}

// "http://host[:port]/path?query": host, port and the path. 0: not one
static int split(const char *url, char *host, size_t host_room, char *port, const char **path) {
	if (strncmp(url, "http://", 7) != 0) return 0;
	const char *h = url + 7, *slash = strchr(h, '/');
	if (slash == NULL) return 0;
	const char *colon = memchr(h, ':', (size_t)(slash - h));
	const char *end = colon ? colon : slash;
	if (end == h || (size_t)(end - h) >= host_room) return 0;
	memcpy(host, h, (size_t)(end - h)), host[end - h] = 0;
	if (colon) {
		size_t n = (size_t)(slash - colon - 1);
		if (n == 0 || n > 5) return 0;
		memcpy(port, colon + 1, n), port[n] = 0;
	} else strcpy(port, "80");
	*path = slash;
	return 1;
}

static int dial(conn *c) {
	struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM}, *ai, *a;
	if (getaddrinfo(c->host, c->port, &hints, &ai) != 0) return 0;
	for (a = ai; a != NULL; a = a->ai_next) {
		int fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
		if (fd < 0) continue;
		fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
		int r = connect(fd, a->ai_addr, a->ai_addrlen);
		if (r != 0 && errno == EINPROGRESS) {
			struct pollfd p = {fd, POLLOUT, 0};
			int e = 0;
			socklen_t el = sizeof e;
			r = poll(&p, 1, DIAL_MS) == 1 && getsockopt(fd, SOL_SOCKET, SO_ERROR, &e, &el) == 0 && e == 0 ? 0 : -1;
		}
		if (r == 0) {
			fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK);
			int one = 1;
			setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
#ifdef SO_NOSIGPIPE
			setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
			c->fd = fd;
			break;
		}
		close(fd);
	}
	freeaddrinfo(ai);
	return c->fd >= 0;
}

static void timeout(int fd, int option, long ms) {
	struct timeval t = {ms / 1000, (int)(ms % 1000) * 1000};
	setsockopt(fd, SOL_SOCKET, option, &t, sizeof t);
}

// piece j of a request: its head (0), then the body's pieces
static size_t piece(const char *head, size_t n, const ls_piece *body, size_t j, const uint8_t **bytes) {
	*bytes = j ? body[j - 1].bytes : (const uint8_t *)head;
	return j ? body[j - 1].length : n;
}

// the head, then the body's pieces as they are: a sendmsg of up to 64 of them at a time
static int send_all(int fd, const char *head, size_t n, const ls_piece *body, size_t pieces) {
	size_t j = 0, at = 0, all = pieces + 1;
	const uint8_t *b;
	while (j < all) {
		struct iovec v[64];
		int c = 0;
		for (size_t k = j; k < all && c < 64; k++, c++) {
			size_t m = piece(head, n, body, k, &b), skip = k == j ? at : 0;
			v[c] = (struct iovec){(void *)(b + skip), m - skip};
		}
		struct msghdr h = {.msg_iov = v, .msg_iovlen = c};
#ifdef MSG_NOSIGNAL
		ssize_t w = sendmsg(fd, &h, MSG_NOSIGNAL);
#else
		ssize_t w = sendmsg(fd, &h, 0);
#endif
		if (w <= 0) {
			if (w < 0 && errno == EINTR) continue;
			return 0;
		}
		for (size_t done = (size_t)w; j < all;) {
			size_t left = piece(head, n, body, j, &b) - at;
			if (done < left) {
				at += done;
				break;
			}
			done -= left, j++, at = 0;
		}
	}
	return 1;
}

// one request on the connection: the answer's length, -1 failed, -2 the connection was found closed
// before anything came back (a kept one the server let go: dial again and retry)
static long exchange(conn *c, const char *path, uint32_t wait_ms, const ls_piece *body, size_t pieces, size_t length,
	uint8_t *answer, size_t room) {
	char req[1024];
	int n = snprintf(req, sizeof req,
		"POST %s HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/octet-stream\r\nContent-Length: %zu\r\n\r\n", path,
		c->host, c->port, length);
	if (n < 0 || (size_t)n >= sizeof req) return -1;
	timeout(c->fd, SO_SNDTIMEO, SLACK_MS);
	timeout(c->fd, SO_RCVTIMEO, (long)wait_ms + SLACK_MS);
	if (!send_all(c->fd, req, (size_t)n, body, pieces)) return -2;
	// the head: up to the blank line
	size_t had = 0;
	char *end = NULL;
	while (end == NULL) {
		if (had == sizeof c->head - 1) return -1;
		ssize_t r = recv(c->fd, c->head + had, sizeof c->head - 1 - had, 0);
		if (r < 0 && errno == EINTR) continue;
		if (r <= 0) return had == 0 && (r == 0 || errno == ECONNRESET) ? -2 : -1;
		had += (size_t)r, c->head[had] = 0;
		end = strstr(c->head, "\r\n\r\n");
	}
	int status = 0;
	if (sscanf(c->head, "HTTP/1.%*d %d", &status) != 1) return -1;
	long size = -1;
	int closing = 0;
	for (char *line = strstr(c->head, "\r\n"); line != NULL && line < end; line = strstr(line + 2, "\r\n")) {
		const char *l = line + 2;
		if (strncasecmp(l, "content-length:", 15) == 0) size = strtol(l + 15, NULL, 10);
		else if (strncasecmp(l, "transfer-encoding:", 18) == 0) return -1; // chunked: the gateway never does it
		else if (strncasecmp(l, "connection:", 11) == 0) {
			for (l += 11; *l == ' '; l++) {}
			closing = strncasecmp(l, "close", 5) == 0;
		}
	}
	if (size < 0) return -1;
	// the body: what came after the head, then the rest. Too big for room: read off and refused
	size_t got = had - (size_t)(end + 4 - c->head), want = (size_t)size;
	if (got > want) return -1;
	int fits = want <= room;
	if (fits) memcpy(answer, end + 4, got);
	while (got < want) {
		char sink[1024];
		size_t ask = want - got;
		uint8_t *to = fits ? answer + got : (uint8_t *)sink;
		if (!fits && ask > sizeof sink) ask = sizeof sink;
		ssize_t r = recv(c->fd, to, ask, 0);
		if (r < 0 && errno == EINTR) continue;
		if (r <= 0) return -1;
		got += (size_t)r;
	}
	if (closing) hang_up(c);
	return status == 200 && fits ? (long)want : -1;
}

#ifdef LS_HTTP_CURL
// https: the answer into answer[0..room), more than room refused
typedef struct {
	uint8_t *to;
	size_t room, got;
} sink;

static size_t take(char *data, size_t size, size_t n, void *context) {
	sink *k = context;
	size_t m = size * n;
	if (m > k->room - k->got) return 0; // too big: curl stops (CURLE_WRITE_ERROR)
	memcpy(k->to + k->got, data, m), k->got += m;
	return m;
}

// the body's pieces as curl asks for them (k the piece, at its bytes given), and from the start again
typedef struct {
	const ls_piece *body;
	size_t pieces, k, at;
} source;

static size_t give(char *to, size_t size, size_t n, void *context) {
	source *s = context;
	size_t room = size * n, put = 0;
	while (put < room && s->k < s->pieces) {
		size_t m = s->body[s->k].length - s->at;
		if (m > room - put) m = room - put;
		memcpy(to + put, s->body[s->k].bytes + s->at, m);
		put += m, s->at += m;
		if (s->at == s->body[s->k].length) s->k++, s->at = 0;
	}
	return put;
}

static int seek(void *context, curl_off_t offset, int origin) {
	source *s = context;
	if (origin != SEEK_SET || offset < 0) return CURL_SEEKFUNC_CANTSEEK;
	s->k = 0, s->at = 0;
	for (size_t left = (size_t)offset; left;) {
		if (s->k == s->pieces) return CURL_SEEKFUNC_FAIL;
		size_t m = s->body[s->k].length;
		if (left < m) s->at = left, left = 0;
		else left -= m, s->k++;
	}
	return CURL_SEEKFUNC_OK;
}

// one https POST on curl's handle (it keeps the connection, and dials again when it drops)
static long secure(conn *c, const char *url, uint32_t wait_ms, const ls_piece *body, size_t pieces, size_t length,
	uint8_t *answer, size_t room) {
	if (c->curl == NULL) {
		if ((c->curl = curl_easy_init()) == NULL) return -1;
		c->headers = curl_slist_append(NULL, "Content-Type: application/octet-stream");
		c->headers = curl_slist_append(c->headers, "Expect:"); // no 100-continue round
		curl_easy_setopt(c->curl, CURLOPT_HTTPHEADER, c->headers);
		curl_easy_setopt(c->curl, CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
		curl_easy_setopt(c->curl, CURLOPT_NOSIGNAL, 1L);
		curl_easy_setopt(c->curl, CURLOPT_CONNECTTIMEOUT_MS, (long)DIAL_MS);
		curl_easy_setopt(c->curl, CURLOPT_WRITEFUNCTION, take);
		curl_easy_setopt(c->curl, CURLOPT_READFUNCTION, give);
		curl_easy_setopt(c->curl, CURLOPT_SEEKFUNCTION, seek);
		curl_easy_setopt(c->curl, CURLOPT_POST, 1L);
	}
	sink k = {answer, room, 0};
	source s = {body, pieces, 0, 0};
	curl_easy_setopt(c->curl, CURLOPT_URL, url);
	// the body read from the pieces (no POSTFIELDS: no copy of it here), its length known
	curl_easy_setopt(c->curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)length);
	curl_easy_setopt(c->curl, CURLOPT_READDATA, &s);
	curl_easy_setopt(c->curl, CURLOPT_SEEKDATA, &s);
	curl_easy_setopt(c->curl, CURLOPT_WRITEDATA, &k);
	curl_easy_setopt(c->curl, CURLOPT_TIMEOUT_MS, (long)wait_ms + SLACK_MS);
	long status = 0;
	if (curl_easy_perform(c->curl) != CURLE_OK) return -1;
	curl_easy_getinfo(c->curl, CURLINFO_RESPONSE_CODE, &status);
	return status == 200 ? (long)k.got : -1;
}
#endif

long ls_http_socket(void *context, const char *url, uint32_t wait_ms, const ls_piece *body, size_t pieces, size_t length,
	uint8_t *answer, size_t room) {
	conn *c = context;
	if (strncmp(url, "https://", 8) == 0) {
#ifdef LS_HTTP_CURL
		return secure(c, url, wait_ms, body, pieces, length, answer, room);
#else
		return -1;
#endif
	}
	char host[sizeof c->host], port[sizeof c->port];
	const char *path;
	if (!split(url, host, sizeof host, port, &path)) return -1;
	if (c->fd >= 0 && (strcmp(host, c->host) != 0 || strcmp(port, c->port) != 0)) hang_up(c);
	for (int fresh = 0; fresh < 2; fresh++) {
		int kept = c->fd >= 0;
		if (!kept) {
			strcpy(c->host, host), strcpy(c->port, port);
			if (!dial(c)) return -1;
		}
		long n = exchange(c, path, wait_ms, body, pieces, length, answer, room);
		if (n >= -1) {
			if (n == -1) hang_up(c);
			return n;
		}
		hang_up(c);
		if (!kept) return -1;
	}
	return -1;
}
