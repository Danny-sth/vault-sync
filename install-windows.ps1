# Vault Sync - Windows Installer
# Запусти в PowerShell: iwr -useb https://raw.githubusercontent.com/Danny-sth/vault-sync/main/install-windows.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "=== Vault Sync Installer ===" -ForegroundColor Cyan

# Найти Obsidian vault
$defaultPaths = @(
    "$env:USERPROFILE\Documents\Obsidian",
    "$env:USERPROFILE\Obsidian",
    "D:\Obsidian",
    "E:\Obsidian"
)

$vaultPath = $null
foreach ($path in $defaultPaths) {
    if (Test-Path "$path\.obsidian") {
        $vaultPath = $path
        break
    }
}

if (-not $vaultPath) {
    $vaultPath = Read-Host "Введи путь к Obsidian vault (папка где .obsidian)"
}

if (-not (Test-Path "$vaultPath\.obsidian")) {
    Write-Host "Ошибка: .obsidian не найден в $vaultPath" -ForegroundColor Red
    exit 1
}

Write-Host "Vault: $vaultPath" -ForegroundColor Green

# Создать папку плагина
$pluginDir = "$vaultPath\.obsidian\plugins\vault-sync-realtime"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null

# Скачать файлы
Write-Host "Скачиваю плагин..." -ForegroundColor Yellow
$baseUrl = "https://github.com/Danny-sth/vault-sync/releases/latest/download"
Invoke-WebRequest -Uri "$baseUrl/main.js" -OutFile "$pluginDir\main.js"
Invoke-WebRequest -Uri "$baseUrl/manifest.json" -OutFile "$pluginDir\manifest.json"

# Создать конфиг
$deviceName = $env:COMPUTERNAME
$deviceId = "windows-" + $deviceName.ToLower()

$config = @{
    serverUrl = "ws://90.156.230.49:8443/ws"
    token = "1fc6ab61063cd3e81f82a062acc36555a7b9fa4d70022030ff3f2e7353ef9dd7"
    deviceId = $deviceId
    deviceName = "Windows $deviceName"
    autoConnect = $true
    syncOnStart = $true
    debounceMs = 500
} | ConvertTo-Json

$config | Out-File -Encoding utf8 "$pluginDir\data.json"

# Включить плагин
$communityPluginsPath = "$vaultPath\.obsidian\community-plugins.json"
if (Test-Path $communityPluginsPath) {
    $plugins = Get-Content $communityPluginsPath | ConvertFrom-Json
    if ($plugins -notcontains "vault-sync-realtime") {
        $plugins += "vault-sync-realtime"
        $plugins | ConvertTo-Json | Out-File -Encoding utf8 $communityPluginsPath
    }
} else {
    '["vault-sync-realtime"]' | Out-File -Encoding utf8 $communityPluginsPath
}

Write-Host ""
Write-Host "=== Готово! ===" -ForegroundColor Green
Write-Host "Перезапусти Obsidian" -ForegroundColor Cyan
Write-Host "Плагин подключится автоматически" -ForegroundColor Cyan
