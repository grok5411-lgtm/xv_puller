# xv_puller

Cloudflare Worker: случайный тег → случайная страница → случайное видео с `xv-ru.com`.

## Эндпоинты

| Путь | Что делает |
|---|---|
| `/tags` | JSON-список тегов со страницы `/tags` |
| `/tags?format=text` | теги по одному в строке |
| `/pick?tag=daddy` | случайная страница тега + случайное видео |
| `/pick?tag=daddy&page=5` | конкретная страница |
| `/random` | случайный тег + случайная страница + случайное видео |
| `/logs?limit=50` | последние записи лога (NDJSON) |

## Логи в GitHub

Каждый запрос `/pick` и `/random` (а также ошибки) дописывается в
`logs/requests.log` в ветке `logs` — отдельно от `main`, чтобы коммиты логов
не перезапускали деплой.

Формат — JSON Lines:

```json
{"ts":"2026-11-12T21:15:03.120Z","path":"/random","tag":"daddy","page":37,"pages":149,"video":"https://www.xv-ru.com/video.kdmaadbb975/_","title":"...","ms":842}
```

Хранится последние 300 строк.

Требуется секрет воркера:

```bash
npx wrangler secret put GITHUB_TOKEN
# вставить fine-grained PAT: Contents = Read and write
```

Или в дашборде: Worker → Settings → Variables and Secrets → Add → Secret `GITHUB_TOKEN`.

## Переменные

`wrangler.toml` → `[vars]`:

- `BASE_URL` — сайт, по умолчанию `https://www.xv-ru.com`
- `GITHUB_REPO` — куда писать логи
- `GITHUB_BRANCH` — ветка логов (`logs`)
- `GITHUB_LOG_PATH` — путь к файлу (`logs/requests.log`)

## Деплой (GitHub → Cloudflare)

1. Cloudflare Dashboard → Workers & Pages → Create → Connect to Git.
2. Репозиторий `grok5411-lgtm/xv_puller`, ветка `main`.
3. Build command: пусто. Deploy command: `npx wrangler deploy`.
4. Каждый push в `main` = новый деплой.

## Ограничение

Запросы идут с IP Cloudflare. Если xv-ru.com их блокирует (403/timeout) — воркер вернёт ошибку 502.
