"""Property Business Date（物业业务日期，REV-FINAL-08）。

所有业务「今天」判断统一使用本模块的 business_date()：

    Property Timezone = Asia/Shanghai（UTC+8）
    business_date     = Asia/Shanghai 当前日期

实现说明（决策见 docs/DECISIONS.md）：
- 使用固定偏移 timezone(timedelta(hours=8), name="Asia/Shanghai")。
  上海自 1991 年起不再实行夏令时，固定 UTC+8 与 IANA Asia/Shanghai
  对一切现代业务日期完全等价，且不依赖宿主机（Windows/Linux）时区设置。
- 环境无 PyPI 网络无法安装 tzdata 包（Windows Python 无系统 tzdata），
  固定偏移方案同时规避了该依赖。
- 时间戳（actual_check_in_at 等）一律 timezone-aware，由 property_now() 生成。

禁止在业务代码中直接使用 datetime.now() / date.today() / 数据库服务器日期。
"""

from datetime import date, datetime, timedelta, timezone

PROPERTY_UTC_OFFSET = timezone(timedelta(hours=8), name="Asia/Shanghai")


def property_now() -> datetime:
    """Asia/Shanghai 当前时刻（timezone-aware）。"""
    return datetime.now(PROPERTY_UTC_OFFSET)


def business_date() -> date:
    """Property Business Date：Asia/Shanghai 当前日期。"""
    return property_now().date()


def add_days(value: date, days: int) -> date:
    """日期加减天数（测试与业务共用，避免散落 timedelta 语义）。"""
    return value + timedelta(days=days)
