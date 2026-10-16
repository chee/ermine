// The in-memory channel pair (channel.h).
#include "channel.h"

#include <stdlib.h>
#include <string.h>

struct chn_listener {
	char *topic;
	chn_fn fn;
	void *ctx;
	int dead;
};

typedef struct side {
	chn_channel channel;
	char *name;
	chn_listener **listeners;
	size_t n, cap;
	// told in progress: a stopped listener is only marked until the last tell is done
	int telling;
	struct side *other;
	chn_pair *pair;
} side;

struct chn_pair {
	side a, b;
	chn_sent *sent;
	size_t nsent, capsent;
};

static void *xalloc(size_t n) {
	void *p = calloc(1, n ? n : 1);
	if (p == NULL) abort();
	return p;
}
static char *xdup(const char *s) { return strcpy(xalloc(strlen(s) + 1), s); }

static void compact(side *s) {
	size_t kept = 0;
	for (size_t i = 0; i < s->n; i++) {
		chn_listener *l = s->listeners[i];
		if (l->dead) {
			free(l->topic);
			free(l);
		} else s->listeners[kept++] = l;
	}
	s->n = kept;
}

static chn_listener *side_on(chn_channel *c, const char *topic, chn_fn fn, void *ctx) {
	side *s = c->impl;
	if (s->n == s->cap) {
		s->cap = s->cap ? s->cap * 2 : 4;
		s->listeners = realloc(s->listeners, s->cap * sizeof *s->listeners);
		if (s->listeners == NULL) abort();
	}
	chn_listener *l = xalloc(sizeof *l);
	l->topic = xdup(topic);
	l->fn = fn;
	l->ctx = ctx;
	return s->listeners[s->n++] = l;
}

static void side_off(chn_channel *c, chn_listener *l) {
	side *s = c->impl;
	l->dead = 1;
	if (!s->telling) compact(s);
}

// every listener on the topic, in the order they were added; those added during the tell are not told
static void tell(side *to, const char *topic, const char *from, const unsigned char *bytes, size_t n) {
	size_t count = to->n;
	to->telling++;
	for (size_t i = 0; i < count; i++) {
		chn_listener *l = to->listeners[i];
		if (!l->dead && strcmp(l->topic, topic) == 0) l->fn(l->ctx, from, bytes, n);
	}
	if (--to->telling == 0) compact(to);
}

static void side_send(chn_channel *c, const char *topic, const unsigned char *bytes, size_t n) {
	side *s = c->impl;
	chn_pair *p = s->pair;
	if (p->nsent == p->capsent) {
		p->capsent = p->capsent ? p->capsent * 2 : 16;
		p->sent = realloc(p->sent, p->capsent * sizeof *p->sent);
		if (p->sent == NULL) abort();
	}
	chn_sent *m = &p->sent[p->nsent++];
	m->from = s->name;
	m->topic = xdup(topic);
	m->bytes = xalloc(n);
	memcpy(m->bytes, bytes, n);
	m->n = n;
	tell(s->other, topic, s->name, bytes, n);
}

static void side_init(side *s, chn_pair *p, side *other, const char *name) {
	s->name = xdup(name);
	s->other = other;
	s->pair = p;
	s->channel = (chn_channel){.name = s->name, .send = side_send, .on = side_on, .off = side_off, .impl = s};
}

chn_pair *chn_pair_new(const char *a, const char *b) {
	chn_pair *p = xalloc(sizeof *p);
	side_init(&p->a, p, &p->b, a);
	side_init(&p->b, p, &p->a, b);
	return p;
}

static void side_free(side *s) {
	for (size_t i = 0; i < s->n; i++) {
		free(s->listeners[i]->topic);
		free(s->listeners[i]);
	}
	free(s->listeners);
	free(s->name);
}

void chn_pair_free(chn_pair *p) {
	if (p == NULL) return;
	side_free(&p->a);
	side_free(&p->b);
	for (size_t i = 0; i < p->nsent; i++) {
		free(p->sent[i].topic);
		free(p->sent[i].bytes);
	}
	free(p->sent);
	free(p);
}

chn_channel *chn_pair_a(chn_pair *p) { return &p->a.channel; }
chn_channel *chn_pair_b(chn_pair *p) { return &p->b.channel; }
const chn_sent *chn_pair_sent(const chn_pair *p, size_t *n) {
	*n = p->nsent;
	return p->sent;
}
