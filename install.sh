#!/usr/bin/env bash
set -euo pipefail

# One-command installer for macOS and Linux. Requires Node.js >=22.13.0 and npm.
# No sudo, git clone, global npm install, shell configuration edits, or login.
weixin_install_tmp=""

cleanup() {
  if [ -n "$weixin_install_tmp" ]; then rm -rf -- "$weixin_install_tmp"; fi
}

usage() {
  cat <<'HELP'
用法：curl -fsSL https://raw.githubusercontent.com/dairoot/weixin-bot-cli/main/install.sh | bash
或：  bash install.sh [选项]

  --ref REF           安装指定分支、标签或提交，默认 main（也可设 WEIXIN_BOT_REF）
  --skill-dir PATH    Skill 目录，默认 ~/.agents/skills/weixin-bot
  --bin-dir PATH      CLI 命令目录，默认 ~/.local/bin
  --backup-dir PATH   升级备份目录，默认 ~/.local/share/weixin-bot/backups
  --no-bin            只安装 skill 及其运行时，不创建 CLI 短命令
  --help, -h          查看帮助

需要 Node.js >=22.13.0、npm、curl 和 tar。支持 macOS / Linux。
重复执行会备份并更新旧安装，保留 ~/.weixin-bot 中的登录和消息数据。
HELP
}

main() {
  local ref="${WEIXIN_BOT_REF:-main}"
  local install_args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) usage; return 0 ;;
      --ref|--skill-dir|--bin-dir|--backup-dir)
        if [ "$#" -lt 2 ] || [ -z "$2" ]; then printf '选项缺少参数：%s\n' "$1" >&2; return 1; fi
        if [ "$1" = '--ref' ]; then ref="$2"; else install_args+=("$1" "$2"); fi
        shift 2 ;;
      --no-bin) install_args+=("$1"); shift ;;
      *) printf '未知选项：%s\n' "$1" >&2; return 1 ;;
    esac
  done
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) printf '支持 macOS / Linux；Windows 请使用 WSL。\n' >&2; return 1 ;;
  esac
  local tool
  for tool in node npm curl tar; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      printf '缺少 %s。请先安装 Node.js >=22.13.0（含 npm）、curl 和 tar。\n' "$tool" >&2
      return 1
    fi
  done
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)'; then
    printf '需要 Node.js >=22.13.0；当前版本：%s\n' "$(node --version)" >&2
    return 1
  fi
  if [ -z "$ref" ]; then printf '安装版本不能为空。\n' >&2; return 1; fi
  local encoded_ref
  encoded_ref=$(node -p 'encodeURIComponent(process.argv[1])' -- "$ref")
  local temporary_root="${TMPDIR:-/tmp}"
  weixin_install_tmp=$(mktemp -d "${temporary_root%/}/weixin-bot-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '下载 weixin-bot-cli（%s）…\n' "$ref" >&2
  curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 15 --max-time 120 \
    "https://codeload.github.com/dairoot/weixin-bot-cli/tar.gz/${encoded_ref}" \
    -o "$weixin_install_tmp/source.tar.gz"
  mkdir "$weixin_install_tmp/source"
  tar -xzf "$weixin_install_tmp/source.tar.gz" --strip-components=1 -C "$weixin_install_tmp/source"
  if [ ! -f "$weixin_install_tmp/source/scripts/install.mjs" ] || [ ! -f "$weixin_install_tmp/source/package-lock.json" ]; then
    printf '该版本缺少一键安装文件，请使用 main 或支持安装器的版本。\n' >&2
    return 1
  fi
  printf '安装锁定版本的依赖…\n' >&2
  # Install from the package directory. Some npm versions misidentify the root
  # package when --prefix points through a temporary/symlinked path.
  (cd "$weixin_install_tmp/source" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  node "$weixin_install_tmp/source/scripts/install.mjs" ${install_args[@]+"${install_args[@]}"}
}

main "$@"
