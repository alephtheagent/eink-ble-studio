# E-Ink Studio

Локальный редактор 122×250 и BLE-прошивка для nRF52840 Pro Micro / nice!nano v2-совместимой платы с WeAct 2.13 **BW GxEPD2_213_BN**. Никаких серверных загрузок изображений, внешних CDN, аккаунтов или runtime-зависимостей сайта.

## Редактор

Публичный редактор: **https://alephtheagent.github.io/eink-studio/**. Исходники: **https://github.com/alephtheagent/eink-ble-studio**.

Статический сайт находится в `web/`; все ссылки относительные. Публичная копия размещена в отдельном каталоге `eink-studio/` Pages-репозитория `alephtheagent/alephtheagent.github.io`; его остальные страницы не изменяются. В публичном `app.js` утверждённый PNG встроен как data URL без изменения его байтов.

GitHub MCP передаёт только UTF-8: бинарные файлы опубликованы в `binary-assets.json` как base64 с SHA256, без потери данных. После клонирования сначала восстановить их:

```sh
python3 tools/restore_assets.py
```

Команда восстанавливает PNG/fixtures и готовые firmware-артефакты; токены, node_modules, scratch и журналы машины в публикацию не входят. `REPORT.md` описывает локальные проверки до публикации, а не аппаратную проверку BLE.

```sh
npm run serve
# http://localhost:8080
```

Открыть PNG/JPEG/WebP и другие форматы, которые декодирует браузер. Preview — интерактивное поле кадрирования: drag мышью/касанием, точные X/Y в native-пикселях, масштаб числом, колесом или двухпальцевым pinch; клавиши стрелок двигают на 1 px, Shift+стрелка на 10 px, +/− меняют масштаб. Поле можно сфокусировать Tab. Меню File/Edit/Display работают, Escape закрывает меню. Поворот по 90°, fit/contain, cover/crop, fill/stretch, вертикальное и двумерное повторение. Вертикальный repeat принудительно перекрывает ширину; 2D repeat оборачивается по обеим осям. Размер плитки — ширина в native px, X/Y — фаза повтора. Fit оставляет белые поля намеренно; repeat — нет.

Brightness, contrast, threshold, inversion; без dithering, Floyd–Steinberg и ordered Bayer 4×4. Предпросмотры показывают именно итоговый бинарный кадр: native 122×250 и увеличенную копию без сглаживания. Save PNG экспортирует native чёрно-белые пиксели (PNG RGBA, не обещается 1-bit PNG-контейнер); Save frame — ровно 4000 байт. Approved reference открывает утверждённое изображение с нейтральными настройками. Для него проверено точное побайтное соответствие, в том числе repeat при ширине плитки 122.

Для отправки: Connect → выбрать `Eink Studio` → Send to display. Прогресс означает подтверждённые устройством байты; после 4000 байт отдельно ожидается завершение драйвера обновления. Ошибка не выдаётся за успех. При обрыве — reconnect и новая передача. Изображение, отправляемое на плату, фиксируется при нажатии Send; дальнейшее редактирование его не меняет.

Web Bluetooth требует HTTPS либо localhost, поддерживаемый Chromium и Bluetooth-разрешения ОС. Основная целевая среда — Android Chrome и совместимые desktop Chromium; Linux/ОС могут иметь дополнительные ограничения Web Bluetooth. iOS/Safari и Firefox не поддерживают этот канал отправки. В них остаются редактор/скачивание; UI проверяет наличие API. Ограничения: [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

**Безопасность:** приложение не требует BLE pairing/шифрования/аутентификации. Ближайший сторонний BLE-клиент может заменить экран. CRC32 — проверка целостности, не криптозащита. После reset bitmap в RAM не сохраняется; изображение удерживает сама e-ink панель.

## Прошивка

За основу взяты board profile, repin variant и библиотеки проверенного локального проекта; исходный проект не изменялся. Сохранены S140 **6.1.1**, application origin **0x26000**, приложение ниже **0xED000**, UF2 family **0xADA52840**. Нет миграции bootloader/layout и нет включённого в UF2 SoftDevice/bootloader. Артефакт предназначен только для уже совместимого bootloader/S140, не универсален для любой платы с nRF52840.

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

```sh
pio run -d firmware -e repin_bw
# Только сборка, НЕ upload.
python3 -m pip install pyelftools==0.32 unicorn==2.1.4
python3 tools/package_firmware.py
```

`firmware/platformio.ini` хранит build/libdeps во внешнем scratch-каталоге этой машины; при переносе изменить эти два пути на доступный каталог. Пакетировщик берёт путь из INI, проверяет ELF/UF2 и исполняет связанные ARM-функции GPIO/SPI в Unicorn, затем создаёт UF2 ZIP. Unicorn MMIO — память, не электроника/SoftDevice/дисплей. Пакетировщик ничего не прошивает и не ищет устройства.

## Проверки

```sh
npm ci
npm test
# JS conversion/CRC + fake BLE + DOM/native-canvas UI; C++ ASan/UBSan protocol.
# Дополнительная реальная UI-проверка, только Firefox:
npx playwright install firefox
npm run serve
STUDIO_URL=http://127.0.0.1:8080 node tools/smoke_firefox.js
```

Node.js 22+; Python 3; g++; PlatformIO. Runtime сайта не требует npm. npm-пакеты — только dev-зависимости проверки, версии разрешены lockfile. Общие JS/C++ vectors — `tests/vectors.json`, утверждённый PNG/4000-byte frame — `tests/fixtures/`. Native canvas/DOM тест не эквивалентен визуальной проверке браузера; фактически выполненные проверки и ограничения перечислены в `REPORT.md`.

Артефакты: `artifacts/eink-ble-bw-s140v6.uf2`, `artifacts/eink-ble-bw-s140v6.zip`, ELF/HEX/BIN, `verification.json` с SHA256 и результатами исполнения ARM. ZIP содержит только UF2. Не путать его с внутренним PlatformIO DFU ZIP во внешнем build-каталоге.

`firmware/sanitize_paths.py` сохраняет basename `__FILE__` для диагностики assertions без абсолютных путей аккаунта сборочной машины. Это PlatformIO middleware для закреплённого GCC 7, который не поддерживает `-ffile-prefix-map`; аппаратные настройки и assertions не отключаются. Экспортируемый ELF не содержит debug records; пакетировщик проверяет отсутствие `/home/` в ELF/BIN.
