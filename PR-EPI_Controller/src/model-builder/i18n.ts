//-----------------------------------------------------------------------
// Workbook labels (EN / ES). Column headers of sensors keep the
// convention "POA 01 (W/m2)" in both languages.
//-----------------------------------------------------------------------

export type Lang = "EN" | "ES";

const T = {
    EN: {
        sSummary: "00 Summary",
        sCharts: "00b Charts",
        sInputs: "01 Inputs",
        sMap: "02 Sensor Map",
        sData: "03 Raw Data & Filtering",
        sDataPR: "03 Data & Criteria",
        sMeteo: "04 PVsyst Meteo",
        sDailyPR: "04 Daily Results",
        sPvsyst: "05 PVsyst Results",
        sMeter: "05b Meter",
        sComp: "06 Production Comparison",
        sDaily: "07 Daily Summary",
        passPr: "The plant has successfully completed the performance test.",
        incomplete: "Test not complete: fewer valid days than required. The result below is provisional.",
        failPr: "The plant has NOT completed the performance test. The results do not reach the contractual minimum.",
        from: "From",
        to: "to",
    },
    ES: {
        sSummary: "00 Resumen",
        sCharts: "00b Gráficos",
        sInputs: "01 Inputs",
        sMap: "02 Mapa sensores",
        sData: "03 Datos y filtrado",
        sDataPR: "03 Datos y criterios",
        sMeteo: "04 Meteo PVsyst",
        sDailyPR: "04 Resultados diarios",
        sPvsyst: "05 Resultados PVsyst",
        sMeter: "05b Contador",
        sComp: "06 Comparativa produccion",
        sDaily: "07 Resumen diario",
        passPr: "La planta ha finalizado con éxito las pruebas de performance.",
        incomplete: "Prueba no completada: hay menos días válidos de los requeridos. El resultado es provisional.",
        failPr: "La planta NO ha finalizado las pruebas de performance. Los resultados no cumplen con el mínimo contractual.",
        from: "Desde",
        to: "a",
    },
} as const;

export function tr(lang: Lang) {
    return T[lang];
}
