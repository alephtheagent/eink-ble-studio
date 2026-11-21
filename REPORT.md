# Локальный результат

## Пути и границы работы

- Рабочий проект: `/home/aleph/eink-ble-studio`.
- Статический сайт: `/home/aleph/eink-ble-studio/web`.
- UF2: `/home/aleph/eink-ble-studio/artifacts/eink-ble-bw-s140v6.uf2`.
- ZIP с единственным UF2: `/home/aleph/eink-ble-studio/artifacts/eink-ble-bw-s140v6.zip`.
- ELF/HEX/BIN и проверка: тот же каталог `artifacts/`, файл `verification.json`.
- Исходный `/home/aleph/eink-nrf52840-test` использован только для чтения/копирования необходимых board/variant файлов и утверждённого PNG. Его файлы не редактировались.
- Создан отдельный локальный Git-репозиторий, без remote/push/публикации. Прошивка платы, смена bootloader, OMP config/роли не выполнялись.

## Реализовано

Редактор — рабочая поверхность, без landing/hero/CDN: монохромные окна, функциональные File/Edit/Display меню, клавиатурное управление, responsive одноколоночная компоновка на узком экране, touch targets от 44 px. Локальное открытие изображений, интерактивная область кадрирования, drag мышью/касанием, двухпальцевый zoom, колесо, точные X/Y и zoom, 90° rotations, fit/contain, cover/crop, fill/stretch, vertical и 2D repeats с размером/фазой. Brightness/contrast/threshold, inversion, реальные none/Floyd–Steinberg/Bayer. Native 122×250 preview и увеличенная pixelated копия. PNG и raw frame downloads. Кнопка Approved reference загружает утверждённый кадр с нейтральными настройками.

Проверено точное соответствие утверждённому native PNG: экспорт 4000 байт, CRC32 `0x1DF76780`, совпадение каждого декодированного PNG-пикселя. Pure image tests дополнительно проверяют native repeat reference с tile width 122. PNG-контейнер RGBA с бинарными BW-пикселями, а не обещанный 1-bit PNG-контейнер.

Прошивка использует настоящий Bluefruit peripheral/service/characteristics и advertising/restart-on-disconnect. Команда обрабатывается синхронно через write authorization, application status публикуется до ATT write response. Обновление GxEPD2 выполняется в loop, вне BLE callback. Mutex защищает протокол, но не удерживается на время обновления дисплея. Кадры во flash не записываются; восстановление bitmap после reset не реализовано и не обещается.

## Протокол и безопасность

[Полная спецификация](docs/protocol.md): UUID service `7b1e0001-6ba2-4f25-8ac7-1d54e91a1000`, command `…0002…`, status `…0003…`. START(length/id/CRC32), DATA(id/offset/1–13 bytes), COMMIT, ABORT. Little-endian. Native portrait 122×250, stride 16, 4000 bytes, MSB first, **black=1**, шесть младших padding bits каждой строки равны нулю.

MTU 23 достаточно: максимум 20 bytes на подтверждённую запись, затем read application status. Notifications не требуются и в прошивке не включены. Проверяются ID/границы/последовательность/дубликаты/CRC/padding; неполный или повреждённый кадр не передаётся дисплею. Повтор точного уже принятого DATA допускается; conflicting duplicates и gaps отклоняются. COMMIT idempotent. Таймаут приёма 15 s, GATT-operation 5 s, ожидание refresh 45 s. После неопределённого timeout GATT клиент disconnect, не запускает перекрывающиеся операции. Неполный приём при disconnect отбрасывается; committed refresh завершается независимо от connection.

Нет обязательного pairing/шифрования/аутентификации. CRC32 не защищает от атакующего; ближайший BLE-клиент может изменить картинку. `done` означает возврат последовательности драйвера, а не оптическое/электрическое подтверждение реального экрана.

## Фактические команды и результаты

Из корня проекта:

```sh
npm ci
npm test
pio run -d firmware -e repin_bw
PYTHONPATH=/home/aleph/.hermes/cache/scratch/eink-studio-python python3 tools/package_firmware.py
```

- Dev dependencies установлены npm, зафиксированы `package-lock.json`; runtime сайт без npm-зависимостей.
- `npm test`: **23/23 JS tests passed**, 0 failed/skipped; **C++ protocol PASS**, g++ C++11 с AddressSanitizer и UndefinedBehaviorSanitizer.
- Shared JS/C++ vectors: CRC32, чёрно-белая полярность, packing размеров 1/7/8/9/122 px и полного кадра, padding. C++: неправильная длина, bounds, incomplete commit, fragment reordering, duplicate/conflict/overlap, CRC corruption, padding corruption, commit idempotence, disconnect/retry, timeout/timer wrap. JS: реальные dithering/geometry, approved PNG roundtrip, fake BLE lost ACK/retry, rejection/disconnect/restart/finite timeout; DOM-навигация/меню/keyboard/pointer/pinch/file input и настоящий native PNG decoder/exporter. Результат: `artifacts/host-tests.json`.
- Финальная firmware build: **SUCCESS**, Flash **138696/815104 bytes**, RAM **22764/237568 bytes**. Устранено предупреждение signed/unsigned в проверке fragment bounds; финальная сборка без него.
- Packaging/verification: **PASS**. ELF ARM32 little-endian hard-float; application origin **0x26000**; все allocated file sections ниже **0xED000**; SP **0x20040000**, reset vector **0x35389**.
- UF2: **277504 bytes**, **542 blocks**, family **0xADA52840**; декодированы и проверены все block headers/addresses/order/end magic/payload; payload побайтно соответствует ELF-derived BIN **138696 bytes**. ZIP integrity и вложенный UF2 проверены. ELF debug records удалены, symbol table для проверки сохранена; ELF/BIN не содержат `/home/`.
- Unicorn выполнил связанные ARM `initVariant`, SPI global initializer и `SPI.begin` с четырьмя начальными сочетаниями OUT/CNF. P0.13 HIGH записан **до** output enable; hardware **SPIM3** PSEL SCK/MOSI/MISO = **38/9/22** (P1.06/P0.09/P0.22); RES P1.11 SPI не перенастраивает. Это исполнение инструкций с memory-backed MMIO, не аппаратный тест.
- Сайт действительно запущен через Python HTTP server, HTTP GET вернул рабочий HTML с контролами редактора. Chromium не запускался.
- Текстовые файлы проекта проверены на email-подобные строки: **0**. Приватные аккаунты/ключи/логины из старого проекта не копировались. node_modules и scratch build/deps исключены из репозитория; полные библиотеки не vendored.

UF2 SHA256: `cbbd3b34411a91aef9a1c1b0075aa1fe88d4da1554e32c3723ebfee25d621ee0`. Остальные SHA256, включая ZIP: `artifacts/verification.json`.

## Точная совместимость и аппаратные ограничения

Профиль Pro Micro/nice!nano v2-compatible nRF52840, исходная схема **S140 6.1.1**, FWID `0x00B6`, application-only UF2; SoftDevice/bootloader не включены и не заменяются. Только WeAct BW **GxEPD2_213_BN**, не BWR и не произвольная 2.13 panel. Пины MOSI P0.09, SCK P1.06, DC P1.04, CS P0.10, BUSY P0.11, RES P1.11, не подключённый MISO P0.22. VCC P0.13 HIGH сохранён, перед display init задержка 250 ms. `CONFIG_NFCT_PINS_AS_GPIOS` сохранён: core может изменить UICR NFCPINS и reset при первом запуске. Подробности и API evidence: [core-compatibility.md](docs/core-compatibility.md), [README](README.md).

На машине не обнаружены `/dev/ttyACM*`, `/dev/ttyUSB*`, serial by-id либо `/sys/class/bluetooth`. Физическая плата/радиоканал недоступны. **Реальное advertising/соединение/приём кадра/потребление питания/refresh новой BLE-прошивки на панели не проверены.** Ничего не прошивалось. Перед ручной публикацией/эксплуатацией нужен тест на плате с уже совместимым bootloader: initial advertising, отправка approved frame, экран, обрыв передачи, reconnect и повтор.

Web Bluetooth: поддерживаемые Android Chrome/desktop Chromium, HTTPS/localhost, доступный Bluetooth ОС. На iOS/Safari/Firefox нет отправки этим API; редактор/download остаются доступны. Проверка API и объяснение ограничений присутствуют в UI. Даже браузерная проверка Firefox не подтверждает Android Chrome, touch-устройство или Web Bluetooth.

## Реальная браузерная проверка без Chromium

Запущен Firefox 142.0.1 (Playwright build 1495), **не Chromium**. Команда на этой машине:

```sh
python3 -m http.server 8765 --directory web --bind 127.0.0.1
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 \
PLAYWRIGHT_BROWSERS_PATH=/home/aleph/.hermes/cache/scratch/eink-studio-browsers \
TMPDIR=/home/aleph/.hermes/cache/scratch node tools/smoke_firefox.js
```

**PASS**: desktop **1280×900**, mobile viewport **390×844**, narrow viewport **320×740**. На каждом размере: настоящий PNG upload, Approved reference и download с точным сравнением 4000 bytes, keyboard move/zoom, меню инверсии, отсутствие page errors и горизонтального overflow; поля/кнопки не выходят за ширину viewport. Desktop/mobile screenshots просмотрены визуально. Это browser viewport, не физический Android touch/Bluetooth-тест.

Доказательства: `artifacts/firefox-smoke.json`, `artifacts/editor-desktop.png`, `artifacts/editor-mobile.png`, `artifacts/editor-narrow.png`.

## Найденные проблемы и решения

- Исходные проверенные repin GPIO/VCC/layout сохранены; прежний текст комментариев про иной SPI не перенесён.
- Signed/unsigned comparison в bounds-check исправлен без отключения проверки границ.
- Неверные фрагменты не должны продлевать receive timeout: activity обновляется только для принятого DATA/точного повтора/идентичного START.
- ATT response не должен обгонять application status: используется синхронная write authorization, а не deferred write callback.
- На этой ОС стандартная установка Playwright Firefox не поддерживается автоматически; официальный Ubuntu 24.04 Firefox build скачан в scratch и запущен напрямую. Chromium не устанавливался/не запускался.
- В обычных vendor assertion strings обнаружены абсолютные build paths. Они не нужны устройству; basename диагностики сохраняется build middleware, debug records исключены из экспортируемого ELF. Пакетировщик отклоняет ELF/BIN с `/home/`.
- Физический BLE/экран недоступны; это оставшееся аппаратное ограничение проверки, не подтверждённая работоспособность по радио.
