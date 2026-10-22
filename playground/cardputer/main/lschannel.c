// a presence channel over littlesync's messages (lschannel.h)
#include "lschannel.h"

#ifdef ESP_PLATFORM
#include "peak.h"
#include "ermine/encoding/c/pack.h"
peak_step *lschannel_steps;
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct chn_listener {
	char *topic;
	chn_fn fn;
	void *ctx;
	struct chn_listener *next;
};

// a row waiting to go: one a topic (a den has one; a few to spare)
#define WAITING 4
typedef struct {
	char *topic;
	unsigned char *bytes;
	size_t n;
	int64_t sent;
} waiting;

static struct {
	chn_channel c;
	ls_dev *dev;
	char name[2 * LS_KEY_LEN + 1];
	struct chn_listener *listeners;
	waiting rows[WAITING];
	int64_t now;
} me;

static void now_send(const char *topic, const unsigned char *bytes, size_t n) {
	ls_code code = ls_send(me.dev, topic, bytes, n);
	// lost, as an ephemeral send is: said, so a row too big is seen
	if (code != LS_OK) printf("lschannel: %s not sent (%zu bytes): %d\n", topic, n, (int)code);
}

static int is_row(const char *topic) { return !strstr(topic, "/ask/") && !strstr(topic, "/answer/"); }

static void send(chn_channel *c, const char *topic, const unsigned char *bytes, size_t n) {
	(void)c;
	if (!is_row(topic)) return now_send(topic, bytes, n);
	waiting *w = NULL, *free_one = NULL;
	for (int i = 0; i < WAITING; i++) {
		if (me.rows[i].topic && strcmp(me.rows[i].topic, topic) == 0) w = &me.rows[i];
		else if (!me.rows[i].topic && !free_one) free_one = &me.rows[i];
	}
	if (w == NULL) {
		// none free: at once, as before
		if (free_one == NULL) return now_send(topic, bytes, n);
		w = free_one;
		w->topic = strdup(topic);
		if (w->topic == NULL) abort();
		w->sent = me.now - LSCHANNEL_GAP_MS;
	}
	free(w->bytes);
	w->bytes = malloc(n ? n : 1);
	if (w->bytes == NULL) abort();
	memcpy(w->bytes, bytes, n);
	w->n = n;
}

void lschannel_tick(int64_t now_ms) {
	me.now = now_ms;
	for (int i = 0; i < WAITING; i++) {
		waiting *w = &me.rows[i];
		if (!w->topic || !w->bytes || now_ms - w->sent < LSCHANNEL_GAP_MS) continue;
		unsigned char *b = w->bytes;
		w->bytes = NULL;
		w->sent = now_ms;
		static size_t said;
		if (w->n > said) said = w->n, printf("lschannel: a row of %zu bytes on %.40s\n", w->n, w->topic);
		now_send(w->topic, b, w->n);
		free(b);
	}
}

static int heard_on(const char *topic) {
	for (struct chn_listener *l = me.listeners; l; l = l->next)
		if (strcmp(l->topic, topic) == 0) return 1;
	return 0;
}

static chn_listener *on(chn_channel *c, const char *topic, chn_fn fn, void *ctx) {
	(void)c;
	struct chn_listener *l = malloc(sizeof *l);
	if (l == NULL) abort();
	l->topic = strdup(topic);
	if (l->topic == NULL) abort();
	l->fn = fn, l->ctx = ctx;
	int had = heard_on(topic);
	l->next = me.listeners;
	me.listeners = l;
	if (!had) ls_listen(me.dev, topic);
	return l;
}

static void off(chn_channel *c, chn_listener *gone) {
	(void)c;
	for (struct chn_listener **p = &me.listeners; *p; p = &(*p)->next) {
		if (*p != gone) continue;
		*p = gone->next;
		if (!heard_on(gone->topic)) ls_unlisten(me.dev, gone->topic);
		free(gone->topic);
		free(gone);
		return;
	}
}

void lschannel_heard(void *context, const char *topic, const uint8_t *who, size_t who_length,
	const uint8_t *bytes, size_t length) {
	(void)context;
	char from[2 * LS_KEY_LEN + 1];
	size_t n = who_length < LS_KEY_LEN ? who_length : LS_KEY_LEN;
	for (size_t i = 0; i < n; i++) sprintf(from + 2 * i, "%02x", who[i]);
	from[2 * n] = 0;
	// a listener may go (off) while told: the next taken first
	for (struct chn_listener *l = me.listeners, *next; l; l = next) {
		next = l->next;
		if (strcmp(l->topic, topic) != 0) continue;
#ifdef ESP_PLATFORM
		{
			// a probe: the row's bytes, and what it takes decoded (let go of at once)
			size_t before = heap_caps_get_free_size(MALLOC_CAP_8BIT);
			op_value *v = pk_get(bytes, length, NULL, NULL);
			size_t after = heap_caps_get_free_size(MALLOC_CAP_8BIT);
			op_free(v);
			printf("row: from %.8s, %u bytes, %u decoded\n", from, (unsigned)length, (unsigned)(before - after));
		}
		if (lschannel_steps) {
			PEAK(lschannel_steps, l->fn(l->ctx, from, bytes, length));
			continue;
		}
#endif
		l->fn(l->ctx, from, bytes, length);
	}
}

chn_channel *lschannel(ls_dev *dev) {
	const uint8_t *key = dev ? ls_key(dev) : NULL;
	if (key == NULL) return NULL;
	me.dev = dev;
	for (int i = 0; i < LS_KEY_LEN; i++) sprintf(me.name + 2 * i, "%02x", key[i]);
	me.c = (chn_channel){.name = me.name, .send = send, .on = on, .off = off};
	return &me.c;
}
