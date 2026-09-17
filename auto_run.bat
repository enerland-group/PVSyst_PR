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
SET "PVSYSTCLI=C:\Program Files\PVsyst8.1.4\PVsystCLI.exe"

REM Fecha de la ejecucion en formato YYYYMMDD (independiente del locale)
FOR /F "tokens=2 delims==" %%I IN ('wmic os get LocalDateTime /value 2^>nul ^| find "="') DO SET "DT=%%I"
SET "FECHA=!DT:~0,8!"
IF "!FECHA!"=="" (
    REM Fallback por si wmic no esta disponible
    FOR /F %%I IN ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') DO SET "FECHA=%%I"
)

REM %BUF% guarda SOLO el veredicto de una linea por CSV ([ OK ] / [FAIL] / [SKIP]),
REM que es lo que se imprime al final como indice. El detalle (avisos, salida del
REM CLI, motivo del fallo) va inline, donde ocurre, y NO se repite aqui: como todo
REM el .bat esta redirigido al mismo fichero (linea 11), duplicarlo solo obligaba a
REM leer el log dos veces. La linea "[ OK ] <csv>" la busca main.py:374 para saber
REM que CSV salio bien: no cambiar ese formato.
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

REM Interprete de Python: hace falta para scripts\timeshift.py, que es quien
REM reparte el desfase de T08_time_shifts entre el MEF y el -imt. Sin el no se
REM puede saber el desfase, y simular sin saberlo falsearia el PR sin avisar.
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
IF NOT EXIST "%~dp0timeshift.py" (
    SET "ERR_MSG=Falta %~dp0timeshift.py (reparte el desfase de T08 entre MEF y -imt)"
    SET "EXIT_CODE=9"
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
        REM El motivo concreto y la salida del CLI ya se han escrito arriba, en el
        REM punto donde fallo. Aqui no se repite nada.
        SET /A TOTAL_ERR+=1
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
    SET "MOTIVO=planta '!PLANTA!' no esta dada de alta."
    call :skip
    exit /b 1
)
IF NOT EXIST "!PROJECT_DIR!" (
    SET "MOTIVO=carpeta de proyecto no existe: !PROJECT_DIR!"
    call :skip
    exit /b 1
)
IF NOT EXIST "!VAR_FILE!" (
    SET "MOTIVO=falta variant.txt en !PROJECT_DIR!"
    call :skip
    exit /b 1
)
IF NOT EXIST "!SIT_FULL!" (
    SET "MOTIVO=falta el SIT en el workspace: !SIT_FULL!"
    call :skip
    exit /b 1
)
IF NOT EXIST "!MEF_FULL!" (
    SET "MOTIVO=falta el MEF en el workspace: !MEF_FULL!"
    call :skip
    exit /b 1
)

SET "VARIANT="
SET /P VARIANT=<"!VAR_FILE!"
IF "!VARIANT!"=="" (
    SET "MOTIVO=variant.txt vacio."
    call :skip
    exit /b 1
)

REM --- Time-shift: T08_time_shifts (Excel) -^> CSV raw corregido + -imt del CLI ---
REM El desfase TOTAL de la planta lo declara el usuario en la tabla
REM T08_time_shifts de plants_config.xlsx, junto con las FECHAS de los cambios de
REM hora. Ese total se atiende en dos sitios, porque el CLI solo admite -imt
REM entre -30 y +30 minutos:
REM
REM   horas enteras   -^> se corrigen las FECHAS DEL CSV RAW (lo hace timeshift.py)
REM   resto [-30;+30] -^> -imt de este convert-meteo
REM
REM En cada fecha de T08, timeshift.py mira el CSV: si falta una hora resta una
REM hora a todo lo posterior, si hay una hora repetida suma una hora, y si no hay
REM ni una cosa ni la otra no toca la hora (solo avisa). El CSV corregido es una
REM COPIA en %TEMP%\pvsyst_tsfix\ con el mismo nombre; el original no se toca y es
REM la copia la que va al -icf. El MEF ya NO se modifica.
REM
REM Fabric (csv_ingest) deshace el desplazamiento al ingerir el CSV de resultados
REM leyendo la MISMA tabla: existe solo dentro de PVsyst, para que la simulacion
REM use la posicion solar correcta, y las fechas que llegan al calculo de PR
REM siguen en la escala de tiempo del SCADA.
REM
REM El TimeShift del fichero de variante YA NO se usa para el -imt: se lee solo
REM como traza, para poder comparar en el log lo declarado con lo aplicado.
REM Si timeshift.py falla (Excel ilegible, CSV ilegible...) se aborta ESTE csv:
REM sin saber el desfase, simular falsearia el PR sin avisar. El csv se queda en
REM el /inbox/ de SharePoint y se reintenta al ciclo siguiente.
REM Para diagnosticar el desfase: scripts\check_timeshift.py
REM Para ver la tabla:             python timeshift.py mostrar
REM Para ver que hay en las fechas: python timeshift.py revisar ^<PLANTA^> --csv ^<csv^>
SET "VARIANT_FILE=%WS%\Projects\!PLANTA!.!VARIANT!"
SET "V_HOURSHIFT="
SET "V_TOTALMIN="
SET "V_TSHIFT="
SET "V_TIMEZONE="
FOR /F "tokens=2 delims==" %%T IN ('findstr /R /C:"^ *TimeZone=" "!SIT_FULL!"') DO SET "V_TIMEZONE=%%T"

REM La variante activa la dice projects\<PLANTA>\variant.txt; el fichero tiene que
REM existir de verdad en el workspace. Si no, run-simulation tampoco arrancaria:
REM mejor abortar aqui con un mensaje que senale el variant.txt.
IF NOT EXIST "!VARIANT_FILE!" (
    SET "MOTIVO=variant.txt dice '!VARIANT!' pero no existe !VARIANT_FILE!. Revisa projects\!PLANTA!\variant.txt. SIT TimeZone=!V_TIMEZONE! h."
    call :fail
    exit /b 1
)
REM El patron "^ *TimeShift=" exige el '=' pegado, asi que no captura
REM TimeShiftTotalMin. Si hay varias coincidencias gana la ultima.
FOR /F "tokens=2 delims==" %%T IN ('findstr /R /C:"^ *TimeShift=" "!VARIANT_FILE!"') DO SET "V_TSHIFT=%%T"
FOR /F "tokens=2 delims==" %%T IN ('findstr /R /C:"^ *HourShift=" "!VARIANT_FILE!"') DO SET "V_HOURSHIFT=%%T"
FOR /F "tokens=2 delims==" %%T IN ('findstr /R /C:"^ *TimeShiftTotalMin=" "!VARIANT_FILE!"') DO SET "V_TOTALMIN=%%T"

REM Traza de lo declarado (ya no manda nada, pero sirve para contrastar cuando algo
REM no cuadra). Va inline, una sola vez, justo antes del reparto del desfase.
echo     - variante !VARIANT! ^| SIT TimeZone=!V_TIMEZONE! h ^| traza variante: TimeShift=!V_TSHIFT! min, HourShift=!V_HOURSHIFT! h, TimeShiftTotalMin=!V_TOTALMIN!

REM timeshift.py: corrige las horas en una copia del CSV y deja en !TS_OUT! un
REM fichero clave=valor con los minutos del -imt y el CSV que hay que convertir.
REM Su salida por pantalla va al log de esta corrida.
SET "TS_OUT=%TEMP%\imt_!PLANTA!_%RANDOM%.txt"
SET "IMT_NUM="
SET "IMT_ARG="
SET "IMT_ABS="
SET "CSV_CONV="
IF EXIST "!TS_OUT!" del "!TS_OUT!" >nul 2>&1
"!PY!" "%~dp0timeshift.py" aplicar !PLANTA! --ws "%WS%" --csv "!CSV_FULL!" --out "!TS_OUT!"
IF !ERRORLEVEL! NEQ 0 (
    SET "MOTIVO=timeshift.py fallo con el desfase de T08_time_shifts. El detalle lo acaba de imprimir el propio timeshift.py, justo aqui arriba. No se simula para no falsear el PR."
    call :fail
    del "!TS_OUT!" >nul 2>&1
    exit /b 1
)
IF NOT EXIST "!TS_OUT!" (
    SET "MOTIVO=timeshift.py termino bien pero no escribio !TS_OUT!."
    call :fail
    exit /b 1
)
FOR /F "usebackq tokens=1,* delims==" %%A IN ("!TS_OUT!") DO (
    IF /I "%%A"=="imt" SET "IMT_NUM=%%B"
    IF /I "%%A"=="csv" SET "CSV_CONV=%%B"
)
del "!TS_OUT!" >nul 2>&1

REM Si no ha habido cambios de hora que corregir, se convierte el CSV original.
IF NOT DEFINED CSV_CONV SET "CSV_CONV=!CSV_FULL!"
IF NOT EXIST "!CSV_CONV!" (
    SET "MOTIVO=timeshift.py apunto a un CSV que no existe: !CSV_CONV!"
    call :fail
    exit /b 1
)
REM Que se ha corregido la hora ya lo ha dicho la linea [TIME-SHIFT] de
REM timeshift.py; la ruta de la copia se ve abajo, en la linea del convert-meteo.

REM Cinturon y tirantes: el reparto ya garantiza |resto| ^<= 30, pero se vuelve a
REM comprobar aqui porque un -imt fuera de rango es exactamente el fallo que
REM estamos evitando. El valor absoluto se calcula con aritmetica (el IF de cmd
REM no compara negativos de forma fiable).
IF DEFINED IMT_NUM SET "IMT_NUM=!IMT_NUM: =!"
IF NOT DEFINED IMT_NUM (
    SET "MOTIVO=timeshift.py devolvio un -imt vacio."
    call :fail
    exit /b 1
)
REM IMT_ABS arranca fuera de rango a proposito: si el SET /A no consigue evaluar
REM el valor (no era un entero), se queda en 999 y el fichero se aborta.
SET "IMT_ABS=999"
SET /A "IMT_ABS=IMT_NUM*((IMT_NUM>>31)|1)" 2>nul
IF !IMT_ABS! GTR 30 (
    SET "MOTIVO=-imt='!IMT_NUM!' no es un entero de [-30;+30]. Revisa time_shift de !PLANTA! en T08_time_shifts."
    call :fail
    exit /b 1
)

REM Con resto 0 no se pasa -imt: las horas ya van corregidas en el propio CSV.
REM No se escribe nada: la linea [TIME-SHIFT] de timeshift.py ya dice el -imt
REM aplicado (o "sin -imt"), asi que anotarlo aqui otra vez sobraba.
IF NOT "!IMT_NUM!"=="0" SET "IMT_ARG=-imt:!IMT_NUM!"


REM Resultados a carpeta LOCAL del proyecto. Python los recoge desde ahi y los
REM sube a SharePoint vía Microsoft Graph (no dependemos de OneDrive sync).
SET "MET_OUT=%WS%\Meteo\!PLANTA!.MET"
SET "RES_DIR_LOCAL=!PROJECT_DIR!\results_out"
SET "RES_CSV=!RES_DIR_LOCAL!\!PLANTA!_!FECHA!.csv"
REM RES_PDF solo se usa si se reactiva el -rpf (ver "INFORME PDF DESACTIVADO").
SET "RES_PDF=!RES_DIR_LOCAL!\!PLANTA!_!FECHA!.pdf"
IF NOT EXIST "!RES_DIR_LOCAL!" mkdir "!RES_DIR_LOCAL!" 2>nul

REM El CSV de resultados se llama igual en todas las ejecuciones
REM (!PLANTA!_!FECHA!.csv): FECHA sale de "wmic os get LocalDateTime", que ya no
REM existe en este Windows, asi que !DT! llega vacia y FECHA se queda en el
REM literal "~0,8" (de ahi los FRA_~0,8.csv / PL1_~0,8.csv de SharePoint).
REM Con el CSV de AYER delante, TODOS los "IF NOT EXIST !RES_CSV!" de abajo son
REM falsos: ni salta el pseudo-subhorario ni falla la comprobacion final. El
REM .bat da [EXITO], main.py no sube nada (filtra por mtime) y la planta se
REM queda congelada con la simulacion vieja. Es lo que le paso a FRA desde el
REM 01/09/2026. Se borra antes de simular: si al final existe, es porque lo ha
REM escrito ESTE run.
del /Q "!RES_CSV!" >nul 2>&1

REM Un registro por llamada al CLI. El del subhorario se guarda aparte del
REM horario: antes el reintento sobrescribia el fichero y, si el subhorario habia
REM fallado por otra cosa, ese error se perdia sin dejar rastro.
SET "TMP_CONV=%TEMP%\pvsyst_conv_%RANDOM%.txt"
SET "TMP_SUB=%TEMP%\pvsyst_sub_%RANDOM%.txt"
SET "TMP_HOUR=%TEMP%\pvsyst_hour_%RANDOM%.txt"
SET "TMP_PSEUDO=%TEMP%\pvsyst_pseudo_%RANDOM%.txt"
SET "TMP_AGG=%TEMP%\pvsyst_agg_%RANDOM%.txt"

echo     - Convirtiendo a .MET desde !CSV_CONV! ...
"%PVSYSTCLI%" convert-meteo -icf:"!CSV_CONV!" -imf:"!MEF_FULL!" -isf:"!SIT_FULL!" -omf:"!MET_OUT!" !IMT_ARG! > "!TMP_CONV!" 2>&1
SET "RC_CONV=!ERRORLEVEL!"

REM OJO: la copia con las horas corregidas (CSV_CONV) YA NO se borra aqui como
REM antes. El procedimiento pseudo-subhorario (mas abajo) la necesita intacta si
REM el subhorario nativo llega a fallar, asi que el borrado se ha movido a
REM despues de toda la simulacion (justo antes del paso 3).

IF !RC_CONV! NEQ 0 (
    SET "MOTIVO=convert-meteo fallo con codigo !RC_CONV!."
    call :fail
    SET "DUMP_ETIQ=convert-meteo"
    SET "DUMP_FILE=!TMP_CONV!"
    call :volcar
    call :limpiar_tmp
    exit /b 1
)
IF NOT EXIST "!MET_OUT!" (
    SET "MOTIVO=convert-meteo no genero el MET en !MET_OUT!."
    call :fail
    SET "DUMP_ETIQ=convert-meteo"
    SET "DUMP_FILE=!TMP_CONV!"
    call :volcar
    call :limpiar_tmp
    exit /b 1
)

SET "SFI_ARG="
IF EXIST "!SFI_FULL!" SET "SFI_ARG=-isf:"!SFI_FULL!""

REM --- INFORME PDF DESACTIVADO (31/08/2026) ------------------------------------
REM Solo se quiere el CSV de resultados. main.py sube lo que encuentre en
REM results_out y no exige el PDF, asi que dejar de generarlo no rompe nada.
REM PARA VOLVER A GENERARLO: comenta la linea "SET RPF_ARG=" de abajo,
REM descomenta la siguiente, y descomenta tambien el bloque de comprobacion
REM del PDF marcado mas abajo como [PDF DESACTIVADO].
SET "RPF_ARG="
REM SET "RPF_ARG=-rpf:"!RES_PDF!""

REM --- aggregate_by_hour: T01_plants (plants_config.xlsx) decide el modo ---
REM pseudo_subhour.py "modo" NUNCA hace fallar el CSV: si no puede leer la tabla
REM (Excel inaccesible, planta sin fila, columna ausente...) imprime "false" y
REM avisa por stderr, y aqui se sigue exactamente como si la planta no estuviera
REM marcada (se intenta subhour primero, el comportamiento de siempre).
SET "AGG_HOUR=false"
"!PY!" "%~dp0pseudo_subhour.py" modo !PLANTA! > "!TMP_AGG!" 2>&1
IF EXIST "!TMP_AGG!" (
    FOR /F "usebackq delims=" %%L IN ("!TMP_AGG!") DO (
        IF /I "%%L"=="true"  SET "AGG_HOUR=true"
        IF /I "%%L"=="false" SET "AGG_HOUR=false"
    )
)

IF /I "!AGG_HOUR!"=="true" (
    REM aggregate_by_hour=true: no tiene sentido intentar subhorario.
    echo     - [MODO] !PLANTA!: aggregate_by_hour=true en T01_plants -^> horario directo, sin intentar subhorario...
    "%PVSYSTCLI%" run-simulation -w:"%WS%" -p:"!PRJ_FILE!" -v:"!VARIANT!" -ts:hour -s:"!SIT_FULL!" -imf:"!MET_OUT!" !SFI_ARG! -ocf:"!RES_CSV!" -odc !RPF_ARG! -rl:en > "!TMP_HOUR!" 2>&1
) ELSE (
    REM 1. Intentamos primero con subhour
    echo     - Ejecutando simulacion en modo subhorario, esto puede tardar...
    "%PVSYSTCLI%" run-simulation -w:"%WS%" -p:"!PRJ_FILE!" -v:"!VARIANT!" -ts:subhour -s:"!SIT_FULL!" -imf:"!MET_OUT!" !SFI_ARG! -ocf:"!RES_CSV!" -odc !RPF_ARG! -rl:en > "!TMP_SUB!" 2>&1

    REM 2. Si el subhorario nativo no ha generado el CSV, procedimiento alternativo
    REM    (ver documentacion "pseudo-sub-hourly simulation"): particion por minuto
    REM    mas N veces -ts:hour mas recombinacion, todo en pseudo_subhour.py.
    REM    OJO: se prueba SIEMPRE, sea cual sea el motivo del fallo -- incluido el
    REM    mensaje "weather data is hourly". Comprobado con datos reales de FRA
    REM    (2026-09-02): PVsyst da ese mismo mensaje aunque el CSV raw sea
    REM    genuinamente cuarto-horario (con variabilidad real entre los 4 grupos),
    REM    asi que NO es señal fiable de "esta planta es horaria de verdad". Si de
    REM    verdad lo es, pseudo_subhour.py lo detecta solo (un unico grupo) y el
    REM    resultado es equivalente al -ts:hour de siempre, solo un poco mas lento.
    IF NOT EXIST "!RES_CSV!" (
        findstr /i /c:"weather data is hourly" "!TMP_SUB!" >nul
        IF !ERRORLEVEL! EQU 0 (
            REM El texto "PVsyst rechazo subhour" lo busca main.py para el log; no
            REM cambiar esta linea aunque ya no condicione que camino se sigue.
            echo     - [WARN] PVsyst rechazo subhour: dice que los datos son horarios. Probando procedimiento pseudo-subhorario, particion por minuto...
        ) ELSE (
            echo     - [WARN] Simulacion subhoraria fallo sin generar CSV. Probando procedimiento pseudo-subhorario, particion por minuto...
        )
        "!PY!" "%~dp0pseudo_subhour.py" ejecutar !PLANTA! --ws "%WS%" --cli "%PVSYSTCLI%" --prj "!PRJ_FILE!" --variant "!VARIANT!" --sit "!SIT_FULL!" --mef "!MEF_FULL!" --csv "!CSV_CONV!" --imt "!IMT_NUM!" --sfi "!SFI_FULL!" --out "!RES_CSV!" > "!TMP_PSEUDO!" 2>&1
        IF !ERRORLEVEL! EQU 0 (
            echo     - [OK] Pseudo-subhorario completado:
            type "!TMP_PSEUDO!"
        )
    )
)

REM La copia con las horas corregidas ya no hace falta: la simulacion (normal o,
REM si ha hecho falta, el pseudo-subhorario) ya la ha consumido.
IF /I NOT "!CSV_CONV!"=="!CSV_FULL!" del /Q "!CSV_CONV!" >nul 2>&1

REM 3. Comprobacion definitiva: si falta el CSV, fallo. Se vuelca entero lo que
REM    ha dicho el CLI en todos los intentos, aqui mismo: es lo unico que explica
REM    por que PVsyst no ha querido simular.
IF NOT EXIST "!RES_CSV!" (
    SET "MOTIVO=run-simulation no genero el CSV de resultados (ni horario/subhorario ni pseudo-subhorario)."
    call :fail
    call :volcar_sim
    call :limpiar_tmp
    exit /b 1
)
REM --- [PDF DESACTIVADO] (31/08/2026) -------------------------------------------
REM Ya no se pide el PDF (ver "INFORME PDF DESACTIVADO" mas arriba), asi que
REM esta comprobacion fallaria SIEMPRE y, peor, borraria el CSV bueno.
REM Se descomenta ENTERA solo si se vuelve a activar el -rpf.
REM IF NOT EXIST "!RES_PDF!" (
REM     SET "MOTIVO=run-simulation no genero el PDF de resultados."
REM     call :fail
REM     call :volcar_sim
REM     Borramos el CSV local huerfano para no acumular basura en projects
REM     del /Q "!RES_CSV!" >nul 2>&1
REM     call :limpiar_tmp
REM     exit /b 1
REM )
call :limpiar_tmp

REM 4. Los resultados se quedan en RES_DIR_LOCAL. Python (main.py) los recoge
REM    desde ahi con buscar_ficheros_generados() y los sube a SharePoint via Graph
REM    (no movemos a OneDrive aqui — eso era la fuente original del problema de sync).
echo     - Resultados generados en !RES_DIR_LOCAL!\ (Python los subira vía Graph).

echo     - Eliminando CSV procesado del INBOX...
REM No se archiva el CSV procesado en ningun sitio: simplemente se borra.
del /Q "!CSV_FULL!" >nul 2>&1

REM main.py:374 busca esta linea literal para saber que el CSV salio bien.
>>"%BUF%" echo [ OK ] !CSV_BASENAME!
exit /b 0


REM ---------------------------------------------------------------------------
REM  Subrutinas de log. La norma es: cada cosa se escribe UNA vez, donde pasa.
REM  Al %BUF% solo va el veredicto de una linea, que es el indice del final.
REM  El motivo viaja en !MOTIVO! (y no como argumento) para que los parentesis y
REM  las comillas de las rutas no rompan el parseo dentro de los bloques IF.
REM ---------------------------------------------------------------------------

:fail
echo     - [FAIL] !MOTIVO!
>>"%BUF%" echo [FAIL] !CSV_BASENAME!: !MOTIVO!
goto :eof

:skip
echo     - [SKIP] !MOTIVO!
>>"%BUF%" echo [SKIP] !CSV_BASENAME!: !MOTIVO!
goto :eof

REM Vuelca entero el registro de una llamada al CLI: !DUMP_FILE! el fichero,
REM !DUMP_ETIQ! la orden que lo genero.
:volcar
echo       ---------- salida de PVsystCLI ^(!DUMP_ETIQ!^) ----------
IF NOT EXIST "!DUMP_FILE!" (
    echo       ^(el CLI no dejo registro^)
) ELSE (
    SET "DUMP_VACIO=1"
    FOR %%S IN ("!DUMP_FILE!") DO IF %%~zS GTR 0 SET "DUMP_VACIO="
    IF DEFINED DUMP_VACIO (
        echo       ^(sin salida^)
    ) ELSE (
        type "!DUMP_FILE!"
    )
)
echo       ---------- fin salida ^(!DUMP_ETIQ!^) ----------
goto :eof

REM Los intentos de simulacion que se hayan hecho de verdad: subhour solo existe
REM si se intento (no con aggregate_by_hour=true), horario solo si hubo
REM reintento/modo directo, y pseudo solo si el subhorario fallo sin ser "datos
REM horarios".
:volcar_sim
IF EXIST "!TMP_SUB!" (
    SET "DUMP_ETIQ=run-simulation -ts:subhour"
    SET "DUMP_FILE=!TMP_SUB!"
    call :volcar
)
IF EXIST "!TMP_HOUR!" (
    SET "DUMP_ETIQ=run-simulation -ts:hour"
    SET "DUMP_FILE=!TMP_HOUR!"
    call :volcar
)
IF EXIST "!TMP_PSEUDO!" (
    SET "DUMP_ETIQ=pseudo_subhour.py ejecutar"
    SET "DUMP_FILE=!TMP_PSEUDO!"
    call :volcar
)
goto :eof

:limpiar_tmp
del "!TMP_CONV!"   >nul 2>&1
del "!TMP_SUB!"    >nul 2>&1
del "!TMP_HOUR!"   >nul 2>&1
del "!TMP_PSEUDO!" >nul 2>&1
del "!TMP_AGG!"    >nul 2>&1
goto :eof


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

REM Indice: una linea por CSV. El detalle de cada uno esta mas arriba, en su
REM bloque, y no se repite aqui.
IF EXIST "%BUF%" (
    FOR %%S IN ("%BUF%") DO IF %%~zS GTR 0 (
        echo.
        echo --- Resumen por fichero ---
        type "%BUF%"
    )
    del "%BUF%" >nul 2>&1
)

echo.
echo === FIN DEL SCRIPT ===
goto :eof
