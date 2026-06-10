#!/bin/bash
# Shell wrapper for launchd — loads nvm and mail credentials.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Load mail credentials from config file (keep passwords out of the plist).
[ -f "$HOME/.config/dikgang/mail.env" ] && source "$HOME/.config/dikgang/mail.env"

exec node /Users/mandersonk/code/javaScript/dailynews/scripts/mail-fetch.mjs
