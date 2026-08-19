#!/bin/bash
#
# Environment bootstrap for Claude Code on the web / fresh dev containers.
# Point the environment's setup script at this file:
#
#   bash /home/user/sbs-stats/scripts/setup_env.sh
#
# It resolves the repo from its own location, so it doesn't care what the
# caller's working directory is (the web setup script runs from /home/user,
# one level above the checkout).
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

# Debian's system setuptools (68.x, install_layout-patched) can't build
# telethon's `pyaes` dependency — a user-site upgrade fixes it without
# touching the distro-managed packages.
pip install --user --upgrade setuptools wheel
pip install -r scripts/requirements.txt
