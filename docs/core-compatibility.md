# Adafruit nRF52 core compatibility

Сборка использует PlatformIO `framework-arduinoadafruitnrf52@1.10601.0`, resolved `1.10601.0+sha.0fd295f1`, не ArduinoBLE и не ESP32 BLE. BLE реально связан с приложением: `Bluefruit.begin()`, primary service, write characteristic, read status, advertising и restart-on-disconnect.

Проверены исходники установленного пакета:

- `libraries/Bluefruit52Lib/src/bluefruit.cpp`: перед `Bluefruit.begin()` используется `configPrphConn(247, BLE_GAP_EVENT_LENGTH_DEFAULT, BLE_GATTS_HVN_TX_QUEUE_SIZE_DEFAULT, BLE_GATTC_WRITE_CMD_TX_QUEUE_SIZE_DEFAULT)`. Без exchange остаётся MTU23. Per-read caps вычисляет `min(getMtu()-3,244)`, с безопасными20 при недоступном соединении. Результаты begin/GATT/advertising проверяются.
- `BLECharacteristic.h/.cpp`: `setWriteAuthorizeCallback(callback, false)` включает write authorization и отключает deferred AdaCallback для этого обработчика. Обработчик вызывается непосредственно BLE event task. Статус записывается в GATT **до** `sd_ble_gatts_rw_authorize_reply`, поэтому ATT response не обгоняет application ACK. Используются обычные write requests, не write command/prepared writes.
- S140 `cores/nRF5/nordic/softdevice/s140_nrf52_6.1.1_API/include/ble_gatts.h`, `ble_gatts_authorize_params_t` (lines 299–305): WRITE authorization **must** set `update` and supply the value. Fixed the previous zero-initialized success reply (`update=0`, no data). Callback now forwards the request bytes and checks `sd_ble_gatts_rw_authorize_reply` return code. `tests/authorize_arm.py` executes the linked callback and receiver up to that actual SVC boundary to check emitted API parameters, including a full 4000-byte CRC-checked frame. Separate branch tests continue the linked callback with injected success or failure return values to check that deferred actions are armed or cleared; they do **not** execute the SoftDevice or verify RF behavior.
- `BLECharacteristic::write` returns 0 on `sd_ble_gatts_value_set` failure and the written length on success; firmware checks all 20 status bytes before sending a success reply. A failed status publication or authorization reply terminates the uncertain connection. Serial logs are queued without blocking the BLE event task.
- `setPermission(SECMODE_NO_ACCESS, SECMODE_OPEN)` для command и обратный порядок для status: без security requirement. V1 max20; command2 max244; status/status2/caps fixed20. UUID используют одну vendor base; `configUuid128Count(3)` достаточно.
- `Bluefruit.Periph.setDisconnectCallback` сообщает disconnect; при receiving протокол отбрасывает незавершённую передачу. Advertising перезапускается. Один peripheral link по умолчанию `Bluefruit.begin()`.
- FreeRTOS mutex защищает protocol state, packet buffer mutation и публикацию status между BLE event task, callback disconnect и loop. Во время долгого refresh mutex не удерживается; новые START/ABORT/DATA не могут изменить committed frame.
- `GxEPD2_213_BN` использует ограниченное ожидание BUSY в базовом GxEPD2 драйвере. `done` означает, что последовательность драйвера вернулась; это не оптическое подтверждение того, что панель подключена или физически обновилась. Для окончательной проверки нужен дисплей.
- Board profile сохраняет `S140`, `6.1.1`, FWID `0x00B6`; `board_build.ldscript` выбирает локальный `eink_s140_v6.ld` с origin `0x26000` и концом FLASH `0xEC000`, оставляя следующий сектор состоянию welcome. Скрипт включает неизменённый core `nrf52_common.ld`; InternalFileSystem начинается с `0xED000`. Core определяет SoftDevice/radio startup. S140 v7 или bootloader не подменяются.
- `variants/promicro_repin/variant.cpp` сохраняет проверенный `g_ADigitalPinMap`, VCC enable preload HIGH; `SPI.begin()` использует core `SPIClass` с аппаратным SPIM3. Пакетировщик проверяет связанный код, а не только текст этих настроек.
- Core перехватывает PREP/EXEC до application authorizer. Проектный `sanitize_paths.py` компилирует private patched core sources, не меняя установленный package: PREP reject до allocation; EXEC NOW/CANCEL reject один раз до broadcast. `tests/core_arm.py` исполняет связанные guards до SVC и запрещает allocator/application-parser entry. Это не тест SoftDevice/RF hostile traffic. Полный wire contract — [protocol-v2.md](protocol-v2.md).

Первичные upstream материалы (фактическая компиляция выполнена с локально закреплённой версией выше):

- [Adafruit nRF52 Arduino core / Bluefruit52Lib](https://github.com/adafruit/Adafruit_nRF52_Arduino/tree/master/libraries/Bluefruit52Lib)
- [Bluefruit BLECharacteristic API](https://github.com/adafruit/Adafruit_nRF52_Arduino/blob/master/libraries/Bluefruit52Lib/src/BLECharacteristic.h)
- [Adafruit Bluefruit nRF52 API guide](https://learn.adafruit.com/bluefruit-nrf52-feather-learning-guide/bluefruit-nrf52-api)
- [GxEPD2](https://github.com/ZinggJM/GxEPD2)

Это проверка API/сборки/программного протокола. Host-тесты, ELF и исполнение GPIO/SPI в Unicorn не запускают реальный SoftDevice, радиоканал или обновление e-ink.
