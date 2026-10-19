// the Cardputer ADV's keyboard: a TCA8418 on I2C, polled
#ifndef KEYS_H
#define KEYS_H

void keys_init(void);
// the next key pressed, by name: "a", "A", "enter", "backspace", "esc", "up", ...; NULL: none
const char *keys_next(void);

#endif
