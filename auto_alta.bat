@echo off
SETLOCAL EnableDelayedExpansion
cls

SET "OPS=C:\Users\PVSYST1\PVSyst_CLI"
IF NOT EXIST "%OPS%\logs_bat" mkdir "%OPS%\logs_bat"
SET "LOG_FILE=%OPS%\logs_bat\auto_alta_log.txt"

REM Llamamos a toda la logica del script y redirigimos cualquier texto o error al log
call :ejecucion %* > "%LOG_FILE%" 2>&1

REM Salimos del script silenciosamente devolviendo el codigo de error
exit /b %EXIT_CODE%


:ejecucion
echo [INICIO SIMULACION] Fecha: %DATE% - Hora: %TIME%
echo ------------------------------------------------------------
SET "EXIT_CODE=0"
SET "WS=C:\Users\PVSYST1\PVsyst8.1_Data"
SET "INPUT=C:\Users\PVSYST1\PVSyst_CLI\inbox"
REM Primer argumento opcional: ruta alternativa de INPUT (usada por el orquestador Python)
IF NOT "%~1"=="" SET "INPUT=%~1"

SET "BUF=%TEMP%\alta_planta_%RANDOM%.tmp"
IF EXIST "%BUF%" del "%BUF%" >nul 2>&1
type nul > "%BUF%"

IF NOT EXIST "%INPUT%" (
    SET "ERR_MSG=No existe la carpeta input: %INPUT%"
    SET "EXIT_CODE=2"
    echo [ERROR] No existe input.
    GOTO :end
)
IF NOT EXIST "%WS%" (
    SET "ERR_MSG=No existe el workspace PVsyst: %WS%"
    SET "EXIT_CODE=3"
    echo [ERROR] No existe el workspace.
    GOTO :end
)

REM Comprobar si hay algun fichero en input
IF NOT EXIST "%INPUT%\*.*" (
    SET "ERR_MSG=La carpeta input esta vacia: %INPUT%"
    SET "EXIT_CODE=4"
    echo [ERROR] Carpeta input vacia.
    GOTO :end
)

REM Detectar PRJ
SET "PRJ_COUNT=0"
SET "PRJ_NAME="
IF EXIST "%INPUT%\*.PRJ" (
    FOR %%F IN ("%INPUT%\*.PRJ") DO (
        SET /A PRJ_COUNT+=1
        SET "PRJ_NAME=%%~nF"
    )
)

REM Detectar variantes .V??
SET "VXX_COUNT=0"
SET "VXX_PLANT="
SET "VXX_VARIANT="
SET "VXX_MIXED=0"
IF EXIST "%INPUT%\*.V??" (
    FOR %%F IN ("%INPUT%\*.V??") DO (
        SET /A VXX_COUNT+=1
        IF "!VXX_PLANT!"=="" (
            SET "VXX_PLANT=%%~nF"
        ) ELSE (
            IF NOT "%%~nF"=="!VXX_PLANT!" SET "VXX_MIXED=1"
        )
        SET "TMP_EXT=%%~xF"
        SET "VXX_VARIANT=!TMP_EXT:.=!"
    )
)

IF !PRJ_COUNT! GTR 1 (
    SET "ERR_MSG=Hay mas de un .PRJ en input. Solo se admite uno."
    SET "EXIT_CODE=5"
    echo [ERROR] Mas de un PRJ.
    GOTO :end
)

IF !PRJ_COUNT! EQU 1 (
    SET "MODE=ALTA"
    SET "PLANTA=!PRJ_NAME!"
    GOTO :run_alta
)

IF !VXX_COUNT! GTR 0 (
    IF !VXX_MIXED! EQU 1 (
        SET "ERR_MSG=Hay variantes de plantas distintas en input. Solo una planta por ejecucion."
        SET "EXIT_CODE=12"
        echo [ERROR] Variantes mezcladas.
        GOTO :end
    )
    SET "MODE=VARIANT"
    SET "PLANTA=!VXX_PLANT!"
    GOTO :run_variant
)

SET "ERR_MSG=input no contiene .PRJ ni .V??. Para CSVs usar run_daily.bat"
SET "EXIT_CODE=7"
echo [ERROR] Faltan archivos clave ^(PRJ o V??^).
GOTO :end


:run_alta
echo [INFO] Iniciando ALTA de planta: !PLANTA!
SET "PROJECT_DIR=%OPS%\projects\%PLANTA%"

SET "SIT_OK=0"
IF EXIST "%INPUT%\*.SIT" SET "SIT_OK=1"
SET "MEF_OK=0"
IF EXIST "%INPUT%\*.MEF" SET "MEF_OK=1"

IF !SIT_OK! EQU 0 (
    SET "ERR_MSG=ALTA requiere un fichero .SIT en input."
    SET "EXIT_CODE=10"
    echo [ERROR] Falta .SIT.
    GOTO :end
)
IF !MEF_OK! EQU 0 (
    SET "ERR_MSG=ALTA requiere un fichero .MEF en input."
    SET "EXIT_CODE=11"
    echo [ERROR] Falta .MEF.
    GOTO :end
)

SET "WARN_PAN=0"
SET "WARN_OND=0"
IF NOT EXIST "%INPUT%\*.PAN" SET "WARN_PAN=1"
IF NOT EXIST "%INPUT%\*.OND" SET "WARN_OND=1"

mkdir "%PROJECT_DIR%\meteo_in"        2>nul
mkdir "%PROJECT_DIR%\results_out"     2>nul
mkdir "%PROJECT_DIR%\reference"       2>nul

call :move_to_ws "PAN" "ComposPV\PVmodules"
call :move_to_ws "OND" "ComposPV\Inverters"
call :move_to_ws "PRJ" "Projects"
call :move_to_ws "V??" "Projects"
call :move_to_ws "SIT" "Sites"
call :move_to_ws "MEF" "Meteo"
call :move_to_ws "MET" "Meteo"
call :move_to_ws "SFI" "Models"

REM Documentos de referencia: se mueven a <projects>\<Planta>\reference\
REM (Python los recoge desde ahi y los sube a SharePoint via Graph)
call :move_to_reference "pdf"
call :move_to_reference "xlsx"
call :move_to_reference "xlsm"
call :move_to_reference "docx"
call :move_to_reference "txt"
call :move_to_reference "md"

SET "VAR_FILE=%PROJECT_DIR%\variant.txt"
IF !VXX_COUNT! GTR 0 (
    >"%VAR_FILE%" echo !VXX_VARIANT!
    >>"%BUF%" echo Variante detectada en input: !VXX_VARIANT!
) ELSE (
    IF NOT EXIST "%VAR_FILE%" (
        >"%VAR_FILE%" echo VC0
        >>"%BUF%" echo Variante por defecto asignada: VC0 ^(sin .V?? en input^)
    )
)

call :report_remaining
SET "EXIT_CODE=0"
echo [INFO] Alta finalizada.
GOTO :end


:run_variant
echo [INFO] Iniciando actualizacion de VARIANTE para la planta: !PLANTA!
SET "PROJECT_DIR=%OPS%\projects\%PLANTA%"

IF NOT EXIST "%WS%\Projects\%PLANTA%.PRJ" (
    SET "ERR_MSG=La planta '!PLANTA!' no esta dada de alta (falta PRJ en workspace)."
    SET "EXIT_CODE=13"
    echo [ERROR] PRJ no encontrado en workspace.
    GOTO :end
)
IF NOT EXIST "%PROJECT_DIR%" (
    SET "ERR_MSG=La planta '!PLANTA!' no esta inicializada (falta carpeta en projects)."
    SET "EXIT_CODE=14"
    echo [ERROR] Carpeta de proyecto no encontrada.
    GOTO :end
)

echo [INFO] Moviendo archivos de la nueva variante...
call :move_to_ws "V??" "Projects"

SET "VAR_FILE=%PROJECT_DIR%\variant.txt"
SET "OLD_VARIANT=Ninguna (o no definida)"

REM Leer la variante antigua si existe y tiene contenido
IF EXIST "%VAR_FILE%" (
    FOR /F "usebackq delims=" %%A IN ("%VAR_FILE%") DO SET "OLD_VARIANT=%%A"
)

>"%VAR_FILE%" echo !VXX_VARIANT!
echo [INFO] Archivo variant.txt actualizado.

>>"%BUF%" echo Cambio de variante registrado: de [!OLD_VARIANT!] a [!VXX_VARIANT!]

call :report_remaining
SET "EXIT_CODE=0"
echo [INFO] Variante actualizada.
GOTO :end


:end
echo.
echo ============================================================
IF !EXIT_CODE! EQU 0 (
    echo  ESTADO: OK
    IF DEFINED MODE echo  Modo:   !MODE!
    IF DEFINED PLANTA echo  Planta: !PLANTA!
    IF "!MODE!"=="VARIANT" echo  Variante actual: !VXX_VARIANT!

    IF "!MODE!"=="ALTA" (
        IF "!WARN_PAN!"=="1" echo  AVISO: no se incluyo .PAN
        IF "!WARN_OND!"=="1" echo  AVISO: no se incluyo .OND
    )
) ELSE (
    echo  ERROR codigo !EXIT_CODE!
    IF DEFINED ERR_MSG echo  !ERR_MSG!
)
echo ============================================================

IF EXIST "%BUF%" (
    FOR %%S IN ("%BUF%") DO IF %%~zS GTR 0 (
        echo.
        echo --- Detalles de la operacion ---
        type "%BUF%"
    )
    del "%BUF%" >nul 2>&1
)

echo.
echo === FIN DEL SCRIPT ===
goto :eof


:move_to_ws
SET "EXT=%~1"
SET "SUBDIR=%~2"
IF NOT EXIST "%INPUT%\*.%EXT%" exit /b 0
SET "DEST=%WS%\%SUBDIR%"
IF NOT EXIST "%DEST%" mkdir "%DEST%" 2>nul
FOR %%F IN ("%INPUT%\*.%EXT%") DO (
    move /Y "%%F" "%DEST%\" >nul
    >>"%BUF%" echo   - Movido: %%~nxF a %SUBDIR%\
)
exit /b 0

:move_to_project
SET "EXT=%~1"
SET "SUBDIR=%~2"
IF NOT EXIST "%INPUT%\*.%EXT%" exit /b 0
SET "DEST=%PROJECT_DIR%\%SUBDIR%"
IF NOT EXIST "%DEST%" mkdir "%DEST%" 2>nul
FOR %%F IN ("%INPUT%\*.%EXT%") DO (
    move /Y "%%F" "%DEST%\" >nul
    >>"%BUF%" echo   - Movido: %%~nxF a projects\!PLANTA!\%SUBDIR%\
)
exit /b 0

:move_to_reference
REM Mueve los ficheros de la extension dada desde INPUT a:
REM    <projects>\<PLANTA>\reference\
REM Python (main.py) los recoge desde ahi y los sube a SharePoint via Graph.
SET "EXT=%~1"
IF NOT EXIST "%INPUT%\*.%EXT%" exit /b 0
SET "DEST=%PROJECT_DIR%\reference"
IF NOT EXIST "%DEST%" mkdir "%DEST%" 2>nul
FOR %%F IN ("%INPUT%\*.%EXT%") DO (
    move /Y "%%F" "%DEST%\" >nul
    >>"%BUF%" echo   - Movido: %%~nxF a projects\!PLANTA!\reference\
)
exit /b 0

:report_remaining
IF NOT EXIST "%INPUT%\*.*" exit /b 0
SET "REMAINING=0"
FOR %%F IN ("%INPUT%\*.*") DO SET /A REMAINING+=1
IF !REMAINING! GTR 0 (
    >>"%BUF%" echo.
    >>"%BUF%" echo AVISO: Quedan !REMAINING! ficheros sin clasificar en input:
    FOR %%F IN ("%INPUT%\*.*") DO >>"%BUF%" echo   - %%~nxF
)
exit /b 0
