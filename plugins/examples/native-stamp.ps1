$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine() | ConvertFrom-Json
if ($request.kind -ne 'invoke' -or $request.command -ne 'stamp') { throw 'Unknown command' }
$call = @{
    kind = 'call'; id = 1; method = 'board.apply'
    args = @{
        create = @(@{ kind = 'sticky'; x = 200; y = 180; width = 300; height = 160; text = [string]$request.args.text; fill = '#d5edff' })
        label = 'Native stamp'
    }
}
[Console]::WriteLine(($call | ConvertTo-Json -Compress -Depth 8))
$reply = [Console]::ReadLine() | ConvertFrom-Json
if ($reply.error) {
    [Console]::WriteLine((@{kind = 'error'; error = [string]$reply.error} | ConvertTo-Json -Compress))
} else {
    [Console]::WriteLine((@{kind = 'result'; result = @{created = $true}} | ConvertTo-Json -Compress -Depth 4))
}
