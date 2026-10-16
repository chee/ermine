// An ephemeral channel (typescript/channel.ts), in C: bytes on a topic, to whoever listens, saved
// nowhere. Generic: any transport can be one, by filling a chn_channel. A channel never says a peer
// left: "gone" comes from the rows' until, not from the transport. Each channel has a name (its
// device); a listener is told the sender's name. The BroadcastChannel of the reference is left out.
#ifndef PRESENCE_CHANNEL_H
#define PRESENCE_CHANNEL_H

#include <stddef.h>

typedef struct chn_channel chn_channel;
typedef struct chn_listener chn_listener;

// told each message on the topic from another channel: from is the sender's name; the bytes are good
// for the call only
typedef void (*chn_fn)(void *ctx, const char *from, const unsigned char *bytes, size_t n);

struct chn_channel {
	const char *name;
	void (*send)(chn_channel *c, const char *topic, const unsigned char *bytes, size_t n);
	// fn told each message on the topic from another channel; gives the listener, for off
	chn_listener *(*on)(chn_channel *c, const char *topic, chn_fn fn, void *ctx);
	// the stop: no more is told to it
	void (*off)(chn_channel *c, chn_listener *l);
	void *impl;
};

// one message a pair carried
typedef struct {
	const char *from;
	char *topic;
	unsigned char *bytes;
	size_t n;
} chn_sent;

// two channels in one process, each sending to the other, at once. sent: every message, in order,
// by either (the pair's own, kept until chn_pair_free)
typedef struct chn_pair chn_pair;
chn_pair *chn_pair_new(const char *a, const char *b);
void chn_pair_free(chn_pair *p);
chn_channel *chn_pair_a(chn_pair *p);
chn_channel *chn_pair_b(chn_pair *p);
const chn_sent *chn_pair_sent(const chn_pair *p, size_t *n);

#endif
