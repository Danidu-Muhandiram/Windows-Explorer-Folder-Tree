param(
    [int]$ParentPID = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinAPI {

    // Gets the currently focused (active) window in Windows
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    // Gets window position and size
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(
        IntPtr hWnd,
        out RECT rect
    );

    // Checks if window is minimized
    [DllImport("user32.dll")]
    public static extern bool IsIconic(
        IntPtr hWnd
    );

    // Moves and resizes window
    [DllImport("user32.dll")]
    public static extern bool MoveWindow(
        IntPtr hWnd,
        int X,
        int Y,
        int nWidth,
        int nHeight,
        bool bRepaint
    );

    // DWM API to get visible bounds (excluding shadows)
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(
        IntPtr hwnd,
        int dwAttribute,
        out RECT pvAttribute,
        int cbAttribute
    );

    // Gets the class name of the window (Explorer's class name is CabinetWClass)
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(
        IntPtr hWnd,
        System.Text.StringBuilder lpClassName,
        int nMaxCount
    );

    // Win32 APIs for non-blocking stdin checks
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool PeekNamedPipe(
        IntPtr hNamedPipe,
        IntPtr lpBuffer,
        int nBufferSize,
        IntPtr lpBytesRead,
        out int lpTotalBytesAvail,
        IntPtr lpBytesLeftThisMessage
    );

    // Rectangle structure for window bounds
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

# Store previously detected path
# Used to avoid printing duplicate paths
$lastPath = ""

# Store previous full explorer state
# Used to avoid duplicate JSON output
$lastState = ""

# Store last active Explorer handle
# Helps detect minimize reliably
$lastExplorerHandle = 0

# Store docked Explorer handle
# Prevents repeated shrinking
$dockedExplorerHandle = 0

# Fixed sidebar width
$sidebarWidth = 320

# Store original Explorer bounds
# Used to restore size later
$originalExplorerBounds = @{}

# Infinite loop
# Keeps watching File Explorer forever
while ($true) {

    try {
        # Check if parent process (Electron) has exited
        if ($ParentPID -ne 0) {
            $parentProcess = Get-Process -Id $ParentPID -ErrorAction SilentlyContinue
            if ($parentProcess -eq $null -or $parentProcess.HasExited) {
                break
            }
        }

        # Check standard input for exit command from Electron (non-blocking)
        $hStdin = [WinAPI]::GetStdHandle(-10) # STD_INPUT_HANDLE
        $bytesAvail = 0
        $res = [WinAPI]::PeekNamedPipe($hStdin, [IntPtr]::Zero, 0, [IntPtr]::Zero, [ref]$bytesAvail, [IntPtr]::Zero)
        if ($res -and $bytesAvail -gt 0) {
            $line = [System.Console]::In.ReadLine()
            if ($line -eq "exit") {
                break
            }
        }

        # Get the currently active (foreground) window handle
        $foregroundWindow = [WinAPI]::GetForegroundWindow()
        $foregroundHandle = $foregroundWindow.ToInt64()

        # Fast check of window class name
        $className = New-Object System.Text.StringBuilder 256
        [WinAPI]::GetClassName($foregroundWindow, $className, 256) | Out-Null
        $isExplorerActive = ($className.ToString() -eq "CabinetWClass")

        # Optimization: If foreground is not Explorer and we have no tracked Explorer window, sleep and skip COM
        if (-not $isExplorerActive -and $lastExplorerHandle -eq 0) {
            Start-Sleep -Milliseconds 50
            continue
        }

        # Create Windows Explorer COM object
        # Allows PowerShell to communicate with File Explorer
        $shell = New-Object -ComObject Shell.Application
        $windows = $shell.Windows()

        # Prioritize finding the active Explorer window first
        $targetWindow = $null
        if ($isExplorerActive) {
            foreach ($window in $windows) {
                if ($window.HWND -eq $foregroundHandle) {
                    $targetWindow = $window
                    break
                }
            }
        }

        # Fallback to the last tracked window if active window isn't Explorer or isn't found
        if ($targetWindow -eq $null -and $lastExplorerHandle -ne 0) {
            foreach ($window in $windows) {
                if ($window.HWND -eq $lastExplorerHandle) {
                    $targetWindow = $window
                    break
                }
            }
        }

        # Process the target window if found
        if ($targetWindow -ne $null) {
            
            $foundTracked = $true

            # Get folder path from Explorer window
            $path = $targetWindow.Document.Folder.Self.Path

            # If path exists
            if ($path) {

                # Save current Explorer handle
                $lastExplorerHandle = $targetWindow.HWND

                # Get DWM frame bounds (visible bounds of the window)
                $rect = New-Object WinAPI+RECT
                $dwmRect = New-Object WinAPI+RECT
                $res = [WinAPI]::DwmGetWindowAttribute([IntPtr]$targetWindow.HWND, 9, [ref]$dwmRect, 16)
                if ($res -eq 0) {
                    $rect = $dwmRect
                } else {
                    [WinAPI]::GetWindowRect([IntPtr]$targetWindow.HWND, [ref]$rect) | Out-Null
                }

                # Get outer window boundaries for resizing and height tracking
                $outerRect = New-Object WinAPI+RECT
                [WinAPI]::GetWindowRect([IntPtr]$targetWindow.HWND, [ref]$outerRect) | Out-Null
                $outerWidth = $outerRect.Right - $outerRect.Left
                $outerHeight = $outerRect.Bottom - $outerRect.Top

                # Dock Explorer only once
                if ($targetWindow.HWND -ne $dockedExplorerHandle) {

                    # Shrink Explorer width
                    $newWidth = $outerWidth - $sidebarWidth

                    # Prevent very small sizes
                    if ($newWidth -gt 500) {

                        # Resize Explorer window using outer bounds
                        [WinAPI]::MoveWindow(
                            [IntPtr]$targetWindow.HWND,
                            $outerRect.Left,
                            $outerRect.Top,
                            $newWidth,
                            $outerHeight,
                            $true
                        ) | Out-Null

                        # Save docked Explorer handle
                        $dockedExplorerHandle = $targetWindow.HWND

                        # Refresh visible window bounds after resize
                        $res = [WinAPI]::DwmGetWindowAttribute([IntPtr]$targetWindow.HWND, 9, [ref]$dwmRect, 16)
                        if ($res -eq 0) {
                            $rect = $dwmRect
                        } else {
                            [WinAPI]::GetWindowRect([IntPtr]$targetWindow.HWND, [ref]$rect) | Out-Null
                        }
                    }
                }

                # Save original Explorer size (outer size)
                # Used when restoring later
                if (-not $originalExplorerBounds.ContainsKey($targetWindow.HWND)) {

                    $originalExplorerBounds[$targetWindow.HWND] = @{
                        x = $outerRect.Left
                        y = $outerRect.Top
                        width = $outerWidth
                        height = $outerHeight
                    }
                }

                # Calculate Explorer visible width
                $width = $rect.Right - $rect.Left
                
                # Height uses outer height to align with bottom edge of Explorer
                $height = $outerHeight

                # Check if Explorer is minimized
                $isMinimized = [WinAPI]::IsIconic([IntPtr]$targetWindow.HWND)

                # Check if Explorer is the active foreground window
                $isActive = ($targetWindow.HWND -eq $foregroundHandle)

                # Create Explorer state object
                $state = @{
                    hwnd = $targetWindow.HWND
                    path = $path
                    x = $rect.Left
                    y = $rect.Top
                    width = $width
                    height = $height
                    minimized = $isMinimized
                    isActive = $isActive
                }

                # Convert object into JSON string
                $json = $state | ConvertTo-Json -Compress

                # Only print if data changed
                if ($json -ne $lastState) {

                    # Send JSON output to Electron
                    Write-Output $json

                    # Save current JSON as last state
                    $lastState = $json
                }
            }
        } else {
            # If our tracked Explorer window was closed
            if ($lastExplorerHandle -ne 0) {
                $state = @{
                    hwnd = $lastExplorerHandle
                    closed = $true
                }
                $json = $state | ConvertTo-Json -Compress
                if ($json -ne $lastState) {
                    Write-Output $json
                    $lastState = $json
                }
                $lastExplorerHandle = 0
                $dockedExplorerHandle = 0
            }
        }

        # Clean up COM objects at end of iteration
        if ($windows) {
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($windows) | Out-Null
        }
        if ($shell) {
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
        }

    } catch {}

    # Wait 50 milliseconds
    # Extremely responsive polling with low CPU footprint (due to fast CabinetWClass check)
    Start-Sleep -Milliseconds 50
}

# Restore Explorer windows
# Runs when script exits cleanly
foreach ($hwnd in $originalExplorerBounds.Keys) {

    try {
        $bounds = $originalExplorerBounds[$hwnd]

        # Restore Explorer original size (outer bounds)
        [WinAPI]::MoveWindow(
            [IntPtr]$hwnd,
            $bounds.x,
            $bounds.y,
            $bounds.width,
            $bounds.height,
            $true
        ) | Out-Null

    } catch {}
}