// the network on the Cardputer (wifi.c): WiFi joined (and joined again when it drops), and
// poll.h's workers (poll_do, poll_up), when menuconfig names a network (Kconfig.projbuild)
#ifndef WIFI_H
#define WIFI_H

// the worker's stack: a TLS handshake runs on it (it used under 3.6 KB of 8)
#define WIFI_STACK 6144

// 1: started, with poll.h's workers (0: none, another carrier); 0: no network named
int wifi_start(int workers);
// one line: the network, whether it is joined, the workers' stack left at the least
const char *wifi_status(void);

#endif
