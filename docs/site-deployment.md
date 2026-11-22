# Публикация сайта на GitHub Pages

Сайт — статический каталог `web/` без сборки и runtime-зависимостей. Workflow **Pages** (`.github/workflows/pages.yml`) публикует его на GitHub Pages через официальные Actions.

## Поведение

- Запуск: push в `main` при изменениях `web/**` или самого workflow, плюс ручной **Actions → Pages → Run workflow**.
- Права: `contents: read`, `pages: write`, `id-token: write`; одновременно выполняется одна публикация (`concurrency: pages`, без отмены текущей).
- Шаги: `actions/checkout`, `actions/configure-pages`, `actions/upload-pages-artifact` с `path: web`, `actions/deploy-pages`.
- Источник Pages — GitHub Actions (`build_type: workflow`), не ветка. Ветка/тег и Release не создаются.
- Production URL: <https://alephtheagent.github.io/eink-ble-studio/> (подкаталог; все ссылки сайта относительные).
- Каталог `web/` содержит `.nojekyll`; Jekyll для Actions-публикации не используется.

Workflow **Firmware** не зависит от Pages: push в `main` по-прежнему только собирает и загружает артефакты, Release создаётся только для тегов `v*`.

## Первичная настройка

Pages уже включён для репозитория с `build_type: workflow`. Для нового клона/репозитория включите источник Actions:

```sh
gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
```

или **Settings → Pages → Build and deployment → Source: GitHub Actions**. При первом деплое GitHub создаёт окружение `github-pages`; при необходимости разрешите ему деплой из `main` в **Settings → Environments**.

Проверка состояния и последнего деплоя:

```sh
gh api repos/OWNER/REPO/pages
gh api repos/OWNER/REPO/deployments?environment=github-pages
```

Пользовательский домен не настроен; HTTPS принудительный.

## Локальная проверка

```sh
npm run serve
# http://localhost:8080 — тот же каталог web/, что публикуется
```

Перед push проверьте, что `web/index.html` ссылается только на относительные пути, а файлы `web/**` (включая `vendor/`, `locales/`, `fonts.js`, `reference.png`) существуют. Web Bluetooth требует HTTPS или localhost; на Pages HTTPS есть, но реальное устройство и разрешения Bluetooth проверяются отдельно от деплоя.