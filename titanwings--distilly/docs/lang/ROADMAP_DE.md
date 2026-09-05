# Distilly roadmap

*Zuletzt aktualisiert: 2026-09-03*

Die aktuelle Produkt-Roadmap steht in [ROADMAP.md](../../ROADMAP.md). Diese Zusammenfassung beschreibt den Developer Preview auf dem Branch `distilly-plugin`.

## Jetzt

Der Codex-Pfad ist als lokale TypeScript/SQLite-Vorschau durchgängig verifiziert: lokale Quellen, Versionen, Korrekturen, Review, fünf MCP-Tools, Plugin-Installation und sichere Deinstallation.

Als Übergang ist jetzt ein Kompatibilitätspfad dokumentiert: Lokale Skill-Hosts ohne verifiziertes Plugin-Binding können ausdrücklich den getrennten Legacy Skill aus `dot-skill` verwenden; native Plugin-Bindings bleiben P1.

## P0

- Eigenständiger `distilly panel`-Befehl mit paketiertem Browser-Smoke-Test.
- Absturzsichere Bereinigung ausschließlich nicht referenzierter Blobs.
- Clean-Machine-Matrix für Node 22.19 und 24 sowie verifizierte Preview-Upgrades und Rollbacks.

## P1: Host-Plugins und lokaler Marketplace

Wir brauchen Community-Unterstützung für geprüfte Plugin-Bindings für **Claude Code, OpenClaw, Hermes, Grok Build, Grok Bot, OpenCode, Pi agent und DeepSeek Harness (DSH)**. Jede Integration braucht einen isolierten Launcher, Setup/Doctor/Restart/Uninstall-Tests sowie exakte Host- und Kapazitätsnachweise. Ich reviewe diese Beiträge aktiv.

Der lokale Panel-Marketplace soll Profile durchsuchen, Belege und Versionen prüfen, bestätigte Person Skills installieren und portable Pakete ohne private Rohmaterialien importieren oder exportieren. Ein Netzwerk-Katalog kommt erst nach festgelegten Regeln für Einwilligung, Moderation, Lizenzierung und Uploads.

## P2

PDF-, EML/MBOX- und Export-Parser, autorisierte Lark-, DingTalk-, Slack- und öffentliche X-Adapter, zweistufige `dot-skill`-Migration, Backup/Restore und tiefere Diagnose folgen nach stabiler Preview.
