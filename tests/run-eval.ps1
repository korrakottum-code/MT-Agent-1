# Agent regression suite - run before and after every change to the bot.
# Script text is ASCII on purpose: PowerShell 5.1 reads .ps1 as ANSI and would mangle Thai.
# Test content (questions, expectations) lives in cases.json, read as UTF-8.
# Usage: .\tests\run-eval.ps1 -TestKey <CRON_SECRET>
param(
  [Parameter(Mandatory = $true)][string]$TestKey,
  [string]$Url = "https://ssjsjvcbulclnvlrkdsj.supabase.co/functions/v1/line-webhook",
  [string]$CasesPath = (Join-Path $PSScriptRoot "cases.json"),
  [string]$Only = "",
  # haiku = cheap gate for routine checks. sonnet = what production actually runs,
  # so use it before calling a phase done. A haiku pass is evidence, not proof.
  # luna / gemini-flash are the cross-vendor models, eval only - see run-compare.ps1.
  [ValidateSet("haiku", "sonnet", "luna", "gemini-flash")][string]$Model = "sonnet"
)

$OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot "assert-case.ps1")
$cases = Get-Content $CasesPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Only) { $cases = $cases | Where-Object { $_.id -like "*$Only*" } }

$headers = @{ "Content-Type" = "application/json; charset=utf-8"; "x-test-key" = $TestKey }
$pass = 0; $fail = 0; $failed = @(); $requestErrors = 0

foreach ($c in $cases) {
  $payload = @{ as_user = $c.as_user; message = $c.message; model = $Model }
  if ($c.in_group) { $payload.in_group = $c.in_group }
  # judge = pretend the group message did not tag the bot, so the model must decide
  # for itself whether to answer or stay quiet. Assert on SILENT in the answer.
  if ($c.judge) { $payload.judge = $c.judge }
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))

  try {
    # Decode the body as UTF-8 by hand. PowerShell 5.1 falls back to Latin-1 when the
    # response has no charset, which turns Thai into mojibake and silently breaks
    # every Thai assertion below - they would match nothing and always "pass".
    $raw = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method POST -Headers $headers -Body $bodyBytes -TimeoutSec 180
    $res = [Text.Encoding]::UTF8.GetString($raw.RawContentStream.ToArray()) | ConvertFrom-Json
  } catch {
    Write-Host "[ERROR] $($c.id) - request failed: $_" -ForegroundColor Red
    # Read the body: the endpoint puts the real reason there, and a bare 500 hides it.
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
      $detail = $sr.ReadToEnd()
      if ($detail) { Write-Host "       $detail" -ForegroundColor Yellow }
    } catch { }
    $fail++; $failed += $c.id; $requestErrors++
    # Two in a row means the service is down, not that the bot regressed.
    # Keep going and every remaining case just burns time for the same answer.
    if ($requestErrors -ge 2) {
      Write-Host ""
      Write-Host "Aborting: two requests in a row failed outright. Check the detail above -" -ForegroundColor Red
      Write-Host "an exhausted Anthropic credit balance looks exactly like this." -ForegroundColor Red
      exit 1
    }
    continue
  }
  $requestErrors = 0

  $problems = @(Test-AgentCase -Case $c -Response $res)

  if ($problems.Count -eq 0) {
    Write-Host "[PASS] $($c.id)  ($($res.ms) ms)" -ForegroundColor Green
    $pass++
  } else {
    Write-Host "[FAIL] $($c.id) - $($c.why)" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "       $p" -ForegroundColor Yellow }
    $flat = ([string]$res.answer -replace "`r?`n", ' ')
    if ($flat.Length -gt 180) { $flat = $flat.Substring(0, 180) + '...' }
    Write-Host "       got: $flat" -ForegroundColor DarkGray
    $fail++; $failed += $c.id
  }
}

Write-Host ""
Write-Host "PASSED $pass / $($pass + $fail)  (model: $Model)" -ForegroundColor Cyan
if ($fail -gt 0) {
  Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "All green - safe to move to the next phase." -ForegroundColor Green
