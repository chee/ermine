// the network on the Cardputer (wifi.c): WiFi joined (and joined again when it drops), and
// poll.h's workers (poll_do, poll_up), when menuconfig names a network (Kconfig.projbuild)
#ifndef WIFI_H
#define WIFI_H

// each worker's stack: a TLS handshake runs on it
#define WIFI_STACK 8192

// 1: started; 0: no network named
int wifi_start(void);
// one line: the network, whether it is joined, the workers' stack left at the least
const char *wifi_status(void);

#endif
