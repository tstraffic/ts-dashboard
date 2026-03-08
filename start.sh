#!/bin/bash
# T&S Traffic Control - Project Dashboard
# Start script

export PATH="$HOME/local/node/bin:$PATH"
cd "$(dirname "$0")"

echo ""
echo "  T&S Traffic Control - Project Dashboard"
echo "  ========================================="
echo ""

node server.js
