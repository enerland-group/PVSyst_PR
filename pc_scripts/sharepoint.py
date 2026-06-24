r"""Integración con SharePoint vía Microsoft Graph (sin depender de OneDrive sync).

Usa la app de Azure AD `PVSyst1_EPI` (la misma que Fabric) con auth client_credentials.

Funciones públicas:
    descargar_meteo_inbox(cfg, dest_dir)
        Pull de los CSV nuevos de meteo desde SharePoint /inbox/ al INBOX local.

    subir_resultados(ficheros, cfg)
        PUT vía Graph de cada fichero resultado a <Raw PVSyst1>/<Planta>/[<subdir>]/<file>.

    subir_log_a_sharepoint(local_path, cfg, fecha_dia, tipo)
        PUT vía Graph del log diario acumulado a <LOGS>/log_<tipo>_<fecha>.txt.

Configuración (en config.yaml):
    graph:
      client_id: "58f369e5-0dfd-4435-802b-a90a6786bf22"
      tenant_id: "943fa85b-068d-404a-bacb-5f0baf8d31a8"
      site_path: "enerlandgroup.sharepoint.com:/sites/Pvsyst1"
      drive_name: "Documentos"
      inbox_folder: "inbox"
      results_root_folder: "Raw PVSyst1"
      logs_folder: "LOGS"
      secret_env_var: "PVSYST1_EPI_SECRET"    # env var con el client_secret

El client_secret NO va en el config — vive en una variable de entorno del PC.
"""
from __future__ import annotations

import os
import json
import time
import shutil
import logging
from pathlib import Path
from urllib.parse import quote
from datetime import datetime

import requests

logger = logging.getLogger(__name__)

# ============================================================
# Defaults (pueden sobreescribirse desde config.yaml)
# ============================================================
DEFAULTS = {
    "client_id":            "58f369e5-0dfd-4435-802b-a90a6786bf22",
    "tenant_id":            "943fa85b-068d-404a-bacb-5f0baf8d31a8",
    "site_path":            "enerlandgroup.sharepoint.com:/sites/Pvsyst1",
    "drive_name":           "Documentos",
    "inbox_folder":         "inbox",
    # Raíz de outputs: cadena vacía = directamente bajo la biblioteca raíz, así
    # los resultados acaban en Documentos/<PLANTA>/<file>. Pon un nombre de
    # subcarpeta si quieres organizarlos bajo una carpeta intermedia.
    "results_root_folder":  "",
    "logs_folder":          "LOGS",
    "secret_env_var":       "PVSYST1_EPI_SECRET",
}

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TIMEOUT    = 60


# ============================================================
# Estado local: qué CSVs de meteo ya se procesaron (idempotencia)
# ============================================================
def _state_path(cfg: dict | None = None) -> Path:
    """Ruta del fichero JSON de estado.

    Prioridad:
      1. cfg["paths"]["state_file"] (si está definido en config.yaml).
      2. %APPDATA%\\PVSyst1_sync\\last_meteo.json   (Windows).
      3. ~/.pvsyst1_sync/last_meteo.json            (otros SO).
    """
    if cfg:
        custom = (cfg.get("paths") or {}).get("state_file")
        if custom:
            p = Path(custom)
            p.parent.mkdir(parents=True, exist_ok=True)
            return p

    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home())) / "PVSyst1_sync"
    else:
        base = Path.home() / ".pvsyst1_sync"
    base.mkdir(parents=True, exist_ok=True)
    return base / "last_meteo.json"


def _load_state(cfg: dict | None = None) -> dict:
    p = _state_path(cfg)
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_state(state: dict, cfg: dict | None = None) -> None:
    _state_path(cfg).write_text(json.dumps(state, indent=2), encoding="utf-8")


# ============================================================
# Graph helpers
# ============================================================
def _cfg_graph(cfg: dict) -> dict:
    """Mezcla DEFAULTS con cfg.graph (cfg gana)."""
    g = dict(DEFAULTS)
    g.update(cfg.get("graph", {}) or {})
    return g


def _get_secret(g: dict) -> str:
    var = g["secret_env_var"]
    secret = os.environ.get(var, "").strip()
    if not secret:
        raise RuntimeError(
            f"Variable de entorno '{var}' no definida o vacía. "
            f"Defínela con `setx {var} <client_secret> /M` y reinicia la consola."
        )
    return secret


def _retry(fn, attempts=3, base_delay=2):
    """Reintenta `fn()` con backoff exponencial."""
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


def _get_token(g: dict) -> str:
    secret = _get_secret(g)
    r = requests.post(
        f"https://login.microsoftonline.com/{g['tenant_id']}/oauth2/v2.0/token",
        data={
            "client_id": g["client_id"],
            "scope": "https://graph.microsoft.com/.default",
            "client_secret": secret,
            "grant_type": "client_credentials",
        },
        timeout=TIMEOUT,
    )
    if not r.ok:
        raise RuntimeError(f"OAuth fallo {r.status_code}: {r.text[:300]}")
    return r.json()["access_token"]


def _gget(token: str, path: str):
    r = requests.get(
        f"{GRAPH_BASE}/{path.lstrip('/')}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=TIMEOUT,
    )
    if not r.ok:
        raise RuntimeError(f"Graph GET {path} -> {r.status_code}: {r.text[:300]}")
    return r.json()


def _resolve_site_and_drive(token: str, g: dict) -> tuple[str, str]:
    site = _gget(token, f"sites/{g['site_path']}")
    site_id = site["id"]
    drives = _gget(token, f"sites/{site_id}/drives").get("value", [])
    drive = next((d for d in drives if d.get("name") == g["drive_name"]), None)
    if drive is None:
        names = [d.get("name") for d in drives]
        raise ValueError(f"Biblioteca '{g['drive_name']}' no encontrada. Disponibles: {names}")
    return site_id, drive["id"]


def _list_folder(token: str, site_id: str, drive_id: str, folder_path: str) -> list[dict]:
    safe = "/".join(quote(s, safe="") for s in folder_path.strip("/").split("/"))
    items = _gget(token, f"sites/{site_id}/drives/{drive_id}/root:/{safe}:/children")
    return [i for i in items.get("value", []) if i.get("file") is not None]


def _download_file(token: str, site_id: str, drive_id: str, remote_path: str, local_path: Path) -> None:
    safe = "/".join(quote(s, safe="") for s in remote_path.strip("/").split("/"))
    url = f"{GRAPH_BASE}/sites/{site_id}/drives/{drive_id}/root:/{safe}:/content"
    with requests.get(url, headers={"Authorization": f"Bearer {token}"}, stream=True, timeout=TIMEOUT * 2) as r:
        if not r.ok:
            raise RuntimeError(f"Graph GET {remote_path} -> {r.status_code}: {r.text[:300]}")
        local_path.parent.mkdir(parents=True, exist_ok=True)
        with local_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=64 * 1024):
                if chunk:
                    f.write(chunk)


def _upload_file(token: str, site_id: str, drive_id: str, remote_path: str, local_path: Path) -> dict:
    safe = "/".join(quote(s, safe="") for s in remote_path.strip("/").split("/"))
    url = f"{GRAPH_BASE}/sites/{site_id}/drives/{drive_id}/root:/{safe}:/content"
    with local_path.open("rb") as f:
        r = requests.put(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/octet-stream",
            },
            data=f,
            timeout=TIMEOUT * 4,
        )
    if not r.ok:
        raise RuntimeError(f"Graph PUT {remote_path} -> {r.status_code}: {r.text[:300]}")
    return r.json()


def _delete_file(token: str, site_id: str, drive_id: str, remote_path: str) -> bool:
    """Elimina un fichero de SharePoint. Devuelve True si se borró o ya no estaba (404)."""
    safe = "/".join(quote(s, safe="") for s in remote_path.strip("/").split("/"))
    url = f"{GRAPH_BASE}/sites/{site_id}/drives/{drive_id}/root:/{safe}"
    r = requests.delete(url, headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT)
    if r.status_code in (204, 404):
        return True
    raise RuntimeError(f"Graph DELETE {remote_path} -> {r.status_code}: {r.text[:300]}")


# ============================================================
# API pública
# ============================================================
def descargar_meteo_inbox(cfg: dict, dest_dir: str | os.PathLike) -> tuple[list[Path], dict]:
    r"""Descarga del SharePoint /inbox/ al INBOX local.

    Compara contra el estado en %APPDATA%\PVSyst1_sync\last_meteo.json para
    saltarse lo que ya se procesó OK en runs anteriores. Pero NO actualiza ese
    JSON — devuelve un dict "pending_state" que debe pasarse a
    `marcar_meteos_procesados()` AL FINAL del ciclo, solo si todo fue bien.
    Así, si la simulación falla a medias, el siguiente run re-baja y reintenta.

    Extensiones que se aceptan: .csv .prj .v?? .sit .mef .met .sfi .pan .ond
    .pdf .xlsx .xlsm .docx .txt .md

    Devuelve (paths_descargados, pending_state_dict).
    """
    g = _cfg_graph(cfg)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Pull desde SharePoint /{g['inbox_folder']}/ ...")

    def _do():
        token = _get_token(g)
        site_id, drive_id = _resolve_site_and_drive(token, g)
        items = _list_folder(token, site_id, drive_id, g["inbox_folder"])
        return token, site_id, drive_id, items

    token, site_id, drive_id, items = _retry(_do)

    accepted_exts = {
        ".csv", ".prj",
        ".sit", ".mef", ".met", ".sfi", ".pan", ".ond",
        ".pdf", ".xlsx", ".xlsm", ".docx", ".txt", ".md",
    }
    import re as _re
    re_variante = _re.compile(r"^\.v..$", _re.IGNORECASE)

    def _es_aceptado(name: str) -> bool:
        if name.startswith("~$"):
            return False
        ext = Path(name).suffix.lower()
        return ext in accepted_exts or bool(re_variante.match(ext))

    items_filtrados = [i for i in items if _es_aceptado(i["name"])]
    if not items_filtrados:
        logger.info(f"  /inbox/ vacío o sin ficheros aceptados.")
        return [], {}

    state = _load_state(cfg)
    descargados: list[Path] = []
    pending_state: dict = {}

    for item in items_filtrados:
        name     = item["name"]
        last_mod = item.get("lastModifiedDateTime", "")
        size     = item.get("size", "?")

        prev = state.get(name, {})
        if prev.get("modified") == last_mod:
            logger.info(f"  {name}: ya procesado OK en ciclo anterior, se omite.")
            continue

        local = dest_dir / name
        logger.info(f"  descargando {name} ({size} B) -> {local}")
        _retry(lambda n=name, l=local: _download_file(token, site_id, drive_id, f"{g['inbox_folder']}/{n}", l))

        # NO guardamos el state todavía. Solo lo añadimos al dict "pending".
        # Si el ciclo completo termina sin fallos, main.py llama a
        # marcar_meteos_procesados(pending_state) para persistirlo.
        pending_state[name] = {
            "modified":      last_mod,
            "downloaded_at": datetime.now().isoformat(timespec="seconds"),
        }
        descargados.append(local)

    if descargados:
        logger.info(f"Pull OK: {len(descargados)} fichero(s) descargado(s) (pendiente de confirmar al final).")
    else:
        logger.info("Pull OK: nada nuevo.")

    return descargados, pending_state


def marcar_meteos_procesados(pending_state: dict, cfg: dict | None = None) -> None:
    """Persiste el estado de meteos procesados en el JSON definido por
    cfg["paths"]["state_file"], o en el fallback %APPDATA%\\PVSyst1_sync\\last_meteo.json.

    Llamar al FINAL del ciclo cuando hubo_fallos == False. Si hubo fallos, NO
    llamar — así el siguiente run re-baja y reintenta.
    """
    if not pending_state:
        return
    state = _load_state(cfg)
    state.update(pending_state)
    _save_state(state, cfg)
    p = _state_path(cfg)
    logger.info(f"Estado guardado: {len(pending_state)} meteo(s) marcado(s) en {p}")


def borrar_meteo_inbox(cfg: dict, filenames: list[str]) -> list[str]:
    r"""Elimina del SharePoint /inbox/ los ficheros indicados (DELETE via Graph).

    Pensada para llamarse AL FINAL del ciclo, sólo si todo fue bien — así el
    fichero no estorba en futuros runs y la /inbox/ queda limpia.

    Si el delete falla por red/permiso, se loguea el error pero no se aborta
    el ciclo: el JSON state ya tiene marcados los meteos como procesados,
    así que aunque queden físicamente en /inbox/ el siguiente run los saltará.

    Devuelve la lista de nombres efectivamente borrados.
    """
    g = _cfg_graph(cfg)
    if not filenames:
        return []

    logger.info(f"Eliminando {len(filenames)} fichero(s) procesado(s) del SharePoint /{g['inbox_folder']}/ ...")

    def _do_auth():
        token = _get_token(g)
        site_id, drive_id = _resolve_site_and_drive(token, g)
        return token, site_id, drive_id

    try:
        token, site_id, drive_id = _retry(_do_auth)
    except Exception as e:
        logger.error(f"  FALLO autenticando para borrar: {e}")
        return []

    borrados: list[str] = []
    for name in filenames:
        try:
            _retry(lambda n=name: _delete_file(token, site_id, drive_id, f"{g['inbox_folder']}/{n}"))
            logger.info(f"  borrado: {name}")
            borrados.append(name)
        except Exception as e:
            logger.error(f"  FALLO borrando {name}: {e}")

    return borrados


def subir_resultados(
    ficheros: list[tuple[str, str, Path]],
    cfg: dict,
) -> list[tuple[str, str, str]]:
    r"""Sube cada fichero a SharePoint via Graph en <results_root_folder>/<Planta>/[<subdir>]/<file>.

    `ficheros` es lista de tuples (planta, subdir, fichero_local). Si `subdir`
    es cadena vacía, va directamente bajo <Planta>/.

    Devuelve lista de (planta, nombre_fichero, webUrl).
    """
    g = _cfg_graph(cfg)
    if not ficheros:
        return []

    logger.info(f"Subiendo {len(ficheros)} ficheros a SharePoint via Graph ...")

    def _do():
        token = _get_token(g)
        site_id, drive_id = _resolve_site_and_drive(token, g)
        return token, site_id, drive_id

    token, site_id, drive_id = _retry(_do)
    enlaces: list[tuple[str, str, str]] = []

    for planta, subdir, f in ficheros:
        if not f.is_file():
            logger.warning(f"  omitido (no existe): {f}")
            continue

        parts = [g["results_root_folder"], planta]
        if subdir:
            parts.append(subdir)
        parts.append(f.name)
        remote_path = "/".join(p for p in parts if p)

        try:
            info = _retry(lambda: _upload_file(token, site_id, drive_id, remote_path, f))
            web_url = info.get("webUrl", "")
            enlaces.append((planta, f.name, web_url))
            logger.info(f"  OK {planta}/{f.name}  ({f.stat().st_size:,} B)")
        except Exception as e:
            logger.error(f"  FAILED {planta}/{f.name}: {e}")

    return enlaces


def subir_log_a_sharepoint(
    local_path: str | os.PathLike,
    cfg: dict,
    fecha_dia: str,
    tipo: str,
) -> str | None:
    r"""Sube el log diario acumulado a SharePoint <logs_folder>/log_<tipo>_<fecha_dia>.txt.

    Sobreescribe si ya existe (Graph PUT con misma ruta hace replace).
    Devuelve la webUrl o None si falló.
    """
    g = _cfg_graph(cfg)
    local_path = Path(local_path)
    if not local_path.exists():
        logger.warning(f"Log local no existe, no se sube: {local_path}")
        return None

    remote_name = local_path.name  # ej. log_alta_20260605.txt
    remote_path = f"{g['logs_folder']}/{remote_name}"

    def _do():
        token = _get_token(g)
        site_id, drive_id = _resolve_site_and_drive(token, g)
        return _upload_file(token, site_id, drive_id, remote_path, local_path)

    try:
        info = _retry(_do)
        url = info.get("webUrl", "")
        logger.info(f"Log {remote_name} subido a SharePoint")
        return url
    except Exception as e:
        logger.error(f"FAILED subir log {remote_name}: {e}")
        return None
