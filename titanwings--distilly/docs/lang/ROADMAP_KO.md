# Distilly 로드맵

*최종 업데이트: 2026-09-03*

정식 로드맵은 [ROADMAP.md](../../ROADMAP.md)에 있습니다. 이 문서는 `distilly-plugin` 브랜치의 Developer Preview를 요약합니다.

## 현재

Codex 로컬 TypeScript/SQLite 흐름은 로컬 자료, 버전, 수정, 검토, MCP 도구 5개, Plugin 설치와 안전한 제거까지 종단 간 검증되었습니다.

전환 기간을 위한 호환 경로도 문서화했습니다. 검증된 Plugin binding이 없는 로컬 Skill 호스트는 독립적인 `dot-skill` Legacy Skill을 명시적으로 사용할 수 있으며, 네이티브 Plugin binding은 계속 P1 과제입니다.

## P0

- 패키지 브라우저 smoke test를 포함한 독립 `distilly panel` 명령.
- 참조되지 않은 blob만 제거하는 충돌 안전 정리.
- Node 22.19와 24의 clean-machine 검증 및 검증 가능한 Preview upgrade/rollback.

## P1: Host Plugin과 로컬 marketplace

**Claude Code, OpenClaw, Hermes, Grok Build, Grok Bot, OpenCode, Pi agent, DeepSeek Harness (DSH)**용 Plugin binding을 커뮤니티와 함께 만들고 검증해야 합니다. 각 통합에는 독립 launcher, setup/doctor/재시작/제거 테스트, 정확한 host 및 용량 증거가 필요합니다. 기여를 적극적으로 review하겠습니다.

로컬 Panel marketplace는 Profile 검색, 근거와 버전 검토, 승인된 Person Skill 설치, 비공개 원본 자료가 없는 portable package 가져오기와 내보내기를 지원해야 합니다. 동의, moderation, license, upload 경계가 정해지기 전에는 네트워크 catalog를 추가하지 않습니다.

## P2

Preview가 안정되면 PDF, EML/MBOX, export parser, Lark, DingTalk, Slack, 공개 X adapter, 2단계 `dot-skill` migration, backup/restore와 심층 doctor를 진행합니다.
