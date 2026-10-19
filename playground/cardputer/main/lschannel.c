// a presence channel over littlesync's messages (lschannel.h)
#include "lschannel.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct chn_listener {
	char *topic;
	chn_fn fn;
	void *ctx;
	struct chn_listener *next;
};

static struct {
	chn_channel c;
	ls_dev *dev;
	char name[2 * LS_KEY_LEN + 1];
	struct chn_listener *listeners;
} me;

static void send(chn_channel *c, const char *topic, const unsigned char *bytes, size_t n) {
	(void)c;
	ls_code code = ls_send(me.dev, topic, bytes, n);
	// lost, as an ephemeral send is: said, so a row too big is seen
	if (code != LS_OK) printf("lschannel: %s not sent (%zu bytes): %d\n", topic, n, (int)code);
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
		if (strcmp(l->topic, topic) == 0) l->fn(l->ctx, from, bytes, length);
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
