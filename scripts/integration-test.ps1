param([string]$BaseUrl = 'http://127.0.0.1:3000')

$ErrorActionPreference = 'Stop'
$email = "integration.$([guid]::NewGuid().ToString('N'))@streaming.local"
$password = 'Integration#2608'
$newPassword = 'Integration#2609'
$token = $null
$profileId = $null
$passed = 0
$rootEnv = Join-Path $PSScriptRoot '..\.env'
$config = @{}
Get-Content $rootEnv | Where-Object { $_ -match '^[A-Z][A-Z0-9_]*=' } | ForEach-Object { $key, $value = $_ -split '=', 2; $config[$key] = $value }
$pgTitleId = '10000000-0000-0000-0000-000000000001'
$rTitleId = '10000000-0000-0000-0000-000000000002'
$directMediaId = '20000000-0000-0000-0000-000000000001'
$hlsMediaId = '20000000-0000-0000-0000-000000000002'
$hlsJobId = '30000000-0000-0000-0000-000000000001'

function Invoke-TestSql([string]$Sql) {
  $Sql | docker exec -i streaming-postgres psql -v ON_ERROR_STOP=1 -U $config.POSTGRES_USER -d $config.POSTGRES_DB | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Test fixture SQL failed' }
}

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
  Invoke-TestSql @"
INSERT INTO "Title" (id,type,name,"releaseYear",rating,genres,"createdAt","updatedAt","cast") VALUES
('$pgTitleId','MOVIE','Integration PG',2024,'PG-13',ARRAY['Test'],NOW(),NOW(),ARRAY[]::TEXT[]),
('$rTitleId','MOVIE','Integration R',2024,'R',ARRAY['Test'],NOW(),NOW(),ARRAY[]::TEXT[]) ON CONFLICT (id) DO NOTHING;
INSERT INTO "MediaFile" (id,"titleId","sourcePath",container,"videoCodec","audioTracks","subtitleTracks","durationSec","importedAt") VALUES
('$directMediaId','$pgTitleId','integration/direct.mp4','mp4','h264','[{"codec":"aac","language":"eng"}]'::jsonb,'[]'::jsonb,120,NOW()),
('$hlsMediaId','$rTitleId','integration/hls.mkv','mkv','hevc','[{"codec":"dts","language":"eng"}]'::jsonb,'[]'::jsonb,120,NOW()) ON CONFLICT (id) DO NOTHING;
INSERT INTO "TranscodeJob" (id,"mediaFileId",encoder,"targetHeight",status,"outputPath","createdAt","finishedAt",attempt)
VALUES ('$hlsJobId','$hlsMediaId','libx264',720,'DONE','fixture',NOW(),NOW(),1) ON CONFLICT (id) DO NOTHING;
"@
  Assert-Status 'health is public' (Invoke-TestRequest GET '/health') 200
  Assert-Status 'account endpoint rejects anonymous requests' (Invoke-TestRequest GET '/auth/me') 401

  $registered = Invoke-TestRequest POST '/auth/register' @{ email = $email; password = $password }
  Assert-Status 'register' $registered 201
  $token = $registered.Body.accessToken
  Assert-Status 'new access token works' (Invoke-TestRequest GET '/auth/me' $null $token) 200
  Assert-Status 'non-admin cannot scan library' (Invoke-TestRequest POST '/media/scan' @{} $token) 403
  Assert-Status 'non-admin cannot list users' (Invoke-TestRequest GET '/auth/users' $null $token) 403
  Assert-Status 'non-admin cannot read admin overview' (Invoke-TestRequest GET '/admin/overview' $null $token) 403

  $profile = Invoke-TestRequest POST '/profiles' @{ name = 'Integration'; isKid = $true; maxRating = 'PG-13' } $token
  Assert-Status 'create profile' $profile 201
  $profileId = $profile.Body.id
  Assert-Status 'set profile PIN' (Invoke-TestRequest POST "/profiles/$profileId/pin" @{ pin = '2608' } $token) 201
  Assert-Status 'wrong PIN is rejected' (Invoke-TestRequest POST "/profiles/$profileId/session" @{ pin = '9999' } $token) 401

  $session = Invoke-TestRequest POST "/profiles/$profileId/session" @{ pin = '2608' } $token
  Assert-Status 'correct PIN creates profile session' $session 201
  $profileToken = $session.Body.accessToken

  $catalog = Invoke-TestRequest GET "/titles?profileId=$profileId" $null $profileToken
  Assert-Status 'profile catalog access' $catalog 200
  if (-not ($catalog.Body | Where-Object { $_.id -eq $pgTitleId })) { throw 'FAIL parental control: PG-13 title was hidden' }
  if ($catalog.Body | Where-Object { $_.id -eq $rTitleId }) { throw 'FAIL parental control: R title was visible' }
  $passed += 2
  Write-Output 'PASS parental control allows title at cap'
  Write-Output 'PASS parental control hides title above cap'
  $directPlan = Invoke-TestRequest GET "/stream/$directMediaId/playback" $null $profileToken
  Assert-Status 'direct playback plan endpoint' $directPlan 200
  if ($directPlan.Body.mode -ne 'direct') { throw "FAIL direct regression: got $($directPlan.Body.mode)" }
  $passed++; Write-Output 'PASS direct playback regression'
  $hlsPlan = Invoke-TestRequest GET "/stream/$hlsMediaId/playback" $null $token
  Assert-Status 'HLS playback plan endpoint' $hlsPlan 200
  if ($hlsPlan.Body.mode -ne 'hls' -or $hlsPlan.Body.url -notmatch '/720/') { throw "FAIL HLS regression: $($hlsPlan.Body | ConvertTo-Json -Compress)" }
  $passed++; Write-Output 'PASS HLS playback regression'
  Assert-Status 'parental control blocks HLS playback above cap' (Invoke-TestRequest GET "/stream/$hlsMediaId/playback" $null $profileToken) 404
  if ($catalog.Body.Count -gt 0) {
    $titleId = $catalog.Body[0].id
    Assert-Status 'add watchlist item' (Invoke-TestRequest POST "/profiles/$profileId/watchlist" @{ titleId = $titleId } $profileToken) 201
    Assert-Status 'read watchlist' (Invoke-TestRequest GET "/profiles/$profileId/watchlist" $null $profileToken) 200
    Assert-Status 'remove watchlist item' (Invoke-TestRequest DELETE "/profiles/$profileId/watchlist/$titleId" $null $profileToken) 200
  }

  Assert-Status 'change password' (Invoke-TestRequest POST '/auth/change-password' @{ currentPassword = $password; newPassword = $newPassword } $token) 201
  Assert-Status 'old account token is revoked' (Invoke-TestRequest GET '/auth/me' $null $token) 401
  Assert-Status 'old profile token is revoked' (Invoke-TestRequest GET '/titles' $null $profileToken) 401
  $newLogin = Invoke-TestRequest POST '/auth/login' @{ email = $email; password = $newPassword }
  Assert-Status 'new password logs in' $newLogin 201
  $newToken = $newLogin.Body.accessToken
  Assert-Status 'revoke all own sessions' (Invoke-TestRequest POST '/auth/revoke-sessions' @{} $newToken) 201
  Assert-Status 'revoked token no longer works' (Invoke-TestRequest GET '/auth/me' $null $newToken) 401
  Write-Output "Integration suite passed: $passed checks"
} finally {
  $cleanup = @"
BEGIN;
DELETE FROM "WatchlistItem" WHERE "profileId" IN (SELECT id FROM "Profile" WHERE "userId" IN (SELECT id FROM "User" WHERE email='$email'));
DELETE FROM "WatchProgress" WHERE "profileId" IN (SELECT id FROM "Profile" WHERE "userId" IN (SELECT id FROM "User" WHERE email='$email'));
DELETE FROM "Profile" WHERE "userId" IN (SELECT id FROM "User" WHERE email='$email');
DELETE FROM "User" WHERE email='$email';
DELETE FROM "TranscodeJob" WHERE id='$hlsJobId';
DELETE FROM "MediaFile" WHERE id IN ('$directMediaId','$hlsMediaId');
DELETE FROM "Title" WHERE id IN ('$pgTitleId','$rTitleId');
COMMIT;
"@
  Invoke-TestSql $cleanup
}
