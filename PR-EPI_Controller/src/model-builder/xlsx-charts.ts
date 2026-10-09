//-----------------------------------------------------------------------
// Native Excel charts. exceljs cannot write charts, so they are added to
// the finished .xlsx package: one DrawingML chart part per chart, linked to
// the worksheet ranges (the charts update when the workbook recalculates).
//-----------------------------------------------------------------------

import type JSZipT from "jszip";

export interface ChartSeries {
    name: string;
    /** Values range, e.g. 'Sheet'!$C$2:$C$481 */
    y: string;
    /** X range for scatter charts (dates or numbers). */
    x?: string;
    color: string; // RRGGBB
    dash?: boolean;
    width?: number; // points
    markers?: boolean; // scatter points without line
}

export interface ChartSpec {
    sheet: string; // worksheet that holds the chart
    from: { col: number; row: number }; // 0-based anchor
    to: { col: number; row: number };
    title: string;
    kind: "bar" | "line" | "scatter";
    /** Categories for bar charts (dates or text). */
    cat?: string;
    catFmt?: string;
    series: ChartSeries[];
    yTitle?: string;
    xTitle?: string;
    yFmt?: string;
    xFmt?: string;
    /** Bar chart: an extra line series on the same axes (e.g. design PR). */
    overlay?: ChartSeries[];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const NS = `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;

const txPr = (sz = 900, bold = false, color = "595959") =>
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
const title = (t: string, sz = 1200) =>
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="1"><a:solidFill><a:srgbClr val="262626"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="en-US" sz="${sz}" b="1"><a:solidFill><a:srgbClr val="262626"/></a:solidFill></a:rPr><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
const line = (s: ChartSeries) =>
    s.markers
        ? `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="3"/><c:spPr><a:solidFill><a:srgbClr val="${s.color}"><a:alpha val="55000"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`
        : `<c:spPr><a:ln w="${Math.round((s.width ?? 1.5) * 12700)}" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>${s.dash ? `<a:prstDash val="dash"/>` : ""}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`;
const gridLines = `<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E6E6E6"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>`;
const axLine = `<c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill></a:ln></c:spPr>`;
const axTitle = (t?: string) => (t ? title(t, 900) : "");
const valAx = (id: number, cross: number, pos: "l" | "b", fmt: string, t?: string, grid = true, crossesMid = false) =>
    `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid ? gridLines : ""}${axTitle(t)}<c:numFmt formatCode="${esc(fmt)}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${axLine}${txPr()}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="${crossesMid ? "between" : "midCat"}"/></c:valAx>`;

function chartXml(s: ChartSpec): string {
    const legend = `<c:legend><c:legendPos val="t"/><c:overlay val="0"/>${txPr(900)}</c:legend>`;
    let plot = "";
    if (s.kind === "bar") {
        const ser = s.series.map((x, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(x.name)}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${x.color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:cat><c:numRef><c:f>${esc(s.cat!)}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${esc(x.y)}</c:f></c:numRef></c:val></c:ser>`).join("");
        plot += `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/><c:overlap val="-10"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>`;
        if (s.overlay?.length) {
            const ov = s.overlay.map((x, i) => `<c:ser><c:idx val="${s.series.length + i}"/><c:order val="${s.series.length + i}"/><c:tx><c:v>${esc(x.name)}</c:v></c:tx>${line(x)}<c:cat><c:numRef><c:f>${esc(s.cat!)}</c:f></c:numRef></c:cat><c:val><c:numRef><c:f>${esc(x.y)}</c:f></c:numRef></c:val><c:smooth val="0"/></c:ser>`).join("");
            plot += `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ov}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>`;
        }
        plot += `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${axTitle(s.xTitle)}<c:numFmt formatCode="${esc(s.catFmt ?? "dd/mm")}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${axLine}${txPr()}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="0"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
        plot += valAx(5002, 5001, "l", s.yFmt ?? "#,##0", s.yTitle, true, true);
    } else {
        const ser = s.series.map((x, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(x.name)}</c:v></c:tx>${line(x)}<c:xVal><c:numRef><c:f>${esc(x.x!)}</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>${esc(x.y)}</c:f></c:numRef></c:yVal><c:smooth val="0"/></c:ser>`).join("");
        plot += `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser}<c:axId val="5001"/><c:axId val="5002"/></c:scatterChart>`;
        plot += valAx(5001, 5002, "b", s.xFmt ?? (s.kind === "line" ? "dd/mm" : "#,##0"), s.xTitle, s.kind === "scatter");
        plot += valAx(5002, 5001, "l", s.yFmt ?? "#,##0", s.yTitle);
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart>${title(s.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`;
}

function drawingXml(anchors: { spec: ChartSpec; rid: string; id: number }[]): string {
    const a = anchors.map(({ spec, rid, id }) => `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${spec.from.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${spec.to.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${spec.to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="${esc(spec.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">${a}</xdr:wsDr>`;
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: { id: string; type: string; target: string }[]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((r) => `<Relationship Id="${r.id}" Type="${REL}/${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;

/** Add the charts to a finished workbook (the output of exceljs writeBuffer). */
export async function addCharts(buf: ArrayBuffer, specs: ChartSpec[]): Promise<ArrayBuffer> {
    if (!specs.length) return buf;
    const JSZip = (await import("jszip")).default as unknown as typeof JSZipT;
    const zip = await JSZip.loadAsync(buf);
    const wbXml = await zip.file("xl/workbook.xml")!.async("string");
    const wbRels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
    let ct = await zip.file("[Content_Types].xml")!.async("string");
    const sheetPath = (name: string) => {
        const m = new RegExp(`<sheet [^>]*name="${esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*r:id="(rId\\d+)"`).exec(wbXml)
            ?? new RegExp(`<sheet [^>]*r:id="(rId\\d+)"[^>]*name="${esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).exec(wbXml);
        if (!m) return null;
        const t = new RegExp(`<Relationship [^>]*Id="${m[1]}"[^>]*Target="([^"]+)"`).exec(wbRels) ?? new RegExp(`<Relationship [^>]*Target="([^"]+)"[^>]*Id="${m[1]}"`).exec(wbRels);
        if (!t) return null;
        const target = t[1].replace(/^\/?xl\//, "");
        return `xl/${target}`;
    };
    const bySheet = new Map<string, ChartSpec[]>();
    for (const s of specs) bySheet.set(s.sheet, [...(bySheet.get(s.sheet) ?? []), s]);
    let chartN = 0, drawN = 0;
    for (const [sheet, list] of bySheet) {
        const path = sheetPath(sheet);
        if (!path || !zip.file(path)) continue;
        const dn = ++drawN;
        const anchors = list.map((spec, k) => {
            const cn = ++chartN;
            zip.file(`xl/charts/chartc${cn}.xml`, chartXml(spec));
            ct = ct.replace("</Types>", `<Override PartName="/xl/charts/chartc${cn}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
            return { spec, rid: `rIdc${k + 1}`, id: k + 1, cn };
        });
        zip.file(`xl/drawings/drawingc${dn}.xml`, drawingXml(anchors));
        zip.file(`xl/drawings/_rels/drawingc${dn}.xml.rels`, rels(anchors.map((a) => ({ id: a.rid, type: "chart", target: `../charts/chartc${a.cn}.xml` }))));
        ct = ct.replace("</Types>", `<Override PartName="/xl/drawings/drawingc${dn}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
        // Sheet → drawing relationship
        const dir = path.slice(0, path.lastIndexOf("/")), file = path.slice(path.lastIndexOf("/") + 1);
        const relPath = `${dir}/_rels/${file}.rels`;
        const relId = "rIdDrawC1";
        const rel = `<Relationship Id="${relId}" Type="${REL}/drawing" Target="../drawings/drawingc${dn}.xml"/>`;
        const existing = zip.file(relPath) ? await zip.file(relPath)!.async("string") : null;
        zip.file(relPath, existing ? existing.replace("</Relationships>", `${rel}</Relationships>`) : rels([{ id: relId, type: "drawing", target: `../drawings/drawingc${dn}.xml` }]));
        let xml = await zip.file(path)!.async("string");
        if (!xml.includes('xmlns:r="')) xml = xml.replace("<worksheet ", `<worksheet xmlns:r="${REL}" `);
        // <drawing> goes before legacyDrawing / tableParts / extLst (schema order)
        const tag = `<drawing r:id="${relId}"/>`;
        const before = ["<legacyDrawing", "<legacyDrawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems", "<tableParts", "<extLst", "</worksheet>"].find((t) => xml.includes(t))!;
        xml = xml.replace(before, `${tag}${before}`);
        zip.file(path, xml);
    }
    zip.file("[Content_Types].xml", ct);
    return await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}
