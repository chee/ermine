// A presence channel over a device (channel.h)
#include "channel.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// a listener: presence's function, told through the device's
// a listener: presence's function, told through the device's, the message opened for its topic
struct chn_listener {
	chn_fn fn;
	void *context;
	tp_listener *on;
	sc_channel *channel;
	char *topic;
	chn_listener *next;
};

struct sc_channel {
	chn_channel channel;
	tp_device *t;
	const sl_signer *signer;
	char name[2 * CM_SIGNER_MAX + 1];
	chn_listener *first;
};

static void told(void *context, const char *from, const uint8_t *bytes, size_t length) {
	(void)from;
	chn_listener *l = context;
	sl_message m;
	if (sl_open_message(bytes, length, l->topic, &m, NULL) != SL_OK) return;
	const sl_signer *me = l->channel->signer;
	if (m.signer_length != me->key_length || memcmp(m.signer, me->key, m.signer_length) != 0) {
		char *name = malloc(2 * m.signer_length + 1);
		if (name == NULL) abort();
		for (size_t i = 0; i < m.signer_length; i++) snprintf(name + 2 * i, 3, "%02x", m.signer[i]);
		l->fn(l->context, name, m.bytes, m.length);
		free(name);
	}
	sl_message_free(&m);
}

// a topic that is not one (sl_seal_message's): lost, as an unheard send is
static void channel_send(chn_channel *c, const char *topic, const unsigned char *bytes, size_t n) {
	sc_channel *s = c->impl;
	uint8_t *sealed;
	size_t length;
	if (sl_seal_message(topic, bytes, n, s->signer, &sealed, &length) != SL_OK) return;
	tp_send(s->t, topic, sealed, length);
	free(sealed);
}

static chn_listener *channel_on(chn_channel *c, const char *topic, chn_fn fn, void *context) {
	sc_channel *s = c->impl;
	chn_listener *l = calloc(1, sizeof *l);
	if (l == NULL) abort();
	l->fn = fn;
	l->context = context;
	l->channel = s;
	l->topic = malloc(strlen(topic) + 1);
	if (l->topic == NULL) abort();
	strcpy(l->topic, topic);
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
		free(l->topic);
		free(l);
		return;
	}
}

sc_channel *sc_create(tp_device *t, const sl_signer *signer) {
	sc_channel *s = calloc(1, sizeof *s);
	if (s == NULL) abort();
	s->t = t;
	s->signer = signer;
	for (size_t i = 0; i < signer->key_length; i++) snprintf(s->name + 2 * i, 3, "%02x", signer->key[i]);
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
