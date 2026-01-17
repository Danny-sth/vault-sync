# Vault Sync - Windows Installer
# Запусти в PowerShell: iwr -useb https://raw.githubusercontent.com/Danny-sth/vault-sync/main/install-windows.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "=== Vault Sync Installer ===" -ForegroundColor Cyan

# Найти Obsidian vault
$defaultPaths = @(
    "$env:USERPROFILE\Documents\Obsidian",
    "$env:USERPROFILE\Documents\Obsidian Vault",
    "$env:USERPROFILE\Obsidian",
    "$env:USERPROFILE\Obsidian Vault",
    "$env:USERPROFILE\OneDrive\Documents\Obsidian",
    "C:\Obsidian",
    "D:\Obsidian",
    "E:\Obsidian"
)

$vaultPath = $null
foreach ($path in $defaultPaths) {
    if (Test-Path "$path\.obsidian") {
        $vaultPath = $path
        Write-Host "Найден vault: $path" -ForegroundColor Green
        break
    }
}

if (-not $vaultPath) {
    Write-Host "Vault не найден автоматически." -ForegroundColor Yellow
    Write-Host "Стандартные пути проверены:" -ForegroundColor Yellow
    foreach ($p in $defaultPaths) { Write-Host "  - $p" -ForegroundColor Gray }
    Write-Host ""
    $vaultPath = Read-Host "Введи полный путь к папке vault (где находится .obsidian)"
    $vaultPath = $vaultPath.Trim('"').Trim("'").Trim()
}

if ([string]::IsNullOrWhiteSpace($vaultPath)) {
    Write-Host "Ошибка: путь не указан" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$vaultPath\.obsidian")) {
    Write-Host "Ошибка: папка .obsidian не найдена в '$vaultPath'" -ForegroundColor Red
    Write-Host "Убедись что указал правильный путь к Obsidian vault" -ForegroundColor Red
    exit 1
}

Write-Host "Vault: $vaultPath" -ForegroundColor Green

# Создать папку плагина
$pluginDir = Join-Path $vaultPath ".obsidian\plugins\vault-sync-realtime"
if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
    Write-Host "Создана папка плагина" -ForegroundColor Gray
}

# Скачать файлы
Write-Host "Скачиваю плагин..." -ForegroundColor Yellow
$baseUrl = "https://github.com/Danny-sth/vault-sync/releases/latest/download"

try {
    Invoke-WebRequest -Uri "$baseUrl/main.js" -OutFile "$pluginDir\main.js" -UseBasicParsing
    Write-Host "  main.js - OK" -ForegroundColor Gray
} catch {
    Write-Host "Ошибка скачивания main.js: $_" -ForegroundColor Red
    exit 1
}

try {
    Invoke-WebRequest -Uri "$baseUrl/manifest.json" -OutFile "$pluginDir\manifest.json" -UseBasicParsing
    Write-Host "  manifest.json - OK" -ForegroundColor Gray
} catch {
    Write-Host "Ошибка скачивания manifest.json: $_" -ForegroundColor Red
    exit 1
}

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
}

$configJson = $config | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText("$pluginDir\data.json", $configJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "  data.json - OK" -ForegroundColor Gray

# Включить плагин
$communityPluginsPath = Join-Path $vaultPath ".obsidian\community-plugins.json"
try {
    if (Test-Path $communityPluginsPath) {
        $content = Get-Content $communityPluginsPath -Raw
        $plugins = $content | ConvertFrom-Json

        # Ensure it's an array
        if ($plugins -isnot [array]) {
            $plugins = @($plugins)
        }

        if ($plugins -notcontains "vault-sync-realtime") {
            $plugins = @($plugins) + "vault-sync-realtime"
        }
    } else {
        $plugins = @("vault-sync-realtime")
    }

    $pluginsJson = ConvertTo-Json -InputObject $plugins -Depth 10
    [System.IO.File]::WriteAllText($communityPluginsPath, $pluginsJson, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  community-plugins.json - OK" -ForegroundColor Gray
} catch {
    Write-Host "Предупреждение: не удалось обновить community-plugins.json: $_" -ForegroundColor Yellow
    Write-Host "Включи плагин вручную в настройках Obsidian" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Готово! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Следующие шаги:" -ForegroundColor Cyan
Write-Host "1. Перезапусти Obsidian" -ForegroundColor White
Write-Host "2. Settings -> Community Plugins -> включи 'Vault Sync'" -ForegroundColor White
Write-Host "3. Плагин подключится автоматически к серверу" -ForegroundColor White
Write-Host ""
Write-Host "Device ID: $deviceId" -ForegroundColor Gray
