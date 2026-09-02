# Shared pass/fail rules for the agent test suites.
# run-eval.ps1 (regression gate) and run-compare.ps1 (model bake-off) both dot-source this,
# so a model comparison is scored by exactly the same rules as the gate that guards main.
# Script text is ASCII on purpose: PowerShell 5.1 reads .ps1 as ANSI and would mangle Thai.
# Test content (questions, expectations) lives in the cases*.json files, read as UTF-8.

# Returns the list of reasons this case failed. Empty list = passed.
function Test-AgentCase {
  param(
    [Parameter(Mandatory = $true)]$Case,
    [Parameter(Mandatory = $true)]$Response
  )

  $problems = @()
  $answer = [string]$Response.answer
  $tools = @($Response.tools_called)

  foreach ($t in @($Case.expect_tools)) {
    if ($t -and $tools -notcontains $t) {
      $problems += "missing tool '$t' (called: $($tools -join ', '))"
    }
  }
  if ($Case.expect_tools_any) {
    $hit = @($Case.expect_tools_any | Where-Object { $tools -contains $_ })
    if ($hit.Count -eq 0) {
      $problems += "no data-checking tool called (called: $($tools -join ', '))"
    }
  }
  foreach ($t in @($Case.forbid_tools)) {
    if ($t -and $tools -contains $t) { $problems += "forbidden tool '$t' was called" }
  }
  if ($Case.expect_answer_matches -and $answer -notmatch $Case.expect_answer_matches) {
    $problems += "answer does not match /$($Case.expect_answer_matches)/"
  }
  if ($Case.forbid_answer_matches -and $answer -match $Case.forbid_answer_matches) {
    $problems += "answer contains forbidden /$($Case.forbid_answer_matches)/"
  }
  if ($Case.min_answer_length -and $answer.Length -lt $Case.min_answer_length) {
    $problems += "answer too short ($($answer.Length) chars)"
  }

  return $problems
}
