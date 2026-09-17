//-----------------------------------------------------------------------
// Generador del informe HTML autocontenido (descarga desde el botón de la app).
// Replica las secciones y el estilo del informe del notebook (report_template.py):
// cabecera, verdict card, producción diaria (Chart.js), POA/GHI, auditoría de
// criterios activos y tabla diaria. Mismo look técnico/navy + gama de azules.
//-----------------------------------------------------------------------

import type { PrSummary, PrDaily } from "@/lib/pr-model";
import { CRITERIA, critMet } from "@/lib/pr-model";

const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Construye el HTML completo del informe a partir de los datos cargados. */
export function buildReportHtml(s: PrSummary, daily: PrDaily[]): string {
    const passColor = s.passed ? "#1a7a3c" : "#c62828";
    const verdict = s.passed ? "CUMPLE ✓" : "NO CUMPLE ✗";
    const aboveBelow = s.passed ? "por encima" : "por debajo";
    const rejectionPct = s.totalIntervals ? (1 - s.validIntervals / s.totalIntervals) * 100 : 0;

    // datos diarios para Chart.js + tabla
    const js = daily.map((d) => ({
        day: d.day,
        mp: d.eMedida,
        gp: d.eGarantizada,
        ep: d.eEsperada,
        valid: d.validDay,
        delta: d.deltaPct,
        vi: d.validIntervals,
        poa_m: d.poaMedida,
        poa_e: d.poaEsperada,
        ghi_m: d.ghiMedida,
        ghi_e: d.ghiEsperada,
    }));

    // tarjetas de criterios activos
    const critCards = CRITERIA.filter((d) => s.active.size === 0 || s.active.has(d.id))
        .map((d) => {
            const { met, failed, rejPct } = critMet(d, s);
            const bad = rejPct > 10;
            const unitRej = d.level === "day" ? "días excl." : "rechazados";
            const unitMet = d.level === "day" ? "días cumplen" : "cumplido";
            const okColor = bad ? "#c62828" : "#1a7a3c";
            const barColor = bad ? "#c62828" : "#2e6ab5";
            return `
      <div class="crit-card">
        <div class="crit-num">Criterio ${d.num}</div>
        <div class="crit-title">${esc(d.title)}</div>
        <div class="crit-stats">
          <div class="crit-count">${failed.toLocaleString("es-ES")}<span class="rej">${unitRej}</span></div>
          <span class="crit-pct" style="background:${bad ? "#fdecea" : "#e8eef8"};color:${bad ? "#c62828" : "#1b3d6e"}">${met.toFixed(1)}% ${unitMet}</span>
        </div>
        <div class="crit-bar"><span style="width:${met}%;background:${barColor}"></span></div>
        <span class="crit-status" style="color:${okColor};border-color:${okColor};background:${bad ? "#fdecea" : "#e8f5ee"}">${bad ? "Revisar" : "OK"}</span>
      </div>`;
        })
        .join("");

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.plantName)} — Informe PR</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root{--brand:#1b3d6e;--brand-dark:#0d2444;--brand-mid:#2e6ab5;--bg-alt:#f4f7fb;--border:#b8cce0;--border-t:#d5e2f0;--muted:#5a6672;--mono:'Consolas','Courier New',monospace;--sans:'Segoe UI',system-ui,Arial,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;color:#1a1a1a;font-family:var(--sans);font-size:14px;line-height:1.5;max-width:1280px;margin:0 auto;padding-bottom:60px}
.page-header{background:var(--brand-dark);color:#fff;padding:14px 40px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid var(--brand-mid)}
.page-header .brand{font:700 20px/1 var(--sans);letter-spacing:.05em}
.page-header .lab{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.8;text-align:right;line-height:1.7}
.page-header .lab strong{display:block;font-size:13px;opacity:1;color:#fff}
.content{padding:28px 40px 0}
.title-bar{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:2px solid var(--brand);padding-bottom:10px;margin-bottom:24px}
.title-bar h1{font-size:21px;font-weight:700;color:var(--brand-dark)}
.title-bar h1 span{display:block;font-size:12px;font-weight:400;color:var(--muted);font-family:var(--mono);margin-top:3px;letter-spacing:.06em}
.meta{text-align:right;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.85}
.verdict{border:1px solid var(--border);border-top:3px solid ${passColor};border-radius:0 0 4px 4px;margin-bottom:24px;overflow:hidden}
.verdict-h{background:var(--bg-alt);padding:12px 22px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--border)}
.badge{font-family:var(--mono);font-size:13px;font-weight:700;letter-spacing:.12em;color:#fff;background:${passColor};padding:4px 14px;border-radius:3px}
.verdict-d{font-size:13px;color:var(--muted)}
.verdict-d strong{color:${passColor}}
.verdict-b{background:#fff;padding:18px 22px;display:grid;grid-template-columns:repeat(4,1fr)}
.kpi{padding:6px 16px;border-right:1px solid var(--border-t)}
.kpi:first-child{padding-left:0}.kpi:last-child{border-right:none}
.kpi-l{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.kpi-v{font-family:var(--mono);font-size:24px;font-weight:700;line-height:1}
.kpi-v .u{font-size:12px;font-weight:400;color:var(--muted);margin-left:3px}
section{margin-bottom:32px}
.sec-h{display:flex;align-items:center;justify-content:space-between;border-left:4px solid var(--brand);padding:6px 12px;margin-bottom:14px;background:var(--bg-alt);border-top:1px solid var(--border-t);border-bottom:1px solid var(--border-t);border-right:1px solid var(--border-t);border-radius:0 3px 3px 0}
.sec-h h2{font-size:11px;font-family:var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--brand-dark);font-weight:700}
.sec-h .sub{font-family:var(--mono);font-size:10px;color:var(--muted)}
.controls{display:flex;gap:8px;align-items:center;margin-bottom:10px;font-family:var(--mono);font-size:11px;color:var(--muted)}
.controls button{background:transparent;border:1px solid var(--border);padding:5px 13px;cursor:pointer;font-family:var(--mono);font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);border-radius:3px}
.controls button.active{background:var(--brand);border-color:var(--brand);color:#fff}
.chart-wrap{border:1px solid var(--border);border-left:4px solid var(--brand);background:#fff;padding:18px;height:320px;border-radius:0 4px 4px 0}
.audit{display:grid;grid-template-columns:repeat(5,1fr);border:1px solid var(--border);border-radius:4px;overflow:hidden;margin-bottom:18px}
.audit>div{padding:12px 16px;border-right:1px solid var(--border);background:var(--bg-alt)}
.audit>div:last-child{border-right:none}
.a-l{font-family:var(--mono);font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.a-v{font-family:var(--mono);font-size:20px;font-weight:700;line-height:1}
.a-v.green{color:#1a7a3c}
.crit-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.crit-card{border:1px solid var(--border);border-top:3px solid var(--brand);background:var(--bg-alt);padding:12px 14px 14px;border-radius:0 0 4px 4px}
.crit-num{font-family:var(--mono);font-size:9px;letter-spacing:.22em;text-transform:uppercase;color:var(--brand);font-weight:700;margin-bottom:3px}
.crit-title{font-size:12px;color:var(--muted);line-height:1.4;min-height:32px}
.crit-stats{display:flex;align-items:baseline;gap:10px;margin:10px 0 8px}
.crit-count{font-family:var(--mono);font-size:22px;font-weight:700;line-height:1}
.crit-count .rej{font-size:10px;font-weight:400;color:var(--muted);letter-spacing:.08em;margin-left:2px}
.crit-pct{font-family:var(--mono);font-size:13px;font-weight:700;padding:2px 7px;border-radius:10px;letter-spacing:.04em}
.crit-bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden}
.crit-bar>span{display:block;height:100%;border-radius:2px}
.crit-status{display:inline-block;margin-top:8px;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:2px;border:1px solid}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);background:var(--bg-alt);padding:8px 10px;border:1px solid var(--border-t);white-space:nowrap}
th:first-child{border-left:4px solid var(--brand)}
td{padding:7px 10px;border:1px solid var(--border-t)}
td.num{font-family:var(--mono);text-align:right}
td.pos{color:#1a7a3c;font-family:var(--mono);text-align:right;font-weight:700}
td.neg{color:#c62828;font-family:var(--mono);text-align:right;font-weight:700}
tr:nth-child(even) td{background:var(--bg-alt)}
tr.invalid td{color:#aaa}
.tag{display:inline-block;padding:2px 7px;font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;border-radius:2px;border:1px solid currentColor;font-weight:700}
.tag.valid{color:#1a7a3c;background:#e8f5ee}.tag.invalid{color:#5a6672;background:#f5f5f5}
footer{background:var(--brand-dark);color:rgba(255,255,255,.65);padding:13px 40px;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;margin-top:36px}
footer .fb{color:#fff;font-weight:700;font-size:11px}
@media print{.controls{display:none}section{break-inside:avoid}}
</style>
</head>
<body>
<div class="page-header">
  <div class="brand">ENERLANDGROUP</div>
  <div class="lab"><strong>Performance Ratio Test Report</strong>IEC 61724-2 · ${esc(s.plantName)}</div>
</div>
<div class="content">
  <div class="title-bar">
    <h1>${esc(s.plantName)}<span>Performance Ratio Test — IEC 61724-2</span></h1>
    <div class="meta">Periodo:&nbsp;<strong>${esc(s.periodStart)} → ${esc(s.periodEnd)}</strong><br>Resolución:&nbsp;<strong>${esc(s.resolution)}</strong><br>Ejecutado:&nbsp;<strong>${esc(s.executedAt.slice(0, 16).replace("T", " "))}</strong></div>
  </div>
  <div class="verdict">
    <div class="verdict-h">
      <div class="badge">${verdict}</div>
      <div class="verdict-d">La producción medida está <strong>${s.deltaPct >= 0 ? "+" : ""}${s.deltaPct.toFixed(2)}%</strong> ${aboveBelow} del umbral garantizado.</div>
    </div>
    <div class="verdict-b">
      <div class="kpi"><div class="kpi-l">Producción garantizada</div><div class="kpi-v">${(s.guaranteedKwh / 1e6).toFixed(3)}<span class="u">GWh</span></div></div>
      <div class="kpi"><div class="kpi-l">Producción medida</div><div class="kpi-v">${(s.measuredKwh / 1e6).toFixed(3)}<span class="u">GWh</span></div></div>
      <div class="kpi"><div class="kpi-l">Desviación</div><div class="kpi-v" style="color:${passColor}">${s.deltaKwh >= 0 ? "+" : ""}${(s.deltaKwh / 1000).toLocaleString("es-ES", { maximumFractionDigits: 0 })}<span class="u">MWh</span></div></div>
      <div class="kpi"><div class="kpi-l">Días de test válidos</div><div class="kpi-v">${s.validDays}<span class="u">días</span></div></div>
    </div>
  </div>
  <section>
    <div class="sec-h"><h2>Producción diaria — medida / garantizada / esperada</h2><span class="sub">Todos los días del periodo</span></div>
    <div class="controls"><span>VISTA:</span><button class="active" data-v="bars">Barras</button><button data-v="cumulative">Acumulada</button><button data-v="delta">Delta %</button></div>
    <div class="chart-wrap"><canvas id="mainChart"></canvas></div>
  </section>
  <section>
    <div class="sec-h"><h2>Irradiancia — POA / GHI medido vs esperado</h2><span class="sub">Media diaria (W/m²) · sólido=medido, discontinuo=esperado</span></div>
    <div class="chart-wrap"><canvas id="irrChart"></canvas></div>
  </section>
  <section>
    <div class="sec-h"><h2>Auditoría de criterios IEC 61724-2</h2><span class="sub">Solo criterios activos · rechazos por criterio</span></div>
    <div class="audit">
      <div><div class="a-l">Intervalos totales</div><div class="a-v">${s.totalIntervals.toLocaleString("es-ES")}</div></div>
      <div><div class="a-l">Pasan todos</div><div class="a-v green">${s.validIntervals.toLocaleString("es-ES")}</div></div>
      <div><div class="a-l">Tasa de rechazo</div><div class="a-v">${rejectionPct.toFixed(1)}%</div></div>
      <div><div class="a-l">Días válidos</div><div class="a-v green">${s.validDays}</div></div>
      <div><div class="a-l">Criterios activos</div><div class="a-v">${s.active.size || CRITERIA.length}</div></div>
    </div>
    <div class="crit-grid">${critCards}</div>
  </section>
  <section>
    <div class="sec-h"><h2>Tabla diaria — E medida / garantizada / esperada · POA/GHI</h2><span class="sub">Días válidos y excluidos</span></div>
    <table><thead><tr><th>Fecha</th><th class="num">E Medida (MWh)</th><th class="num">E Garantizada (MWh)</th><th class="num">E Esperada (MWh)</th><th class="num">POA Med.</th><th class="num">POA Esp.</th><th class="num">GHI Med.</th><th class="num">GHI Esp.</th><th class="num">Δ vs Guar.</th><th class="num">Int. válidos</th><th>Estado</th></tr></thead><tbody id="tbody"></tbody></table>
  </section>
</div>
<footer><span class="fb">Enerlandgroup</span><span>${esc(s.plantName)} · PR Test · IEC 61724-2</span><span>Ctrl+P → PDF</span></footer>
<script>
const data = ${JSON.stringify(js)};
const NAVY='#1b3d6e',MID='#4a82c4',LIGHT='#9ec3e8',RED='#c62828',ORANGE='#e65100';
const fmt=(k,d=2)=>(k/1000).toFixed(d);
const fIrr=v=>(v&&v>0)?v.toFixed(0):'\\u2014';
const tb=document.getElementById('tbody');
data.forEach(r=>{
  const pos=r.delta>=0,tr=document.createElement('tr');if(!r.valid)tr.className='invalid';
  tr.innerHTML='<td>'+r.day+'</td><td class="num">'+fmt(r.mp)+'</td><td class="num">'+fmt(r.gp)+'</td><td class="num">'+fmt(r.ep)+'</td>'+
   '<td class="num">'+fIrr(r.poa_m)+'</td><td class="num">'+fIrr(r.poa_e)+'</td><td class="num">'+fIrr(r.ghi_m)+'</td><td class="num">'+fIrr(r.ghi_e)+'</td>'+
   '<td class="'+(r.valid?(pos?'pos':'neg'):'num')+'">'+(r.valid?((pos?'+':'')+r.delta.toFixed(1)+'%'):'\\u2014')+'</td>'+
   '<td class="num">'+(r.vi||0)+'</td><td><span class="tag '+(r.valid?'valid':'invalid')+'">'+(r.valid?'Válido':'Excl.')+'</span></td>';
  tb.appendChild(tr);
});
const labels=data.map(r=>r.day);
const ctx=document.getElementById('mainChart').getContext('2d');
const defs={
  bars:{type:'bar',data:{labels,datasets:[
    {label:'Medida (MWh)',data:data.map(r=>r.mp/1000),backgroundColor:data.map(r=>r.valid?NAVY:'#c0ccc8')},
    {label:'Garantizada (MWh)',data:data.map(r=>r.gp/1000),backgroundColor:MID},
    {label:'Esperada (MWh)',data:data.map(r=>r.ep/1000),backgroundColor:LIGHT}]}},
  cumulative:{type:'line',data:(()=>{let m=0,g=0,e=0;const M=[],G=[],E=[];data.forEach(r=>{if(r.valid){m+=r.mp/1000;g+=r.gp/1000;e+=r.ep/1000;}M.push(m);G.push(g);E.push(e);});return{labels,datasets:[
    {label:'Medida acum.',data:M,borderColor:NAVY,borderWidth:2.5,pointRadius:0,tension:.2},
    {label:'Garantizada acum.',data:G,borderColor:MID,borderWidth:2,pointRadius:0,borderDash:[5,3],tension:.2},
    {label:'Esperada acum.',data:E,borderColor:LIGHT,borderWidth:2,pointRadius:0,borderDash:[2,2],tension:.2}]};})()},
  delta:{type:'bar',data:(()=>{const v=data.filter(r=>r.valid);return{labels:v.map(r=>r.day),datasets:[{label:'Δ% vs Garantizada',data:v.map(r=>r.delta),backgroundColor:v.map(r=>r.delta>=0?NAVY:RED)}]};})()}
};
const opts={responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{family:'Consolas',size:11}}}},scales:{x:{grid:{display:false},ticks:{font:{family:'Consolas',size:9},maxRotation:60,minRotation:60}},y:{grid:{color:'#e2eaf2'},ticks:{font:{family:'Consolas',size:10}}}}};
let chart=new Chart(ctx,{...defs.bars,options:opts});
document.querySelectorAll('.controls button').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.controls button').forEach(x=>x.classList.remove('active'));b.classList.add('active');chart.destroy();chart=new Chart(ctx,{...defs[b.dataset.v],options:opts});}));
const nz=v=>(v&&v>0)?v:null;
new Chart(document.getElementById('irrChart').getContext('2d'),{type:'line',data:{labels,datasets:[
  {label:'POA medida',data:data.map(r=>nz(r.poa_m)),borderColor:NAVY,borderWidth:2.2,pointRadius:0,tension:.25,spanGaps:true},
  {label:'POA esperada',data:data.map(r=>nz(r.poa_e)),borderColor:NAVY,borderWidth:1.8,pointRadius:0,borderDash:[5,3],tension:.25,spanGaps:true},
  {label:'GHI medida',data:data.map(r=>nz(r.ghi_m)),borderColor:ORANGE,borderWidth:2.2,pointRadius:0,tension:.25,spanGaps:true},
  {label:'GHI esperada',data:data.map(r=>nz(r.ghi_e)),borderColor:ORANGE,borderWidth:1.8,pointRadius:0,borderDash:[5,3],tension:.25,spanGaps:true}]},options:opts});
</script>
</body>
</html>`;
}

/** Dispara la descarga del informe HTML en el navegador. */
export function downloadReportHtml(s: PrSummary, daily: PrDaily[]): void {
    const html = buildReportHtml(s, daily);
    const safe = s.plantName.replace(/[\\/*?:"<>|]/g, "_");
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safe}_PR_Report.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
