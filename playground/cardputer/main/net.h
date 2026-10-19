// littlesync over WiFi: a link of the device's to the gateway's HTTP sessions (littlesync's http.h),
// when menuconfig names a network and a gateway (Kconfig.projbuild). The posts run on a task of their
// own (esp_http_client, one handle, kept alive); every ls_ call stays on the loop's task
#ifndef NET_H
#define NET_H

#include "littlesync.h"

#include <stddef.h>
#include <stdint.h>

// WiFi joined (and joined again when it drops) and the link made: 1. 0: not configured, or no link
int net_start(ls_dev *dev, void (*random)(void *context, uint8_t *out, size_t n));
// after ls_tick, each loop: an answer fed in, the next post begun
void net_turn(int64_t now_ms);
// one line: the network, whether it is joined, the session, posts and failures (NULL: not started)
const char *net_status(void);
// the link (NULL: not started), for ls_traffic_of
struct ls_link *net_link(void);

#endif
