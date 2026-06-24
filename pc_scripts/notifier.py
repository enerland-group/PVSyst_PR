"""Envío de notificaciones a Microsoft Teams vía Power Automate Workflow Webhook."""
from __future__ import annotations

import logging
import datetime as dt
import requests

logger = logging.getLogger(__name__)


def _post(webhook_url: str, payload: dict) -> bool:
    """Envía el payload HTTP a Teams."""
    try:
        r = requests.post(webhook_url, json=payload, timeout=30)
        if r.status_code in (200, 202):
            return True
        logger.error("Workflow webhook devolvio %s: %s", r.status_code, r.text)
        return False
    except Exception:
        logger.exception("Error enviando a Teams")
        return False


def _envolver_card(card_body: list[dict]) -> dict:
    """Envuelve un Adaptive Card en el formato que los Workflows entienden."""
    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": card_body,
                },
            }
        ],
    }


def _formatear_evento(ev: dict) -> str:
    """Renderiza '✓ Prefijo **Planta** sufijo' o con '✗' si fue error."""
    marca = "✓" if ev.get("ok") else "✗"
    prefijo = ev.get("prefijo", "")
    planta = ev.get("planta", "")
    sufijo = ev.get("sufijo", "") or ""
    return f"{marca} {prefijo} **{planta}**{sufijo}".rstrip()


def enviar_resumen_breve(webhook_url: str, eventos: list[dict], hubo_fallos: bool = False) -> bool:
    """Monta y envía la tarjeta de resumen a Teams.

    `eventos` es una lista de dicts con claves: ok (bool), prefijo (str),
    planta (str), sufijo (str opcional).
    """
    if not eventos:
        return True

    fecha = dt.datetime.now().strftime("%d/%m/%Y")
    color = "Attention" if hubo_fallos else "Default"

    lista_texto = "\n".join(_formatear_evento(ev) for ev in eventos)

    body = [
        {
            "type": "TextBlock",
            "text": f"**Sim. {fecha}**",
            "weight": "Bolder",
            "size": "Large",
            "color": color
        },
        {
            "type": "TextBlock",
            "text": lista_texto,
            "wrap": True,
            "spacing": "Small"
        }
    ]

    return _post(webhook_url, _envolver_card(body))