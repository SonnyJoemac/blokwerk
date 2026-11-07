#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is nodig. Installeer het via https://nodejs.org en start dit bestand opnieuw."; (open https://nodejs.org || xdg-open https://nodejs.org) 2>/dev/null; read -r -p "Druk op Enter om te sluiten"; exit 1; }
[ "$1" = "boot" ] && export NO_OPEN=1
export BLOKWERK_LOOP=1
while true; do node blokwerk.js; [ $? -eq 42 ] || break; done
