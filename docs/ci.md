# CI и выпуск прошивки

Workflow **Firmware** проверяет pull request без создания релиза. Push в ветку `main` запускает сборку и загрузку артефактов, но никогда не публикует GitHub Release; push тега `v*` запускает ту же сборку и дополнительно публикует Release. Ручной запуск через **Actions → Firmware → Run workflow** позволяет задать параметр `version` — числовую версию приложения для DFU, по умолчанию `1`. Это версия приложения в init packet, а не обязательно номер тега. Для выпуска, например, тега `v3` выполните из нужного коммита:

```sh
git tag v3
git push origin v3
```

Эти команды только документируют порядок выпуска: до публикации проверьте выбранный коммит и результат workflow. Запуск CI сам по себе не гарантирует совместимость с конкретным устройством.

## Артефакты

В каталоге `artifacts` по умолчанию формируются:

- `eink-ble-welcome-once-dfu-bw-s140v6.uf2` — application-only UF2;
- `eink-ble-welcome-once-dfu-bw-s140v6.zip` — ZIP с UF2;
- `eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip` — пакет legacy Nordic DFU;
- `eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip` — побайтово идентичная копия предыдущего DFU-пакета для OTA-потребителя.
- `verification-welcome-once-dfu.json` — ELF/UF2, bitmap и linked ARM smoke-проверки;
- `eink-ble-welcome-once-dfu-bw-s140v6-dfu.json` — границы HEX, метаданные и хеши проверенного DFU.

CI загружает каталог `artifacts/` через `upload-artifact` с `if: always()` (если файлы успели появиться) при push в `main`, push тега `v*` и ручном запуске. Только успешный push тега `v*` создаёт Release с этими ассетами и автоматически сгенерированными release notes; push в `main` и ручной запуск загружают те же артефакты, но релиз не публикуют. PR-проверки запускаются для `firmware/**`, `tools/**`, `tests/**`, исходных PNG, npm-конфигурации и самого workflow.

Суффикс `-dfu.zip` важен: `web/ota.js` в `selectDfuAsset` выбирает первый asset релиза с этим окончанием, поэтому Release должен содержать `eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip`. Наличие совместимого загрузчика на стороне сайта и поведение реального устройства необходимо проверять отдельно.

## Локальная сборка и упаковка

Нужны Python 3.11, Node.js 22+, npm, компилятор C++ и доступ к зависимостям PlatformIO. Из корня репозитория:

```sh
python3 -m pip install platformio pyelftools unicorn adafruit-nrfutil
npm ci
npm test
npm run build:firmware
npm run package:firmware
NRFUTIL=adafruit-nrfutil npm run package:dfu
cp artifacts/eink-ble-welcome-once-dfu-bw-s140v6.dfu.zip \
   artifacts/eink-ble-welcome-once-dfu-bw-s140v6-dfu.zip
```

`npm test` запускает JS- и host C++-проверки; сборка и упаковка не прошивают устройство. Команда `package:dfu` задаёт версию приложения `1`. Для другой версии вызывайте упаковщик напрямую, указав `--application-version` и пути к HEX, выходному ZIP и JSON-отчёту через `--output` и `--result` соответственно.

Переменная `ARTIFACTS_DIR` меняет каталог результатов `package_firmware.py`; по умолчанию используется `artifacts` в корне репозитория, относительный путь отсчитывается от текущего рабочего каталога. При использовании другого каталога укажите соответствующие пути DFU-упаковщику (включая `--result`) и команде копирования, а не пути `artifacts` из примера.

Для запуска legacy `nrfutil` приоритет такой: переменная `NRFUTIL`, затем исполняемый `nrfutil` из `PATH`, затем `~/.local/bin/nrfutil`. Опциональный каталог Python-модулей `~/.platformio/packages/tool-adafruit-nrfutil/site-packages` (`NRF_SITE`) добавляется в поиск, только если существует; иначе используется установленный Python-модуль `nordicsemi`. Требуется совместимый `adafruit-nrfutil` с командой `dfu genpkg`, а не произвольная новая версия Nordic nrfutil.

Пакет pip `adafruit-nrfutil` устанавливает CLI с именем `adafruit-nrfutil`, а не `nrfutil`. Поэтому workflow задаёт `NRFUTIL=adafruit-nrfutil`; локальный пример делает то же явно, не полагаясь на ранее установленный `~/.local/bin/nrfutil`.

## Границы и безопасность

Упаковка проверяет family ID UF2 `0xADA52840`, начало приложения `0x26000` и конец не выше `0xCC000` (исключительная граница; далее `0xCC000..0xEBFFF` зарезервировано под хранение страниц), а также содержимое и целостность архивов. DFU-пакет проверяется по manifest, init packet и CRC16. Это legacy DFU 0.5 без криптографической подписи; ключи подписи сейчас не используются. Для OTA необходим совместимый установленный bootloader: подписанный Secure DFU не является взаимозаменяемой заменой этого формата.

Пакет содержит только приложение: bootloader и SoftDevice не обновляются, зарезервированные под страницы сектора `0xCC000..0xEBFFF` и сектор состояния welcome `0xEC000..0xECFFF` не входят в образ приложения. При single-bank обновлении потеря питания может оставить неработающее приложение; заранее обеспечьте возможность восстановления через USB и совместимый загрузчик. Проверки сборки и эмуляции не заменяют проверку реального bootloader, радио, питания и дисплея и не гарантируют работу на аппаратуре.
