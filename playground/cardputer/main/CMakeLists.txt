# pigs.c, lab-pig's format on littlesync (room.c reads and writes it), from the pigs demos' littlesync peer
set(PIGS ${CMAKE_CURRENT_LIST_DIR}/../../demos/pigs/littlesync)
idf_component_register(
	SRCS main.c screen.c keys.c host.c shell.c drivers.c room.c net.c ${PIGS}/pigs.c
	INCLUDE_DIRS . ${PIGS}
	REQUIRES ermine esp_lcd esp_driver_spi esp_driver_gpio esp_driver_i2c esp_driver_usb_serial_jtag esp_timer littlesync nvs_flash esp_hw_support
		esp_wifi esp_netif esp_event esp_http_client
)
