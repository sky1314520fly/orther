# Roadmap do Distilly

*Última atualização: 2026-09-03*

O roadmap canônico está em [ROADMAP.md](../../ROADMAP.md). Esta página resume a Developer Preview da branch `distilly-plugin`.

## Agora

O fluxo local TypeScript/SQLite do Codex foi verificado de ponta a ponta: materiais locais, versões, correções, revisão, cinco ferramentas MCP, instalação do Plugin e desinstalação segura.

Como transição, já está documentado um caminho de compatibilidade: hosts locais de Skills sem binding de Plugin verificado podem usar explicitamente o Skill legado independente de `dot-skill`; os bindings nativos de Plugin continuam em P1.

## P0

- Um comando independente `distilly panel` com smoke test de navegador do pacote.
- Limpeza segura após falhas que remova apenas blobs sem referência.
- Matriz em máquinas limpas com Node 22.19 e 24, além de upgrade e rollback verificados da Preview.

## P1: Plugins de hosts e marketplace local

Precisamos de ajuda para criar e validar bindings de Plugin para **Claude Code, OpenClaw, Hermes, Grok Build, Grok Bot, OpenCode, Pi agent e DeepSeek Harness (DSH)**. Cada integração deve ter launcher isolado, testes de setup/doctor/reinício/desinstalação e evidência exata de host e capacidade. Vou revisar essas contribuições ativamente.

O marketplace local do Panel deve permitir buscar Profiles, revisar evidências e versões, instalar Person Skills confirmados e importar ou exportar pacotes portáteis sem materiais privados. Nenhum catálogo em rede será adicionado antes de definir consentimento, moderação, licenças e limites de upload.

## P2

Depois da estabilização da Preview virão parsers para PDF, EML/MBOX e exports; adapters autorizados para Lark, DingTalk, Slack e X público; migração de `dot-skill` em duas etapas; backup/restore e diagnóstico profundo.
