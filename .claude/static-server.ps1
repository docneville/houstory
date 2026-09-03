param(
    [int]$Port = 8080,
    [string]$Root = (Get-Location).Path
)

Add-Type -AssemblyName System.Net.HttpListener -ErrorAction SilentlyContinue

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $Root at http://localhost:$Port/"

$mimeTypes = @{
    ".html" = "text/html"; ".htm" = "text/html"; ".css" = "text/css"
    ".js" = "application/javascript"; ".json" = "application/json"
    ".png" = "image/png"; ".jpg" = "image/jpeg"; ".jpeg" = "image/jpeg"
    ".gif" = "image/gif"; ".svg" = "image/svg+xml"; ".ico" = "image/x-icon"
    ".txt" = "text/plain"; ".woff" = "font/woff"; ".woff2" = "font/woff2"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        try {
            $path = [Uri]::UnescapeDataString($request.Url.AbsolutePath)
            if ($path -eq "/") { $path = "/index.html" }
            $filePath = Join-Path $Root ($path.TrimStart("/"))
            $fullRoot = (Resolve-Path $Root).Path
            if ((Test-Path $filePath) -and ((Resolve-Path $filePath).Path.StartsWith($fullRoot))) {
                $ext = [IO.Path]::GetExtension($filePath)
                $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
                $bytes = [IO.File]::ReadAllBytes($filePath)
                $response.ContentType = $contentType
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $response.StatusCode = 404
                $notFoundBytes = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
                $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
            }
        } catch {
            $response.StatusCode = 500
        } finally {
            $response.OutputStream.Close()
        }
    }
} finally {
    $listener.Stop()
}
