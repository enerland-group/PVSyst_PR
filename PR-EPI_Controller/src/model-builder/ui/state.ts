//-----------------------------------------------------------------------
// Wizard state shared by the steps.
//-----------------------------------------------------------------------

import type { Artifacts } from "../workbook";
import type { ImportStats } from "../import";
import type { Dataset, ModelConfig, PvsystTable, RawTable } from "../types";

export interface WizardData {
    cfg: ModelConfig;
    scada: RawTable | null;
    restored: { ds: Dataset; stats: ImportStats } | null;
    restoredFrom: string;
    pvsyst: PvsystTable | null;
    meterRaw: RawTable | null;
}

export type StepKey = "project" | "data" | "sensors" | "filter" | "criteria" | "exclusions" | "review" | "pvexport" | "results" | "contract" | "generate";
export interface StepDef { k: StepKey; t: string; s: string; stage?: string }

export const STEPS_EPI: StepDef[] = [
    { k: "project", t: "Project", s: "Name, code, test type", stage: "Stage 1 · Measured data" },
    { k: "data", t: "SCADA data", s: "Import and clean" },
    { k: "sensors", t: "Sensor mapping", s: "Rename SCADA columns" },
    { k: "filter", t: "Sensor filtering", s: "Outliers, dispersion, albedo" },
    { k: "criteria", t: "Validity criteria", s: "Which intervals and days count" },
    { k: "exclusions", t: "Exclusions", s: "Events not attributable" },
    { k: "pvexport", t: "Data review & export", s: "Charts, meteo CSV for PVsyst" },
    { k: "results", t: "PVsyst & meter", s: "Simulation and production", stage: "Stage 2 · Comparison" },
    { k: "contract", t: "Contract", s: "Guarantee and test rules" },
    { k: "generate", t: "Generate", s: "Review and download" },
];
export const STEPS_PR: StepDef[] = [
    { k: "project", t: "Project", s: "Name, code, test type" },
    { k: "data", t: "SCADA & meter data", s: "Import and clean" },
    { k: "sensors", t: "Sensor mapping", s: "Rename SCADA columns" },
    { k: "filter", t: "Sensor filtering", s: "Outliers, dispersion" },
    { k: "criteria", t: "Validity criteria", s: "Which intervals and days count" },
    { k: "exclusions", t: "Exclusions", s: "Events not attributable" },
    { k: "review", t: "Data review", s: "Charts of the measurements" },
    { k: "contract", t: "Contract", s: "PR inputs, monthly values" },
    { k: "generate", t: "Generate", s: "Review and download" },
];

export interface StepProps {
    d: WizardData;
    setD: (fn: (d: WizardData) => WizardData) => void;
    /** Mutate a copy of the config. */
    edit: (fn: (c: ModelConfig) => void) => void;
    art: (Artifacts & { stats: ImportStats }) | null;
    err: string | null;
    go: (k: StepKey) => void;
    notify: (m: string) => void;
}
