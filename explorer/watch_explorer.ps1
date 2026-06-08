Add-Type @"
using System;
using System.Runtime.InteropServices;

public class WinAPI {

    //Gets the currently focused (active) window in Windows
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    //Gets window position and size
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(
        IntPtr hWnd,
        out RECT rect
    );

    //Rectangle structure for window bounds
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

# Infinite loop
# Keeps watching File Explorer forever
while ($true) {

    try {

        # Get the currently active (foreground) window handle
        $foregroundWindow = [WinAPI]::GetForegroundWindow()
        $foregroundHandle = $foregroundWindow.ToInt64()

        # Create Windows Explorer COM object
        # Allows PowerShell to communicate with File Explorer
        $shell = New-Object -ComObject Shell.Application

        # Get all open Explorer windows
        $windows = $shell.Windows()

        # Variable to hold current active folder path
        $activePath = $null

        # Loop through all Explorer windows
        foreach ($window in $windows) {

            try {

                # Compare Explorer window handle with active window handle
                # This ensures we only track the ACTIVE File Explorer window
                if ($window.HWND -eq $foregroundHandle) {

                    # Get folder path from Explorer window
                    $path = $window.Document.Folder.Self.Path

                    # If path exists
                    if ($path) {

                        # Save current folder path
                        $activePath = $path

                        # Create rectangle object
                        # Used to get Explorer window position and size
                        $rect = New-Object WinAPI+RECT

                        # Get current Explorer window bounds
                        [WinAPI]::GetWindowRect(
                            $foregroundWindow,
                            [ref]$rect
                        ) | Out-Null

                        # Calculate Explorer width
                        $width = $rect.Right - $rect.Left

                        # Calculate Explorer height
                        $height = $rect.Bottom - $rect.Top

                        # Create Explorer state object
                        # Contains path + window position + size
                        $state = @{
                            hwnd = $foregroundHandle
                            path = $activePath
                            x = $rect.Left
                            y = $rect.Top
                            width = $width
                            height = $height
                        }

                        # Convert object into JSON string
                        # Easier for Electron to read
                        $json = $state | ConvertTo-Json -Compress

                        # Only print if:
                        # 1. data changed
                        # 2. prevents duplicate updates
                        if ($json -ne $lastState) {

                            # Send JSON output to Electron
                            # Electron reads this via stdout
                            Write-Output $json

                            # Save current JSON as last state
                            $lastState = $json
                        }

                        # Stop loop after finding active Explorer window
                        break
                    }
                }

            } catch {}
        }

    } catch {}

    # Wait 300 milliseconds
    # Prevents CPU overuse while staying responsive
    Start-Sleep -Milliseconds 300
}