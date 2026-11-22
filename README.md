# E-Ink Studio

Локальный редактор 122×250 и BLE-прошивка для nRF52840 Pro Micro / nice!nano v2-совместимой платы с WeAct 2.13 **BW GxEPD2_213_BN**. Никаких серверных загрузок изображений, внешних CDN, аккаунтов или runtime-зависимостей сайта.

## Редактор

Статический сайт находится в `web/`; этот каталог является корнем будущего GitHub Pages сайта. Все ссылки относительные, поэтому поддерживается публикация в подкаталоге. Публикация здесь не выполнялась.

```sh
npm run serve
# http://localhost:8080
```

Открыть PNG/JPEG/WebP и другие форматы, которые декодирует браузер. Preview — интерактивное поле кадрирования: drag мышью/касанием, точные X/Y в native-пикселях, масштаб числом, колесом или двухпальцевым pinch; клавиши стрелок двигают на 1 px, Shift+стрелка на 10 px, +/− меняют масштаб. Поле можно сфокусировать Tab. Меню File/Edit/Display работают, Escape закрывает меню. Поворот по 90°, fit/contain, cover/crop, fill/stretch, вертикальное и двумерное повторение. Вертикальный repeat принудительно перекрывает ширину; 2D repeat оборачивается по обеим осям. Размер плитки — ширина в native px, X/Y — фаза повтора. Fit оставляет белые поля намеренно; repeat — нет.

Brightness, contrast, threshold, inversion; без dithering, Floyd–Steinberg и ordered Bayer 4×4. Предпросмотры показывают именно итоговый бинарный кадр: native 122×250 и увеличенную копию без сглаживания. Save PNG экспортирует native чёрно-белые пиксели (PNG RGBA, не обещается 1-bit PNG-контейнер); Save frame — ровно 4000 байт. Approved reference открывает утверждённое изображение с нейтральными настройками. Для него проверено точное побайтное соответствие, в том числе repeat при ширине плитки 122.

Текст добавляется через Edit → Add text или кнопку Add text в окне Image; File → Text only создаёт белый фон. Настройки появляются в раскрываемой секции Text layers окна Adjustments. Можно выбрать текстовый слой или изображение, менять порядок текстовых слоёв, удалять их, отменять и повторять действия. При выбранном тексте drag/касание и стрелки двигают слой; +/−, колесо и pinch меняют целочисленный масштаб bitmap-шрифта. Размер блока, перенос абзацев, выравнивание, положение, поворот, цвет, фон и прозрачность настраиваются отдельно. Edit → Fine image rotation открывает произвольный поворот изображения; прежняя кнопка Rotate 90° сохранена. Предупреждения сообщают об отсутствующих глифах и выходе за границы.

Шрифты работают локально, содержат кириллицу; меню показывает каждое имя собственным растром и фактический размер ячейки. Исходные BDF и лицензии находятся в `web/fonts/`, генератор — `tools/generate_fonts.js`. Текст накладывается после обработки фотографии без сглаживания; прозрачность реализована детерминированным бинарным покрытием, не серыми пикселями. Один итоговый кадр используется для обоих preview, PNG, файла кадра и BLE; шесть неиспользуемых битов каждой строки остаются нулевыми.

Для отправки: Connect → выбрать `Eink Studio` → Send to display. BLE v2 используется при наличии характеристик capabilities, иначе применяется v1; v2 может передавать сжатые данные PackBits. Прогресс означает подтверждённые байты передачи (для v2 их число может быть меньше 4000), после передачи отдельно ожидается завершение драйвера обновления. Ошибка не выдаётся за успех. При обрыве — reconnect и новая передача. Изображение, отправляемое на плату, фиксируется при нажатии Send; дальнейшее редактирование его не меняет. Аппаратная проверка этого изменения не заявляется.

Web Bluetooth требует HTTPS либо localhost, поддерживаемый Chromium и Bluetooth-разрешения ОС. Основная целевая среда — Android Chrome и совместимые desktop Chromium; Linux/ОС могут иметь дополнительные ограничения Web Bluetooth. iOS/Safari и Firefox не поддерживают этот канал отправки. В них остаются редактор/скачивание; UI проверяет наличие API. Ограничения: [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

**Безопасность:** приложение не требует BLE pairing/шифрования/аутентификации. Ближайший сторонний BLE-клиент может заменить экран, сбросить состояние welcome или перевести устройство в UF2 DFU. CRC32 — проверка целостности, не криптозащита. После reset bitmap в RAM не сохраняется, но e-ink удерживает физическую картинку: при совпадающем состоянии текущей сборки прошивка панель не инициализирует.

### Firmware update

File → Firmware update или кнопка рядом с подключением открывает отдельную секцию. Update to latest запрашивает **последний** release `alephtheagent/eink-ble-studio`, ищет `-dfu.zip` и проверяет application-only manifest. Наличие `manifest.dfu_version: 0.5` выбирает **Legacy DFU 0.5 (Adafruit)** — транспорт nice!nano с Adafruit nRF52 bootloader; без `dfu_version` используется Nordic Secure DFU. Другие legacy-версии и пакеты с SoftDevice/bootloader отклоняются. Выбранный транспорт показывается перед передачей; более старый релиз автоматически не выбирается. Текущая версия прошивки неизвестна. Пакет и понимание риска необходимо подтвердить до Flash firmware.

Enter DFU отправляет `0x05` и ждёт отключения; одно отключение не доказывает запуск загрузчика. На старой прошивке можно нажать RESET дважды. После входа в DFU на Flash firmware нужно **повторно выбрать загрузчик** в браузерном chooser. Он показывает оба сервиса: legacy `00001530-1212-efde-1523-785feabcd123` и Secure `0xFE59`; транспорт определяется пакетом, не именем устройства. Legacy передаёт пакеты по 20 байт, PRN=8 (Adafruit OTA требует **PRN ≤ 8**). При прерывании **single-bank** обновления нет резервного приложения: плата может остаться в загрузчике, потребуется повторить обновление совместимым пакетом. Отмена не закрывает системный chooser — его нужно закрыть вручную. Все библиотеки локальные: `web/legacy-dfu.js` и `web/vendor/`, без CDN.

В предыдущем прогоне GitHub API latest ответил 404; загрузка release asset может блокироваться CORS. В этом изменении сеть и публикация не выполнялись: интеграция проверена локально в Chromium с реальным 146712-байтовым образом и fake GATT, включая CRC16-CCITT, PRN и reset. Реальная прошивка по BLE не выполнялась; совместимость физического загрузчика и CORS целевого asset пока не подтверждены. Подробности: `OTA-REPORT.md`.


## Прошивка

За основу взяты board profile, repin variant и библиотеки проверенного локального проекта; исходный проект не изменялся. Сохранены S140 **6.1.1**, application origin **0x26000**, UF2 family **0xADA52840**. Локальный linker ограничивает приложение адресом ниже **0xEC000**; сектор `0xEC000–0xECFFF` выделен под состояние welcome. Bootloader и SoftDevice не включены в UF2 и не меняются. Артефакт предназначен только для уже совместимого bootloader/S140, не универсален для любой платы с nRF52840.

| Сигнал | Физический GPIO | Arduino index |
| --- | --- | --- |
| MOSI / DIN | P0.09 | 10 |
| SCK / CLK | P1.06 | 9 |
| DC | P1.04 | 8 |
| CS | P0.10 | 16 |
| BUSY | P0.11 | 7 |
| RES | P1.11 | 14 |
| MISO, не подключать | P0.22 | 4 |
| VCC enable | P0.13 HIGH | прямой GPIO в initVariant |

Аппаратный `SPI` / SPIM3, 4 MHz, mode 0, MSB first. MISO **не назначается на RES**. `initVariant()` сначала поднимает latch P0.13 HIGH, затем включает выход; перед SPI/display init есть задержка 250 ms. Не подавать 5V/RAW на дисплей.

`CONFIG_NFCT_PINS_AS_GPIOS` сохранён в board JSON: используемые NFC-совместимые выводы должны работать как GPIO. Ядро может изменить UICR NFCPINS и выполнить reset при первом запуске. Это постоянная настройка MCU; смена bootloader для неё не нужна. Кадры во flash не записываются.

BLE реализован встроенной в **Adafruit nRF52 Arduino** библиотекой Bluefruit52Lib, не заглушкой UART/Serial. Зафиксированы platform `nordicnrf52@11.0.0`, framework package `1.10601.0` (разрешённая версия `1.10601.0+sha.0fd295f1`), GxEPD2 `1.6.9`, Adafruit GFX `1.12.4`, BusIO `1.17.4`. Подробности проверки API: [docs/core-compatibility.md](docs/core-compatibility.md). Формат/UUID/команды/ACK/ошибки: [docs/protocol.md](docs/protocol.md).

Добавлен [v2: MTU и PackBits/raw fallback](docs/protocol-v2.md), не заменяющий v1. Firmware разрешает MTU до247; Web Bluetooth использует динамические firmware capabilities (`safeWrite20..244`), а не вымышленный JS MTU API. При отсутствии capabilities старой firmware — v1. При ошибке расширенной записи — disconnect/reconnect, новый ID и `force20: true`. Итог интеграции и ограничения: [REPORT-V2.md](REPORT-V2.md).

Стартовый экран — точный bitmap из `assets/approved-welcome.png`, без значка монитора и без ложного Ready. При пустом или повреждённом состоянии либо другом build ID он отрисовывается до advertising, после чего панель hibernate и состояние записывается с CRC; при совпадении панель и SPI не инициализируются. Каждая сборка получает новый случайный 32-битный ID через compiler define (коллизия возможна). Команда `05` сбрасывает состояние для следующего reset, `06` запускает UF2 DFU после подтверждения; подробности и v2 opcodes — в [протоколе](docs/protocol.md#commands). Генератор `python3 tools/welcome_bitmap.py generate`; упаковщик сравнивает все пиксели PNG, 5× preview и реально связанного ELF. Загружаемые изображения не сохраняются во flash.

BLE timeout содержит точный этап (`write START2`, `read ack DATA2 offset N`, `refresh read status`; аналогичные v1 stages сохранены). USB serial 115200 выводит stage/state/error и результат authorize SDK; [диагностика](docs/protocol.md#diagnostics-no-wire-format-change). Таймаут GATT не увеличен. Для другого редактора копируется только `web/ble.js`, при совместимых `image.js` exports; GUI не менялся. V2 progress считает encoded bytes. Подробности callback metadata и безопасного fallback — в [контракте v2](docs/protocol-v2.md#client-integration-and-compatibility).

```sh
pio run -d firmware -e repin_bw
# Только сборка, НЕ upload.
python3 -m pip install pyelftools==0.33 unicorn==2.1.4
python3 tools/package_firmware.py
```

`firmware/platformio.ini` хранит build/libdeps в отдельном scratch-каталоге `eink-ble-fix-build`; при переносе изменить эти пути. Пакетировщик проверяет ELF/UF2/ZIP и welcome, исполняет ARM GPIO/SPI, v1/v2 authorize regression и core PREP/EXEC/capabilities smoke (`tests/authorize_arm.py`, `tests/core_arm.py`). Проверки параметров authorization останавливаются на настоящей SVC; отдельные branch-тесты продолжают связанный callback с подставленными результатами успеха или ошибки, проверяя постановку и отмену deferred action. SoftDevice и RF не исполняются и этими тестами не проверяются. MMIO — память, не электроника/радио/дисплей. Пакетировщик ничего не прошивает и не ищет устройства.

## Проверки

```sh
npm ci
npm test
# JS conversion/CRC + fake BLE + DOM/native-canvas UI; C++ ASan/UBSan protocol and host boot-state scenarios.
node tools/measure_v2.mjs
node tools/smoke_v2.mjs
# Production JS → native C++ receiver, simulated GATT/driver return, not RF.
# Дополнительная реальная UI-проверка, только Firefox:
npx playwright install firefox
npm run serve
STUDIO_URL=http://127.0.0.1:8080 node tools/smoke_firefox.js
```

Node.js 22+; Python 3; g++; PlatformIO. Runtime сайта не требует npm. npm-пакеты — только dev-зависимости проверки, версии разрешены lockfile. Общие JS/C++ vectors — `tests/vectors.json`, утверждённый PNG/4000-byte frame — `tests/fixtures/`. Native canvas/DOM тест не эквивалентен визуальной проверке браузера. Проверки, ограничения и скриншоты текущего дополнения описаны в `ADDITIVE-REPORT.md`; `REPORT.md` сохраняет исторический отчёт предыдущего релиза.

Артефакты предыдущей MTU/compression-сборки сохранены: `artifacts/eink-ble-v2-bw-s140v6.{uf2,zip,elf,hex,bin}` и `artifacts/verification-v2.json`; они не заменяются новой сборкой welcome-once/DFU. Новые артефакты `artifacts/eink-ble-welcome-once-dfu-bw-s140v6.{uf2,zip,elf,hex,bin}` и `artifacts/verification-welcome-once-dfu.json` формируются `npm run package:firmware` после `pio run -d firmware -e repin_bw`. После `pip install adafruit-nrfutil` команда `NRFUTIL=adafruit-nrfutil npm run package:dfu` создаёт application-only `artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip`. Это legacy DFU 0.5 пакет с CRC16, **не криптографически подписанный**; HEX/BIN, manifest, init packet и ZIP целостность автоматически сверяются `tools/dfu_package.py`. Workflow, выпуск по тегу и дополнительное имя `-dfu.zip` для OTA описаны в [docs/ci.md](docs/ci.md).

`firmware/sanitize_paths.py` сохраняет basename `__FILE__` для диагностики assertions без абсолютных путей аккаунта сборочной машины. Это PlatformIO middleware для закреплённого GCC 7, который не поддерживает `-ffile-prefix-map`; аппаратные настройки и assertions не отключаются. Экспортируемый ELF не содержит debug records; пакетировщик проверяет отсутствие `/home/` в ELF/BIN.

Тот же middleware компилирует private copies закреплённых Bluefruit `BLECharacteristic.cpp`/`BLEGatt.cpp`: PREP отклоняется до1024-byte allocator, EXEC NOW/CANCEL — один раз до handle-less broadcast. Общий установленный framework не редактируется. Смена ожидаемых core anchors останавливает сборку, а не оставляет небезопасный fallback.
