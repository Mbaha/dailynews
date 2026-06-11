#!/bin/bash
# Shell wrapper for launchd — loads nvm and .env.local so the correct node
# version and environment variables (including ANTHROPIC_API_KEY) are available.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

exec node --env-file /Users/mandersonk/code/javaScript/dailynews/.env.local \
  /Users/mandersonk/code/javaScript/dailynews/scripts/watcher.mjs
