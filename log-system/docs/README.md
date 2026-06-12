# @myby/log — 日志系统

## 可用文档

| 文档 | 适用对象 |
|------|----------|
| [QUICK_START.md](./QUICK_START.md) | 任何想 5 分钟跑通全链路的人 |
| [INTEGRATION_SDK.md](./INTEGRATION_SDK.md) | 需要在前端项目接入日志 SDK 的开发者 |
| [INTEGRATION_SERVER.md](./INTEGRATION_SERVER.md) | 需要部署或集成后端服务的开发者 |
| [API_REFERENCE.md](./API_REFERENCE.md) | 需要查阅完整 API 请求/响应格式的开发者 |
| [CONFIGURATION.md](./CONFIGURATION.md) | 需要调整系统配置的运维/开发人员 |
| [TESTING.md](./TESTING.md) | 需要编写测试或验证系统功能的开发者 |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | 遇到问题需要排查的人 |

## 设计原则

- **代码即文档**：架构逻辑、数据流、模块职责以源码为准
- **Schema 从数据库导出**：数据表结构可通过 `sqlite3 data/logs.db .schema` 获取最新定义
- **本目录只保留对开发者有直接操作价值的参考文档**，避免维护成本高于收益的说明性文档
