param(
    [string]$DatabaseUrl = $env:CRADLE_TEST_DATABASE_URL,
    [string]$RedisUrl = $env:CRADLE_TEST_REDIS_URL
)

$ErrorActionPreference = "Stop"

if (-not $DatabaseUrl) { $DatabaseUrl = "postgres://postgres:postgres@127.0.0.1:5432/cradle_test?sslmode=disable" }
if (-not $RedisUrl) { $RedisUrl = "redis://127.0.0.1:6379/2" }

$env:CRADLE_TEST_DATABASE_URL = $DatabaseUrl
$env:CRADLE_TEST_REDIS_URL = $RedisUrl

Write-Host "test database : $DatabaseUrl"
Write-Host "test redis    : $RedisUrl"

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    go test ./... -count=1
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
