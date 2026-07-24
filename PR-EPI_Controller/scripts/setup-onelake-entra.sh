#!/usr/bin/env bash
#-----------------------------------------------------------------------
# Crea la App Registration (SPA) que usa la app PR-EPI para pedir tokens de
# OneLake vía MSAL (login una vez → renovación silenciosa; no se regenera a mano).
#
# Requisitos: `az login` hecho (ya lo tienes) + permiso para registrar apps en Entra.
# Ejecutar con git-bash:  bash scripts/setup-onelake-entra.sh
#-----------------------------------------------------------------------
set -euo pipefail

APP_NAME="PR-EPI-OneLake"
STORAGE_APP="e406a681-f3d4-42a8-90b6-c2b029497af1"      # Azure Storage (recurso)
STORAGE_SCOPE="03e0da56-190b-40ad-a80c-ea378c433f7f"    # user_impersonation (delegado)

# Redirect URIs SPA. SIN barra final (deben coincidir con window.location.origin).
# Añade aquí la URL de producción de la app en Fabric cuando la sepas.
REDIRECTS='["http://localhost:5173","http://localhost:5174"]'

echo "→ Creando app registration '$APP_NAME'…"
APP_ID=$(az ad app create \
  --display-name "$APP_NAME" \
  --sign-in-audience AzureADMyOrg \
  --required-resource-accesses "[{\"resourceAppId\":\"$STORAGE_APP\",\"resourceAccess\":[{\"id\":\"$STORAGE_SCOPE\",\"type\":\"Scope\"}]}]" \
  --query appId -o tsv)

OBJ_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)

echo "→ Marcando plataforma como SPA con redirect URIs…"
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$OBJ_ID" \
  --headers "Content-Type=application/json" \
  --body "{\"spa\":{\"redirectUris\":$REDIRECTS}}"

echo "→ Creando service principal…"
az ad sp create --id "$APP_ID" >/dev/null

echo "→ Consintiendo el permiso de Azure Storage (puede requerir rol de admin)…"
az ad app permission admin-consent --id "$APP_ID" \
  || echo "!! admin-consent falló → pídeselo a un admin de Entra (Azure Storage / user_impersonation)."

echo ""
echo "================================================================"
echo "LISTO. appId = $APP_ID"
echo "Añade a PR-EPI_Controller/.env.development.local (y a la config de prod):"
echo "    VITE_ENTRA_CLIENT_ID=$APP_ID"
echo "Y BORRA la línea VITE_FABRIC_TOKEN= (el token manual ya no hace falta)."
echo "================================================================"
