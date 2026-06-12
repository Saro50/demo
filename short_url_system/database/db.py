"""
数据库操作模块
================
本模块封装了短链接系统的所有数据库操作，基于 SQLAlchemy + SQLite。

核心接口：
  - init_db()          : 初始化数据库表结构（首次启动时调用）
  - create_short_url() : 创建短链接记录
  - get_by_short_code(): 通过短码查询长链接
  - increment_visits() : 增加访问计数
  - get_all_links()    : 获取所有短链接记录（用于演示页面展示）

数据模型:
  ShortLink 表字段：
    id          - 自增主键
    short_code  - 短码（唯一标识，支持自定义与自动生成）
    original_url- 原始长链接
    visit_count - 访问次数
    created_at  - 创建时间

注意：
  本模块的内部异常均会向上抛出，由上层（路由层）统一处理并记录日志。
  如需切换数据库（如 MySQL/PostgreSQL），只需修改此处 SQLALCHEMY_DATABASE_URL 配置，
  以及将 AnyIO 异步适配为对应方言即可。
"""

import string
import random
from datetime import datetime

from sqlalchemy import create_engine, Column, Integer, String, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker

# ── 数据库配置 ──────────────────────────────────────────────────────────────
# MVP 阶段使用 SQLite（单文件，无需额外服务），后续可切换至 PostgreSQL
SQLALCHEMY_DATABASE_URL = "sqlite:///./short_url.db"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False},  # SQLite 多线程共享连接
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


# ── 数据模型 ────────────────────────────────────────────────────────────────
class ShortLink(Base):
    """短链接数据模型"""
    __tablename__ = "short_links"

    id = Column(Integer, primary_key=True, index=True)
    short_code = Column(String(10), unique=True, nullable=False, index=True,
                        comment="短码：用户自定义或系统自动生成的唯一标识")
    original_url = Column(String(2048), nullable=False,
                          comment="原始长链接")
    visit_count = Column(Integer, default=0, nullable=False,
                         comment="累计访问次数")
    created_at = Column(DateTime, default=datetime.utcnow,
                        comment="创建时间")


# ── 公共方法 ────────────────────────────────────────────────────────────────

def init_db():
    """初始化数据库表结构（幂等，仅在表不存在时创建）"""
    Base.metadata.create_all(bind=engine)


def get_db_session():
    """获取数据库会话（上下文管理器用法由上层负责）"""
    return SessionLocal()


def generate_short_code(length: int = 6) -> str:
    """
    生成随机短码，只包含字母和数字（大小写敏感，避开易混淆字符）。
    
    参数 length: 短码长度，默认 6 位可提供 62^6 ≈ 568 亿种组合，冲突概率极低。
    
    注意：调用方务必验证该短码在数据库中唯一，若冲突应重新生成。
    """
    chars = string.ascii_letters + string.digits
    # 移除易混淆字符
    safe_chars = chars.replace('0', '').replace('O', '').replace('I', '').replace('l', '')
    return ''.join(random.choices(safe_chars, k=length))


def create_short_url(original_url: str, custom_code: str = None) -> dict:
    """
    创建短链接记录。

    参数:
      original_url: 长链接地址，由调用方保证非空且格式合法
      custom_code:  用户自定义短码，为 None 时系统自动生成

    返回:
      dict 包含新创建的记录信息：{id, short_code, original_url, visit_count, created_at}

    异常:
      ValueError: 当 custom_code 已存在时抛出，由上层捕获并返回友好提示
      Exception:  数据库写入异常，由上层统一记录日志
    """
    session = get_db_session()
    try:
        # 如果指定了自定义短码，检查唯一性
        if custom_code:
            existing = session.query(ShortLink).filter(
                ShortLink.short_code == custom_code
            ).first()
            if existing:
                raise ValueError(f"短码 '{custom_code}' 已被占用，请更换其他自定义短码")

        # 若未指定自定义短码，循环生成直到唯一
        short_code = custom_code
        if not short_code:
            for _ in range(10):  # 最多尝试 10 次，避免死循环
                candidate = generate_short_code()
                exists = session.query(ShortLink).filter(
                    ShortLink.short_code == candidate
                ).first()
                if not exists:
                    short_code = candidate
                    break
            if not short_code:
                raise RuntimeError("短码生成失败，无法找到可用短码（数据库可能已满）")

        # 创建记录
        new_link = ShortLink(
            short_code=short_code,
            original_url=original_url,
            visit_count=0,
            created_at=datetime.utcnow()
        )
        session.add(new_link)
        session.commit()
        session.refresh(new_link)

        return {
            "id": new_link.id,
            "short_code": new_link.short_code,
            "original_url": new_link.original_url,
            "visit_count": new_link.visit_count,
            "created_at": new_link.created_at.isoformat(),
        }
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_by_short_code(short_code: str) -> dict | None:
    """
    通过短码查询长链接记录。

    返回 dict 或 None（不存在时）。
    本方法不会增加访问计数，访问计数由 increment_visits() 单独处理，
    以保持查询和更新职责分离。
    """
    session = get_db_session()
    try:
        link = session.query(ShortLink).filter(
            ShortLink.short_code == short_code
        ).first()
        if not link:
            return None
        return {
            "id": link.id,
            "short_code": link.short_code,
            "original_url": link.original_url,
            "visit_count": link.visit_count,
            "created_at": link.created_at.isoformat(),
        }
    finally:
        session.close()


def increment_visits(short_code: str) -> bool:
    """
    增加指定短码的访问次数（原子操作）。

    返回 bool: 更新成功返回 True，短码不存在返回 False。
    
    注意：此操作使用 UPDATE 原子递增，在并发场景下不会丢失计数。
    """
    session = get_db_session()
    try:
        link = session.query(ShortLink).filter(
            ShortLink.short_code == short_code
        ).first()
        if not link:
            return False
        link.visit_count = ShortLink.visit_count + 1
        session.commit()
        return True
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_all_links(limit: int = 100) -> list[dict]:
    """
    获取所有短链接列表（按创建时间降序），用于演示页面展示。

    参数 limit: 最大返回条数，默认 100，避免数据量过大时影响页面加载。
    """
    session = get_db_session()
    try:
        links = (
            session.query(ShortLink)
            .order_by(ShortLink.created_at.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": link.id,
                "short_code": link.short_code,
                "original_url": link.original_url,
                "visit_count": link.visit_count,
                "created_at": link.created_at.isoformat(),
            }
            for link in links
        ]
    finally:
        session.close()
