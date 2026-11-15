Add-Type -Namespace W -Name U -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
"@
$target = [uint32]$args[0]
[W.U]::EnumWindows({ param($h,$p) $procId=0; [void][W.U]::GetWindowThreadProcessId($h,[ref]$procId); if ($procId -eq $target) { $sb=New-Object System.Text.StringBuilder 256; [void][W.U]::GetWindowText($h,$sb,256); if ($sb.Length -gt 0) { [Console]::WriteLine($sb.ToString() + " visible=" + [W.U]::IsWindowVisible($h)) } }; $true }, [System.IntPtr]::Zero) | Out-Null
