"""Script de diagnostico del webhook de Teams.

Uso:
    python test_webhook.py

Lee la URL desde config.yaml (teams.webhook_url) y manda un mensaje simple
para verificar que el flujo de Power Automate esta bien configurado.

Util para depurar antes de poner la automatizacion completa.
"""
from __future__ import annotations

import sys

import requests
import yaml


def main() -> int:
    with open("config.yaml", "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    url = cfg["teams"]["webhook_url"]
    if not url:
        print("ERROR: teams.webhook_url esta vacia en config.yaml")
        return 1

    print(f"Enviando mensaje de prueba a: {url[:80]}...")

    payload = {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": [
                        {
                            "type": "TextBlock",
                            "text": "🧪 Mensaje de prueba",
                            "weight": "Bolder",
                            "size": "Large",
                        },
                        {
                            "type": "TextBlock",
                            "text": "Si ves esto en Teams, el webhook funciona.",
                            "wrap": True,
                        },
                    ],
                },
            }
        ],
    }

    try:
        r = requests.post(url, json=payload, timeout=30)
    except Exception as e:
        print(f"ERROR en la peticion: {e}")
        return 1

    print(f"Status code: {r.status_code}")
    print(f"Respuesta: {r.text[:500]}")

    if r.status_code in (200, 202):
        print("\n✅ OK: revisa el canal de Teams. Deberia haber llegado el mensaje en unos segundos.")
        return 0
    else:
        print("\n❌ FALLO. Posibles causas:")
        print("  - URL caducada o flujo deshabilitado")
        print("  - Formato del payload no soportado por la version del flujo")
        print("  - Tenant bloquea webhooks externos")
        return 1


if __name__ == "__main__":
    sys.exit(main())
