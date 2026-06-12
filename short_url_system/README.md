# 短链接系统 (Short URL System) — MVP v1.0

一个轻量级的短链接生成与管理服务，基于 Python Flask + SQLite 构建。

---

## 环境要求

| 依赖项 | 最低版本 | 说明 |
|--------|---------|------|
| Python | **3.9+** | 推荐 3.11+，更优的性能与类型提示支持 |
| pip | 21+ | Python 包管理器 |
| SQLite | 3.x | Python 内置，无需额外安装 |

无需安装 MySQL、PostgreSQL、Redis 等外部服务，开箱即用。

---

## 快速启动

### 1. 克隆或进入项目目录

```bash
cd short_url_system
```

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

依赖清单（`requirements.txt`）：

```
flask>=3.0.0      # Web 框架
sqlalchemy>=2.0.0  # ORM 数据库操作层
```

### 3. 启动服务

```bash
python app.py
```

启动后终端输出如下：

```
2026-06-11 11:46:44 [INFO] 数据库初始化完成
2026-06-11 11:46:44 [INFO] 短链接系统启动 | 访问 http://localhost:5000 体验
 * Running on http://127.0.0.1:5000
```

### 4. 打开浏览器

访问 **[http://localhost:5000](http://localhost:5000)** 即可看到功能演示页面。

---

## 使用方法

### 网页端（推荐）

1. 在输入框中粘贴长链接
2. （可选）填写自定义短码，如 `my-link`
3. 点击 **生成短链接**
4. 复制生成的短链接，在浏览器中访问即可跳转

### API 方式

#### 创建短链接

```bash
curl -X POST http://localhost:5000/api/shorten \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.example.com/very/long/url",
    "custom_code": "my-link"
  }'
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✅ | 原始长链接，必须以 `http://` 或 `https://` 开头 |
| `custom_code` | string | ❌ | 自定义短码，3-10位字母/数字/下划线/连字符，留空则自动生成 |

**成功响应（200）：**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "short_code": "my-link",
    "original_url": "https://www.example.com/very/long/url",
    "visit_count": 0,
    "created_at": "2026-06-11T03:46:46",
    "short_url": "http://localhost:5000/my-link"
  }
}
```

**错误响应示例：**

| 状态码 | 场景 | 响应 |
|--------|------|------|
| 400 | URL 为空或格式非法 | `{"success": false, "error": "URL 不能为空"}` |
| 409 | 自定义短码已被占用 | `{"success": false, "error": "短码 'my-link' 已被占用"}` |
| 500 | 服务器内部错误 | `{"success": false, "error": "服务器内部错误"}` |

#### 获取短链接列表

```bash
curl http://localhost:5000/api/links
```

#### 访问短链接（重定向）

```bash
# 浏览器中直接访问，或使用 curl
curl -v http://localhost:5000/my-link
# → 302 重定向到原始链接
```

---

## 功能特性

### ✅ 已实现（MVP）

- **生成短链接**：支持自定义短码与系统自动生成（6位随机，62⁶ ≈ 568亿组合）
- **重定向访问**：访问短链接 302 跳转至原始长链接
- **访问计数**：每次访问原子递增，支持并发安全
- **冲突检测**：自定义短码重复时自动提示
- **演示页面**：可视化表单 + 实时链接列表展示
- **安全防护**：
  - URL 协议白名单（仅 http/https）
  - 短码格式正则校验
  - 输入长度限制（URL ≤ 2048 字符）
  - 所有操作日志记录

### 🔜 规划中（后续迭代）

- 短链接过期时间
- 访问来源统计（User-Agent、IP 归属地）
- 二维码生成
- 批量导入导出
- API 鉴权（Token）
- Redis 缓存热点短码

---

## 架构说明

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  浏览器/客户端 │ ──→ │  Flask 路由层  │ ──→ │ SQLite 数据库 │
│  (HTML/JS)   │ ←── │  (app.py)    │ ←── │ (db.py)     │
└─────────────┘     └──────────────┘     └─────────────┘
```

- **路由层**（`app.py`）：处理 HTTP 请求、参数校验、日志记录
- **数据层**（`database/db.py`）：封装所有 SQLite 操作，使用 SQLAlchemy ORM

---

## 生产部署建议

当需要对外提供服务时，建议：

### 方案一：Gunicorn + Nginx（推荐）

```bash
# 安装 Gunicorn
pip install gunicorn

# 启动（4 workers，约支撑 500+ 并发）
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```

Nginx 反向代理配置示例：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 方案二：Docker（容器化）

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
EXPOSE 5000
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:5000", "app:app"]
```

### 性能扩容方向

| 瓶颈 | 扩容方案 |
|------|---------|
| 数据库读写 | SQLite → PostgreSQL + 连接池 |
| 热点短码查询 | 引入 Redis 缓存 `short_code → original_url` 映射 |
| 高并发写入 | 引入消息队列（如 RabbitMQ）异步处理访问计数 |
| 单机瓶颈 | 水平扩展多实例 + Nginx 负载均衡 |

---

## 核心 API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 首页（演示页面） |
| `POST` | `/api/shorten` | 创建短链接 |
| `GET` | `/api/links` | 获取所有短链接列表 |
| `GET` | `/<short_code>` | 访问短链接（重定向） |

---

## 常见问题

**Q: 数据库文件在哪？**

启动后会在项目根目录自动生成 `short_url.db` 文件。

**Q: 如何重置数据？**

```bash
rm short_url.db
# 重启应用会自动创建新的空数据库
```

**Q: 如何修改短链接的域名？**

编辑 `app.py` 中的 `BASE_URL` 配置：

```python
app.config["BASE_URL"] = "https://your-domain.com"  # 默认为 http://localhost:5000
```

**Q: 短码能支持中文吗？**

当前设计仅支持字母、数字、下划线和连字符。这是因为短码作为 URL 路径段，中文需要额外编码，且不利于记忆分享。如需支持可在 `validate_custom_code()` 中放宽正则。
