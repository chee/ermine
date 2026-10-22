# the den on tippet; the old littlesync path (room.c, net.c, lschannel.c, and the pigs demos' pigs.c)
# is out of the build, its files left where they are
idf_component_register(
	SRCS main.c screen.c keys.c host.c shell.c drivers.c fb.c den.c things.c poll.c wifi.c flash.c
	INCLUDE_DIRS .
	REQUIRES ermine esp_lcd esp_driver_spi esp_driver_gpio esp_driver_i2c esp_driver_usb_serial_jtag esp_timer nvs_flash esp_hw_support
		esp_wifi esp_netif esp_event esp_http_client mbedtls fatfs wear_levelling esp_partition
)
# words cut to fit the screen's band are meant
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)
