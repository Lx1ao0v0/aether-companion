#!/bin/bash
# Linux 启动脚本。首次使用前执行 chmod +x start.sh 赋予执行权限，
# 然后 ./start.sh 启动。通常在终端里运行，窗口不会自动关闭。
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[需要先安装 Node.js] 请安装 LTS 版本（推荐 20.x）后重试：https://nodejs.org"
  exit 1
fi

# 确保有 config.json（值为空也没关系：程序首跑会用引导向导带你装可灵 / 登录 / 连接）。
if [ ! -f config.json ] && [ -f config.example.json ]; then
  cp config.example.json config.json
fi

echo "正在启动 Aether 管家... 关闭窗口 / Ctrl+C 即停止。"
echo "首次使用？跟着「配置向导」按提示操作即可（装可灵 / 登录 / 连接账号）。"
exec node src/index.js "$@"
