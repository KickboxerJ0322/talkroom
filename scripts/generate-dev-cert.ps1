param(
  [string]$IpAddress
)

$ErrorActionPreference = "Stop"

$certDir = Join-Path $PSScriptRoot "..\certs"
$certDir = [System.IO.Path]::GetFullPath($certDir)
$pfxPath = Join-Path $certDir "localhost-dev.pfx"
$cerPath = Join-Path $certDir "localhost-dev.cer"
$password = "changeit"

if (-not $IpAddress) {
  $IpAddress = (
    ipconfig |
    Select-String "IPv4 Address|IPv4 アドレス" |
    ForEach-Object {
      if ($_ -match "(\d{1,3}(\.\d{1,3}){3})") {
        $matches[1]
      }
    } |
    Where-Object { $_ -and $_ -notlike "127.*" } |
    Select-Object -First 1
  )
}

if (-not $IpAddress) {
  throw "Could not detect an IPv4 address automatically. Please pass -IpAddress."
}

New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$hashAlgorithm = [System.Security.Cryptography.HashAlgorithmName]::SHA256
$padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
$subject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new("CN=localhost-dev")
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new($subject, $rsa, $hashAlgorithm, $padding)

$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $false)
)
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment,
    $false
  )
)
$request.CertificateExtensions.Add(
  [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($request.PublicKey, $false)
)

$sanBuilder = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$sanBuilder.AddDnsName("localhost")
$sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
$sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse($IpAddress))
$request.CertificateExtensions.Add($sanBuilder.Build())

$notBefore = [System.DateTimeOffset]::UtcNow.AddDays(-1)
$notAfter = $notBefore.AddYears(2)
$certificate = $request.CreateSelfSigned($notBefore, $notAfter)

$pfxBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
$cerBytes = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)

[System.IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
[System.IO.File]::WriteAllBytes($cerPath, $cerBytes)

$rsa.Dispose()
$certificate.Dispose()

Write-Host "Generated:"
Write-Host "  $pfxPath"
Write-Host "  $cerPath"
Write-Host "  IP Address: $IpAddress"
Write-Host ""
Write-Host "Start HTTPS server with:"
Write-Host "  npm run start:https"
