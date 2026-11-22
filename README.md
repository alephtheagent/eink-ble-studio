# E-Ink Studio

Локальный редактор 122×250 и BLE-прошивка для nRF52840 Pro Micro / nice!nano v2-совместимой платы с WeAct 2.13 **BW GxEPD2_213_BN**. Текущая версия приложения — **1.1.0** (`package.json`). Legacy DFU `application_version: 1` — отдельное целочисленное поле формата uint32, не отображающее SemVer. Никаких серверных загрузок изображений, внешних CDN, аккаунтов или runtime-зависимостей сайта.

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
Переключатели Image / Text / Draw позволяют редактировать текст прямо на виртуальном экране и рисовать карандашом или ластиком. Страницы создаются, дублируются, удаляются и переставляются локально; Import images as pages применяет общие настройки пакетного импорта. Save project / Open project сохраняют и восстанавливают редактируемые слои. Get pages перед заменой локальной работы предлагает сохранить проект, заменить или отменить; полученные с устройства страницы открываются как растры: прежний текст нельзя редактировать как текст, но поверх можно добавить новые слои. Удаление на устройстве выполняется только при Send changes. Язык English / Русский выбирается в шапке и сохраняется локально.

Синхронизация использует [версионированное расширение страниц](docs/protocol-pages.md), сравнивает CRC, ревизии и порядок и отправляет изменённые кадры. Изменения фиксируются по отдельности, не как одна атомарная пачка. При конфликте или прерванной связи необходимо сверить состояние, прежде чем продолжить. Перед обновлением прошивки получите страницы и сохраните проект: сохранность области страниц при UF2 и BLE OTA не доказана.


Для отправки: Connect → выбрать `Eink Studio` → Send to display. BLE v2 используется при наличии характеристик capabilities, иначе применяется v1; v2 может передавать сжатые данные PackBits. Прогресс означает подтверждённые байты передачи (для v2 их число может быть меньше 4000), после передачи отдельно ожидается завершение драйвера обновления. Ошибка не выдаётся за успех. При обрыве — reconnect и новая передача. Изображение, отправляемое на плату, фиксируется при нажатии Send; дальнейшее редактирование его не меняет. Аппаратная проверка этого изменения не заявляется.

Web Bluetooth требует HTTPS либо localhost, поддерживаемый Chromium и Bluetooth-разрешения ОС. Основная целевая среда — Android Chrome и совместимые desktop Chromium; Linux/ОС могут иметь дополнительные ограничения Web Bluetooth. iOS/Safari и Firefox не поддерживают этот канал отправки. В них остаются редактор/скачивание; UI проверяет наличие API. Ограничения: [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

**Безопасность:** приложение не требует BLE pairing/шифрования/аутентификации. Ближайший сторонний BLE-клиент может заменить экран, сбросить состояние welcome или перевести устройство в UF2 DFU. CRC32 — проверка целостности, не криптозащита. После reset bitmap в RAM не сохраняется, но e-ink удерживает физическую картинку: при совпадающем состоянии текущей сборки прошивка панель не инициализирует.

### Firmware update

File → Firmware update или кнопка рядом с подключением открывает отдельную секцию. Update to latest запрашивает **последний** release `alephtheagent/eink-ble-studio`, ищет `-dfu.zip` и проверяет application-only manifest. Наличие `manifest.dfu_version: 0.5` выбирает **Legacy DFU 0.5 (Adafruit)** — транспорт nice!nano с Adafruit nRF52 bootloader; без `dfu_version` используется Nordic Secure DFU. Другие legacy-версии и пакеты с SoftDevice/bootloader отклоняются. Выбранный транспорт показывается перед передачей; более старый релиз автоматически не выбирается. Текущая версия прошивки неизвестна. Пакет и понимание риска необходимо подтвердить до Flash firmware.

Enter DFU отправляет `0x05` и ждёт отключения; одно отключение не доказывает запуск загрузчика. На старой прошивке можно нажать RESET дважды. После входа в DFU на Flash firmware нужно **повторно выбрать загрузчик** в браузерном chooser. Он показывает оба сервиса: legacy `00001530-1212-efde-1523-785feabcd123` и Secure `0xFE59`; транспорт определяется пакетом, не именем устройства. Legacy передаёт пакеты по 20 байт, PRN=8 (Adafruit OTA требует **PRN ≤ 8**). При прерывании **single-bank** обновления нет резервного приложения: плата может остаться в загрузчике, потребуется повторить обновление совместимым пакетом. Отмена не закрывает системный chooser — его нужно закрыть вручную. Все библиотеки локальные: `web/legacy-dfu.js` и `web/vendor/`, без CDN.

В предыдущем прогоне GitHub API latest ответил 404; загрузка release asset может блокироваться CORS. В этом изменении сеть и публикация не выполнялись: интеграция проверена локально в Chromium с реальным 146712-байтовым образом и fake GATT, включая CRC16-CCITT, PRN и reset. Реальная прошивка по BLE не выполнялась; совместимость физического загрузчика и CORS целевого asset пока не подтверждены. Подробности: `OTA-REPORT.md`.


## Прошивка

За основу взяты board profile, repin variant и библиотеки проверенного локального проекта; исходный проект не изменялся. Сохранены S140 **6.1.1**, application origin **0x26000**, UF2 family **0xADA52840**. Приложение ограничено адресом ниже **0xCC000**; `0xCC000–0xEBFFF` зарезервировано под страницы, `0xEC000–0xECFFF` — под состояние welcome, внутренняя файловая система начинается с `0xED000`. Два из 32 секторов страниц содержат метаданные, 30 — кадры; один кадр резервируется под copy-on-write, поэтому максимум одновременно сохранённых страниц — **29**. Bootloader и SoftDevice не включены в UF2. Совместимость с конкретным установленным bootloader и его политика erase физически не подтверждены.

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

`CONFIG_NFCT_PINS_AS_GPIOS` сохранён в board JSON: используемые NFC-совместимые выводы должны работать как GPIO. Ядро может изменить UICR NFCPINS и выполнить reset при первом запуске. Это постоянная настройка MCU; смена bootloader для неё не нужна.

BLE реализован встроенной в **Adafruit nRF52 Arduino** библиотекой Bluefruit52Lib, не заглушкой UART/Serial. Зафиксированы platform `nordicnrf52@11.0.0`, framework package `1.10601.0` (разрешённая версия `1.10601.0+sha.0fd295f1`), GxEPD2 `1.6.9`, Adafruit GFX `1.12.4`, BusIO `1.17.4`. Подробности проверки API: [docs/core-compatibility.md](docs/core-compatibility.md). Формат/UUID/команды/ACK/ошибки: [docs/protocol.md](docs/protocol.md).

Добавлен [v2: MTU и PackBits/raw fallback](docs/protocol-v2.md), не заменяющий v1. Firmware разрешает MTU до247; Web Bluetooth использует динамические firmware capabilities (`safeWrite20..244`), а не вымышленный JS MTU API. При отсутствии capabilities старой firmware — v1. При ошибке расширенной записи — disconnect/reconnect, новый ID и `force20: true`. Итог интеграции и ограничения: [REPORT-V2.md](REPORT-V2.md).

Стартовый экран — точный bitmap из `assets/approved-welcome.png`, без значка монитора и без ложного Ready. При пустом или повреждённом состоянии либо другом build ID он отрисовывается до advertising, после чего панель hibernate и состояние записывается с CRC; при совпадении панель и SPI не инициализируются. Каждая сборка получает новый случайный 32-битный ID через compiler define (коллизия возможна). Команда `05` сбрасывает состояние для следующего reset, `06` запускает UF2 DFU после подтверждения; подробности и v2 opcodes — в [протоколе](docs/protocol.md#commands). Генератор `python3 tools/welcome_bitmap.py generate`; упаковщик сравнивает все пиксели PNG, 5× preview и реально связанного ELF.

BLE timeout содержит точный этап (`write START2`, `read ack DATA2 offset N`, `refresh read status`; аналогичные v1 stages сохранены). USB serial 115200 выводит stage/state/error и результат authorize SDK; [диагностика](docs/protocol.md#diagnostics-no-wire-format-change). V2 progress считает encoded bytes. Подробности callback metadata и безопасного fallback — в [контракте v2](docs/protocol-v2.md#client-integration-and-compatibility).

```sh
pio run -d firmware -e repin_bw
# Только сборка, НЕ upload.
python3 -m pip install pyelftools==0.33 unicorn==2.1.4
python3 tools/package_firmware.py
```

`firmware/platformio.ini` хранит build/libdeps в `firmware/.pio/`. Пакетировщик проверяет ELF/UF2/ZIP и welcome, исполняет ARM GPIO/SPI, v1/v2 authorize regression и core PREP/EXEC/capabilities smoke (`tests/authorize_arm.py`, `tests/core_arm.py`). Проверки параметров authorization останавливаются на настоящей SVC; отдельные branch-тесты продолжают связанный callback с подставленными результатами успеха или ошибки. SoftDevice и RF не исполняются и этими тестами не проверяются. MMIO — память, не электроника/радио/дисплей. Пакетировщик ничего не прошивает и не ищет устройства.

## Проверки

```sh
npm ci
npm test
# JS conversion/CRC, DOM, page client → native endpoint and C++ host flash tests.
npx playwright install chromium
node tools/task-ui.mjs
node tools/task-sync.mjs
# Browser UI → native C++ endpoint over simulated GATT; not RF or hardware.
```

Node.js 22+; Python 3; g++; PlatformIO. Runtime сайта не требует npm. npm-пакеты — только dev-зависимости проверки, версии разрешены lockfile. Общие JS/C++ vectors — `tests/vectors.json`, утверждённый PNG/4000-byte frame — `tests/fixtures/`. Native canvas/DOM тест не эквивалентен визуальной проверке браузера. Актуальные результаты и ограничения — [TASK-REPORT.md](TASK-REPORT.md), свежие логи и скриншоты — `artifacts/task-verification/`; `ADDITIVE-REPORT.md`, `REPORT.md` и `REPORT-V2.md` — исторические отчёты.
Подробности: [редактор](docs/editor.md), [локализация](docs/localization.md), [протокол страниц](docs/protocol-pages.md), [flash-хранилище](docs/storage.md).

Свежая проверенная сборка этого задания находится в `artifacts/task-verification/`: ELF, HEX, BIN, UF2, ZIP и `verification-welcome-once-dfu.json`, а также `*-dfu.zip` и `dfu-verification.json`. `npm run package:firmware` и `npm run package:dfu` по умолчанию пишут в `artifacts/`; для отдельного каталога используйте `ARTIFACTS_DIR` для UF2 и явные пути `--output`/`--result` для `tools/dfu_package.py`. Legacy DFU 0.5 содержит CRC16, но **не криптографическую подпись**. Старые `artifacts/eink-ble-v2-*` и `artifacts/eink-ble-welcome-once-*` не являются результатами текущего прогона. Workflow и версия DFU описаны в [docs/ci.md](docs/ci.md).

`firmware/sanitize_paths.py` сохраняет basename `__FILE__` для диагностики assertions без абсолютных путей аккаунта сборочной машины. Это PlatformIO middleware для закреплённого GCC 7, который не поддерживает `-ffile-prefix-map`; аппаратные настройки и assertions не отключаются. Экспортируемый ELF не содержит debug records; пакетировщик проверяет отсутствие `/home/` в ELF/BIN.

Тот же middleware компилирует private copies закреплённых Bluefruit `BLECharacteristic.cpp`/`BLEGatt.cpp`: PREP отклоняется до1024-byte allocator, EXEC NOW/CANCEL — один раз до handle-less broadcast. Общий установленный framework не редактируется. Смена ожидаемых core anchors останавливает сборку, а не оставляет небезопасный fallback.
