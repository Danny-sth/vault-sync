#!/bin/bash
# VPN туннель через российский VPS (неинтерактивный режим для MCP)

VPS_HOST="147.45.102.213"
VPS_PASS='wmTxN7P@wvSuwK'
VPS_USER="root"

is_tunnel_active() {
    pgrep -f "sshuttle.*$VPS_HOST" > /dev/null 2>&1
}

get_ip() {
    curl -4 -s --max-time 3 ifconfig.me 2>/dev/null || echo "N/A"
}

# Запуск туннеля
echo "Запускаю VPN туннель через $VPS_HOST..."

# Останавливаем старый туннель если есть
sudo pkill -f "sshuttle.*$VPS_HOST" 2>/dev/null
sleep 1

# Запускаем новый туннель
sudo sshpass -p "$VPS_PASS" sshuttle \
    -e 'ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30' \
    -r ${VPS_USER}@${VPS_HOST} \
    0.0.0.0/0 \
    -x $VPS_HOST \
    --dns 2>&1 &

# Ждем подключения
echo "Жду подключения..."
for i in {1..15}; do
    sleep 1
    IP=$(get_ip)
    if [ "$IP" = "$VPS_HOST" ]; then
        echo "Туннель готов! IP: $IP"
        exit 0
    fi
done

echo "Таймаут подключения"
exit 1
