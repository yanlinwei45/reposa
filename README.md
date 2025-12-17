# Reposa - Anthropic API 代理服务

一个基于 Next.js 15 的 Anthropic API 代理服务，提供 API 转发、日志记录、认证等功能。

## 📋 项目概述

**Reposa** (Response Proxy Service API) 是一个轻量级的 API 代理层，位于客户端和 Anthropic API 之间。

### 主要功能

- ✅ **API 代理转发** - 将客户端请求转发到 Anthropic API
- ✅ **流式响应支持** - 支持 Server-Sent Events (SSE) 流式传输
- ✅ **多端点兼容** - 提供标准和兼容两种 API 路径
- ✅ **请求日志记录** - 记录所有 API 请求和事件
- ✅ **CORS 支持** - 支持跨域请求
- ✅ **错误处理** - 统一的错误处理和响应格式

### 使用场景

1. **隐藏 API Key** - 在服务端安全存储 Anthropic API Key，避免暴露给客户端
2. **统一管理** - 集中管理和监控所有 API 调用
3. **请求日志** - 记录请求/响应用于分析和调试
4. **速率限制** - 可以添加自定义的速率限制逻辑
5. **请求转换** - 在转发前修改或增强请求

## 🚀 快速开始

### 1. 环境要求

- Node.js 18+
- pnpm (推荐) 或 npm

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env`：

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的 Anthropic API Key：

```env
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx
ANTHROPIC_API_URL=https://api.anthropic.com
PORT=9527
LOG_LEVEL=info
```

> 获取 API Key: https://console.anthropic.com/settings/keys

### 4. 启动开发服务器

```bash
pnpm dev
```

服务将在 http://localhost:9527 启动

### 5. 测试 API

使用 curl 测试：

```bash
curl -X POST http://localhost:9527/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
```

## 📁 项目结构

```
reposa/
├── app/                                      # Next.js App Router
│   ├── v1/messages/route.ts                 # 标准 API 端点
│   ├── api/
│   │   ├── compatible/v1/messages/route.ts  # 兼容 API 端点
│   │   └── event_logging/batch/route.ts     # 事件日志端点
│   ├── layout.tsx                           # 根布局
│   ├── page.tsx                             # 首页
│   └── globals.css                          # 全局样式
├── middleware.ts                             # Next.js 中间件（请求拦截）
├── .env.example                              # 环境变量示例
├── package.json                              # 项目依赖
└── README.md                                 # 项目文档
```

## 🛠️ API 端点说明

### 1. `/v1/messages` - 标准消息端点

**作用**: 主要的 Anthropic Messages API 代理端点

**请求示例**:

```bash
POST http://localhost:9527/v1/messages
Content-Type: application/json

{
  "model": "claude-sonnet-4-5-20250929",
  "max_tokens": 1024,
  "messages": [
    {"role": "user", "content": "你好"}
  ]
}
```

**支持参数**:
- `model` (必需) - 模型名称
- `messages` (必需) - 消息数组
- `max_tokens` - 最大生成 token 数
- `temperature` - 温度参数
- `stream` - 是否启用流式响应
- `system` - 系统提示词
- 其他 Anthropic API 支持的参数

### 2. `/api/compatible/v1/messages` - 兼容端点

**作用**: 与 `/v1/messages` 功能完全相同，提供不同的路径格式

**为什么需要?**
- 某些客户端库默认使用 `/api/*` 前缀
- 提供多种路径选择，增强兼容性

**使用方式**: 与 `/v1/messages` 完全相同

### 3. `/api/event_logging/batch` - 事件日志端点

**作用**: 接收 Claude CLI 等客户端发送的事件日志

**功能**:
- 记录 API 使用统计
- 收集性能指标
- 错误追踪

**扩展方向**:
- 发送到日志服务（Datadog, Sentry 等）
- 存储到数据库进行分析
- 触发监控告警

## 🔧 核心组件详解

### Middleware (中间件)

**文件**: `middleware.ts`

**作用**:
1. 在请求到达路由之前进行拦截
2. 记录请求日志
3. 添加 CORS 头
4. 可以添加认证、速率限制等

**执行流程**:
```
客户端请求 -> Middleware -> 路由处理器 -> 返回响应
```

**扩展示例**:

```typescript
// 添加 API Key 验证
const apiKey = request.headers.get('x-api-key');
if (!apiKey || apiKey !== process.env.CLIENT_API_KEY) {
  return NextResponse.json(
    { error: 'Invalid API key' },
    { status: 401 }
  );
}
```

### 路由处理器

**流式响应** (`stream: true`):
- 使用 Server-Sent Events (SSE)
- 实时返回生成的内容
- 适合长文本生成

**标准响应** (`stream: false` 或未设置):
- 等待完整响应后一次性返回
- 适合短文本或需要完整内容的场景

## 🔐 安全建议

### 开发环境

- ✅ 使用 `.env` 文件存储敏感信息
- ✅ 不要将 `.env` 文件提交到 Git

### 生产环境

1. **API Key 保护**
   - 使用环境变量存储
   - 不要在客户端暴露

2. **添加认证**
   ```typescript
   // 在 middleware.ts 中添加
   const clientKey = request.headers.get('x-api-key');
   if (!isValidKey(clientKey)) {
     return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
   }
   ```

3. **速率限制**
   - 使用 Redis 或内存存储实现
   - 防止 API 滥用

4. **CORS 限制**
   ```typescript
   // 限制允许的域名
   response.headers.set('Access-Control-Allow-Origin', 'https://yourdomain.com');
   ```

5. **HTTPS**
   - 生产环境必须使用 HTTPS
   - 保护传输数据安全

## 📊 监控和日志

### 当前日志级别

通过 `LOG_LEVEL` 环境变量控制：

- `debug` - 显示所有详细信息
- `info` - 显示一般信息（默认）
- `warn` - 只显示警告
- `error` - 只显示错误

### 日志示例

```
[Middleware] POST /v1/messages
[Middleware] API 请求详情: { path: '/v1/messages', method: 'POST', hasApiKey: true }
[/v1/messages] 收到请求: { model: 'claude-sonnet-4-5-20250929', messageCount: 1, stream: false }
[/v1/messages] 请求成功, ID: msg_01XYZ...
```

## 🚢 部署

### Vercel (推荐)

1. 将代码推送到 GitHub
2. 在 Vercel 中导入项目
3. 配置环境变量 `ANTHROPIC_API_KEY`
4. 部署

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### 其他平台

- Railway
- Render
- Fly.io
- 自托管 VPS

## 🧪 测试

### 使用 curl

```bash
# 标准请求
curl -X POST http://localhost:9527/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'

# 流式请求
curl -X POST http://localhost:9527/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

### 使用 Claude CLI

配置 Claude CLI 使用本地代理：

```bash
# 设置环境变量
export ANTHROPIC_BASE_URL=http://localhost:9527
export ANTHROPIC_API_KEY=your-key

# 使用 Claude CLI
claude "Hello, how are you?"
```

## 🔄 工作流程

```
┌─────────────┐
│   客户端     │
└──────┬──────┘
       │ HTTP Request
       ▼
┌─────────────────────┐
│   Next.js Server    │
│   (localhost:9527)  │
├─────────────────────┤
│   1. Middleware     │ ← 请求拦截、日志、CORS
│   2. Route Handler  │ ← 参数验证、转发
└──────┬──────────────┘
       │ HTTP Request (with real API Key)
       ▼
┌─────────────────────┐
│  Anthropic API      │
│ api.anthropic.com   │
└──────┬──────────────┘
       │ Response
       ▼
┌─────────────────────┐
│   客户端收到响应     │
└─────────────────────┘
```

## 🛣️ 未来计划

- [ ] 添加请求缓存（相同请求返回缓存结果）
- [ ] 实现速率限制
- [ ] 添加用户认证系统
- [ ] 使用统计面板
- [ ] 成本追踪和配额管理
- [ ] 支持更多 Anthropic API 端点
- [ ] Webhook 支持

## 📝 常见问题

### Q: 为什么需要代理服务？

A:
1. **安全**: 隐藏真实 API Key，避免在客户端暴露
2. **控制**: 统一管理 API 调用，添加日志、限流等
3. **灵活**: 可以在转发前/后修改请求/响应

### Q: 性能会有影响吗？

A: 代理会增加约 10-50ms 的延迟，但换来了安全性和可控性。对于流式响应，延迟几乎可以忽略。

### Q: 如何添加认证？

A: 在 `middleware.ts` 中添加 API Key 验证逻辑，参考上面的安全建议部分。

### Q: 支持哪些 Anthropic 模型？

A: 支持所有 Anthropic Messages API 的模型，包括：
- Claude Opus 4.5
- Claude Sonnet 4.5
- Claude Haiku 4

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

**需要帮助？** 查看 [Anthropic API 文档](https://docs.anthropic.com/en/api/getting-started)
