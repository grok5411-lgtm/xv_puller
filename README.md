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

Пример ответа `/pick`:

```json
{
  "tag": "daddy",
  "page": 37,
  "pages": 149,
  "pageUrl": "https://www.xv-ru.com/tags/daddy/36",
  "candidates": 30,
  "video": {
    "id": "kdmaadbb975",
    "url": "https://www.xv-ru.com/video.kdmaadbb975/_",
    "title": "...",
    "duration": "8 мин.",
    "quality": "1080p",
    "thumbnail": "https://..."
  }
}
```

## Деплой (GitHub → Cloudflare)

1. Cloudflare Dashboard → Workers & Pages → Create → Connect to Git.
2. Выбрать репозиторий `grok5411-lgtm/xv_puller`, ветку `main`.
3. Build command: пусто. Deploy command: `npx wrangler deploy`.
4. Каждый push в `main` = новый деплой.

Переменная `BASE_URL` задаётся в `wrangler.toml` (`[vars]`).

## Ограничение

Запросы идут с IP Cloudflare. Если xv-ru.com их блокирует (403/timeout) — воркер вернёт ошибку 502. Тогда нужен исходящий прокси (например, `fetch` через сторонний прокси-сервис) или self-host на своём сервере.
