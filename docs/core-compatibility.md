# Adafruit nRF52 core compatibility

Сборка использует PlatformIO `framework-arduinoadafruitnrf52@1.10601.0`, resolved `1.10601.0+sha.0fd295f1`, не ArduinoBLE и не ESP32 BLE. BLE реально связан с приложением: `Bluefruit.begin()`, primary service, write characteristic, read status, advertising и restart-on-disconnect.

Проверены исходники установленного пакета:

- `libraries/Bluefruit52Lib/src/bluefruit.cpp`: `configPrphBandwidth(BANDWIDTH_NORMAL)` вызывает `configPrphConn(BLE_GATT_ATT_MTU_DEFAULT, ...)`; базовый MTU 23, пакеты command не больше 20 bytes. Настройка вызывается **до** `Bluefruit.begin()`.
- `BLECharacteristic.h/.cpp`: `setWriteAuthorizeCallback(callback, false)` включает write authorization и отключает deferred AdaCallback для этого обработчика. Обработчик вызывается непосредственно BLE event task. Статус записывается в GATT **до** `sd_ble_gatts_rw_authorize_reply`, поэтому ATT response не обгоняет application ACK. Используются обычные write requests, не write command/prepared writes.
- `setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN)` для command и обратный порядок для status: запись/чтение без security requirement. Command имеет max length 20, status fixed length 20. Три UUID используют одну 128-bit vendor base; `configUuid128Count(3)` оставляет достаточное число слотов.
- `Bluefruit.Periph.setDisconnectCallback` сообщает disconnect; при receiving протокол отбрасывает незавершённую передачу. Advertising перезапускается. Один peripheral link по умолчанию `Bluefruit.begin()`.
- FreeRTOS mutex защищает protocol state, packet buffer mutation и публикацию status между BLE event task, callback disconnect и loop. Во время долгого refresh mutex не удерживается; новые START/ABORT/DATA не могут изменить committed frame.
- `GxEPD2_213_BN` использует ограниченное ожидание BUSY в базовом GxEPD2 драйвере. `done` означает, что последовательность драйвера вернулась; это не оптическое подтверждение того, что панель подключена или физически обновилась. Для окончательной проверки нужен дисплей.
- Board profile задаёт `nrf52840_s140_v6.ld`, `S140`, `6.1.1`, FWID `0x00B6`; core определяет SoftDevice/radio startup. Не подменяется S140 v7 linker или bootloader.
- `variants/promicro_repin/variant.cpp` сохраняет проверенный `g_ADigitalPinMap`, VCC enable preload HIGH; `SPI.begin()` использует core `SPIClass` с аппаратным SPIM3. Пакетировщик проверяет связанный код, а не только текст этих настроек.

Первичные upstream материалы (фактическая компиляция выполнена с локально закреплённой версией выше):

- [Adafruit nRF52 Arduino core / Bluefruit52Lib](https://github.com/adafruit/Adafruit_nRF52_Arduino/tree/master/libraries/Bluefruit52Lib)
- [Bluefruit BLECharacteristic API](https://github.com/adafruit/Adafruit_nRF52_Arduino/blob/master/libraries/Bluefruit52Lib/src/BLECharacteristic.h)
- [Adafruit Bluefruit nRF52 API guide](https://learn.adafruit.com/bluefruit-nrf52-feather-learning-guide/bluefruit-nrf52-api)
- [GxEPD2](https://github.com/ZinggJM/GxEPD2)

Это проверка API/сборки/программного протокола. Host-тесты, ELF и исполнение GPIO/SPI в Unicorn не запускают реальный SoftDevice, радиоканал или обновление e-ink.
