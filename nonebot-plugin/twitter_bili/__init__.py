"""Twitter→QQ→Bilibili 发布系统 NoneBot2 插件包。"""

# NoneBot2 按目录加载插件时只执行本文件，子模块不会自动导入；
# 必须在此显式导入，否则 commands 的命令匹配器与 notification 的通知轮询都不会注册。
from . import commands  # noqa: F401
from . import notification  # noqa: F401
