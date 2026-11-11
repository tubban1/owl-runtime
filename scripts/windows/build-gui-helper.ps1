# Build OWL LAB native GUI helper for x64 Windows. No network/npm/SDK.
# SHA-256 receipt is written next to the binary; unsigned DEV build is NOT a signed release.
[CmdletBinding()]
param(
  [string]$Source = '',
  [string]$Output = ''
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if(-not $Source){$Source=Join-Path $root 'windows-helper\OWLHelper.cs'}
if(-not $Output){$Output=Join-Path $root 'windows-helper\bin\OWLHelper.exe'}
if(-not (Test-Path -LiteralPath $Source -PathType Leaf)){throw 'OWL_GUI_SOURCE_NOT_FOUND'}
$csc="$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if(-not (Test-Path $csc)){throw 'WINDOWS_FRAMEWORK_CSC_NOT_FOUND'}
$dir=Split-Path -Parent $Output
New-Item -ItemType Directory -Force $dir|Out-Null
$gac="$env:WINDIR\Microsoft.NET\assembly\GAC_MSIL"
$assemblyPaths=@()
foreach($n in @('UIAutomationClient','UIAutomationTypes','WindowsBase')){
  $found=Get-ChildItem (Join-Path $gac $n) -Recurse -Filter ($n+'.dll') -File -ErrorAction SilentlyContinue|Select-Object -First 1
  if(-not $found){throw ('WINDOWS_GUI_ASSEMBLY_MISSING '+$n)}
  $assemblyPaths+=('/r:'+ $found.FullName)
}
$argsList=@('/nologo','/optimize+','/platform:x64','/target:exe','/warnaserror+',
  ('/out:'+ $Output),
  '/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll') +
  $assemblyPaths + @($Source)
$stderrOutput=& $csc @argsList 2>&1
if($LASTEXITCODE -ne 0){throw ('WINDOWS_GUI_COMPILE_FAILED '+($stderrOutput|Out-String))}
if(-not(Test-Path $Output)){throw 'WINDOWS_GUI_EXE_MISSING'}
$hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $Output).Hash.ToLowerInvariant()
$receipt=[ordered]@{component='owl-windows-gui-helper';kind='unsigned-dev';
  architecture='win32-x64';sha256=$hash;sourceSha256=(Get-FileHash -Algorithm SHA256 $Source).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText((Join-Path $dir 'component.json'),($receipt|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
Write-Output ('WINDOWS_GUI_COMPILED '+$Output)
Write-Output ('SHA256 '+$hash)
