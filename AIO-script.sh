#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/mxnix/AIClient-2-API"
REPO_NAME="AIClient-2-API"
resolve_script_dir() {
  local source_path="${BASH_SOURCE[0]:-}"

  if [[ -n "$source_path" && "$source_path" != "stdin" ]]; then
    local source_dir
    source_dir="$(dirname -- "$source_path")"
    if [[ -n "$source_dir" ]] && cd "$source_dir" >/dev/null 2>&1; then
      pwd
      return 0
    fi
  fi

  pwd
}

SCRIPT_DIR="$(resolve_script_dir)"
PROJECT_DIR=""
QUIET=1

log() {
  echo "[AIO] $*"
}

warn() {
  echo "[AIO][ПРЕДУПРЕЖДЕНИЕ] $*"
}

die() {
  echo "[AIO][ОШИБКА] $*" >&2
  exit 1
}

run_cmd() {
  if [[ "$QUIET" -eq 1 ]]; then
    "$@" >/dev/null 2>&1
  else
    "$@"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_termux() {
  [[ -n "${TERMUX_VERSION:-}" ]] || [[ "${PREFIX:-}" == *"com.termux"* ]]
}

is_macos() {
  [[ "$(uname -s)" == "Darwin" ]]
}

is_linux() {
  [[ "$(uname -s)" == "Linux" ]]
}

run_root_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command_exists sudo; then
    sudo "$@"
  else
    die "Для установки пакетов нужны права root или sudo."
  fi
}

update_termux_packages() {
  if ! is_termux; then
    return 0
  fi

  command_exists pkg || die "Команда pkg не найдена. Похоже, это не Termux."

  log "Termux: обновляю пакеты..."
  run_cmd pkg update -y
  run_cmd pkg upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
}

install_termux_packages_if_needed() {
  local need_git=0
  local need_node=0

  command_exists git || need_git=1
  command_exists node || need_node=1
  command_exists npm || need_node=1

  if [[ $need_git -eq 0 && $need_node -eq 0 ]]; then
    log "Termux: git и Node.js уже установлены."
    return 0
  fi

  if [[ $need_git -eq 1 ]]; then
    log "Termux: устанавливаю git..."
    run_cmd pkg install -y git
  fi

  if [[ $need_node -eq 1 ]]; then
    log "Termux: устанавливаю Node.js..."
    if ! run_cmd pkg install -y nodejs-lts; then
      warn "Пакет nodejs-lts недоступен, пробую nodejs."
      run_cmd pkg install -y nodejs
    fi
  fi
}

install_linux_packages_if_needed() {
  local need_git=0
  local need_node=0

  command_exists git || need_git=1
  command_exists node || need_node=1
  command_exists npm || need_node=1

  if [[ $need_git -eq 0 && $need_node -eq 0 ]]; then
    log "Linux: git и Node.js уже установлены."
    return 0
  fi

  if command_exists apt-get; then
    log "Linux: устанавливаю недостающие пакеты (apt-get)..."
    run_root_cmd apt-get update -y -qq
    if [[ $need_git -eq 1 ]]; then
      run_root_cmd apt-get install -y -qq git
    fi
    if [[ $need_node -eq 1 ]]; then
      run_root_cmd apt-get install -y -qq nodejs npm
    fi
  elif command_exists dnf; then
    log "Linux: устанавливаю недостающие пакеты (dnf)..."
    if [[ $need_git -eq 1 ]]; then
      run_root_cmd dnf install -y -q git
    fi
    if [[ $need_node -eq 1 ]]; then
      run_root_cmd dnf install -y -q nodejs npm
    fi
  elif command_exists yum; then
    log "Linux: устанавливаю недостающие пакеты (yum)..."
    if [[ $need_git -eq 1 ]]; then
      run_root_cmd yum install -y -q git
    fi
    if [[ $need_node -eq 1 ]]; then
      run_root_cmd yum install -y -q nodejs npm
    fi
  elif command_exists pacman; then
    log "Linux: устанавливаю недостающие пакеты (pacman)..."
    if [[ $need_git -eq 1 ]]; then
      run_root_cmd pacman -Sy --noconfirm --noprogressbar git
    fi
    if [[ $need_node -eq 1 ]]; then
      run_root_cmd pacman -Sy --noconfirm --noprogressbar nodejs npm
    fi
  elif command_exists zypper; then
    log "Linux: устанавливаю недостающие пакеты (zypper)..."
    if [[ $need_git -eq 1 ]]; then
      run_root_cmd zypper --non-interactive --quiet install git
    fi
    if [[ $need_node -eq 1 ]]; then
      run_root_cmd zypper --non-interactive --quiet install nodejs npm
    fi
  elif command_exists apk; then
    log "Linux: устанавливаю недостающие пакеты (apk)..."
    if [[ $need_git -eq 1 ]]; then
      run_root_cmd apk add --no-cache git
    fi
    if [[ $need_node -eq 1 ]]; then
      run_root_cmd apk add --no-cache nodejs npm
    fi
  else
    die "Не удалось определить менеджер пакетов Linux. Установите git и Node.js вручную."
  fi
}

install_macos_packages_if_needed() {
  local need_git=0
  local need_node=0

  command_exists git || need_git=1
  command_exists node || need_node=1
  command_exists npm || need_node=1

  if [[ $need_git -eq 0 && $need_node -eq 0 ]]; then
    log "macOS: git и Node.js уже установлены."
    return 0
  fi

  if ! command_exists brew; then
    die "На macOS не найден Homebrew. Установите Homebrew и запустите скрипт снова."
  fi

  if [[ $need_git -eq 1 ]]; then
    log "macOS: устанавливаю git..."
    brew install --quiet git
  fi

  if [[ $need_node -eq 1 ]]; then
    log "macOS: устанавливаю Node.js..."
    brew install --quiet node
  fi
}

is_target_remote() {
  [[ "$1" =~ mxnix/AIClient-2-API(\.git)?$ ]]
}

is_target_repo() {
  local dir="$1"
  local remote_url=""

  [[ -d "$dir/.git" ]] || return 1
  remote_url="$(git -C "$dir" config --get remote.origin.url 2>/dev/null || true)"
  [[ -n "$remote_url" ]] || return 1

  is_target_remote "$remote_url"
}

resolve_project_dir() {
  local cwd
  cwd="$(pwd)"

  if is_target_repo "$cwd"; then
    PROJECT_DIR="$cwd"
    return
  fi

  if is_target_repo "$SCRIPT_DIR"; then
    PROJECT_DIR="$SCRIPT_DIR"
    return
  fi

  PROJECT_DIR="$cwd/$REPO_NAME"
}

clone_or_update_repo() {
  resolve_project_dir
  log "Рабочая директория: $PROJECT_DIR"

  if [[ -d "$PROJECT_DIR/.git" ]]; then
    log "Обновляю репозиторий..."
    run_cmd git -C "$PROJECT_DIR" fetch --all --prune --quiet
    if ! run_cmd git -C "$PROJECT_DIR" pull --ff-only --quiet; then
      warn "git pull --ff-only не выполнен (возможны локальные изменения). Продолжаю."
    fi
    return 0
  fi

  if [[ -e "$PROJECT_DIR" ]]; then
    die "Папка '$PROJECT_DIR' уже существует, но это не репозиторий git. Удалите или переименуйте эту папку и запустите скрипт снова!"
  fi

  log "Клонирую репозиторий..."
  run_cmd git clone --quiet "$REPO_URL" "$PROJECT_DIR"
}

show_termux_runtime_notice() {
  if ! is_termux; then
    return 0
  fi

  echo
  echo "Запускаю AIClient2API."
  echo "Важно: эту сессию оставьте открытой. Остановить можно Ctrl+C."
  echo "Дальше откройте новую сессию Termux и запускайте SillyTavern там."
  echo "Потяните слева экрана вправо, кнопка New Session."
  if [[ -r /dev/tty ]]; then
    if ! read -r -p "Нажмите Enter, чтобы продолжить... " < /dev/tty; then
      warn "Не удалось прочитать ввод из терминала. Продолжаю без паузы."
    fi
  else
    warn "Терминал недоступен для ввода. Продолжаю без паузы."
  fi
  echo
}

run_project() {
  cd "$PROJECT_DIR"

  [[ -f "package.json" ]] || die "В '$PROJECT_DIR' не найден package.json."
  command_exists npm || die "npm не найден. Убедитесь, что Node.js установлен корректно."

  log "Устанавливаю зависимости npm..."
  run_cmd npm install --silent --no-progress

  show_termux_runtime_notice

  log "Запускаю npm start..."
  npm start
}

main() {
  for arg in "$@"; do
    if [[ "$arg" == "--verbose" ]]; then
      QUIET=0
      break
    fi
  done

  log "Старт AIO-скрипта для Linux/macOS/Termux."
  if [[ "$QUIET" -eq 1 ]]; then
    log "Тихий режим включен (подробный вывод: --verbose)."
  fi

  if is_termux; then
    update_termux_packages
    install_termux_packages_if_needed
  elif is_linux; then
    install_linux_packages_if_needed
  elif is_macos; then
    install_macos_packages_if_needed
  else
    die "Эта версия скрипта предназначена для Linux/macOS/Termux."
  fi

  command_exists git || die "git не найден после установки."
  command_exists node || die "node не найден после установки."
  command_exists npm || die "npm не найден после установки."

  clone_or_update_repo
  run_project
}

main "$@"
