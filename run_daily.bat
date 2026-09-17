@echo off
SETLOCAL EnableDelayedExpansion
cls

SET "EXIT_CODE=0"

SET "WS=C:\Users\PVSYST1\PVsyst8.1_Data"
SET "OPS=C:\Users\PVSYST1\PVSyst_CLI"
SET "INPUT=%OPS%\input"
SET "PVSYSTCLI=C:\Program Files\PVsyst8.1.4\PVsystCLI.exe"

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

REM Interprete de Python: hace falta para scripts\timeshift.py, que reparte el
REM desfase de T08_time_shifts entre el MEF y el -imt.
SET "PY="
where python >nul 2>&1
IF !ERRORLEVEL! EQU 0 SET "PY=python"
IF NOT DEFINED PY (
    where py >nul 2>&1
    IF !ERRORLEVEL! EQU 0 SET "PY=py"
)
IF NOT DEFINED PY (
    SET "ERR_MSG=No hay interprete Python en el PATH (hace falta para timeshift.py)"
    SET "EXIT_CODE=9"
    GOTO :end
)

IF NOT EXIST "%INPUT%\*.csv" (
    SET "ERR_MSG=No hay CSVs en input. Nada que procesar."
    SET "EXIT_CODE=0"
    GOTO :end
)

REM --- MENSAJE DE ARRANQUE PARA EL USUARIO ---
echo ============================================================
echo   INICIANDO PROCESAMIENTO AUTOMATICO
echo   PVsyst CLI esta trabajando en segundo plano...
echo   El proceso puede tardar varios minutos por simulacion.
echo   Por favor, no cierres esta ventana.
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
        echo     - [ERROR] Fallo en el procesamiento. Revisa el log al final.
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

REM --- Time-shift: T08_time_shifts (Excel) -^> CSV raw corregido + -imt del CLI ---
REM Mismo mecanismo que auto_run.bat (que es el que usa la automatizacion):
REM scripts\timeshift.py corrige los cambios de hora en una COPIA del CSV raw (en
REM las fechas que dice T08) y devuelve los minutos sueltos para este -imt.
REM El MEF no se toca. Fabric deshace el desplazamiento al ingerir.
SET "TS_OUT=%TEMP%\imt_!PLANTA!_%RANDOM%.txt"
SET "IMT="
SET "IMT_ARG="
SET "IMT_ABS=999"
SET "CSV_CONV="
IF EXIST "!TS_OUT!" del "!TS_OUT!" >nul 2>&1
"!PY!" "%~dp0timeshift.py" aplicar !PLANTA! --ws "%WS%" --csv "!CSV_FULL!" --out "!TS_OUT!"
IF !ERRORLEVEL! NEQ 0 (
    echo     - [ERROR] timeshift.py no pudo determinar el desfase de !PLANTA!.
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: timeshift.py fallo con el desfase de T08_time_shifts. No se simula para no falsear el PR.
    del "!TS_OUT!" >nul 2>&1
    exit /b 1
)
IF NOT EXIST "!TS_OUT!" (
    echo     - [ERROR] timeshift.py no devolvio el -imt.
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: timeshift.py no devolvio el -imt.
    exit /b 1
)
FOR /F "usebackq tokens=1,* delims==" %%A IN ("!TS_OUT!") DO (
    IF /I "%%A"=="imt" SET "IMT=%%B"
    IF /I "%%A"=="csv" SET "CSV_CONV=%%B"
)
del "!TS_OUT!" >nul 2>&1
IF DEFINED IMT SET "IMT=!IMT: =!"
IF NOT DEFINED IMT (
    echo     - [ERROR] timeshift.py no devolvio el -imt.
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: timeshift.py no devolvio el -imt.
    exit /b 1
)
IF NOT DEFINED CSV_CONV SET "CSV_CONV=!CSV_FULL!"
IF NOT EXIST "!CSV_CONV!" (
    echo     - [ERROR] el CSV que hay que convertir no existe: !CSV_CONV!
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: timeshift.py apunto a un CSV que no existe ^(!CSV_CONV!^).
    exit /b 1
)
SET /A "IMT_ABS=IMT*((IMT>>31)|1)" 2>nul
IF !IMT_ABS! GTR 30 (
    echo     - [ERROR] -imt no valido o fuera de rango: '!IMT!' min.
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: -imt='!IMT!' no es un entero de [-30;+30]. Revisa time_shift de !PLANTA! en T08_time_shifts.
    exit /b 1
)
IF NOT "!IMT!"=="0" SET "IMT_ARG=-imt:!IMT!"
IF DEFINED IMT_ARG (
    echo     - Time-shift aplicado: !IMT_ARG! ^(minutos sueltos de T08; las horas van en el CSV^)
    >>"%BUF%" echo [INFO] !CSV_BASENAME!: -imt aplicado = !IMT_ARG! ^(minutos sueltos de T08^)
) ELSE (
    echo     - Time-shift: 0 minutos sueltos, se omite -imt
    >>"%BUF%" echo [INFO] !CSV_BASENAME!: 0 minutos sueltos; -imt omitido.
)

REM PVsyst CLI ignora -omf: si apunta fuera del workspace, asi que
REM escribimos el MET intermedio dentro de %WS%\Meteo (donde PVsyst lo pone).
SET "MET_OUT=%WS%\Meteo\!PLANTA!.MET"
SET "RES_DIR=!PROJECT_DIR!\results_out"
SET "RES_CSV=!RES_DIR!\!PLANTA!.csv"
SET "RES_PDF=!RES_DIR!\!PLANTA!.pdf"
IF NOT EXIST "!RES_DIR!" mkdir "!RES_DIR!" 2>nul

SET "TMP_OUT=%TEMP%\pvsyst_%RANDOM%.txt"

echo     - Convirtiendo datos meteorologicos a .MET ...
"%PVSYSTCLI%" convert-meteo -icf:"!CSV_CONV!" -imf:"!MEF_FULL!" -isf:"!SIT_FULL!" -omf:"!MET_OUT!" !IMT_ARG! > "!TMP_OUT!" 2>&1
SET "RC_CONV=!ERRORLEVEL!"
IF /I NOT "!CSV_CONV!"=="!CSV_FULL!" del /Q "!CSV_CONV!" >nul 2>&1
IF !RC_CONV! NEQ 0 (
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

REM 3. Comprobacion definitiva: ¿existe el CSV o no?
IF NOT EXIST "!RES_CSV!" (
    >>"%BUF%" echo [FAIL] !CSV_BASENAME!: Error critico en run-simulation. Salida CLI:
    type "!TMP_OUT!" >> "%BUF%"
    del "!TMP_OUT!" >nul 2>&1
    exit /b 1
)
del "!TMP_OUT!" >nul 2>&1

echo     - Limpiando y moviendo archivos procesados...
SET "HIST_DIR=!PROJECT_DIR!\meteo_in"
IF NOT EXIST "!HIST_DIR!" mkdir "!HIST_DIR!" 2>nul
move /Y "!CSV_FULL!" "!HIST_DIR!\" >nul 2>&1

>>"%BUF%" echo [ OK ] !CSV_BASENAME! a projects\!PLANTA!\results_out\
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
pause
ENDLOCAL
exit /b %EXIT_CODE%