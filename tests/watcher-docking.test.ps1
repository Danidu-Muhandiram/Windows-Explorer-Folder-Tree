$ErrorActionPreference = 'Stop'
$watcherPath = Join-Path $PSScriptRoot '../explorer/watch_explorer.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $watcherPath), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }

# Execute the actual docking branch against a fake WinAPI; never move desktop windows.
$dockBranch = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Clauses[0].Item1.Extent.Text -eq '-not $originalExplorerBounds.ContainsKey($targetWindow.HWND)'
}, $true)
if (-not $dockBranch) { throw 'Docking branch not found' }
$dock = [scriptblock]::Create($dockBranch.Extent.Text)

Add-Type @'
using System;
using System.Collections.Generic;
public class WinAPI {
    public struct RECT { public int Left, Top, Right, Bottom; }
    public static Dictionary<long, int> Widths = new Dictionary<long, int>();
    public static int Moves = 0;
    public static bool Fail = false;
    public static bool MoveWindow(IntPtr hwnd, int x, int y, int width, int height, bool repaint) {
        if (Fail) return false;
        Widths[hwnd.ToInt64()] = width;
        Moves++;
        return true;
    }
    public static int DwmGetWindowAttribute(IntPtr hwnd, int attr, ref RECT rect, int size) { return -1; }
    public static bool GetWindowRect(IntPtr hwnd, ref RECT rect) {
        rect.Right = Widths[hwnd.ToInt64()]; rect.Bottom = 700; return true;
    }
}
'@
$originalExplorerBounds = @{}
$sidebarWidth = 320
foreach ($handle in @(1, 2, 1, 2, 1)) {
    if (-not [WinAPI]::Widths.ContainsKey($handle)) { [WinAPI]::Widths[$handle] = 1400 }
    $targetWindow = [pscustomobject]@{ HWND = $handle }
    $outerRect = New-Object WinAPI+RECT
    $rect = New-Object WinAPI+RECT
    $dwmRect = New-Object WinAPI+RECT
    $outerWidth = [WinAPI]::Widths[$handle]
    $outerHeight = 700
    . $dock
}
if ([WinAPI]::Moves -ne 2) { throw 'Revisited window was docked again' }
foreach ($handle in @(1, 2)) {
    if ([WinAPI]::Widths[$handle] -ne 1080) { throw 'Incorrect docked width' }
    if ($originalExplorerBounds[$handle].width -ne 1400) { throw 'Original bounds overwritten' }
}

# Crossing from 100% to 150% reserves only the extra 160 physical pixels.
$targetWindow = [pscustomobject]@{ HWND = 1 }
$outerWidth = [WinAPI]::Widths[1]
$sidebarWidth = 480
. $dock
if ([WinAPI]::Widths[1] -ne 920) { throw 'DPI change reserved incorrect space' }
$outerWidth = [WinAPI]::Widths[1]
. $dock
if ([WinAPI]::Widths[1] -ne 920) { throw 'Repeated DPI update shrank window again' }
$sidebarWidth = 320
. $dock
if ([WinAPI]::Widths[1] -ne 1080) { throw 'Returning to original DPI failed' }
if ($originalExplorerBounds[1].width -ne 1400) { throw 'DPI update overwrote original bounds' }

# Narrow windows and failed native calls must not be marked as successfully docked.
$targetWindow = [pscustomobject]@{ HWND = 3 }
[WinAPI]::Widths[3] = 800
$outerWidth = 800
. $dock
if ($originalExplorerBounds.ContainsKey(3)) { throw 'Narrow window marked as docked' }
$outerWidth = 1400
[WinAPI]::Fail = $true
. $dock
if ($originalExplorerBounds.ContainsKey(3)) { throw 'Failed resize marked as docked' }
'Docking regressions passed'
