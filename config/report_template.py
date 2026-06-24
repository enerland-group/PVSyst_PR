"""
report_template.py
──────────────────
Generates a self-contained HTML Performance Ratio report.
Style: technical / engineering — white background, dark-blue brand, Enerlandgroup logo.

Entry point:
    render_html(pr_result, audit, cfg, resolution) -> str
"""
from __future__ import annotations
import json
from datetime import datetime

# Logo embedded from enerland.ico (256x256 PNG, base64)
try:
    from config._logo_b64 import LOGO_B64 as _LOGO_B64
except ImportError:
    try:
        from _logo_b64 import LOGO_B64 as _LOGO_B64
    except ImportError:
        _LOGO_B64 = ""   # fallback: no logo

_LOGO_HTML = (
    f'<img src="data:image/png;base64,{_LOGO_B64}" height="44" alt="Enerlandgroup" '
    f'style="display:block;height:44px;width:auto;">'
    if _LOGO_B64 else
    '<span style="font:700 20px/1 Segoe UI,sans-serif;color:#fff;letter-spacing:0.05em">ENERLANDGROUP</span>'
)


_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{plant_name} — PR Test Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
/* ── Design tokens ─────────────────────────────────────── */
:root {{
  --brand:        #1b3d6e;   /* dark navy blue */
  --brand-dark:   #0d2444;
  --brand-light:  #e8eef8;
  --brand-mid:    #2e6ab5;
  --border:       #b8cce0;
  --border-table: #d5e2f0;
  --bg:           #ffffff;
  --bg-alt:       #f4f7fb;
  --bg-header:    #0d2444;
  --text:         #1a1a1a;
  --text-muted:   #5a6672;
  --pass:         #1a7a3c;
  --pass-bg:      #e8f5ee;
  --fail:         #c62828;
  --fail-bg:      #fdecea;
  --warn:         #e65100;
  --mono:         'Consolas', 'Courier New', monospace;
  --sans:         'Segoe UI', system-ui, -apple-system, Arial, sans-serif;
}}

/* ── Reset ─────────────────────────────────────────────── */
*, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
}}
body {{ max-width: 1280px; margin: 0 auto; padding-bottom: 60px; }}

/* ── Top header bar ────────────────────────────────────── */
.page-header {{
  background: var(--bg-header);
  color: #fff;
  padding: 14px 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 3px solid var(--brand-mid);
}}
.page-header .logo-area {{
  display: flex;
  align-items: center;
  gap: 14px;
}}
.page-header .report-label {{
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.8;
  line-height: 1.7;
  text-align: right;
}}
.page-header .report-label strong {{
  display: block;
  font-size: 13px;
  opacity: 1;
  letter-spacing: 0.04em;
  color: #fff;
}}

/* ── Content wrapper ───────────────────────────────────── */
.content {{ padding: 28px 40px 0; }}

/* ── Report title strip ────────────────────────────────── */
.report-title-bar {{
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  border-bottom: 2px solid var(--brand);
  padding-bottom: 10px;
  margin-bottom: 24px;
}}
.report-title-bar h1 {{
  font-size: 21px;
  font-weight: 700;
  color: var(--brand-dark);
  letter-spacing: -0.01em;
  line-height: 1.2;
}}
.report-title-bar h1 span {{
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  font-family: var(--mono);
  margin-top: 3px;
  letter-spacing: 0.06em;
}}
.report-meta {{
  text-align: right;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.85;
}}

/* ── Verdict card ──────────────────────────────────────── */
.verdict-card {{
  border: 1px solid var(--border);
  border-top: 3px solid {verdict_color_css};
  border-radius: 0 0 4px 4px;
  margin-bottom: 24px;
  overflow: hidden;
}}
.verdict-header {{
  background: var(--bg-alt);
  color: var(--text);
  padding: 12px 22px;
  display: flex;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--border);
}}
.verdict-badge {{
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #fff;
  background: {verdict_color_css};
  padding: 4px 14px;
  border-radius: 3px;
  white-space: nowrap;
}}
.verdict-desc {{
  font-size: 13px;
  color: var(--text-muted);
}}
.verdict-desc strong {{ color: {verdict_color_css}; }}
.verdict-body {{
  background: #fff;
  padding: 18px 22px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
}}
.verdict-body .kpi {{
  padding: 6px 16px;
  border-right: 1px solid var(--border-table);
}}
.verdict-body .kpi:first-child {{ padding-left: 0; }}
.verdict-body .kpi:last-child {{ border-right: none; }}
.kpi-label {{
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 4px;
}}
.kpi-value {{
  font-family: var(--mono);
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}}
.kpi-value.accent {{ color: {verdict_color_css}; }}
.kpi-value .unit {{
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  margin-left: 3px;
}}

/* ── Section headings ──────────────────────────────────── */
section {{ margin-bottom: 32px; }}
.section-head {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-left: 4px solid var(--brand);
  padding: 6px 10px 6px 12px;
  margin-bottom: 14px;
  background: var(--bg-alt);
  border-top: 1px solid var(--border-table);
  border-bottom: 1px solid var(--border-table);
  border-right: 1px solid var(--border-table);
  border-radius: 0 3px 3px 0;
}}
.section-head h2 {{
  font-size: 11px;
  font-family: var(--mono);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--brand-dark);
  font-weight: 700;
}}
.section-head .sub {{
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
}}

/* ── Chart ─────────────────────────────────────────────── */
.controls {{
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
}}
.controls button {{
  background: transparent;
  border: 1px solid var(--border);
  padding: 5px 13px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-muted);
  border-radius: 3px;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}}
.controls button.active {{
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}}
.controls button:hover:not(.active) {{
  background: var(--brand-light);
  border-color: var(--brand);
  color: var(--brand-dark);
}}
.chart-wrap {{
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  background: #fff;
  padding: 18px;
  height: 320px;
  border-radius: 0 4px 4px 0;
}}

/* ── Audit summary strip ───────────────────────────────── */
.audit-strip {{
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 18px;
}}
.audit-strip > div {{
  padding: 12px 16px;
  border-right: 1px solid var(--border);
  background: var(--bg-alt);
}}
.audit-strip > div:last-child {{ border-right: none; }}
.audit-strip .a-label {{
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 5px;
}}
.audit-strip .a-val {{
  font-family: var(--mono);
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}}
.audit-strip .a-val.green {{ color: var(--pass); }}

/* ── Criterion cards ───────────────────────────────────── */
.crit-grid {{
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}}
.crit-card {{
  border: 1px solid var(--border);
  border-top: 3px solid var(--brand);
  background: var(--bg-alt);
  padding: 12px 14px 14px;
  border-radius: 0 0 4px 4px;
}}
.crit-num {{
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--brand);
  font-weight: 700;
  margin-bottom: 3px;
}}
.crit-title {{
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
  min-height: 32px;
}}
.crit-stats {{
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 10px 0 8px;
}}
.crit-count {{
  font-family: var(--mono);
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}}
.crit-count .rejected {{
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted);
  letter-spacing: 0.08em;
  margin-left: 2px;
}}
.crit-pct {{
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 10px;
  background: var(--brand-light);
  color: var(--brand);
  letter-spacing: 0.04em;
}}
.crit-pct.bad {{
  background: #fdecea;
  color: var(--fail);
}}
.crit-ref {{
  font-weight: 400;
  opacity: 0.6;
  font-size: 10px;
}}
/* ── Info tooltip ──────────────────────────────────────── */
.crit-header {{
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}}
.info-btn {{
  flex-shrink: 0;
  width: 18px; height: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--brand);
  background: transparent;
  color: var(--brand);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
  margin-top: 1px;
  transition: background 0.15s, color 0.15s;
  position: relative;
}}
.info-btn:hover, .info-btn:focus {{ outline: none; background: var(--brand); color: #fff; }}
.tooltip {{
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  left: auto;
  width: 280px;
  background: var(--brand-dark);
  color: #fff;
  font-family: var(--sans);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.55;
  padding: 12px 14px;
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.25);
  z-index: 100;
  text-align: left;
  letter-spacing: 0;
  text-transform: none;
  cursor: default;
}}
.tooltip::before {{
  content: '';
  position: absolute;
  top: -6px; right: 5px;
  border: 6px solid transparent;
  border-top: none;
  border-bottom-color: var(--brand-dark);
}}
.tooltip .tip-norm {{
  display: inline-block;
  margin-top: 7px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: rgba(255,255,255,0.55);
  border-top: 1px solid rgba(255,255,255,0.15);
  padding-top: 7px;
  width: 100%;
}}
.info-btn:hover .tooltip,
.info-btn:focus .tooltip,
.info-btn.open .tooltip {{ display: block; }}
.crit-bar {{
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  overflow: hidden;
}}
.crit-bar > span {{
  display: block;
  height: 100%;
  background: var(--brand-mid);
  border-radius: 2px;
}}
.crit-bar.bad > span {{ background: var(--fail); }}

/* ── Tables ────────────────────────────────────────────── */
.two-col {{ display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }}
table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}}
th {{
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  background: var(--bg-alt);
  padding: 8px 10px;
  border: 1px solid var(--border-table);
  white-space: nowrap;
}}
th:first-child {{ border-left: 4px solid var(--brand); }}
td {{
  padding: 7px 10px;
  border: 1px solid var(--border-table);
  vertical-align: middle;
}}
td:first-child {{ border-left: 4px solid var(--border); }}
td.num {{
  font-family: var(--mono);
  text-align: right;
}}
td.delta-pos {{ color: var(--pass); font-family: var(--mono); text-align: right; font-weight: 700; }}
td.delta-neg {{ color: var(--fail); font-family: var(--mono); text-align: right; font-weight: 700; }}
tr:nth-child(even) td {{ background: var(--bg-alt); }}
tr:hover td {{ background: var(--brand-light); }}
tr.invalid td {{ color: #aaa; }}

/* ── Search input ──────────────────────────────────────── */
.search-bar {{ display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }}
.search-bar input {{
  flex: 1;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--brand);
  font-family: var(--mono);
  font-size: 12px;
  outline: none;
  background: #fff;
  border-radius: 0 3px 3px 0;
}}
.search-bar input:focus {{
  border-color: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-light);
}}

/* ── Status tags ───────────────────────────────────────── */
.tag {{
  display: inline-block;
  padding: 2px 7px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  border-radius: 2px;
  border: 1px solid currentColor;
  font-weight: 700;
}}
.tag.valid   {{ color: var(--pass); background: var(--pass-bg); }}
.tag.invalid {{ color: var(--text-muted); background: #f5f5f5; }}

/* ── Footer ────────────────────────────────────────────── */
footer {{
  background: var(--bg-header);
  color: rgba(255,255,255,0.65);
  padding: 13px 40px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 36px;
  gap: 16px;
}}
footer .footer-brand {{ color: #fff; font-weight: 700; font-size: 11px; }}

/* ── Print ─────────────────────────────────────────────── */
@media print {{
  .page-header {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
  .controls, .search-bar {{ display: none; }}
  .chart-wrap {{ break-inside: avoid; height: 260px; }}
  section {{ break-inside: avoid; }}
  .verdict-card {{ break-after: avoid; }}
  body {{ padding-bottom: 0; }}
}}
</style>
</head>
<body>

<!-- ── Page header ─────────────────────────────────────── -->
<div class="page-header">
  <div class="logo-area">
    {logo_html}
  </div>
  <div class="report-label">
    <strong>Performance Ratio Test Report</strong>
    IEC&nbsp;61724-2 &nbsp;·&nbsp; {plant_name}
  </div>
</div>

<!-- ── Content ─────────────────────────────────────────── -->
<div class="content">

  <!-- Title strip -->
  <div class="report-title-bar">
    <h1>
      {plant_name}
      <span>Performance Ratio Test &mdash; IEC&nbsp;61724-2</span>
    </h1>
    <div class="report-meta">
      Period:&nbsp;<strong>{period_human}</strong><br>
      Resolution:&nbsp;<strong>{resolution}</strong><br>
      Generated:&nbsp;<strong>{generated_at}</strong>
    </div>
  </div>

  <!-- ── Verdict ───────────────────────────────────────── -->
  <div class="verdict-card">
    <div class="verdict-header">
      <div class="verdict-badge">{verdict_word}</div>
      <div class="verdict-desc">
        Measured production is <strong>{delta_pct:+.2f}%</strong> {above_or_below} the guaranteed threshold.
      </div>
    </div>
    <div class="verdict-body">
      <div class="kpi">
        <div class="kpi-label">Guaranteed production</div>
        <div class="kpi-value">{guar_gwh:.3f}<span class="unit">GWh</span></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Measured production</div>
        <div class="kpi-value">{meas_gwh:.3f}<span class="unit">GWh</span></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Deviation</div>
        <div class="kpi-value accent">{delta_mwh:+,.0f}<span class="unit">MWh</span></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Valid test days</div>
        <div class="kpi-value">{valid_days}<span class="unit">days</span></div>
      </div>
    </div>
  </div>

  <!-- ── Daily chart ───────────────────────────────────── -->
  <section>
    <div class="section-head">
      <h2>Daily production &mdash; valid measured vs guaranteed</h2>
      <span class="sub">All days in test window</span>
    </div>
    <div class="controls">
      <span>VIEW:</span>
      <button class="active" data-view="bars">Bar chart</button>
      <button data-view="cumulative">Cumulative</button>
      <button data-view="delta">Delta %</button>
    </div>
    <div class="chart-wrap"><canvas id="mainChart"></canvas></div>
  </section>

  <!-- ── Hourly average profile ────────────────────────── -->
  <section>
    <div class="section-head">
      <h2>Average daily profile &mdash; by hour</h2>
      <span class="sub">Hourly mean across all valid intervals (every day)</span>
    </div>
    <div class="chart-wrap"><canvas id="hourChart"></canvas></div>
  </section>

  <!-- ── IEC criteria audit ────────────────────────────── -->
  <section>
    <div class="section-head">
      <h2>IEC 61724-2 filtering audit</h2>
      <span class="sub">Interval rejections by criterion</span>
    </div>

    <div class="audit-strip">
      <div>
        <div class="a-label">Total intervals</div>
        <div class="a-val">{total_intervals:,}</div>
      </div>
      <div>
        <div class="a-label">Passed all criteria</div>
        <div class="a-val green">{valid_intervals:,}</div>
      </div>
      <div>
        <div class="a-label">Rejection rate</div>
        <div class="a-val">{rejection_pct:.1f}<span style="font-size:12px;font-weight:400">%</span></div>
      </div>
      <div>
        <div class="a-label">Days observed</div>
        <div class="a-val">{total_days}</div>
      </div>
      <div>
        <div class="a-label">Days valid</div>
        <div class="a-val green">{valid_days}</div>
      </div>
    </div>

    <div class="crit-grid">
      <div class="crit-card">
        <div class="crit-header"><div>
          <div class="crit-num">Criterio 01</div>
          <div class="crit-title">GHI sano (lectura v&aacute;lida &ge; 0)</div>
        </div>
          <button class="info-btn" tabindex="0" aria-label="Info C1">i
            <div class="tooltip">Se excluyen los intervalos cuya GHI falta o es no f&iacute;sica (sensor en fallo).
              <span class="tip-norm">Chequeo de sanidad del piran&oacute;metro</span></div></button>
        </div>
        <div class="crit-stats">
          <div class="crit-count">{ghi_failed:,}<span class="rejected">rechazados</span></div>
          <span class="crit-pct">{ghi_met:.1f}%<span class="crit-ref">&nbsp;cumplido</span></span>
        </div>
        <div class="crit-bar"><span style="width:{ghi_bar:.1f}%"></span></div>
      </div>

      <div class="crit-card">
        <div class="crit-header"><div>
          <div class="crit-num">Criterio 02</div>
          <div class="crit-title">POA &ge;&nbsp;{poa_min}&nbsp;W/m&sup2; por intervalo</div>
        </div>
          <button class="info-btn" tabindex="0" aria-label="Info C2">i
            <div class="tooltip">Se excluyen los intervalos diurnos con POA por debajo de {poa_min}&nbsp;W/m&sup2;; a baja irradiancia el PR pierde representatividad.
              <span class="tip-norm">IEC 61724-2 &mdash; Umbral m&iacute;nimo de irradiancia</span></div></button>
        </div>
        <div class="crit-stats">
          <div class="crit-count">{poa_failed:,}<span class="rejected">rechazados</span></div>
          <span class="crit-pct">{poa_met:.1f}%<span class="crit-ref">&nbsp;cumplido (diurno)</span></span>
        </div>
        <div class="crit-bar"><span style="width:{poa_bar:.1f}%"></span></div>
      </div>

      <div class="crit-card">
        <div class="crit-header"><div>
          <div class="crit-num">Criterio 03</div>
          <div class="crit-title">&ge;&nbsp;{min_hours}&nbsp;h/d&iacute;a con POA &ge;&nbsp;{poa_thr}&nbsp;W/m&sup2;</div>
        </div>
          <button class="info-btn" tabindex="0" aria-label="Info C3">i
            <div class="tooltip">Un d&iacute;a solo se incluye si tiene al menos {min_hours} horas con POA &ge;&nbsp;{poa_thr}&nbsp;W/m&sup2;.
              <span class="tip-norm">IEC 61724-2 &mdash; Horas m&iacute;nimas de irradiancia diaria</span></div></button>
        </div>
        <div class="crit-stats">
          <div class="crit-count">{hrs_failed:,}<span class="rejected">d&iacute;as excl.</span></div>
          <span class="crit-pct">{hrs_met:.1f}%<span class="crit-ref">&nbsp;d&iacute;as cumplen</span></span>
        </div>
        <div class="crit-bar"><span style="width:{hrs_bar:.1f}%"></span></div>
      </div>

      <div class="crit-card">
        <div class="crit-header"><div>
          <div class="crit-num">Criterio 04</div>
          <div class="crit-title">Setpoint &ge;&nbsp;{sp_min:,.0f}&nbsp;kW &amp; sin alarma de viento</div>
        </div>
          <button class="info-btn" tabindex="0" aria-label="Info C4">i
            <div class="tooltip">Se excluyen los intervalos con limitaci&oacute;n (setpoint &lt;&nbsp;{sp_min:,.0f}&nbsp;kW) o alarma de viento: restricciones operativas externas.
              <span class="tip-norm">IEC 61724-2 &mdash; Restricciones operativas externas</span></div></button>
        </div>
        <div class="crit-stats">
          <div class="crit-count">{sp_failed:,}<span class="rejected">rechazados</span></div>
          <span class="crit-pct">{sp_met:.1f}%<span class="crit-ref">&nbsp;cumplido</span></span>
        </div>
        <div class="crit-bar"><span style="width:{sp_bar:.1f}%"></span></div>
      </div>
    </div>
  </section>

  <!-- ── Top / bottom days ─────────────────────────────── -->
  <section class="two-col">
    <div>
      <div class="section-head">
        <h2>Best days</h2>
        <span class="sub">Highest over-performance</span>
      </div>
      <table>
        <thead><tr>
          <th>Date</th><th class="num">Measured</th>
          <th class="num">Guaranteed</th><th class="num">&Delta;&nbsp;%</th>
        </tr></thead>
        <tbody>{top_rows}</tbody>
      </table>
    </div>
    <div>
      <div class="section-head">
        <h2>Worst days</h2>
        <span class="sub">Largest under-performance</span>
      </div>
      <table>
        <thead><tr>
          <th>Date</th><th class="num">Measured</th>
          <th class="num">Guaranteed</th><th class="num">&Delta;&nbsp;%</th>
        </tr></thead>
        <tbody>{bot_rows}</tbody>
      </table>
    </div>
  </section>

  <!-- ── Daily detail table ────────────────────────────── -->
  <section>
    <div class="section-head">
      <h2>Tabla diaria — E medida / garantizada / esperada · POA/GHI medido vs esperado</h2>
      <span class="sub">Solo días válidos y excluidos del período de test</span>
    </div>
    <div class="search-bar">
      <input type="text" id="search" placeholder="Filtrar por fecha, p.ej. 2026-03 …">
    </div>
    <table id="detailTable">
      <thead><tr>
        <th>Date</th>
        <th class="num">E Medida (MWh)</th>
        <th class="num">E Garantizada (MWh)</th>
        <th class="num">E Esperada (MWh)</th>
        <th class="num">POA Med. (W/m&sup2;)</th>
        <th class="num">POA Esp. (W/m&sup2;)</th>
        <th class="num">GHI Med. (W/m&sup2;)</th>
        <th class="num">GHI Esp. (W/m&sup2;)</th>
        <th class="num">&Delta; vs Guar.</th>
        <th class="num">Intervalos válidos</th>
        <th>Estado</th>
      </tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </section>

</div><!-- /content -->

<footer>
  <span class="footer-brand">Enerlandgroup</span>
  <span>{plant_name} &nbsp;&middot;&nbsp; PR Test &nbsp;&middot;&nbsp; IEC&nbsp;61724-2</span>
  <span>Ctrl+P &rarr; PDF &nbsp;&nbsp; Generated {generated_at}</span>
</footer>

<script>
const data = {daily_json};
const fmt  = (kwh, d=2) => (kwh / 1000).toFixed(d);

/* ── Detail table ────────────────────────────────────── */
const tbody = document.getElementById('tbody');
function renderTable(filter) {{
  filter = (filter || '').toLowerCase();
  tbody.innerHTML = '';
  const fmtIrr = v => (v && v > 0) ? v.toFixed(0) : '&mdash;';
  data.filter(r => r.day.toLowerCase().includes(filter)).forEach(r => {{
    const pos = r.delta_pct >= 0;
    const tr  = document.createElement('tr');
    if (!r.valid) tr.className = 'invalid';
    tr.innerHTML = `
      <td>${{r.day}}</td>
      <td class="num">${{fmt(r.mp)}}</td>
      <td class="num">${{fmt(r.gp)}}</td>
      <td class="num">${{fmt(r.ep)}}</td>
      <td class="num">${{fmtIrr(r.poa_m)}}</td>
      <td class="num">${{fmtIrr(r.poa_e)}}</td>
      <td class="num">${{fmtIrr(r.ghi_m)}}</td>
      <td class="num">${{fmtIrr(r.ghi_e)}}</td>
      <td class="${{r.valid ? (pos ? 'delta-pos' : 'delta-neg') : ''}}">${{r.valid ? ((pos?'+':'') + r.delta_pct.toFixed(1) + '%') : '&mdash;'}}</td>
      <td class="num">${{r.valid_intervals || 0}}</td>
      <td><span class="tag ${{r.valid?'valid':'invalid'}}">${{r.valid?'Válido':'Excl.'}}</span></td>
    `;
    tbody.appendChild(tr);
  }});
}}
renderTable('');
document.getElementById('search').addEventListener('input', e => renderTable(e.target.value));

/* ── Chart ───────────────────────────────────────────── */
const Y_MAX  = {chart_y_max};   // null = auto-scale; number = installed capacity ceiling (MWh/day)
const BLUE   = '#1b3d6e';
const BLUE_M = '#2e6ab5';
const RED    = '#c62828';
const GREY   = '#c0ccc8';
const ctx    = document.getElementById('mainChart').getContext('2d');
const labels = data.map(r => r.day);

const chartDefs = {{
  bars: {{
    type: 'bar',
    data: {{
      labels,
      datasets: [
        {{
          label: 'Measured (MWh)',
          data: data.map(r => r.mp / 1000),
          backgroundColor: data.map(r => r.valid ? BLUE : GREY),
          borderWidth: 0, borderRadius: 2,
        }},
        {{
          label: 'Guaranteed (MWh)',
          data: data.map(r => r.gp / 1000),
          backgroundColor: data.map(r => r.valid ? 'rgba(27,61,110,0.18)' : 'rgba(180,180,180,0.15)'),
          borderColor: data.map(r => r.valid ? BLUE_M : GREY),
          borderWidth: 1, borderRadius: 2,
        }}
      ]
    }}
  }},
  cumulative: {{
    type: 'line',
    data: (() => {{
      let cm = 0, cg = 0;
      const mp = [], gp = [];
      data.forEach(r => {{
        if (r.valid) {{ cm += r.mp / 1000; cg += r.gp / 1000; }}
        mp.push(cm); gp.push(cg);
      }});
      return {{
        labels,
        datasets: [
          {{ label: 'Cumulative measured (MWh)', data: mp, borderColor: BLUE,   backgroundColor: 'rgba(27,61,110,0.07)', fill: true,  tension: 0.2, borderWidth: 2.5, pointRadius: 0 }},
          {{ label: 'Cumulative guaranteed (MWh)', data: gp, borderColor: RED, backgroundColor: 'transparent',          fill: false, tension: 0.2, borderWidth: 2,   pointRadius: 0, borderDash: [5,3] }}
        ]
      }};
    }})()
  }},
  delta: {{
    type: 'bar',
    data: (() => {{
      const vd = data.filter(r => r.valid);
      return {{
        labels: vd.map(r => r.day),
        datasets: [{{
          label: 'Δ% vs Guaranteed',
          data: vd.map(r => r.delta_pct),
          backgroundColor: vd.map(r => r.delta_pct >= 0 ? BLUE : RED),
          borderWidth: 0, borderRadius: 2,
        }}]
      }};
    }})()
  }}
}};

const commonOpts = {{
  responsive: true, maintainAspectRatio: false,
  plugins: {{
    legend: {{ position: 'bottom', labels: {{ font: {{ family: 'Consolas,monospace', size: 11 }}, padding: 16 }} }},
    tooltip: {{ titleFont: {{ family: 'Consolas,monospace', size: 11 }}, bodyFont: {{ family: 'Consolas,monospace', size: 11 }} }}
  }},
  scales: {{
    x: {{ grid: {{ display: false }}, ticks: {{ font: {{ family: 'Consolas,monospace', size: 9 }}, maxRotation: 60, minRotation: 60 }} }},
    y: {{ grid: {{ color: '#e2eaf2' }}, ticks: {{ font: {{ family: 'Consolas,monospace', size: 10 }} }} }}
  }}
}};

// Y_MAX sólo aplica a la vista de barras; cumulative y delta se auto-escalan
const barsOpts = JSON.parse(JSON.stringify(commonOpts));
if (Y_MAX !== null) {{ barsOpts.scales.y.min = 0; barsOpts.scales.y.max = Y_MAX; }}

let chart = new Chart(ctx, {{ ...chartDefs.bars, options: barsOpts }});
document.querySelectorAll('.controls button').forEach(btn => {{
  btn.addEventListener('click', () => {{
    document.querySelectorAll('.controls button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chart.destroy();
    const opts = btn.dataset.view === 'bars' ? barsOpts : commonOpts;
    chart = new Chart(ctx, {{ ...chartDefs[btn.dataset.view], options: opts }});
  }});
}});

/* ── Hourly profile chart ─────────────────────────────── */
const hourly = {hourly_json};
if (hourly && hourly.length) {{
  const hctx = document.getElementById('hourChart').getContext('2d');
  new Chart(hctx, {{
    type: 'line',
    data: {{
      labels: hourly.map(h => h.hour + 'h'),
      datasets: [
        {{ label: 'Measured (kWh, hourly avg)',   data: hourly.map(h => h.measured),   borderColor: BLUE, backgroundColor: 'rgba(27,61,110,0.07)', fill: true,  tension: 0.3, borderWidth: 2.5, pointRadius: 0 }},
        {{ label: 'Guaranteed (kWh, hourly avg)', data: hourly.map(h => h.guaranteed), borderColor: RED,  backgroundColor: 'transparent',          fill: false, tension: 0.3, borderWidth: 2,   pointRadius: 0, borderDash: [5,3] }}
      ]
    }},
    options: commonOpts
  }});
}}

/* ── Info tooltip: auto-flip + click toggle ──────────── */
function positionTooltip(btn) {{
  const tip = btn.querySelector('.tooltip');
  if (!tip) return;
  // Reset to default (right-aligned)
  tip.style.right  = '0';
  tip.style.left   = 'auto';
  tip.style.removeProperty('--arrow-left');
  const rect = tip.getBoundingClientRect();
  if (rect.left < 8) {{
    // Overflows left — flip to open rightward from the button
    tip.style.right = 'auto';
    tip.style.left  = '0';
  }}
}}
document.querySelectorAll('.info-btn').forEach(btn => {{
  btn.addEventListener('mouseenter', () => positionTooltip(btn));
  btn.addEventListener('focus',      () => positionTooltip(btn));
  btn.addEventListener('click', e => {{
    e.stopPropagation();
    const isOpen = btn.classList.contains('open');
    document.querySelectorAll('.info-btn.open').forEach(b => b.classList.remove('open'));
    if (!isOpen) {{ btn.classList.add('open'); positionTooltip(btn); }}
  }});
}});
document.addEventListener('click', () => {{
  document.querySelectorAll('.info-btn.open').forEach(b => b.classList.remove('open'));
}});
</script>
</body>
</html>
"""


# ─── Helpers ────────────────────────────────────────────────────────────────

def _row(r: dict) -> str:
    sign = "+" if r["delta_pct"] >= 0 else ""
    cls  = "delta-pos" if r["delta_pct"] >= 0 else "delta-neg"
    return (
        f"<tr><td>{r['day']}</td>"
        f"<td class='num'>{r['mp']/1000:.2f} MWh</td>"
        f"<td class='num'>{r['gp']/1000:.2f} MWh</td>"
        f"<td class='{cls}'>{sign}{r['delta_pct']:.1f}%</td></tr>"
    )


def _bar_cls(failed: int, total: int, warn_pct: float = 10.0) -> str:
    if total <= 0:
        return ""
    return "bad" if (failed / total * 100) > warn_pct else ""


# ─── Public entry point ──────────────────────────────────────────────────────

def render_html(
    pr_result: dict,
    audit: dict,
    cfg: dict,
    resolution: str,
) -> str:
    """
    Build a self-contained HTML report string.

    Parameters
    ----------
    pr_result : dict  — output of compute_pr_test()
    audit     : dict  — criteria audit counters from evaluate_criteria()
    cfg       : dict  — plant config with keys 'plant' and 'contract'
    resolution: str   — e.g. '15min'
    """
    js_daily = [
        {
            "day":             str(d["_day"]),
            "mp":              float(d.get("measured_valid_kWh", d["measured_kWh"])),
            "gp":              float(d.get("guaranteed_valid_kWh", d["guaranteed_kWh"])),
            "ep":              float(d.get("expected_valid_kWh", d["expected_kWh"])),
            "valid":           bool(d["valid_day"]),
            "delta_pct":       float(d["delta_pct"]),
            "valid_intervals": int(d["valid_intervals"]),
            "poa_m":           float(d.get("poa_medida_wm2", d.get("poa_avg", 0)) or 0),
            "poa_e":           float(d.get("poa_esperada_wm2", 0) or 0),
            "ghi_m":           float(d.get("ghi_medida_wm2", 0) or 0),
            "ghi_e":           float(d.get("ghi_esperada_wm2", 0) or 0),
        }
        for d in pr_result["daily"]
    ]

    valid_daily  = [d for d in js_daily if d["valid"]]
    sorted_valid = sorted(valid_daily, key=lambda x: x["delta_pct"])
    top = list(reversed(sorted_valid[-5:]))
    bot = sorted_valid[:5]

    passed             = pr_result["passed"]
    verdict_color_css  = "var(--pass)"   if passed else "var(--fail)"
    verdict_bg_css     = "var(--pass-bg)" if passed else "var(--fail-bg)"
    verdict_border_css = "#b3d9c4"       if passed else "#f5c6c4"

    plant_name = cfg["plant"]["name"]
    c          = cfg["contract"]

    total_intervals = audit["total_intervals"] or 1
    total_days      = audit["valid_days"] + len(audit["excluded_days"])

    # ── 4 criterios reales (% de intervalos / dias que CUMPLEN) ─────────────
    daytime = audit.get("daytime_intervals", total_intervals) or 1

    def _met(failed, base):
        return round((base - failed) / base * 100, 1) if base else 100.0

    ghi_failed = audit["c1_failed"]            # GHI sano
    poa_failed = audit["c3_failed"]            # POA >= min (diurno)
    hrs_failed = audit["c4_failed"]            # dias excluidos por horas/dia
    sp_failed  = audit.get("c6_failed", 0)     # setpoint >= min & sin viento

    ghi_met = _met(ghi_failed, total_intervals); ghi_bar = ghi_met
    poa_met = _met(poa_failed, daytime);         poa_bar = poa_met
    hrs_met = _met(hrs_failed, total_days);      hrs_bar = hrs_met
    sp_met  = _met(sp_failed,  total_intervals); sp_bar  = sp_met

    # ── Chart Y-axis ceiling: 120 % of the max value in the series ──────────
    max_mp = max((d["mp"] for d in js_daily), default=0) / 1000   # MWh
    max_gp = max((d["gp"] for d in js_daily), default=0) / 1000   # MWh
    series_max = max(max_mp, max_gp)
    chart_y_max    = round(series_max * 1.2, 1) if series_max > 0 else None
    chart_y_max_js = "null" if chart_y_max is None else str(chart_y_max)

    html = _HTML_TEMPLATE.format(
        logo_html          = _LOGO_HTML,
        plant_name         = plant_name,
        generated_at       = datetime.now().strftime("%Y-%m-%d %H:%M"),
        period_human       = f"{pr_result['period_start']} → {pr_result['period_end']}",
        resolution         = resolution,
        verdict_color_css  = verdict_color_css,
        verdict_bg_css     = verdict_bg_css,
        verdict_border_css = verdict_border_css,
        verdict_word       = "PASSED ✓" if passed else "FAILED ✗",
        above_or_below     = "above" if passed else "below",
        delta_pct          = pr_result["delta_pct"],
        guar_gwh           = pr_result["total_guaranteed_kwh"] / 1e6,
        meas_gwh           = pr_result["total_measured_kwh"]   / 1e6,
        delta_mwh          = pr_result["delta_kwh"] / 1000,
        total_intervals    = audit["total_intervals"],
        valid_intervals    = audit["valid_intervals"],
        rejection_pct      = (1 - audit["valid_intervals"] / total_intervals) * 100,
        total_days         = total_days,
        valid_days         = audit["valid_days"],
        # 4 criterios reales - % cumplido
        ghi_failed = ghi_failed, ghi_met = ghi_met, ghi_bar = ghi_bar,
        poa_failed = poa_failed, poa_met = poa_met, poa_bar = poa_bar,
        hrs_failed = hrs_failed, hrs_met = hrs_met, hrs_bar = hrs_bar,
        sp_failed  = sp_failed,  sp_met  = sp_met,  sp_bar  = sp_bar,
        # contract thresholds
        min_hours = c["min_valid_hours_per_day"],
        poa_thr   = c["poa_threshold_wm2"],
        sp_min    = c["setpoint_min_kw"],
        poa_min   = c["poa_min_valid_wm2"],
        # chart
        chart_y_max = chart_y_max_js,
        hourly_json = json.dumps(pr_result.get("hourly", [])),
        # tables
        top_rows   = "".join(_row(r) for r in top),
        bot_rows   = "".join(_row(r) for r in bot),
        daily_json = json.dumps(js_daily),
    )
    return html
