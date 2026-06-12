"""
短链接系统 - 主应用入口
=================================
基于 Flask + SQLite 的轻量级短链接服务。

架构概览：
  app.py          - 路由层：处理 HTTP 请求、参数校验、日志记录
  database/db.py  - 数据层：封装所有 SQLite 操作

业务数据流转：
  用户请求 → Flask 路由 → 参数校验/消毒 → db 层方法 → 返回响应

启动方式：
  cd short_url_system && python app.py

预估并发规模（MVP）：
  当前为单进程 Flask 开发服务器，约可支持 50-100 并发。
  如需生产部署：
    - 使用 Gunicorn/uWSGI + Nginx 反向代理，单机可支撑 500+ 并发
    - 若访问量 > 5000 QPS，建议引入 Redis 缓存热点短码映射，
      并将 SQLite 替换为 PostgreSQL + 连接池
"""

import re
import logging
from datetime import datetime

from flask import Flask, request, jsonify, redirect, render_template, url_for
from urllib.parse import urlparse

from database.db import (
    init_db,
    create_short_url,
    get_by_short_code,
    increment_visits,
    get_all_links,
)

# ── 应用初始化 ──────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config["BASE_URL"] = "http://localhost:5000"  # 部署时修改为实际域名

# ── 日志配置 ────────────────────────────────────────────────────────────────
# 所有用户交互处均记录日志，便于回溯问题
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ── 常量 ────────────────────────────────────────────────────────────────────
SHORT_CODE_REGEX = re.compile(r"^[a-zA-Z0-9_-]{3,10}$")
URL_REGEX = re.compile(
    r"^https?://"  # 必须 http 或 https 开头
    r"([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}"  # 域名
    r"(:\d+)?(/.*)?$"  # 端口和路径可选
)
MAX_URL_LENGTH = 2048


# ── 工具函数 ────────────────────────────────────────────────────────────────

def validate_url(url: str) -> tuple[bool, str]:
    """
    校验 URL 合法性。
    返回 (is_valid, error_message)
    
    安全注意：
      - 只允许 http/https 协议，防止 javascript: / file: 等协议攻击
      - 限制最大长度避免恶意超长输入
      - 防止 SSRF：不对内网地址做严格限制（MVP 阶段仅作格式校验），
        生产环境应加入 IP 黑名单过滤内网/回环地址
    """
    if not url or not url.strip():
        return False, "URL 不能为空"
    url = url.strip()
    if len(url) > MAX_URL_LENGTH:
        return False, f"URL 长度不能超过 {MAX_URL_LENGTH} 字符"
    if not URL_REGEX.match(url):
        return False, "请输入有效的 HTTP/HTTPS 链接"
    return True, ""


def validate_custom_code(code: str | None) -> tuple[bool, str]:
    """
    校验自定义短码合法性。
    返回 (is_valid, error_message)
    
    规则：3-10 位字母、数字、下划线、连字符
    原因：MySQL/PostgreSQL 中作为索引字段，过短冲突率高，过长不便于记忆
    """
    if not code or not code.strip():
        return True, ""  # 不填则系统自动生成
    code = code.strip()
    if not SHORT_CODE_REGEX.match(code):
        return False, "自定义短码需为 3-10 位的字母、数字、下划线或连字符"
    return True, ""


# ── 路由：首页 / 演示页面 ──────────────────────────────────────────────────

@app.route("/")
def index():
    """
    首页 - 短链接系统功能演示页面。
    展示已生成的短链接列表、提供创建表单。
    """
    links = get_all_links()
    return render_template("index.html", links=links, base_url=app.config["BASE_URL"])


# ── 路由：创建短链接 ──────────────────────────────────────────────────────

@app.route("/api/shorten", methods=["POST"])
def api_shorten():
    """
    [API] 创建短链接
    请求体 JSON: { "url": "...", "custom_code": "..." }
    返回 JSON:   { "success": true, "data": {...} } 或 { "success": false, "error": "..." }
    """
    # ── 日志记录用户操作 ──────────────────────────────────────────────
    data = request.get_json(silent=True) or {}
    logger.info(
        "用户请求创建短链接 | url=%s | custom_code=%s | remote=%s",
        data.get("url", "")[:100],  # 截断避免日志过长
        data.get("custom_code", "无"),
        request.remote_addr,
    )

    # 参数基本校验
    original_url = data.get("url", "").strip()
    custom_code = data.get("custom_code", "").strip() or None

    is_valid, err_msg = validate_url(original_url)
    if not is_valid:
        logger.warning("URL 校验失败 | error=%s | url=%s", err_msg, original_url[:100])
        return jsonify({"success": False, "error": err_msg}), 400

    is_valid, err_msg = validate_custom_code(custom_code)
    if not is_valid:
        logger.warning("自定义短码校验失败 | error=%s | code=%s", err_msg, custom_code)
        return jsonify({"success": False, "error": err_msg}), 400

    # 调用数据层创建
    try:
        link = create_short_url(original_url, custom_code)
        short_url = f"{app.config['BASE_URL']}/{link['short_code']}"
        logger.info(
            "短链接创建成功 | short_code=%s | original_url=%s",
            link["short_code"], link["original_url"][:100],
        )
        return jsonify({
            "success": True,
            "data": {
                **link,
                "short_url": short_url,
            },
        })
    except ValueError as e:
        # 自定义短码冲突
        logger.warning("短码冲突 | error=%s", str(e))
        return jsonify({"success": False, "error": str(e)}), 409
    except RuntimeError as e:
        # 系统生成短码用尽（极低概率）
        logger.error("短码生成异常 | error=%s", str(e))
        return jsonify({"success": False, "error": "系统繁忙，请稍后重试"}), 500
    except Exception as e:
        logger.error("创建短链接异常 | error=%s", str(e), exc_info=True)
        return jsonify({"success": False, "error": "服务器内部错误"}), 500


# ── 路由：重定向（短链接访问） ──────────────────────────────────────────

@app.route("/<short_code>")
def redirect_to_original(short_code):
    """
    访问短链接，重定向到原始长链接。
    同时记录访问次数。
    
    异常路径：
      - 短码不存在 → 返回404页面
      - 短码格式不合法 → 返回404页面
    """
    logger.info(
        "用户访问短链接 | short_code=%s | remote=%s",
        short_code, request.remote_addr,
    )

    # 基础格式校验
    if not SHORT_CODE_REGEX.match(short_code):
        logger.warning("短码格式非法 | short_code=%s", short_code)
        return render_template("404.html", short_code=short_code), 404

    # 查询短链接
    link = get_by_short_code(short_code)
    if not link:
        logger.warning("短码不存在 | short_code=%s", short_code)
        return render_template("404.html", short_code=short_code), 404

    # 增加访问计数（异步场景下可改为消息队列，MVP 阶段同步处理即可）
    increment_visits(short_code)

    logger.info(
        "重定向 | short_code=%s → %s | visit_count=%d",
        short_code, link["original_url"][:100], link["visit_count"] + 1,
    )

    # 重定向到原始链接（安全考虑：只允许 http/https 已在存储时保证）
    return redirect(link["original_url"], code=302)


# ── 路由：获取链接列表（API） ───────────────────────────────────────────

@app.route("/api/links", methods=["GET"])
def api_get_links():
    """
    [API] 获取所有短链接列表（用于前端动态刷新）。
    返回 JSON 格式的链接列表。
    """
    links = get_all_links()
    return jsonify({
        "success": True,
        "data": [
            {
                **link,
                "short_url": f"{app.config['BASE_URL']}/{link['short_code']}",
            }
            for link in links
        ],
    })


# ── 启动入口 ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # 首次运行自动初始化数据库
    init_db()
    logger.info("数据库初始化完成")
    logger.info("短链接系统启动 | 访问 http://localhost:5000 体验")
    app.run(host="0.0.0.0", port=5000, debug=True)
