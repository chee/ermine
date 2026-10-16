// A presence channel (playground/presence/c/channel.h) over a device's ephemeral messages
// (extensions/sync/typescript/channel.ts), in C: the connection the device already has. Its name is
// the device's key as lowercase hex, which is how a receiver names the sender's rows. Ephemeral: a
// send no peer hears is lost, as any would be
#ifndef SC_CHANNEL_H
#define SC_CHANNEL_H

#include "transport.h"
#include "../../../playground/presence/c/channel.h"

typedef struct sc_channel sc_channel;

// a channel over the device, which must outlive it
sc_channel *sc_create(tp_device *t);
// its listeners stopped, and it let go of
void sc_free(sc_channel *c);
// the channel, as presence takes one
chn_channel *sc_channel_of(sc_channel *c);

#endif
