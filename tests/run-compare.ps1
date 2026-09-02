# Model bake-off - run the same exam against several models and put the results side by side.
# Scoring comes from tests/assert-case.ps1, the same rules run-eval.ps1 uses to guard main,
# so "passed the bake-off" and "passed the gate" mean the same thing.
#
# Script text is ASCII on purpose: PowerShell 5.1 reads .ps1 as ANSI and would mangle Thai.
# Test content (questions, expectations) lives in the cases*.json files, read as UTF-8.
#
# The model names below must exist in EVAL_MODELS in supabase/functions/line-webhook/index.ts.
# A model that is not wired up yet fails fast with the list of names the endpoint accepts.
#
# Usage: .\tests\run-compare.ps1 -TestKey <CRON_SECRET>
#        .\tests\run-compare.ps1 -TestKey <CRON_SECRET> -Models haiku,sonnet -Repeat 3
param(
  [Parameter(Mandatory = $true)][string]$TestKey,
  [string]$Url = "https://ssjsjvcbulclnvlrkdsj.supabase.co/functions/v1/line-webhook",
  [string[]]$Models = @("luna", "gemini-flash", "haiku"),
  [string[]]$CasesPath = @(
    (Join-Path $PSScriptRoot "cases-compare.json"),
    (Join-Path $PSScriptRoot "cases-judge.json")
  ),
  [string]$Only = "",
  # Models are not deterministic. One run tells you almost nothing about a close call -
  # raise this to 3 before deciding anything, and read the flaky column.
  [int]$Repeat = 1,
  [string]$OutDir = (Join-Path $PSScriptRoot "results")
)

$OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot "assert-case.ps1")

# "pwsh -File" hands every argument over as one literal string, so -Models haiku,sonnet
# arrives as a single name and every case gets skipped as an unknown model. Split by hand.
$Models = @($Models | ForEach-Object { $_ -split "," } | Where-Object { $_ } | ForEach-Object { $_.Trim() })
$CasesPath = @($CasesPath | ForEach-Object { $_ -split "," } | Where-Object { $_ } | ForEach-Object { $_.Trim() })

$cases = @()
foreach ($path in $CasesPath) {
  if (-not (Test-Path $path)) { Write-Host "case file not found: $path" -ForegroundColor Red; exit 1 }
  $suite = [IO.Path]::GetFileNameWithoutExtension($path)
  foreach ($c in (Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    Add-Member -InputObject $c -NotePropertyName suite -NotePropertyValue $suite -Force
    # Three axes, because "which model is better" is three separate questions:
    # correct = follows the rules and does not make things up
    # tools   = reaches for the right tool, and keeps its hands off the wrong one
    # silence = decides on its own whether a group message was even meant for it
    # Price is not a case - it comes out of the token counts the endpoint reports.
    if (-not $c.dimension) {
      $d = if ($suite -like "*judge*") { "silence" } else { "correct" }
      Add-Member -InputObject $c -NotePropertyName dimension -NotePropertyValue $d -Force
    }
    $cases += $c
  }
}
if ($Only) { $cases = $cases | Where-Object { $_.id -like "*$Only*" } }
if (-not $cases) { Write-Host "no cases matched" -ForegroundColor Red; exit 1 }

$prices = $null
$pricePath = Join-Path $PSScriptRoot "prices.json"
if (Test-Path $pricePath) { $prices = Get-Content $pricePath -Raw -Encoding UTF8 | ConvertFrom-Json }

# Cost of one call, or $null when we have no verified price for that model yet.
# Guessing a price here would be worse than showing nothing - the whole point of the
# bake-off is deciding what to pay for.
function Get-CallCost {
  param($ModelId, $Usage)
  if (-not $prices -or -not $ModelId -or -not $Usage) { return $null }
  $p = $null
  foreach ($k in $prices.PSObject.Properties.Name) {
    if ($k -eq "_note") { continue }
    if ($ModelId.StartsWith($k)) { $p = $prices.$k; break }
  }
  if (-not $p -or $null -eq $p.input -or $null -eq $p.output) { return $null }
  $cacheRead = if ($null -ne $p.cache_read) { $p.cache_read } else { $p.input * 0.1 }
  $cacheWrite = if ($null -ne $p.cache_write) { $p.cache_write } else { $p.input * 1.25 }
  return (
    ($Usage.input * $p.input) + ($Usage.output * $p.output) +
    ($Usage.cache_read * $cacheRead) + ($Usage.cache_write * $cacheWrite)
  ) / 1000000
}

$headers = @{ "Content-Type" = "application/json; charset=utf-8"; "x-test-key" = $TestKey }
$results = @{}   # "<model>|<case id>" -> record
$totals = @{}
$dead = @{}
foreach ($m in $Models) {
  $totals[$m] = [ordered]@{
    model = $m; modelId = $null; runs = 0; passed = 0; graded = 0; errors = 0
    ms = 0; input = 0; output = 0; cache_read = 0; cache_write = 0; cost = 0.0; costKnown = $true
    byDim = @{}
  }
  foreach ($d in @("correct", "tools", "silence")) {
    $totals[$m].byDim[$d] = [ordered]@{ passed = 0; graded = 0 }
  }
  $dead[$m] = 0
}

$manualCases = @($cases | Where-Object { $_.manual })
$gradedCases = @($cases | Where-Object { -not $_.manual })
Write-Host ""
Write-Host "Bake-off: $($gradedCases.Count) graded + $($manualCases.Count) read-yourself cases x $($Models.Count) models x $Repeat run(s)" -ForegroundColor Cyan
Write-Host "= $(($cases.Count) * $Models.Count * $Repeat) agent calls. Regression suites are NOT included; run run-eval.ps1 for those." -ForegroundColor DarkGray
Write-Host ""

foreach ($c in $cases) {
  Write-Host "$($c.id)" -ForegroundColor White -NoNewline
  Write-Host "  [$($c.suite)]" -ForegroundColor DarkGray
  foreach ($m in $Models) {
    if ($dead[$m] -ge 2) { Write-Host "  $m : skipped (model looks down)" -ForegroundColor DarkGray; continue }

    $rec = [ordered]@{
      model = $m; id = $c.id; suite = $c.suite; dimension = [string]$c.dimension; manual = [bool]$c.manual
      runs = 0; passed = 0; problems = @(); answers = @(); ms = @(); error = $null
    }
    for ($r = 0; $r -lt $Repeat; $r++) {
      $payload = @{ as_user = $c.as_user; message = $c.message; model = $m }
      if ($c.in_group) { $payload.in_group = $c.in_group }
      if ($c.judge) { $payload.judge = $c.judge }
      $bodyBytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))

      try {
        # Decode as UTF-8 by hand. PowerShell 5.1 falls back to Latin-1 when the response
        # carries no charset, which turns Thai into mojibake and makes every Thai
        # assertion match nothing - the suite would then "pass" while testing nothing.
        $raw = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method POST -Headers $headers -Body $bodyBytes -TimeoutSec 240
        $res = [Text.Encoding]::UTF8.GetString($raw.RawContentStream.ToArray()) | ConvertFrom-Json
      } catch {
        $detail = ""
        try {
          $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream(), [Text.Encoding]::UTF8)
          $detail = $sr.ReadToEnd()
        } catch { }
        # A model name the endpoint does not know is a wiring problem, not a test result.
        # Say so once and drop the model instead of burning the whole suite on it.
        if ($detail -match "model|EVAL_MODELS") {
          Write-Host "  $m : NOT WIRED UP - $detail" -ForegroundColor Red
          Write-Host "        add it to EVAL_MODELS in supabase/functions/line-webhook/index.ts" -ForegroundColor Yellow
          $dead[$m] = 2
        } else {
          Write-Host "  $m : request failed - $_" -ForegroundColor Red
          if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
          $dead[$m]++
        }
        $rec.error = if ($detail) { $detail } else { "$_" }
        $totals[$m].errors++
        break
      }
      $dead[$m] = 0

      $rec.runs++
      $totals[$m].runs++
      $rec.answers += [string]$res.answer
      $rec.ms += [int]$res.ms
      $totals[$m].ms += [int]$res.ms
      if ($res.model) { $totals[$m].modelId = [string]$res.model }

      # usage is only there once the endpoint reports it back; without it the report
      # still works, it just cannot say what the run cost.
      if ($res.usage) {
        $u = [ordered]@{
          input = [int]$res.usage.input; output = [int]$res.usage.output
          cache_read = [int]$res.usage.cache_read; cache_write = [int]$res.usage.cache_write
        }
        foreach ($k in @("input", "output", "cache_read", "cache_write")) { $totals[$m][$k] += $u[$k] }
        $cost = Get-CallCost -ModelId ([string]$res.model) -Usage $u
        if ($null -eq $cost) { $totals[$m].costKnown = $false } else { $totals[$m].cost += $cost }
      } else {
        $totals[$m].costKnown = $false
      }

      if ($c.manual) { continue }
      $problems = @(Test-AgentCase -Case $c -Response $res)
      $totals[$m].graded++
      $dim = $totals[$m].byDim[[string]$c.dimension]
      if ($dim) { $dim.graded++ }
      if ($problems.Count -eq 0) {
        $rec.passed++; $totals[$m].passed++
        if ($dim) { $dim.passed++ }
      } else { $rec.problems += , $problems }
    }

    $results["$m|$($c.id)"] = $rec
    if ($rec.error) { continue }
    $avgMs = if ($rec.ms.Count) { [int](($rec.ms | Measure-Object -Average).Average) } else { 0 }
    if ($c.manual) {
      $flat = ($rec.answers[0] -replace "`r?`n", ' ')
      if ($flat.Length -gt 110) { $flat = $flat.Substring(0, 110) + '...' }
      Write-Host "  $m : (read yourself, $avgMs ms) $flat" -ForegroundColor DarkGray
    } elseif ($rec.passed -eq $rec.runs) {
      Write-Host "  $m : PASS $($rec.passed)/$($rec.runs)  ($avgMs ms)" -ForegroundColor Green
    } elseif ($rec.passed -gt 0) {
      Write-Host "  $m : FLAKY $($rec.passed)/$($rec.runs)  ($avgMs ms) - $($rec.problems[0][0])" -ForegroundColor Yellow
    } else {
      Write-Host "  $m : FAIL 0/$($rec.runs)  ($avgMs ms) - $($rec.problems[0][0])" -ForegroundColor Red
    }
  }
}

# ---------------------------------------------------------------- report

function Format-Cell {
  param($Rec)
  if (-not $Rec) { return "  -  " }
  if ($Rec.error) { return " ERR " }
  if ($Rec.manual) { return "  ~  " }
  if ($Rec.passed -eq $Rec.runs) { return " PASS" }
  if ($Rec.passed -gt 0) { return " $($Rec.passed)/$($Rec.runs) " }
  return " FAIL"
}

$idWidth = ($cases | ForEach-Object { $_.id.Length } | Measure-Object -Maximum).Maximum
$mWidth = [Math]::Max(6, ($Models | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum)
Write-Host ""
Write-Host ("case".PadRight($idWidth) + "  " + (($Models | ForEach-Object { $_.PadRight($mWidth) }) -join " ")) -ForegroundColor Cyan
foreach ($c in $cases) {
  $row = $c.id.PadRight($idWidth) + "  "
  $row += (($Models | ForEach-Object { (Format-Cell $results["$_|$($c.id)"]).PadRight($mWidth) }) -join " ")
  Write-Host $row
}

function Get-DimScore { param($Total, $Dim)
  $d = $Total.byDim[$Dim]
  if (-not $d -or -not $d.graded) { return "-" }
  return "$($d.passed)/$($d.graded)"
}

Write-Host ""
Write-Host ("{0,-16} {1,-8} {2,-8} {3,-8} {4,-8} {5,-8} {6}" -f `
  "model", "correct", "tools", "silence", "total", "avg ms", "cost/round") -ForegroundColor Cyan
foreach ($m in $Models) {
  $t = $totals[$m]
  $score = if ($t.graded) { "$($t.passed)/$($t.graded)" } else { "-" }
  $avg = if ($t.runs) { [int]($t.ms / $t.runs) } else { 0 }
  $cost = if ($t.costKnown -and $t.cost -gt 0) { '$' + $t.cost.ToString("0.0000") } else { "-" }
  Write-Host ("{0,-16} {1,-8} {2,-8} {3,-8} {4,-8} {5,-8} {6}" -f `
    $m, (Get-DimScore $t "correct"), (Get-DimScore $t "tools"), (Get-DimScore $t "silence"), `
    $score, $avg, $cost)
}
Write-Host "cost/round = what one full pass of these cases costs on that model" -ForegroundColor DarkGray
if (($totals.Values | Where-Object { -not $_.costKnown })) {
  Write-Host "cost '-' = no verified price in tests/prices.json, or the endpoint did not report usage" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- files

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$stamp = [datetime]::Now.ToString("yyyyMMdd-HHmmss", [Globalization.CultureInfo]::InvariantCulture)
$jsonPath = Join-Path $OutDir "compare-$stamp.json"
$mdPath = Join-Path $OutDir "compare-$stamp.md"

@{ ran_at = (Get-Date).ToString("s"); models = $Models; repeat = $Repeat
   cases = $CasesPath; totals = $totals; results = $results } |
  ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8

$md = New-Object Text.StringBuilder
[void]$md.AppendLine("# Model bake-off $stamp")
[void]$md.AppendLine()
[void]$md.AppendLine("| case | " + ($Models -join " | ") + " | why |")
[void]$md.AppendLine("|---|" + (($Models | ForEach-Object { "---|" }) -join "") + "---|")
foreach ($c in $cases) {
  $cells = ($Models | ForEach-Object { (Format-Cell $results["$_|$($c.id)"]).Trim() }) -join " | "
  [void]$md.AppendLine("| $($c.id) [$($c.dimension)] | $cells | $($c.why) |")
}
[void]$md.AppendLine()
[void]$md.AppendLine("| model | correct | tools | silence | total | avg ms | tokens in/out | cost/round |")
[void]$md.AppendLine("|---|---|---|---|---|---|---|---|")
foreach ($m in $Models) {
  $t = $totals[$m]
  $score = if ($t.graded) { "$($t.passed)/$($t.graded)" } else { "-" }
  $avg = if ($t.runs) { [int]($t.ms / $t.runs) } else { 0 }
  $cost = if ($t.costKnown -and $t.cost -gt 0) { '$' + $t.cost.ToString("0.0000") } else { "-" }
  [void]$md.AppendLine("| $m ($($t.modelId)) | $(Get-DimScore $t 'correct') | $(Get-DimScore $t 'tools') | $(Get-DimScore $t 'silence') | $score | $avg | $($t.input)/$($t.output) | $cost |")
}
# Every answer, side by side - the part a person has to read. Tone, length and Thai
# that sounds like a person are the things no regex in assert-case.ps1 can score.
[void]$md.AppendLine()
[void]$md.AppendLine("## Answers side by side")
foreach ($c in $cases) {
  [void]$md.AppendLine()
  [void]$md.AppendLine("### $($c.id)")
  [void]$md.AppendLine()
  [void]$md.AppendLine("> $($c.message)")
  [void]$md.AppendLine()
  [void]$md.AppendLine("_$($c.why)_")
  foreach ($m in $Models) {
    $rec = $results["$m|$($c.id)"]
    [void]$md.AppendLine()
    [void]$md.AppendLine("**$m** - " + (Format-Cell $rec).Trim())
    [void]$md.AppendLine()
    if (-not $rec) { [void]$md.AppendLine("(not run)"); continue }
    if ($rec.error) { [void]$md.AppendLine("(error: $($rec.error))"); continue }
    foreach ($p in $rec.problems) { [void]$md.AppendLine("- FAIL: " + ($p -join "; ")) }
    [void]$md.AppendLine('```')
    [void]$md.AppendLine($rec.answers[0])
    [void]$md.AppendLine('```')
  }
}
Set-Content -Path $mdPath -Value $md.ToString() -Encoding UTF8

Write-Host ""
Write-Host "wrote $mdPath" -ForegroundColor Green
Write-Host "wrote $jsonPath" -ForegroundColor DarkGray
Write-Host "The table decides tools and rules. Read the answers before deciding tone." -ForegroundColor Cyan
