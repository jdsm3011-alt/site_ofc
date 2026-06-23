$owner = "jdsm3011-alt"
$repo  = "site_ofc"

function Remove-Diacritics {
    param([string]$Text)
    $normalized = $Text.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $normalized.ToCharArray()) {
        $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
        if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($ch)
        }
    }
    return $sb.ToString().Normalize([System.Text.NormalizationForm]::FormC)
}

# Reduz um nome de ficheiro a uma "chave" so com letras e numeros em minusculas,
# ignorando acentos e diferencas entre _ , - , espaco e . (tudo o resto e ignorado)
function Get-ComparisonKey {
    param([string]$FileName)
    $noAccents = Remove-Diacritics $FileName
    $key = $noAccents.ToLower()
    $key = $key -replace '[^a-z0-9]', ''
    return $key
}

$relatorio = @()

Get-ChildItem -Path "data" -Directory | ForEach-Object {
    $distrito = $_.Name
    $slug = Remove-Diacritics $distrito
    $slug = $slug.ToLower()
    $slug = $slug -replace '[^a-z0-9]+', '-'
    $slug = $slug.Trim('-')

    $localFiles = Get-ChildItem -Path $_.FullName -Recurse -File | Where-Object { $_.Extension -in '.zip', '.tif' }

    $releaseInfo = gh release view $slug --repo "$owner/$repo" --json assets 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $releaseInfo) {
        $relatorio += [PSCustomObject]@{ Distrito = $distrito; Local = $localFiles.Count; GitHub = 0; Estado = "RELEASE NAO EXISTE" }
        return
    }

    $remoteAssetNames = ($releaseInfo | ConvertFrom-Json).assets.name
    $remoteKeys = $remoteAssetNames | ForEach-Object { Get-ComparisonKey $_ }

    $emFalta = @()
    foreach ($f in $localFiles) {
        $key = Get-ComparisonKey $f.Name
        if ($remoteKeys -notcontains $key) {
            $emFalta += $f.Name
        }
    }

    $estado = if ($emFalta.Count -eq 0) { "OK" } else { "FALTAM $($emFalta.Count)" }

    $relatorio += [PSCustomObject]@{ Distrito = $distrito; Local = $localFiles.Count; GitHub = $remoteAssetNames.Count; Estado = $estado }

    if ($emFalta.Count -gt 0) {
        Write-Host "Em falta de verdade em $distrito :"
        $emFalta | ForEach-Object { Write-Host "  - $_" }
    }
}

$relatorio | Format-Table -AutoSize
