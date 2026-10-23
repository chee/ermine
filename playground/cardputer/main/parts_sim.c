// the parts on the Mac (sim.c): none there; each says so, and the things say it in words
#include "parts.h"

#include <stdio.h>
#include <string.h>

static char why[64] = "not on the Mac";
const char *parts_why(void) { return why; }
void parts_tick(void) {}
int parts_play(const char *voice) { return printf("parts: would play %s\n", voice), 0; }
int parts_listen(int on) { return on ? -1 : 0; }
int parts_loudness(void) { return -1; }
int parts_tilt(int on) { return on ? -1 : 0; }
int parts_tilt_read(float *x, float *y) { return *x = *y = 0, -1; }
int parts_led(int on) { return on ? -1 : 0; }
int parts_led_set(uint8_t r, uint8_t g, uint8_t b) { return printf("parts: led %u %u %u\n", r, g, b), 0; }
int parts_ir(int on) { return on ? -1 : 0; }
int parts_ir_nec(uint32_t code, int raw) { return printf("parts: ir %08lx %d\n", (unsigned long)code, raw), 0; }
int parts_battery_mv(void) { return -1; }
int parts_battery_level(int mv) { return mv < 0 ? 0 : 50; }
int parts_sd_list(char names[][13], int most) { return (void)names, (void)most, -1; }
int parts_grove(int on) { return on ? -1 : 0; }
int parts_grove_scan(uint8_t *found, int most) { return (void)found, (void)most, 0; }
void *keys_bus(void) { return NULL; }
