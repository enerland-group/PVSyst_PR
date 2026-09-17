# =============================================================================
#  Crea la App Registration (SPA) que usa PR-EPI_Controller para obtener el
#  token de OneLake via MSAL (renovacion silenciosa, permanente).
#
#  REQUIERE un usuario con permiso para REGISTRAR APLICACIONES en Entra:
#    Global Admin  /  Application Administrator  /  Cloud Application Admin
#    (o rol 'Application Developer' asignado al usuario).
#  El paso de consentimiento (admin-consent) requiere ademas Global Admin o
#  Privileged Role Administrator.
#
#  Ejecutar una sola vez:
#    az login              # con la cuenta con privilegios, tenant Enerland
#    ! powershell -ExecutionPolicy Bypass -File <ruta>\setup-entra-app.ps1
# =============================================================================
$ErrorActionPreference = "Stop"

$TENANT = "943fa85b-068d-404a-bacb-5f0baf8d31a8"                     # Enerland
$REDIRECTS = @(
  "https://fond-spur-b4c329ed90-westeurope.webapp.fabricapps.net",  # app desplegada (rayfin static hosting)
  "http://localhost:5173"                                           # dev (vite)
)
$STORAGE_APP    = "e406a681-f3d4-42a8-90b6-c2b029497af1"            # Azure Storage (first-party)
$USER_IMP_SCOPE = "03e0da56-190b-40ad-a80c-ea378c433f7f"           # user_impersonation (delegado)

Write-Host "1) Creando App Registration 'PR-EPI Controller'..."
$app = az ad app create --display-name "PR-EPI Controller" --sign-in-audience AzureADMyOrg | ConvertFrom-Json
$appId = $app.appId
$objId = $app.id
if (-not $appId) { throw "No se pudo crear la app (privilegios insuficientes para registrar aplicaciones)." }
Write-Host "   appId = $appId"

Write-Host "2) Registrando redirect URIs como plataforma SPA..."
$tmp = Join-Path $env:TEMP "spa-redirects.json"
(@{ spa = @{ redirectUris = $REDIRECTS } } | ConvertTo-Json -Compress -Depth 5) | Out-File -FilePath $tmp -Encoding ascii
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$objId" --headers "Content-Type=application/json" --body "@$tmp"
Remove-Item $tmp -ErrorAction SilentlyContinue

Write-Host "3) Anadiendo permiso delegado Azure Storage / user_impersonation..."
az ad app permission add --id $appId --api $STORAGE_APP --api-permissions "$USER_IMP_SCOPE=Scope"

Write-Host "4) Creando service principal..."
az ad sp create --id $appId | Out-Null
Start-Sleep -Seconds 5

Write-Host "5) Consentimiento de administrador del permiso..."
az ad app permission admin-consent --id $appId

$out = Join-Path $PSScriptRoot ".entra_appid.txt"
$appId | Out-File -FilePath $out -Encoding ascii -NoNewline
Write-Host ""
Write-Host "==================================================================="
Write-Host " LISTO. VITE_ENTRA_CLIENT_ID = $appId"
Write-Host " (guardado en $out)"
Write-Host "==================================================================="
