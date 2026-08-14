param([string]$BaseUrl = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$email = "integration.$([guid]::NewGuid().ToString('N'))@streaming.local"
$password = 'Integration#2608'
$newPassword = 'Integration#2609'
$token = $null
$profileId = $null
$passed = 0

function Invoke-TestRequest {
  param([string]$Method, [string]$Path, $Body = $null, [string]$Bearer = '')
  $headers = @{}
  if ($Bearer) { $headers.Authorization = "Bearer $Bearer" }
  $params = @{ Method = $Method; Uri = "$BaseUrl$Path"; Headers = $headers; UseBasicParsing = $true }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Depth 8) }
  try {
    $response = Invoke-WebRequest @params
    $json = if ($response.Content) { $response.Content | ConvertFrom-Json } else { $null }
    return @{ Status = [int]$response.StatusCode; Body = $json }
  } catch {
    $status = [int]$_.Exception.Response.StatusCode
    return @{ Status = $status; Body = $null }
  }
}

function Assert-Status([string]$Name, $Response, [int]$Expected) {
  if ($Response.Status -ne $Expected) { throw "FAIL ${Name}: expected $Expected, got $($Response.Status)" }
  $script:passed++
  Write-Output "PASS $Name"
}

try {
  Assert-Status 'health is public' (Invoke-TestRequest GET '/health') 200
  Assert-Status 'account endpoint rejects anonymous requests' (Invoke-TestRequest GET '/auth/me') 401

  $registered = Invoke-TestRequest POST '/auth/register' @{ email = $email; password = $password }
  Assert-Status 'register' $registered 201
  $token = $registered.Body.accessToken
  Assert-Status 'new access token works' (Invoke-TestRequest GET '/auth/me' $null $token) 200
  Assert-Status 'non-admin cannot scan library' (Invoke-TestRequest POST '/media/scan' @{} $token) 403

  $profile = Invoke-TestRequest POST '/profiles' @{ name = 'Integration'; isKid = $false } $token
  Assert-Status 'create profile' $profile 201
  $profileId = $profile.Body.id
  Assert-Status 'set profile PIN' (Invoke-TestRequest POST "/profiles/$profileId/pin" @{ pin = '2608' } $token) 201
  Assert-Status 'wrong PIN is rejected' (Invoke-TestRequest POST "/profiles/$profileId/session" @{ pin = '9999' } $token) 401

  $session = Invoke-TestRequest POST "/profiles/$profileId/session" @{ pin = '2608' } $token
  Assert-Status 'correct PIN creates profile session' $session 201
  $profileToken = $session.Body.accessToken

  $catalog = Invoke-TestRequest GET "/titles?profileId=$profileId" $null $profileToken
  Assert-Status 'profile catalog access' $catalog 200
  if ($catalog.Body.Count -gt 0) {
    $titleId = $catalog.Body[0].id
    Assert-Status 'add watchlist item' (Invoke-TestRequest POST "/profiles/$profileId/watchlist" @{ titleId = $titleId } $profileToken) 201
    Assert-Status 'read watchlist' (Invoke-TestRequest GET "/profiles/$profileId/watchlist" $null $profileToken) 200
    Assert-Status 'remove watchlist item' (Invoke-TestRequest DELETE "/profiles/$profileId/watchlist/$titleId" $null $profileToken) 200
  }

  Assert-Status 'change password' (Invoke-TestRequest POST '/auth/change-password' @{ currentPassword = $password; newPassword = $newPassword } $token) 201
  Assert-Status 'old account token is revoked' (Invoke-TestRequest GET '/auth/me' $null $token) 401
  Assert-Status 'old profile token is revoked' (Invoke-TestRequest GET '/titles' $null $profileToken) 401
  Assert-Status 'new password logs in' (Invoke-TestRequest POST '/auth/login' @{ email = $email; password = $newPassword }) 201
  Write-Output "Integration suite passed: $passed checks"
} finally {
  $rootEnv = Join-Path $PSScriptRoot '..\.env'
  $config = @{}
  Get-Content $rootEnv | Where-Object { $_ -match '^[A-Z][A-Z0-9_]*=' } | ForEach-Object { $key, $value = $_ -split '=', 2; $config[$key] = $value }
  $cleanup = @"
BEGIN;
DELETE FROM "WatchlistItem" WHERE "profileId" IN (SELECT id FROM "Profile" WHERE "userId" IN (SELECT id FROM "User" WHERE email='$email'));
DELETE FROM "WatchProgress" WHERE "profileId" IN (SELECT id FROM "Profile" WHERE "userId" IN (SELECT id FROM "User" WHERE email='$email'));
DELETE FROM "Profile" WHERE "userId" IN (SELECT id FROM "User" WHERE email='$email');
DELETE FROM "User" WHERE email='$email';
COMMIT;
"@
  $cleanup | docker exec -i streaming-postgres psql -v ON_ERROR_STOP=1 -U $config.POSTGRES_USER -d $config.POSTGRES_DB | Out-Null
}
