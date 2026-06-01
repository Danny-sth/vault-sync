#!/bin/bash
# VPN Russia - Connect to Innotech Cisco VPN
# Usage: ./vpn-russia.sh

set -e

VPN_SERVER="connect.inno.tech"
VPN_USER="${VPN_USER:-INNO\DKudinov_oc}"

echo "Connecting to Cisco VPN: $VPN_SERVER"
echo "User: $VPN_USER"
echo ""

# Check if openconnect is installed
if ! command -v openconnect &> /dev/null; then
    echo "Error: openconnect is not installed"
    echo "Install with: sudo apt-get install openconnect"
    exit 1
fi

# Check if already connected
if ip link show tun0 &> /dev/null; then
    echo "VPN already connected (tun0 exists)"
    echo "Disconnect first with: sudo killall openconnect"
    exit 1
fi

# Note: This script requires sudo privileges and interactive MFA
echo "Starting OpenConnect (requires sudo and MFA)..."
echo "You will be prompted for:"
echo "  1. Sudo password"
echo "  2. VPN password"
echo "  3. MFA token from https://mfa.inno.tech"
echo ""

# Run openconnect in background
# Note: In production, this should be run via systemd or similar
sudo openconnect \
    --protocol=anyconnect \
    --user="$VPN_USER" \
    --authgroup="Многофакторная аутентификация" \
    "$VPN_SERVER"

exit 0
