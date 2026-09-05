# Distilly — Developer Preview

이 페이지는 현재 프리뷰를 요약합니다. 전체 기준 안내는 [루트 README](../../README.md)를 확인하세요.

Distilly는 사용자가 명시적으로 제공한 자료를 버전이 있는 **Person Profiles for Agents**로 변환합니다. 호출 표면은 Skill로 유지되며 저장소, 런타임, 검토, 호스트 수명주기는 로컬 Plugin으로 제공합니다.

## 설치

프리뷰는 `distilly-plugin` 브랜치에 있습니다. Codex는 전체 흐름을 검증했으며, OpenClaw `2026.3.24`와 Hermes `v0.9.0`에도 실제 호스트 transport-capacity fixture가 있습니다(전체 lifecycle acceptance는 별도 검증입니다). 아래 명령은 Codex 설치 예시입니다. Node.js `22.19+` 또는 `24`, pnpm `10.32+`, 로컬 Codex CLI가 필요합니다.

```bash
git clone --branch distilly-plugin https://github.com/titanwings/distilly.git
cd distilly
corepack enable
pnpm install --frozen-lockfile
pnpm run build
node packages/cli/lib/bin.js setup --host codex
node packages/cli/lib/bin.js doctor --host codex
```

설치 후 Codex를 다시 시작하세요. 호스트 연동을 제거해도 사람, Profile, 로컬 자료는 보존됩니다.

```bash
node packages/cli/lib/bin.js uninstall --host codex
```

OpenClaw와 Hermes에는 이제 로컬 호환 binding이 있습니다. OpenClaw는 Claude 호환 bundle을 설치하고 발견하며, Hermes는 관리형 Skill을 설치하고 wrapper와 설정을 통해 같은 MCP 서버를 등록합니다. 두 binding 모두 설치·발견·5개 도구 smoke check를 실행하며, 아래의 정확한 버전에는 실제 호스트 transport-capacity fixture도 기록되어 있습니다. 측정은 실제 실행 파일·모델·MCP transport를 통해 결정적 synthetic fixture server를 사용하며, 전체 package/lifecycle acceptance는 별도 검증입니다. 기록되지 않은 버전이나 변경된 release/tool tuple에서는 setup이 계속 fail-closed합니다.

모델에 노출되는 MCP 계약은 정확히 다섯 가지 도구입니다: `distilly_get`, `distilly_ingest`, `distilly_pending`, `distilly_commit`, `distilly_correct`.

## Legacy Skill 호환 모드

위의 Node.js, pnpm, Codex 사전 조건은 네이티브 Codex Plugin에만 적용되며, Legacy 모드에는 Codex·Node.js·pnpm이 필요하지 않지만 전체 기존 흐름에는 호스트의 일반 Skill 지원과 filesystem·Bash·Python 기능이 필요합니다.

Codex, OpenClaw `2026.3.24`, Hermes `v0.9.0`에는 이제 `distilly-plugin` Plugin의 검증된 실제 호스트 transport-capacity fixture가 있습니다. `openai-codex/gpt-5.4` 격리 clean session에서 측정한 net budget은 OpenClaw가 65,536 serialized bytes, Hermes가 49,752입니다. 아직 검증된 Plugin binding이 없는 로컬 Skill 호스트에서는 사용자가 `dot-skill` 브랜치의 유지 관리용 Legacy Skill을 명시적으로 설치할 수 있습니다.

```bash
git clone --single-branch --branch dot-skill --depth 1 \
  https://github.com/titanwings/distilly.git <host-skills-dir>/distilly
git -C <host-skills-dir>/distilly rev-parse HEAD
```

이는 독립적인 구현이며 지원되는 공유 데이터 모델이 없습니다. Legacy collector가 `~/.distilly` 네임스페이스를 사용할 수 있으므로 해당 상호작용을 격리하고 감사하기 전에는 Legacy와 Plugin 경로를 함께 사용하지 마세요. 현재 호환 경로는 로컬 파일과 붙여 넣은 텍스트만 보장합니다. Preview의 SQLite authority, MCP 도구 5개, Panel, Plugin lifecycle을 제공하지 않습니다. Plugin setup 또는 preflight가 실패해도 자동으로 이 경로로 전환하지 않습니다. 같은 호스트의 discovery scope에는 활성 `distilly` 설치를 하나만 두고, 재시작 전에 다른 복사본을 비활성화하거나 제거하세요. Grok Bot의 로컬 Skill 저장소 import는 아직 검증되지 않았으므로, 현재는 saved/private Skill로 수동 저장하는 방법만 권장합니다.

## 현재 범위

사용자가 선택한 TXT, Markdown, JSON, SRT/VTT 파일과 붙여 넣은 텍스트, 공개 URL을 지원합니다. Codex, OpenClaw `2026.3.24`, Hermes `v0.9.0`은 capacity 검증을 마쳤으며, 전체 package/lifecycle acceptance는 별도 검사로 남아 있습니다. Claude Code, DeepSeek Harness (DSH), Pi agent, Grok Build, OpenCode, Grok Bot의 네이티브 Plugin binding에는 커뮤니티 fixture가 필요하며, Grok Bot은 검증된 로컬 저장소 가져오기도 없습니다.

[로드맵](../../ROADMAP.md)과 [2026-09 업데이트](../../UPDATES.md)를 참고하세요.
