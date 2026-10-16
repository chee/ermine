// A presence channel over a device (channel.h)
#include "channel.h"

#include <stdio.h>
#include <stdlib.h>

// a listener: presence's function, told through the device's
struct chn_listener {
	chn_fn fn;
	void *context;
	tp_listener *on;
	chn_listener *next;
};

struct sc_channel {
	chn_channel channel;
	tp_device *t;
	char name[65];
	chn_listener *first;
};

static void told(void *context, const char *from, const uint8_t *bytes, size_t length) {
	chn_listener *l = context;
	l->fn(l->context, from, bytes, length);
}

static void channel_send(chn_channel *c, const char *topic, const unsigned char *bytes, size_t n) {
	sc_channel *s = c->impl;
	tp_send(s->t, topic, bytes, n);
}

static chn_listener *channel_on(chn_channel *c, const char *topic, chn_fn fn, void *context) {
	sc_channel *s = c->impl;
	chn_listener *l = calloc(1, sizeof *l);
	if (l == NULL) abort();
	l->fn = fn;
	l->context = context;
	l->on = tp_listen(s->t, topic, told, l);
	l->next = s->first;
	s->first = l;
	return l;
}

// the device tells a stopped listener nothing more, so it may go now
static void channel_off(chn_channel *c, chn_listener *l) {
	sc_channel *s = c->impl;
	for (chn_listener **at = &s->first; *at; at = &(*at)->next) {
		if (*at != l) continue;
		*at = l->next;
		tp_unlisten(s->t, l->on);
		free(l);
		return;
	}
}

sc_channel *sc_create(tp_device *t) {
	sc_channel *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	s->t = t;
	const uint8_t *key = tp_key(t);
	for (int i = 0; i < 32; i++) snprintf(s->name + 2 * i, 3, "%02x", key[i]);
	s->channel = (chn_channel){s->name, channel_send, channel_on, channel_off, s};
	return s;
}

void sc_free(sc_channel *s) {
	while (s->first != NULL) channel_off(&s->channel, s->first);
	free(s);
}

chn_channel *sc_channel_of(sc_channel *s) {
	return &s->channel;
}
