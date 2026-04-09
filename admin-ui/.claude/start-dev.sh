#!/bin/sh
export PATH="/opt/homebrew/bin:/Users/mauriciodesouza/.nvm/versions/node/v22.22.2/bin:$PATH"
cd "/Users/mauriciodesouza/Desktop/TRABALHO/GovAI - Enterprise AI GRC /GitHub /GovAI GRC Platform/admin-ui"
exec /Users/mauriciodesouza/.nvm/versions/node/v22.22.2/bin/node node_modules/.bin/next dev --port 3000
