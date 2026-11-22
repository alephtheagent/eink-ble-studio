# BLE timeout / boot welcome repair

> Актуальный результат welcome-once/DFU для этого worktree приведён в разделе ниже. `REPORT-V2.md` и названные там `v2`-артефакты — предыдущая, отдельная сборка; исторические v1 результаты ниже также не описывают её.

## Актуальный результат: welcome-once + BLE DFU

Подготовлено только в `/home/aleph/eink-ble-fix`. Не публиковалось, не коммитилось и не прошивалось. Новые артефакты именованы `eink-ble-welcome-once-dfu-bw-s140v6`; существующие v1/v2-файлы в `artifacts/` не изменяют факты этой сборки.

### Итоговая сборка и границы flash

- Команда сборки: `pio run -d firmware -e repin_bw` (последовательные build invocations; в обоих проверенных post-fix runs компилировался `firmware/src/main.cpp`). Встроенный ELF-символ `eink_build_id` из `.data` проверен непосредственно: build #2 `0x751B6373`, build #3/final `0xEBB20994`. ID различаются при обычных последовательных сборках; финальный ID также записан в `verification-welcome-once-dfu.json`.
- Финальный build: **SUCCESS**, 146712 байт Flash из 811008 доступных приложению, 23304 байта RAM из 237568. Linker app: `0x26000..0xEC000` exclusive. Фактический HEX диапазон `0x26000..0x49D18` exclusive; запас до зарезервированного сектора: **664296 bytes**. Состояние занимает страницу 4096 bytes по `0xEC000`; HEX и UF2 не содержат данных для неё. InternalFS остаётся от `0xED000`.
- `tests/boot_state.cpp` исполняет production `ensureWelcome` из `firmware/include/boot_state.h` с Store/Panel hooks: для совпавшего ID welcome hook вызван **0 раз**, а повреждённое/стёртое/другое состояние показывает welcome; CRC/build ID mismatch, read failure, reset и повтор после failed-save проверены. Это host helper smoke, не запуск MCU `setup()` или физическая панель.
- `npm test`: **47/47 JS PASS**, C++ protocol + boot-state PASS с ASan/UBSan. После добавления отдельной проверки v2 `RESET_WELCOME` status снова выполнен `PYTHONPATH=/home/aleph/.hermes/cache/scratch/eink-studio-python python3 tests/run_cpp.py`: C++ protocol и boot-state PASS.
- `python3 tests/authorize_arm.py <final ELF>` и тот же прогон при package: настоящий связанный ARM callback/receiver. Полный approved frame **4000 bytes / 308 DATA** завершился QUEUED; проверены v2 raw/PackBits при write ceilings 20/125/244. Callback продолжён после SVC с инъецированными результатами: успешная ATT authorization устанавливает `actionArmed`; ошибочная authorization и status publication очищают action, завершающий status action=0. При отказе публикации ATT status равен `0x010E`. Linked ARM smoke проверяет v1 reset `0x05`/enter-DFU `0x06` статусы и отказ DFU во время receiving. Native C++ `tests/protocol.cpp` проверяет action statuses v1 reset/DFU `0x05`/`0x06` и v2 reset/DFU `0x15`/`0x16`, включая reset status до отдельного `consumeAction()`. Это эмуляция callback/SVC boundary с инъецированным return, **не SoftDevice или радио**.

### Артефакты текущей сборки

Все файлы находятся в `/home/aleph/eink-ble-fix/artifacts/`:

- `eink-ble-welcome-once-dfu-bw-s140v6.uf2` — application-only UF2, **293888 bytes**, 574 blocks, family `0xADA52840`; SHA256 `5c5e312875b4cfb547e9baa79d239346b39455ae2d7ef19ece3e52d1ab5d922b`.
- `eink-ble-welcome-once-dfu-bw-s140v6.zip` — только этот UF2; SHA256 `7eabb15dcf760c46a42449aa8e3d6bd57128f7af3e11ed00f60ac650054c6858`.
- Рядом `.elf`, `.hex`, `.bin`; embedded ID `0xEBB20994`. BIN 146712 bytes, SHA256 `0d47655a2ef538334a5416598268d36a9e72f0c60a53445428397f0d9a5007d1`; ELF SHA256 `94275cbfcf892af229db7475cb876ae993cb34d02deea12dd62b6634b427e234`; HEX SHA256 `a23faedbbf5abc81985aa12099e7af7d4194e68b061adb12ae15f91ae65095a3`.
- `verification-welcome-once-dfu.json` — окончательные ELF/UF2 проверки, размещение, embedded ID, welcome pixels и ARM smoke.
- `eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip` — Nordic application DFU package, SHA256 `812e5a110454062b2187ad5833627f4f26c8658a62905bc092f608aefa45bdb8`; metadata: application version 1, device type `0x0052`, SD requirement `0x00B6`; HEX/BIN span 146712 bytes (`0x26000..0x49D18`).
- `eink-ble-welcome-once-dfu-bw-s140v6-dfu.json` — проверка manifest, init packet, CRC, размеров и hashes. ZIP имеет ровно три файла: manifest.json 510 bytes, application BIN 146712 bytes, init packet DAT 14 bytes; итог 147668 bytes. Firmware CRC16 и BIN-равенство HEX проверены.

Упаковка выполнена `PYTHONPATH=/home/aleph/.hermes/cache/scratch/eink-studio-python python3 tools/package_firmware.py` и `npm run package:dfu`. `verification-welcome-once-dfu.json` сохраняет результаты linked ARM action smoke. Фактический nrfutil вызов:
`/home/aleph/.local/bin/nrfutil dfu genpkg --dfu-ver 0.5 --dev-type 0x52 --sd-req 0xb6 --application-version 1 --application artifacts/eink-ble-welcome-once-dfu-bw-s140v6.hex artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip`.

Установлен Adafruit nrfutil **0.5.3.post16**. Это DFU 0.5 legacy пакет с **CRC16 metadata, без криптографической подписи**. `--key-file` поддержан инструментом, но включает DFU 0.8 signed формат; локального проекта/bootloader test private key не найдено, ключ не создавался и не включался в артефакты. Пакет не загружался. В core `wiring.c`, `enterUf2Dfu()` устанавливает `DFU_MAGIC_UF2_RESET=0x57` после отключения SoftDevice; upstream Adafruit bootloader использует `0x57` для UF2/USB DFU, тогда как OTA BLE использует `0xA8`. На целевом bootloader это не проверено.

### Непроверено на аппаратуре

Плата не прошивалась. Нет физической проверки RF/BLE, SoftDevice runtime, bootloader acceptance DFU ZIP, NVMC/flash erase/write на nRF52840, панели, оптики/электрики или reset после команды. До получения платы/bootloader нельзя утверждать, что состояние реально сохраняется или что DFU пакет принимается устройством. `0x57` и DFU 0.5 package format сверены по исходникам/генератору, не на устройстве.

## Исторический результат v1 repair (не текущая сборка)

Работа выполнена только в `/home/aleph/eink-ble-fix`. Без commit/push/deploy/upload, без Chromium и без изменений GUI редактора. Единственный изменённый клиентский runtime-файл — **`web/ble.js`**; его нужно интегрировать вместе с firmware, но wire protocol **не менялся**.

### Подтверждённый дефект и граница доказательства

Исходный `authorizeCommand` формировал успешный WRITE authorize reply с `update=0`, `len=0`, `p_data=null` и игнорировал результат `sd_ble_gatts_rw_authorize_reply`. Это нарушает явное требование S140 6.1.1 `ble_gatts.h:299–305`: WRITE authorization всегда должен задавать update и данные.

До исправления создан и запущен `tests/authorize_arm.py`: исполняется **связанный ARM callback** исходного ELF до его настоящей SVC-инструкции. Получено `svc=176, type=2, status=0, update=0, length=0, data=""`; regression завершился с `AssertionError: S140 contract violation: WRITE authorize reply.update MUST be 1`. После исправления: `update=1`, `length=11`, исходные START bytes; полный приём welcome через 308 DATA packets заканчивается QUEUED с корректным CRC. Проверены incomplete COMMIT, duplicate DATA и повтор COMMIT.

Это воспроизводимый дефект исходящего SDK-вызова, **не исполнение SoftDevice**: RTOS lock/time и запись status перехвачены, выполнение останавливается перед обработкой SVC; SDK success не подделывается. Нельзя без платы утверждать, что именно этот дефект вызвал пользовательский 5-секундный timeout. Его фактическая стадия, RF/OS latency, питание, BUSY и реальное поведение SoftDevice остаются неизвестны.

### Исправления

- `firmware/src/main.cpp`: WRITE authorize передаёт update/offset/len/data; проверяет SDK result и длину записи status. При неуспехе — disconnect неопределённой ATT-процедуры. Обработка синхронно в BLE event task, status до ATT reply, без deferred AdaCallback. Mutex не удерживается во время display refresh; ожидание mutex callback ограничено 50 ms.
- Serial 115200: `t`, stage, conn, op, DATA offset, length, state, protocol error, SDK authorize result. Очередь 16 записей неблокирующая; USB вывод только из loop, записи при бурсте могут теряться. Расшифровка — `docs/protocol.md`.
- `web/ble.js`: сообщения разделяют connect, discovery service/command/status, write START/DATA offset/COMMIT, read ACK, refresh read и общий refresh deadline. Исходный 5 s timeout **не увеличен**. Ошибка с cause выводится в console; необязательный `onDiagnostic({stage,event,error})`. Connect/send/read защищены от concurrent entry; disconnect отменяет активный вызов, поздние результаты не восстанавливают stale characteristics.
- `firmware/include/welcome.h`: точный bitmap из **локального** `assets/approved-welcome.png`, дизайн без значка монитора. На каждом boot экран рисуется и hibernate завершается **до advertising**. Повторной welcome-задачи нет, текущий transfer не перерисовывается. Ложный Ready не добавлен. Изображения RAM-only, reset всегда заменяет их welcome.
- `tools/welcome_bitmap.py`: воспроизводимая генерация и проверка PNG → header → ELF плюс 5× preview. `tools/package_firmware.py` автоматически выполняет pixel verification и ARM authorization regression перед выдачей пакета.
- `tests/ble.test.js`: stage diagnostics, timeout и re-entry/late-result сценарии. Эти JS tests имитируют Web Bluetooth и не используются как доказательство поведения SDK/радио.
- `firmware/platformio.ini`: отдельные build/libdeps в scratch `eink-ble-fix-build`, без пересечения со старой сборкой.

### Совместимость

UUID неизменны: service `7b1e0001-6ba2-4f25-8ac7-1d54e91a1000`, command `…0002…` WRITE-with-response, status `…0003…` READ. MTU23, payload до 20 bytes, DATA до 13 bytes; START/DATA/COMMIT/ABORT, CRC32 IEEE, status v1 без изменений. 122×250, stride16, 4000 bytes, black=1, MSB-first, padding=0. Приём timeout15s, operation5s, refresh45s. Старый клиент совместим с исправленной прошивкой; новый клиент wire-compatible со старым, но не устраняет дефект старой firmware.

Плата и пины сохранены: nRF52840 S140 **6.1.1**, app origin **0x26000**, верхняя граница **0xED000**, UF2 family **0xADA52840**, BW **GxEPD2_213_BN**. P0.13 HIGH до output enable; MOSI P0.09, SCK P1.06, DC P1.04, CS P0.10, BUSY P0.11, RES P1.11. UF2 application-only, SoftDevice и bootloader не включены.

### Выполненные проверки

- `npm ci --cache /home/aleph/.hermes/cache/scratch/eink-ble-fix-npm-cache`: установлены lockfile dependencies. Первый `npm test` остановился из-за отсутствовавшей зависимости UI; после установки **30/30 JS PASS**, C++ protocol **PASS** с ASan/UBSan. C++ покрывает bounds, partial, error/CRC/padding, duplicates, COMMIT, disconnect/restart, timeout и uint32 wrap.
- `pio run -d firmware -e repin_bw`: **SUCCESS**, Flash **144544/815104 bytes**, RAM **22768/237568 bytes**. Закреплённые GxEPD2 1.6.9, GFX 1.12.4, BusIO 1.17.4.
- ARM regression **red → green**, затем тот же full-frame smoke на **экспортированном** ELF при packaging. Реальная compiled protocol/CRC machine, остановка на SVC; не hardware/SoftDevice execution.
- Throwaway interop smoke: настоящий `web/ble.js` → отдельный native процесс с настоящим `firmware/include/protocol.h`. 310 команд, received4000, CRC accepted, QUEUED. Физический драйвер не имитировался: клиент ожидаемо завершился `refresh: Display refresh timed out`, **DONE/success не выдавался**. Временные программы удалены, лог сохранён.
- Welcome: **30 500** source pixels, **762 500** preview pixels и 4000 linked ELF bytes совпали, padding=0. Preview визуально просмотрен: утверждённый дизайн без монитора. CRC32 welcome **0x014DA2FD**, packed SHA256 **`dc6e05e5f09d7df9b32d3952472577744d534723f11f60ed1204370180169733`**. Старые `tests/fixtures/approved-*` остаются отдельными историческими image/protocol vectors, это не источник boot welcome.
- UF2: **289280 bytes**, **565 blocks**, payload соответствует BIN **144544 bytes**; проверены headers/family/addresses/order/end magic, ELF layout, SP **0x20040000**, reset **0x359F1**, ZIP CRC и точное равенство вложенного UF2. Linked ARM GPIO/SPI smoke — 4 начальных состояния; SCK/MOSI/MISO38/9/22, RES не затронут. Это MMIO-memory emulation, не электроника.

### Передаваемые файлы и логи

- `/home/aleph/eink-ble-fix/artifacts/eink-ble-bw-s140v6.uf2`
- `/home/aleph/eink-ble-fix/artifacts/eink-ble-bw-s140v6.zip` — только UF2.
- ELF/HEX/BIN и `artifacts/verification.json` с актуальными SHA256 — рядом.
- UF2 SHA256: **`b652f3cc14a9e17827d0c1defb7667a1ca41234ae0a75adc865f5af75534739e`**.
- Логи: `/home/aleph/.hermes/cache/scratch/eink-ble-fix-validation/`: `authorize-red.log`, `authorize-green.log`, `npm-test.log`, `pio-build.log`, `package.log`, `client-native-smoke.log`.
- Полный source/binary diff: `/home/aleph/.hermes/cache/scratch/eink-ble-fix-validation/changes.patch` (новые source-файлы включены).

### Что ещё требует физической платы

В текущем окружении не обнаружены serial devices `/dev/ttyACM*`, `/dev/ttyUSB*`, by-id или Bluetooth adapter в sysfs. Не выполнены RF transfer, display optical/electrical check, SoftDevice runtime или прошивка устройства. GxEPD2 DONE означает возврат драйвера, не оптическое подтверждение и не гарантию отсутствия BUSY timeout.

На плате с совместимым bootloader: дождаться boot welcome/advertising → передать кадр → при ошибке сохранить **полный stage-prefixed error/cause**, offset прогресса, BLE serial строки и `Busy Timeout!`, если есть. Затем проверить partial/disconnect/reconnect и reset → welcome. Это аппаратная верификация готового артефакта, а не утверждение, что радио уже проверено.

---

# Исторический отчёт исходного checkout (до текущего ремонта)

Следующие пути, hashes и результаты относятся к прежней работе, не к текущему UF2; актуальные сведения приведены выше.

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
