// What the transport and sync harnesses share (playground/together/typescript/harnesses.ts), in C:
// devices in one process joined by in-memory pipes, in order, as harnesses.ts's pipe is; the clock
// the devices run on, which moves only when a harness moves it; quiet's count of what crossed
#ifndef WR_WIRES_HARNESS_H
#define WR_WIRES_HARNESS_H

#include "transport.h"

// every message sent over any pipe: a harness knows when nothing crosses
extern size_t wr_moved;
// the harness's clock, ms since 1970: from 1 760 000 000 000, moved by the harness
extern uint64_t wr_ms;
uint64_t wr_clock(void *context);

// a pipe between two devices, each connecting over its end (both start the handshake: Subduction's
// simultaneous open)
void wr_connect(tp_device *a, tp_device *b);
// what the device asks of its host: each message handed to the other end of its pipe; a close cuts
// the pipe, the other end told
void wr_drain(tp_device *d);
// the pipes between the two cut, no one told
void wr_cut(tp_device *a, tp_device *b);
// every pipe of the device cut, the other ends told: their transport closed
void wr_close(tp_device *d);
// whether the pipe between the two has both handshakes done
bool wr_up(tp_device *a, tp_device *b);
// lets go of every pipe
void wr_free(void);

#endif
