r"""Lanza pipelines de Fabric vía la Job Scheduler REST API (sin Power Automate).

Usa la MISMA app de Azure AD que el resto (PVSyst1_EPI) con client_credentials,
pero pide un token con scope de Fabric (https://api.fabric.microsoft.com/.default)
en lugar del de Graph.

Función pública:
    lanzar_pipeline_pr(cfg, plant_codes, period_start="", period_end="", extra=None)
        POST a /workspaces/{ws}/items/{pipeline}/jobs/instances?jobType=Pipeline
        con executionData.parameters = {plant_codes, period_start, period_end, ...}.
        Devuelve la URL de la instancia de job (header Location) o None si falló.

PREREQUISITO (una vez):
    - El tenant debe permitir "Service principals can use Fabric APIs"
      (Admin portal de Power BI/Fabric → Developer settings).
    - El service principal PVSyst1_EPI debe tener acceso al workspace de Fabric
      con rol Contributor o Member (Manage access → Add people → la app).
    Sin esto la API responde 401/403.

Config (config.yaml):
    fabric:
      workspace_id:   "0c4c3bbe-a6ae-404f-b1b7-7052bacfea11"
      pr_pipeline_id: "f5bca0f3-f3dc-4af0-99bc-dfe910667024"   # PR_calculation
    # client_id / tenant_id / secret_env_var se reutilizan de la sección graph.
"""
from __future__ import annotations

import os
import time
import logging

import requests

logger = logging.getLogger(__name__)

FABRIC_BASE = "https://api.fabric.microsoft.com/v1"
FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default"
TIMEOUT = 60

# Defaults de credenciales (mismos que sharepoint.py / Fabric).
_DEF_CLIENT_ID = "58f369e5-0dfd-4435-802b-a90a6786bf22"
_DEF_TENANT_ID = "943fa85b-068d-404a-bacb-5f0baf8d31a8"
_DEF_SECRET_VAR = "PVSYST1_EPI_SECRET"


def _conf(cfg: dict) -> dict:
    """Mezcla credenciales (sección graph) con ids de Fabric (sección fabric)."""
    g = cfg.get("graph", {}) or {}
    fb = cfg.get("fabric", {}) or {}
    return {
        "client_id":      g.get("client_id", _DEF_CLIENT_ID),
        "tenant_id":      g.get("tenant_id", _DEF_TENANT_ID),
        "secret_env_var": g.get("secret_env_var", _DEF_SECRET_VAR),
        "workspace_id":   fb.get("workspace_id"),
        "pr_pipeline_id": fb.get("pr_pipeline_id"),
    }


def _get_secret(c: dict) -> str:
    secret = os.environ.get(c["secret_env_var"], "").strip()
    if not secret:
        raise RuntimeError(
            f"Variable de entorno '{c['secret_env_var']}' no definida o vacía. "
            f"Defínela con `setx {c['secret_env_var']} <client_secret> /M` y reinicia la consola."
        )
    return secret


def _get_fabric_token(c: dict) -> str:
    r = requests.post(
        f"https://login.microsoftonline.com/{c['tenant_id']}/oauth2/v2.0/token",
        data={
            "client_id": c["client_id"],
            "scope": FABRIC_SCOPE,
            "client_secret": _get_secret(c),
            "grant_type": "client_credentials",
        },
        timeout=TIMEOUT,
    )
    if not r.ok:
        raise RuntimeError(f"OAuth Fabric fallo {r.status_code}: {r.text[:300]}")
    return r.json()["access_token"]


def _retry(fn, attempts: int = 3, base_delay: int = 2):
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except (requests.RequestException, RuntimeError) as e:
            last_err = e
            if i == attempts - 1:
                break
            wait = base_delay ** (i + 1)
            logger.warning(f"reintento {i+1}/{attempts} en {wait}s ({e})")
            time.sleep(wait)
    raise last_err


def lanzar_pipeline_pr(
    cfg: dict,
    plant_codes,
    period_start: str = "",
    period_end: str = "",
    extra: dict | None = None,
) -> str | None:
    r"""Lanza el pipeline PR (pipeline 2) en Fabric pasándole los parámetros.

    - `plant_codes`: lista/tupla o cadena coma-separada (p.ej. ["PL2","PL3"] o "PL2,PL3").
    - `period_start` / `period_end`: ISO YYYY-MM-DD. Vacío = Fabric usa el rango máximo.
    - `extra`: dict opcional con más parámetros del pipeline
      (force_reingest, num_months, last_months_only, traceability_excel, report_html, files...).

    Devuelve la URL de la instancia de job (para seguir su estado) o None si falló.
    """
    c = _conf(cfg)
    if not c["workspace_id"] or not c["pr_pipeline_id"]:
        raise RuntimeError(
            "Faltan fabric.workspace_id o fabric.pr_pipeline_id en config.yaml — "
            "no se puede lanzar el pipeline PR."
        )

    if isinstance(plant_codes, (list, tuple)):
        plant_codes = ",".join(str(p).strip() for p in plant_codes if str(p).strip())

    params = {
        "plant_codes":  plant_codes,
        "period_start": period_start or "",
        "period_end":   period_end or "",
        "files":        "",   # vacío = csv_ingest autodescubre (es el único param sin default)
    }
    if extra:
        params.update(extra)

    url = (f"{FABRIC_BASE}/workspaces/{c['workspace_id']}"
           f"/items/{c['pr_pipeline_id']}/jobs/instances?jobType=Pipeline")
    body = {"executionData": {"parameters": params}}

    def _do():
        token = _get_fabric_token(c)
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
            timeout=TIMEOUT,
        )
        if r.status_code not in (200, 202):
            raise RuntimeError(f"Fabric job launch -> {r.status_code}: {r.text[:300]}")
        return r.headers.get("Location", "")

    job_url = _retry(_do)
    logger.info(
        f"✅ Pipeline PR lanzado en Fabric | plant_codes={plant_codes} | "
        f"periodo [{period_start or '∅'} .. {period_end or '∅'}] | job: {job_url or '(sin Location)'}"
    )
    return job_url


def claim_pipeline_owner(cfg: dict) -> None:
    r"""Hace que el SP sea el 'LastModifiedBy' del pipeline PR (PATCH de descripción).

    POR QUÉ: las actividades de Notebook dentro de un pipeline corren bajo la
    identidad del ÚLTIMO que modificó el pipeline, no de quien lo lanza. Si lo
    editó un usuario y luego lo lanza el SP de forma desatendida, los notebooks
    fallan con 'UserAccessTokenException: unable to acquire user token'.

    Al modificar el pipeline el propio SP, pasa a ser LastModifiedBy y los
    notebooks corren bajo el SP (que sí puede adquirir su token).

    EJECUTAR UNA VEZ en el PC (que tiene el secret). Repetir si alguien vuelve a
    editar el pipeline desde el portal (eso revierte el LastModifiedBy a usuario).
    """
    c = _conf(cfg)
    if not c["workspace_id"] or not c["pr_pipeline_id"]:
        raise RuntimeError("Faltan fabric.workspace_id o fabric.pr_pipeline_id en config.yaml")
    token = _get_fabric_token(c)
    url = (f"{FABRIC_BASE}/workspaces/{c['workspace_id']}"
           f"/dataPipelines/{c['pr_pipeline_id']}")
    r = requests.patch(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"description": "Owner = PVSyst1_EPI (SPN) — ejecucion desatendida del pipeline PR"},
        timeout=TIMEOUT,
    )
    if not r.ok:
        raise RuntimeError(f"PATCH dataPipelines -> {r.status_code}: {r.text[:300]}")
    logger.info("✅ SP fijado como LastModifiedBy del pipeline PR. "
                "Ya puede lanzarse de forma desatendida (los notebooks correran bajo el SP).")


if __name__ == "__main__":
    # Uso: `python fabric_jobs.py` en el PC (con PVSYST1_EPI_SECRET definido)
    # para reclamar la propiedad del pipeline por el SP (paso único de setup).
    import yaml
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    with open("config.yaml", encoding="utf-8") as _f:
        _cfg = yaml.safe_load(_f)
    claim_pipeline_owner(_cfg)
