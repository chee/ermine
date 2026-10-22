// struct iovec, which ESP-IDF's sys/uio.h names but never defines (only lwip's sockets.h does):
// tippet's store_file.c (writev) is built with this included first. its writev: main/flash.c's
#ifndef CARD_IOVEC_H
#define CARD_IOVEC_H
#include <stddef.h>
struct iovec {
	void *iov_base;
	size_t iov_len;
};
#endif
