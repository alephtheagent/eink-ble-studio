# OTA на сайте E-Ink Studio — Legacy DFU

## Результат текущего прогона

Добавлен application-only Legacy DFU 0.5 для nice!nano с Adafruit nRF52 bootloader. Nordic Secure DFU сохранён как отдельный транспорт. Выбор делается по manifest пакета, а не по имени устройства.

`npm test`: **51 JS-тест, 51 pass, 0 fail, 0 cancelled, 0 skipped**; C++ regression suite — **PASS**. Прежняя проверка запрета legacy заменена проверкой поддержки обоих форматов; остальные существующие сценарии сохранены. Лог: `artifacts/legacy-dfu-tests.log`.

В Chromium на localhost выполнен полный путь через настоящий `web/ota.js`, локальный JSZip, настоящий `LegacyDfu` и stateful fake GATT: передано **146712 байт**, получено **916 PRN**, проверен CRC16, выполнены validate и activate/reset, progress=100, busy=false. Физическая плата не прошивалась. Публикаций не было; `/home/aleph/eink-ble-fix` использован только для чтения источников и копирования fixtures.

## Изменения по файлам

- `web/legacy-dfu.js`: самостоятельный UMD/global `LegacyDfu`, без зависимостей и сборщика. API: `new LegacyDfu({bluetooth, prn=8, chunk=20, onLog, onProgress, timeout=10000})`, `update(device, {init, firmware})`, `abort()`. Очереди ответов по opcode регистрируются до запуска записи. Таймауты ограничивают connect/discovery/notification setup, GATT writes и ожидание ответов. Отмена и неожиданный disconnect завершают ожидания ошибкой; disconnect при activate/reset допустим. В конце удаляются listeners и закрывается соединение.
- `web/ota.js`: `manifest.dfu_version: 0.5` → legacy; отсутствие `dfu_version` → Secure DFU. Иные legacy-версии, смешанные application/SoftDevice/bootloader manifests, отсутствующие/пустые dat/bin отклоняются. Статус сообщает выбранный транспорт. Chooser использует два альтернативных service filters и optionalServices для обоих сервисов; legacy запрашивается полным vendor UUID, **не Bluetooth SIG UUID 0x1530**. Существующий progress/cancel API сохранён.
- `web/index.html`: локальный `legacy-dfu.js` загружается до `app.js`. Разметка первого экрана не менялась.
- `tests/legacy-dfu.test.js`: строгая state machine загрузчика, реальные fixtures, проверка CRC16-CCITT над принятым образом против init-пакета, подсчёт байт, pacing, обе формы PRN, notification races, финал на точной PRN-границе, повреждённый образ, status error, disconnect, timeout, abort и ожидаемый reset. Packet characteristic поддерживает write without response.
- `tests/ota.test.js`: оба manifest-формата, запрет неподдерживаемой версии и смешанных образов, chooser с обоими сервисами; существующие release/confirmation/cancel/error проверки сохранены.
- `tests/fixtures/legacy-dfu.bin`, `tests/fixtures/legacy-dfu.dat`: реальные бинарный образ и init-пакет из read-only firmware artifacts.
- `README.md`: транспорт nice!nano, PRN ≤ 8, single-bank recovery, повторный выбор загрузчика, ограничения CORS и аппаратной проверки.

## Протокол и источники

Локальная установка `adafruit-nrfutil 0.5.3.post16`:

- `/home/aleph/.local/venvs/nrfutil/lib/python3.14/site-packages/nordicsemi/dfu/dfu_transport_ble.py`: UUID, opcodes/statuses, START и размеры, INIT, PRN, RECEIVE, VALIDATE, ACTIVATE.
- В том же каталоге `dfu.py:140–212`: чтение dat/bin и порядок application-only transfer.

Legacy service `00001530-1212-efde-1523-785feabcd123`; control `00001531-…`; packet `00001532-…`. Secure DFU остаётся на `0xFE59` со своими характеристиками.

Для реального образа последовательность control writes проверена тестами и браузерным smoke:

```text
01 04          START application
02 00          INIT start
02 01          INIT complete
08 08 00       PRN = 8
03             RECEIVE
04             VALIDATE
05             ACTIVATE / RESET
```

После START в packet идут 12 байт `u32 LE`: `0, 0, 146712`. Init и firmware передаются чанками до 20 байт. Успешный ответ — `10 opcode 01`. Поддерживаются PRN `11 + u32 LE received bytes` и указанная в задании форма `10 03 status`. На финальном пакете требуется ответ RECEIVE; отдельный PRN не требуется, в том числе при кратном PRN числе пакетов. CRC проверяет загрузчик; клиент не подменяет успешную валидацию собственной проверкой.

### Fixtures

Источник bin: `/home/aleph/eink-ble-fix/artifacts/eink-ble-welcome-once-dfu-bw-s140v6.bin`.

Источник dat: `eink-ble-welcome-once-dfu-bw-s140v6.dat` внутри соседнего `eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip`; manifest указывает `dfu_version: 0.5`, CRC16=11672 (`0x2d98`).

SHA-256:

```text
bin  5d6d2f6a1bcbef87973382b242c676f508c54c358018eb2a276a9da684ae003a
dat  be1bce773b9f18ada04418f8514111b067e34965871516a3fef95ac1108220b4
```

Хеш скопированного bin совпал с исходным.

## Проверки

Полный regression run:

```sh
npm test
```

Результат: 51/51 JS, C++ `shared CRC/pixel vectors, approved frame, bounds, ordering, duplicates, CRC/padding, commit, disconnect/retry and timer wrap PASS`. Сообщения Bluetooth error в логе относятся к успешно пройденным негативным сценариям.

Browser smoke выполнен через Chromium automation на `http://127.0.0.1:18871/web/` с локальным сервером:

```sh
python3 -m http.server 18871 --directory . --bind 127.0.0.1
```

В странице создан ZIP с реальными fixtures и legacy manifest; GitHub fetch и requestDevice заменены локальными адаптерами. `dfuFactory` **не подменялся**: использовался production backend. Stateful GATT model взят из `tests/legacy-dfu.test.js`. После preflight настоящими UI-действиями открыта Firmware, отмечено подтверждение и нажато Flash firmware. Проверены control writes, размер принятого образа, PRN, CRC, reset, успешный статус и сброс busy. Данные: `artifacts/legacy-dfu-smoke.json`; визуальное подтверждение: `artifacts/legacy-dfu-panel.webp`.

Первый экран после reload на 390×844: Firmware hidden=true, horizontal overflow=false, обе локальные библиотеки загружены. Скриншот: `artifacts/legacy-first-mobile.webp`. Открытая Firmware на desktop 1280×900 также без горизонтального переполнения. Редактор и первая поверхность визуально проверены; новый Firefox smoke в этом изменении не запускался.

## Эксплуатационные ограничения

- **Adafruit OTA: PRN ≤ 8**; клиент по умолчанию использует 8 и запрещает выход за диапазон 1–8. Firmware chunks ≤ 20 байт.
- **Single-bank, без fallback.** Обрыв или отмена могут оставить плату без рабочего приложения, в загрузчике; для восстановления нужна новая полная передача совместимого пакета.
- После ENTER_DFU либо double RESET загрузчик нужно **выбрать заново** в chooser. Отключение само по себе не доказывает успешный вход в DFU. Выбор другого типа загрузчика не переключает формат ZIP автоматически: несовместимый сервис выдаст ошибку discovery.
- Web Bluetooth требует HTTPS/localhost и поддерживаемый Chromium/ОС. Firefox и Safari не выполняют BLE OTA.
- Сетевые GitHub release/CORS проверки из предыдущего отчёта не повторялись: ранее latest вернул 404, а скачивание публичного asset другого проекта блокировалось браузерным fetch. Это не доказывает недоступность целевого репозитория или CORS целевого asset. Нужен доступный браузеру application-only ZIP.
- Secure DFU реализация vendor не изменялась. Ранее отмеченное ограничение проверки CRC возобновляемого firmware prefix при SELECT остаётся.
- **Hardware DFU не выполнялся, совместимость с физической платой этим прогоном не подтверждена. Ничего не опубликовано, исходная прошивка не изменялась.**
