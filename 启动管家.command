#!/bin/bash
# macOS 双击启动脚本。首次使用前可能需要：右键 → 打开（绕过 Gatekeeper），
# 或在终端执行：chmod +x "启动管家.command" 赋予执行权限。
#
# 健壮性：任何失败路径都先打印原因，再 hold 住窗口（等按键），
# 避免双击后窗口一闪而过看不到报错。
cd "$(dirname "$0")"

hold() { echo ""; read -n 1 -s -r -p "按任意键关闭此窗口…"; echo ""; }

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "============================================================"
  echo " 需要先安装 Node.js（只需一次）"
  echo "  1) 打开 https://nodejs.org"
  echo "  2) 下载并安装 LTS 版本（推荐 20.x）"
  echo "  3) 安装完成后重新双击本文件"
  echo "============================================================"
  hold
  exit 1
fi

# 确保有 config.json（值为空也没关系：程序首跑会用引导向导带你装可灵 / 登录 / 连接）。
if [ ! -f config.json ] && [ -f config.example.json ]; then
  cp config.example.json config.json
fi

echo "正在启动 Aether 管家… 关闭窗口 / Ctrl+C 即停止。"
echo "首次使用？跟着下面的「配置向导」按提示操作即可（装可灵 / 登录 / 连接账号）。"
echo "------------------------------------------------------------"
node src/index.js "$@"
echo ""
echo "------------------------------------------------------------"
echo "管家已停止（退出码 $?）。若刚启动就退出，请看上面的报错原因。"
hold
