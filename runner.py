"""Ejecución de scripts .bat capturando toda la salida y el código de retorno."""
from __future__ import annotations

import subprocess
import shlex
from dataclasses import dataclass
from pathlib import Path


@dataclass
class BatResult:
    """Resultado de ejecutar un .bat."""
    nombre: str
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    @property
    def consola_completa(self) -> str:
        """Mezcla stdout y stderr en un único bloque para reenviar a Teams."""
        partes = []
        if self.stdout:
            partes.append("=== STDOUT ===")
            partes.append(self.stdout)
        if self.stderr:
            partes.append("=== STDERR ===")
            partes.append(self.stderr)
        if self.timed_out:
            partes.append("=== TIMEOUT: el proceso fue cancelado por exceder el tiempo ===")
        return "\n".join(partes) if partes else "(sin salida)"


def ejecutar_bat(comando_completo: str, timeout: int | None = None) -> BatResult:
    """Ejecuta un .bat y captura todo. Mantiene las rutas de Windows intactas."""
    # posix=False es vital para no destruir los backslash (\) de Windows
    partes = shlex.split(comando_completo, posix=False)
    
    # Limpiamos las comillas que puedan venir en la ruta
    ruta_bat = Path(partes[0].strip('"').strip("'"))
    nombre = ruta_bat.name

    if not ruta_bat.is_file():
        return BatResult(
            nombre=nombre,
            exit_code=-1,
            stdout="",
            stderr=f"Fallo critico Python: No se encuentra el script {ruta_bat}",
        )

    try:
        proc = subprocess.run(
            f'cmd.exe /c "{comando_completo}"',
            capture_output=True,
            text=True,
            encoding="cp1252",
            errors="replace",
            timeout=timeout,
            cwd=ruta_bat.parent,
        )
        return BatResult(
            nombre=nombre,
            exit_code=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
        )
    except subprocess.TimeoutExpired as e:
        return BatResult(
            nombre=nombre,
            exit_code=-2,
            stdout=(e.stdout or b"").decode("cp1252", errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""),
            stderr=(e.stderr or b"").decode("cp1252", errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or ""),
            timed_out=True,
        )
    except Exception as e:
        return BatResult(
            nombre=nombre,
            exit_code=-3,
            stdout="",
            stderr=str(e),
        )