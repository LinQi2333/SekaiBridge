import nonebot
from nonebot.adapters.onebot.v11 import Adapter as OneBotV11Adapter

# 初始化 NoneBot2（读取 .env 配置）
nonebot.init()

driver = nonebot.get_driver()
driver.register_adapter(OneBotV11Adapter)

# 加载插件：QQ 命令 + 新推文通知轮询
nonebot.load_builtin_plugins()  # 内置插件（含 echo，用于调试命令机制）
nonebot.load_plugin("twitter_bili.commands")
nonebot.load_plugin("twitter_bili.notification")

if __name__ == "__main__":
    nonebot.run()
