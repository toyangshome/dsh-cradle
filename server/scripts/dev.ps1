param(
    [int]$Port = 8789,
    [string]$DatabaseUrl = $env:DATABASE_URL,
    [string]$RedisUrl = $env:REDIS_URL,
    [string]$Token = $env:CRADLE_TOKEN,
    [string]$AdminToken = $env:CRADLE_ADMIN_TOKEN,
    [string]$LogLevel = "info"
)

$ErrorActionPreference = "Stop"

if (-not $DatabaseUrl) { $DatabaseUrl = "postgres://postgres:postgres@127.0.0.1:5432/cradle?sslmode=disable" }
if (-not $RedisUrl) { $RedisUrl = "redis://127.0.0.1:6379/0" }

$env:DATABASE_URL = $DatabaseUrl
$env:REDIS_URL = $RedisUrl
$env:CRADLE_TOKEN = $Token
$env:CRADLE_ADMIN_TOKEN = $AdminToken
$env:CRADLE_LOG_LEVEL = $LogLevel

Write-Host "database : $DatabaseUrl"
Write-Host "redis    : $RedisUrl"
Write-Host "console  : http://127.0.0.1:$Port/admin"

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    go run ./cmd/cradle-server --port $Port
} finally {
    Pop-Location
}
