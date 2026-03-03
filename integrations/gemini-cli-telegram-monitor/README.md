# Gemini CLI Telegram Monitor

отдельный сервис для Docker, который:

- каждые 10 минут проверяет все Gemini fixed IP;
- публикует и редактирует один пост в Telegram-канале;
- меняет картинку сверху поста по общему статусу;
- повторно закрепляет сообщение после обновления;
- пишет компактный audit-log по каждому IP в файл.

## что проверяется

для каждого IP сервис отправляет короткий `generateContent` запрос в `cloudcode-pa.googleapis.com`.

правила классификации:

- `2xx` и есть ответ модели: `работает`
- `429 You have exhausted your capacity...`: `работает`
- `429 No capacity available for model...`: `не работает`
- всё остальное: `неизвестно`

общий статус:

- `работает`, если рабочих IP не меньше `75%`
- `не работает`, если большинство IP в статусе `не работает`
- `есть проблемы`, если большинство IP в статусе `неизвестно`
- в остальных смешанных случаях тоже `есть проблемы`

## куда класть изображения

PNG нужно положить сюда:

`docker/gemini-cli-telegram-monitor/assets/`

имена файлов должны быть ровно такие:

- `noproblems.png` -> общий статус `работает`
- `problems.png` -> общий статус `не работает`
- `somethingwrong.png` -> общий статус `есть проблемы`

также добавлю отдельно в `/static/tg-monitor-assets`, мб пригодится кому

## конфиг

основной env-файл:

`docker/gemini-cli-telegram-monitor/.env`

пример:

`docker/gemini-cli-telegram-monitor/.env.example`

сервис умеет автоматически подтягивать:

- `PROJECT_ID`
- `GEMINI_OAUTH_CREDS_FILE_PATH`
- `GEMINI_FIXED_IPS`

из:

- `/configs/provider_pools.json`
- `/configs/config.json`

то есть при типичной Docker-схеме вам часто достаточно заполнить только Telegram-переменные.

если OAuth-файл лежит вне `docker/configs`, просто добавьте отдельный bind mount в compose и укажите контейнерный путь в `GEMINI_OAUTH_CREDS_FILE_PATH`.

## Логи по IP

по умолчанию сервис пишет файл:

`/data/ip-status.log`

на хосте это будет:

`docker/gemini-cli-telegram-monitor/state/ip-status.log`

формат строки:

```text
2026-03-03T21:52:25.380Z | 108.177.14.95 | working | answered | http=200
2026-03-03T21:52:25.380Z | 173.194.220.95 | down | 429-no-capacity | http=429 | No capacity available for model...
```

путь можно поменять через `MONITOR_AUDIT_LOG_FILE`.

## запуск

отдельный compose-файл:

`docker/docker-compose.telegram-monitor.yml`

команда:

```bash
docker compose -f docker/docker-compose.telegram-monitor.yml up -d --build
```

## права Telegram-бота

бот должен быть админом канала и уметь:

- публиковать посты;
- редактировать свои посты;
- закреплять сообщения.