# BLE v2: MTU + PackBits — интеграция и новая сборка

## Результат и границы

Работа выполнена только в `/home/aleph/eink-ble-fix`. Соседний `/home/aleph/eink-text-editor` не изменялся. Без commit, push, deploy, записи на плату и запуска Chromium. Лаборатория `/home/aleph/eink-ble-performance-lab` прочитана, не изменялась.

Реализован production v2 в firmware и `web/ble.js`: потолок MTU247, динамический per-connection safeWrite20..244, streaming PackBits с raw fallback, CRC32, exact4000-byte decode, строгий ACK. Сохранены v1 endpoints и исправление S140 WRITE authorize `update=1` с исходными bytes; exact approved boot welcome не заменён. Новые UF2/ZIP действительно собраны из v2 кода; имя содержит **`v2`**. Старые файлы без `v2` не являются этой сборкой.

**Проверено на host и связанном ARM ELF, не по радио.** Нет измеренного RF throughput, фактического MTU negotiation телефона, исполнения SoftDevice или оптической/электрической проверки панели. Плата не прошивалась. Тесты GATT имитируют границу IO; ARM проверки останавливаются на настоящем SVC, не подделывая ответ SoftDevice. Поддержка большого пакета конкретным телефоном требует его реального write+application ACK.

## Новые передаваемые артефакты

Абсолютные пути:

- `/home/aleph/eink-ble-fix/artifacts/eink-ble-v2-bw-s140v6.uf2`
- `/home/aleph/eink-ble-fix/artifacts/eink-ble-v2-bw-s140v6.zip` — единственный вложенный файл: указанный UF2, байты совпадают.
- Рядом `.elf`, `.hex`, `.bin` и `/home/aleph/eink-ble-fix/artifacts/verification-v2.json`.

| Файл | SHA256 |
| --- | --- |
| UF2 | `dbc3035fabb366788803fdaa85ea098ec72c0fb9b1fd76d15da666d628a3ace8` |
| ZIP | `4d3e7c8281f2e764ed73862b4b3f543616257bcea841d8ea529e277e7fb54aad` |
| BIN | `6e21cde24f98e41374d9a2c41da868bf08aebe41d50a3ad8eebf185b4444d7e6` |
| ELF | `ca79c96c350dbb8b944c854a6ff7c9765b41755a5eb5572eec7e7fa20bf6114d` |

UF2 **291328 bytes**, **569 blocks**; BIN **145576 bytes**. Проверены все UF2 block headers/family/order/address/end magic, восстановление BIN, ZIP CRC/равенство. Application-only: origin `0x26000`, limit `0xED000`, family `0xADA52840`, initial SP `0x20040000`, reset `0x35D85`. SoftDevice/bootloader не включены. Внутренний PlatformIO DFU ZIP в scratch build — не этот пользовательский ZIP.

## Реализация

- `firmware/include/protocol.h`: единственный receiving framebuffer4000, owner connection+dialect, v1 raw-prefix duplicates, v2 exact-last full packet duplicate≤244, idempotent START/COMMIT. Декодер хранит только counters/token state; нет encoded4000 staging buffer. Bounds проверяются до feed; malformed stream переводит весь transfer в ERROR. Полный input, exact output4000, завершённый token, CRC и row padding обязательны перед QUEUED. После ERROR данные не продолжаются; START/ABORT/restart. Disconnect/15s timeout инвалидирует incomplete frame. Committed buffer immutable до возврата display driver; только затем DONE/generation.
- `firmware/src/main.cpp`: новый command2/status2/caps в том же service. `configPrphConn(247, default event length/queues)` до begin; результаты begin/GATT/advertising проверяются. Caps READ authorizer синхронно вычисляет `min(getMtu()-3,244)`, fallback20 при отсутствующем/отключённом/невалидном соединении. Это не обещание MTU247: default без exchange23.
- `firmware/sanitize_paths.py`: воспроизводимые private patched copies Bluefruit `BLECharacteristic.cpp` и `BLEGatt.cpp` в scratch build. Общий framework package не редактируется. PREP отвергается **до** core long-write allocation1024; handle-less EXEC NOW/CANCEL отвергаются один раз до broadcast/drop. Не зарегистрирован обычный write callback — альтернативного parser bypass нет. Смена ожидаемых pinned source anchors останавливает сборку. Одного `request->op` guard в application недостаточно; прежняя core-ветка действительно обходила его.
- `web/ble.js`: capabilities discovery; только `NotFoundError` отсутствующего caps выбирает v1. Network/discovery ошибки, неизвестные/corrupt caps и неполный v2 service завершаются явно. Caps перечитывается перед каждой передачей; reconnect сбрасывает characteristic state. После каждого write-with-response — status2 read, exact ID/codec/total/CRC/state/error/offset ACK. V2 не делает blind retries. Неопределённый результат/timeout отключает соединение; offset не продвигается. `force20` даёт явно управляемый fallback после reconnect/new ID, без resize посреди transfer. Public readStatus выбирает status2 для v2.
- Web write API: explicit `writeValueWithResponse` предпочтителен; legacy `writeValue` разрешён только при `properties.write=true` и отсутствии `writeWithoutResponse`. Без response-confirmed API — явная ошибка.

Полный единый wire contract: `/home/aleph/eink-ble-fix/docs/protocol-v2.md`. V1 contract: `docs/protocol.md`. CRC — не authentication; соседний BLE клиент по-прежнему не требует pairing/encryption.

## Старый timeout и exact approved welcome

WRITE authorization по-прежнему синхронный, `setWriteAuthorizeCallback(..., false)`: оба status публикуются под mutex **до** authorize reply; reply передаёт update1, offset, len, p_data; SDK result проверяется. Не увеличен 5s GATT timeout. Исходный дефект authorize был нарушением SDK контракта; без реальной платы нельзя утверждать, что именно он вызвал прежний пользовательский timeout. MTU/codec его не маскируют и не заменяют исправление.

Source welcome — `assets/approved-welcome.png`, не историческая avatar fixture. Упаковщик сравнил **30500 source pixels**, **762500 preview pixels**, header и все4000 bytes символа `eink_welcome_bitmap` нового ELF. Packed SHA256 **`dc6e05e5f09d7df9b32d3952472577744d534723f11f60ed1204370180169733`**, CRC32 **`014da2fd`**, padding0. На boot welcome завершается и hibernate выполняется до advertising; повторной welcome-задачи во время upload нет.

Repin сохранён: VCC **P0.13 HIGH**, MOSI P0.09, SCK P1.06, DC P1.04, CS P0.10, BUSY P0.11, RES P1.11; MISO P0.22, не RES. Linked ARM GPIO/SPI smoke исполнен при четырёх initial latch/config states: preload HIGH до output enable; SPIM3 SCK/MOSI/MISO38/9/22; RES не затронут. Это memory-backed MMIO, не электрическое измерение.

## Выполненная проверка

1. **Red:** исходный `node --test tests/ble-v2.test.js` упал: `SyntaxError: ... ble.js does not provide an export named 'chooseCodec'`, 1 fail. Это фактическое состояние прерванного worktree, не готовый v2.
2. **Green:** `npm test` — **47/47 JS PASS**, затем legacy native C++ PASS с ASan/UBSan. `tests/ble-v2.test.js` компилирует настоящий C++ receiver с ASan/UBSan и проверяет JS-framed raw/PackBits при limits20/125/244, exact frame equality, split tokens по одному байту, literal worst-case4032→raw4000, bounds, malformed headers/stream, все неполные prefixes compressed zero-frame, trailing token/overflow, CRC, padding, duplicate/offset/ID/owner/dialect, disconnect/timeout/restart/idempotence. Client tests: caps fallback/errors, ACK failure/link loss, queued≠success, hung DATA/no retry, reconnect ceiling reset/force20 и legacy response API. Существующие image/UI DOM/native-canvas/v1 tests сохранены. Console Bluetooth errors в логе — ожидаемые negative cases.
3. `node tools/measure_v2.mjs` — actual production JS image pipeline/codec, nine image+dither rows; исходная approved avatar побайтно совпала с исторической approved-frame.bin.
4. `node tools/smoke_v2.mjs` — **27 полных production BleTransport→native production Protocol transfers** под ASan/UBSan, все exact4000-byte frames совпали: avatar/welcome/generated graph × none/Bayer/Floyd–Steinberg × ceilings20/125/244. При244 реально отправлены244-byte DATA packets в host bridge (237 payload). GATT IO и переход драйвера QUEUED→DONE явно симулированы, не выдаются за физический refresh.
5. `pio run -d firmware -e repin_bw` — **SUCCESS**. Platform nordicnrf52 11.0.0, Adafruit core package1.10601.0, GCC7.2.1, GxEPD2 1.6.9/GFX1.12.4/BusIO1.17.4, S1406.1.1. Flash145576/815104, app static RAM23288/237568.
6. `tools/package_firmware.py` выполнен isolated Python с pyelftools0.33/unicorn2.1.4. `tests/authorize_arm.py` на **экспортированном новом ELF**: v1 welcome4000 через308 DATA, incomplete COMMIT/duplicate/idempotent COMMIT; v2 raw4000 и compressed64 при20/125/244 — QUEUED с CRC. Реальные WRITE SVC arguments update1 и исходные bytes, оба status перед SVC.
7. `tests/core_arm.py` на том же ELF: actual compiled PREP4/EXEC CANCEL5/EXEC NOW6 guards доходят до SVC WRITE_NOT_PERMITTED без allocator/application-parser entry и без изменения protocol memory. Caps callback на controlled MTU inputs23/128/247/517/0, null/disconnected и возврате к23 выдал20/125/244/244/20/20/20/20. Getters — controlled inputs; это проверка вычислений/re-read, не negotiation. Первый запуск нового harness обнаружил неверную упаковку opcode в синтетическом SDK event; исправлен harness, production guards подтверждены исполнением и disassembly.

Логи/машинные результаты:

- `/home/aleph/eink-ble-fix/artifacts/v2-tests.log`
- `/home/aleph/eink-ble-fix/artifacts/v2-build.log`
- `/home/aleph/eink-ble-fix/artifacts/v2-package.log`
- `/home/aleph/eink-ble-fix/artifacts/v2-smoke.json`
- `/home/aleph/eink-ble-fix/artifacts/v2-measurements/measurements.json`, PNG и `.bin/.wire` варианты.

## Реальные размеры, не RF throughput

Все raw frames4000 bytes. Writes включают START+COMMIT; столько же ACK reads, без caps/discovery/refresh polls.

| Изображение / dither | Выбранный codec | Wire bytes | Writes20 /125 /244 |
| --- | --- | ---: | ---: |
| Approved avatar / none, Bayer, FS | PackBits |3900|302 /36 /19|
| Exact approved welcome / none, Bayer, FS | PackBits |2341|183 /22 /12|
| Generated graph / none | PackBits |1437|113 /15 /9|
| Generated graph / Bayer | PackBits |1723|135 /17 /10|
| Generated graph / FS | PackBits |1911|149 /19 /11|
| Literal worst-case | raw fallback |4000 (PackBits4032)|310 /36 /19|

Avatar сжимается только на **2.5%**; при244 число writes19 такое же, как raw4000. Большой MTU сокращает количество операций, но не доказывает скорость. Графика создана `tools/measure_v2.mjs`, это отдельная детерминированная картинка, не утверждённая пользователем замена avatar/welcome. Dithering variants одной бинарной avatar/welcome совпадают; не считаются независимыми исходными изображениями.

## Интеграция с другим веб-редактором

Ничего не копировалось в `/home/aleph/eink-text-editor`. Интегратору нужен **только** `/home/aleph/eink-ble-fix/web/ble.js` вместо соответствующего transport module. Соседний `image.js` должен экспортировать `FRAME_BYTES=4000`, `crc32(bytes)` с тем же IEEE алгоритмом; frame122×250/stride16/MSB-first/black1/padding0. Не копировать app/index/style или исторические UI artifacts.

Сохранены `new BleTransport(options)`, `connect()`, `send(frame[,id])`, `readStatus()`, `disconnect()`, callbacks onProgress/onStatus/onDiagnostic. В v2 `onProgress(offset,total)` считает **encoded bytes**, а не raw pixels; отображать ratio offset/total. Public status содержит version2/codec. `onDiagnostic` transfer/info даёт `codec`, `rawBytes`, `wireBytes`, **serverCeiling** и фактически выбранный **writeCeiling**. Не называть ceiling скоростью или JS-selected MTU.

Обычный путь — connect из user gesture, await send(frame), success только после DONE. Для fallback: дождаться settling прежних native операций (connect сам откажет, пока pending), reconnect, задать `transport.force20=true`, send(frame) с новым ID. Состояние committed после обрыва неизвестно: перед повтором проверить status, не обещать, что экран не обновился. ID не durable/authenticated. HTTPS/localhost и браузер с Web Bluetooth обязательны; Firefox использованными host tests не наделяется Web Bluetooth.

Проверенный первичный источник: [Web Bluetooth spec source](https://raw.githubusercontent.com/WebBluetoothCG/web-bluetooth/main/index.bs), connection algorithm attempts Exchange MTU и игнорирует ошибку; characteristic write rejects >512. Это **не** гарантия atomic512 и не стандартный JS MTU getter/setter. Используется firmware safeWrite, не user-agent/ОС. Ссылки и binary layout — `docs/protocol-v2.md`.

## Ограничения аппаратной верификации

Не выполнялись: настоящий caps READ authorization/MTU exchange с телефоном, RF write237-payload+ACK при negotiated247, Android/desktop browser/backend matrix, hostile PREP/EXEC через реальный SoftDevice, runtime `sd_ble_enable` ram_start/high-water, фактический panel refresh/питание/BUSY. Причина — в этой работе нет разрешённого аппаратного запуска/прошивки; host/emulation не заменяют его.

ELF `size -A`: `.data872`, `.bss22416`, сумма **23288 bytes**; `.heap212232` — linker reserve, не живые объекты и не измеренный свободный heap. Runtime SoftDevice/FreeRTOS headroom неизвестен. `Bluefruit.begin()` проверяется, но его аппаратный результат на MTU247 здесь не исполнялся.

Следующий аппаратный контроль без изменения контракта: подтвердить exact boot welcome и P0.13 HIGH → caps на default23 и negotiated247 → upload с write244/ACK и отдельным panel DONE → corrupted/incomplete/disconnect/reconnect/PREP/EXEC → reset welcome. Замерять upload и panel refresh отдельно. Утверждений о выполнении этого контроля или RF throughput в данном отчёте нет.
