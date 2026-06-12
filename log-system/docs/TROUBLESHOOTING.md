# 常见问题排查

> 本文档提供部署和集成过程中的常见问题及解决方案。

---

## 1. 服务端问题

### 服务无法启动

**现象**：`npm run dev` 报错退出

```
Error: Cannot find module 'better-sqlite3'
```

**解决**：
```bash
cd packages/server
npm install
# 如果 better-sqlite3 编译失败，尝试：
npm rebuild better-sqlite3
```

### 端口被占用

**现象**：`EADDRINUSE: address already in use :::3100`

**解决**：
```bash
# 查找占用进程
lsof -i :3100
# 或
kill $(lsof -t -i:3100)
```

### 数据库写满

**现象**：日志能接受（返回 accepted）但查不到数据

**解决**：
```bash
# 检查数据库文件大小
ls -lh packages/server/data/logs.db

# 检查磁盘空间
df -h

# 清理旧数据
sqlite3 packages/server/data/logs.db "DELETE FROM logs WHERE timestamp < $(date -d '-7 days' +%s)000;"
sqlite3 packages/server/data/logs.db "VACUUM;"
```

### 内存缓冲区未刷入

**现象**：刚上报的日志在 2 秒内查询不到

**原因**：内存缓冲区每 100ms 刷入一次，写入后需等待缓冲区刷新。这是正常行为。

**验证**：
```bash
sleep 2 && curl "http://localhost:3100/api/logs?page_size=5"
```

---

## 2. 前端 SDK 问题

### SDK 初始化不生效

**现象**：调用 `Logger.track()` 无响应，控制台无日志

**检查清单**：
- [ ] 是否在入口文件调用了 `Logger.init()`
- [ ] `endpoint` 地址是否正确（同域用 `/api/logs`，跨域用完整 URL）
- [ ] 跨域时后端是否配置了 CORS
- [ ] 浏览器控制台是否有报错（检查 `x-trace-id` header 相关）

### 网络请求日志重复

**现象**：SDK 上报日志的请求也被自动捕获为 `request` 类型日志

**原因**：SDK 覆写了 `window.fetch`，上报请求也触发了拦截器。

**影响**：每次上报会产生 1 条额外的 request 日志（记录上报请求本身）。

**解决**：目前不影响功能。后续版本会增加白名单过滤，排除上报接口自身的请求。

### IndexedDB 无法写入

**现象**：控制台输出 `[LogSystem] Queue push failed`

**常见原因**：
- 无痕/隐私模式下 IndexedDB 不可用
- 浏览器存储已满
- 跨域 iframe 中无权限

**解决**：SDK 内部已做 try-catch，写入失败不会影响业务代码。日志会丢失但应用正常运行。

### 脱敏过于严格

**现象**：正常的业务数据中的数字被误识别为手机号/身份证

**解决**：调整 `sanitizer.ts` 中的正则表达式，或设置 `sanitize: false` 关闭脱敏。

---

## 3. UI 看板问题

### 页面空白

**现象**：打开 `http://localhost:3101` 白屏

**检查清单**：
- [ ] 是否执行了 `npm install`
- [ ] 控制台是否有报错（F12 打开开发者工具）
- [ ] Vite 代理是否配置正确（`vite.config.ts` 中的 proxy）

### 日志列表为空

**现象**：看板打开后显示"暂无日志"

**检查清单**：
- [ ] 后端服务是否在运行 (`curl http://localhost:3100/api/health`)
- [ ] 是否已上报日志 (`curl http://localhost:3100/api/logs`)
- [ ] 默认筛选条件是否过滤了所有日志（看板默认显示 error + warn）
- [ ] 时间范围是否正确（默认最近 1 小时）

### 链路面板不显示

**现象**：点击日志后底部面板空白

**检查清单**：
- [ ] 该日志是否有 `trace_id` 字段
- [ ] 后端 `/api/traces/:traceID` 是否能正常返回数据
- [ ] 浏览器控制台是否有网络错误

---

## 4. 部署问题

### Nginx 代理后 IP 不正确

**现象**：所有日志的 `ip` 字段都是 `127.0.0.1`

**解决**：确保 Nginx 配置了正确的 proxy header：

```nginx
location /api/ {
    proxy_pass http://localhost:3100;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### HTTPS 混合内容

**现象**：HTTPS 页面加载 HTTP 接口被浏览器阻止

**解决**：确保后端服务也使用 HTTPS，或配置 Nginx 反向代理处理 SSL。

### 数据库被锁定

**现象**：`SQLITE_BUSY: database is locked`

**解决**：默认已启用 WAL 模式并设置 `busy_timeout = 5000`。
如果仍有此错误，减少并发写入量，或迁移到 PostgreSQL。

---

## 5. 调试技巧

### 开启 SDK 调试日志

SDK 内部使用 `console.log('[LogSystem] ...')` 输出关键信息。
在浏览器控制台中过滤 `[LogSystem]` 即可查看 SDK 运行状态。

```
// 浏览器控制台
[LogSystem] Initialized: app=test-app env=test
[LogSystem] Queue push success: trace-001-span-001
[LogSystem] Flush: sending 3 logs
[LogSystem] Flush: accepted 3
```

### 直接查询 SQLite

```bash
sqlite3 packages/server/data/logs.db
.tables
SELECT count(*) FROM logs;
SELECT level, category, message FROM logs LIMIT 10;
SELECT trace_id, span_count, has_error FROM traces;
```

### 模拟网络断开

```bash
# Mac: 使用 Network Link Conditioner 或
# 手动断开网络后操作页面，恢复后检查日志是否补传
```

---

## 6. 寻求帮助

如果以上方案无法解决问题：

1. 检查服务端日志输出（终端窗口或 nohup 输出文件）
2. 检查浏览器控制台 `[LogSystem]` 过滤日志
3. 确认版本匹配：SDK / Server / Shared 为同一版本
