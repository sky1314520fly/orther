# prompts.chat 中文说明

> 世界大型开源 AI 提示词库，原名 Awesome ChatGPT Prompts。适用于 ChatGPT、Claude、Gemini、Llama、Mistral 等现代 AI 助手。

## 项目简介

`prompts.chat` 是一个由社区维护的提示词集合及可自行部署的提示词管理平台。用户可以浏览、搜索、复制、创建和分享提示词，也可以将完整平台部署到自己的服务器，为团队建立带品牌、权限和私有内容的提示词库。

- 官方网站：<https://prompts.chat>
- 原始仓库：<https://github.com/f/prompts.chat>
- 原始源码快照：[`source/`](source/)
- 原英文说明：[`source/README.md`](source/README.md)
- 中文部署说明：[`DEPLOYMENT_CN.md`](DEPLOYMENT_CN.md)
- Docker 中文说明：[`DOCKER_CN.md`](DOCKER_CN.md)
- 来源与许可证：[`SOURCE.md`](SOURCE.md)

## 主要功能

- 收录社区整理的通用 AI 提示词，提供分类、标签和语义搜索。
- 支持文本、JSON、YAML 以及带媒体内容的提示词。
- 支持提示词创建、分享、收藏、投票、排行榜和个性化订阅。
- 支持私有提示词、版本记录和类似 Pull Request 的变更请求。
- 提供英文、西班牙文、日文、土耳其文和中文等多语言界面。
- 内置提示工程互动教程，以及面向 8–14 岁儿童的游戏化学习内容。
- 提供 CLI、Claude Code 插件和 MCP Server 集成。
- 支持自托管、品牌定制、主题配置和多种身份认证方式。

## 技术栈

| 类别 | 技术 |
|---|---|
| Web 框架 | Next.js 16、React 19、TypeScript |
| UI | Tailwind CSS 4、Radix UI、Lucide React |
| 数据库 | PostgreSQL、Prisma 6 |
| 身份认证 | NextAuth，支持 credentials、GitHub、Google、Apple、Azure AD、OIDC、OAuth 2.0 |
| AI | OpenAI 兼容接口、Embedding、生成与翻译模型 |
| 协议与集成 | MCP、CLI、Claude Code Plugin |
| 测试与质量 | Vitest、ESLint |
| 部署 | Node.js 24.x、Docker、Docker Compose、GHCR |

## 使用方式

### 在线浏览

访问 <https://prompts.chat/prompts>，或查看原项目中的 [`PROMPTS.md`](source/PROMPTS.md) 和 [`prompts.csv`](source/prompts.csv)。

### CLI

```bash
npx prompts.chat
```

### Claude Code 插件

```text
/plugin marketplace add f/prompts.chat
/plugin install prompts.chat@prompts.chat
```

### MCP Server

远程方式：

```json
{
  "mcpServers": {
    "prompts.chat": {
      "url": "https://prompts.chat/api/mcp"
    }
  }
}
```

本地方式：

```json
{
  "mcpServers": {
    "prompts.chat": {
      "command": "npx",
      "args": ["-y", "prompts.chat", "mcp"]
    }
  }
}
```

## 典型使用场景

- 为日常写作、开发、学习、分析和内容创作查找可复用提示词。
- 在企业或团队内部建设私有提示词资产库。
- 使用 MCP 或 CLI 将提示词库接入 AI 编程工具。
- 学习提示工程，或为青少年提供互动式 AI 素养教育。
- 使用自有品牌、域名、认证体系和 PostgreSQL 数据库搭建独立站点。

## 快速自托管

```bash
npx prompts.chat new my-prompt-library
cd my-prompt-library
```

手动安装：

```bash
git clone https://github.com/f/prompts.chat.git
cd prompts.chat
npm install
npm run setup
```

详细步骤参见 [`DEPLOYMENT_CN.md`](DEPLOYMENT_CN.md)；使用容器部署参见 [`DOCKER_CN.md`](DOCKER_CN.md)。

## 许可证

原项目采用双许可证：

- `src/`、`prisma/`、`scripts/` 以及配置、构建文件等代码和站点原创内容采用 MIT License。
- `prompts.csv`、`PROMPTS.md` 和用户提交的提示词内容采用 CC0 1.0 Universal。
- 对归属不明确的文件，原项目声明默认适用 MIT License。

本目录仅整理中文说明，不声称对原项目拥有原创权。完整信息见 [`SOURCE.md`](SOURCE.md) 和原始源码中的许可证文件。
