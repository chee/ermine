// the Cardputer ADV's other hardware (parts.h)
#include "parts.h"

#include <dirent.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bmi270_config.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "driver/sdspi_host.h"
#include "driver/spi_master.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_vfs_fat.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sdmmc_cmd.h"

static char why[64];
const char *parts_why(void) { return why; }
static int no(const char *what, esp_err_t e) {
	snprintf(why, sizeof why, "%s: %s", what, esp_err_to_name(e));
	printf("parts: %s\n", why);
	return -1;
}

// a device on the internal bus (made once, kept: a handle is small)
static i2c_master_dev_handle_t device(uint8_t address) {
	i2c_device_config_t c = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = address, .scl_speed_hz = 400000};
	i2c_master_dev_handle_t d = NULL;
	if (i2c_master_bus_add_device((i2c_master_bus_handle_t)keys_bus(), &c, &d) != ESP_OK) return NULL;
	return d;
}
static esp_err_t put(i2c_master_dev_handle_t d, uint8_t reg, uint8_t v) {
	uint8_t b[2] = {reg, v};
	return i2c_master_transmit(d, b, 2, 50);
}
static esp_err_t get(i2c_master_dev_handle_t d, uint8_t reg, uint8_t *out, size_t n) {
	return i2c_master_transmit_receive(d, &reg, 1, out, n, 50);
}

// ---- audio: the ES8311, one I2S both ways (16 kHz, 16 bits, two slots), a task of its own ----

#define RATE 16000
#define CHUNK 128
static i2c_master_dev_handle_t codec;
static i2s_chan_handle_t tx, rx;
static QueueHandle_t voices;
static volatile int listening, level = -1, gone, letting_go;
// when a voice was last played (ticks): idle 3 s and not listening, the audio is let go
static volatile TickType_t used;

// ES8311, as M5Unified sets it up on the ADV (its speaker's and its mic's, both): MCLK from BCLK,
// times 8 (256 fs at 32 BCLK a frame), the DAC on to the amp and the jack at 0 dB, the mic's PGA at
// 24 dB, 16-bit I2S each way
static const uint8_t CODEC[][2] = {
	{0x00, 0x80}, {0x01, 0xBF}, {0x02, 0x18}, {0x09, 0x0C}, {0x0A, 0x0C}, {0x0D, 0x01}, {0x0E, 0x02}, {0x12, 0x00},
	{0x13, 0x10}, {0x14, 0x18}, {0x17, 0xBF}, {0x1C, 0x6A}, {0x32, 0xBF}, {0x37, 0x08},
};

// a note of a voice (sound.ts' note): f Hz from at s, a swell to peak over attack, gone over tail;
// fm: a modulator at f * ratio, f * depth deep, falling away; slide: f to slide Hz over 70 ms (pop)
typedef struct {
	float f, at, peak, attack, tail, ratio, depth, slide;
	int triangle;
} note;
typedef struct {
	const char *name;
	note n[4];
	int count;
} voice;
#define N(...) {__VA_ARGS__}
static const voice VOICES[] = {
	{"ding", {N(1568, 0, 0.05f, 0.006f, 0.9f, 3.5f, 1.2f, 0, 0)}, 1},
	{"pop", {N(320, 0, 0.08f, 0.004f, 0.12f, 0, 0, 980, 0)}, 1},
	{"sparkle",
		{N(1046.5f, 0, 0.035f, 0.006f, 0.32f, 2, 0.5f, 0, 0), N(1318.5f, 0.06f, 0.035f, 0.006f, 0.32f, 2, 0.5f, 0, 0),
			N(1568, 0.12f, 0.035f, 0.006f, 0.32f, 2, 0.5f, 0, 0), N(2093, 0.18f, 0.035f, 0.006f, 0.32f, 2, 0.5f, 0, 0)},
		4},
	{"plink", {N(784, 0, 0.07f, 0.003f, 0.35f, 0, 0, 0, 0), N(3136, 0, 0.02f, 0.002f, 0.06f, 0, 0, 0, 0)}, 2},
	{"blip", {N(880, 0, 0.06f, 0.006f, 0.09f, 0, 0, 0, 1), N(1174.7f, 0.06f, 0.06f, 0.006f, 0.14f, 0, 0, 0, 1)}, 2},
	{"tick", {N(1900, 0, 0.08f, 0.001f, 0.035f, 1.41f, 0.8f, 0, 0), N(420, 0, 0.05f, 0.001f, 0.05f, 0, 0, 0, 0)}, 2},
	{"chime", {N(1046.5f, 0, 0.045f, 0.006f, 0.5f, 2, 0.6f, 0, 0), N(1568, 0.13f, 0.045f, 0.006f, 0.7f, 2, 0.6f, 0, 0)}, 2},
};
#undef N
// the page's 1.0 as loud as this: soft (sound.ts' peaks are 0.035 to 0.08)
#define LOUD 90000.0f

static float wave(float phase, int triangle) {
	if (!triangle) return sinf(phase);
	float p = fmodf(phase / (2 * (float)M_PI), 1.0f);
	return p < 0.5f ? 4 * p - 1 : 3 - 4 * p;
}

// a voice, a chunk at a time, into the codec: each note's phase kept as it goes
static void sing(const voice *v) {
	float phase[4] = {0}, mphase[4] = {0}, end = 0;
	for (int i = 0; i < v->count; i++) {
		float e = v->n[i].at + v->n[i].attack + v->n[i].tail;
		if (e > end) end = e;
	}
	int16_t buf[CHUNK * 2];
	const float dt = 1.0f / RATE;
	for (int at = 0; at < (int)(end * RATE) + CHUNK; at += CHUNK) {
		for (int k = 0; k < CHUNK; k++) {
			float t = (at + k) * dt, s = 0;
			for (int i = 0; i < v->count; i++) {
				const note *n = &v->n[i];
				float u = t - n->at;
				if (u < 0 || u > n->attack + n->tail) continue;
				float g = u < n->attack ? n->peak * u / n->attack : n->peak * expf(-9.21f * (u - n->attack) / n->tail);
				float f = n->slide > 0 ? n->f * powf(n->slide / n->f, fminf(u / 0.07f, 1)) : n->f;
				if (n->ratio > 0 && n->depth > 0) {
					// the modulator's deviation falls from f * depth to 1 Hz over attack + 0.6 tail
					float fall = fminf(u / (n->attack + n->tail * 0.6f), 1);
					float dev = n->f * n->depth * powf(1 / (n->f * n->depth), fall);
					mphase[i] += 2 * (float)M_PI * n->f * n->ratio * dt;
					f += dev * sinf(mphase[i]);
				}
				phase[i] += 2 * (float)M_PI * f * dt;
				if (phase[i] > 2 * (float)M_PI * 64) phase[i] -= 2 * (float)M_PI * 64;
				s += g * wave(phase[i], n->triangle);
			}
			float x = s * LOUD;
			int16_t y = (int16_t)(x > 32767 ? 32767 : x < -32768 ? -32768 : x);
			buf[2 * k] = buf[2 * k + 1] = y;
		}
		size_t wrote;
		i2s_channel_write(tx, buf, sizeof buf, &wrote, 200);
	}
}

// the task: voices played as they come; the mic's level read between (an RMS of 0.1 s, as 0 to 100:
// -60 dBFS 0, -10 dBFS 100)
static void audio(void *arg) {
	(void)arg;
	int16_t in[CHUNK * 2];
	double sum = 0;
	int count = 0;
	for (;;) {
		const voice *v;
		if (xQueueReceive(voices, &v, listening ? 0 : pdMS_TO_TICKS(100)) == pdTRUE) {
			// NULL: let go (parts_tick's, idle 3 s): the channels and this task, the loop told
			if (v == NULL) {
				i2s_channel_disable(tx), i2s_channel_disable(rx);
				i2s_del_channel(tx), i2s_del_channel(rx);
				put(codec, 0x0D, 0xFC), put(codec, 0x00, 0x00);
				printf("parts: the audio let go, its task's stack %u left\n", (unsigned)uxTaskGetStackHighWaterMark(NULL));
				gone = 1;
				vTaskDelete(NULL);
			}
			sing(v);
			used = xTaskGetTickCount();
		}
		if (!listening) continue;
		size_t got = 0;
		if (i2s_channel_read(rx, in, sizeof in, &got, 20) != ESP_OK) continue;
		for (size_t i = 0; i < got / 2; i++) sum += (double)in[i] * in[i], count++;
		if (count >= RATE / 5) {
			double rms = sqrt(sum / count) / 32768.0, db = rms > 0 ? 20 * log10(rms) : -120;
			int l = (int)((db + 60) * 2);
			level = l < 0 ? 0 : l > 100 ? 100 : l;
			sum = 0, count = 0;
		}
	}
}

static int audio_on(void) {
	if (tx) return 0;
	if (codec == NULL && (codec = device(0x18)) == NULL) return no("the codec (ES8311) isn't on the bus", ESP_FAIL);
	for (size_t i = 0; i < sizeof CODEC / sizeof *CODEC; i++) {
		esp_err_t e = put(codec, CODEC[i][0], CODEC[i][1]);
		if (e != ESP_OK) return no("the codec (ES8311) didn't answer", e);
	}
	// small DMA: 2 buffers of 128 frames each way (1 KB each)
	i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
	cc.dma_desc_num = 2, cc.dma_frame_num = CHUNK, cc.auto_clear_after_cb = true;
	esp_err_t e = i2s_new_channel(&cc, &tx, &rx);
	if (e != ESP_OK) return tx = rx = NULL, no("no I2S", e);
	i2s_std_config_t sc = {
		.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(RATE),
		.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
		.gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = 41, .ws = 43, .dout = 42, .din = 46},
	};
	if ((e = i2s_channel_init_std_mode(tx, &sc)) != ESP_OK || (e = i2s_channel_init_std_mode(rx, &sc)) != ESP_OK ||
		(e = i2s_channel_enable(tx)) != ESP_OK || (e = i2s_channel_enable(rx)) != ESP_OK) {
		i2s_del_channel(tx), i2s_del_channel(rx);
		tx = rx = NULL;
		return no("I2S didn't start", e);
	}
	voices = xQueueCreate(4, sizeof(const voice *));
	xTaskCreate(audio, "audio", 3072, NULL, 4, NULL);
	return 0;
}

// the audio (about 9 KB: its task, its DMA, the I2S driver) let go once idle: a voice played
// 3 s ago and the mic off. each loop
void parts_tick(void) {
	if (letting_go && gone) {
		vQueueDelete(voices);
		voices = NULL, tx = rx = NULL, letting_go = gone = 0;
		return;
	}
	if (tx && !letting_go && !listening && xTaskGetTickCount() - used > pdMS_TO_TICKS(3000)) {
		const voice *none = NULL;
		if (xQueueSend(voices, &none, 0) == pdTRUE) letting_go = 1;
	}
}

int parts_play(const char *name) {
	for (size_t i = 0; i < sizeof VOICES / sizeof *VOICES; i++) {
		if (strcmp(name, VOICES[i].name) != 0) continue;
		if (letting_go) {
			snprintf(why, sizeof why, "the speaker is resting: again in a moment");
			return -1;
		}
		if (audio_on()) return -1;
		used = xTaskGetTickCount();
		const voice *v = &VOICES[i];
		xQueueSend(voices, &v, 0);
		return 0;
	}
	snprintf(why, sizeof why, "no voice %.20s", name);
	return -1;
}

int parts_listen(int on) {
	if (on && letting_go) return snprintf(why, sizeof why, "the audio is closing: again in a moment"), -1;
	if (on && audio_on()) return -1;
	used = xTaskGetTickCount();
	listening = on;
	if (!on) level = -1;
	return 0;
}
int parts_loudness(void) { return listening ? level : -1; }

// ---- the BMI270: its config uploaded, the accelerometer on at 100 Hz, ±2 g ----

static i2c_master_dev_handle_t imu;
int parts_tilt(int on) {
	if (!on) {
		if (imu) put(imu, 0x7D, 0x00);
		return 0;
	}
	uint8_t id = 0;
	if (imu == NULL) {
		// 0x68, or 0x69
		for (uint8_t a = 0x68; a <= 0x69 && imu == NULL; a++) {
			i2c_master_dev_handle_t d = device(a);
			if (d && get(d, 0x00, &id, 1) == ESP_OK && id == 0x24) imu = d;
			else if (d) i2c_master_bus_rm_device(d);
		}
		if (imu == NULL) return no("the IMU (BMI270) isn't on the bus", ESP_ERR_NOT_FOUND);
	}
	put(imu, 0x7E, 0xB6);
	vTaskDelay(pdMS_TO_TICKS(3));
	put(imu, 0x7C, 0x00);
	vTaskDelay(pdMS_TO_TICKS(1));
	put(imu, 0x59, 0x00);
	// the config, 64 bytes at a time from flash, each at its index (in words)
	uint8_t b[65];
	for (size_t i = 0; i < sizeof bmi270_config; i += 64) {
		uint8_t at[3] = {0x5B, (uint8_t)((i >> 1) & 0x0F), (uint8_t)(i >> 5)};
		b[0] = 0x5E;
		memcpy(b + 1, bmi270_config + i, 64);
		esp_err_t e = i2c_master_transmit(imu, at, 3, 50);
		if (e == ESP_OK) e = i2c_master_transmit(imu, b, 65, 50);
		if (e != ESP_OK) return no("the IMU's config didn't load", e);
	}
	put(imu, 0x59, 0x01);
	uint8_t st = 0;
	for (int i = 0; i < 30 && (st & 0x0F) != 1; i++) vTaskDelay(pdMS_TO_TICKS(5)), get(imu, 0x21, &st, 1);
	if ((st & 0x0F) != 1) return no("the IMU didn't start", ESP_ERR_INVALID_STATE);
	put(imu, 0x7D, 0x04);
	put(imu, 0x40, 0xA8);
	put(imu, 0x41, 0x00);
	return 0;
}

int parts_tilt_read(float *x, float *y) {
	uint8_t d[6];
	if (imu == NULL || get(imu, 0x0C, d, 6) != ESP_OK) return -1;
	*x = (int16_t)(d[0] | d[1] << 8) / 16384.0f;
	*y = (int16_t)(d[2] | d[3] << 8) / 16384.0f;
	return 0;
}

// ---- RMT: the LED (WS2812, 10 MHz ticks) and IR (NEC on a 38 kHz carrier, 1 MHz ticks) ----

static rmt_channel_handle_t led_ch, ir_ch;
static rmt_encoder_handle_t led_enc, ir_enc;

static int rmt_on(int pin, uint32_t hz, rmt_channel_handle_t *ch) {
	rmt_tx_channel_config_t c = {.gpio_num = pin, .clk_src = RMT_CLK_SRC_DEFAULT, .resolution_hz = hz,
		.mem_block_symbols = 48, .trans_queue_depth = 2};
	esp_err_t e = rmt_new_tx_channel(&c, ch);
	if (e != ESP_OK) return *ch = NULL, no("no RMT channel", e);
	return 0;
}

int parts_led(int on) {
	if (!on) {
		if (led_ch) {
			parts_led_set(0, 0, 0);
			rmt_disable(led_ch), rmt_del_channel(led_ch), rmt_del_encoder(led_enc);
			led_ch = NULL, led_enc = NULL;
		}
		return 0;
	}
	if (led_ch) return 0;
	if (rmt_on(21, 10000000, &led_ch)) return -1;
	rmt_bytes_encoder_config_t ec = {
		.bit0 = {.level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9},
		.bit1 = {.level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3},
		.flags.msb_first = 1,
	};
	rmt_new_bytes_encoder(&ec, &led_enc);
	rmt_enable(led_ch);
	return 0;
}

int parts_led_set(uint8_t r, uint8_t g, uint8_t b) {
	if (led_ch == NULL) return -1;
	uint8_t grb[3] = {g, r, b};
	rmt_transmit_config_t t = {0};
	esp_err_t e = rmt_transmit(led_ch, led_enc, grb, 3, &t);
	if (e == ESP_OK) e = rmt_tx_wait_all_done(led_ch, 50);
	return e == ESP_OK ? 0 : no("the LED didn't take it", e);
}

int parts_ir(int on) {
	if (!on) {
		if (ir_ch) rmt_disable(ir_ch), rmt_del_channel(ir_ch), rmt_del_encoder(ir_enc), ir_ch = NULL, ir_enc = NULL;
		return 0;
	}
	if (ir_ch) return 0;
	if (rmt_on(44, 1000000, &ir_ch)) return -1;
	rmt_carrier_config_t carrier = {.frequency_hz = 38000, .duty_cycle = 0.33f};
	rmt_apply_carrier(ir_ch, &carrier);
	rmt_copy_encoder_config_t cc;
	memset(&cc, 0, sizeof cc);
	rmt_new_copy_encoder(&cc, &ir_enc);
	rmt_enable(ir_ch);
	return 0;
}

// NEC: a 9 ms mark, 4.5 ms space, 32 bits lowest first (a 560 us mark, then 560 us or 1690 us of
// space), a last mark. raw: the 32 bits as sent; else address << 8 | command, each sent then its
// complement
int parts_ir_nec(uint32_t code, int raw) {
	if (ir_ch == NULL) return -1;
	uint32_t bits = raw ? code
			    : (uint32_t)((code >> 8) & 0xFF) | (uint32_t)(~(code >> 8) & 0xFF) << 8 |
			(uint32_t)(code & 0xFF) << 16 | (uint32_t)(~code & 0xFF) << 24;
	rmt_symbol_word_t s[34];
	s[0] = (rmt_symbol_word_t){.level0 = 1, .duration0 = 9000, .level1 = 0, .duration1 = 4500};
	for (int i = 0; i < 32; i++)
		s[1 + i] = (rmt_symbol_word_t){.level0 = 1, .duration0 = 560, .level1 = 0, .duration1 = bits >> i & 1 ? 1690 : 560};
	s[33] = (rmt_symbol_word_t){.level0 = 1, .duration0 = 560, .level1 = 0, .duration1 = 0};
	rmt_transmit_config_t t = {0};
	esp_err_t e = rmt_transmit(ir_ch, ir_enc, s, sizeof s, &t);
	if (e == ESP_OK) e = rmt_tx_wait_all_done(ir_ch, 200);
	return e == ESP_OK ? 0 : no("the IR didn't send", e);
}

// ---- the battery: ADC1 channel 9 (G10), 12 dB, curve-fitted; made for a read, let go after ----

int parts_battery_mv(void) {
	adc_oneshot_unit_handle_t u;
	adc_oneshot_unit_init_cfg_t uc = {.unit_id = ADC_UNIT_1};
	esp_err_t e = adc_oneshot_new_unit(&uc, &u);
	if (e != ESP_OK) return no("no ADC", e);
	adc_oneshot_chan_cfg_t cc = {.atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_DEFAULT};
	adc_oneshot_config_channel(u, ADC_CHANNEL_9, &cc);
	adc_cali_handle_t cal = NULL;
	adc_cali_curve_fitting_config_t fc = {.unit_id = ADC_UNIT_1, .chan = ADC_CHANNEL_9, .atten = ADC_ATTEN_DB_12,
		.bitwidth = ADC_BITWIDTH_DEFAULT};
	adc_cali_create_scheme_curve_fitting(&fc, &cal);
	int sum = 0, n = 0;
	for (int i = 0; i < 8; i++) {
		int raw, mv;
		if (adc_oneshot_read(u, ADC_CHANNEL_9, &raw) != ESP_OK) continue;
		if (cal && adc_cali_raw_to_voltage(cal, raw, &mv) == ESP_OK) sum += mv, n++;
	}
	if (cal) adc_cali_delete_scheme_curve_fitting(cal);
	adc_oneshot_del_unit(u);
	if (n == 0) return no("the battery didn't read", ESP_FAIL);
	return 2 * sum / n;
}

int parts_battery_level(int mv) {
	int l = (mv - 3300) * 100 / (4150 - 3350);
	return l < 0 ? 0 : l > 100 ? 100 : l;
}

// ---- the microSD: SPI3, mounted at /s for a look at its top folder, let go after ----

int parts_sd_list(char names[][13], int most) {
	spi_bus_config_t bus = {.mosi_io_num = 14, .miso_io_num = 39, .sclk_io_num = 40, .quadwp_io_num = -1,
		.quadhd_io_num = -1, .max_transfer_sz = 4096};
	esp_err_t e = spi_bus_initialize(SPI3_HOST, &bus, SPI_DMA_CH_AUTO);
	if (e != ESP_OK) return no("no SPI for the card", e);
	sdmmc_host_t host = SDSPI_HOST_DEFAULT();
	host.slot = SPI3_HOST;
	sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
	slot.gpio_cs = 12, slot.host_id = SPI3_HOST;
	esp_vfs_fat_mount_config_t mc = {.format_if_mount_failed = false, .max_files = 1, .allocation_unit_size = 0};
	sdmmc_card_t *card = NULL;
	e = esp_vfs_fat_sdspi_mount("/s", &host, &slot, &mc, &card);
	int n = -1;
	if (e != ESP_OK) no(e == ESP_ERR_TIMEOUT || e == ESP_FAIL ? "no card in" : "the card didn't mount", e);
	else {
		n = 0;
		DIR *d = opendir("/s");
		struct dirent *f;
		while (d && n < most && (f = readdir(d)) != NULL)
			if (f->d_name[0] != '.') snprintf(names[n++], 13, "%s", f->d_name);
		if (d) closedir(d);
		esp_vfs_fat_sdcard_unmount("/s", card);
	}
	spi_bus_free(SPI3_HOST);
	return n;
}

// ---- Grove (Port A): its own I2C bus, G2 SDA, G1 SCL, 100 kHz ----

static i2c_master_bus_handle_t grove;
int parts_grove(int on) {
	if (!on) {
		if (grove) i2c_del_master_bus(grove), grove = NULL;
		return 0;
	}
	if (grove) return 0;
	i2c_master_bus_config_t c = {.i2c_port = I2C_NUM_1, .sda_io_num = 2, .scl_io_num = 1,
		.clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true};
	esp_err_t e = i2c_new_master_bus(&c, &grove);
	return e == ESP_OK ? 0 : (grove = NULL, no("no I2C for Grove", e));
}

int parts_grove_scan(uint8_t *found, int most) {
	int n = 0;
	for (uint8_t a = 0x08; grove && a <= 0x77 && n < most; a++)
		if (i2c_master_probe(grove, a, 10) == ESP_OK) found[n++] = a;
	return n;
}
