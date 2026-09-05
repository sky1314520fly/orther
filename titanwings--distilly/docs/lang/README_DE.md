# Distilly — Developer Preview

Diese Seite fasst die aktuelle Vorschau zusammen. Die vollständige, kanonische Anleitung steht im [Root-README](../../README.md).

Distilly verwandelt ausdrücklich bereitgestelltes Material in versionierte **Person Profiles for Agents**. Die aufrufbare Oberfläche bleibt ein Skill; Speicherung, Laufzeit, Review und Host-Lifecycle werden als lokales Plugin geliefert.

## Installation

Die Vorschau liegt im Branch `distilly-plugin`. Codex ist für den vollständigen Ablauf verifiziert; OpenClaw `2026.3.24` und Hermes `v0.9.0` haben zusätzlich echte Transport-Kapazitäts-Fixtures, während die vollständige Lifecycle-Abnahme separat bleibt. Die folgenden Befehle zeigen die Codex-Installation. Benötigt werden Node.js `22.19+` oder `24`, pnpm `10.32+` und eine lokale Codex-CLI:

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js setup --host codex
node packages/cli/lib/bin.js doctor --host codex
```

Codex nach der Installation neu starten. Die Host-Integration lässt sich entfernen, ohne Personen, Profile oder Quellen zu löschen:

```bash
node packages/cli/lib/bin.js uninstall --host codex
```

Für OpenClaw und Hermes gibt es jetzt lokale Kompatibilitäts-Bindings. OpenClaw installiert und entdeckt das Claude-kompatible Bundle; Hermes installiert den verwalteten Skill und registriert denselben MCP-Server über Wrapper und Konfiguration. Beide Bindings führen Smoke-Checks für Installation, Discovery und die fünf Tools aus; für die unten genannten exakten Versionen liegen außerdem echte Transport-Kapazitäts-Fixtures des jeweiligen Hosts vor. Die Messung verwendet einen deterministischen synthetischen Fixture-Server über das echte Programm/Modell/MCP-Transport; die vollständige Paket- und Lifecycle-Abnahme bleibt separat. Bei jeder nicht erfassten Version oder einem geänderten Release-/Tool-Tupel schlägt das Setup weiterhin sicher fehl.

Der Modellvertrag besteht aus genau fünf MCP-Tools: `distilly_get`, `distilly_ingest`, `distilly_pending`, `distilly_commit` und `distilly_correct`.

## Kompatibilität mit dem Legacy Skill

Die oben genannten Node.js-, pnpm- und Codex-Voraussetzungen gelten nur für das native Codex-Plugin; der Legacy-Modus benötigt Codex, Node.js und pnpm nicht, setzt für den vollständigen alten Ablauf aber die normale Skill-Unterstützung des Hosts sowie Zugriff auf Dateisystem, Bash und Python voraus.

Codex, OpenClaw `2026.3.24` und Hermes `v0.9.0` besitzen jetzt verifizierte Transport-Kapazitäts-Fixtures des Hosts für das `distilly-plugin`-Plugin. In isolierten sauberen Sitzungen mit `openai-codex/gpt-5.4` betragen die gemessenen Nettobudgets 65.536 serialisierte Bytes für OpenClaw und 49.752 für Hermes. Für einen lokalen Skill-Host ohne verifiziertes Plugin-Binding kann der Nutzer ausdrücklich den gepflegten Legacy Skill aus dem Branch `dot-skill` installieren:

```bash
git clone --single-branch --branch dot-skill --depth 1 \
  https://github.com/titanwings/distilly.git <host-skills-dir>/distilly
git -C <host-skills-dir>/distilly rev-parse HEAD
```

Das ist eine getrennte Implementierung ohne unterstütztes gemeinsames Datenmodell. Legacy-Collector können den Namensraum `~/.distilly` verwenden; solange diese Überschneidung nicht isoliert und geprüft ist, dürfen Legacy- und Plugin-Pfad nicht gemeinsam verwendet werden. Die Kompatibilität deckt derzeit nur lokale Dateien und eingefügten Text ab. Sie bietet weder die SQLite-Autorität, die fünf MCP-Tools, das Panel noch den Plugin-Lifecycle der Preview. Nach einem fehlgeschlagenen Plugin-Setup oder Preflight erfolgt kein automatischer Wechsel. Im selben Discovery-Bereich eines Hosts darf nur eine aktive Installation namens `distilly` vorhanden sein; andere Kopien müssen vor dem Neustart deaktiviert oder entfernt werden. Der Import eines lokalen Skill-Repositorys für Grok Bot ist noch nicht verifiziert; derzeit wird dort nur ein manuell gespeicherter/privater Skill empfohlen.

## Aktueller Umfang

Die Vorschau akzeptiert ausgewählte TXT-, Markdown-, JSON- und SRT/VTT-Dateien, eingefügten Text und vom Nutzer ausgewählte öffentliche URLs. Codex, OpenClaw `2026.3.24` und Hermes `v0.9.0` sind kapazitätsverifiziert; die vollständige Paket- und Lifecycle-Abnahme bleibt eine separate Prüfung. Für Claude Code, DeepSeek Harness (DSH), Pi agent, Grok Build, OpenCode und Grok Bot fehlen noch Community-Fixtures; für Grok Bot ist außerdem kein lokaler Repository-Import verifiziert.

Siehe [Roadmap](../../ROADMAP.md) und [Update 2026-09](../../UPDATES.md).
