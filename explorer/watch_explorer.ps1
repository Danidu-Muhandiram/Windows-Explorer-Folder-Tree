# Store previously detected path
# Used to avoid printing duplicate paths
$lastPath = ""

# Infinite loop
# Keeps watching File Explorer forever
while ($true) {

    try {

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
                # Get folder path from Explorer window
                $path = $window.Document.Folder.Self.Path

                # If path exists
                if ($path) {
                    # Save current folder path
                    $activePath = $path
                    # Stop loop after first valid path
                    break
                }

            } catch {}
        }

        # Only print if:
        # 1. path exists
        # 2. path changed from previous one
        if ($activePath -and $activePath -ne $lastPath) {


            # Send path output to Electron
            # Electron reads this via stdout
            Write-Output $activePath
            # Save current path as last path
            $lastPath = $activePath
        }

    } catch {}

    # Wait 500 milliseconds (0.5 seconds)
    # Prevents CPU overuse
    Start-Sleep -Milliseconds 500
}