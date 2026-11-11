# Windows native UIA smoke. Does NOT send pointer/keyboard input to user's apps.
[CmdletBinding()]
param([string]$Helper='')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if(-not $Helper){$Helper=Join-Path $root 'windows-helper\bin\OWLHelper.exe'}
if(-not (Test-Path $Helper -PathType Leaf)){throw 'WINDOWS_GUI_HELPER_NOT_FOUND'}
$receipt=Join-Path (Split-Path $Helper -Parent) 'component.json'
if(-not (Test-Path $receipt)){throw 'WINDOWS_GUI_HELPER_RECEIPT_MISSING'}
$manifest=Get-Content $receipt -Raw|ConvertFrom-Json
$hash=(Get-FileHash $Helper -Algorithm SHA256).Hash.ToLowerInvariant()
if($manifest.sha256 -cne $hash){throw 'WINDOWS_GUI_HELPER_HASH_MISMATCH'}
$oldRead=$env:OWL_WIN_GUI_READ_GRANTED
$oldInput=$env:OWL_WIN_GUI_INPUT_GRANTED
$oldForeground=$env:OWL_WIN_GUI_FOREGROUND_GRANTED
try{
  $env:OWL_WIN_GUI_READ_GRANTED='false'
  $env:OWL_WIN_GUI_INPUT_GRANTED='false'
  $env:OWL_WIN_GUI_FOREGROUND_GRANTED='false'
  $denied=('{"action":"status"}'|& $Helper --request-stdin|ConvertFrom-Json)
  if($denied.ok -ne $false -or $denied.code -cne 'WINDOWS_GUI_NOT_AUTHORIZED'){throw 'GUI_READ_DENY_FAILED'}
  $env:OWL_WIN_GUI_READ_GRANTED='true'
  $status=('{"action":"status"}'|& $Helper --request-stdin|ConvertFrom-Json)
  if($status.ok -ne $true -or $status.result.backend -cne 'win32-uia'){throw 'GUI_STATUS_FAILED'}
  $inputDenied=('{"action":"click_element","query":"not-a-real-control"}'|& $Helper --request-stdin|ConvertFrom-Json)
  if($inputDenied.ok -ne $false -or $inputDenied.code -cne 'WINDOWS_GUI_INPUT_NOT_AUTHORIZED'){throw 'GUI_INPUT_DENY_FAILED'}
  $env:OWL_WIN_GUI_INPUT_GRANTED='true'
  $keyDenied=('{"action":"key","key":"a"}'|& $Helper --request-stdin|ConvertFrom-Json)
  if($keyDenied.ok -ne $false -or $keyDenied.code -cne 'WINDOWS_GUI_FOREGROUND_TAKEOVER_REQUIRED'){throw 'GUI_FOREGROUND_DENY_FAILED'}
  # Opens a disposable test-only UIA window outside the visible screen. Does
  # not send real SendInput; reports separately if Windows changes focus.
  $self=(& $Helper --selftest|ConvertFrom-Json)
  if(-not $self.ok -or -not $self.semanticInvoke -or -not $self.semanticSetValue -or $self.foregroundInputExercised){throw 'GUI_SELFTEST_FAILED'}
  [ordered]@{status='passed';hash=$hash;readDenied=$true;
    semanticDeniedByDefault=$true;foregroundDeniedByDefault=$true;
    semanticInvoke=$true;semanticSetValue=$true;
    focusPreserved=$self.focusPreserved;foregroundInputExercised=$false} |
    ConvertTo-Json -Compress
}finally{
  $env:OWL_WIN_GUI_READ_GRANTED=$oldRead
  $env:OWL_WIN_GUI_INPUT_GRANTED=$oldInput
  $env:OWL_WIN_GUI_FOREGROUND_GRANTED=$oldForeground
}
