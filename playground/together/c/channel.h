// A presence channel (playground/together/presence/c/channel.h) over a device's ephemeral messages
// (playground/together/typescript/channel.ts), in C: the connection the device already has. Each message
// is sealed by the signer (sl_seal_message), so its sender is the key that signed it whatever
// connection carried it. Its name is the signer's key as lowercase hex, which is how a receiver names
// the sender's rows; what arrives unsealed, badly sealed, or sealed by this signer is dropped.
// Ephemeral: a send no peer hears is lost, as any would be
#ifndef SC_CHANNEL_H
#define SC_CHANNEL_H

#include "transport.h"
#include "../presence/c/channel.h"

typedef struct sc_channel sc_channel;

// a channel over the device, its messages sealed by the signer (the device's key, sl_seeded); both
// must outlive it
sc_channel *sc_create(tp_device *t, const sl_signer *signer);
// its listeners stopped, and it let go of
void sc_free(sc_channel *c);
// the channel, as presence takes one
chn_channel *sc_channel_of(sc_channel *c);

#endif
