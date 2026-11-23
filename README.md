# OpenClaw в Telegram

Личный текстовый бот и Mini App для одного владельца. Cloudflare принимает Telegram webhook, хранит очередь и настройки и раздаёт панель. OpenClaw работает на Linux или в тестовом Codespace. Хост подключается к Worker исходящими HTTPS-запросами. Шлюз OpenClaw слушает только `127.0.0.1`.

**Хост для повседневной работы** — собственный Linux-компьютер, домашний сервер или VPS, правила которого разрешают запуск бота. Если компьютер уже есть, отдельный тариф хостинга не нужен. Пока компьютер включён, Mini App и новые сообщения автоматически поднимают OpenClaw. На спящем агенте остаётся только лёгкий процесс Worker-клиента с опросом раз в 10 секунд.

**GitHub Codespaces — для разработки и тестов этого репозитория.** GitHub запрещает production-facing хостинг, использование Codespaces как части serverless-приложения и задачи вне разработки или тестирования связанного проекта. Автопробуждение через GitHub API в этом проекте предназначено для проверки бота. [Условия GitHub Codespaces](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-codespaces)

## 1. Подготовьте Telegram и Cloudflare

1. Создайте бота через [@BotFather](https://t.me/BotFather), откройте его личный чат и нажмите «Старт». Узнайте свой числовой Telegram user ID. Для нового бота до настройки webhook можно выполнить `getUpdates` и взять `message.from.id` из своего сообщения.
2. Установите Node.js **24.16+** в ветке 24 или **26.1+**. В корне проекта выполните:

   ```bash
   npm ci
   cp wrangler.example.jsonc wrangler.jsonc
   npx wrangler login
   npx wrangler d1 create openclaw-telegram
   ```

3. Вставьте выданный UUID в `d1_databases[0].database_id`. В `vars` задайте `OWNER_ID` строкой и `MODELS_JSON` массивом идентификаторов вашего API, записанным как JSON-строка. Список и порядок должны совпадать со списком на хосте. Первая модель используется по умолчанию. Выберите `BACKEND: "standalone"` для обычной работы либо внесите параметры Codespace из раздела 3.
4. Примените миграцию и разверните Worker:

   ```bash
   npx wrangler d1 migrations apply openclaw-telegram --remote
   npm run deploy
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   npx wrangler secret put RUNNER_SECRET
   ```

   Для webhook и runner используйте два разных случайных секрета. Каждый можно создать командой `openssl rand -hex 32`. Сохраните HTTPS-адрес Worker из вывода Wrangler. Для Telegram и Mini App отдельный домен не нужен.
5. Скопируйте `telegram.env.example` в `telegram.local.env`. Заполните адрес Worker, `OWNER_ID`, токен бота и тот же `TELEGRAM_WEBHOOK_SECRET`. Защитите этот временный файл правами `chmod 600 telegram.local.env`. Затем выполните:

   ```bash
   node --env-file=telegram.local.env scripts/configure-telegram.js
   ```

   Скрипт устанавливает webhook и кнопку «Пульт OpenClaw» в чате владельца. Сохраните секреты в менеджере паролей и удалите временный файл после настройки. В Cloudflare остаются зашифрованные Secrets. Авторизацию панели даёт подписанный Telegram `initData` с проверкой владельца и срока в один час. Когда срок истечёт, откройте панель заново. [Bot API](https://core.telegram.org/bots/api#setwebhook), [проверка Mini App initData](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)

## 2. Разместите OpenClaw на собственном Linux

1. Скопируйте проект на постоянно включённый Linux-хост с `node`, `npm`, `flock` и `ps` (в Debian/Ubuntu это пакеты `util-linux` и `procps`).
2. Выполните `cp runner.env.example .env` и `chmod 600 .env`. Впишите адрес Worker, тот же `RUNNER_SECRET`, независимый случайный `OPENCLAW_GATEWAY_TOKEN`, URL и ключ провайдера, строку `MODELS_JSON`. URL обычно заканчивается на `/v1`. Провайдер должен поддерживать потоковый `POST /chat/completions`. Для вызова инструментов нужна модель с OpenAI-совместимым function calling.
3. Для первого запуска выполните `./scripts/install`, затем `./scripts/run`. Для постоянной работы завершите ручной процесс через Ctrl+C и установите пользовательскую службу:

   ```bash
   sudo loginctl enable-linger "$USER"
   ./scripts/install-service
   journalctl --user -u openclaw-telegram.service -f
   ```

4. Отправьте текст боту. Панель покажет запуск, затем готовность. Кнопка «Выключить» дождётся текущего запроса и остановит шлюз. Следующее сообщение снова его запустит. На выключенном Linux-компьютере сообщения останутся в очереди до следующего запуска хоста.

## 3. Проверьте GitHub Codespaces

1. Загрузите код в GitHub-репозиторий. В настройках Codespaces Secrets выдайте этому репозиторию ровно переменные из `runner.env.example`. На GitHub вводите `MODELS_JSON` без внешних одинарных кавычек. Токен GitHub и токен бота нужны только Worker. [Codespaces Secrets](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces)
2. Создайте **один** Codespace на машине 2 cores / 8 ГБ и дождитесь окончания `postCreateCommand`. Узнайте имя из `$CODESPACE_NAME` или `gh codespace list`. `.devcontainer/devcontainer.json` устанавливает Node и OpenClaw и вызывает `postStartCommand` при запуске контейнера. Журнал супервизора доступен в `.claw-state/runner.log`. При установке пакета зависимостей первый запуск займёт дольше. Для диагностики хука из терминала выполните `./scripts/codespace-start`.
3. В конфигурации Worker задайте `BACKEND: "codespaces"` и `CODESPACE_NAME`. Разверните Worker заново и добавьте секрет:

   ```bash
   npm run deploy
   npx wrangler secret put GH_CODESPACES_TOKEN
   ```

   Fine-grained PAT для выбранного репозитория требует **Codespaces: Read** для чтения состояния и **Codespaces lifecycle admin: Read and write** для запуска и остановки. Classic PAT использует scope `codespace`. Вызовы идут в `GET /user/codespaces/{name}` и `POST /user/codespaces/{name}/{start|stop}`. [GitHub REST API](https://docs.github.com/en/rest/codespaces/codespaces)
4. Остановите Codespace в GitHub, закройте вкладку IDE и отправьте два разных сообщения боту. Проверьте один запуск и оба ответа. Это проверяет, что ваш Codespace исполняет `postStartCommand` при запуске через API без подключения IDE. После ответа нажмите «Выключить» и дождитесь состояния `Shutdown` на GitHub. Следующим сообщением проверьте повторный запуск. Настройте штатный idle timeout GitHub выше обычной длительности тестового запуска и ответа. GitHub может независимо остановить среду по своим лимитам. [Жизненный цикл Codespaces](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle)
5. Для повседневной эксплуатации переключитесь на отдельное развёртывание с `BACKEND: "standalone"`. Один Telegram-бот может иметь только один webhook, поэтому для параллельного тестирования используйте отдельный тестовый бот и Worker/D1.

### Вместо API-ключа: вход через ChatGPT (Codex)

При первоначальной настройке задайте на хосте `MODEL_PROVIDER=codex` и укажите в `MODELS_JSON` идентификаторы из каталога Codex без префикса `openai/`, например `["gpt-5.6-luna"]`. Список в Worker должен совпадать. `MODEL_BASE_URL` и `MODEL_API_KEY` в этом режиме не нужны. После установки OpenClaw выполните на хосте:

```bash
./scripts/claw models auth login --provider openai
./scripts/claw models status --check
```

Подтвердите вход в своём аккаунте ChatGPT по инструкции CLI. Вход сохраняется в каталоге состояния OpenClaw; не копируйте его данные в Worker или GitHub Secrets. Если `openclaw.json` уже создан для другого провайдера, смена переменной не перезапишет файл: обновите настройки моделей существующего экземпляра или используйте отдельный каталог состояния. [Настройка Codex в OpenClaw](https://docs.openclaw.ai/providers/openai/setup#codex-subscription)

### Статистика Codespaces в Mini App

Добавьте в конфигурацию `GH_LOGIN`, при необходимости измените `GH_MONTHLY_CORE_HOURS` и сохраните отдельный fine-grained PAT с **Plan: Read** через `npx wrangler secret put GH_BILLING_TOKEN`. Панель берёт данные по аккаунту за текущий календарный месяц UTC через `GET /users/{username}/settings/billing/usage/summary` и кеширует успешный ответ до пяти минут на экземпляре Worker. Сумма берётся по compute SKU; отчёт может запаздывать. Если доступ к отчёту отсутствует, панель показывает «Нет данных». Для точного остатка по расчётному периоду и хранения используйте GitHub Billing. [API биллинга](https://docs.github.com/en/rest/billing/usage#get-billing-usage-summary-for-a-user), [список SKU](https://docs.github.com/en/billing/reference/product-and-sku-names#github-codespaces-skus)

## CLI, Skills и память

```bash
./scripts/claw --help
./scripts/claw config validate
./scripts/claw skills list
./scripts/claw models list
./scripts/claw gateway status
```

Обёртка передаёт аргументы штатному CLI и удерживает блокировку на время выполнения. Для команд, которым нужен шлюз, сначала запустите агент из панели. Шлюз обслуживает супервизор, поэтому отдельный `gateway install` для рабочего экземпляра не требуется. Настройки OpenClaw, транскрипты, workspace и Skills хранятся в `.claw-state/`. В Codespaces каталог находится внутри `/workspaces`, переживает stop/start и сохраняется при rebuild того же Codespace. Удаление Codespace удаляет его диск. Для переноса сохраните резервную копию каталога после остановки агента. Файлы Skills проекта можно размещать в `.claw-state/workspace/skills/`.

Изменение модели в панели действует со следующего Telegram-запроса. Список моделей и базовый URL записываются при первой настройке. При смене списка или URL обновите настройки провайдера `privateapi` и разрешённые модели в `.claw-state/openclaw.json` через CLI или редактор, затем согласуйте значения `MODELS_JSON` на хосте и в Worker. Конфигурация содержит ссылки на переменные окружения. Модельный токен можно менять через Secrets без записи в JSON. Для векторного поиска по памяти отдельно настройте модель эмбеддингов вашего провайдера. [Провайдеры OpenClaw](https://docs.openclaw.ai/gateway/config-agents/models), [память OpenClaw](https://docs.openclaw.ai/concepts/memory)

## Как обрабатываются сообщения

- Worker подтверждает текстовый webhook после записи в D1. Повторные доставки дедуплицируются по `update_id`. Cloudflare Durable Object упорядочивает запуск, выдачу заданий и выключение.
- Адаптер использует `sendMessageDraft(can_stop=true)`. Событие `stopped_message_generation` отменяет соединение OpenResponses. OpenClaw завершает активную генерацию по сигналу отключения. `/stop` действует на текущий Telegram-запрос и доступен как резервный вариант. Уже выполненные внешние действия инструмента сохраняют эффект. Встроенный Telegram-канал OpenClaw в этой конфигурации выключен. [Telegram Bot API](https://core.telegram.org/bots/api#sendmessagedraft), [OpenResponses Gateway API](https://docs.openclaw.ai/gateway/openresponses-http-api#streaming)
- По умолчанию сон наступает не раньше пяти минут после последнего входящего запроса. Сначала должны освободиться очередь, рабочий lease, команды CLI, сессии и запущенные шлюзом процессы. Во время ручного выключения новые запросы сохраняются. Если сообщение пришло после запроса выключения, агент проснётся после завершения остановки.
- Готовый результат хранится в D1 до отправки в Telegram. После доставки D1 сохраняет идентификатор для дедупликации, а содержимое диалога остаётся в OpenClaw. Если хост аварийно завершился во время уже начатого задания, бот отмечает прерывание и просит повторить запрос, чтобы не выполнить инструменты дважды. Если Telegram принял ответ, а передача подтверждения оборвалась, возможен дубликат фрагмента. Telegram Bot API не предоставляет ключ идемпотентности для `sendMessage`.
- Адаптер поддерживает текст в личном чате владельца. Telegram-черновик показывает первые 3900 символов, а длинный итог отправляется несколькими сообщениями. Для инструментов, которые намеренно запускают процессы вне дерева шлюза или на внешней машине, состояние такого процесса должен отслеживать сам инструмент.

## Бесплатные лимиты

| Сервис | Лимит |
| --- | --- |
| GitHub Free, личный аккаунт | 120 ядро-часов в месяц, примерно 60 часов работы 2-ядерной машины, и 15 ГБ хранения в месяц |
| Cloudflare Workers Free | 100 000 запросов в день, CPU 10 мс на HTTP-запрос |
| Cloudflare D1 Free | 5 млн строк чтения и 100 000 строк записи в день, 5 ГБ суммарного хранения, до 500 МБ на базу |
| Cloudflare SQLite Durable Objects Free | 100 000 запросов и 13 000 ГБ·с в день |

Хранение Codespace расходует квоту, пока Codespace существует. Если подключён платёжный метод, настройте бюджет Codespaces с остановкой расхода при достижении предела. Расход API модели зависит от тарифа вашего провайдера. [GitHub Free](https://docs.github.com/en/billing/reference/product-usage-included), [Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [лимиты D1](https://developers.cloudflare.com/d1/platform/limits/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Проверка

```bash
npm test
npx wrangler d1 migrations apply openclaw-telegram --local
npx wrangler deploy --dry-run
```

Для проверки на своих аккаунтах пройдите полный цикл из раздела 3 или запустите сервис из раздела 2. Попросите бота дать длинный ответ и нажмите нативную кнопку «Стоп» во время текста. Затем проверьте, что другой запрос продолжает диалог, выбранная в Mini App модель применяется, а короткий таймер усыпляет хост после окончания очереди.
