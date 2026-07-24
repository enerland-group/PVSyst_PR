//-----------------------------------------------------------------------
// Token de OneLake (Entra, scope storage) para descargar el Excel de trazabilidad.
//
// PERMANENTE vía MSAL: el usuario hace login UNA vez (popup) y MSAL renueva el
// token en silencio con el refresh token (semanas, auto-renovado). No hay que
// regenerar nada a mano. El token de Rayfin NO sirve para OneLake.
//
// Requisitos (una sola vez, en Entra ID):
//   · App registration tipo SPA con redirect = origen de la app (dev + prod).
//   · Permiso delegado  Azure Storage / user_impersonation.
//   · VITE_ENTRA_CLIENT_ID = appId de esa registration (NO es secreto → va en env).
//
// Override para pruebas rápidas: si VITE_FABRIC_TOKEN está definido se usa tal
// cual y se salta MSAL (token manual de `az`, caduca ~1h).
//-----------------------------------------------------------------------

import {
    PublicClientApplication,
    InteractionRequiredAuthError,
    type AccountInfo,
} from "@azure/msal-browser";

// OneLake acepta bearers de Entra con audiencia storage.azure.com.
const STORAGE_SCOPES = ["https://storage.azure.com/user_impersonation"];

let msalInstance: PublicClientApplication | null = null;
let initPromise: Promise<PublicClientApplication> | null = null;

/** Crea (una vez) e inicializa el cliente MSAL. */
async function getMsal(): Promise<PublicClientApplication> {
    if (msalInstance) return msalInstance;
    if (!initPromise) {
        const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID;
        const tenantId = import.meta.env.VITE_FABRIC_TENANT_ID;
        if (!clientId) {
            throw new Error(
                "Falta VITE_ENTRA_CLIENT_ID: el appId de la App Registration (SPA) con permiso " +
                "Azure Storage/user_impersonation. Sin él MSAL no puede pedir el token de OneLake.",
            );
        }
        const pca = new PublicClientApplication({
            auth: {
                clientId,
                authority: `https://login.microsoftonline.com/${tenantId ?? "organizations"}`,
                redirectUri: window.location.origin,
            },
            // localStorage → el refresh token sobrevive recargas: silencioso "para siempre".
            cache: { cacheLocation: "localStorage" },
        });
        initPromise = pca.initialize().then(() => (msalInstance = pca));
    }
    return initPromise;
}

/**
 * Devuelve un bearer de Entra válido para OneLake (scope storage).
 * Silencioso salvo el primer login, que abre un popup una vez por navegador.
 */
export async function getFabricToken(): Promise<string> {
    // Atajo de dev: token manual pegado en .env (caduca ~1h). Útil sin app registration.
    const manual = import.meta.env.VITE_FABRIC_TOKEN;
    if (manual) return manual;

    const msal = await getMsal();
    let account: AccountInfo | undefined = msal.getActiveAccount() ?? msal.getAllAccounts()[0];

    // Primer uso en este navegador: login interactivo (una sola vez).
    if (!account) {
        const login = await msal.loginPopup({ scopes: STORAGE_SCOPES });
        account = login.account ?? undefined;
        if (account) msal.setActiveAccount(account);
    }

    try {
        const r = await msal.acquireTokenSilent({ scopes: STORAGE_SCOPES, account });
        return r.accessToken;
    } catch (err) {
        // El silencioso caducó/necesita consentimiento → un popup y a seguir.
        if (err instanceof InteractionRequiredAuthError) {
            const r = await msal.acquireTokenPopup({ scopes: STORAGE_SCOPES });
            return r.accessToken;
        }
        throw err;
    }
}
