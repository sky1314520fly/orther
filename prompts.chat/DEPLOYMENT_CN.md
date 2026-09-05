# prompts.chat 中文部署说明

## 环境要求

- Node.js 24.x
- PostgreSQL
- npm

生产环境建议准备域名、HTTPS 反向代理、稳定的 PostgreSQL 实例，并显式设置所有密钥。

## 快速安装

```bash
npx prompts.chat new my-prompt-library
cd my-prompt-library
```

该命令会复制干净的项目文件、安装依赖并启动交互式配置向导。

## 手动安装

```bash
git clone https://github.com/f/prompts.chat.git
cd prompts.chat
npm install
npm run setup
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

其中 `npm run db:seed` 为可选步骤。开发服务器启动后，按终端显示的地址访问。

## 生产构建与启动

```bash
npm run build
npm run start
```

数据库迁移也可使用适合生产环境的命令：

```bash
npm run db:deploy
```

## 基础环境变量

复制 `.env.example` 后填写实际值：

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/prompts_chat?schema=public"
NEXTAUTH_URL="https://your-domain.example"
NEXTAUTH_SECRET="your-super-secret-key-change-in-production"
CRON_SECRET="your-secret-key-here"
```

如使用连接池，`DATABASE_URL` 指向连接池地址，`DIRECT_URL` 指向数据库直连地址，以便执行迁移。

### 身份认证

按需要启用对应认证提供商，并在 `prompts.config.ts` 中配置 provider：

| 环境变量 | 用途 |
|---|---|
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | GitHub OAuth |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Google OAuth |
| `AZURE_AD_CLIENT_ID`、`AZURE_AD_CLIENT_SECRET`、`AZURE_AD_TENANT_ID` | Azure AD |
| `AUTH_APPLE_ID`、`AUTH_APPLE_SECRET` | Apple |
| `AUTH_OIDC_ID`、`AUTH_OIDC_SECRET`、`AUTH_OIDC_ISSUER` | 通用 OIDC |
| `AUTH_OAUTH_ID`、`AUTH_OAUTH_SECRET`、`AUTH_OAUTH_ISSUER` | 通用 OAuth 2.0 |

### AI 功能

| 环境变量 | 用途 |
|---|---|
| `OPENAI_API_KEY` | OpenAI 或兼容服务的 API Key |
| `OPENAI_BASE_URL` | 可选，自定义 OpenAI 兼容接口地址 |
| `OPENAI_EMBEDDING_MODEL` | 语义搜索使用的 Embedding 模型 |
| `OPENAI_GENERATIVE_MODEL` | AI 生成功能使用的模型 |
| `OPENAI_TRANSLATION_MODEL` | 搜索词翻译使用的模型 |

### 对象存储与媒体生成

对象存储可通过 `ENABLED_STORAGE` 选择 `do-spaces`、`s3` 或 `url`。S3 使用 `S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_ENDPOINT`；DigitalOcean Spaces 使用对应的 `DO_SPACES_*` 参数。

媒体生成可选用 `WIRO_API_KEY`、`WIRO_VIDEO_MODELS`、`WIRO_IMAGE_MODELS`，或 `FAL_API_KEY`、`FAL_VIDEO_MODELS`、`FAL_IMAGE_MODELS`。

所有可用键及注释以 [`source/.env.example`](source/.env.example) 为准。

## `prompts.config.ts` 配置

运行 `npm run setup` 可交互式生成 `prompts.config.ts`，主要包括：

- `branding`：名称、Logo、描述。
- `theme`：主色、圆角和界面样式。
- `auth`：认证提供商及是否允许注册。
- `features`：私有提示词、变更请求、分类、标签、评论、AI 搜索、AI 生成和 MCP。
- `homepage`：首页品牌、成就和赞助商内容。
- `i18n`：支持的语言及默认语言。

当 `useCloneBranding` 为 `true` 时，首页使用自定义品牌，并隐藏 prompts.chat 的成就、赞助商和私服推广内容，适合企业白标部署。

## 常用维护命令

```bash
npm run db:generate
npm run db:migrate
npm run db:deploy
npm run db:seed
npm run db:studio
npm run lint
npm test
```

## 常见问题

### 启动时数据库连接失败

检查 `DATABASE_URL` 的主机、端口、用户名、密码、数据库名和 `schema`。容器内访问宿主机时不能使用错误的 `localhost` 地址。

### OAuth 登录失败

确认 OAuth 平台登记的回调地址与实际域名、协议和 provider 完全一致，并检查相关 `*_CLIENT_ID`、`*_CLIENT_SECRET`。生产环境的 `NEXTAUTH_URL` 应使用最终 HTTPS 地址。

### AI 搜索不可用

需要在配置中开启对应功能，并正确设置 `OPENAI_API_KEY`。使用兼容服务时同时配置 `OPENAI_BASE_URL` 和支持的模型名。

### 修改配置后未生效

重新执行构建和启动；Docker 环境则重建或重启容器。运行时 `PCHAT_*` 配置无需修改源代码。
