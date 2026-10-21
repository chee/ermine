// transport_openssl.c: transport.h's streams on a desktop: POSIX sockets,
// TLS by OpenSSL (the server's certificate checked against the system's
// roots and the host name). An ESP-IDF build replaces this file (lwIP,
// mbedTLS).

#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE

#include "transport.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/ssl.h>

struct ErmStream {
	int fd;
	SSL_CTX *context;
	SSL *ssl; // NULL for plain TCP
};

/** a TCP connection to host:port (this waits), then non-blocking: the descriptor, or -1 */
static int dial(const char *host, const char *port, const char **error) {
	struct addrinfo hints = { 0 }, *found = NULL;
	hints.ai_family = AF_UNSPEC;
	hints.ai_socktype = SOCK_STREAM;
	if (getaddrinfo(host, port, &hints, &found) != 0) return *error = "the server's name could not be resolved", -1;
	int fd = -1;
	for (struct addrinfo *a = found; a && fd < 0; a = a->ai_next) {
		fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
		if (fd < 0) continue;
		if (connect(fd, a->ai_addr, a->ai_addrlen) != 0) {
			close(fd);
			fd = -1;
		}
	}
	freeaddrinfo(found);
	if (fd < 0) return *error = "could not connect to the server", -1;
	int one = 1;
	setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
#ifdef SO_NOSIGPIPE
	setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
	return fd;
}

static void nonblocking(int fd) {
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
}

ErmStream *ermStreamOpen(const char *host, const char *port, bool tls, const char **error) {
	int fd = dial(host, port, error);
	if (fd < 0) return NULL;
	ErmStream *s = calloc(1, sizeof *s);
	if (!s) return close(fd), *error = "out of memory", NULL;
	s->fd = fd;
	if (tls) {
		s->context = SSL_CTX_new(TLS_client_method());
		if (!s->context) return ermStreamClose(s), *error = "TLS could not start", NULL;
		SSL_CTX_set_min_proto_version(s->context, TLS1_2_VERSION);
		SSL_CTX_set_verify(s->context, SSL_VERIFY_PEER, NULL);
		SSL_CTX_set_default_verify_paths(s->context);
		s->ssl = SSL_new(s->context);
		if (!s->ssl) return ermStreamClose(s), *error = "TLS could not start", NULL;
		SSL_set_mode(s->ssl, SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
		SSL_set_tlsext_host_name(s->ssl, host);
		SSL_set1_host(s->ssl, host);
		SSL_set_fd(s->ssl, fd);
		if (SSL_connect(s->ssl) != 1) {
			long verified = SSL_get_verify_result(s->ssl);
			*error = verified != X509_V_OK ? X509_verify_cert_error_string(verified) : "the TLS handshake failed";
			ermStreamClose(s);
			return NULL;
		}
	}
	nonblocking(fd);
	return s;
}

/** waits until the descriptor is ready for `events` */
static void await(int fd, short events) {
	struct pollfd p = { fd, events, 0 };
	poll(&p, 1, 1000);
}

long ermStreamRead(ErmStream *s, uint8_t *out, size_t room) {
	if (!s || s->fd < 0) return -1;
	if (room > 1 << 30) room = 1 << 30;
	if (!s->ssl) {
		ssize_t n = recv(s->fd, out, room, 0);
		if (n > 0) return (long)n;
		if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
		return -1;
	}
	int n = SSL_read(s->ssl, out, (int)room);
	if (n > 0) return n;
	int why = SSL_get_error(s->ssl, n);
	if (why == SSL_ERROR_WANT_READ || why == SSL_ERROR_WANT_WRITE) return 0;
	return -1;
}

bool ermStreamWrite(ErmStream *s, const uint8_t *bytes, size_t length) {
	if (!s || s->fd < 0) return false;
	while (length) {
		size_t chunk = length > 1 << 30 ? 1 << 30 : length;
		if (!s->ssl) {
#ifdef MSG_NOSIGNAL
			ssize_t n = send(s->fd, bytes, chunk, MSG_NOSIGNAL);
#else
			ssize_t n = send(s->fd, bytes, chunk, 0);
#endif
			if (n > 0) {
				bytes += n, length -= (size_t)n;
			} else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
				await(s->fd, POLLOUT);
			} else {
				return false;
			}
			continue;
		}
		int n = SSL_write(s->ssl, bytes, (int)chunk);
		if (n > 0) {
			bytes += n, length -= (size_t)n;
			continue;
		}
		int why = SSL_get_error(s->ssl, n);
		if (why == SSL_ERROR_WANT_WRITE) await(s->fd, POLLOUT);
		else if (why == SSL_ERROR_WANT_READ) await(s->fd, POLLIN);
		else return false;
	}
	return true;
}

int ermStreamFd(const ErmStream *s) {
	return s ? s->fd : -1;
}

void ermStreamWait(ErmStream *s, int ms) {
	if (!s || s->fd < 0 || (s->ssl && SSL_pending(s->ssl) > 0)) return;
	struct pollfd p = { s->fd, POLLIN, 0 };
	poll(&p, 1, ms);
}

void ermStreamClose(ErmStream *s) {
	if (!s) return;
	if (s->ssl) {
		SSL_shutdown(s->ssl);
		SSL_free(s->ssl);
	}
	if (s->context) SSL_CTX_free(s->context);
	if (s->fd >= 0) close(s->fd);
	free(s);
}
