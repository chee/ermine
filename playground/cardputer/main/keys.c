// the keyboard (keys.h). the TCA8418 scans a 7x8 matrix; M5Cardputer's TCA8418 reader maps its
// key numbers to the 4x14 layout printed on the keys (MIT, M5Stack)
#include "keys.h"

#include <stdio.h>
#include <string.h>

#include "driver/i2c_master.h"

#define ADDRESS 0x34
#define PIN_SDA 8
#define PIN_SCL 9

#define CFG 0x01
#define INT_STAT 0x02
#define KEY_LCK_EC 0x03
#define KEY_EVENT_A 0x04
#define KP_GPIO1 0x1D
#define KP_GPIO2 0x1E
#define KP_GPIO3 0x1F

static i2c_master_dev_handle_t dev;
static i2c_master_bus_handle_t bus;
// the bus, for the codec and the IMU on it too (parts.c)
void *keys_bus(void) { return bus; }
static int shift, fn, ctrl;

// the keys as printed: plain, shifted. 0: a key with a name (named)
static const char plain[4][15] = {
	"`1234567890-=\0",
	"\0qwertyuiop[]\\",
	"\0\0asdfghjkl;'\0",
	"\0\0\0zxcvbnm,./ ",
};
static const char shifted[4][15] = {
	"~!@#$%^&*()_+\0",
	"\0QWERTYUIOP{}|",
	"\0\0ASDFGHJKL:\"\0",
	"\0\0\0ZXCVBNM<>? ",
};

static uint8_t get(uint8_t reg) {
	uint8_t v = 0;
	if (i2c_master_transmit_receive(dev, &reg, 1, &v, 1, 50) != ESP_OK) return 0;
	return v;
}
static void set(uint8_t reg, uint8_t v) {
	uint8_t b[2] = {reg, v};
	i2c_master_transmit(dev, b, 2, 50);
}

void keys_init(void) {
	i2c_master_bus_config_t bus_config = {.i2c_port = I2C_NUM_0,
		.sda_io_num = PIN_SDA,
		.scl_io_num = PIN_SCL,
		.clk_source = I2C_CLK_SRC_DEFAULT,
		.glitch_ignore_cnt = 7,
		.flags.enable_internal_pullup = true};
	ESP_ERROR_CHECK(i2c_new_master_bus(&bus_config, &bus));
	i2c_device_config_t dev_config = {.dev_addr_length = I2C_ADDR_BIT_LEN_7,
		.device_address = ADDRESS,
		.scl_speed_hz = 400000};
	ESP_ERROR_CHECK(i2c_master_bus_add_device(bus, &dev_config, &dev));
	// rows 0-6 and columns 0-7 scanned
	set(KP_GPIO1, 0x7F);
	set(KP_GPIO2, 0xFF);
	set(KP_GPIO3, 0x00);
	for (int i = 0; i < 16 && get(KEY_EVENT_A); i++) {}
	set(INT_STAT, 0x1F);
	// key events counted
	set(CFG, 0x01);
	printf("keys: TCA8418 %s\n", get(KP_GPIO1) == 0x7F ? "answers" : "does not answer");
}

// a key's name, or NULL for a modifier (its state kept)
static const char *named(int row, int column, int down) {
	if (row == 2 && column == 0) return fn = down, NULL;
	if (row == 2 && column == 1) return shift = down, NULL;
	if (row == 3 && column == 0) return ctrl = down, NULL;
	if (row == 3 && (column == 1 || column == 2)) return NULL;
	if (!down) return NULL;
	if (row == 0 && column == 13) return fn ? "delete" : "backspace";
	if (row == 1 && column == 0) return "tab";
	if (row == 2 && column == 13) return "enter";
	if (fn) {
		if (row == 0 && column == 0) return "esc";
		if (row == 2 && column == 11) return "up";
		if (row == 3 && column == 10) return "left";
		if (row == 3 && column == 11) return "down";
		if (row == 3 && column == 12) return "right";
	}
	static char one[2];
	one[0] = (shift ? shifted : plain)[row][column];
	return one[0] ? one : NULL;
}

const char *keys_next(void) {
	while (get(KEY_LCK_EC) & 0x0F) {
		uint8_t e = get(KEY_EVENT_A);
		if (e == 0) break;
		int down = e & 0x80, number = (e & 0x7F) - 1;
		int r = number / 10, c = number % 10;
		int column = r * 2 + (c > 3), row = c % 4;
		if (row > 3 || column > 13) continue;
		const char *k = named(row, column, down);
		if (k) return k;
	}
	set(INT_STAT, 0x01);
	return NULL;
}
