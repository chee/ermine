// In-memory pipes between devices (wires.h)
#include "wires.h"

#include <stdlib.h>

size_t wr_moved;
uint64_t wr_ms = 1760000000000ull;

uint64_t wr_clock(void *context) {
	(void)context;
	return wr_ms;
}

typedef struct {
	tp_device *a, *b;
	uint64_t ca, cb;
	bool live;
} pipe_t;

static pipe_t *pipes;
static size_t pipe_count, pipe_room;

void wr_connect(tp_device *a, tp_device *b) {
	if (pipe_count == pipe_room) {
		pipe_room = pipe_room ? pipe_room * 2 : 8;
		pipes = realloc(pipes, pipe_room * sizeof *pipes);
		if (pipes == NULL) abort();
	}
	pipe_t *p = &pipes[pipe_count++];
	*p = (pipe_t){a, b, 0, 0, true};
	p->ca = tp_connect(a, NULL);
	p->cb = tp_connect(b, NULL);
}

void wr_drain(tp_device *d) {
	tp_out o;
	while (tp_next(d, &o)) {
		for (size_t i = 0; i < pipe_count; i++) {
			pipe_t *p = &pipes[i];
			tp_device *other;
			uint64_t conn;
			if (!p->live) continue;
			if (p->a == d && p->ca == o.conn) other = p->b, conn = p->cb;
			else if (p->b == d && p->cb == o.conn) other = p->a, conn = p->ca;
			else continue;
			if (o.kind == TP_SEND) {
				tp_received(other, conn, o.bytes, o.length);
				wr_moved++;
			} else {
				p->live = false;
				tp_closed(other, conn);
			}
			break;
		}
		tp_out_free(&o);
	}
}

void wr_cut(tp_device *a, tp_device *b) {
	for (size_t i = 0; i < pipe_count; i++) {
		pipe_t *p = &pipes[i];
		if ((p->a == a && p->b == b) || (p->a == b && p->b == a)) p->live = false;
	}
}

void wr_close(tp_device *d) {
	for (size_t i = 0; i < pipe_count; i++) {
		pipe_t *p = &pipes[i];
		if (!p->live || (p->a != d && p->b != d)) continue;
		p->live = false;
		if (p->a == d) tp_closed(p->b, p->cb);
		else tp_closed(p->a, p->ca);
	}
	// a device gone is in no pipe
	for (size_t i = 0; i < pipe_count; i++) {
		if (pipes[i].a == d) pipes[i].a = NULL;
		if (pipes[i].b == d) pipes[i].b = NULL;
	}
}

bool wr_up(tp_device *a, tp_device *b) {
	for (size_t i = 0; i < pipe_count; i++) {
		pipe_t *p = &pipes[i];
		if (!p->live) continue;
		if (p->a == a && p->b == b) return tp_connected(a, p->ca, NULL) && tp_connected(b, p->cb, NULL);
		if (p->a == b && p->b == a) return tp_connected(b, p->ca, NULL) && tp_connected(a, p->cb, NULL);
	}
	return false;
}

void wr_free(void) {
	free(pipes);
	pipes = NULL;
	pipe_count = pipe_room = 0;
}
