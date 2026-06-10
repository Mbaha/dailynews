#!/bin/bash
# Shell wrapper for launchd — loads nvm so the correct node version is found.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

exec node /Users/mandersonk/code/javaScript/dailynews/scripts/watcher.mjs
