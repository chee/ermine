// a presence channel (extensions/presence/c/channel.h) over littlesync's messages (littlesync.h,
// "messages"): send is ls_send (sealed by this device's key), on is ls_listen, and what is heard comes
// from ls_options.heard, from: the hex of the key that sealed it (checked by littlesync), the same
// name together's channel gives a browser's sender. its name: this device's key as hex, the den's id
// (away's rule: a den's channel is named its id)
//
//   ls_options o = {.heard = lschannel_heard, ...};  ls_dev *d = ls_open(&o);
//   chn_channel *c = lschannel(d);                   // after ls_open; one a device
#ifndef CARD_LSCHANNEL_H
#define CARD_LSCHANNEL_H

#include "littlesync.h"
#include "extensions/presence/c/channel.h"

// the channel over dev's messages; NULL: no key
chn_channel *lschannel(ls_dev *dev);
// ls_options.heard: what littlesync hears, to the channel's listeners on its topic
void lschannel_heard(void *context, const char *topic, const uint8_t *who, size_t who_length,
	const uint8_t *bytes, size_t length);

#endif
