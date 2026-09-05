# Hoja de ruta de Distilly

*Última actualización: 2026-09-03*

La hoja de ruta canónica está en [ROADMAP.md](../../ROADMAP.md). Esta página resume la Developer Preview de la rama `distilly-plugin`.

## Ahora

El flujo de Codex está verificado de extremo a extremo como producto local TypeScript/SQLite: fuentes locales, versiones, correcciones, revisión, cinco herramientas MCP, instalación del Plugin y desinstalación segura.

Como transición, ya está documentado un camino de compatibilidad: los hosts locales de Skills sin un binding de Plugin verificado pueden usar explícitamente el Skill heredado independiente de `dot-skill`; los bindings nativos de Plugin siguen siendo una tarea P1.

## P0

- Un comando independiente `distilly panel` con una prueba de navegador del paquete.
- Limpieza segura ante fallos que elimine únicamente blobs sin referencias.
- Matriz en máquinas limpias para Node 22.19 y 24, además de actualización y reversión verificadas de la Preview.

## P1: Plugins de hosts y marketplace local

Necesitamos ayuda de la comunidad para crear y validar bindings de Plugin para **Claude Code, OpenClaw, Hermes, Grok Build, Grok Bot, OpenCode, Pi agent y DeepSeek Harness (DSH)**. Cada integración debe incluir launcher aislado, pruebas de setup/doctor/reinicio/desinstalación y evidencia exacta de host y capacidad. Revisaré activamente estas contribuciones.

El marketplace local del Panel debe permitir buscar perfiles, revisar evidencia y versiones, instalar Person Skills confirmados e importar o exportar paquetes portátiles sin materiales privados. No habrá catálogo en red hasta definir consentimiento, moderación, licencias y límites de carga.

## P2

Después de estabilizar la Preview vendrán parsers para PDF, EML/MBOX y exportaciones; adaptadores autorizados para Lark, DingTalk, Slack y X público; migración de `dot-skill` en dos etapas; backup/restore y diagnósticos profundos.
