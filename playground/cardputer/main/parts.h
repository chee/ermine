// the Cardputer ADV's other hardware (parts.c), each made only while a thing uses it, let go after.
// pins: M5Stack's Cardputer-Adv page and M5Unified (board_M5CardputerADV):
//   the internal I2C (G8 SDA, G9 SCL, the keyboard's): the ES8311 codec at 0x18, the BMI270 at 0x68/0x69
//   I2S, the codec's: G41 BCLK, G43 LRCK, G42 DSDIN (to the codec: the NS4150B amp and the speaker,
//     and the headphone jack), G46 ASDOUT (from it: the MEMS mic); MCLK from BCLK
//   the IR emitter G44; the RGB LED (a WS2812) G21, powered with the screen's G38
//   microSD on SPI: G12 CS, G14 MOSI, G40 CLK, G39 MISO; the battery on ADC1 G10, halved
//   Grove (HY2.0-4P, Port A): G2 SDA, G1 SCL
// every call is the loop's; the audio has a task of its own. -1 back: not done, parts_why says why
#ifndef PARTS_H
#define PARTS_H

#include <stdint.h>

const char *parts_why(void);
// each loop: what is idle let go (the audio, 3 s after its last voice with the mic off)
void parts_tick(void);

// the speaker: one of the dens' voices (sound.ts' VOICES: ding pop sparkle plink blip tick chime),
// made here, played soon. 0, or -1 (no such voice, or no audio)
int parts_play(const char *voice);
// the mic: on (its level read from then on) or off; its level now, 0 to 100 (-1: off)
int parts_listen(int on);
int parts_loudness(void);

// the IMU: on, off; the pull of gravity on x and y now, in g (0: read)
int parts_tilt(int on);
int parts_tilt_read(float *x, float *y);

// the RGB LED: on (a colour), off
int parts_led(int on);
int parts_led_set(uint8_t r, uint8_t g, uint8_t b);

// the IR emitter: on, off; an NEC code sent (address and command, or 32 bits as sent, lowest first)
int parts_ir(int on);
int parts_ir_nec(uint32_t code, int raw);

// the battery: its voltage now, mV (the divider undone), and as a percentage (M5's: 3.3 V empty)
int parts_battery_mv(void);
int parts_battery_level(int mv);

// the microSD card: its top folder's names, at most most (each up to 12 letters): how many, or -1
int parts_sd_list(char names[][13], int most);

// Grove's I2C: on, off; the addresses that answer (0x08 to 0x77): how many
int parts_grove(int on);
int parts_grove_scan(uint8_t *found, int most);

// the internal I2C bus (keys.c makes it)
void *keys_bus(void);

#endif
