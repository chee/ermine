// drv_vnc.c: /drivers/vnc, an RFB (VNC) client: another machine's screen in
// an ermine window, its keyboard and pointer from ermine's. The other side
// keeps its own screen, cursor and focus, so input reaches every app there
// (a second Mac login over Screen Sharing, a Linux machine or a VM).
//
//   /dev/vnc/views/<name>     a program's (ephemeral): {host, port, user?, layer, x, y, w, h,
//                             view: "fit" | "actual", sx, sy, hide?, n, keys?, ground?, remember?}; a new n
//                             connects again; the node gone, the connection closes
//   /dev/vnc/sessions/<name>  the driver's: {state, error, host, port, version, security,
//                             desktop, w, h, encoding, frames, bytes, scale, x, y, mac, keys}
//   /dev/vnc/sessions/<name>/cursor   the other side's cursor, a picture, while it sends one
//   /dev/vnc/driver/on/password   (name, password, user?): held in this driver's memory for the
//                             view's life, never in the graph
//   /dev/vnc/driver/on/input  (name, events): irq 34 and 35 records, x and y in the layer's
//                             pixels; {event: "release"}, {event: "chord", keys}, {event: "clip", text}
//
// state: connecting, securing, password (waiting for on/password), live, closed (the other
// side ended it), failed (error says why).
//
// remember: true, a password wanted is asked of the Mac's keychain first (the
// metal's keychain command, its answer an irq 66 record {event: "keychain",
// account, password}), and one typed is kept there once the connection is
// live; false, taken out once live. The account: user@host:port, or host:port.
//
// Pixels: the other side's screen, as its updates finish, is copied into a
// plane of the view's size (fit: scaled, area-averaged; actual: 1:1 from sx,
// sy), hostPlanes' source "vnc", and the driver writes the view's layer's
// plane, {source: "vnc", id, serial, x, y, w, h, dirty?}: only the
// rectangle an update changed is scaled again and copied by the compositor,
// and a frame costs the program nothing. Over the plane the layer's ops are
// played, as Paint's are; the program leaves the plane's rectangle undrawn.
//
// The thread, one a connection: connects, speaks RFB 3.3, 3.7 or 3.8 (3.889,
// Apple's, as 3.8), secures with None, VNC authentication (DES) or Apple
// Remote Desktop's (type 30: Diffie-Hellman, MD5, AES-128), and decodes
// Raw, CopyRect, RRE, Hextile, Zlib and ZRLE into a screen of its own, and
// the Cursor, DesktopSize, ExtendedDesktopSize and LastRect pseudo-encodings.
// An update done, its rectangles are copied into the screen the host reads,
// irq 66 is posted, and the next incremental update is asked for once the
// host has taken it: one a turn, at most.
//
// Keys go as X keysyms: a key's text when it typed one with no command,
// control or option held (so the layout is the person's), else the key's
// place on a US keyboard. cmd and option are keys' `cmd` and `alt`, keysym
// names: on a Mac server (RFB 3.889, or type 30 offered) Alt_L and Meta_L,
// as OSXvnc's server takes them (Alt as Command, Meta as Option); else
// Super_L and Alt_L. Neither is checked against Apple's server here.
//
// The clipboard: the other side's (ServerCutText, Latin-1) is written to
// /dev/clip/text, from "vnc", which the clip driver gives the Mac; a clip
// event sends text (ClientCutText, Latin-1, a character it has not a ?).

#define OPENSSL_SUPPRESS_DEPRECATED // DES_ecb_encrypt: VNC authentication's DES, which OpenSSL 3's EVP keeps in its legacy provider

#include "drivers.h"
#include "../../../ermine/encoding/c/json_text.h"
#include "drv.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <openssl/bn.h>
#include <openssl/des.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#include <zlib.h>

#define IRQ 66
#define MOST 8192   // the widest and tallest a screen or a view may be
#define CUT 1048576 // the most clipboard text taken or sent
#define HELD 32     // keys held down at once, remembered so each up is its down's keysym

typedef struct Box {
	int x, y, w, h;
} Box;

static Box unite(Box a, Box b) {
	if (a.w <= 0 || a.h <= 0) return b;
	if (b.w <= 0 || b.h <= 0) return a;
	int x0 = a.x < b.x ? a.x : b.x, y0 = a.y < b.y ? a.y : b.y;
	int x1 = a.x + a.w > b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h > b.y + b.h ? a.y + a.h : b.y + b.h;
	return (Box){ x0, y0, x1 - x0, y1 - y0 };
}

static Box meet(Box a, Box b) {
	int x0 = a.x > b.x ? a.x : b.x, y0 = a.y > b.y ? a.y : b.y;
	int x1 = a.x + a.w < b.x + b.w ? a.x + a.w : b.x + b.w, y1 = a.y + a.h < b.y + b.h ? a.y + a.h : b.y + b.h;
	return x1 > x0 && y1 > y0 ? (Box){ x0, y0, x1 - x0, y1 - y0 } : (Box){ 0 };
}

typedef struct Screen {
	char *name;  // its view's, in /dev/vnc/views
	int64_t n;   // the view's n it was made for
	char *host, *user;
	int port;
	int k;       // its session node's id, vnc/sessions/<name>.<k>
	// shared with the thread, under lock
	pthread_mutex_t lock;
	pthread_cond_t cond;
	int fd;
	bool stop, posted, asked;
	char *secret;      // the password, until the thread has used it
	uint32_t *front;   // the other side's screen as its last whole update left it
	int fw, fh;
	Box dirty;         // what changed in it since the host last took it
	bool sized, cursed;
	char state[16];
	char *error, *desktop, *want; // want: what a password wait wants, "password" or "user"
	int minor;
	const char *security, *encoding;
	bool mac;
	int64_t frames, bytes;
	uint32_t *cbits;   // the cursor: its pixels, a bit a pixel of its mask
	uint8_t *cmask;
	int cw, ch, chx, chy;
	char *cut;         // the other side's clipboard, UTF-8, not yet written
	// the thread's own
	pthread_t thread;
	pthread_mutex_t out; // the socket's sending side: the thread asks for updates, the host sends input
	uint32_t *back;
	int bw, bh;
	z_stream zrle, zlib;
	bool zrleOn, zlibOn;
	uint8_t in[65536];
	size_t ip, il;
	uint8_t *buf;      // scratch: inflated data, a rectangle's pixels
	size_t cap;
	// the host's own
	int64_t id, serial; // the plane's
	uint32_t *view;
	int vw, vh, ow, oh; // the plane; and the picture of the screen in it, at ox, oy, ow × oh
	int ox, oy, sx, sy;
	double scale;
	bool fit, hide, shown, whole; // whole: the plane drawn whole at the next turn
	uint32_t ground;
	char *layer;
	int x, y;          // the plane's place in the layer
	uint32_t cmd, alt; // the keysyms cmd and option send; 0 the server's kind's
	struct {
		char key[24];
		uint32_t sym;
	} held[HELD];
	int buttons;       // RFB's mask held
	double wheel, wheelx;
	int px, py;        // where the pointer was last said to be, the other side's pixels
	char *said;        // the session node's value as last written
	int64_t told;      // when frames and bytes were last written, µs
	int64_t tf, tb;
	bool placed, ready; // ready: the screen has come, so the plane shows it
	int cmade;         // the cursor picture's scale as last made, per mille
	bool remember, unremember; // the view's remember: true, the password kept in the Mac's keychain once it works; false, taken out
	bool sought, seeking, keyed, filed; // the keychain asked, its answer awaited, its password used; the keychain told, once live
} Screen;

typedef struct Vnc {
	Host *host;
	int unit;
	struct {
		Screen **items;
		int count, capacity;
	} screens;
	struct {
		char *name, *secret, *user;
	} kept[16]; // passwords given for a view, held for its life
	int64_t ids;
	int ks;
} Vnc;

static Vnc *the; // for hostPlane's

static void push(Vnc *v, Screen *s) {
	if (v->screens.count == v->screens.capacity) {
		v->screens.capacity = v->screens.capacity ? v->screens.capacity * 2 : 4;
		v->screens.items = realloc(v->screens.items, sizeof(Screen *) * (size_t)v->screens.capacity);
	}
	v->screens.items[v->screens.count++] = s;
}

static void wipe(char *secret) {
	if (!secret) return;
	volatile char *p = secret;
	while (*p) *p++ = 0;
	free(secret);
}

// --- the thread's side: the socket

/** the thread says where it is: state, and error (NULL for none), and wakes the host */
static void post(Screen *s) {
	pthread_mutex_lock(&s->lock);
	if (!s->posted) {
		s->posted = true;
		ermosPost("{\"irq\": 66}");
	}
	pthread_mutex_unlock(&s->lock);
}

static void say(Screen *s, const char *state, const char *error) {
	pthread_mutex_lock(&s->lock);
	snprintf(s->state, sizeof s->state, "%s", state);
	free(s->error);
	s->error = error ? copyString(error) : NULL;
	pthread_mutex_unlock(&s->lock);
	post(s);
}

static bool stopped(Screen *s) {
	pthread_mutex_lock(&s->lock);
	bool stop = s->stop;
	pthread_mutex_unlock(&s->lock);
	return stop;
}

/** n bytes from the socket, exactly; false at its end, an error or a stop */
static bool take(Screen *s, void *out, size_t n) {
	uint8_t *o = out;
	while (n) {
		if (s->ip == s->il) {
			ssize_t got = recv(s->fd, s->in, sizeof s->in, 0);
			if (got < 0 && errno == EINTR) continue;
			if (got <= 0) return false;
			s->ip = 0, s->il = (size_t)got;
			pthread_mutex_lock(&s->lock);
			s->bytes += got;
			pthread_mutex_unlock(&s->lock);
		}
		size_t k = s->il - s->ip < n ? s->il - s->ip : n;
		memcpy(o, s->in + s->ip, k);
		s->ip += k, o += k, n -= k;
	}
	return true;
}

static bool skip(Screen *s, size_t n) {
	uint8_t junk[512];
	while (n) {
		size_t k = n < sizeof junk ? n : sizeof junk;
		if (!take(s, junk, k)) return false;
		n -= k;
	}
	return true;
}

static bool u8(Screen *s, uint8_t *v) {
	return take(s, v, 1);
}

static bool u16(Screen *s, uint16_t *v) {
	uint8_t b[2];
	if (!take(s, b, 2)) return false;
	*v = (uint16_t)(b[0] << 8 | b[1]);
	return true;
}

static bool u32(Screen *s, uint32_t *v) {
	uint8_t b[4];
	if (!take(s, b, 4)) return false;
	*v = (uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 | (uint32_t)b[2] << 8 | b[3];
	return true;
}

/** a pixel as it comes: four bytes, little-endian, 0x00RRGGBB (the format asked for) */
static bool pixel(Screen *s, uint32_t *v) {
	uint8_t b[4];
	if (!take(s, b, 4)) return false;
	*v = (uint32_t)b[2] << 16 | (uint32_t)b[1] << 8 | b[0];
	return true;
}

/** bytes to the socket, all of them; from either thread */
static bool put(Screen *s, const void *bytes, size_t n) {
	const uint8_t *b = bytes;
	pthread_mutex_lock(&s->out);
	bool ok = s->fd >= 0;
	while (ok && n) {
		ssize_t k = send(s->fd, b, n, 0);
		if (k < 0 && errno == EINTR) continue;
		if (k <= 0) ok = false;
		else b += k, n -= (size_t)k;
	}
	pthread_mutex_unlock(&s->out);
	return ok;
}

static void be16(uint8_t *at, unsigned v) {
	at[0] = (uint8_t)(v >> 8), at[1] = (uint8_t)v;
}

static void be32(uint8_t *at, uint32_t v) {
	at[0] = (uint8_t)(v >> 24), at[1] = (uint8_t)(v >> 16), at[2] = (uint8_t)(v >> 8), at[3] = (uint8_t)v;
}

/** scratch of at least n bytes */
static uint8_t *room(Screen *s, size_t n) {
	if (n > s->cap) {
		s->buf = realloc(s->buf, n);
		s->cap = n;
	}
	return s->buf;
}

/** the reason a server gives (a u32 length, then text) */
static char *reason(Screen *s) {
	uint32_t n;
	if (!u32(s, &n)) return copyString("closed");
	if (n > 4096) n = 4096;
	char *t = calloc(n + 1, 1);
	if (!take(s, t, n)) {
		free(t);
		return copyString("closed");
	}
	return t;
}

/** the address, connected, waiting at most 10 s, a stop seen within a quarter of one */
static int dial(Screen *s, char **why) {
	char port[16];
	snprintf(port, sizeof port, "%d", s->port);
	struct addrinfo hints = { .ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM }, *list = NULL;
	int e = getaddrinfo(s->host, port, &hints, &list);
	if (e) {
		*why = formatString("no such host: %s", gai_strerror(e));
		return -1;
	}
	int fd = -1;
	*why = NULL;
	for (struct addrinfo *a = list; a && fd < 0 && !stopped(s); a = a->ai_next) {
		fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
		if (fd < 0) continue;
		int on = 1;
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof on);
		int flags = fcntl(fd, F_GETFL, 0);
		fcntl(fd, F_SETFL, flags | O_NONBLOCK);
		int r = connect(fd, a->ai_addr, a->ai_addrlen);
		if (r < 0 && errno == EINPROGRESS) {
			r = -1;
			for (int t = 0; t < 40 && !stopped(s); t++) {
				struct pollfd p = { fd, POLLOUT, 0 };
				if (poll(&p, 1, 250) > 0) {
					int err = 0;
					socklen_t len = sizeof err;
					getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
					if (!err) r = 0;
					else {
						free(*why);
						*why = formatString("%s", strerror(err));
					}
					break;
				}
			}
			if (r < 0 && !*why) *why = copyString("timed out");
		} else if (r < 0) {
			free(*why);
			*why = formatString("%s", strerror(errno));
		}
		if (r < 0) {
			close(fd);
			fd = -1;
			continue;
		}
		fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);
	}
	freeaddrinfo(list);
	if (fd >= 0) {
		free(*why);
		*why = NULL;
	} else if (!*why) *why = copyString("stopped");
	return fd;
}

// --- securing

/** waits for a password (and a user, when want is "user") from on/password; false on a stop */
static bool ask(Screen *s, const char *want) {
	pthread_mutex_lock(&s->lock);
	bool have = s->secret && (strcmp(want, "user") || (s->user && *s->user));
	if (!have) {
		snprintf(s->state, sizeof s->state, "password");
		free(s->want);
		s->want = copyString(want);
		s->asked = true;
		if (!s->posted) {
			s->posted = true;
			ermosPost("{\"irq\": 66}");
		}
		while (!s->stop && !(s->secret && (strcmp(want, "user") || (s->user && *s->user)))) pthread_cond_wait(&s->cond, &s->lock);
		s->asked = false;
		snprintf(s->state, sizeof s->state, "securing");
	}
	bool ok = !s->stop;
	pthread_mutex_unlock(&s->lock);
	return ok;
}

static unsigned char flip(unsigned char b) {
	b = (unsigned char)((b & 0xF0) >> 4 | (b & 0x0F) << 4);
	b = (unsigned char)((b & 0xCC) >> 2 | (b & 0x33) << 2);
	return (unsigned char)((b & 0xAA) >> 1 | (b & 0x55) << 1);
}

/** VNC authentication: the 16-byte challenge, DES-encrypted with the password's first 8 bytes, each reversed bit by bit */
static bool vncAuth(Screen *s) {
	uint8_t challenge[16], answer[16];
	if (!take(s, challenge, 16) || !ask(s, "password")) return false;
	DES_cblock key = { 0 };
	pthread_mutex_lock(&s->lock);
	for (size_t i = 0; i < 8 && s->secret[i]; i++) key[i] = flip((unsigned char)s->secret[i]);
	pthread_mutex_unlock(&s->lock);
	DES_key_schedule ks;
	DES_set_key_unchecked(&key, &ks);
	DES_ecb_encrypt((const_DES_cblock *)challenge, (DES_cblock *)answer, &ks, DES_ENCRYPT);
	DES_ecb_encrypt((const_DES_cblock *)(challenge + 8), (DES_cblock *)(answer + 8), &ks, DES_ENCRYPT);
	memset(&key, 0, sizeof key);
	memset(&ks, 0, sizeof ks);
	return put(s, answer, 16);
}

/**
 * Apple Remote Desktop's (type 30), as libvncclient and noVNC do it: the
 * server sends a generator (2 bytes), a key length (2), the prime (key
 * length bytes) and its public key; the client's key pair on them; the
 * shared secret, key length bytes, MD5'd, is an AES-128 key; the user and
 * the password, each NUL-ended in 64 bytes, random bytes after, encrypted
 * in ECB, no padding; sent, then the client's public key
 */
static bool ardAuth(Screen *s) {
	uint8_t gen[2];
	uint16_t len;
	if (!take(s, gen, 2) || !u16(s, &len) || !len || len > 1024) return false;
	uint8_t *prime = malloc(len), *theirs = malloc(len), *mine = malloc(len), *shared = malloc(len);
	bool ok = take(s, prime, len) && take(s, theirs, len) && ask(s, "user");
	BN_CTX *ctx = BN_CTX_new();
	BIGNUM *p = BN_bin2bn(prime, len, NULL), *g = BN_bin2bn(gen, 2, NULL), *peer = BN_bin2bn(theirs, len, NULL);
	BIGNUM *priv = BN_new(), *pub = BN_new(), *sec = BN_new();
	ok = ok && ctx && p && g && peer && priv && pub && sec && BN_priv_rand_range(priv, p) && BN_mod_exp(pub, g, priv, p, ctx) &&
	     BN_mod_exp(sec, peer, priv, p, ctx) && BN_bn2binpad(pub, mine, len) == len && BN_bn2binpad(sec, shared, len) == len;
	uint8_t key[EVP_MAX_MD_SIZE], plain[128], cipher[128 + 16];
	unsigned klen = 0;
	int clen = 0, more = 0;
	ok = ok && EVP_Digest(shared, len, key, &klen, EVP_md5(), NULL) && klen == 16 && RAND_bytes(plain, sizeof plain) == 1;
	if (ok) {
		pthread_mutex_lock(&s->lock);
		size_t un = strlen(s->user), pn = strlen(s->secret);
		if (un > 63) un = 63;
		if (pn > 63) pn = 63;
		memcpy(plain, s->user, un);
		plain[un] = 0;
		memcpy(plain + 64, s->secret, pn);
		plain[64 + pn] = 0;
		pthread_mutex_unlock(&s->lock);
		EVP_CIPHER_CTX *aes = EVP_CIPHER_CTX_new();
		ok = aes && EVP_EncryptInit_ex(aes, EVP_aes_128_ecb(), NULL, key, NULL) && EVP_CIPHER_CTX_set_padding(aes, 0) &&
		     EVP_EncryptUpdate(aes, cipher, &clen, plain, sizeof plain) && EVP_EncryptFinal_ex(aes, cipher + clen, &more) && clen + more == 128;
		EVP_CIPHER_CTX_free(aes);
	}
	ok = ok && put(s, cipher, 128) && put(s, mine, len);
	memset(plain, 0, sizeof plain);
	memset(key, 0, sizeof key);
	memset(shared, 0, len);
	BN_clear_free(priv);
	BN_clear_free(sec);
	BN_free(pub);
	BN_free(p);
	BN_free(g);
	BN_free(peer);
	BN_CTX_free(ctx);
	free(prime);
	free(theirs);
	free(mine);
	free(shared);
	return ok;
}

/** the version, the security and its result, the init: false with *why on a failure */
static bool handshake(Screen *s, char **why) {
	char v[13] = { 0 };
	if (!take(s, v, 12)) return *why = copyString("closed before its version"), false;
	int major = 0, minor = 0;
	if (sscanf(v, "RFB %3d.%3d", &major, &minor) != 2 || major != 3) return *why = formatString("not an RFB server (%.11s)", v), false;
	// 3.889 is Apple's, answered as 3.8; UltraVNC's and TightVNC's odd minors as 3.3
	int use = minor >= 8 ? 8 : minor == 7 ? 7 : 3;
	pthread_mutex_lock(&s->lock);
	s->minor = minor;
	s->mac = minor == 889;
	pthread_mutex_unlock(&s->lock);
	char mine[13];
	snprintf(mine, sizeof mine, "RFB 003.%03d\n", use);
	if (!put(s, mine, 12)) return *why = copyString("closed"), false;
	say(s, "securing", NULL);
	uint32_t type = 0;
	if (use == 3) {
		if (!u32(s, &type)) return *why = copyString("closed"), false;
		if (type == 0) return *why = reason(s), false;
	} else {
		uint8_t count, types[255];
		if (!u8(s, &count)) return *why = copyString("closed"), false;
		if (!count) return *why = reason(s), false;
		if (!take(s, types, count)) return *why = copyString("closed"), false;
		bool has[256] = { false };
		for (int i = 0; i < count; i++) has[types[i]] = true;
		pthread_mutex_lock(&s->lock);
		bool user = s->user && *s->user;
		if (has[30]) s->mac = true;
		pthread_mutex_unlock(&s->lock);
		// a user given and Apple's offered: Apple's (a Mac login); else VNC's; else none; else Apple's, asking for a user
		type = has[30] && user ? 30 : has[2] ? 2 : has[1] ? 1 : has[30] ? 30 : 0;
		if (!type) {
			char list[1024] = "";
			for (int i = 0; i < count; i++) snprintf(list + strlen(list), sizeof list - strlen(list), "%s%d", i ? ", " : "", types[i]);
			return *why = formatString("no security type this client has: the server offers %s", list), false;
		}
		uint8_t t = (uint8_t)type;
		if (!put(s, &t, 1)) return *why = copyString("closed"), false;
	}
	pthread_mutex_lock(&s->lock);
	s->security = type == 1 ? "none" : type == 2 ? "vnc" : type == 30 ? "ard" : "?";
	pthread_mutex_unlock(&s->lock);
	if (type == 2 && !vncAuth(s)) return *why = copyString(stopped(s) ? "stopped" : "closed during VNC authentication"), false;
	if (type == 30 && !ardAuth(s)) return *why = copyString(stopped(s) ? "stopped" : "closed during Apple's authentication"), false;
	// the result: 3.8 always; 3.7 and 3.3 after a password only
	if (type != 1 || use == 8) {
		uint32_t result;
		if (!u32(s, &result)) return *why = copyString("closed before the security result"), false;
		if (result) {
			char *r = use == 8 ? reason(s) : copyString("");
			*why = formatString("refused: %s", *r ? r : type == 1 ? "no access" : "the password, or the user, is wrong");
			free(r);
			return false;
		}
	}
	// shared: others stay connected
	uint8_t shared = 1;
	if (!put(s, &shared, 1)) return *why = copyString("closed"), false;
	uint8_t init[24];
	if (!take(s, init, 24)) return *why = copyString("closed before its init"), false;
	int w = init[0] << 8 | init[1], h = init[2] << 8 | init[3];
	uint32_t nl = (uint32_t)init[20] << 24 | (uint32_t)init[21] << 16 | (uint32_t)init[22] << 8 | init[23];
	char *desktop = calloc(nl < 1024 ? nl + 1 : 1025, 1);
	if (!take(s, desktop, nl < 1024 ? nl : 1024) || (nl > 1024 && !skip(s, nl - 1024))) {
		free(desktop);
		return *why = copyString("closed"), false;
	}
	if (w < 1 || h < 1 || w > MOST || h > MOST) {
		free(desktop);
		return *why = formatString("a screen of %d × %d", w, h), false;
	}
	s->bw = w, s->bh = h;
	s->back = calloc((size_t)w * (size_t)h, 4);
	pthread_mutex_lock(&s->lock);
	free(s->desktop);
	s->desktop = desktop;
	s->sized = true;
	pthread_mutex_unlock(&s->lock);
	// pixels as a layer's: 32 bits, depth 24, little-endian, true colour, red at 16, green 8, blue 0
	uint8_t format[20] = { 0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0 };
	// the encodings, the best first: CopyRect, ZRLE, Zlib, Hextile, RRE, Raw; Cursor, DesktopSize, ExtendedDesktopSize, LastRect
	static const int32_t encodings[] = { 1, 16, 6, 5, 2, 0, -239, -223, -308, -224 };
	uint8_t set[4 + 4 * sizeof encodings / sizeof *encodings] = { 2, 0 };
	be16(set + 2, sizeof encodings / sizeof *encodings);
	for (size_t i = 0; i < sizeof encodings / sizeof *encodings; i++) be32(set + 4 + 4 * i, (uint32_t)encodings[i]);
	if (!put(s, format, sizeof format) || !put(s, set, sizeof set)) return *why = copyString("closed"), false;
	return true;
}

// --- decoding, into back

static void fill(Screen *s, int x, int y, int w, int h, uint32_t c) {
	Box b = meet((Box){ x, y, w, h }, (Box){ 0, 0, s->bw, s->bh });
	for (int j = b.y; j < b.y + b.h; j++)
		for (int i = b.x; i < b.x + b.w; i++) s->back[(size_t)j * s->bw + i] = c;
}

/** pixels at x, y, w × h, rows of w, clipped to the screen */
static void blit(Screen *s, int x, int y, int w, int h, const uint32_t *px) {
	Box b = meet((Box){ x, y, w, h }, (Box){ 0, 0, s->bw, s->bh });
	for (int j = b.y; j < b.y + b.h; j++) memcpy(s->back + (size_t)j * s->bw + b.x, px + (size_t)(j - y) * w + (b.x - x), (size_t)b.w * 4);
}

static uint32_t le(const uint8_t *b) {
	return (uint32_t)b[2] << 16 | (uint32_t)b[1] << 8 | b[0];
}

static bool raw(Screen *s, int x, int y, int w, int h) {
	uint8_t *row = room(s, (size_t)w * 4);
	uint32_t *px = malloc((size_t)w * 4);
	bool ok = true;
	for (int j = 0; j < h && ok; j++) {
		ok = take(s, row, (size_t)w * 4);
		for (int i = 0; ok && i < w; i++) px[i] = le(row + 4 * i);
		if (ok) blit(s, x, y + j, w, 1, px);
	}
	free(px);
	return ok;
}

static bool copyRect(Screen *s, int x, int y, int w, int h) {
	uint16_t sx, sy;
	if (!u16(s, &sx) || !u16(s, &sy)) return false;
	Box from = meet((Box){ sx, sy, w, h }, (Box){ 0, 0, s->bw, s->bh });
	if (!from.w) return true;
	uint32_t *tmp = malloc((size_t)from.w * (size_t)from.h * 4);
	for (int j = 0; j < from.h; j++) memcpy(tmp + (size_t)j * from.w, s->back + (size_t)(from.y + j) * s->bw + from.x, (size_t)from.w * 4);
	blit(s, x + (from.x - sx), y + (from.y - sy), from.w, from.h, tmp);
	free(tmp);
	return true;
}

static bool rre(Screen *s, int x, int y, int w, int h) {
	uint32_t n, bg;
	if (!u32(s, &n) || !pixel(s, &bg)) return false;
	fill(s, x, y, w, h, bg);
	for (uint32_t i = 0; i < n; i++) {
		uint32_t c;
		uint16_t r[4];
		if (!pixel(s, &c) || !u16(s, &r[0]) || !u16(s, &r[1]) || !u16(s, &r[2]) || !u16(s, &r[3])) return false;
		fill(s, x + r[0], y + r[1], r[2] < w - r[0] ? r[2] : w - r[0], r[3] < h - r[1] ? r[3] : h - r[1], c);
	}
	return true;
}

static bool hextile(Screen *s, int x, int y, int w, int h) {
	uint32_t bg = 0, fg = 0;
	for (int ty = 0; ty < h; ty += 16)
		for (int tx = 0; tx < w; tx += 16) {
			int tw = w - tx < 16 ? w - tx : 16, th = h - ty < 16 ? h - ty : 16;
			uint8_t sub;
			if (!u8(s, &sub)) return false;
			if (sub & 1) {
				if (!raw(s, x + tx, y + ty, tw, th)) return false;
				continue;
			}
			if (sub & 2 && !pixel(s, &bg)) return false;
			fill(s, x + tx, y + ty, tw, th, bg);
			if (sub & 4 && !pixel(s, &fg)) return false;
			if (!(sub & 8)) continue;
			uint8_t n;
			if (!u8(s, &n)) return false;
			for (int i = 0; i < n; i++) {
				uint32_t c = fg;
				uint8_t xy, wh;
				if ((sub & 16 && !pixel(s, &c)) || !u8(s, &xy) || !u8(s, &wh)) return false;
				int rx = xy >> 4, ry = xy & 15, rw = (wh >> 4) + 1, rh = (wh & 15) + 1;
				if (rx + rw > tw) rw = tw - rx;
				if (ry + rh > th) rh = th - ry;
				if (rw > 0 && rh > 0) fill(s, x + tx + rx, y + ty + ry, rw, rh, c);
			}
		}
	return true;
}

/** a zlib stream's next part, length-prefixed, inflated whole into the scratch: its length, or -1 */
static long inflated(Screen *s, z_stream *z, bool *on) {
	uint32_t n;
	if (!u32(s, &n) || n > 64u << 20) return -1;
	uint8_t *in = malloc(n ? n : 1);
	if (!take(s, in, n)) {
		free(in);
		return -1;
	}
	if (!*on) {
		memset(z, 0, sizeof *z);
		if (inflateInit(z) != Z_OK) {
			free(in);
			return -1;
		}
		*on = true;
	}
	z->next_in = in, z->avail_in = n;
	size_t got = 0;
	if (s->cap < 65536) room(s, 65536);
	for (;;) {
		if (got == s->cap) room(s, s->cap * 2);
		z->next_out = s->buf + got, z->avail_out = (uInt)(s->cap - got);
		int r = inflate(z, Z_SYNC_FLUSH);
		got = s->cap - z->avail_out;
		if (r == Z_STREAM_END) break;
		if (r != Z_OK && r != Z_BUF_ERROR) {
			free(in);
			return -1;
		}
		// all of it taken in and given out, or no way on: done
		if (z->avail_out && (!z->avail_in || r == Z_BUF_ERROR)) break;
	}
	free(in);
	return (long)got;
}

static bool zlibRect(Screen *s, int x, int y, int w, int h) {
	long n = inflated(s, &s->zlib, &s->zlibOn);
	if (n < (long)w * h * 4) return false;
	uint32_t *px = malloc((size_t)w * (size_t)h * 4);
	for (long i = 0; i < (long)w * h; i++) px[i] = le(s->buf + 4 * i);
	blit(s, x, y, w, h, px);
	free(px);
	return true;
}

typedef struct Reader {
	const uint8_t *p;
	size_t n, i;
	bool bad;
} Reader;

static unsigned byte(Reader *r) {
	if (r->i >= r->n) return r->bad = true, 0;
	return r->p[r->i++];
}

/** a CPIXEL: three bytes for this format, blue, green, red */
static uint32_t cpixel(Reader *r) {
	if (r->i + 3 > r->n) return r->bad = true, 0;
	uint32_t c = (uint32_t)r->p[r->i + 2] << 16 | (uint32_t)r->p[r->i + 1] << 8 | r->p[r->i];
	r->i += 3;
	return c;
}

static int run(Reader *r) {
	int n = 1;
	unsigned b;
	do {
		b = byte(r);
		n += (int)b;
	} while (b == 255 && !r->bad && n < 1 << 24);
	return n;
}

static bool zrle(Screen *s, int x, int y, int w, int h) {
	long n = inflated(s, &s->zrle, &s->zrleOn);
	if (n < 0) return false;
	// parsed from a copy: the scratch is reused by nothing below, but keep it plain
	Reader r = { s->buf, (size_t)n, 0, false };
	uint32_t tile[64 * 64], pal[128];
	for (int ty = 0; ty < h && !r.bad; ty += 64)
		for (int tx = 0; tx < w && !r.bad; tx += 64) {
			int tw = w - tx < 64 ? w - tx : 64, th = h - ty < 64 ? h - ty : 64, count = tw * th;
			unsigned sub = byte(&r);
			if (sub == 0)
				for (int i = 0; i < count; i++) tile[i] = cpixel(&r);
			else if (sub == 1) {
				uint32_t c = cpixel(&r);
				for (int i = 0; i < count; i++) tile[i] = c;
			} else if (sub <= 16) {
				for (unsigned i = 0; i < sub; i++) pal[i] = cpixel(&r);
				int bits = sub == 2 ? 1 : sub <= 4 ? 2 : 4;
				for (int j = 0; j < th; j++) {
					unsigned acc = 0;
					int have = 0;
					for (int i = 0; i < tw; i++) {
						if (!have) acc = byte(&r), have = 8;
						have -= bits;
						tile[j * tw + i] = pal[((acc >> have) & ((1u << bits) - 1)) % sub];
					}
				}
			} else if (sub == 128) {
				for (int i = 0; i < count && !r.bad;) {
					uint32_t c = cpixel(&r);
					int k = run(&r);
					while (k-- && i < count) tile[i++] = c;
				}
			} else if (sub >= 130) {
				unsigned m = sub - 128;
				for (unsigned i = 0; i < m; i++) pal[i] = cpixel(&r);
				for (int i = 0; i < count && !r.bad;) {
					unsigned b = byte(&r);
					uint32_t c = pal[(b & 127) % m];
					int k = b & 128 ? run(&r) : 1;
					while (k-- && i < count) tile[i++] = c;
				}
			} else r.bad = true;
			if (!r.bad) blit(s, x + tx, y + ty, tw, th, tile);
		}
	return !r.bad;
}

/** the cursor: its pixels, then its mask, a bit a pixel, rows a whole byte */
static bool cursor(Screen *s, int hx, int hy, int w, int h) {
	if ((size_t)w * (size_t)h > 1u << 20) return false;
	size_t mb = (size_t)(w + 7) / 8 * (size_t)h;
	uint8_t *px = malloc((size_t)w * (size_t)h * 4 + 1), *mask = malloc(mb + 1);
	bool ok = take(s, px, (size_t)w * (size_t)h * 4) && take(s, mask, mb);
	if (ok && w > 0 && h > 0 && w <= 256 && h <= 256) {
		uint32_t *bits = malloc((size_t)w * (size_t)h * 4 + 4);
		for (int i = 0; i < w * h; i++) bits[i] = le(px + 4 * i);
		pthread_mutex_lock(&s->lock);
		free(s->cbits);
		free(s->cmask);
		s->cbits = bits, s->cmask = mask, mask = NULL;
		s->cw = w, s->ch = h, s->chx = hx, s->chy = hy;
		s->cursed = true;
		pthread_mutex_unlock(&s->lock);
	}
	free(px);
	free(mask);
	return ok;
}

static void resize(Screen *s, int w, int h) {
	if (w < 1 || h < 1 || w > MOST || h > MOST || (w == s->bw && h == s->bh)) return;
	uint32_t *b = calloc((size_t)w * (size_t)h, 4);
	for (int j = 0; j < h && j < s->bh; j++) memcpy(b + (size_t)j * w, s->back + (size_t)j * s->bw, (size_t)(w < s->bw ? w : s->bw) * 4);
	free(s->back);
	s->back = b, s->bw = w, s->bh = h;
	pthread_mutex_lock(&s->lock);
	s->sized = true;
	pthread_mutex_unlock(&s->lock);
}

static const char *named(int32_t e) {
	switch (e) {
	case 0: return "Raw";
	case 1: return "CopyRect";
	case 2: return "RRE";
	case 5: return "Hextile";
	case 6: return "Zlib";
	case 16: return "ZRLE";
	default: return NULL;
	}
}

/** a FramebufferUpdate, after its type: each rectangle into back; *box what changed, *sized whether the screen did */
static bool update(Screen *s, Box *box, bool *sized, char **why) {
	uint8_t pad;
	uint16_t count;
	if (!u8(s, &pad) || !u16(s, &count)) return false;
	for (int i = 0; i < count; i++) {
		uint16_t r[4];
		uint32_t e;
		if (!u16(s, &r[0]) || !u16(s, &r[1]) || !u16(s, &r[2]) || !u16(s, &r[3]) || !u32(s, &e)) return false;
		int x = r[0], y = r[1], w = r[2], h = r[3];
		int32_t enc = (int32_t)e;
		bool ok = true;
		if (enc == -224) break; // LastRect
		if (enc == -223) {
			resize(s, w, h);
			*sized = true;
			continue;
		}
		if (enc == -308) {
			uint8_t head[4];
			ok = take(s, head, 4) && skip(s, (size_t)head[0] * 16);
			if (ok && y == 0) {
				resize(s, w, h);
				*sized = true;
			}
			if (!ok) return false;
			continue;
		}
		if (enc == -239) {
			if (!cursor(s, x, y, w, h)) return false;
			continue;
		}
		if ((size_t)w * (size_t)h > (size_t)MOST * MOST) return *why = copyString("a rectangle too big"), false;
		switch (enc) {
		case 0: ok = raw(s, x, y, w, h); break;
		case 1: ok = copyRect(s, x, y, w, h); break;
		case 2: ok = rre(s, x, y, w, h); break;
		case 5: ok = hextile(s, x, y, w, h); break;
		case 6: ok = zlibRect(s, x, y, w, h); break;
		case 16: ok = zrle(s, x, y, w, h); break;
		default: return *why = formatString("an encoding not asked for: %d", (int)enc), false;
		}
		if (!ok) return *why = formatString("%s: its data cut short or wrong", named(enc)), false;
		if (enc != 1 || !s->encoding) {
			pthread_mutex_lock(&s->lock);
			s->encoding = named(enc);
			pthread_mutex_unlock(&s->lock);
		}
		*box = unite(*box, meet((Box){ x, y, w, h }, (Box){ 0, 0, s->bw, s->bh }));
	}
	return true;
}

/** text in Latin-1 as UTF-8, fresh */
static char *utf8(const uint8_t *t, size_t n) {
	char *o = malloc(n * 2 + 1), *p = o;
	for (size_t i = 0; i < n; i++) {
		if (t[i] < 0x80) *p++ = (char)t[i];
		else *p++ = (char)(0xC0 | t[i] >> 6), *p++ = (char)(0x80 | (t[i] & 63));
	}
	*p = 0;
	return o;
}

static bool request(Screen *s, bool incremental) {
	uint8_t m[10] = { 3, incremental };
	be16(m + 6, (unsigned)s->bw);
	be16(m + 8, (unsigned)s->bh);
	return put(s, m, sizeof m);
}

static void *talk(void *data) {
	Screen *s = data;
	char *why = NULL;
	int fd = dial(s, &why);
	pthread_mutex_lock(&s->out);
	s->fd = fd;
	pthread_mutex_unlock(&s->out);
	if (fd < 0) {
		say(s, "failed", why);
		free(why);
		return NULL;
	}
	if (!handshake(s, &why)) {
		say(s, stopped(s) ? "closed" : "failed", why);
		free(why);
		return NULL;
	}
	pthread_mutex_lock(&s->lock);
	wipe(s->secret); // used: the driver keeps the view's copy for a connection again
	s->secret = NULL;
	s->fw = s->bw, s->fh = s->bh;
	s->front = calloc((size_t)s->bw * (size_t)s->bh, 4);
	pthread_mutex_unlock(&s->lock);
	say(s, "live", NULL);
	bool whole = true;
	while (request(s, !whole)) {
		whole = false;
		uint8_t type;
		Box box = { 0 };
		bool sized = false, done = false;
		// messages until an update: the bell, the colour map, the clipboard come between
		while (!done) {
			if (!u8(s, &type)) goto gone;
			if (type == 0) {
				if (!update(s, &box, &sized, &why)) goto gone;
				done = true;
			} else if (type == 1) {
				uint8_t head[5];
				uint16_t k;
				if (!take(s, head, 3) || !u16(s, &k) || !skip(s, (size_t)k * 6)) goto gone;
			} else if (type == 2) {
				// the bell: not rung
			} else if (type == 3) {
				uint8_t pad[3];
				uint32_t n;
				if (!take(s, pad, 3) || !u32(s, &n)) goto gone;
				size_t keep = n < CUT ? n : CUT;
				uint8_t *t = malloc(keep + 1);
				if (!take(s, t, keep) || !skip(s, n - keep)) {
					free(t);
					goto gone;
				}
				pthread_mutex_lock(&s->lock);
				free(s->cut);
				s->cut = utf8(t, keep);
				pthread_mutex_unlock(&s->lock);
				free(t);
				post(s);
			} else {
				why = formatString("a message this client does not know: %d", type);
				goto gone;
			}
		}
		// the update into the screen the host reads, then the host woken; the next asked for once it has taken this
		pthread_mutex_lock(&s->lock);
		if (s->fw != s->bw || s->fh != s->bh) {
			free(s->front);
			s->front = calloc((size_t)s->bw * (size_t)s->bh, 4);
			s->fw = s->bw, s->fh = s->bh;
			box = (Box){ 0, 0, s->bw, s->bh };
			s->sized = true;
		}
		for (int j = box.y; j < box.y + box.h; j++) memcpy(s->front + (size_t)j * s->fw + box.x, s->back + (size_t)j * s->bw + box.x, (size_t)box.w * 4);
		s->dirty = unite(s->dirty, box);
		s->frames++;
		if (!s->posted) {
			s->posted = true;
			ermosPost("{\"irq\": 66}");
		}
		while (s->posted && !s->stop) pthread_cond_wait(&s->cond, &s->lock);
		bool stop = s->stop;
		pthread_mutex_unlock(&s->lock);
		if (stop) break;
		whole = sized;
	}
gone:
	say(s, stopped(s) || !why ? "closed" : "failed", why);
	free(why);
	return NULL;
}

// --- the host's side

static Json *sessionAt(const char *name) {
	return drvPath("/", "dev", "vnc", "sessions", name, NULL);
}

static Json *layerAt(const char *name) {
	return drvPath("/", "dev", "display", "layers", name, NULL);
}

/** plane id's pixels, the view of a screen */
static bool planeAt(void *data, int64_t id, HostPlane *out) {
	Vnc *v = data;
	for (int i = 0; i < v->screens.count; i++) {
		Screen *s = v->screens.items[i];
		if (s->id == id && s->view) {
			*out = (HostPlane){ s->view, s->vw, s->vh, s->vw };
			return true;
		}
	}
	return false;
}

/** where the screen's picture is in the view: its scale, place and size */
static void place(Screen *s) {
	int fw = s->fw > 0 ? s->fw : 1, fh = s->fh > 0 ? s->fh : 1;
	if (s->fit) {
		double a = (double)s->vw / fw, b = (double)s->vh / fh;
		s->scale = a < b ? a : b;
		if (s->scale <= 0) s->scale = 1;
		s->ow = (int)(fw * s->scale + 0.5), s->oh = (int)(fh * s->scale + 0.5);
		if (s->ow > s->vw) s->ow = s->vw;
		if (s->oh > s->vh) s->oh = s->vh;
		s->ox = (s->vw - s->ow) / 2, s->oy = (s->vh - s->oh) / 2;
	} else {
		s->scale = 1;
		if (s->sx > fw - s->vw) s->sx = fw - s->vw;
		if (s->sy > fh - s->vh) s->sy = fh - s->vh;
		if (s->sx < 0) s->sx = 0;
		if (s->sy < 0) s->sy = 0;
		s->ow = fw - s->sx < s->vw ? fw - s->sx : s->vw, s->oh = fh - s->sy < s->vh ? fh - s->sy : s->vh;
		s->ox = fw < s->vw ? (s->vw - fw) / 2 : 0, s->oy = fh < s->vh ? (s->vh - fh) / 2 : 0;
	}
}

/**
 * the view's pixels in dest (the view's rectangle d, within the picture),
 * from front: each a box of the screen's, averaged by how much of it each
 * screen pixel covers (8-bit weights); 1:1 copied
 */
static void paint(Screen *s, Box d) {
	if (!s->front || !s->view) return;
	if (s->scale == 1 && !s->fit) {
		for (int j = d.y; j < d.y + d.h; j++)
			memcpy(s->view + (size_t)j * s->vw + d.x, s->front + (size_t)(j - s->oy + s->sy) * s->fw + (d.x - s->ox + s->sx), (size_t)d.w * 4);
		return;
	}
	double k = 1 / s->scale;
	int taps = (int)k + 2;
	int *x0 = malloc(sizeof(int) * (size_t)d.w), *wx = malloc(sizeof(int) * (size_t)d.w * (size_t)taps), *wy = malloc(sizeof(int) * (size_t)taps);
	// each column's first screen pixel and its weights, out of 256
	for (int i = 0; i < d.w; i++) {
		double a = (d.x + i - s->ox) * k, b = a + k;
		int first = (int)a;
		x0[i] = first;
		int total = 0;
		for (int t = 0; t < taps; t++) {
			double lo = first + t > a ? first + t : a, hi = first + t + 1 < b ? first + t + 1 : b;
			int wgt = hi > lo && first + t < s->fw ? (int)((hi - lo) / k * 256 + 0.5) : 0;
			wx[i * taps + t] = wgt;
			total += wgt;
		}
		// rounding put right on the first
		wx[i * taps] += 256 - total;
	}
	for (int j = 0; j < d.h; j++) {
		double a = (d.y + j - s->oy) * k, b = a + k;
		int first = (int)a, total = 0;
		for (int t = 0; t < taps; t++) {
			double lo = first + t > a ? first + t : a, hi = first + t + 1 < b ? first + t + 1 : b;
			wy[t] = hi > lo && first + t < s->fh ? (int)((hi - lo) / k * 256 + 0.5) : 0;
			total += wy[t];
		}
		wy[0] += 256 - total;
		uint32_t *o = s->view + (size_t)(d.y + j) * s->vw + d.x;
		for (int i = 0; i < d.w; i++) {
			uint32_t r = 0, g = 0, bl = 0;
			for (int ty = 0; ty < taps; ty++) {
				if (!wy[ty]) continue;
				int sy = first + ty < s->fh ? first + ty : s->fh - 1;
				const uint32_t *row = s->front + (size_t)sy * s->fw;
				for (int tx = 0; tx < taps; tx++) {
					int w = wx[i * taps + tx] * wy[ty];
					if (!w) continue;
					int sx = x0[i] + tx < s->fw ? x0[i] + tx : s->fw - 1;
					uint32_t c = row[sx];
					r += (c >> 16 & 255) * (uint32_t)w, g += (c >> 8 & 255) * (uint32_t)w, bl += (c & 255) * (uint32_t)w;
				}
			}
			o[i] = (r >> 16) << 16 | (g >> 16) << 8 | bl >> 16;
		}
	}
	free(x0);
	free(wx);
	free(wy);
}

/** the view of what changed in the screen (its pixels), as a rectangle of the view's, painted */
static Box redraw(Screen *s, Box changed) {
	Box d;
	if (s->fit) {
		int x0 = s->ox + (int)(changed.x * s->scale) - 1, y0 = s->oy + (int)(changed.y * s->scale) - 1;
		int x1 = s->ox + (int)((changed.x + changed.w) * s->scale + 0.999) + 1, y1 = s->oy + (int)((changed.y + changed.h) * s->scale + 0.999) + 1;
		d = (Box){ x0, y0, x1 - x0, y1 - y0 };
	} else d = (Box){ s->ox + changed.x - s->sx, s->oy + changed.y - s->sy, changed.w, changed.h };
	d = meet(d, (Box){ s->ox, s->oy, s->ow, s->oh });
	if (d.w) paint(s, d);
	return d;
}

/** the whole view: the ground, the picture */
static void again(Screen *s) {
	if (!s->view) return;
	for (size_t i = 0; i < (size_t)s->vw * (size_t)s->vh; i++) s->view[i] = s->ground;
	if (s->front) {
		place(s);
		paint(s, (Box){ s->ox, s->oy, s->ow, s->oh });
	}
}

/** the plane, said in the layer: dirty, or the whole of it */
static void show(const ErmGiven *g, Screen *s, const Box *dirty) {
	if (!s->layer || !s->view) return;
	Json *at = layerAt(s->layer);
	if (!drvHas(g->api, at)) return;
	if (s->hide || !s->ready) {
		if (s->shown) drvSet(g->api, at, "plane", jsonNull());
		s->shown = false;
		return;
	}
	s->serial++;
	Json *p = drvMap("source", jsonString("vnc"), "id", jsonInteger(s->id), "serial", jsonInteger(s->serial), "x", jsonInteger(s->x), "y", jsonInteger(s->y), "w",
	                 jsonInteger(s->vw), "h", jsonInteger(s->vh), NULL);
	if (dirty && s->shown) jsonAdd(p, "dirty", jsonRef(drvMap("x", jsonInteger(dirty->x), "y", jsonInteger(dirty->y), "w", jsonInteger(dirty->w), "h", jsonInteger(dirty->h), NULL)));
	drvSet(g->api, at, "plane", p);
	s->shown = true;
}

static const char LETTERS[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * the cursor as a picture, at the size it shows in the view: scaled by the
 * view's scale over the screen's unit (cursor.js draws a picture's pixel a
 * point); its colours, at most 62 letters, made coarser until they fit
 */
static Json *pictureOf(Vnc *v, Screen *s) {
	double f = s->scale / (v->unit > 0 ? v->unit : 1);
	int w = (int)(s->cw * f + 0.5), h = (int)(s->ch * f + 0.5);
	if (w < 1) w = 1;
	if (h < 1) h = 1;
	if (w > 64) w = 64;
	if (h > 64) h = 64;
	uint32_t masks[] = { 0xffffff, 0xf8f8f8, 0xf0f0f0, 0xe0e0e0, 0xc0c0c0 }, colours[62];
	int nc = 0;
	for (size_t m = 0; m < sizeof masks / sizeof *masks; m++) {
		nc = 0;
		bool fits = true;
		for (int j = 0; j < h && fits; j++)
			for (int i = 0; i < w && fits; i++) {
				int sx = (int)(i / f), sy = (int)(j / f);
				if (sx >= s->cw) sx = s->cw - 1;
				if (sy >= s->ch) sy = s->ch - 1;
				if (!(s->cmask[sy * ((s->cw + 7) / 8) + sx / 8] & (0x80 >> (sx & 7)))) continue;
				uint32_t c = s->cbits[sy * s->cw + sx] & masks[m];
				int k = 0;
				while (k < nc && colours[k] != c) k++;
				if (k == nc) {
					if (nc == 62) fits = false;
					else colours[nc++] = c;
				}
			}
		if (!fits) continue;
		Json *rows = jsonArray(), *map = jsonObject();
		char *row = malloc((size_t)w + 1);
		for (int j = 0; j < h; j++) {
			for (int i = 0; i < w; i++) {
				int sx = (int)(i / f), sy = (int)(j / f);
				if (sx >= s->cw) sx = s->cw - 1;
				if (sy >= s->ch) sy = s->ch - 1;
				row[i] = ' ';
				if (!(s->cmask[sy * ((s->cw + 7) / 8) + sx / 8] & (0x80 >> (sx & 7)))) continue;
				uint32_t c = s->cbits[sy * s->cw + sx] & masks[m];
				for (int k = 0; k < nc; k++)
					if (colours[k] == c) row[i] = LETTERS[k];
			}
			row[w] = 0;
			jsonPush(rows, jsonString(row));
		}
		free(row);
		for (int k = 0; k < nc; k++) {
			char l[2] = { LETTERS[k], 0 };
			jsonAdd(map, l, jsonInteger(colours[k]));
		}
		Json *hot = jsonArray();
		jsonPush(hot, jsonInteger((int64_t)(s->chx * f)));
		jsonPush(hot, jsonInteger((int64_t)(s->chy * f)));
		return drvMap("kind", jsonString("picture"), "colors", map, "rows", rows, "hot", hot, NULL);
	}
	return jsonNull();
}

static int keptOf(Vnc *v, const char *name) {
	for (int i = 0; i < 16; i++)
		if (v->kept[i].name && !strcmp(v->kept[i].name, name)) return i;
	return -1;
}

/** what the Mac's keychain knows a password by: user@host:port, or host:port */
static char *account(const Screen *s) {
	return s->user && *s->user ? formatString("%s@%s:%d", s->user, s->host, s->port) : formatString("%s:%d", s->host, s->port);
}

/** the keychain (the metal's): act "get", "set" (with the password) or "drop" */
static void keychain(Vnc *v, Screen *s, const char *act, const char *secret) {
	char *a = account(s);
	Json *c = drvMap("op", jsonString("keychain"), "act", jsonString(act), "account", jsonString(a), NULL);
	if (secret) jsonAdd(c, "password", jsonString(secret));
	hostCommand(v->host, c);
	free(a);
}

/** the keychain's answer, {event: "keychain", account, password}: to the connection waiting for it; none, the sheet asks */
static void answered(Vnc *v, const Json *r) {
	const char *a = jsonText(jsonGet(r, "account")), *secret = jsonText(jsonGet(r, "password"));
	for (int i = 0; a && i < v->screens.count; i++) {
		Screen *s = v->screens.items[i];
		char *mine = account(s);
		bool it = s->seeking && !strcmp(mine, a);
		free(mine);
		if (!it) continue;
		s->seeking = false;
		if (!secret) continue;
		pthread_mutex_lock(&s->lock);
		wipe(s->secret);
		s->secret = copyString(secret);
		s->keyed = true;
		pthread_cond_broadcast(&s->cond);
		pthread_mutex_unlock(&s->lock);
	}
}

static const char *keysymName(uint32_t k) {
	switch (k) {
	case 0xffe7: return "Meta_L";
	case 0xffe9: return "Alt_L";
	case 0xffeb: return "Super_L";
	case 0xffed: return "Hyper_L";
	case 0xffe3: return "Control_L";
	default: return "?";
	}
}

static uint32_t keysymOf(const char *name) {
	if (!name) return 0;
	const struct {
		const char *name;
		uint32_t sym;
	} table[] = { { "Meta_L", 0xffe7 }, { "Alt_L", 0xffe9 }, { "Super_L", 0xffeb }, { "Hyper_L", 0xffed }, { "Control_L", 0xffe3 } };
	for (size_t i = 0; i < sizeof table / sizeof *table; i++)
		if (!strcmp(table[i].name, name)) return table[i].sym;
	return 0;
}

static uint32_t cmdOf(const Screen *s, bool mac) {
	return s->cmd ? s->cmd : mac ? 0xffe9 : 0xffeb;
}

static uint32_t altOf(const Screen *s, bool mac) {
	return s->alt ? s->alt : mac ? 0xffe7 : 0xffe9;
}

/** the session node's value: what the thread says, and the view's place */
static Json *told(Vnc *v, Screen *s, bool counts) {
	(void)v;
	pthread_mutex_lock(&s->lock);
	char version[16] = "";
	if (s->minor) snprintf(version, sizeof version, "3.%d", s->minor);
	if (counts) s->tf = s->frames, s->tb = s->bytes;
	// the keychain asked: securing still, the sheet not opened for a password it may have
	const char *state = s->seeking ? "securing" : s->state;
	Json *o = drvMap("state", jsonString(state), "error", s->error ? jsonString(s->error) : jsonNull(), "want", s->want && !strcmp(state, "password") ? jsonString(s->want) : jsonNull(),
	                 "host", jsonString(s->host), "port", jsonInteger(s->port), "version", *version ? jsonString(version) : jsonNull(), "security",
	                 s->security ? jsonString(s->security) : jsonNull(), "desktop", s->desktop ? jsonString(s->desktop) : jsonNull(), "w", jsonInteger(s->fw), "h",
	                 jsonInteger(s->fh), "encoding", s->encoding ? jsonString(s->encoding) : jsonNull(), "frames", jsonInteger(s->tf), "bytes", jsonInteger(s->tb),
	                 "mac", jsonBoolean(s->mac), NULL);
	bool mac = s->mac;
	pthread_mutex_unlock(&s->lock);
	jsonAdd(o, "scale", jsonNumber((double)(int)(s->scale * 1000 + 0.5) / 1000));
	jsonAdd(o, "x", jsonInteger(s->ox));
	jsonAdd(o, "y", jsonInteger(s->oy));
	jsonAdd(o, "keys", jsonRef(drvMap("cmd", jsonString(keysymName(cmdOf(s, mac))), "alt", jsonString(keysymName(altOf(s, mac))), NULL)));
	return o;
}

/** the session node: its state as it changes; frames and bytes once a second */
static void report(const ErmGiven *g, Vnc *v, Screen *s, int64_t now) {
	if (!s->placed) return;
	bool counts = now - s->told >= 1000000;
	Json *value = told(v, s, counts);
	char *text = jsonPrint(value);
	if (!s->said || strcmp(s->said, text)) {
		drvSnap(g->api, sessionAt(s->name), value);
		free(s->said);
		s->said = text;
		if (counts) s->told = now;
	} else free(text);
}

/** irq 66: each connection's news: the session node, the plane, the cursor, the clipboard; then each thread let go on */
static ErmErr vncIrq(void *data, const ErmGiven *g, Json **out) {
	Vnc *v = data;
	*out = jsonNull();
	int64_t now = hostNow(v->host);
	const Json *records = g->args && g->args->array.count ? g->args->array.items[0] : NULL;
	for (int i = 0; jsonIsArray(records) && i < records->array.count; i++) {
		const char *e = jsonText(jsonGet(records->array.items[i], "event"));
		if (e && !strcmp(e, "keychain")) answered(v, records->array.items[i]);
	}
	for (int i = 0; i < v->screens.count; i++) {
		Screen *s = v->screens.items[i];
		pthread_mutex_lock(&s->lock);
		// a password wanted, and the view remembers one: the keychain asked first (a user too, it knows not)
		bool look = s->asked && s->remember && !s->sought && (!s->want || strcmp(s->want, "user") || (s->user && *s->user));
		bool on = !strcmp(s->state, "live");
		Box dirty = s->dirty;
		bool sized = s->sized, cursed = s->cursed, first = !s->placed;
		char *cut = s->cut;
		s->dirty = (Box){ 0 }, s->sized = false, s->cursed = false, s->cut = NULL;
		if (sized) dirty = (Box){ 0 };
		// the view drawn from front while the thread waits (or decodes into back, which is its own)
		Box drawn = { 0 };
		bool all = s->front && (sized || s->whole);
		s->ready = s->front != NULL;
		if (all) again(s);
		else if (s->front && dirty.w) drawn = redraw(s, dirty);
		// the cursor, at the view's scale: again when it or the scale changed
		Json *picture = NULL;
		if (s->cbits && (cursed || s->cmade != (int)(s->scale * 1000))) {
			picture = pictureOf(v, s);
			s->cmade = (int)(s->scale * 1000);
		}
		pthread_mutex_unlock(&s->lock);
		if (look) {
			s->sought = s->seeking = true;
			keychain(v, s, "get", NULL);
		}
		if (first) {
			char *id = formatString("vnc/sessions/%s.%d", s->name, s->k);
			drvMake(g->api, drvPath("/", "dev", "vnc", "sessions", NULL), s->name, id, told(v, s, true));
			free(id);
			s->placed = true;
			s->told = now;
		}
		if (all) {
			show(g, s, NULL);
			s->whole = false;
		} else if (drawn.w) show(g, s, &drawn);
		if (picture) {
			Json *at = drvUnder(sessionAt(s->name), "cursor", NULL), *p = picture;
			if (drvHas(g->api, at)) drvSnap(g->api, at, p);
			else {
				char *id = formatString("vnc/sessions/%s.%d/cursor", s->name, s->k);
				drvMake(g->api, sessionAt(s->name), "cursor", id, p);
				free(id);
			}
		}
		if (cut) {
			Json *was = drvRead(g->api, drvPath("/", "dev", "clip", "text", NULL));
			drvSnap(g->api, drvPath("/", "dev", "clip", "text", NULL), drvMap("text", jsonString(cut), "count", jsonInteger(jsonIsNumber(jsonGet(was, "count")) ? (int64_t)jsonGet(was, "count")->number : 0), "from", jsonString("vnc"), NULL));
			free(cut);
		}
		// live: a password typed for a view that remembers, kept in the keychain; one that no longer does, taken out
		if (on && !s->filed) {
			s->filed = true;
			int k = keptOf(v, s->name);
			if (s->remember && !s->keyed && k >= 0 && v->kept[k].secret && *v->kept[k].secret) keychain(v, s, "set", v->kept[k].secret);
			else if (s->unremember) keychain(v, s, "drop", NULL);
		}
		report(g, v, s, now);
		pthread_mutex_lock(&s->lock);
		s->posted = false;
		pthread_cond_broadcast(&s->cond);
		pthread_mutex_unlock(&s->lock);
	}
	return ermOk();
}

// --- starting and stopping a connection

static void forget(Vnc *v, const char *name) {
	int k = keptOf(v, name);
	if (k < 0) return;
	free(v->kept[k].name);
	wipe(v->kept[k].secret);
	free(v->kept[k].user);
	v->kept[k].name = v->kept[k].secret = v->kept[k].user = NULL;
}

static void stop(const ErmGiven *g, Screen *s) {
	pthread_mutex_lock(&s->lock);
	s->stop = true;
	pthread_cond_broadcast(&s->cond);
	pthread_mutex_unlock(&s->lock);
	pthread_mutex_lock(&s->out);
	if (s->fd >= 0) shutdown(s->fd, SHUT_RDWR);
	pthread_mutex_unlock(&s->out);
	pthread_join(s->thread, NULL);
	pthread_mutex_lock(&s->out);
	if (s->fd >= 0) close(s->fd);
	s->fd = -1;
	pthread_mutex_unlock(&s->out);
	if (g) {
		if (s->layer && s->shown && drvHas(g->api, layerAt(s->layer))) drvSet(g->api, layerAt(s->layer), "plane", jsonNull());
		if (s->placed) {
			Json *at = sessionAt(s->name);
			if (drvHas(g->api, drvUnder(at, "cursor", NULL))) {
				char *id = formatString("vnc/sessions/%s.%d/cursor", s->name, s->k);
				drvOp(g->api, "unplace", drvMap("address", at, "name", jsonString("cursor"), "id", jsonString(id), NULL));
				free(id);
			}
			char *id = formatString("vnc/sessions/%s.%d", s->name, s->k);
			drvOp(g->api, "unplace", drvMap("address", drvPath("/", "dev", "vnc", "sessions", NULL), "name", jsonString(s->name), "id", jsonString(id), NULL));
			free(id);
		}
	}
	if (s->zrleOn) inflateEnd(&s->zrle);
	if (s->zlibOn) inflateEnd(&s->zlib);
	wipe(s->secret);
	free(s->name);
	free(s->host);
	free(s->user);
	free(s->layer);
	free(s->front);
	free(s->back);
	free(s->view);
	free(s->buf);
	free(s->cbits);
	free(s->cmask);
	free(s->cut);
	free(s->error);
	free(s->desktop);
	free(s->want);
	free(s->said);
	free(s);
}

static void start(Vnc *v, Screen *s) {
	s->fd = -1;
	snprintf(s->state, sizeof s->state, "connecting");
	pthread_mutex_init(&s->lock, NULL);
	pthread_cond_init(&s->cond, NULL);
	pthread_mutex_init(&s->out, NULL);
	s->id = ++v->ids;
	s->k = ++v->ks;
	int k = keptOf(v, s->name);
	if (k >= 0) {
		s->secret = copyString(v->kept[k].secret);
		if (v->kept[k].user && *v->kept[k].user) {
			free(s->user);
			s->user = copyString(v->kept[k].user);
		}
	}
	s->whole = true;
	pthread_create(&s->thread, NULL, talk, s);
}

/** the views asked for: each name and value, read tracked */
static ErmErr viewsCompute(void *data, const ErmGiven *g, Json **out) {
	(void)data;
	Json *names = drvNames(g->api, drvPath("/", "dev", "vnc", "views", NULL));
	*out = jsonArray();
	for (int i = 0; names && i < names->array.count; i++) {
		const char *name = jsonText(names->array.items[i]);
		Json *value = drvRead(g->api, drvPath("/", "dev", "vnc", "views", name, NULL));
		if (jsonIsObject(value)) jsonPush(*out, jsonRef(drvMap("name", jsonString(name), "value", jsonShallow(value), NULL)));
	}
	return ermOk();
}

static int64_t whole(const Json *v, int64_t otherwise) {
	int64_t n;
	if (jsonIsWhole(v, &n)) return n;
	if (jsonIsNumber(v)) return (int64_t)v->number;
	return otherwise;
}

/** each view: a connection made (again, for a new n or another address), its view's place followed; one gone, closed */
static ErmErr viewsEffect(void *data, const ErmGiven *g, Json **out) {
	Vnc *v = data;
	*out = jsonNull();
	const Json *list = g->value;
	int k = 0;
	for (int i = 0; i < v->screens.count; i++) {
		Screen *s = v->screens.items[i];
		const Json *view = NULL;
		for (int n = 0; jsonIsArray(list) && n < list->array.count && !view; n++)
			if (!strcmp(jsonText(jsonGet(list->array.items[n], "name")), s->name)) view = jsonGet(list->array.items[n], "value");
		// the user is read as a connection starts: a new one, a new n
		const char *host = jsonText(jsonGet(view, "host"));
		bool same = view && host && !strcmp(host, s->host) && whole(jsonGet(view, "port"), 5900) == s->port && whole(jsonGet(view, "n"), 0) == s->n;
		if (same) {
			v->screens.items[k++] = s;
			continue;
		}
		if (!view) forget(v, s->name);
		stop(g, s);
	}
	v->screens.count = k;
	for (int n = 0; jsonIsArray(list) && n < list->array.count; n++) {
		const char *name = jsonText(jsonGet(list->array.items[n], "name"));
		const Json *view = jsonGet(list->array.items[n], "value");
		Screen *s = NULL;
		for (int i = 0; i < v->screens.count && !s; i++)
			if (!strcmp(v->screens.items[i]->name, name)) s = v->screens.items[i];
		const char *host = jsonText(jsonGet(view, "host"));
		if (!s) {
			if (!host || !*host) continue;
			s = calloc(1, sizeof *s);
			s->name = copyString(name);
			s->host = copyString(host);
			s->port = (int)whole(jsonGet(view, "port"), 5900);
			s->user = copyString(jsonText(jsonGet(view, "user")) ? jsonText(jsonGet(view, "user")) : "");
			s->n = whole(jsonGet(view, "n"), 0);
			s->fit = true;
			start(v, s);
			push(v, s);
		}
		// the view's place, its scaling, its scroll: drawn whole again when any changes
		const char *layer = jsonText(jsonGet(view, "layer"));
		int vw = (int)whole(jsonGet(view, "w"), 0), vh = (int)whole(jsonGet(view, "h"), 0);
		if (vw < 1 || vw > MOST) vw = vw < 1 ? 1 : MOST;
		if (vh < 1 || vh > MOST) vh = vh < 1 ? 1 : MOST;
		const char *mode = jsonText(jsonGet(view, "view"));
		bool fit = !mode || strcmp(mode, "actual");
		Json *hide = jsonGet(view, "hide"), *keys = jsonGet(view, "keys");
		bool hidden = hide && hide->type == JSON_BOOLEAN && hide->boolean;
		uint32_t ground = (uint32_t)whole(jsonGet(view, "ground"), 0x1c1a17) & 0xffffff;
		int x = (int)whole(jsonGet(view, "x"), 0), y = (int)whole(jsonGet(view, "y"), 0), sx = (int)whole(jsonGet(view, "sx"), 0), sy = (int)whole(jsonGet(view, "sy"), 0);
		Json *remember = jsonGet(view, "remember");
		s->remember = remember && remember->type == JSON_BOOLEAN && remember->boolean;
		s->unremember = remember && remember->type == JSON_BOOLEAN && !remember->boolean;
		s->cmd = keysymOf(jsonText(jsonGet(keys, "cmd")));
		s->alt = keysymOf(jsonText(jsonGet(keys, "alt")));
		bool moved = !s->layer || !layer || strcmp(s->layer, layer) || vw != s->vw || vh != s->vh || fit != s->fit || ground != s->ground || x != s->x || y != s->y ||
		             (!fit && (sx != s->sx || sy != s->sy)) || hidden != s->hide;
		if (!moved) continue;
		if (s->layer && layer && strcmp(s->layer, layer) && s->shown && drvHas(g->api, layerAt(s->layer))) drvSet(g->api, layerAt(s->layer), "plane", jsonNull());
		free(s->layer);
		s->layer = layer ? copyString(layer) : NULL;
		pthread_mutex_lock(&s->lock);
		if (vw != s->vw || vh != s->vh) {
			free(s->view);
			s->view = calloc((size_t)vw * (size_t)vh, 4);
			s->vw = vw, s->vh = vh;
			if (layer) s->shown = false;
		}
		s->fit = fit, s->ground = ground, s->x = x, s->y = y, s->sx = sx, s->sy = sy, s->hide = hidden;
		place(s);
		again(s);
		pthread_mutex_unlock(&s->lock);
		show(g, s, NULL);
		// its scale and place, said
		report(g, v, s, hostNow(v->host));
	}
	return ermOk();
}

// --- input

static Screen *screenOf(Vnc *v, const char *name) {
	for (int i = 0; name && i < v->screens.count; i++)
		if (!strcmp(v->screens.items[i]->name, name)) return v->screens.items[i];
	return NULL;
}

static bool live(Screen *s) {
	pthread_mutex_lock(&s->lock);
	bool on = !strcmp(s->state, "live");
	pthread_mutex_unlock(&s->lock);
	return on;
}

static void key(Screen *s, uint32_t sym, bool down) {
	uint8_t m[8] = { 4, down };
	be32(m + 4, sym);
	put(s, m, sizeof m);
}

static void pointer(Screen *s, int mask) {
	uint8_t m[6] = { 5, (uint8_t)mask };
	be16(m + 2, (unsigned)s->px);
	be16(m + 4, (unsigned)s->py);
	put(s, m, sizeof m);
}

/** keysyms of keys by name (Keys.swift's names, places on a US keyboard) */
static uint32_t special(const char *key, int64_t code, bool right, const Screen *s, bool mac) {
	// the keypad, by the Mac's code: its keys' names are the keys they type
	const int64_t pad[][2] = { { 0x52, 0xffb0 }, { 0x53, 0xffb1 }, { 0x54, 0xffb2 }, { 0x55, 0xffb3 }, { 0x56, 0xffb4 }, { 0x57, 0xffb5 }, { 0x58, 0xffb6 },
		                       { 0x59, 0xffb7 }, { 0x5B, 0xffb8 }, { 0x5C, 0xffb9 }, { 0x41, 0xffae }, { 0x43, 0xffaa }, { 0x45, 0xffab }, { 0x4B, 0xffaf },
		                       { 0x4E, 0xffad }, { 0x51, 0xffbd }, { 0x4C, 0xff8d }, { 0x47, 0xff0b } };
	for (size_t i = 0; code > 0 && i < sizeof pad / sizeof *pad; i++)
		if (pad[i][0] == code) return (uint32_t)pad[i][1];
	const struct {
		const char *name;
		uint32_t sym;
	} table[] = { { "Enter", 0xff0d }, { "Tab", 0xff09 }, { "Space", 0x20 }, { "Backspace", 0xff08 }, { "Escape", 0xff1b }, { "Delete", 0xffff },
		          { "Help", 0xff63 }, { "ArrowUp", 0xff52 }, { "ArrowDown", 0xff54 }, { "ArrowLeft", 0xff51 }, { "ArrowRight", 0xff53 }, { "Home", 0xff50 },
		          { "End", 0xff57 }, { "PageUp", 0xff55 }, { "PageDown", 0xff56 }, { "Clear", 0xff0b }, { "ContextMenu", 0xff67 } };
	for (size_t i = 0; i < sizeof table / sizeof *table; i++)
		if (!strcmp(table[i].name, key)) return table[i].sym;
	if (key[0] == 'F' && key[1] >= '1' && key[1] <= '9') {
		int n = atoi(key + 1);
		if (n >= 1 && n <= 35) return 0xffbe + (uint32_t)(n - 1);
	}
	// modifiers: their right ones by the Mac's code
	if (!strcmp(key, "Shift")) return right ? 0xffe2 : 0xffe1;
	if (!strcmp(key, "Control")) return right ? 0xffe4 : 0xffe3;
	if (!strcmp(key, "Meta")) return cmdOf(s, mac) + (right ? 1 : 0);
	if (!strcmp(key, "Alt")) return altOf(s, mac) + (right ? 1 : 0);
	return 0;
}

/** the next code point of UTF-8 text, at *i */
static uint32_t next(const char *t, size_t *i) {
	const unsigned char *u = (const unsigned char *)t + *i;
	uint32_t c = u[0];
	int n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
	if (n > 1) c &= 0xFF >> (n + 1);
	for (int k = 1; k < n; k++) {
		if ((u[k] & 0xC0) != 0x80) {
			*i += k;
			return 0xFFFD;
		}
		c = c << 6 | (u[k] & 63);
	}
	*i += n;
	return c;
}

static uint32_t symOfChar(uint32_t c) {
	return c < 0x100 ? c : 0x01000000 | c;
}

static bool modded(const Json *mods, const char *m) {
	for (int i = 0; jsonIsArray(mods) && i < mods->array.count; i++)
		if (!strcmp(jsonText(mods->array.items[i]) ? jsonText(mods->array.items[i]) : "", m)) return true;
	return false;
}

static void keyRecord(Screen *s, const Json *r) {
	const char *name = jsonText(jsonGet(r, "key")), *text = jsonText(jsonGet(r, "text"));
	Json *dn = jsonGet(r, "down");
	bool down = dn && dn->type == JSON_BOOLEAN && dn->boolean;
	int64_t code = whole(jsonGet(r, "code"), -1);
	if (!name) return;
	pthread_mutex_lock(&s->lock);
	bool mac = s->mac;
	pthread_mutex_unlock(&s->lock);
	char id[24];
	snprintf(id, sizeof id, "%lld:%.15s", (long long)code, name);
	if (!down) {
		for (int i = 0; i < HELD; i++)
			if (s->held[i].sym && !strcmp(s->held[i].key, id)) {
				key(s, s->held[i].sym, false);
				s->held[i].sym = 0;
			}
		return;
	}
	bool right = code == 0x3C || code == 0x3E || code == 0x3D || code == 0x36;
	uint32_t sym = special(name, code, right, s, mac);
	if (!sym && strcmp(name, "CapsLock") && strcmp(name, "Fn") && strcmp(name, "Unidentified")) {
		const Json *mods = jsonGet(r, "mods");
		bool plain = !modded(mods, "cmd") && !modded(mods, "ctrl") && !modded(mods, "alt");
		size_t i = 0;
		uint32_t typed = text && *text ? next(text, &i) : 0;
		if (plain && typed >= 0x20 && !(typed >= 0xF700 && typed <= 0xF8FF) && text && !text[i]) sym = symOfChar(typed);
		else {
			// the key's place on a US keyboard, shifted as a US keyboard shifts it
			size_t j = 0;
			uint32_t c = next(name, &j);
			if (!name[j]) {
				static const char from[] = "1234567890-=[]\\;',./`", to[] = "!@#$%^&*()_+{}|:\"<>?~";
				if (modded(mods, "shift")) {
					if (c >= 'a' && c <= 'z') c -= 32;
					else if (c < 0x80 && strchr(from, (int)c)) c = (uint32_t)(unsigned char)to[strchr(from, (int)c) - from];
				}
				sym = symOfChar(c);
			}
		}
	}
	if (!sym) return;
	// a repeat: the same keysym down again, with no up
	int slot = -1;
	for (int i = 0; i < HELD; i++) {
		if (s->held[i].sym && !strcmp(s->held[i].key, id)) slot = -2;
		if (slot == -1 && !s->held[i].sym) slot = i;
	}
	if (slot >= 0) {
		snprintf(s->held[slot].key, sizeof s->held[slot].key, "%s", id);
		s->held[slot].sym = sym;
	}
	key(s, sym, true);
}

/** every key held let go, as when the window loses the keyboard */
static void release(Screen *s) {
	for (int i = 0; i < HELD; i++)
		if (s->held[i].sym) {
			key(s, s->held[i].sym, false);
			s->held[i].sym = 0;
		}
}

/** a point in the layer as the other side's pixel; false off the picture */
static bool at(Screen *s, const Json *r) {
	Json *x = jsonGet(r, "x"), *y = jsonGet(r, "y");
	if (!jsonIsNumber(x) || !jsonIsNumber(y)) return false;
	double vx = x->number - s->x - s->ox, vy = y->number - s->y - s->oy;
	double rx = s->fit ? vx / s->scale : vx + s->sx, ry = s->fit ? vy / s->scale : vy + s->sy;
	pthread_mutex_lock(&s->lock);
	int fw = s->fw, fh = s->fh;
	pthread_mutex_unlock(&s->lock);
	bool in = rx >= 0 && ry >= 0 && rx < fw && ry < fh;
	s->px = rx < 0 ? 0 : rx >= fw ? fw - 1 : (int)rx;
	s->py = ry < 0 ? 0 : ry >= fh ? fh - 1 : (int)ry;
	return in;
}

static void chord(Vnc *v, Screen *s, const Json *keys) {
	(void)v;
	pthread_mutex_lock(&s->lock);
	bool mac = s->mac;
	pthread_mutex_unlock(&s->lock);
	uint32_t syms[8];
	int n = 0;
	for (int i = 0; jsonIsArray(keys) && i < keys->array.count && n < 8; i++) {
		const char *k = jsonText(keys->array.items[i]);
		if (!k) continue;
		uint32_t sym = !strcmp(k, "cmd") ? cmdOf(s, mac) : !strcmp(k, "alt") ? altOf(s, mac) : !strcmp(k, "ctrl") ? 0xffe3 : !strcmp(k, "shift") ? 0xffe1 : special(k, -1, false, s, mac);
		if (!sym) {
			size_t j = 0;
			uint32_t c = next(k, &j);
			if (!k[j]) sym = symOfChar(c);
		}
		if (sym) syms[n++] = sym;
	}
	for (int i = 0; i < n; i++) key(s, syms[i], true);
	for (int i = n - 1; i >= 0; i--) key(s, syms[i], false);
}

/** text sent as the other side's clipboard: Latin-1, a character beyond it a ? */
static void clip(Screen *s, const char *text) {
	size_t n = strlen(text), i = 0, k = 0;
	uint8_t *m = malloc(8 + (n < CUT ? n : CUT));
	while (text[i] && k < CUT) {
		uint32_t c = next(text, &i);
		m[8 + k++] = c < 0x100 ? (uint8_t)c : '?';
	}
	m[0] = 6, m[1] = m[2] = m[3] = 0;
	be32(m + 4, (uint32_t)k);
	put(s, m, 8 + k);
	free(m);
}

/** on/input (name, events): what the window is given, to the other side */
static ErmErr onInput(void *data, const ErmGiven *g, Json **out) {
	Vnc *v = data;
	*out = jsonNull();
	const char *name = g->args && g->args->array.count > 0 ? jsonText(g->args->array.items[0]) : NULL;
	Json *events = g->args && g->args->array.count > 1 ? g->args->array.items[1] : NULL;
	Screen *s = screenOf(v, name);
	if (!s || !live(s)) return ermOk();
	for (int i = 0; jsonIsArray(events) && i < events->array.count; i++) {
		Json *r = events->array.items[i];
		const char *e = jsonText(jsonGet(r, "event"));
		if (!e) continue;
		if (!strcmp(e, "key")) keyRecord(s, r);
		else if (!strcmp(e, "commit")) {
			const char *t = jsonText(jsonGet(r, "text"));
			for (size_t k = 0; t && t[k];) {
				uint32_t sym = symOfChar(next(t, &k));
				key(s, sym, true);
				key(s, sym, false);
			}
		} else if (!strcmp(e, "release")) {
			release(s);
			if (s->buttons) {
				s->buttons = 0;
				pointer(s, 0);
			}
		} else if (!strcmp(e, "chord")) chord(v, s, jsonGet(r, "keys"));
		else if (!strcmp(e, "clip")) {
			const char *t = jsonText(jsonGet(r, "text"));
			if (t) clip(s, t);
		} else if (!strcmp(e, "move") || !strcmp(e, "down") || !strcmp(e, "up")) {
			at(s, r);
			int64_t b = whole(jsonGet(r, "button"), 0);
			int bit = b == 1 ? 4 : b == 2 ? 2 : 1; // the metal's 0 left, 1 right, 2 other; RFB's 1 left, 2 middle, 4 right
			if (!strcmp(e, "down")) s->buttons |= bit;
			if (!strcmp(e, "up")) s->buttons &= ~bit;
			pointer(s, s->buttons);
		} else if (!strcmp(e, "scroll")) {
			at(s, r);
			Json *dx = jsonGet(r, "dx"), *dy = jsonGet(r, "dy");
			// a notch a twelve points of the trackpad's pixels: up and down 4 and 5, left and right 6 and 7
			double step = 12.0 * (v->unit > 0 ? v->unit : 1);
			s->wheel += jsonIsNumber(dy) ? dy->number : 0;
			s->wheelx += jsonIsNumber(dx) ? dx->number : 0;
			for (int k = 0; k < 10 && (s->wheel >= step || s->wheel <= -step); k++) {
				int bit = s->wheel > 0 ? 16 : 8;
				s->wheel += s->wheel > 0 ? -step : step;
				pointer(s, s->buttons | bit);
				pointer(s, s->buttons);
			}
			for (int k = 0; k < 10 && (s->wheelx >= step || s->wheelx <= -step); k++) {
				int bit = s->wheelx > 0 ? 64 : 32;
				s->wheelx += s->wheelx > 0 ? -step : step;
				pointer(s, s->buttons | bit);
				pointer(s, s->buttons);
			}
			if (s->wheel >= step || s->wheel <= -step) s->wheel = 0;
			if (s->wheelx >= step || s->wheelx <= -step) s->wheelx = 0;
		}
	}
	return ermOk();
}

/** on/password (name, password, user?): held for the view, and given to its connection if it waits */
static ErmErr onPassword(void *data, const ErmGiven *g, Json **out) {
	Vnc *v = data;
	*out = jsonNull();
	const char *name = g->args && g->args->array.count > 0 ? jsonText(g->args->array.items[0]) : NULL;
	const char *secret = g->args && g->args->array.count > 1 ? jsonText(g->args->array.items[1]) : NULL;
	const char *user = g->args && g->args->array.count > 2 ? jsonText(g->args->array.items[2]) : NULL;
	if (!name || !secret) return ermDetail(ermInvalid("bad"), "text", jsonString("password takes a view's name and its password"));
	int k = keptOf(v, name);
	if (k < 0)
		for (int i = 0; i < 16 && k < 0; i++)
			if (!v->kept[i].name) k = i;
	if (k < 0) k = 0, forget(v, v->kept[0].name);
	if (!v->kept[k].name) v->kept[k].name = copyString(name);
	wipe(v->kept[k].secret);
	free(v->kept[k].user);
	v->kept[k].secret = copyString(secret);
	v->kept[k].user = user && *user ? copyString(user) : NULL;
	Screen *s = screenOf(v, name);
	if (s) {
		pthread_mutex_lock(&s->lock);
		wipe(s->secret);
		s->secret = copyString(secret);
		if (user && *user) {
			free(s->user);
			s->user = copyString(user);
		}
		pthread_cond_broadcast(&s->cond);
		pthread_mutex_unlock(&s->lock);
	}
	return ermOk();
}

ErmErr driverVnc(void *data, const ErmGiven *g, Json **out) {
	*out = jsonNull();
	Vnc *v = calloc(1, sizeof *v);
	v->host = data;
	the = v;
	Json *mode = drvRead(g->api, drvPath("/", "dev", "display", "mode", NULL));
	v->unit = (int)whole(jsonGet(mode, "unit"), 1);
	Json *dev = drvPath("/", "dev", "vnc", NULL);
	drvMake(g->api, dev, "views", "vnc/views", jsonNull());
	drvMake(g->api, dev, "sessions", "vnc/sessions", jsonNull());
	Json *here = drvHere(g);
	drvHandler(g, here, "irq", (ErmFn){ vncIrq, v });
	drvHandler(g, here, "input", (ErmFn){ onInput, v });
	drvHandler(g, here, "password", (ErmFn){ onPassword, v });
	drvClaim(g, here, IRQ);
	drvChild(g, here, "views", (ErmFn){ viewsCompute, NULL }, (ErmFn){ viewsEffect, v });
	hostPlanes(v->host, "vnc", planeAt, v);
	return ermOk();
}

void vncStop(void) {
	if (!the) return;
	for (int i = 0; i < the->screens.count; i++) stop(NULL, the->screens.items[i]);
	the->screens.count = 0;
}
