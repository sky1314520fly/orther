# prompts.chat Docker 中文部署说明

## Docker Compose 快速启动

源码构建：

```bash
git clone https://github.com/f/prompts.chat.git
cd prompts.chat
docker compose up -d --build
```

使用预构建镜像：

```bash
git clone https://github.com/f/prompts.chat.git
cd prompts.chat
docker compose up -d
```

默认访问地址为 <http://localhost:4444>。`compose.yml` 同时启动 `app` 和 PostgreSQL 17，并将数据库数据保存到 `postgres_data` 卷。

## 使用已有 PostgreSQL

```bash
docker run -d \
  --name prompts \
  -p 4444:3000 \
  -e DATABASE_URL="postgresql://user:pass@your-db-host:5432/prompts?schema=public" \
  -e AUTH_SECRET="$(openssl rand -base64 32)" \
  ghcr.io/f/prompts.chat:latest
```

如需本地构建镜像：

```bash
docker build -f docker/Dockerfile -t prompts.chat .
```

## 生产环境配置

在项目根目录创建 `.env`：

```bash
POSTGRES_PASSWORD=replace-with-a-strong-password
AUTH_SECRET=your-secret-key-here
PORT=4444
```

生成密钥：

```bash
openssl rand -base64 32
```

不要在生产环境使用 `compose.yml` 中的默认数据库密码。

## 运行时品牌与功能参数

所有运行时定制变量使用 `PCHAT_` 前缀。

| 环境变量 | 用途 | 默认值 |
|---|---|---|
| `PCHAT_NAME` | 应用名称 | `My Prompt Library` |
| `PCHAT_DESCRIPTION` | 应用描述 | `Collect, organize...` |
| `PCHAT_LOGO` | Logo 路径 | `/logo.svg` |
| `PCHAT_LOGO_DARK` | 深色模式 Logo | 与 `PCHAT_LOGO` 相同 |
| `PCHAT_FAVICON` | Favicon 路径 | `/logo.svg` |
| `PCHAT_COLOR` | 主题主色 | `#6366f1` |
| `PCHAT_THEME_RADIUS` | 圆角：`none\|sm\|md\|lg` | `sm` |
| `PCHAT_THEME_VARIANT` | 样式：`default\|flat\|brutal` | `default` |
| `PCHAT_THEME_DENSITY` | 密度：`compact\|default\|comfortable` | `default` |
| `PCHAT_AUTH_PROVIDERS` | 认证方式，逗号分隔 | `credentials` |
| `PCHAT_ALLOW_REGISTRATION` | 是否开放注册 | `true` |
| `PCHAT_LOCALES` | 支持语言，逗号分隔 | `en` |
| `PCHAT_DEFAULT_LOCALE` | 默认语言 | `en` |
| `PCHAT_FEATURE_PRIVATE_PROMPTS` | 私有提示词 | `true` |
| `PCHAT_FEATURE_CHANGE_REQUESTS` | 版本和变更请求 | `true` |
| `PCHAT_FEATURE_CATEGORIES` | 分类 | `true` |
| `PCHAT_FEATURE_TAGS` | 标签 | `true` |
| `PCHAT_FEATURE_COMMENTS` | 评论 | `true` |
| `PCHAT_FEATURE_AI_SEARCH` | AI 搜索 | `false` |
| `PCHAT_FEATURE_AI_GENERATION` | AI 生成 | `false` |
| `PCHAT_FEATURE_MCP` | MCP 功能 | `false` |

系统变量包括 `AUTH_SECRET`、`DATABASE_URL`、`DIRECT_URL` 和 `PORT`。

## 常用操作

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f
docker compose logs app
docker compose logs db

# 数据初始化
docker compose exec app npx prisma db seed

# 数据库终端
docker compose exec db psql -U prompts -d prompts

# 停止服务
docker compose down
```

## 备份与恢复

```bash
docker compose exec db pg_dump -U prompts prompts > backup.sql
docker compose exec -T db psql -U prompts prompts < backup.sql
```

执行 `docker compose down` 不会删除命名卷；执行 `docker compose down -v` 会删除数据库卷和数据，请谨慎使用。

## 健康检查

```bash
curl http://localhost:4444/api/health
```

正常响应中 `status` 为 `healthy`，且 `database` 为 `connected`。

## 更新

预构建镜像：

```bash
docker compose pull
docker compose up -d
```

本地构建：

```bash
git pull
docker compose up -d --build
```

## 反向代理

将 Nginx 或 Caddy 的上游指向 `127.0.0.1:4444`，并传递 `Host`、`X-Real-IP`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。生产环境应启用 HTTPS，并将公开认证地址设置为最终域名。

## 常见问题

- `app` 无法连接 `db`：等待 PostgreSQL 健康检查完成，并检查 `DATABASE_URL` 中的服务名是否为 `db`。
- 端口冲突：通过 `PORT` 修改宿主机端口，例如 `PORT=8080 docker compose up -d`。
- 登录后会话失效：确保设置稳定且足够强的 `AUTH_SECRET`，不要在每次启动时重新生成。
- 修改品牌后无变化：确认变量位于 `app.environment` 下，然后执行 `docker compose up -d`。
- 查看原项目完整排障、资源需求和代理示例：[`source/DOCKER.md`](source/DOCKER.md)。
