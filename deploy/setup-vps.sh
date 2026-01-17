#!/bin/bash
set -e

# Run on VPS as root

# Create directories
mkdir -p /opt/vault-sync
mkdir -p /opt/sombra/obsidian-vault

# Create user if doesn't exist
id -u sombra &>/dev/null || useradd -r -s /bin/false sombra

# Set permissions
chown -R sombra:sombra /opt/vault-sync
chown -R sombra:sombra /opt/sombra/obsidian-vault

# Create env file
if [ ! -f /opt/vault-sync/.env ]; then
    TOKEN=$(openssl rand -hex 32)
    echo "VAULT_SYNC_TOKEN=$TOKEN" > /opt/vault-sync/.env
    chmod 600 /opt/vault-sync/.env
    chown sombra:sombra /opt/vault-sync/.env
    echo "Generated token: $TOKEN"
    echo "Save this token - you'll need it for Obsidian plugin!"
fi

# Install systemd service
cp vault-sync.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable vault-sync

echo "Setup complete!"
echo "1. Copy vault-sync binary to /opt/vault-sync/"
echo "2. Run: systemctl start vault-sync"
echo "3. Check: systemctl status vault-sync"
