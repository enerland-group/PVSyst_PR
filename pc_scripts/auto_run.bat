@echo off
SETLOCAL EnableDelayedExpansion
cls

SET "OPS=C:\Users\PVSYST1\PVSyst_CLI"
IF NOT EXIST "%OPS%\logs_bat" mkdir "%OPS%\logs_bat"
SET "LOG_FILE=%OPS%\logs_bat\auto_run_log.txt"

REM Llamamos a toda la logica del script y redirigimos cualquier texto o error al log
REM %* propaga los argumentos del script a la subrutina (sin esto, %~1 dentro de :ejecucion seria vacio)
call :ejecucion %* > "%LOG_FILE%" 2>&1

REM Salimos del script silenciosamente devolviendo el codigo de error
exit /b !EXIT_CODE!


:ejecucion
echo [INICIO SIMULACION] Fecha: %DATE% - Hora: %TIME%
echo ------------------------------------------------------------
SET "EXIT_CODE=0"

SET "WS=C:\Users\PVSYST1\PVsyst8.1_Data"
SET "INPUT=C:\Users\PVSYST1\PVSyst_CLI\inbox"
REM Primer argumento opcional: ruta alternativa de INPUT (usada por el orquestador Python)
IF NOT "%~1"=="" SET "INPUT=%~1"
SET "PVSYSTCLI=C:\Program Files\PVsyst8.1.2\PVsystCLI.exe"

REM Fecha de la ejecucion en formato YYYYMMDD (independiente del locale)
FOR /F "tokens=2 delims==" %%I IN ('wmic os get LocalDateTime /value 2^>nul ^| find "="') DO SET "DT=%%I"
SET "FECHA=!DT:~0,8!"
IF "!FECHA!"=="" (
    REM Fallback por si wmic no esta disponible
    FOR /F %%I IN ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') DO SET "FECHA=%%I"
)

SET "BUF=%TEMP%\run_daily_%RANDOM%.tmp"
IF EXIST "%BUF%" del "%BUF%" >nul 2>&1
type nul > "%BUF%"

IF NOT EXIST "%INPUT%" (
    SET "ERR_MSG=No existe la carpeta input: %INPUT%"
    SET "EXIT_CODE=2"
    GOTO :end
)
IF NOT EXIST "%WS%" (
    SET "ERR_MSG=No existe el workspace PVsyst: %WS%"
    SET "EXIT_CODE=3"
    GOTO :end
)
IF NOT EXIST "%PVSYSTCLI%" (
    SET "ERR_MSG=No se encuentra PVsystCLI: %PVSYSTCLI%"
    SET "EXIT_CODE=8"
    GOTO :end
)

IF NOT EXIST "%INPUT%\*.csv" (
    SET "ERR_MSG=No hay CSVs en input. Nada que procesar."
    SET "EXIT_CODE=0"
    GOTO :end
)

REM --- MENSAJE DE ARRANQUE PARA EL LOG ---
echo ============================================================
echo   INICIANDO PROCESAMIENTO AUTOMATICO
echo   PVsyst CLI esta trabajando...
echo ============================================================
echo.

SET "TOTAL_OK=0"
SET "TOTAL_ERR=0"
SET "TOTAL=0"

FOR %%F IN ("%INPUT%\*.csv") DO (
    SET /A TOTAL+=1
    SET "CSV_FULL=%%F"
    SET "CSV_BASENAME=%%~nxF"
    FOR /F "tokens=1 delims=_" %%a IN ("%%~nF") DO SET "PLANTA=%%a"

    REM --- CHIVATO DE ARCHIVO ACTUAL ---
    echo.
    echo [~] Procesando archivo !TOTAL!: !CSV_BASENAME!

    call :process_one_csv
    IF !ERRORLEVEL! EQU 0 (
        SET /A TOTAL_OK+=1
        echo     - [EXITO] Archivo procesado correctamente.
    ) ELSE (
        SET /A TOTAL_ERR+=1
        echo     - [ERROR] Fallo en el procesamiento. Revisa el resumen al final.
    )
)

IF !TOTAL_ERR! GTR 0 SET "EXIT_CODE=20"
GOTO :end


:process_one_csv
SET "PROJECT_DIR=%OPS%\projects\!PLANTA!"
SET "PRJ_FILE=!PLANTA!.PRJ"
SET "SIT_FULL=%WS%\Sites\!PLANTA!.SIT"
SET "MEF_FULL=%WS%\Meteo\!PLANTA!.MEF"
SET "SFI_FULL=%WS%\Models\!PLANTA!.SFI"
SET "VAR_FILE=!PROJECT_DIR!\variant.txt"

IF NOT EXIST "%WS%\Projects\!PLANTA!.PRJ" (
    >>"%BUF%" echo [SKIP] !CSV_BASENAME!: planta '!PLANTA!' no esta dada de alta.
    exit /b 1
)
IF NOT EXIST "!PROJECT_DIR!" (
    >>"%BUF%" echo [SKIP] !CSV_BASENAME!: carpeta de proyecto no existe.
    exit /b 1
)
IF NOT EXIST "!VAR_FILE!" (
    >>"%BUF%" echo [SKIP] !CSV_BASENAME!: falta variant.txt.
    exit /b 1
)
IF NOT EXIST "!SIT_FULL!" (
    >>"%BUF%" echo [SKIP] !CSV_BASENAME!: falta SIT en workspace.
    exit /b 1
)
IF NOT EXIST "!MEF_FULL!" (
    >>"%BUF%" echo [SKIP] !CSV_BASENAME!: falta MEF en workspace.
    exit /b 1
)

SET "VARIANT="
SET /P VARIANT=<"!VAR_FILE!"
IF "!VARIANT!"=="" (
    >>"%BUF%" echo [SKIP] !CSV_BASENAME!: variant.txt vacio.
    exit /b 1
)

REM Resultados a carpeta LOCAL del proyecto. Python los recoge desde ahi y los
REM sube a SharePoint vía Microsoft Graph (no dependemos de OneDrive sync).
SET "MET_OUT=%WS%\Meteo\!PLANTA!.MET"
SET "RES_DIR_LOCAL=!PROJECT_DIR!\results_out"
SET "RES_CSV=!RES_DIR_LOCAL!\!PLANTA!_!FECHA!.csv"
SET "RES_PDF=!RES_DIR_LOCAL!\!PLANTA!_!FECHA!.pdf"
IF NOT EXIST "!RES_DIR_LOCAL!" mkdir "!RES_DIR_LOCAL!" 2>nul

SET "TMP_OUT=%TEMP%\pvsyst_%RANDOM%.txt"

echo     - Convirtiendo datos meteorologicos a .MET ...
"%PVSYSTCLI%" convert-meteo -icf:"!CSV_FULL!" -imf:"!MEF_FULL!" -isf:"!SIT_FULL!" -omf:"!MET_OUT!" > "!TMP_OUT!" 2>&1
IF !ERRORLEVEL! NEQ 0 (
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: convert-meteo fallo.
    type "!TMP_OUT!" >> "%BUF%"
    del "!TMP_OUT!" >nul 2>&1
    exit /b 1
)
IF NOT EXIST "!MET_OUT!" (
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: convert-meteo no genero el MET en !MET_OUT!.
    >>"%BUF%" echo    Salida CLI:
    type "!TMP_OUT!" >> "%BUF%"
    del "!TMP_OUT!" >nul 2>&1
    exit /b 1
)
del "!TMP_OUT!" >nul 2>&1

SET "SFI_ARG="
IF EXIST "!SFI_FULL!" SET "SFI_ARG=-isf:"!SFI_FULL!""

REM 1. Intentamos primero con subhour
echo     - Ejecutando simulacion en modo subhorario (esto puede tardar)...
"%PVSYSTCLI%" run-simulation -w:"%WS%" -p:"!PRJ_FILE!" -v:"!VARIANT!" -ts:subhour -s:"!SIT_FULL!" -imf:"!MET_OUT!" !SFI_ARG! -ocf:"!RES_CSV!" -odc -rpf:"!RES_PDF!" -rl:en > "!TMP_OUT!" 2>&1

REM 2. Buscamos la frase literal en el registro porque PVsyst miente con los codigos de error
findstr /i /c:"weather data is hourly" "!TMP_OUT!" >nul
IF !ERRORLEVEL! EQU 0 (
    >>"%BUF%" echo [WARN] !CSV_BASENAME!: PVsyst rechazo subhour. Forzando modo horario...
    echo     - Aviso de PVsyst detectado: datos horarios. Reintentando simulacion...
    "%PVSYSTCLI%" run-simulation -w:"%WS%" -p:"!PRJ_FILE!" -v:"!VARIANT!" -ts:hour -s:"!SIT_FULL!" -imf:"!MET_OUT!" !SFI_ARG! -ocf:"!RES_CSV!" -odc -rpf:"!RES_PDF!" -rl:en > "!TMP_OUT!" 2>&1
)

REM 3. Comprobacion definitiva: si falta CSV o PDF, fallo
IF NOT EXIST "!RES_CSV!" (
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: No se genero el CSV de resultados. Salida CLI:
    type "!TMP_OUT!" >> "%BUF%"
    del "!TMP_OUT!" >nul 2>&1
    exit /b 1
)
IF NOT EXIST "!RES_PDF!" (
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: No se genero el PDF de resultados. Salida CLI:
    type "!TMP_OUT!" >> "%BUF%"
    REM Borramos el CSV local huerfano para no acumular basura en projects\
    del /Q "!RES_CSV!" >nul 2>&1
    del "!TMP_OUT!" >nul 2>&1
    exit /b 1
)
del "!TMP_OUT!" >nul 2>&1

REM 4. Los resultados se quedan en RES_DIR_LOCAL. Python (main.py) los recoge
REM    desde ahi con buscar_ficheros_generados() y los sube a SharePoint via Graph
REM    (no movemos a OneDrive aqui — eso era la fuente original del problema de sync).
echo     - Resultados generados en !RES_DIR_LOCAL!\ (Python los subira vía Graph).

echo     - Eliminando CSV procesado del INBOX...
REM No se archiva el CSV procesado en ningun sitio: simplemente se borra.
del /Q "!CSV_FULL!" >nul 2>&1

>>"%BUF%" echo [ OK ] !CSV_BASENAME!
exit /b 0


:end
echo.
echo ============================================================
IF !EXIT_CODE! EQU 0 (
    IF DEFINED TOTAL (
        echo  ESTADO: OK
        echo  Procesados:  !TOTAL!
        echo  Correctos:   !TOTAL_OK!
        echo  Con error:   !TOTAL_ERR!
    ) ELSE (
        echo  OK
        IF DEFINED ERR_MSG echo  !ERR_MSG!
    )
) ELSE (
    IF !EXIT_CODE! EQU 20 (
        echo  ESTADO: COMPLETADO CON ERRORES
        echo  Procesados:  !TOTAL!
        echo  Correctos:   !TOTAL_OK!
        echo  Con error:   !TOTAL_ERR!
    ) ELSE (
        echo  ERROR codigo !EXIT_CODE!
        IF DEFINED ERR_MSG echo  !ERR_MSG!
    )
)
echo ============================================================

IF EXIST "%BUF%" (
    FOR %%S IN ("%BUF%") DO IF %%~zS GTR 0 (
        echo.
        echo --- Resumen de operaciones ---
        type "%BUF%"
    )
    del "%BUF%" >nul 2>&1
)

echo.
echo === FIN DEL SCRIPT ===
goto :eof
