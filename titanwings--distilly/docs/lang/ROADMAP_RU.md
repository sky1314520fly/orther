# Дорожная карта Distilly

*Последнее обновление: 2026-09-03*

Каноническая дорожная карта находится в [ROADMAP.md](../../ROADMAP.md). Здесь описана Developer Preview из ветки `distilly-plugin`.

## Сейчас

Локальный TypeScript/SQLite-путь Codex проверен от начала до конца: локальные материалы, версии, исправления, review, ровно пять MCP-инструментов, установка Plugin и безопасное удаление.

Переходный путь совместимости теперь описан в документации: локальный host Skill без проверенного Plugin binding может явно использовать отдельный Legacy Skill из `dot-skill`; нативные Plugin bindings остаются задачей P1.

## P0

- Отдельная команда `distilly panel` с браузерным smoke-тестом собранного пакета.
- Устойчивая к сбоям очистка только тех blobs, на которые нет ссылок.
- Проверка на чистых машинах с Node 22.19 и 24, а также проверяемые upgrade и rollback Preview.

## P1: Host Plugins и локальный marketplace

Нам нужна помощь сообщества для создания и проверки Plugin bindings для **Claude Code, OpenClaw, Hermes, Grok Build, Grok Bot, OpenCode, Pi agent и DeepSeek Harness (DSH)**. Каждая интеграция должна иметь отдельный launcher, тесты setup/doctor/перезапуска/удаления и точные свидетельства host и capacity. Я буду активно review этих вкладов.

Локальный marketplace в Panel должен поддерживать поиск Profiles, проверку evidence и versions, установку подтверждённых Person Skills, а также import/export переносимых пакетов без приватных исходных материалов. Сетевой catalog появится только после определения правил согласия, moderation, licensing и upload.

## P2

После стабилизации Preview появятся parser для PDF, EML/MBOX и exports; разрешённые adapters для Lark, DingTalk, Slack и публичного X; двухэтапная миграция `dot-skill`; backup/restore и глубокая диагностика.
