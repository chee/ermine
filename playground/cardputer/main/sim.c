// the firmware's programs on the Mac: stdin is the keyboard (a line: its keys, then enter; a line
// "tab": the tab key, yes to a pair ask; "esc": no; "print": the den's state), the screen is
// printed, and the framebuffer written as a PNG (/tmp/dens/card/sim.png, and numbered beside it).
// the den is the cardputer's (den.h) on tippet, its install and log in SIM_HOME
// (/tmp/cardputer-sim), linked to SIM_SERVER's room (https://galaxy.observer; "none": alone) by
// poll.h's long-poll, its two workers threads with curl. ./sim.sh builds and runs it.
//
//   SIM_ROOM=KAYA ./sim.sh          the den in room KAYA on galaxy.observer, typing into it
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <curl/curl.h>
#include <malloc/malloc.h>

#include "core/ed25519/c/ed25519.h"
int64_t now_ms(void);
#include "core/changeable/c/json.h"
#include "den.h"
#include "drivers.h"
#include "fb.h"
#include "host.h"
#include "poll.h"
#include "shell.h"
#include "things.h"
#include "menu.h"

static int quiet;
static char home[200];

void show(const op_value *screen) {
	if (quiet) return;
	const op_value *lines = op_get(screen, "lines"), *prompt = op_get(screen, "prompt");
	printf("+------------------------------+\n|%-30s|\n", "ermine");
	for (size_t i = 0; lines && i < lines->count; i++) printf("|%-30.30s|\n", lines->items[i]->str);
	printf("|> %-28.28s|\n+------------------------------+\n", prompt ? prompt->str : "");
}

// a PNG, no compression (stored deflate blocks) ----------------------------------------------------

static unsigned long crc_table[256];
static unsigned long crc(unsigned long c, const unsigned char *b, size_t n) {
	if (!crc_table[1])
		for (unsigned long k = 0; k < 256; k++) {
			unsigned long x = k;
			for (int j = 0; j < 8; j++) x = x & 1 ? 0xedb88320UL ^ (x >> 1) : x >> 1;
			crc_table[k] = x;
		}
	c ^= 0xffffffffUL;
	for (size_t i = 0; i < n; i++) c = crc_table[(c ^ b[i]) & 0xff] ^ (c >> 8);
	return c ^ 0xffffffffUL;
}
static void be32(unsigned char *p, unsigned long v) {
	p[0] = (unsigned char)(v >> 24), p[1] = (unsigned char)(v >> 16), p[2] = (unsigned char)(v >> 8);
	p[3] = (unsigned char)v;
}
static void chunk(FILE *f, const char *type, const unsigned char *data, size_t n) {
	unsigned char len[4], c[4];
	be32(len, (unsigned long)n);
	fwrite(len, 1, 4, f);
	unsigned char *both = malloc(n + 4);
	memcpy(both, type, 4);
	if (n) memcpy(both + 4, data, n);
	fwrite(both, 1, n + 4, f);
	be32(c, crc(0, both, n + 4));
	fwrite(c, 1, 4, f);
	free(both);
}

// the whole screen, a colour a byte, put together strip by strip as the Cardputer sends them
static uint8_t full[FB_W * FB_H];

// the screen, each pixel 3x3 (so it can be looked at)
#define ZOOM 3
static void png(const char *path) {
	int w = FB_W * ZOOM, h = FB_H * ZOOM;
	size_t row = 1 + (size_t)w * 3, raw_n = row * (size_t)h;
	unsigned char *raw = malloc(raw_n);
	for (int y = 0; y < h; y++) {
		unsigned char *r = raw + (size_t)y * row;
		r[0] = 0;
		for (int x = 0; x < w; x++) memcpy(r + 1 + x * 3, fb_rgb[full[(y / ZOOM) * FB_W + x / ZOOM]], 3);
	}
	size_t blocks = (raw_n + 65534) / 65535;
	size_t zn = 2 + raw_n + blocks * 5 + 4;
	unsigned char *z = malloc(zn), *p = z;
	*p++ = 0x78, *p++ = 0x01;
	unsigned long a = 1, b = 0;
	for (size_t i = 0; i < raw_n; i++) a = (a + raw[i]) % 65521, b = (b + a) % 65521;
	for (size_t off = 0; off < raw_n; off += 65535) {
		size_t n = raw_n - off < 65535 ? raw_n - off : 65535;
		*p++ = off + n == raw_n ? 1 : 0;
		*p++ = (unsigned char)n, *p++ = (unsigned char)(n >> 8);
		*p++ = (unsigned char)~n, *p++ = (unsigned char)(~n >> 8);
		memcpy(p, raw + off, n);
		p += n;
	}
	be32(p, b << 16 | a);
	FILE *f = fopen(path, "wb");
	if (f != NULL) {
		fwrite("\x89PNG\r\n\x1a\n", 1, 8, f);
		unsigned char ihdr[13];
		be32(ihdr, (unsigned long)w), be32(ihdr + 4, (unsigned long)h);
		ihdr[8] = 8, ihdr[9] = 2, ihdr[10] = ihdr[11] = ihdr[12] = 0;
		chunk(f, "IHDR", ihdr, 13);
		chunk(f, "IDAT", z, zn);
		chunk(f, "IEND", NULL, 0);
		fclose(f);
	}
	free(raw), free(z);
}

static int frames;
static void (*shown)(void);

static void draw(void (*paint)(void));
void frame_show(void (*paint)(void)) {
	shown = paint;
	draw(menu_open() ? menu_paint : paint);
}
static void draw(void (*paint)(void)) {
	for (int top = 0; top < FB_H; top += FB_STRIP) {
		fb_strip(top);
		paint();
		for (int y = top; y < top + FB_STRIP && y < FB_H; y++)
			for (int x = 0; x < FB_W; x++) full[y * FB_W + x] = (uint8_t)fb_get(x, y);
	}
	mkdir("/tmp/dens", 0755), mkdir("/tmp/dens/card", 0755);
	char path[128];
	// numbered from this run's start time, so a run after a reset doesn't write over the last's
	static long run;
	if (run == 0) run = (long)(time(NULL) % 100000);
	snprintf(path, sizeof path, "/tmp/dens/card/sim-%05ld-%03d.png", run, frames++);
	png(path);
	png("/tmp/dens/card/sim.png");
	printf("frame: %s\n", path);
}

void frame_again(void) {
	if (shown || menu_open()) draw(menu_open() ? menu_paint : shown);
}

// the rooms kept in SIM_HOME (its t2<code> folders), and one let go whole
static long dir_bytes(const char *dir) {
	DIR *d = opendir(dir);
	struct dirent *f;
	struct stat st;
	long n = 0;
	char file[600];
	while (d && (f = readdir(d)) != NULL) {
		snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
		if (f->d_name[0] != '.' && stat(file, &st) == 0) n += (long)st.st_size;
	}
	if (d) closedir(d);
	return n;
}

int rooms_list(menu_room *out, int most) {
	DIR *d = opendir(home);
	struct dirent *e;
	int n = 0;
	char dir[400];
	while (d && (e = readdir(d)) != NULL && n < most) {
		if (strncmp(e->d_name, "t2", 2) != 0 || strlen(e->d_name) != 6) continue;
		snprintf(dir, sizeof dir, "%s/%s", home, e->d_name);
		snprintf(out[n].code, 5, "%s", e->d_name + 2);
		out[n].kb = (unsigned)((dir_bytes(dir) + 1023) / 1024);
		snprintf(out[n].fs, sizeof out[n].fs, "sim");
		n++;
	}
	if (d) closedir(d);
	return n;
}

int room_delete(const char *code, unsigned *left, char *why, size_t cap) {
	if (strcmp(code, den_room()) == 0) return snprintf(why, cap, "the den is in it"), -1;
	char dir[400], file[600];
	snprintf(dir, sizeof dir, "%s/t2%s", home, code);
	DIR *d = opendir(dir);
	if (d == NULL) return snprintf(why, cap, "it isn't here"), -1;
	struct dirent *f;
	while ((f = readdir(d)) != NULL) {
		snprintf(file, sizeof file, "%s/%s", dir, f->d_name);
		if (f->d_name[0] != '.') unlink(file);
	}
	closedir(d);
	if (rmdir(dir) != 0) return snprintf(why, cap, "%s", strerror(errno)), -1;
	struct statvfs v;
	*left = statvfs(home, &v) == 0 ? (unsigned)((uint64_t)v.f_bavail * v.f_frsize / 1024) : 0;
	return 0;
}

static void *sim_mem(void *ctx, void *p, size_t old, size_t size) {
	(void)ctx, (void)old;
	if (size == 0) return free(p), NULL;
	return realloc(p, size);
}

// the room, kept in SIM_HOME/room (the device's NVS); room_go: kept, then the sim run again in it
static char **args;
void room_go(const char *code) {
	char path[256];
	snprintf(path, sizeof path, "%s/room", home);
	FILE *f = fopen(path, "w");
	if (f) fputs(code, f), fclose(f);
	den_leave();
	printf("sim: to room %s: running again\n", code);
	fflush(stdout);
	unsetenv("SIM_ROOM");
	execv(args[0], args);
	perror("execv");
	exit(1);
}

void den_random(uint8_t *out, size_t n) { arc4random_buf(out, n); }

size_t den_free(void) { return 1 << 20; }
size_t den_disk_free(void) { return 1 << 30; }
int64_t den_clock(void) { return now_ms(); }

void den_mark(const char *what) {
	// SIM_TRACE_LOAD (with libtrace): what the history's load holds, by who allocated it
	if (getenv("SIM_TRACE_LOAD")) {
		void (*on)(int) = (void (*)(int))dlsym(RTLD_DEFAULT, "trace_on");
		void (*dump)(const char *, int) = (void (*)(const char *, int))dlsym(RTLD_DEFAULT, "trace_dump");
		if (on && strcmp(what, "log loaded") == 0) on(1);
		if (on && dump && strcmp(what, "history loaded") == 0) on(0), dump("by 6 callers", 6);
	}
	malloc_statistics_t m;
	malloc_zone_statistics(NULL, &m);
	size_t most, heap = den_heap(&most);
	printf("mark: %s: %zu in use, tippet %zu\n", what, m.size_in_use, heap);
}

// ---- poll.h's workers: two threads, each with a curl handle kept between requests ----

static struct {
	pthread_t thread;
	pthread_mutex_t lock;
	pthread_cond_t go;
	poll_request *job;
	CURL *curl;
} workers[2];

typedef struct {
	uint8_t *b;
	size_t n, room;
	int over;
} got;

static size_t take(char *p, size_t size, size_t k, void *ctx) {
	got *g = ctx;
	size_t n = size * k;
	if (g->n + n > POLL_MOST) return g->over = 1, 0;
	if (g->n + n > g->room) {
		g->room = (g->n + n) * 2;
		g->b = realloc(g->b, g->room);
		if (g->b == NULL) abort();
	}
	memcpy(g->b + g->n, p, n);
	g->n += n;
	return n;
}

static void *work(void *arg) {
	int i = (int)(intptr_t)arg;
	for (;;) {
		pthread_mutex_lock(&workers[i].lock);
		while (workers[i].job == NULL) pthread_cond_wait(&workers[i].go, &workers[i].lock);
		poll_request *r = workers[i].job;
		workers[i].job = NULL;
		pthread_mutex_unlock(&workers[i].lock);
		CURL *c = workers[i].curl;
		got g = {0};
		curl_easy_reset(c);
		curl_easy_setopt(c, CURLOPT_URL, r->url);
		curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, r->post ? 15000L : 35000L);
		curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, take);
		curl_easy_setopt(c, CURLOPT_WRITEDATA, &g);
		struct curl_slist *h = NULL;
		if (r->post) {
			h = curl_slist_append(h, "Content-Type: application/octet-stream");
			curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
			curl_easy_setopt(c, CURLOPT_POST, 1L);
			curl_easy_setopt(c, CURLOPT_POSTFIELDS, r->body ? (const char *)r->body : "");
			curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)r->n);
		}
		long status = -1;
		if (curl_easy_perform(c) == CURLE_OK && !g.over) curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
		curl_slist_free_all(h);
		r->status = (int)status;
		if (status >= 0) r->answer = g.b, r->length = g.n;
		else free(g.b);
		__atomic_store_n(&r->done, 1, __ATOMIC_RELEASE);
	}
	return NULL;
}

void poll_do(int i, poll_request *r) {
	pthread_mutex_lock(&workers[i].lock);
	workers[i].job = r;
	pthread_cond_signal(&workers[i].go);
	pthread_mutex_unlock(&workers[i].lock);
}

int poll_up(void) { return 1; }

static void workers_start(void) {
	curl_global_init(CURL_GLOBAL_DEFAULT);
	for (int i = 0; i < 2; i++) {
		pthread_mutex_init(&workers[i].lock, NULL);
		pthread_cond_init(&workers[i].go, NULL);
		workers[i].curl = curl_easy_init();
		pthread_create(&workers[i].thread, NULL, work, (void *)(intptr_t)i);
	}
}

// ---- the install, in files in SIM_HOME ----


static bool file_read(void *ctx, const char *name, uint8_t *out, size_t cap, size_t *length) {
	(void)ctx;
	char path[256];
	snprintf(path, sizeof path, "%s/%s", home, name);
	FILE *f = fopen(path, "rb");
	if (f == NULL) return false;
	uint8_t b[256];
	size_t n = fread(b, 1, sizeof b, f);
	fclose(f);
	memcpy(out, b, n < cap ? n : cap);
	*length = n;
	return true;
}

static bool file_write(void *ctx, const char *name, const uint8_t *data, size_t length) {
	(void)ctx;
	char path[256];
	snprintf(path, sizeof path, "%s/%s", home, name);
	FILE *f = fopen(path, "wb");
	if (f == NULL) return false;
	int ok = fwrite(data, 1, length, f) == length;
	return fclose(f) == 0 && ok;
}

static bool public_key_of(void *ctx, const uint8_t secret[32], uint8_t out[32]) {
	(void)ctx;
	ermEd25519Public(secret, out);
	return true;
}

int64_t now_ms(void) {
	struct timeval t;
	gettimeofday(&t, NULL);
	return (int64_t)t.tv_sec * 1000 + t.tv_usec / 1000;
}

int main(int argc, char **argv) {
	(void)argc, (void)argv;
	const char *h = getenv("SIM_HOME"), *room = getenv("SIM_ROOM"), *server = getenv("SIM_SERVER");
	snprintf(home, sizeof home, "%s", h ? h : "/tmp/cardputer-sim");
	args = argv;
	static char kept[8];
	if (room == NULL || strlen(room) != 4) {
		char path[256];
		snprintf(path, sizeof path, "%s/room", h ? h : "/tmp/cardputer-sim");
		FILE *f = fopen(path, "r");
		room = f && fgets(kept, sizeof kept, f) && strlen(kept) == 4 ? kept : "ACDE";
		if (f) fclose(f);
	}
	if (server == NULL) server = "https://galaxy.observer";
	mkdir(home, 0755);
	setvbuf(stdout, NULL, _IOLBF, 0);
	quiet = getenv("SIM_SHELL") == NULL;
	host_init();
	es_context *keys = host_start("keyboard", keyboard, NULL);
	if (!quiet) host_start("shell", shell, NULL), host_start("display", display, NULL);
	inst_install me;
	uint8_t random[INST_RANDOM];
	arc4random_buf(random, sizeof random);
	int code = inst_open(&(inst_store){file_read, file_write, NULL}, &(inst_public_key){public_key_of, NULL}, NULL,
		random, &me);
	if (code != INST_OK) {
		fprintf(stderr, "install: %s\n", inst_error(code));
		return 1;
	}
	char dir[256];
	snprintf(dir, sizeof dir, "%s/t2%s", home, room);
	if (getenv("SIM_FORGET")) den_forgets(1);
	malloc_statistics_t before, after;
	malloc_zone_statistics(NULL, &before);
	if (den_boot(&me, room, dir, now_ms())) return 1;
	malloc_zone_statistics(NULL, &after);
	printf("den: up, %zu bytes in use more (malloc's, ASan's own too)\n", after.size_in_use - before.size_in_use);
	printf("den: %s in room %s\n", me.id, room);
	int online = strcmp(server, "none") != 0;
	if (online) {
		char url[200];
		snprintf(url, sizeof url, "%s/littlesync/tippet/dens-%s", server, room);
		workers_start();
		poll_start(den_sync(), url);
		printf("poll: %s\n", url);
	}
	char line[256];
	size_t at = 0;
	int open = 1;
	int64_t said = 0;
	for (;;) {
		fd_set in;
		FD_ZERO(&in);
		if (open) FD_SET(0, &in);
		struct timeval wait = {0, 10000};
		if (select(1, &in, NULL, NULL, &wait) > 0 && FD_ISSET(0, &in)) {
			ssize_t n = read(0, line + at, sizeof line - 1 - at);
			if (n <= 0) {
				open = 0;
				if (!online) return 0;
			} else at += (size_t)n;
			char *nl;
			while ((nl = memchr(line, '\n', at)) != NULL) {
				*nl = 0;
				if (strcmp(line, "g0") == 0) menu_toggle();
				else if (menu_open() && (strcmp(line, "tab") != 0 || menu_key("tab"))) {
					// the menu's keys: a line a key's name (esc, enter, up, down, backspace), or letters
					if (!strcmp(line, "tab")) {
					} else if (!strcmp(line, "esc") || !strcmp(line, "enter") || !strcmp(line, "up") || !strcmp(line, "down") ||
						!strcmp(line, "backspace"))
						menu_key(line);
					else
						for (char *c = line; *c; c++) {
							char key[2] = {*c, 0};
							menu_key(key);
						}
				} else if (strcmp(line, "tab") == 0) den_pair_answer(1);
				else if (strcmp(line, "esc") == 0) den_pair_answer(0);
				else if (strcmp(line, "print") == 0) den_print();
				else if (strcmp(line, "quit") == 0) return 0;
				else if (strcmp(line, "snapshot") == 0) den_snapshot();
				else if (strcmp(line, "mark") == 0) den_mark("now");
				else if (strcmp(line, "packs") == 0) {
					// the last few steps of this den's packed as one run: its bytes, against the steps alone
					static uint8_t b[8][2048];
					tp_span sp[8];
					size_t total = 0;
					int k = 0;
					uint64_t count = den_steps_own();
					for (uint64_t n = count > 6 ? count - 5 : 1; k < 6 && n <= count; n++) {
						long l = den_own_step(n, b[k], sizeof b[k]);
						if (l < 0) break;
						sp[k % 8] = (tp_span){b[k], (size_t)l};
						k++;
					}
					tp_mem mem = {sim_mem, NULL};
					for (int i = 1; i <= k; i++) {
						tp_span pack;
						total = 0;
						for (int j = 0; j < i; j++) total += sp[j].n;
						if (tp_pack(&mem, sp, (size_t)i, 1 << 20, &pack) == 0) {
							printf("packs: %d steps, %zu bytes alone, %zu packed\n", i, total, pack.n);
							tp_span_free(&mem, &pack);
						}
					}
				} else if (strncmp(line, "cycle ", 6) == 0) {
					// a thing started and stopped 10 times: what each leaves behind
					den_mark("before cycles");
					for (int i = 0; i < 10; i++) {
						den_start(line + 6, "cycled");
						for (int k = 0; k < 3; k++) host_settle(), den_tick(now_ms());
						den_stop("cycled");
						for (int k = 0; k < 3; k++) host_settle(), den_tick(now_ms());
						if (i == 0 || i == 9) den_mark(i ? "after 10" : "after 1");
					}
				} else if (strncmp(line, "measure ", 8) == 0) {
					// a thing started, what it holds after, by who allocated it (SIM_TRACE: libtrace)
					void (*on)(int) = (void (*)(int))dlsym(RTLD_DEFAULT, "trace_on");
					void (*dump)(const char *, int) = (void (*)(const char *, int))dlsym(RTLD_DEFAULT, "trace_dump");
					static int k;
					char at[32];
					snprintf(at, sizeof at, "m-%d", ++k);
					den_mark("before");
					if (on) on(1);
					int ok = den_start(line + 8, at);
					for (int i = 0; i < 5; i++) host_settle(), den_tick(now_ms());
					if (on) on(0);
					den_mark(ok ? "a thing started" : "a thing refused");
					if (dump) dump("by caller", 1), dump("by 6 callers", 6);
				}
				else {
					for (char *c = line; *c; c++) {
						char key[2] = {*c, 0};
						if (!quiet) keyboard_press(keys, key);
						things_key(key);
						host_settle();
					}
					if (!quiet) keyboard_press(keys, "enter");
				}
				host_settle();
				size_t used = (size_t)(nl - line) + 1;
				memmove(line, nl + 1, at - used);
				at -= used;
			}
		}
		int64_t now = now_ms();
		if (online) {
			poll_turn(now);
			host_settle();
			den_net(poll_state());
		}
		den_tick(now);
		things_tick(now);
		if (now - said > 10000) {
			said = now;
			unsigned requests = 0, failed = 0, i = 0, o = 0;
			if (online) poll_counts(&requests, &failed, &i, &o);
			size_t most, heap = den_heap(&most);
			printf("sim: %s, requests %u failed %u, messages in %u out %u, %llu steps, tippet heap %zu (most %zu)\n",
				online ? poll_state() : "alone", requests, failed, i, o, (unsigned long long)den_steps(), heap, most);
		}
	}
}
