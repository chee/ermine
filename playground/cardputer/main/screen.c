// the screen (screen.h). pins and panel offsets: M5Stack's Cardputer ADV docs and M5GFX
#include "screen.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "font8x8.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define WIDTH 240
#define HEIGHT 135
#define PIN_MOSI 35
#define PIN_SCK 36
#define PIN_CS 37
#define PIN_DC 34
#define PIN_RST 33
#define PIN_LIGHT 38
// the 128 rows of text in the 135
#define TOP 3
#define STRIP (WIDTH * 8)

static esp_lcd_panel_handle_t panel;
// two strips: one filled while the other is sent. free counts the ones not being sent
static uint16_t *strips[2];
static int next;
static SemaphoreHandle_t free_strips;

// the panel takes rgb565 high byte first
static inline uint16_t wire(uint16_t c) { return (uint16_t)(c >> 8 | c << 8); }

static bool sent(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx) {
	BaseType_t woke = pdFALSE;
	xSemaphoreGiveFromISR(free_strips, &woke);
	return woke == pdTRUE;
}

// a strip to fill: the older one, once it is sent
static uint16_t *strip(void) {
	xSemaphoreTake(free_strips, portMAX_DELAY);
	uint16_t *s = strips[next];
	next ^= 1;
	return s;
}

static void send(int y, int rows, uint16_t *s) { esp_lcd_panel_draw_bitmap(panel, 0, y, WIDTH, y + rows, s); }

void screen_init(void) {
	free_strips = xSemaphoreCreateCounting(2, 2);
	for (int i = 0; i < 2; i++) {
		strips[i] = heap_caps_malloc(STRIP * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
		assert(strips[i]);
	}
	spi_bus_config_t bus = {.mosi_io_num = PIN_MOSI,
		.miso_io_num = -1,
		.sclk_io_num = PIN_SCK,
		.quadwp_io_num = -1,
		.quadhd_io_num = -1,
		.max_transfer_sz = STRIP * 2};
	ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
	esp_lcd_panel_io_handle_t io;
	esp_lcd_panel_io_spi_config_t io_config = {.cs_gpio_num = PIN_CS,
		.dc_gpio_num = PIN_DC,
		.spi_mode = 0,
		.pclk_hz = 40 * 1000 * 1000,
		.trans_queue_depth = 4,
		.on_color_trans_done = sent,
		.lcd_cmd_bits = 8,
		.lcd_param_bits = 8};
	ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_config, &io));
	esp_lcd_panel_dev_config_t config = {.reset_gpio_num = PIN_RST,
		.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
		.bits_per_pixel = 16};
	ESP_ERROR_CHECK(esp_lcd_new_panel_st7789(io, &config, &panel));
	ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
	ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
	ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, true));
	ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(panel, true));
	ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, true, false));
	ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, 40, 53));
	screen_edges(0);
	for (int row = 0; row < SCREEN_ROWS; row++) screen_line(row, "", 0, 0);
	ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
	gpio_config_t light = {.pin_bit_mask = 1ULL << PIN_LIGHT, .mode = GPIO_MODE_OUTPUT};
	gpio_config(&light);
	gpio_set_level(PIN_LIGHT, 1);
}

void screen_edges(uint16_t color) {
	uint16_t c = wire(color);
	uint16_t *s = strip();
	for (int i = 0; i < STRIP; i++) s[i] = c;
	send(0, TOP, s);
	s = strip();
	for (int i = 0; i < STRIP; i++) s[i] = c;
	send(TOP + SCREEN_ROWS * 8, HEIGHT - TOP - SCREEN_ROWS * 8, s);
}

void screen_line(int row, const char *text, uint16_t ink, uint16_t paper) {
	if (row < 0 || row >= SCREEN_ROWS) return;
	uint16_t in = wire(ink), pa = wire(paper);
	uint16_t *s = strip();
	for (int i = 0; i < STRIP; i++) s[i] = pa;
	for (int x = 0; *text && x < SCREEN_COLUMNS; x++, text++) {
		unsigned char ch = (unsigned char)*text;
		const unsigned char *glyph = font8x8_basic[ch < 128 ? ch : '?'];
		for (int y = 0; y < 8; y++) {
			uint16_t *p = s + y * WIDTH + x * 8;
			for (int b = 0; b < 8; b++)
				if (glyph[y] >> b & 1) p[b] = in;
		}
	}
	send(TOP + row * 8, 8, s);
}
