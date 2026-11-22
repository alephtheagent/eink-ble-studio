# CI-REPORT

## Результат

Реализован `.github/workflows/firmware.yml`: теги `v*`, ручной запуск с `version=1`, PR по путям прошивки/инструментов/тестов и входным файлам. Python 3.11, Node 22, кэш `~/.platformio`, установка pip/npm, сборка, строгая упаковка, `npm test`, загрузка артефактов `always()`. Release — только после успешного push тега, через `softprops/action-gh-release@v2`, `tag_name: ${{ github.ref_name }}`, release notes, не draft; только `GITHUB_TOKEN`, `contents: write`.

Коммиты, push, теги, релизы и прошивка платы не выполнялись. GitHub Actions/Release API локально не запускались.

## Файлы

- `.github/workflows/firmware.yml` — workflow.
- `firmware/platformio.ini` — абсолютные пути сборки и libdeps заменены на `firmware/.pio/build` и `firmware/.pio/libdeps` относительно проекта PlatformIO. Настройки платформы, библиотек и прошивки не изменены.
- `tools/package_firmware.py` — `ARTIFACTS_DIR`, создание вложенных каталогов, разрешение относительного build_dir от `firmware/`. Импорт `welcome_bitmap` сохранён и проверен с `PYTHONPATH=tools`. Хеши verification теперь относятся только к пяти файлам текущего UF2-пакетирования: старый `.dfu.zip` не должен попадать в отчёт до его последующей регенерации. Проверки ELF/bitmap/ARM/UF2 сохранены.
- `tools/dfu_package.py` — `NRFUTIL`: env → `shutil.which('nrfutil')` → `~/.local/bin/nrfutil`. Каталог `NRF_SITE` необязателен, без него используются установленные модули `nordicsemi`. Дополнительно проверяются расширения `.bin` и `.dat`; остальные проверки manifest/init packet/CRC/границ сохранены.
- `docs/ci.md` — выпуск, ассеты, поиск OTA, отсутствие подписи и single-bank ограничения.
- `README.md` — актуализирована команда DFU после установки pip и добавлена ссылка на CI-документацию.
- `CI-REPORT.md` — этот отчёт с фактическим выводом команд.
- `artifacts/eink-ble-welcome-once-dfu-bw-s140v6.{elf,hex,bin,uf2,zip,dfu.zip}`, `artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip`, `artifacts/verification-welcome-once-dfu.json`, `artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.json` — локально пересобранные результаты.

`package.json` и `tests/run_cpp.py` не требовали изменений: `npm test` работает с новым HOME без локальных абсолютных путей. Host runner использует `Path.home()`, а не фиксированный `/home/aleph`. Протокол, опкоды и исходный код поведения прошивки не менялись.

## Найденные несовместимости

1. Запрошенное `.dfu.zip` **не** заканчивается на `-dfu.zip`. Workflow сохраняет `.dfu.zip` и публикует побайтово идентичную копию `-dfu.zip`, которую найдёт описанный OTA consumer. Оба имени проверены локально.
2. В этой рабочей копии нет `web/ota.js`/`selectDfuAsset`. Сайт не менялся; контракт выбора первого `-dfu.zip` взят из задания, end-to-end OTA здесь не подтверждён.
3. `pip install adafruit-nrfutil` создаёт CLI **adafruit-nrfutil**, не `nrfutil`. Это проверено через metadata entry points. Первая дополнительная проверка с `NRFUTIL=/tmp/eink-ci-venv/bin/nrfutil` завершилась кодом 1: `FileNotFoundError: [Errno 2] No such file or directory: '/tmp/eink-ci-venv/bin/nrfutil'`. Workflow исправлен: job env `NRFUTIL=adafruit-nrfutil`. После этого DFU-команда повторно выполнена успешно, в том числе с новым HOME без PlatformIO site-packages. Успешный первоначальный запуск через ранее установленный локальный `nrfutil` не использован как единственное доказательство CI-совместимости.

## Окружение и порядок локальной проверки

Создан отдельный venv `/tmp/eink-ci-venv` с CPython 3.11.16 через `uv venv --python 3.11 --seed /tmp/eink-ci-venv`; uv предварительно установлен в `/tmp/eink-ci-bootstrap`. В процессах проверки первым в PATH был `/tmp/eink-ci-venv/bin`, заданы `VIRTUAL_ENV`, `PYTHONNOUSERSITE=1`; для окончательного DFU — `NRFUTIL=adafruit-nrfutil`, как в workflow. Для команды DFU `APPLICATION_VERSION=1`.

Сборка использовала новый `firmware/.pio/build` и новые libdeps, но существующий кэш toolchain/framework `~/.platformio`; полностью пустой HOME для самой сборки не использовался. Старые пользовательские `artifacts/` локально не удалялись. Workflow удаляет старые артефакты только в свежем checkout CI, чтобы не публиковать файлы из прежних сборок.

Вначале `npm ci` и `npm test` выполнены на доступном Node 26.8.1 — успешно. Затем `npm test` выполнен на Node **22.23.5**, как major в workflow, через `npm exec --yes --package=node@22`, с HOME `/tmp/eink-ci-clean-home`. Оба запуска дали 47/47 JS и оба C++ PASS. Сообщения Bluetooth error в выводе принадлежат отрицательным сценариям проходящих тестов, не скрыты.

Для проверки YAML в venv дополнительно установлен PyYAML; точная запрошенная команда `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/firmware.yml'))"` завершилась кодом 0 без stdout. Ключ `'on'` явно заключён в кавычки, чтобы и YAML 1.1/PyYAML, и GitHub Actions читали строковый ключ.

Дополнительные smoke-проверки (одноразовые `python3 -c`, без новых постоянных тестов):
- упаковка с `ARTIFACTS_DIR=/tmp/eink-ci-clean-home/nested/artifacts`, включая все linked ARM smoke;
- DFU с новым HOME, без `NRF_SITE`, с CLI из venv;
- независимое чтение UF2/DFU и CRC16 через `binascii.crc_hqx(binary, 0xffff)`;
- семантическая проверка YAML, tag-only release, `always()` upload и совпадения всех release asset glob с реальными файлами.

## Проверенные значения

- UF2 family `0xADA52840`, начало `0x26000`, 574 блока, 293888 байт.
- BIN 146712 байт; конец образа `0x49d18`, padded UF2 до `0x49e00`, оба ниже `0xEC000`.
- DFU legacy 0.5, application_version 1, device_type `0x52`, softdevice_req `[0xB6]`.
- Ровно три файла: manifest.json, application .bin, init .dat (14 байт).
- CRC16 init = независимый CRC16 BIN = `0xfd97`.
- `.dfu.zip` и `-dfu.zip` идентичны; хеши файлов в verification совпадают с фактическими файлами.

## Остаточные риски

- Реальный GitHub runner, загрузка artifacts и создание Release не выполнялись: по заданию никакой публикации. Локально исполнены build/package/test команды; YAML разобран и проверен отдельным smoke, но это не запуск GitHub Actions.
- Legacy DFU 0.5 не подписан: CRC16 обнаруживает повреждение, но не подтверждает автора. Новые ключи/секреты не добавлены. Для подписанного формата потребуется поддержка соответствующего bootloader, provisioning ключа и другой совместимый pipeline; это не включено.
- Single-bank обновление может потерять приложение при сбое питания; нужна возможность USB-восстановления. SoftDevice/bootloader не включены в пакет, совместимость конкретной платы и аппаратные эффекты не проверялись.
- OTA consumer отсутствует в checkout. Совместимый суффикс обеспечен; реальный путь сайт → Release → BLE DFU не выполнялся.
- Pip-зависимости устанавливаются без pin, как в задании; образы `ubuntu-latest` и major-теги Actions обновляются. PlatformIO platform/framework/libs закреплены текущей конфигурацией. Сеть/registry и разрешения репозитория остаются внешними условиями CI.
- У прошивки уже был случайный build ID; повторные сборки и ZIP timestamps не обязаны давать одинаковые SHA256. Это не изменение протокола.

## Реальные выводы команд

Ниже stdout/stderr захвачены непосредственно из завершившихся процессов. Строки `$ ...` и `EXIT_CODE=...` добавлены локальным runner. Полные основные логи приведены без пересказа; дополнительные smoke-команды включают исполняемый код.

<details>
<summary>install-python</summary>

```text
$ pip install platformio pyelftools unicorn adafruit-nrfutil
Collecting platformio
  Downloading platformio-6.2.0-py3-none-any.whl.metadata (7.2 kB)
Collecting pyelftools
  Using cached pyelftools-0.33-py3-none-any.whl.metadata (1.0 kB)
Collecting unicorn
  Using cached unicorn-2.1.4-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl.metadata (4.2 kB)
Collecting adafruit-nrfutil
  Using cached adafruit-nrfutil-0.5.3.post16.tar.gz (49 kB)
  Installing build dependencies: started
  Installing build dependencies: finished with status 'done'
  Getting requirements to build wheel: started
  Getting requirements to build wheel: finished with status 'done'
  Preparing metadata (pyproject.toml): started
  Preparing metadata (pyproject.toml): finished with status 'done'
Requirement already satisfied: pip in /tmp/eink-ci-venv/lib/python3.11/site-packages (from platformio) (26.3)
Collecting bottle==0.13.* (from platformio)
  Downloading bottle-0.13.4-py2.py3-none-any.whl.metadata (1.6 kB)
Collecting click!=8.3,<8.6,>=8.0.4 (from platformio)
  Using cached click-8.5.1-py3-none-any.whl.metadata (2.6 kB)
Collecting colorama (from platformio)
  Downloading colorama-0.4.6-py2.py3-none-any.whl.metadata (17 kB)
Collecting marshmallow<5,>=3 (from platformio)
  Downloading marshmallow-4.4.0-py3-none-any.whl.metadata (6.8 kB)
Collecting pyserial==3.5.* (from platformio)
  Using cached pyserial-3.5-py2.py3-none-any.whl.metadata (1.6 kB)
Collecting requests==2.* (from platformio)
  Using cached requests-2.34.2-py3-none-any.whl.metadata (4.8 kB)
Collecting semantic_version==2.10.* (from platformio)
  Downloading semantic_version-2.10.0-py2.py3-none-any.whl.metadata (9.7 kB)
Collecting tabulate==0.* (from platformio)
  Using cached tabulate-0.10.0-py3-none-any.whl.metadata (40 kB)
Collecting ajsonrpc==1.2.* (from platformio)
  Downloading ajsonrpc-1.2.0-py3-none-any.whl.metadata (6.9 kB)
Collecting starlette<2 (from platformio)
  Downloading starlette-1.10.0-py3-none-any.whl.metadata (6.6 kB)
Collecting uvicorn<1 (from platformio)
  Downloading uvicorn-0.54.0-py3-none-any.whl.metadata (6.6 kB)
Collecting wsproto==1.* (from platformio)
  Downloading wsproto-1.3.2-py3-none-any.whl.metadata (5.2 kB)
Collecting charset_normalizer<4,>=2 (from requests==2.*->platformio)
  Downloading charset_normalizer-3.5.2-cp311-cp311-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl.metadata (46 kB)
Collecting idna<4,>=2.5 (from requests==2.*->platformio)
  Using cached idna-3.20-py3-none-any.whl.metadata (7.2 kB)
Collecting urllib3<3,>=1.26 (from requests==2.*->platformio)
  Using cached urllib3-2.8.0-py3-none-any.whl.metadata (7.4 kB)
Collecting certifi>=2023.5.7 (from requests==2.*->platformio)
  Downloading certifi-2026.11.20-py3-none-any.whl.metadata (2.5 kB)
Collecting anyio<5,>=4.0.0 (from starlette<2->platformio)
  Downloading anyio-4.16.0-py3-none-any.whl.metadata (4.7 kB)
Collecting typing-extensions>=4.10.0 (from starlette<2->platformio)
  Using cached typing_extensions-4.16.0-py3-none-any.whl.metadata (3.3 kB)
Collecting h11>=0.8 (from uvicorn<1->platformio)
  Downloading h11-0.16.0-py3-none-any.whl.metadata (8.3 kB)
Collecting ecdsa>=0.13 (from adafruit-nrfutil)
  Using cached ecdsa-0.19.2-py2.py3-none-any.whl.metadata (29 kB)
Collecting six>=1.9.0 (from ecdsa>=0.13->adafruit-nrfutil)
  Using cached six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)
Downloading platformio-6.2.0-py3-none-any.whl (418 kB)
Using cached pyelftools-0.33-py3-none-any.whl (201 kB)
Downloading ajsonrpc-1.2.0-py3-none-any.whl (22 kB)
Downloading bottle-0.13.4-py2.py3-none-any.whl (103 kB)
Using cached click-8.5.1-py3-none-any.whl (126 kB)
Downloading marshmallow-4.4.0-py3-none-any.whl (53 kB)
Using cached pyserial-3.5-py2.py3-none-any.whl (90 kB)
Using cached requests-2.34.2-py3-none-any.whl (73 kB)
Downloading charset_normalizer-3.5.2-cp311-cp311-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl (269 kB)
Using cached idna-3.20-py3-none-any.whl (69 kB)
Downloading semantic_version-2.10.0-py2.py3-none-any.whl (15 kB)
Downloading starlette-1.10.0-py3-none-any.whl (80 kB)
Downloading anyio-4.16.0-py3-none-any.whl (134 kB)
Using cached tabulate-0.10.0-py3-none-any.whl (39 kB)
Using cached urllib3-2.8.0-py3-none-any.whl (135 kB)
Downloading uvicorn-0.54.0-py3-none-any.whl (87 kB)
Downloading wsproto-1.3.2-py3-none-any.whl (24 kB)
Downloading h11-0.16.0-py3-none-any.whl (37 kB)
Using cached unicorn-2.1.4-cp37-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl (16.4 MB)
Downloading certifi-2026.11.20-py3-none-any.whl (127 kB)
Using cached ecdsa-0.19.2-py2.py3-none-any.whl (150 kB)
Using cached six-1.17.0-py2.py3-none-any.whl (11 kB)
Using cached typing_extensions-4.16.0-py3-none-any.whl (45 kB)
Downloading colorama-0.4.6-py2.py3-none-any.whl (25 kB)
Building wheels for collected packages: adafruit-nrfutil
  Building wheel for adafruit-nrfutil (pyproject.toml): started
  Building wheel for adafruit-nrfutil (pyproject.toml): finished with status 'done'
  Created wheel for adafruit-nrfutil: filename=adafruit_nrfutil-0.5.3.post16-py3-none-any.whl size=85217 sha256=a61ecd50c894d7b549edc9bcfb163583528902872b900ae19ca49155a35778b5
  Stored in directory: /home/aleph/.cache/pip/wheels/db/3c/20/c0258db2269dac052821c795dc9a56250f68b4d28004edecf4
Successfully built adafruit-nrfutil
Installing collected packages: pyserial, bottle, urllib3, unicorn, typing-extensions, tabulate, six, semantic_version, pyelftools, marshmallow, idna, h11, colorama, click, charset_normalizer, certifi, ajsonrpc, wsproto, uvicorn, requests, ecdsa, anyio, starlette, adafruit-nrfutil, platformio

Successfully installed adafruit-nrfutil-0.5.3.post16 ajsonrpc-1.2.0 anyio-4.16.0 bottle-0.13.4 certifi-2026.11.20 charset_normalizer-3.5.2 click-8.5.1 colorama-0.4.6 ecdsa-0.19.2 h11-0.16.0 idna-3.20 marshmallow-4.4.0 platformio-6.2.0 pyelftools-0.33 pyserial-3.5 requests-2.34.2 semantic_version-2.10.0 six-1.17.0 starlette-1.10.0 tabulate-0.10.0 typing-extensions-4.16.0 unicorn-2.1.4 urllib3-2.8.0 uvicorn-0.54.0 wsproto-1.3.2

EXIT_CODE=0
```

</details>

<details>
<summary>npm-ci</summary>

```text
$ npm ci
npm warn deprecated whatwg-encoding@3.1.1: Use @exodus/bytes instead for a more spec-conformant and faster implementation

added 43 packages, and audited 44 packages in 8s

7 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities

EXIT_CODE=0
```

</details>

<details>
<summary>environment</summary>

```text
$ python3 --version && pio --version && nrfutil version && node --version && npm --version && g++ --version
Python 3.11.16
PlatformIO Core, version 6.2.0
adafruit-nrfutil version 0.5.3.post16
v26.8.1
11.19.0
g++ (Ubuntu 15.2.0-16ubuntu1) 15.2.0
Copyright (C) 2025 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.


EXIT_CODE=0
```

</details>

<details>
<summary>entrypoints</summary>

```text
$ python3 -c "from importlib.metadata import distribution; print(distribution('adafruit-nrfutil').entry_points)"
[EntryPoint(name='adafruit-nrfutil', value='nordicsemi.__main__:cli', group='console_scripts')]

EXIT_CODE=0
```

</details>

<details>
<summary>build</summary>

```text
$ pio run -d firmware -e repin_bw
Processing repin_bw (platform: platformio/nordicnrf52@11.0.0; board: promicro_nrf52840_s140v6; framework: arduino)
--------------------------------------------------------------------------------
Library Manager: Installing zinggjm/GxEPD2 @ 1.6.9
Unpacking 0% 10% 20% 30% 40% 50% 60% 70% 80% 90% 100%
Library Manager: GxEPD2@1.6.9 has been installed!
Library Manager: Resolving dependencies...
Library Manager: Installing Adafruit GFX Library
Unpacking 0% 10% 20% 30% 40% 50% 60% 70% 80% 90% 100%
Library Manager: Adafruit GFX Library@1.13.0 has been installed!
Library Manager: Resolving dependencies...
Library Manager: Installing Adafruit BusIO
Unpacking 0% 10% 20% 30% 40% 50% 60% 70% 80% 90% 100%
Library Manager: Adafruit BusIO@1.17.4 has been installed!
Library Manager: Installing adafruit/Adafruit GFX Library @ 1.12.4
Unpacking 0% 10% 20% 30% 40% 50% 60% 70% 80% 90% 100%
Library Manager: Adafruit GFX Library@1.12.4 has been installed!
Library Manager: Resolving dependencies...
Verbose mode can be enabled via `-v, --verbose` option
CONFIGURATION: https://docs.platformio.org/page/boards/nordicnrf52/promicro_nrf52840_s140v6.html
PLATFORM: Nordic nRF52 (11.0.0) > Pro Micro nice!nano v2 pinout, S140 v6 application only
HARDWARE: NRF52840 64MHz, 232KB RAM, 792KB Flash
PACKAGES: 
 - framework-arduinoadafruitnrf52 @ 1.10601.0+sha.0fd295f1 
 - framework-cmsis @ 2.50700.210515 (5.7.0) 
 - tool-adafruit-nrfutil @ 1.503.0 (5.3) 
 - tool-sreccat @ 1.164.0 (1.64) 
 - toolchain-gccarmnoneeabi @ 1.70201.0 (7.2.1)
LDF: Library Dependency Finder -> https://bit.ly/configure-pio-ldf
LDF Modes: Finder ~ chain, Compatibility ~ soft
Found 17 compatible libraries
Scanning dependencies...
Dependency Graph
|-- GxEPD2 @ 1.6.9
|-- Adafruit GFX Library @ 1.12.4
|-- Adafruit BusIO @ 1.17.4
|-- Adafruit Internal File System on Bluefruit nRF52 @ 0.11.0
|-- SPI @ 1.0
|-- Adafruit Bluefruit nRF52 Libraries @ 0.21.0
Building in release mode
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/Adafruit_TinyUSB_API.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/Adafruit_USBD_CDC.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/Adafruit_USBD_Device.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/Adafruit_USBD_Interface.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/Adafruit_USBH_Host.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/cdc/Adafruit_USBH_CDC.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/hid/Adafruit_USBD_HID.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/midi/Adafruit_USBD_MIDI.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/msc/Adafruit_USBD_MSC.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/msc/Adafruit_USBH_MSC.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/ports/esp32/Adafruit_TinyUSB_esp32.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/ports/nrf/Adafruit_TinyUSB_nrf.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/ports/rp2040/Adafruit_TinyUSB_rp2040.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/ports/samd/Adafruit_TinyUSB_samd.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/video/Adafruit_USBD_Video.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/arduino/webusb/Adafruit_USBD_WebUSB.cpp.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/audio/audio_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/bth/bth_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/cdc/cdc_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/cdc/cdc_host.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/dfu/dfu_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/dfu/dfu_rt_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/hid/hid_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/hid/hid_host.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/midi/midi_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/msc/msc_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/msc/msc_host.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/net/ecm_rndis_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/net/ncm_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/usbtmc/usbtmc_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/vendor/vendor_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/class/video/video_device.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/common/tusb_fifo.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/device/usbd.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/device/usbd_control.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/host/hub.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/host/usbh.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/analog/max3421/hcd_max3421.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/microchip/samd/dcd_samd.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/nordic/nrf5x/dcd_nrf5x.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/raspberrypi/pio_usb/dcd_pio_usb.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/raspberrypi/pio_usb/hcd_pio_usb.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/raspberrypi/rp2040/dcd_rp2040.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/raspberrypi/rp2040/hcd_rp2040.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/raspberrypi/rp2040/rp2040_usb.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/portable/synopsys/dwc2/dcd_dwc2.c.o
Compiling .pio/build/repin_bw/lib6b6/Adafruit_TinyUSB_Arduino/tusb.c.o
Compiling .pio/build/repin_bw/src/main.cpp.o
Compiling .pio/build/repin_bw/lib0d2/Wire/Wire_nRF52.cpp.o
Compiling .pio/build/repin_bw/lib9ac/SPI/SPI.cpp.o
Compiling .pio/build/repin_bw/lib9ac/SPI/SPI_nrf52832.cpp.o
Compiling .pio/build/repin_bw/lib4d0/Adafruit BusIO/Adafruit_BusIO_Register.cpp.o
Archiving .pio/build/repin_bw/lib9ac/libSPI.a
Indexing .pio/build/repin_bw/lib9ac/libSPI.a
Compiling .pio/build/repin_bw/lib4d0/Adafruit BusIO/Adafruit_GenericDevice.cpp.o
Archiving .pio/build/repin_bw/lib0d2/libWire.a
Indexing .pio/build/repin_bw/lib0d2/libWire.a
Compiling .pio/build/repin_bw/lib4d0/Adafruit BusIO/Adafruit_I2CDevice.cpp.o
Compiling .pio/build/repin_bw/lib4d0/Adafruit BusIO/Adafruit_SPIDevice.cpp.o
Compiling .pio/build/repin_bw/lib133/Adafruit GFX Library@1.12.4/Adafruit_GFX.cpp.o
Compiling .pio/build/repin_bw/lib133/Adafruit GFX Library@1.12.4/Adafruit_GrayOLED.cpp.o
Compiling .pio/build/repin_bw/lib133/Adafruit GFX Library@1.12.4/Adafruit_SPITFT.cpp.o
Compiling .pio/build/repin_bw/lib133/Adafruit GFX Library@1.12.4/glcdfont.c.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/GxEPD2_EPD.cpp.o
Archiving .pio/build/repin_bw/lib4d0/libAdafruit BusIO.a
Indexing .pio/build/repin_bw/lib4d0/libAdafruit BusIO.a
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_102.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_1160_T91.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_1248.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_150_BN.cpp.o
Archiving .pio/build/repin_bw/lib133/libAdafruit GFX Library@1.12.4.a
Indexing .pio/build/repin_bw/lib133/libAdafruit GFX Library@1.12.4.a
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_154.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_154_D67.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_154_M09.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_154_M10.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_154_T8.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_B72.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_B73.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_B74.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_BN.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_M21.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_T5D.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_213_flex.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_260.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_260_M01.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_266_BN.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_270.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_BS.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_I6FD.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_M06.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_T5.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_T5D.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_T94.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_290_T94_V2.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_370_TC1.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_371.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_420.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_420_M01.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_583.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_583_T8.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_750.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd/GxEPD2_750_T7.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_1248c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_154_Z90c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_154c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_213_Z19c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_213_Z98c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_213c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_266c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_270c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_290_C90c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_290_Z13c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_290c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_420c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_420c_Z21.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_583c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_583c_Z83.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_750c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_750c_GDEW075Z08.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_750c_Z08.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd3c/GxEPD2_750c_Z90.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_1160c_GDEY116F51.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_154c_GDEM0154F51H.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_213c_GDEY0213F51.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_266c_GDEY0266F51H.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_290c_GDEY029F51H.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_300c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_350c_GDEM035F51.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_397c_GDEM0397F81.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_420c_GDEY0420F51.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_437c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_579c_GDEY0579F51.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd4c/GxEPD2_750c_GDEM075F52.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd7c/GxEPD2_565c.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd7c/GxEPD2_565c_GDEP0565D90.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd7c/GxEPD2_730c_ACeP_730.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd7c/GxEPD2_730c_GDEP073E01.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/epd7c/GxEPD2_730c_GDEY073D46.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdeh/GxEPD2_576_GDEH0576T81.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdem/GxEPD2_1020_GDEM102T91.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdem/GxEPD2_1085_GDEM1085T51.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdem/GxEPD2_1330_GDEM133T91.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdem/GxEPD2_397_GDEM0397T81.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdem3c/GxEPD2_1330c_GDEM133Z91.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdeq/GxEPD2_310_GDEQ031T10.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdeq/GxEPD2_426_GDEQ0426T82.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdeq/GxEPD2_583_GDEQ0583T31.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdeq3c/GxEPD2_583c_GDEQ0583Z31.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_154_GDEY0154D67.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_213_GDEY0213B74.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_266_GDEY0266T90.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_270_GDEY027T91.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_290_GDEY029T71H.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_290_GDEY029T94.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_370_GDEY037T03.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_420_GDEY042T81.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_579_GDEY0579T93.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey/GxEPD2_750_GDEY075T7.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey3c/GxEPD2_1160c_GDEY116Z91.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey3c/GxEPD2_420c_GDEY042Z98.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey3c/GxEPD2_579c_GDEY0579Z93.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/gdey3c/GxEPD2_750c_GDEY075Z08.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/it8951/GxEPD2_it103_1872x1404.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/it8951/GxEPD2_it60.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/it8951/GxEPD2_it60_1448x1072.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/it8951/GxEPD2_it78_1872x1404.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/other/GxEPD2_420_GYE042A87.cpp.o
Compiling .pio/build/repin_bw/libb92/GxEPD2/other/GxEPD2_420_SE0420NQ04.cpp.o
Compiling .pio/build/repin_bw/lib92b/Adafruit_LittleFS/Adafruit_LittleFS.cpp.o
Compiling .pio/build/repin_bw/lib92b/Adafruit_LittleFS/Adafruit_LittleFS_File.cpp.o
Compiling .pio/build/repin_bw/lib92b/Adafruit_LittleFS/littlefs/lfs.c.o
Compiling .pio/build/repin_bw/lib92b/Adafruit_LittleFS/littlefs/lfs_util.c.o
Compiling .pio/build/repin_bw/libbe6/InternalFileSytem/InternalFileSystem.cpp.o
Compiling .pio/build/repin_bw/libbe6/InternalFileSytem/flash/flash_cache.c.o
Compiling .pio/build/repin_bw/libbe6/InternalFileSytem/flash/flash_nrf5x.c.o
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/Adafruit_nRFCrypto.cpp.o
Archiving .pio/build/repin_bw/libb92/libGxEPD2.a
Archiving .pio/build/repin_bw/libbe6/libInternalFileSytem.a
Indexing .pio/build/repin_bw/libbe6/libInternalFileSytem.a
Indexing .pio/build/repin_bw/libb92/libGxEPD2.a
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/ecc/nRFCrypto_ECC.cpp.o
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/ecc/nRFCrypto_ECC_PrivateKey.cpp.o
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/ecc/nRFCrypto_ECC_PublicKey.cpp.o
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/nRFCrypto_Hash.cpp.o
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/nRFCrypto_Hmac.cpp.o
Compiling .pio/build/repin_bw/liba93/Adafruit_nRFCrypto/nRFCrypto_Random.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEAdvertising.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLECentral.cpp.o
Archiving .pio/build/repin_bw/liba93/libAdafruit_nRFCrypto.a
Indexing .pio/build/repin_bw/liba93/libAdafruit_nRFCrypto.a
Compiling .pio/build/repin_bw/project-core/BLECharacteristic.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEClientCharacteristic.cpp.o
Archiving .pio/build/repin_bw/lib92b/libAdafruit_LittleFS.a
Indexing .pio/build/repin_bw/lib92b/libAdafruit_LittleFS.a
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEClientService.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEConnection.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEDiscovery.cpp.o
Compiling .pio/build/repin_bw/project-core/BLEGatt.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEPeriph.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEScanner.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLESecurity.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEService.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/BLEUuid.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/bluefruit.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEAncs.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEClientBas.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEClientCts.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEClientDis.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEClientHidAdafruit.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEClientIas.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/clients/BLEClientUart.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEBas.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEBeacon.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEDfu.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEDis.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEHidAdafruit.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEHidGamepad.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEHidGeneric.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEIas.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEMidi.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/BLEUart.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/services/EddyStone.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/utility/AdaMsg.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/utility/bonding.cpp.o
Compiling .pio/build/repin_bw/libc8a/Bluefruit52Lib/utility/bootloader_util.c.o
Compiling .pio/build/repin_bw/FrameworkArduinoVariant/variant.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/HardwarePWM.cpp.o
Archiving .pio/build/repin_bw/libFrameworkArduinoVariant.a
Indexing .pio/build/repin_bw/libFrameworkArduinoVariant.a
Compiling .pio/build/repin_bw/FrameworkArduino/IPAddress.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/Print.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/RingBuffer.cpp.o
Archiving .pio/build/repin_bw/libc8a/libBluefruit52Lib.a
Indexing .pio/build/repin_bw/libc8a/libBluefruit52Lib.a
Compiling .pio/build/repin_bw/FrameworkArduino/Stream.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/Tone.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/Uart.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/WInterrupts.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/WMath.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/WString.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/abi.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/avr/dtostrf.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/delay.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/croutine.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/event_groups.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/list.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/portable/MemMang/heap_3.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/queue.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/stream_buffer.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/tasks.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/Source/timers.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/portable/CMSIS/nrf52/port_cmsis.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/portable/CMSIS/nrf52/port_cmsis_systick.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/freertos/portable/GCC/nrf52/port.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/hooks.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/itoa.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/linker/gcc_startup_nrf52.S.o
Compiling .pio/build/repin_bw/FrameworkArduino/linker/gcc_startup_nrf52833.S.o
Compiling .pio/build/repin_bw/FrameworkArduino/linker/gcc_startup_nrf52840.S.o
Compiling .pio/build/repin_bw/FrameworkArduino/main.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/new.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_gpiote.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_power.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_pwm.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_qspi.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_spim.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_spis.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_temp.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_timer.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/drivers/src/nrfx_wdt.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/mdk/system_nrf52.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/mdk/system_nrf52833.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/nordic/nrfx/mdk/system_nrf52840.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/pulse.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/pulse_asm.S.o
Compiling .pio/build/repin_bw/FrameworkArduino/rtos.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/sysview/Config/SEGGER_SYSVIEW_Config_FreeRTOS.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/sysview/SEGGER/SEGGER_RTT.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/sysview/SEGGER/SEGGER_RTT_ASM_ARMv7M.S.o
Compiling .pio/build/repin_bw/FrameworkArduino/sysview/SEGGER/SEGGER_RTT_printf.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/sysview/SEGGER/SEGGER_SYSVIEW.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/sysview/SEGGER_SYSVIEW_FreeRTOS.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/utility/AdaCallback.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/utility/SoftwareTimer.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/utility/adafruit_fifo.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/utility/debug.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/utility/utilities.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/wiring.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/wiring_analog.cpp.o
Compiling .pio/build/repin_bw/FrameworkArduino/wiring_analog_nRF52.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/wiring_digital.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/wiring_private.c.o
Compiling .pio/build/repin_bw/FrameworkArduino/wiring_shift.c.o
Archiving .pio/build/repin_bw/libFrameworkArduino.a
Indexing .pio/build/repin_bw/libFrameworkArduino.a
Linking .pio/build/repin_bw/firmware.elf
Checking size .pio/build/repin_bw/firmware.elf
Advanced Memory Usage is available via "PlatformIO Home > Project Inspect"
RAM:   [=         ]   9.8% (used 23304 bytes from 237568 bytes)
Flash: [==        ]  18.1% (used 146712 bytes from 811008 bytes)
Building .pio/build/repin_bw/firmware.hex
Building .pio/build/repin_bw/firmware.zip
Zip created at .pio/build/repin_bw/firmware.zip
========================= [SUCCESS] Took 96.15 seconds =========================

EXIT_CODE=0
```

</details>

<details>
<summary>package</summary>

```text
$ PYTHONPATH=tools python3 tools/package_firmware.py
{"linked_actions": {"reset_status": "01000001000000000000a00f0000000000000000", "enter_dfu_status": "01000002000000000000a00f0000000000000000", "dfu_while_receiving_status": "010102001f0000000000a00fbe938b3a00000000", "action_armed_before_svc": false}}
{"linked_deferred_action": {"successful_att_authorization_arms": true, "failed_att_authorization_clears": [2, 2, 0, 0], "failed_status_publication_att_error": 270, "failed_status_publication_clears": [2, 2, 0, 0]}}
{"linked_v2": [{"write_ceiling": 20, "codec": 0, "wire_bytes": 4000, "status": "0202000009000000a00fa00fbe938b3a00000000"}, {"write_ceiling": 125, "codec": 0, "wire_bytes": 4000, "status": "0202000009000000a00fa00fbe938b3a00000000"}, {"write_ceiling": 244, "codec": 0, "wire_bytes": 4000, "status": "0202000009000000a00fa00fbe938b3a00000000"}, {"write_ceiling": 20, "codec": 1, "wire_bytes": 64, "status": "020200010900000040004000be938b3a00000000"}, {"write_ceiling": 125, "codec": 1, "wire_bytes": 64, "status": "020200010900000040004000be938b3a00000000"}, {"write_ceiling": 244, "codec": 1, "wire_bytes": 64, "status": "020200010900000040004000be938b3a00000000"}]}
{
  "elf": "/home/aleph/eink-ble-fix/artifacts/eink-ble-welcome-once-dfu-bw-s140v6.elf",
  "START_authorize_SVC": {
    "svc": 176,
    "type": 2,
    "status": 0,
    "update": 1,
    "offset": 0,
    "length": 11,
    "data": "0107000000a00ffda24d01"
  },
  "DATA_packets": 308,
  "frame_bytes": 4000,
  "final_status": "0102000007000000a00fa00ffda24d0100000000",
  "CRC32": "0x14da2fd",
  "scope": "Linked callback/receiver to SVC boundary with injected authorization outcomes; no SoftDevice, RF or hardware execution"
}
ARM callback contract + full MTU23 frame + action success/failure sequencing PASS
{
  "guard_opcodes": [
    4,
    5,
    6
  ],
  "capabilities": [
    {
      "present": true,
      "connected": true,
      "mtu_input": 23,
      "safeWrite": 20
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 128,
      "safeWrite": 125
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 247,
      "safeWrite": 244
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 517,
      "safeWrite": 244
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 0,
      "safeWrite": 20
    },
    {
      "present": false,
      "connected": false,
      "mtu_input": 247,
      "safeWrite": 20
    },
    {
      "present": true,
      "connected": false,
      "mtu_input": 247,
      "safeWrite": 20
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 23,
      "safeWrite": 20
    }
  ],
  "scope": "Linked ARM core guard/callback to SVC; no SoftDevice, RF, allocation or display simulation"
}
{
  "origin": "0x26000",
  "limit_exclusive": "0xec000",
  "family": "0xada52840",
  "binary_bytes": 146712,
  "image_end_exclusive": "0x49d18",
  "layout_margin_bytes": 664296,
  "embedded_build_id": "0x6298e50e",
  "state_sector": {
    "address": "0xec000",
    "size_bytes": 4096,
    "excluded_from_application": true
  },
  "uf2_bytes": 293888,
  "blocks": 574,
  "initial_sp": "0x20040000",
  "reset_vector": "0x36549",
  "arm_smoke": [
    {
      "initial_out": 0,
      "initial_cnf": 0,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    },
    {
      "initial_out": 8192,
      "initial_cnf": 0,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    },
    {
      "initial_out": 8192,
      "initial_cnf": 3,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    },
    {
      "initial_out": 0,
      "initial_cnf": 3,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    }
  ],
  "linked_action_smoke": [
    {
      "linked_actions": {
        "reset_status": "01000001000000000000a00f0000000000000000",
        "enter_dfu_status": "01000002000000000000a00f0000000000000000",
        "dfu_while_receiving_status": "010102001f0000000000a00fbe938b3a00000000",
        "action_armed_before_svc": false
      }
    },
    {
      "linked_deferred_action": {
        "successful_att_authorization_arms": true,
        "failed_att_authorization_clears": [
          2,
          2,
          0,
          0
        ],
        "failed_status_publication_att_error": 270,
        "failed_status_publication_clears": [
          2,
          2,
          0,
          0
        ]
      }
    }
  ],
  "welcome": {
    "source": "assets/approved-welcome.png",
    "source_size": [
      122,
      250
    ],
    "preview": "assets/approved-welcome-preview.png",
    "preview_size": [
      610,
      1250
    ],
    "preview_scale": 5,
    "source_pixels_compared": 30500,
    "preview_pixels_compared": 762500,
    "elf_symbol": "eink_welcome_bitmap",
    "frame_bytes": 4000,
    "frame_sha256": "dc6e05e5f09d7df9b32d3952472577744d534723f11f60ed1204370180169733",
    "layout": "MSB-first, black=1, stride=16, zero padding",
    "match": true
  },
  "authorize_contract": "PASS: linked ARM v1/v2 callback/receiver and core PREP/EXEC/capabilities to SVC boundary; injected SVC returns verify deferred action success/failure",
  "scope": "Linked ARM protocol/authorization with injected SVC outcomes, plus GPIO/SPI memory-backed MMIO; not hardware, RF, display timing or electrical verification.",
  "sha256": {
    "eink-ble-welcome-once-dfu-bw-s140v6.elf": "c4c7f2f4c60463c239a8529311ec4d035a75a043d14ac71e0378804645ca0a15",
    "eink-ble-welcome-once-dfu-bw-s140v6.hex": "21a36060819428e1890643bad08fba6ab8a80e51bf85534f19d709e37e55e3ec",
    "eink-ble-welcome-once-dfu-bw-s140v6.bin": "0248a0f0cfbd334961581226a0343b7aebacd0405bfdc171452a9f42b08f1563",
    "eink-ble-welcome-once-dfu-bw-s140v6.uf2": "8d07d99121ea77d76f9c41c4c43be0f451cd64f008f9505e58a5e53a3d129373",
    "eink-ble-welcome-once-dfu-bw-s140v6.zip": "a50c6cf44325e3f1f98f6fefe58e47480f9dd0712c8245226751f51ea8657748"
  }
}

EXIT_CODE=0
```

</details>

<details>
<summary>dfu</summary>

```text
$ python3 tools/dfu_package.py artifacts/eink-ble-welcome-once-dfu-bw-s140v6.hex --application-version "$APPLICATION_VERSION" --output artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip
Zip created at /home/aleph/eink-ble-fix/artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip
{
  "package": "/home/aleph/eink-ble-fix/artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip",
  "sha256": "96c384745ca9e9a5ac75b52de1c7fb8a8fea6beb8f4e34ede853dad8f84fbcd3",
  "application_version": 1,
  "dfu_version": 0.5,
  "device_type": "0x52",
  "sd_req": [
    "0xb6"
  ],
  "hex_bounds": {
    "min": "0x26000",
    "max_exclusive": "0x49d18"
  },
  "application_bin_bytes": 146712,
  "firmware_sha256": "0248a0f0cfbd334961581226a0343b7aebacd0405bfdc171452a9f42b08f1563",
  "signature": "none: DFU 0.5 legacy init packet (CRC16 metadata only)",
  "files": {
    "manifest.json": {
      "bytes": 510,
      "sha256": "3f63130588dbe4a6ed1400e628e6e7f723c0b32721bf93d64d3f65355b53b675"
    },
    "eink-ble-welcome-once-dfu-bw-s140v6.bin": {
      "bytes": 146712,
      "sha256": "0248a0f0cfbd334961581226a0343b7aebacd0405bfdc171452a9f42b08f1563"
    },
    "eink-ble-welcome-once-dfu-bw-s140v6.dat": {
      "bytes": 14,
      "sha256": "da32dd13cc52a412eb4a1abd7c5f4a94aa246e0488a22dfe8f05bdfc4cc05b33"
    }
  },
  "zip_bytes": 147668
}

EXIT_CODE=0
```

</details>

<details>
<summary>ota-copy</summary>

```text
$ cp artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip

EXIT_CODE=0
```

</details>

<details>
<summary>tests-node22</summary>

```text
$ npm exec --yes --package=node@22 --call 'node --version && npm test'
v22.23.5

> eink-ble-studio@1.0.0 test
> node --test tests/*.test.js && python3 tests/run_cpp.py

TAP version 13
# Bluetooth error: Error: discovery capabilities: discovery failed
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:151:28
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:67:40
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:67:5)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error [NetworkError]: discovery failed
#       at Object.getCharacteristic (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:35:81)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:151:98
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Bluetooth error: Error: Invalid device capabilities
#     at decodeCapabilities (file:///home/aleph/eink-ble-fix/web/ble.js:40:372)
#     at file:///home/aleph/eink-ble-fix/web/ble.js:158:9
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:67:40
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:67:5)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Bluetooth error: Error: DATA2 offset 0: Unexpected device acknowledgement; reconnect and restart the transfer
#     at ack (file:///home/aleph/eink-ble-fix/web/ble.js:211:15)
#     at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:219:11)
#     ... 5 lines matching cause stack trace ...
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   [cause]: Error: Unexpected device acknowledgement
#       at check (file:///home/aleph/eink-ble-fix/web/ble.js:202:160)
#       at ack (file:///home/aleph/eink-ble-fix/web/ble.js:208:16)
#       at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:219:11)
#       at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#       at async waitForActual (node:assert:644:5)
#       at async Function.rejects (node:assert:767:25)
#       at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:76:5)
#       at async Test.run (node:internal/test_runner/test:1054:7)
#       at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# }
# Bluetooth error: Error: DATA2 offset 0: write DATA2 offset 0: link lost; reconnect and restart the transfer
#     at ack (file:///home/aleph/eink-ble-fix/web/ble.js:211:15)
#     at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:219:11)
#     ... 5 lines matching cause stack trace ...
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   [cause]: Error: write DATA2 offset 0: link lost
#       at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#       at async ack (file:///home/aleph/eink-ble-fix/web/ble.js:207:9)
#       at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:219:11)
#       at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#       at async waitForActual (node:assert:644:5)
#       at async Function.rejects (node:assert:767:25)
#       at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:76:5)
#       at async Test.run (node:internal/test_runner/test:1054:7)
#       at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#     timeout: false,
#     [cause]: Error: link lost
#         at Object.writeValueWithResponse (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:19:124)
#         at BleTransport.writeWithResponse (file:///home/aleph/eink-ble-fix/web/ble.js:181:92)
#         at file:///home/aleph/eink-ble-fix/web/ble.js:207:68
#         at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
#   }
# }
# Bluetooth error: Error: refresh: Display refresh timed out; check device status before retrying
#     at BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:226:43)
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:86:5)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Subtest: v2 discovery and negotiated ceilings are reread for each transfer
ok 1 - v2 discovery and negotiated ceilings are reread for each transfer
  ---
  duration_ms: 33.450247
  type: 'test'
  ...
# Subtest: capability absence falls back, discovery and corrupt capabilities do not
ok 2 - capability absence falls back, discovery and corrupt capabilities do not
  ---
  duration_ms: 191.644494
  type: 'test'
  ...
# Subtest: bad v2 acknowledgement or disconnect never produces a successful commit
ok 3 - bad v2 acknowledgement or disconnect never produces a successful commit
  ---
  duration_ms: 13.69532
  type: 'test'
  ...
# Bluetooth error: Error: DATA2 offset 0: write DATA2 offset 0: timed out; reconnect and restart the transfer; reconnect and restart the transfer
#     at ack (file:///home/aleph/eink-ble-fix/web/ble.js:211:15)
#     at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:219:11)
#     ... 5 lines matching cause stack trace ...
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   [cause]: Error: write DATA2 offset 0: timed out; reconnect and restart the transfer
#       at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#       at async ack (file:///home/aleph/eink-ble-fix/web/ble.js:207:9)
#       at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:219:11)
#       at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#       at async waitForActual (node:assert:644:5)
#       at async Function.rejects (node:assert:767:25)
#       at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:86:5)
#       at async Test.run (node:internal/test_runner/test:1054:7)
#       at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#     timeout: true,
#     [cause]: Error: timed out; reconnect and restart the transfer
#         at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#         at listOnTimeout (node:internal/timers:585:17)
#         at process.processTimers (node:internal/timers:521:7) {
#       timeout: true
#     }
#   }
# }
# Bluetooth error: Error: START2: write START2: No response-confirmed write API; reconnect and restart the transfer
#     at ack (file:///home/aleph/eink-ble-fix/web/ble.js:211:15)
#     at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:214:13)
#     ... 5 lines matching cause stack trace ...
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   [cause]: Error: write START2: No response-confirmed write API
#       at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#       at async ack (file:///home/aleph/eink-ble-fix/web/ble.js:207:9)
#       at async BleTransport.send2 (file:///home/aleph/eink-ble-fix/web/ble.js:214:13)
#       at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#       at async waitForActual (node:assert:644:5)
#       at async Function.rejects (node:assert:767:25)
#       at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble-v2-client.test.js:115:7)
#       at async Test.run (node:internal/test_runner/test:1054:7)
#       at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#     timeout: false,
#     [cause]: Error: No response-confirmed write API
#         at BleTransport.writeWithResponse (file:///home/aleph/eink-ble-fix/web/ble.js:183:11)
#         at file:///home/aleph/eink-ble-fix/web/ble.js:207:68
#         at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
#   }
# }
# Subtest: queued COMMIT is not display success and uncertain DATA is not retried
ok 4 - queued COMMIT is not display success and uncertain DATA is not retried
  ---
  duration_ms: 36.755387
  type: 'test'
  ...
# Subtest: reconnect discards previous ceiling and explicit force20 bounds a restarted attempt
ok 5 - reconnect discards previous ceiling and explicit force20 bounds a restarted attempt
  ---
  duration_ms: 12.722928
  type: 'test'
  ...
# Subtest: legacy write API is allowed only with unambiguous response-only properties
ok 6 - legacy write API is allowed only with unambiguous response-only properties
  ---
  duration_ms: 6.761495
  type: 'test'
  ...
# Subtest: v2 codec, capabilities and framing wire contract
ok 7 - v2 codec, capabilities and framing wire contract
  ---
  duration_ms: 31.259994
  type: 'test'
  ...
# Subtest: JS packets round trip through C++ receiver at MTU 23
ok 8 - JS packets round trip through C++ receiver at MTU 23
  ---
  duration_ms: 755.497845
  type: 'test'
  ...
# Subtest: JS packets round trip through C++ receiver at MTU 128
ok 9 - JS packets round trip through C++ receiver at MTU 128
  ---
  duration_ms: 243.252832
  type: 'test'
  ...
# Subtest: JS packets round trip through C++ receiver at MTU 247
ok 10 - JS packets round trip through C++ receiver at MTU 247
  ---
  duration_ms: 144.527983
  type: 'test'
  ...
# Subtest: compressed tokens split at every byte and exact output length
ok 11 - compressed tokens split at every byte and exact output length
  ---
  duration_ms: 99.993113
  type: 'test'
  ...
# Subtest: START and COMMIT are idempotent without decoding or refreshing twice
ok 12 - START and COMMIT are idempotent without decoding or refreshing twice
  ---
  duration_ms: 41.561836
  type: 'test'
  ...
# Subtest: malformed headers and excessive encoded lengths are rejected before input is consumed
ok 13 - malformed headers and excessive encoded lengths are rejected before input is consumed
  ---
  duration_ms: 81.376469
  type: 'test'
  ...
# Subtest: v2 bounds, ownership, duplicate and recovery rules
ok 14 - v2 bounds, ownership, duplicate and recovery rules
  ---
  duration_ms: 98.168391
  type: 'test'
  ...
# Subtest: disconnect, timeout, restart and shared v1 ownership
ok 15 - disconnect, timeout, restart and shared v1 ownership
  ---
  duration_ms: 41.516951
  type: 'test'
  ...
# Subtest: malformed compressed streams, CRC and padding cannot refresh
ok 16 - malformed compressed streams, CRC and padding cannot refresh
  ---
  duration_ms: 186.913724
  type: 'test'
  ...
# Subtest: every truncated run stream prefix and trailing token is rejected
ok 17 - every truncated run stream prefix and trailing token is rejected
  ---
  duration_ms: 2168.764843
  type: 'test'
  ...
# Bluetooth error: Error: read ack DATA offset 0: Device error: offset
#     at BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:240:28)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:260:11
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:34:62)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Bluetooth error: Error: write DATA offset 13: Disconnected
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:260:11
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:38:56)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: Disconnected
#       at Object.writeValueWithResponse (file:///home/aleph/eink-ble-fix/tests/ble.test.js:16:61)
#       at BleTransport.writeWithResponse (file:///home/aleph/eink-ble-fix/web/ble.js:181:92)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:238:68
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Subtest: MTU23 approved frame acknowledged end-to-end with exact duplicate after lost ACK
ok 18 - MTU23 approved frame acknowledged end-to-end with exact duplicate after lost ACK
  ---
  duration_ms: 240.741444
  type: 'test'
  ...
# Subtest: explicit rejection never commits or reports success
ok 19 - explicit rejection never commits or reports success
  ---
  duration_ms: 4.387444
  type: 'test'
  ...
# Subtest: disconnect fails incomplete transfer; fresh reconnect restarts and succeeds
ok 20 - disconnect fails incomplete transfer; fresh reconnect restarts and succeeds
  ---
  duration_ms: 82.438395
  type: 'test'
  ...
# Bluetooth error: Error: write START: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:255:13
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:43:66)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Subtest: operation timeout disconnects uncertain GATT and does not retry concurrently
ok 21 - operation timeout disconnects uncertain GATT and does not retry concurrently
  ---
  duration_ms: 15.162975
  type: 'test'
  ...
# Bluetooth error: Error: refresh: Display refresh timed out; check device status before retrying
#     at file:///home/aleph/eink-ble-fix/web/ble.js:266:41
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:47:73)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Bluetooth error: Error: Invalid frame padding
#     at file:///home/aleph/eink-ble-fix/web/ble.js:252:70
#     at BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:24)
#     at BleTransport.send (file:///home/aleph/eink-ble-fix/web/ble.js:250:92)
#     at TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:51:25)
#     at Test.runInAsyncScope (node:async_hooks:214:14)
#     at Test.run (node:internal/test_runner/test:1047:25)
#     at Test.processPendingSubtests (node:internal/test_runner/test:744:18)
#     at Test.postRun (node:internal/test_runner/test:1173:19)
#     at Test.run (node:internal/test_runner/test:1101:12)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Bluetooth error: Error: Invalid frame length
#     at file:///home/aleph/eink-ble-fix/web/ble.js:251:79
#     at BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:24)
#     at BleTransport.send (file:///home/aleph/eink-ble-fix/web/ble.js:250:92)
#     at TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:51:71)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Bluetooth error: Error: Web Bluetooth is unavailable in this browser. Use supported Chromium on HTTPS or localhost; iOS Safari is not supported.
#     at file:///home/aleph/eink-ble-fix/web/ble.js:124:32
#     at BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:24)
#     at BleTransport.connect (file:///home/aleph/eink-ble-fix/web/ble.js:123:27)
#     at TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:55:68)
#     at Test.runInAsyncScope (node:async_hooks:214:14)
#     at Test.run (node:internal/test_runner/test:1047:25)
#     at Test.processPendingSubtests (node:internal/test_runner/test:744:18)
#     at Test.postRun (node:internal/test_runner/test:1173:19)
#     at Test.run (node:internal/test_runner/test:1101:12)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Subtest: display refresh has finite timeout distinct from transfer completion
ok 22 - display refresh has finite timeout distinct from transfer completion
  ---
  duration_ms: 361.969264
  type: 'test'
  ...
# Subtest: corrupt local padding and invalid lengths never reach GATT
ok 23 - corrupt local padding and invalid lengths never reach GATT
  ---
  duration_ms: 3.061019
  type: 'test'
  ...
# Subtest: missing Web Bluetooth produces actionable error
ok 24 - missing Web Bluetooth produces actionable error
  ---
  duration_ms: 5.951225
  type: 'test'
  ...
# Bluetooth error: Error: connect: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:133:20
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:75:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: discovery service: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:138:21
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:75:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: discovery command: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:139:21
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:75:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: discovery status: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:140:20
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:75:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: discovery service: service denied
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:138:21
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:81:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: service denied
#       at service (file:///home/aleph/eink-ble-fix/tests/ble.test.js:80:48)
#       at Object.getPrimaryService (file:///home/aleph/eink-ble-fix/tests/ble.test.js:66:47)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:138:85
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Bluetooth error: Error: write START: write failed
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:255:13
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:91:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: write failed
#       at f.command.writeValueWithResponse (file:///home/aleph/eink-ble-fix/tests/ble.test.js:88:58)
#       at BleTransport.writeWithResponse (file:///home/aleph/eink-ble-fix/web/ble.js:181:92)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:238:68
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Bluetooth error: Error: write DATA offset 13: write failed
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:260:11
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:91:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: write failed
#       at f.command.writeValueWithResponse (file:///home/aleph/eink-ble-fix/tests/ble.test.js:88:58)
#       at BleTransport.writeWithResponse (file:///home/aleph/eink-ble-fix/web/ble.js:181:92)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:238:68
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Bluetooth error: Error: write COMMIT: write failed
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:263:9
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:91:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: write failed
#       at f.command.writeValueWithResponse (file:///home/aleph/eink-ble-fix/tests/ble.test.js:88:58)
#       at BleTransport.writeWithResponse (file:///home/aleph/eink-ble-fix/web/ble.js:181:92)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:238:68
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Bluetooth error: Error: read ack DATA offset 0: read failed
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.readStatusInternal (file:///home/aleph/eink-ble-fix/web/ble.js:173:19)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:239:19)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:260:11
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:95:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: read failed
#       at f.status.readValue (file:///home/aleph/eink-ble-fix/tests/ble.test.js:94:62)
#       at file:///home/aleph/eink-ble-fix/web/ble.js:173:74
#       at file:///home/aleph/eink-ble-fix/web/ble.js:101:157
# }
# Subtest: discovery failures and timeouts identify the exact stage
ok 25 - discovery failures and timeouts identify the exact stage
  ---
  duration_ms: 72.590158
  type: 'test'
  ...
# Subtest: write and acknowledgement errors identify packet and DATA offset
ok 26 - write and acknowledgement errors identify packet and DATA offset
  ---
  duration_ms: 102.958418
  type: 'test'
  ...
# Bluetooth error: Error: write START: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:255:13
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:105:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: read ack START: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.readStatusInternal (file:///home/aleph/eink-ble-fix/web/ble.js:173:19)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:239:19)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:255:13
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:105:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: refresh read status: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.readStatusInternal (file:///home/aleph/eink-ble-fix/web/ble.js:173:19)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:268:11
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:105:3)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: write START: Disconnected; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:255:13
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:118:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: Disconnected; reconnect and restart the transfer
#       at BleTransport.disconnect (file:///home/aleph/eink-ble-fix/web/ble.js:71:21)
#       at TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:117:4)
#       at async Test.run (node:internal/test_runner/test:1054:7)
#       at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# }
# Subtest: timeouts identify write, ack and refresh reads without concurrent retry
ok 27 - timeouts identify write, ack and refresh reads without concurrent retry
  ---
  duration_ms: 455.869244
  type: 'test'
  ...
# Subtest: connect, send and status reject re-entry and disconnect cancels pending work
ok 28 - connect, send and status reject re-entry and disconnect cancels pending work
  ---
  duration_ms: 6.88732
  type: 'test'
  ...
# Bluetooth error: Error: connect: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:133:20
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:128:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: connect: previous connection attempt or GATT operation is still pending
#     at file:///home/aleph/eink-ble-fix/web/ble.js:130:57
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:129:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Bluetooth error: Error: discovery status: Disconnected; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:140:20
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:139:17)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: false,
#   [cause]: Error: Disconnected; reconnect and restart the transfer
#       at BleTransport.disconnect (file:///home/aleph/eink-ble-fix/web/ble.js:71:21)
#       at TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:139:4)
#       at async Test.run (node:internal/test_runner/test:1054:7)
#       at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# }
# Subtest: late connection cannot restore stale characteristics or disconnect a new attempt
ok 29 - late connection cannot restore stale characteristics or disconnect a new attempt
  ---
  duration_ms: 9.521307
  type: 'test'
  ...
# Subtest: late discovery result after disconnect cannot publish characteristics
ok 30 - late discovery result after disconnect cannot publish characteristics
  ---
  duration_ms: 2.953688
  type: 'test'
  ...
# Bluetooth error: Error: write START: timed out; reconnect and restart the transfer
#     at BleTransport.operation (file:///home/aleph/eink-ble-fix/web/ble.js:117:21)
#     at async BleTransport.writeAck (file:///home/aleph/eink-ble-fix/web/ble.js:238:9)
#     at async file:///home/aleph/eink-ble-fix/web/ble.js:255:13
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:148:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7) {
#   timeout: true,
#   [cause]: Error: timed out; reconnect and restart the transfer
#       at Timeout.<anonymous> (file:///home/aleph/eink-ble-fix/web/ble.js:111:75)
#       at listOnTimeout (node:internal/timers:585:17)
#       at process.processTimers (node:internal/timers:521:7) {
#     timeout: true
#   }
# }
# Bluetooth error: Error: connect: previous connection attempt or GATT operation is still pending
#     at file:///home/aleph/eink-ble-fix/web/ble.js:130:57
#     at async BleTransport.run (file:///home/aleph/eink-ble-fix/web/ble.js:89:18)
#     at async waitForActual (node:assert:644:5)
#     at async Function.rejects (node:assert:767:25)
#     at async TestContext.<anonymous> (file:///home/aleph/eink-ble-fix/tests/ble.test.js:149:2)
#     at async Test.run (node:internal/test_runner/test:1054:7)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
# Subtest: pending timed-out GATT write prevents reconnecting the same device
ok 31 - pending timed-out GATT write prevents reconnecting the same device
  ---
  duration_ms: 28.207615
  type: 'test'
  ...
# Subtest: shared CRC vector 0
ok 32 - shared CRC vector 0
  ---
  duration_ms: 6.396676
  type: 'test'
  ...
# Subtest: shared CRC vector 1
ok 33 - shared CRC vector 1
  ---
  duration_ms: 1.222116
  type: 'test'
  ...
# Subtest: shared CRC vector 2
ok 34 - shared CRC vector 2
  ---
  duration_ms: 1.128036
  type: 'test'
  ...
# Subtest: shared packing 1×1: black polarity, stride and padding
ok 35 - shared packing 1×1: black polarity, stride and padding
  ---
  duration_ms: 4.481859
  type: 'test'
  ...
# Subtest: shared packing 7×2: black polarity, stride and padding
ok 36 - shared packing 7×2: black polarity, stride and padding
  ---
  duration_ms: 1.268381
  type: 'test'
  ...
# Subtest: shared packing 8×2: black polarity, stride and padding
ok 37 - shared packing 8×2: black polarity, stride and padding
  ---
  duration_ms: 0.889904
  type: 'test'
  ...
# Subtest: shared packing 9×2: black polarity, stride and padding
ok 38 - shared packing 9×2: black polarity, stride and padding
  ---
  duration_ms: 0.730258
  type: 'test'
  ...
# Subtest: shared packing 122×2: black polarity, stride and padding
ok 39 - shared packing 122×2: black polarity, stride and padding
  ---
  duration_ms: 1.201555
  type: 'test'
  ...
# Subtest: shared packing 122×250: black polarity, stride and padding
ok 40 - shared packing 122×250: black polarity, stride and padding
  ---
  duration_ms: 54.630685
  type: 'test'
  ...
# Subtest: approved reference pixel-for-pixel survives conversion
ok 41 - approved reference pixel-for-pixel survives conversion
  ---
  duration_ms: 107.264383
  type: 'test'
  ...
# Subtest: threshold boundary, inversion, brightness and contrast
ok 42 - threshold boundary, inversion, brightness and contrast
  ---
  duration_ms: 2.95628
  type: 'test'
  ...
# Subtest: Floyd–Steinberg diffusion and Bayer use real spatial patterns
ok 43 - Floyd–Steinberg diffusion and Bayer use real spatial patterns
  ---
  duration_ms: 0.718591
  type: 'test'
  ...
# Subtest: transparent pixels composite white; fit has margins; cover and tiles have none
ok 44 - transparent pixels composite white; fit has margins; cover and tiles have none
  ---
  duration_ms: 74.969697
  type: 'test'
  ...
# Subtest: rotation and position map source axes without mirroring
ok 45 - rotation and position map source axes without mirroring
  ---
  duration_ms: 26.023103
  type: 'test'
  ...
# Subtest: invalid sizes and unknown algorithms fail explicitly
ok 46 - invalid sizes and unknown algorithms fail explicitly
  ---
  duration_ms: 1.367703
  type: 'test'
  ...
# Subtest: editor surface: approved PNG→native pixels→download, menus, keyboard, pointer, filters and local file
ok 47 - editor surface: approved PNG→native pixels→download, menus, keyboard, pointer, filters and local file
  ---
  duration_ms: 1095.355643
  type: 'test'
  ...
1..47
# tests 47
# suites 0
# pass 47
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6654.429713
C++: shared vectors, protocol bounds/CRC/duplicates/recovery, v1/v2 reset/DFU actions and status PASS
C++ boot state: record validation, first/repeat boot, changed build, corruption/read failure, reset-state and persistence retry PASS
npm notice
npm notice New major version of npm available! 11.19.0 -> 12.2.3
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.3
npm notice To update run: npm install -g npm@12.2.3
npm notice

EXIT_CODE=0
```

</details>

<details>
<summary>install-yaml</summary>

```text
$ pip install pyyaml
Collecting pyyaml
  Downloading pyyaml-6.0.4-cp311-cp311-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl.metadata (2.3 kB)
Downloading pyyaml-6.0.4-cp311-cp311-manylinux2014_x86_64.manylinux_2_17_x86_64.manylinux_2_28_x86_64.whl (828 kB)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 828.0/828.0 kB 3.4 MB/s  0:00:00
Installing collected packages: pyyaml
Successfully installed pyyaml-6.0.4

EXIT_CODE=0
```

</details>

<details>
<summary>yaml</summary>

```text
$ python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/firmware.yml'))"

EXIT_CODE=0
```

</details>

<details>
<summary>dfu-clean-home</summary>

```text
$ python3 tools/dfu_package.py artifacts/eink-ble-welcome-once-dfu-bw-s140v6.hex --application-version 1 --output /tmp/eink-ci-clean-home/firmware-dfu.zip --result /tmp/eink-ci-clean-home/firmware-dfu.json
Zip created at /tmp/eink-ci-clean-home/firmware-dfu.zip
{
  "package": "/tmp/eink-ci-clean-home/firmware-dfu.zip",
  "sha256": "96c384745ca9e9a5ac75b52de1c7fb8a8fea6beb8f4e34ede853dad8f84fbcd3",
  "application_version": 1,
  "dfu_version": 0.5,
  "device_type": "0x52",
  "sd_req": [
    "0xb6"
  ],
  "hex_bounds": {
    "min": "0x26000",
    "max_exclusive": "0x49d18"
  },
  "application_bin_bytes": 146712,
  "firmware_sha256": "0248a0f0cfbd334961581226a0343b7aebacd0405bfdc171452a9f42b08f1563",
  "signature": "none: DFU 0.5 legacy init packet (CRC16 metadata only)",
  "files": {
    "manifest.json": {
      "bytes": 510,
      "sha256": "3f63130588dbe4a6ed1400e628e6e7f723c0b32721bf93d64d3f65355b53b675"
    },
    "eink-ble-welcome-once-dfu-bw-s140v6.bin": {
      "bytes": 146712,
      "sha256": "0248a0f0cfbd334961581226a0343b7aebacd0405bfdc171452a9f42b08f1563"
    },
    "eink-ble-welcome-once-dfu-bw-s140v6.dat": {
      "bytes": 14,
      "sha256": "da32dd13cc52a412eb4a1abd7c5f4a94aa246e0488a22dfe8f05bdfc4cc05b33"
    }
  },
  "zip_bytes": 147668
}

EXIT_CODE=0
```

</details>

<details>
<summary>package-env</summary>

```text
$ PYTHONPATH=tools python3 tools/package_firmware.py
{"linked_actions": {"reset_status": "01000001000000000000a00f0000000000000000", "enter_dfu_status": "01000002000000000000a00f0000000000000000", "dfu_while_receiving_status": "010102001f0000000000a00fbe938b3a00000000", "action_armed_before_svc": false}}
{"linked_deferred_action": {"successful_att_authorization_arms": true, "failed_att_authorization_clears": [2, 2, 0, 0], "failed_status_publication_att_error": 270, "failed_status_publication_clears": [2, 2, 0, 0]}}
{"linked_v2": [{"write_ceiling": 20, "codec": 0, "wire_bytes": 4000, "status": "0202000009000000a00fa00fbe938b3a00000000"}, {"write_ceiling": 125, "codec": 0, "wire_bytes": 4000, "status": "0202000009000000a00fa00fbe938b3a00000000"}, {"write_ceiling": 244, "codec": 0, "wire_bytes": 4000, "status": "0202000009000000a00fa00fbe938b3a00000000"}, {"write_ceiling": 20, "codec": 1, "wire_bytes": 64, "status": "020200010900000040004000be938b3a00000000"}, {"write_ceiling": 125, "codec": 1, "wire_bytes": 64, "status": "020200010900000040004000be938b3a00000000"}, {"write_ceiling": 244, "codec": 1, "wire_bytes": 64, "status": "020200010900000040004000be938b3a00000000"}]}
{
  "elf": "/tmp/eink-ci-clean-home/nested/artifacts/eink-ble-welcome-once-dfu-bw-s140v6.elf",
  "START_authorize_SVC": {
    "svc": 176,
    "type": 2,
    "status": 0,
    "update": 1,
    "offset": 0,
    "length": 11,
    "data": "0107000000a00ffda24d01"
  },
  "DATA_packets": 308,
  "frame_bytes": 4000,
  "final_status": "0102000007000000a00fa00ffda24d0100000000",
  "CRC32": "0x14da2fd",
  "scope": "Linked callback/receiver to SVC boundary with injected authorization outcomes; no SoftDevice, RF or hardware execution"
}
ARM callback contract + full MTU23 frame + action success/failure sequencing PASS
{
  "guard_opcodes": [
    4,
    5,
    6
  ],
  "capabilities": [
    {
      "present": true,
      "connected": true,
      "mtu_input": 23,
      "safeWrite": 20
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 128,
      "safeWrite": 125
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 247,
      "safeWrite": 244
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 517,
      "safeWrite": 244
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 0,
      "safeWrite": 20
    },
    {
      "present": false,
      "connected": false,
      "mtu_input": 247,
      "safeWrite": 20
    },
    {
      "present": true,
      "connected": false,
      "mtu_input": 247,
      "safeWrite": 20
    },
    {
      "present": true,
      "connected": true,
      "mtu_input": 23,
      "safeWrite": 20
    }
  ],
  "scope": "Linked ARM core guard/callback to SVC; no SoftDevice, RF, allocation or display simulation"
}
{
  "origin": "0x26000",
  "limit_exclusive": "0xec000",
  "family": "0xada52840",
  "binary_bytes": 146712,
  "image_end_exclusive": "0x49d18",
  "layout_margin_bytes": 664296,
  "embedded_build_id": "0x6298e50e",
  "state_sector": {
    "address": "0xec000",
    "size_bytes": 4096,
    "excluded_from_application": true
  },
  "uf2_bytes": 293888,
  "blocks": 574,
  "initial_sp": "0x20040000",
  "reset_vector": "0x36549",
  "arm_smoke": [
    {
      "initial_out": 0,
      "initial_cnf": 0,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    },
    {
      "initial_out": 8192,
      "initial_cnf": 0,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    },
    {
      "initial_out": 8192,
      "initial_cnf": 3,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    },
    {
      "initial_out": 0,
      "initial_cnf": 3,
      "vcc_writes": [
        [
          "0x50000508",
          "0x2000"
        ],
        [
          "0x50000734",
          "0x3"
        ],
        [
          "0x5000050c",
          "0x8000"
        ],
        [
          "0x5000050c",
          "0x200"
        ]
      ],
      "SPIM3_sck_mosi_miso": [
        38,
        9,
        22
      ]
    }
  ],
  "linked_action_smoke": [
    {
      "linked_actions": {
        "reset_status": "01000001000000000000a00f0000000000000000",
        "enter_dfu_status": "01000002000000000000a00f0000000000000000",
        "dfu_while_receiving_status": "010102001f0000000000a00fbe938b3a00000000",
        "action_armed_before_svc": false
      }
    },
    {
      "linked_deferred_action": {
        "successful_att_authorization_arms": true,
        "failed_att_authorization_clears": [
          2,
          2,
          0,
          0
        ],
        "failed_status_publication_att_error": 270,
        "failed_status_publication_clears": [
          2,
          2,
          0,
          0
        ]
      }
    }
  ],
  "welcome": {
    "source": "assets/approved-welcome.png",
    "source_size": [
      122,
      250
    ],
    "preview": "assets/approved-welcome-preview.png",
    "preview_size": [
      610,
      1250
    ],
    "preview_scale": 5,
    "source_pixels_compared": 30500,
    "preview_pixels_compared": 762500,
    "elf_symbol": "eink_welcome_bitmap",
    "frame_bytes": 4000,
    "frame_sha256": "dc6e05e5f09d7df9b32d3952472577744d534723f11f60ed1204370180169733",
    "layout": "MSB-first, black=1, stride=16, zero padding",
    "match": true
  },
  "authorize_contract": "PASS: linked ARM v1/v2 callback/receiver and core PREP/EXEC/capabilities to SVC boundary; injected SVC returns verify deferred action success/failure",
  "scope": "Linked ARM protocol/authorization with injected SVC outcomes, plus GPIO/SPI memory-backed MMIO; not hardware, RF, display timing or electrical verification.",
  "sha256": {
    "eink-ble-welcome-once-dfu-bw-s140v6.elf": "c4c7f2f4c60463c239a8529311ec4d035a75a043d14ac71e0378804645ca0a15",
    "eink-ble-welcome-once-dfu-bw-s140v6.hex": "21a36060819428e1890643bad08fba6ab8a80e51bf85534f19d709e37e55e3ec",
    "eink-ble-welcome-once-dfu-bw-s140v6.bin": "0248a0f0cfbd334961581226a0343b7aebacd0405bfdc171452a9f42b08f1563",
    "eink-ble-welcome-once-dfu-bw-s140v6.uf2": "8d07d99121ea77d76f9c41c4c43be0f451cd64f008f9505e58a5e53a3d129373",
    "eink-ble-welcome-once-dfu-bw-s140v6.zip": "3ee8361691f8ae494120671d77ec47dbf70d88992fc222b1552524b30f2ea16e"
  }
}

EXIT_CODE=0
```

</details>

<details>
<summary>artifact-smoke</summary>

```text
$ python3 -c 'import binascii, hashlib, json, struct, zipfile
from pathlib import Path
out=Path('"'"'artifacts'"'"'); prefix=out/'"'"'eink-ble-welcome-once-dfu-bw-s140v6'"'"'
uf2=prefix.with_suffix('"'"'.uf2'"'"').read_bytes()
assert len(uf2)%512==0
addresses=[]
for i in range(len(uf2)//512):
    block=uf2[i*512:(i+1)*512]
    a,b,flags,address,size,index,count,family=struct.unpack_from('"'"'<8I'"'"',block)
    assert (a,b,flags,size,index,count,family)==(0x0A324655,0x9E5D5157,0x2000,256,i,len(uf2)//512,0xADA52840)
    assert struct.unpack_from('"'"'<I'"'"',block,508)[0]==0x0AB16F30
    assert address==0x26000+i*256 and address+size<=0xEC000
    addresses.append(address)
with zipfile.ZipFile(prefix.with_suffix('"'"'.dfu.zip'"'"')) as z:
    assert z.testzip() is None
    manifest=json.loads(z.read('"'"'manifest.json'"'"'))['"'"'manifest'"'"']
    app=manifest['"'"'application'"'"']; names=z.namelist()
    assert len(names)==3 and set(names)=={'"'"'manifest.json'"'"',app['"'"'bin_file'"'"'],app['"'"'dat_file'"'"']}
    binary=z.read(app['"'"'bin_file'"'"']); dat=z.read(app['"'"'dat_file'"'"'])
    device,revision,version,n,sd,crc=struct.unpack('"'"'<HHIHHH'"'"',dat)
    calculated=binascii.crc_hqx(binary,0xffff)
    assert (device,revision,version,n,sd)==(0x52,0xffff,1,1,0xB6)
    assert crc==calculated==app['"'"'init_packet_data'"'"']['"'"'firmware_crc16'"'"']
    assert app['"'"'init_packet_data'"'"']['"'"'softdevice_req'"'"']==[0xB6]
    assert app['"'"'init_packet_data'"'"']['"'"'device_type'"'"']==0x52
    assert binary==prefix.with_suffix('"'"'.bin'"'"').read_bytes()
assert prefix.with_suffix('"'"'.dfu.zip'"'"').read_bytes()==(out/(prefix.name+'"'"'-dfu.zip'"'"')).read_bytes()
for report in ['"'"'verification-welcome-once-dfu.json'"'"',prefix.name+'"'"'-dfu.json'"'"']:
    data=json.loads((out/report).read_text())
    if '"'"'sha256'"'"' in data and isinstance(data['"'"'sha256'"'"'],dict):
        for name,digest in data['"'"'sha256'"'"'].items():
            assert hashlib.sha256((out/name).read_bytes()).hexdigest()==digest
print(json.dumps({'"'"'uf2_family'"'"':hex(family),'"'"'start'"'"':hex(min(addresses)),'"'"'uf2_end_exclusive'"'"':hex(addresses[-1]+256),'"'"'image_end_exclusive'"'"':hex(0x26000+len(binary)),'"'"'dfu_members'"'"':names,'"'"'softdevice_req'"'"':[hex(sd)],'"'"'device_type'"'"':hex(device),'"'"'crc16_init'"'"':hex(crc),'"'"'crc16_independent'"'"':hex(calculated),'"'"'ota_alias_identical'"'"':True,'"'"'verification_digests_match'"'"':True},indent=2))
'
{
  "uf2_family": "0xada52840",
  "start": "0x26000",
  "uf2_end_exclusive": "0x49e00",
  "image_end_exclusive": "0x49d18",
  "dfu_members": [
    "manifest.json",
    "eink-ble-welcome-once-dfu-bw-s140v6.bin",
    "eink-ble-welcome-once-dfu-bw-s140v6.dat"
  ],
  "softdevice_req": [
    "0xb6"
  ],
  "device_type": "0x52",
  "crc16_init": "0xfd97",
  "crc16_independent": "0xfd97",
  "ota_alias_identical": true,
  "verification_digests_match": true
}

EXIT_CODE=0
```

</details>

<details>
<summary>workflow-smoke</summary>

```text
$ python3 -c 'import yaml
from pathlib import Path
w=yaml.safe_load(Path('"'"'.github/workflows/firmware.yml'"'"').read_text())
assert w['"'"'on'"'"']['"'"'push'"'"']['"'"'tags'"'"']==['"'"'v*'"'"']
assert w['"'"'on'"'"']['"'"'workflow_dispatch'"'"']['"'"'inputs'"'"']['"'"'version'"'"']['"'"'default'"'"']=='"'"'1'"'"'
assert set(['"'"'firmware/**'"'"','"'"'tools/**'"'"','"'"'tests/**'"'"']) <= set(w['"'"'on'"'"']['"'"'pull_request'"'"']['"'"'paths'"'"'])
job=w['"'"'jobs'"'"']['"'"'firmware'"'"']; assert job['"'"'env'"'"']['"'"'NRFUTIL'"'"']=='"'"'adafruit-nrfutil'"'"'
steps=job['"'"'steps'"'"']; upload=next(s for s in steps if s.get('"'"'uses'"'"','"'"''"'"').startswith('"'"'actions/upload-artifact@'"'"'))
assert upload['"'"'if'"'"']=='"'"'always()'"'"'
release=next(s for s in steps if s.get('"'"'uses'"'"','"'"''"'"').startswith('"'"'softprops/action-gh-release@'"'"'))
assert "github.event_name == '"'"'push'"'"'" in release['"'"'if'"'"'] and "refs/tags/v" in release['"'"'if'"'"']
assert release['"'"'with'"'"']['"'"'tag_name'"'"']=='"'"'${{ github.ref_name }}'"'"'
assert release['"'"'with'"'"']['"'"'generate_release_notes'"'"'] is True and release['"'"'with'"'"']['"'"'draft'"'"'] is False
for pattern in release['"'"'with'"'"']['"'"'files'"'"'].splitlines():
    assert list(Path('"'"'.'"'"').glob(pattern)),pattern
print('"'"'YAML parsed; triggers, dispatch version, CLI, always-upload, tag-only release and all asset globs PASS'"'"')
'
YAML parsed; triggers, dispatch version, CLI, always-upload, tag-only release and all asset globs PASS

EXIT_CODE=0
```

</details>

