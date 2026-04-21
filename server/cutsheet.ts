/**
 * Fabrication Cut Sheet PDF Generator + Email
 * Generates a PDF cut sheet from FabItem[] and emails it to the owner.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as nodemailer from "nodemailer";
import type { FabItem } from "@shared/schema";

// ── Office address for plan forwarding + bid PDFs ───────────────────────────
export const OFFICE_EMAIL = "Office@RebarConcreteProducts.com";

// ── Email sender ─────────────────────────────────────────────────────────────
function getTransporter() {
  const service = process.env.EMAIL_SERVICE; // "gmail" if using Gmail SMTP
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS; // App password for Gmail

  if (service && user && pass) {
    return nodemailer.createTransport({ service, auth: { user, pass } });
  }

  // Fallback: SendGrid
  const sgKey = process.env.SENDGRID_API_KEY;
  if (sgKey) {
    return nodemailer.createTransport({
      host: "smtp.sendgrid.net",
      port: 587,
      auth: { user: "apikey", pass: sgKey },
    });
  }

  // Dev fallback: log only
  return null;
}

// ── Forward received plans to office ─────────────────────────────────────────
// Called when a customer texts a PDF (MMS) or a plan link (Dropbox/Drive).
// Emails Office@RebarConcreteProducts.com with the PDF attached or link in body.
export async function forwardPlansToOffice(params: {
  customerName: string;
  customerPhone: string;
  originalMessage: string;
  projectDetails?: string;
  pdfPaths?: string[]; // local file paths for MMS PDFs
  planLinks?: string[]; // Dropbox/Drive/direct links
}): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[PlanForward] No email transport — cannot forward plans to office.");
    return false;
  }

  const linksBlock = (params.planLinks && params.planLinks.length > 0)
    ? `\nPlan link(s):\n${params.planLinks.map(l => `  - ${l}`).join("\n")}\n`
    : "";

  const body = [
    `A customer has submitted plans for takeoff.`,
    ``,
    `Customer: ${params.customerName}`,
    `Phone: ${params.customerPhone}`,
    `Project details: ${params.projectDetails || "(not yet provided)"}`,
    ``,
    (params.pdfPaths && params.pdfPaths.length > 0)
      ? `Plan attachment(s) are included below.`
      : `Plan link(s) are included above.`,
    `Please upload these plans to the takeoff system for processing.`,
    ``,
    `Customer message: "${params.originalMessage || ""}"`,
    linksBlock,
  ].join("\n");

  const attachments = (params.pdfPaths || [])
    .filter(p => p && fs.existsSync(p))
    .map((p, i) => ({
      filename: `${params.customerName.replace(/\s+/g, "_")}_plan_${i + 1}.pdf`,
      path: p,
      contentType: "application/pdf",
    }));

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com",
      to: OFFICE_EMAIL,
      subject: `[Plan Received] ${params.customerName} — ${params.customerPhone}`,
      text: body,
      attachments,
    });
    console.log(`[PlanForward] Plans forwarded to ${OFFICE_EMAIL} for ${params.customerName} (${params.customerPhone})`);
    return true;
  } catch (err) {
    console.error("[PlanForward] Forwarding failed:", err);
    return false;
  }
}

// ── Generate cut sheet PDF via Python/ReportLab ──────────────────────────────
export function generateCutSheetPdf(params: {
  projectName: string;
  customerName: string;
  estimateNumber: string;
  fabItems: FabItem[];
}): string {
  const outPath = `/tmp/cutsheet_${Date.now()}.pdf`;
  const logoPath = "/home/user/workspace/rcp_logo.png";

  const script = `
import sys, json
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.pdfgen import canvas as pdfcanvas

# Data passed via stdin
data = json.loads(sys.stdin.read())
project_name = data["projectName"]
customer_name = data["customerName"]
estimate_number = data["estimateNumber"]
fab_items = data["fabItems"]
out_path = data["outPath"]
logo_path = data["logoPath"]

doc = SimpleDocTemplate(
    out_path,
    pagesize=landscape(letter),
    leftMargin=0.5*inch, rightMargin=0.5*inch,
    topMargin=0.5*inch, bottomMargin=0.5*inch,
    title="Fabrication Cut Sheet",
    author="Perplexity Computer"
)

styles = getSampleStyleSheet()
lime = colors.HexColor("#C8FF00")
dark = colors.HexColor("#1A1A1A")
mid  = colors.HexColor("#2D2D2D")

title_style = ParagraphStyle("title", fontSize=16, textColor=dark, spaceAfter=4, alignment=TA_LEFT, fontName="Helvetica-Bold")
sub_style   = ParagraphStyle("sub",   fontSize=10, textColor=mid,  spaceAfter=2, alignment=TA_LEFT)
note_style  = ParagraphStyle("note",  fontSize=8,  textColor=mid,  spaceAfter=6, alignment=TA_LEFT)

story = []

# Header row with logo + title
header_data = [[
    Paragraph(f"<b>Rebar Concrete Products</b><br/>2112 N Custer Rd, McKinney, TX 75071 | 469-631-7730", sub_style),
    Paragraph(f"<b>FABRICATION CUT SHEET</b>", title_style),
    Paragraph(f"<b>Project:</b> {project_name}<br/><b>Customer:</b> {customer_name}<br/><b>Estimate #:</b> {estimate_number}", sub_style),
]]
header_table = Table(header_data, colWidths=[2.5*inch, 3.5*inch, 3.5*inch])
header_table.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), lime),
    ("TEXTCOLOR",  (0,0), (-1,0), dark),
    ("VALIGN",     (0,0), (-1,0), "MIDDLE"),
    ("BOTTOMPADDING", (0,0), (-1,0), 8),
    ("TOPPADDING",    (0,0), (-1,0), 8),
    ("LEFTPADDING",   (0,0), (0,0), 10),
    ("BOX", (0,0), (-1,-1), 1.5, dark),
]))
story.append(header_table)
story.append(Spacer(1, 12))

# Main data table
col_headers = [
    "Mark", "Bar Size", "Qty\n(pcs)", "Cut Length\n(ft)",
    "Bend Description", "Total LF", "Total Wt\n(lbs)",
    "Stock Len\n(ft)", "Pcs/Stock\nBar", "Stock Bars\nNeeded"
]
rows = [col_headers]
total_weight = 0.0
total_stock_bars = 0

for fi in fab_items:
    rows.append([
        fi["mark"],
        fi["barSize"],
        str(fi["qty"]),
        f"{fi['lengthFt']:.2f}",
        fi["bendDescription"],
        f"{fi['totalLF']:.1f}",
        f"{fi['weightLbs']:.1f}",
        str(fi["stockLengthFt"]),
        str(fi["barsPerStock"]),
        str(fi["stockBarsNeeded"]),
    ])
    total_weight += fi["weightLbs"]
    total_stock_bars += fi["stockBarsNeeded"]

# Totals row
rows.append([
    "TOTAL", "", "", "", "", "", f"{total_weight:.1f} lbs", "", "", str(total_stock_bars)
])

col_widths = [0.55*inch, 0.65*inch, 0.6*inch, 0.75*inch, 2.3*inch,
              0.65*inch, 0.75*inch, 0.65*inch, 0.7*inch, 0.75*inch]

data_table = Table(rows, colWidths=col_widths, repeatRows=1)
data_table.setStyle(TableStyle([
    # Header
    ("BACKGROUND",   (0,0), (-1,0), dark),
    ("TEXTCOLOR",    (0,0), (-1,0), lime),
    ("FONTNAME",     (0,0), (-1,0), "Helvetica-Bold"),
    ("FONTSIZE",     (0,0), (-1,0), 8),
    ("ALIGN",        (0,0), (-1,0), "CENTER"),
    ("VALIGN",       (0,0), (-1,0), "MIDDLE"),
    ("TOPPADDING",   (0,0), (-1,0), 5),
    ("BOTTOMPADDING",(0,0), (-1,0), 5),
    # Data rows
    ("FONTSIZE",  (0,1), (-1,-2), 8),
    ("ALIGN",     (0,1), (-1,-2), "CENTER"),
    ("VALIGN",    (0,1), (-1,-2), "MIDDLE"),
    ("ROWBACKGROUNDS", (0,1), (-1,-2), [colors.white, colors.HexColor("#F5F5F5")]),
    ("TOPPADDING",    (0,1), (-1,-2), 4),
    ("BOTTOMPADDING", (0,1), (-1,-2), 4),
    # Totals row
    ("BACKGROUND",  (0,-1), (-1,-1), colors.HexColor("#E8FFB0")),
    ("FONTNAME",    (0,-1), (-1,-1), "Helvetica-Bold"),
    ("FONTSIZE",    (0,-1), (-1,-1), 8),
    ("ALIGN",       (0,-1), (-1,-1), "CENTER"),
    ("TOPPADDING",  (0,-1), (-1,-1), 5),
    ("BOTTOMPADDING",(0,-1),(-1,-1), 5),
    # Grid
    ("GRID", (0,0), (-1,-1), 0.5, colors.HexColor("#CCCCCC")),
    ("BOX",  (0,0), (-1,-1), 1.5, dark),
]))
story.append(data_table)
story.append(Spacer(1, 14))
story.append(Paragraph(
    "<b>NOTE:</b> Verify all bar marks, quantities, and dimensions against approved drawings before cutting. "
    "Contact Rebar Concrete Products at 469-631-7730 with any questions.",
    note_style
))

doc.build(story)
print("OK:" + out_path)
`;

  const inputData = JSON.stringify({
    projectName: params.projectName,
    customerName: params.customerName,
    estimateNumber: params.estimateNumber,
    fabItems: params.fabItems,
    outPath,
    logoPath,
  });

  const pythonScript = `/tmp/cutsheet_gen_${Date.now()}.py`;
  fs.writeFileSync(pythonScript, script);

  try {
    const result = execSync(`echo '${inputData.replace(/'/g, "'\\''")}' | python3 "${pythonScript}"`, {
      encoding: "utf8",
      timeout: 30000,
    }).trim();
    if (result.startsWith("OK:")) return result.replace("OK:", "");
    throw new Error(`PDF generation output: ${result}`);
  } finally {
    try { fs.unlinkSync(pythonScript); } catch (_) {}
  }
}

// ── Email the cut sheet to owner ─────────────────────────────────────────────
export async function emailCutSheet(params: {
  pdfPath: string;
  projectName: string;
  customerName: string;
  estimateNumber: string;
  ownerEmail: string;
}): Promise<boolean> {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn("[CutSheet] No email transport configured. Set EMAIL_SERVICE/EMAIL_USER/EMAIL_PASS or SENDGRID_API_KEY.");
    // Log the cut sheet path so the owner can find it manually
    console.log(`[CutSheet] Cut sheet saved at: ${params.pdfPath}`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com",
      to: params.ownerEmail,
      subject: `Fabrication Cut Sheet — ${params.projectName} (Est #${params.estimateNumber}) — CUSTOMER APPROVED`,
      text: [
        `A customer has approved Estimate #${params.estimateNumber} for ${params.projectName}.`,
        `Customer: ${params.customerName}`,
        ``,
        `The fabrication cut sheet is attached. Please cut and bend accordingly.`,
        ``,
        `Rebar Concrete Products`,
        `2112 N Custer Rd, McKinney, TX 75071`,
        `469-631-7730`,
      ].join("\n"),
      html: `
        <h2 style="color:#1A1A1A">Fabrication Cut Sheet — Customer Approved</h2>
        <p><strong>Estimate #:</strong> ${params.estimateNumber}</p>
        <p><strong>Project:</strong> ${params.projectName}</p>
        <p><strong>Customer:</strong> ${params.customerName}</p>
        <hr/>
        <p>The fabrication cut sheet is attached. Please cut and bend accordingly.</p>
        <p style="color:#666;font-size:12px">Rebar Concrete Products | 2112 N Custer Rd, McKinney, TX 75071 | 469-631-7730</p>
      `,
      attachments: [
        {
          filename: `CutSheet_${params.estimateNumber}_${params.projectName.replace(/\s+/g, "_")}.pdf`,
          path: params.pdfPath,
          contentType: "application/pdf",
        },
      ],
    });
    console.log(`[CutSheet] Cut sheet emailed to ${params.ownerEmail}`);
    return true;
  } catch (err) {
    console.error("[CutSheet] Email failed:", err);
    return false;
  }
}

// ── Placement Drawing PDF (pdfkit) ────────────────────────────────────────────
// Generates a per-mark placement drawing with a simple geometric sketch of the bar,
// placement notes, and a summary table. Unlike the cut sheet (ReportLab via Python),
// this uses pdfkit directly from Node so it works anywhere without a Python runtime.

const BAR_WEIGHT_TABLE: Record<string, number> = {
  "#3": 0.376, "#4": 0.668, "#5": 1.043, "#6": 1.502,
  "#7": 2.044, "#8": 2.670, "#9": 3.400, "#10": 4.303, "#11": 5.313,
};

function classifyBend(desc: string): "straight" | "stirrup" | "lhook" | "hook180" | "custom" {
  const d = (desc || "").toLowerCase();
  if (/stirrup|tie|ring|spiral|closed loop/.test(d)) return "stirrup";
  if (/180.?hook|u-?bar|u shape|hairpin/.test(d)) return "hook180";
  if (/l-?bar|l-?hook|corner|90.?hook/.test(d)) return "lhook";
  if (/straight|cont\.?|continuous|stock/.test(d)) return "straight";
  return "custom";
}

export async function generatePlacementDrawingPdf(params: {
  projectName: string;
  customerName: string;
  estimateNumber: string;
  fabItems: FabItem[];
}): Promise<string> {
  const pdfkitMod: any = await import("pdfkit");
  const PDFDocument: any = pdfkitMod.default || pdfkitMod;
  const outPath = `/tmp/placement_${Date.now()}.pdf`;

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: `Placement Drawing — ${params.projectName}`,
      Author: "Rebar Concrete Products",
    },
  });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const lime = "#C8FF00";
  const dark = "#1A1A1A";
  const mid = "#2D2D2D";
  const grey = "#888888";
  const light = "#F5F5F5";

  // Header band
  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 100;
  doc.rect(50, 45, contentWidth, 50).fill(lime);
  doc.fillColor(dark).font("Helvetica-Bold").fontSize(14)
    .text("REBAR CONCRETE PRODUCTS — Placement Drawing", 60, 55);
  doc.font("Helvetica").fontSize(9).fillColor(dark)
    .text(`Project: ${params.projectName}`, 60, 75)
    .text(`Customer: ${params.customerName}`, 300, 75)
    .text(`Estimate #: ${params.estimateNumber}   Date: ${new Date().toLocaleDateString()}`, 60, 87);

  doc.moveDown(3);
  let y = 115;

  // ── Per-bar sections ─────────────────────────────────────────────────────────
  const fabItems = params.fabItems || [];
  for (const fi of fabItems) {
    // Page-break check: need ~160 pts for each bar block
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 50;
    }

    // Bar mark label
    doc.fillColor(dark).font("Helvetica-Bold").fontSize(14)
      .text(`BAR MARK ${fi.mark}`, 50, y);
    y += 20;

    // Bar details
    const bend = classifyBend(fi.bendDescription);
    const bendLabel = bend === "stirrup" ? "Stirrup/Tie"
      : bend === "lhook" ? "L-hook (90°)"
      : bend === "hook180" ? "180° hook"
      : bend === "straight" ? "Straight"
      : "Custom bend";
    doc.fillColor(mid).font("Helvetica").fontSize(10)
      .text(`${fi.barSize} ${bendLabel} | ${fi.lengthFt.toFixed(2)} ft cut | ${fi.qty} bars`, 50, y);
    y += 14;

    // Placement note (bendDescription carries the location/detail)
    if (fi.bendDescription) {
      doc.fillColor(grey).font("Helvetica-Oblique").fontSize(9)
        .text(`Placement: ${fi.bendDescription}`, 50, y, { width: contentWidth });
      y += 14;
    }

    // ── Sketch box ────────────────────────────────────────────────────────────
    const boxX = 50;
    const boxY = y + 4;
    const boxW = 380;
    const boxH = 90;
    doc.rect(boxX, boxY, boxW, boxH).lineWidth(0.5).stroke(grey);

    const cx = boxX + boxW / 2;
    const cy = boxY + boxH / 2;

    if (bend === "straight") {
      // Horizontal line with arrows + length label
      const lineW = boxW * 0.75;
      const x0 = cx - lineW / 2;
      const x1 = cx + lineW / 2;
      doc.lineWidth(2).strokeColor(dark);
      doc.moveTo(x0, cy).lineTo(x1, cy).stroke();
      // End caps
      doc.lineWidth(1).moveTo(x0, cy - 6).lineTo(x0, cy + 6).stroke();
      doc.moveTo(x1, cy - 6).lineTo(x1, cy + 6).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(mid)
        .text(`${fi.lengthFt.toFixed(2)} ft`, cx - 20, cy + 10);
    } else if (bend === "stirrup") {
      // Rectangle with rounded corners representing closed stirrup
      const w = boxW * 0.5;
      const h = boxH * 0.55;
      const rx = cx - w / 2;
      const ry = cy - h / 2;
      doc.lineWidth(2).strokeColor(dark);
      doc.roundedRect(rx, ry, w, h, 6).stroke();
      // Dimension labels
      const dim = params_guessStirrupDims(fi.bendDescription, fi.lengthFt);
      doc.font("Helvetica").fontSize(8).fillColor(mid)
        .text(`${dim.w}"`, cx - 8, ry - 11)
        .text(`${dim.h}"`, rx + w + 4, cy - 4);
    } else if (bend === "lhook") {
      // L-shape
      doc.lineWidth(2).strokeColor(dark);
      const x0 = cx - boxW * 0.3;
      const x1 = cx + boxW * 0.15;
      const yh = cy + boxH * 0.2;
      const yv = cy - boxH * 0.25;
      doc.moveTo(x0, yh).lineTo(x1, yh).lineTo(x1, yv).stroke();
      doc.font("Helvetica").fontSize(8).fillColor(mid)
        .text(`leg A`, x0 + 4, yh + 4)
        .text(`leg B`, x1 + 4, yv + 8);
    } else if (bend === "hook180") {
      // U-shape
      doc.lineWidth(2).strokeColor(dark);
      const w = boxW * 0.4;
      const h = boxH * 0.55;
      const x0 = cx - w / 2;
      const x1 = cx + w / 2;
      const yTop = cy - h / 2;
      const yBot = cy + h / 2;
      doc.moveTo(x0, yTop).lineTo(x0, yBot - 10).stroke();
      doc.moveTo(x1, yTop).lineTo(x1, yBot - 10).stroke();
      // Arc at the bottom
      doc.arc(cx, yBot - 10, w / 2, 0, Math.PI).stroke();
    } else {
      // Custom — zigzag placeholder
      doc.lineWidth(2).strokeColor(dark);
      const x0 = cx - boxW * 0.3;
      const x1 = cx + boxW * 0.3;
      doc.moveTo(x0, cy)
        .lineTo(x0 + 30, cy - 20)
        .lineTo(x0 + 60, cy + 20)
        .lineTo(x0 + 90, cy - 20)
        .lineTo(x1, cy)
        .stroke();
      doc.font("Helvetica").fontSize(8).fillColor(mid)
        .text(`custom — see cut sheet`, x0, cy + 28);
    }

    // Side panel: weight info
    const sideX = boxX + boxW + 14;
    const unitLb = BAR_WEIGHT_TABLE[fi.barSize] ?? 0;
    const unitWeight = unitLb * fi.lengthFt;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(dark)
      .text("WEIGHT", sideX, boxY + 6);
    doc.font("Helvetica").fontSize(9).fillColor(mid)
      .text(`Unit: ${unitWeight.toFixed(2)} lbs`, sideX, boxY + 22)
      .text(`Total: ${fi.weightLbs.toFixed(1)} lbs`, sideX, boxY + 36)
      .text(`Sticks: ${fi.stockBarsNeeded}`, sideX, boxY + 50);

    y = boxY + boxH + 20;

    // Divider line
    doc.lineWidth(0.3).strokeColor(grey);
    doc.moveTo(50, y).lineTo(50 + contentWidth, y).stroke();
    y += 10;
  }

  // ── Summary table ────────────────────────────────────────────────────────────
  if (y > doc.page.height - 200) {
    doc.addPage();
    y = 50;
  }
  doc.font("Helvetica-Bold").fontSize(12).fillColor(dark)
    .text("SUMMARY", 50, y);
  y += 18;

  const colWidths = [70, 50, 75, 65, 45, 55, 65];
  const colHeaders = ["Bar Mark", "Size", "Bend", "Cut Len", "Qty", "Total LF", "Total Lbs"];
  let x = 50;
  doc.rect(50, y, contentWidth, 18).fill(dark);
  doc.fillColor(lime).font("Helvetica-Bold").fontSize(9);
  x = 50;
  colHeaders.forEach((h, i) => {
    doc.text(h, x + 4, y + 5, { width: colWidths[i] - 8 });
    x += colWidths[i];
  });
  y += 18;

  let totalLF = 0;
  let totalLb = 0;
  let rowIdx = 0;
  for (const fi of fabItems) {
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = 50;
    }
    if (rowIdx % 2 === 0) {
      doc.rect(50, y, contentWidth, 16).fill(light);
    }
    doc.fillColor(dark).font("Helvetica").fontSize(9);
    x = 50;
    const bend = classifyBend(fi.bendDescription);
    const bendShort = bend === "stirrup" ? "Stirrup"
      : bend === "lhook" ? "L-hook"
      : bend === "hook180" ? "180° hook"
      : bend === "straight" ? "Straight"
      : "Custom";
    const cells = [
      fi.mark,
      fi.barSize,
      bendShort,
      `${fi.lengthFt.toFixed(2)}'`,
      String(fi.qty),
      fi.totalLF.toFixed(1),
      fi.weightLbs.toFixed(1),
    ];
    cells.forEach((c, i) => {
      doc.text(c, x + 4, y + 4, { width: colWidths[i] - 8 });
      x += colWidths[i];
    });
    totalLF += fi.totalLF;
    totalLb += fi.weightLbs;
    y += 16;
    rowIdx++;
  }

  // Grand total
  doc.rect(50, y, contentWidth, 18).fill("#E8FFB0");
  doc.fillColor(dark).font("Helvetica-Bold").fontSize(9);
  x = 50;
  const totals = ["GRAND TOTAL", "", "", "", "", totalLF.toFixed(1), totalLb.toFixed(1)];
  totals.forEach((t, i) => {
    doc.text(t, x + 4, y + 5, { width: colWidths[i] - 8 });
    x += colWidths[i];
  });
  y += 28;

  // Footer
  doc.font("Helvetica").fontSize(8).fillColor(grey)
    .text(
      "Rebar Concrete Products | 2112 N Custer Rd McKinney TX 75071 | 469-631-7730 | rebarconcreteproducts.com",
      50, doc.page.height - 40, { width: contentWidth, align: "center" }
    );

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  return outPath;
}

// Parse inside-dim hints like "8x20" or "12x36" from the bendDescription.
// Falls back to an approximate from cut length.
function params_guessStirrupDims(desc: string, cutLenFt: number): { w: number; h: number } {
  const m = (desc || "").match(/(\d+)\s*x\s*(\d+)/i);
  if (m) return { w: parseInt(m[1]), h: parseInt(m[2]) };
  // perimeter ≈ 2(w+h)/12 + 1ft hooks
  const perimInches = Math.max(0, (cutLenFt - 1)) * 12 / 2;
  const h = Math.round(perimInches * 0.6);
  const w = Math.max(4, Math.round(perimInches - h));
  return { w, h };
}

// ── Email the cut sheet to the customer (with owner CC) ─────────────────────
// Sent right after plan takeoff completes — before estimate approval.
// Gives the customer a polished PDF takeoff to review alongside the QBO estimate.
export async function emailCutSheetToCustomer(params: {
  pdfPath: string;
  projectName: string;
  customerName: string;
  customerEmail: string;
  estimateNumber?: string;
  ownerEmail?: string;
  placementPdfPath?: string;
}): Promise<boolean> {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn("[CutSheet] No email transport configured — skipping customer cut sheet email.");
    return false;
  }

  if (!params.customerEmail) {
    console.warn("[CutSheet] No customer email — skipping customer cut sheet email.");
    return false;
  }

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com",
      to: params.customerEmail,
      cc: params.ownerEmail || undefined,
      subject: params.placementPdfPath
        ? `Your Rebar Cut Sheet & Placement Drawing — ${params.projectName}`
        : `Your Rebar Cut Sheet — ${params.projectName}`,
      text: [
        `Hi ${params.customerName},`,
        ``,
        params.placementPdfPath
          ? `Thanks for sending us your plans. Please find your fabrication cut sheet and placement drawing attached.`
          : `Thanks for sending us your plans. Please find your fabrication cut sheet attached.`,
        params.estimateNumber ? `Estimate #${params.estimateNumber} has also been sent for your review.` : ``,
        ``,
        `If anything looks off, reply to this email or call us at 469-631-7730 Mon–Fri 6am–3pm and we'll make it right.`,
        ``,
        `Thanks,`,
        `Rebar Concrete Products`,
        `2112 N Custer Rd, McKinney, TX 75071`,
        `469-631-7730`,
      ].filter(Boolean).join("\n"),
      html: `
        <p>Hi ${params.customerName},</p>
        <p>Thanks for sending us your plans. Please find your <strong>fabrication cut sheet</strong>${params.placementPdfPath ? ` and <strong>placement drawing</strong>` : ""} attached for ${params.projectName}.</p>
        ${params.estimateNumber ? `<p>Estimate <strong>#${params.estimateNumber}</strong> has also been sent for your review.</p>` : ""}
        <p>If anything looks off, reply to this email or call us at <strong>469-631-7730</strong> (Mon–Fri 6am–3pm) and we'll make it right.</p>
        <p style="color:#666;font-size:12px">Rebar Concrete Products | 2112 N Custer Rd, McKinney, TX 75071 | 469-631-7730 | rebarconcreteproducts.com</p>
      `,
      attachments: [
        {
          filename: `CutSheet_${(params.estimateNumber || "takeoff")}_${params.projectName.replace(/\s+/g, "_")}.pdf`,
          path: params.pdfPath,
          contentType: "application/pdf",
        },
        ...(params.placementPdfPath ? [{
          filename: `PlacementDrawing_${(params.estimateNumber || "takeoff")}_${params.projectName.replace(/\s+/g, "_")}.pdf`,
          path: params.placementPdfPath,
          contentType: "application/pdf",
        }] : []),
      ],
    });
    console.log(`[CutSheet] Cut sheet emailed to customer ${params.customerEmail}${params.ownerEmail ? ` (cc ${params.ownerEmail})` : ""}`);
    return true;
  } catch (err) {
    console.error("[CutSheet] Customer email failed:", err);
    return false;
  }
}

// ── Branded Bid / Estimate PDF (pdfkit) ──────────────────────────────────────
// Produces a polished 3-page PDF with brand colors and logo:
//   Page 1: cover + estimate summary with pricing
//   Page 2: fabrication cut sheet
//   Page 3: placement drawings
const BRAND = {
  lime:  "#C8D400",
  dark:  "#1a1a1a",
  white: "#FFFFFF",
  blue:  "#1E90FF",
  light: "#f5f5f5",
  veryLight: "#f9f9f9",
  gray:  "#666666",
  mid:   "#2D2D2D",
  border: "#CCCCCC",
};

const BRAND_BAR_WEIGHT: Record<string, number> = {
  "#3": 0.376, "#4": 0.668, "#5": 1.043, "#6": 1.502,
  "#7": 2.044, "#8": 2.670, "#9": 3.400, "#10": 4.303, "#11": 5.313,
};

// Resolve the logo path at runtime — works in dev (tsx), bundled CJS (dist/), and any CWD.
function resolveLogoPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "server/assets/logo.jpg"),
    path.resolve(process.cwd(), "dist/assets/logo.jpg"),
    path.resolve(process.cwd(), "assets/logo.jpg"),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function drawBrandHeader(doc: any, pageWidth: number) {
  // Charcoal band
  doc.rect(0, 0, pageWidth, 120).fill(BRAND.dark);
  // Logo on the left
  const logo = resolveLogoPath();
  if (logo) {
    try {
      doc.image(logo, 40, 20, { height: 80 });
    } catch (err) {
      // Fallback if image can't be loaded — write the company name
      doc.fillColor(BRAND.lime).font("Helvetica-Bold").fontSize(18)
        .text("REBAR CONCRETE PRODUCTS", 40, 50);
    }
  } else {
    doc.fillColor(BRAND.lime).font("Helvetica-Bold").fontSize(18)
      .text("REBAR CONCRETE PRODUCTS", 40, 50);
  }
  // Company info right-aligned in white
  const infoX = pageWidth - 310;
  doc.fillColor(BRAND.white).font("Helvetica").fontSize(9)
    .text("2112 N Custer Rd | McKinney, TX 75071", infoX, 34, { width: 270, align: "right" })
    .text("469-631-7730 | Office@RebarConcreteProducts.com", infoX, 50, { width: 270, align: "right" })
    .text("rebarconcreteproducts.com", infoX, 66, { width: 270, align: "right" });
  // Lime rule below header
  doc.rect(0, 120, pageWidth, 3).fill(BRAND.lime);
}

function drawBrandFooter(doc: any, pageWidth: number, pageHeight: number) {
  const h = 46;
  const y = pageHeight - h;
  doc.rect(0, y, pageWidth, h).fill(BRAND.dark);
  doc.fillColor(BRAND.white).font("Helvetica").fontSize(8)
    .text("This is a PRELIMINARY ESTIMATE for bidding purposes only.", 0, y + 6, { width: pageWidth, align: "center" })
    .text("Final quantities determined by full engineering takeoff upon contract award.", 0, y + 18, { width: pageWidth, align: "center" });
  doc.fillColor(BRAND.lime).font("Helvetica-Bold").fontSize(8)
    .text("Rebar Concrete Products  |  469-631-7730  |  rebarconcreteproducts.com", 0, y + 32, { width: pageWidth, align: "center" });
}

function classifyBendShort(desc: string): string {
  const d = (desc || "").toLowerCase();
  if (/stirrup|tie|ring|spiral|closed loop/.test(d)) return "Stirrup";
  if (/180.?hook|u-?bar|u shape|hairpin/.test(d)) return "180° hook";
  if (/l-?bar|l-?hook|corner|90.?hook/.test(d)) return "L-hook";
  if (/straight|cont\.?|continuous|stock/.test(d)) return "Straight";
  return "Custom";
}

export async function generateBidPdf(params: {
  lineItems: Array<{
    name: string;
    description?: string;
    qty: number;
    unitPrice: number;
    amount: number;
  }>;
  fabItems?: FabItem[];
  projectInfo: {
    projectName: string;
    projectAddress: string;
    customerName: string;
    estimateNumber: string;
  };
  taxRate?: number; // defaults to 0.0825
}): Promise<string> {
  const pdfkitMod: any = await import("pdfkit");
  const PDFDocument: any = pdfkitMod.default || pdfkitMod;
  const outPath = `/tmp/bid_${Date.now()}.pdf`;

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 140, bottom: 60, left: 40, right: 40 },
    info: {
      Title: `Preliminary Estimate — ${params.projectInfo.projectName}`,
      Author: "Rebar Concrete Products",
    },
  });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const contentLeft = 40;
  const contentRight = pageWidth - 40;
  const contentWidth = contentRight - contentLeft;
  const taxRate = params.taxRate ?? 0.0825;

  // Hook: repaint header/footer on every page (including auto-added pages)
  doc.on("pageAdded", () => {
    drawBrandHeader(doc, pageWidth);
    drawBrandFooter(doc, pageWidth, pageHeight);
  });

  // ── PAGE 1: COVER + ESTIMATE SUMMARY ─────────────────────────────────────
  drawBrandHeader(doc, pageWidth);
  drawBrandFooter(doc, pageWidth, pageHeight);

  let y = 145;
  // Title block
  doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(24)
    .text("PRELIMINARY ESTIMATE", contentLeft, y);
  // Date on the right
  doc.fillColor(BRAND.gray).font("Helvetica").fontSize(10)
    .text(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
      contentLeft, y + 6, { width: contentWidth, align: "right" });
  y += 30;
  doc.fillColor(BRAND.gray).font("Helvetica-Oblique").fontSize(9)
    .text("For bidding purposes only. Final quantities subject to full engineering takeoff upon contract award.",
      contentLeft, y, { width: contentWidth });
  y += 20;

  // Project info box (light gray, rounded)
  const boxH = 100;
  doc.roundedRect(contentLeft, y, contentWidth, boxH, 6).fill(BRAND.light);
  doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(10);
  const labelX = contentLeft + 14;
  const valueX = contentLeft + 130;
  let by = y + 12;
  const rows: Array<[string, string]> = [
    ["Project Name:", params.projectInfo.projectName || "(pending)"],
    ["Project Address:", params.projectInfo.projectAddress || "(pending)"],
    ["Prepared For:", params.projectInfo.customerName || "(pending)"],
    ["Estimate #:", params.projectInfo.estimateNumber || "(pending)"],
    ["Valid:", "30 days from date"],
  ];
  for (const [label, value] of rows) {
    doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(10).text(label, labelX, by);
    doc.fillColor(BRAND.mid).font("Helvetica").fontSize(10).text(value, valueX, by, { width: contentWidth - 140 });
    by += 16;
  }
  y += boxH + 20;

  // Line items table
  // Column widths total = contentWidth
  const colW = [60, 220, 40, 40, 40, 70, 65]; // ~535
  // Normalize to contentWidth
  const colScale = contentWidth / colW.reduce((a, b) => a + b, 0);
  const widths = colW.map(w => w * colScale);
  const headers = ["Bar Mark", "Description", "Size", "Qty", "Unit", "Unit Price", "Total"];

  const drawTableHeader = (yy: number) => {
    doc.rect(contentLeft, yy, contentWidth, 22).fill(BRAND.dark);
    // Lime accent stripe along the bottom of the header
    doc.rect(contentLeft, yy + 22, contentWidth, 2).fill(BRAND.lime);
    let x = contentLeft;
    doc.fillColor(BRAND.white).font("Helvetica-Bold").fontSize(9);
    headers.forEach((h, i) => {
      const align = (i >= 3) ? "right" : "left";
      doc.text(h, x + 6, yy + 6, { width: widths[i] - 12, align });
      x += widths[i];
    });
    return yy + 26;
  };

  y = drawTableHeader(y);

  let subtotal = 0;
  const items = params.lineItems || [];
  items.forEach((it, idx) => {
    // Page-break check (leave room for totals on last rows)
    if (y > pageHeight - 120) {
      doc.addPage();
      y = 145;
      y = drawTableHeader(y);
    }
    const rowH = 22;
    if (idx % 2 === 1) {
      doc.rect(contentLeft, y, contentWidth, rowH).fill(BRAND.veryLight);
    } else {
      doc.rect(contentLeft, y, contentWidth, rowH).fill(BRAND.white);
    }
    doc.fillColor(BRAND.dark).font("Helvetica").fontSize(9);
    // Parse size + mark from the name if available (best-effort)
    const sizeMatch = (it.name || "").match(/#\d+/);
    const size = sizeMatch ? sizeMatch[0] : "";
    const mark = idx < 26
      ? String.fromCharCode(65 + idx) + (idx < 10 ? "1" : String(Math.floor(idx / 10) + 1))
      : `M${idx + 1}`;
    const cells = [
      mark,
      it.name + (it.description ? ` — ${it.description}` : ""),
      size,
      String(it.qty),
      "ea",
      `$${it.unitPrice.toFixed(2)}`,
      `$${it.amount.toFixed(2)}`,
    ];
    let x = contentLeft;
    cells.forEach((c, i) => {
      const align = (i >= 3) ? "right" : "left";
      doc.text(c, x + 6, y + 6, { width: widths[i] - 12, align, ellipsis: true });
      x += widths[i];
    });
    subtotal += it.amount;
    y += rowH;
  });

  // Totals block
  y += 10;
  if (y > pageHeight - 130) { doc.addPage(); y = 145; }
  const totalsBoxX = contentLeft + contentWidth * 0.45;
  const totalsBoxW = contentWidth - (contentWidth * 0.45);
  const misc = Math.round(subtotal * 0.05 * 100) / 100;
  const estimateTotal = Math.round((subtotal + misc) * 100) / 100;
  const tax = Math.round(estimateTotal * taxRate * 100) / 100;
  const grand = Math.round((estimateTotal + tax) * 100) / 100;

  const drawTotalLine = (label: string, value: string, bold = false, color = BRAND.dark) => {
    doc.fillColor(color).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 10);
    doc.text(label, totalsBoxX, y, { width: totalsBoxW * 0.55, align: "left" });
    doc.text(value, totalsBoxX + totalsBoxW * 0.55, y, { width: totalsBoxW * 0.45 - 4, align: "right" });
    y += bold ? 18 : 15;
  };

  drawTotalLine("Subtotal:", `$${subtotal.toFixed(2)}`);
  drawTotalLine("Contingency/Misc. (+/-5%):", `+$${misc.toFixed(2)}`);
  // Divider
  doc.moveTo(totalsBoxX, y).lineTo(totalsBoxX + totalsBoxW - 4, y).lineWidth(0.5).stroke(BRAND.border);
  y += 4;
  drawTotalLine("ESTIMATE TOTAL:", `$${estimateTotal.toFixed(2)}`, true, BRAND.dark);
  drawTotalLine(`Tax (${(taxRate * 100).toFixed(2)}%):`, `$${tax.toFixed(2)}`);
  // Lime highlight for grand total
  doc.rect(totalsBoxX - 4, y - 2, totalsBoxW, 22).fill(BRAND.lime);
  doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(12);
  doc.text("GRAND TOTAL:", totalsBoxX, y + 3, { width: totalsBoxW * 0.55, align: "left" });
  doc.text(`$${grand.toFixed(2)}`, totalsBoxX + totalsBoxW * 0.55, y + 3, { width: totalsBoxW * 0.45 - 4, align: "right" });
  y += 28;

  // ── PAGE 2: FABRICATION CUT SHEET ────────────────────────────────────────
  if (params.fabItems && params.fabItems.length > 0) {
    doc.addPage();
    y = 145;
    doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(18)
      .text("FABRICATION CUT SHEET", contentLeft, y);
    y += 26;
    doc.fillColor(BRAND.gray).font("Helvetica").fontSize(9)
      .text(`Project: ${params.projectInfo.projectName}  |  Estimate #: ${params.projectInfo.estimateNumber}`,
        contentLeft, y);
    y += 20;

    const fabHeaders = ["Bar Mark", "Size", "Bend Type", "Dimensions", "Cut Len", "Qty", "Lbs/pc", "Total LF", "Total Lbs"];
    const fabColW = [55, 45, 80, 80, 55, 40, 50, 60, 65];
    const fabScale = contentWidth / fabColW.reduce((a, b) => a + b, 0);
    const fabWidths = fabColW.map(w => w * fabScale);

    const drawFabHeader = (yy: number) => {
      doc.rect(contentLeft, yy, contentWidth, 22).fill(BRAND.dark);
      doc.rect(contentLeft, yy + 22, contentWidth, 2).fill(BRAND.lime);
      let x = contentLeft;
      doc.fillColor(BRAND.white).font("Helvetica-Bold").fontSize(9);
      fabHeaders.forEach((h, i) => {
        const align = (i >= 4) ? "right" : "left";
        doc.text(h, x + 4, yy + 6, { width: fabWidths[i] - 8, align });
        x += fabWidths[i];
      });
      return yy + 26;
    };

    y = drawFabHeader(y);

    let totalLF = 0, totalLb = 0;
    (params.fabItems || []).forEach((fi, idx) => {
      if (y > pageHeight - 110) {
        doc.addPage();
        y = 145;
        y = drawFabHeader(y);
      }
      const rowH = 20;
      if (idx % 2 === 1) {
        doc.rect(contentLeft, y, contentWidth, rowH).fill(BRAND.veryLight);
      } else {
        doc.rect(contentLeft, y, contentWidth, rowH).fill(BRAND.white);
      }
      doc.fillColor(BRAND.dark).font("Helvetica").fontSize(8.5);
      const bendShort = classifyBendShort(fi.bendDescription);
      const dimMatch = (fi.bendDescription || "").match(/(\d+)\s*x\s*(\d+)/i);
      const dims = dimMatch ? `${dimMatch[1]}" × ${dimMatch[2]}"` : "";
      const unitLb = BRAND_BAR_WEIGHT[fi.barSize] ?? 0;
      const lbsPerPc = unitLb * fi.lengthFt;
      const cells = [
        fi.mark,
        fi.barSize,
        bendShort,
        dims,
        `${fi.lengthFt.toFixed(2)} ft`,
        String(fi.qty),
        lbsPerPc.toFixed(2),
        fi.totalLF.toFixed(1),
        fi.weightLbs.toFixed(1),
      ];
      let x = contentLeft;
      cells.forEach((c, i) => {
        const align = (i >= 4) ? "right" : "left";
        doc.text(c, x + 4, y + 6, { width: fabWidths[i] - 8, align, ellipsis: true });
        x += fabWidths[i];
      });
      totalLF += fi.totalLF;
      totalLb += fi.weightLbs;
      y += rowH;
    });

    // Totals row in lime
    doc.rect(contentLeft, y, contentWidth, 22).fill(BRAND.lime);
    doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(9);
    let x = contentLeft;
    const totalCells = ["TOTAL", "", "", "", "", "", "", totalLF.toFixed(1), totalLb.toFixed(1)];
    totalCells.forEach((c, i) => {
      const align = (i >= 4) ? "right" : "left";
      doc.text(c, x + 4, y + 7, { width: fabWidths[i] - 8, align });
      x += fabWidths[i];
    });
    y += 26;

    // ── PAGE 3: PLACEMENT DRAWING ──────────────────────────────────────────
    doc.addPage();
    y = 145;
    doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(18)
      .text("PLACEMENT DRAWING", contentLeft, y);
    y += 26;
    doc.fillColor(BRAND.gray).font("Helvetica").fontSize(9)
      .text(`Project: ${params.projectInfo.projectName}  |  Estimate #: ${params.projectInfo.estimateNumber}`,
        contentLeft, y);
    y += 20;

    for (const fi of params.fabItems) {
      if (y > pageHeight - 200) {
        doc.addPage();
        y = 145;
      }
      doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(12)
        .text(`BAR MARK ${fi.mark}`, contentLeft, y);
      y += 16;
      const bendShort = classifyBendShort(fi.bendDescription);
      doc.fillColor(BRAND.mid).font("Helvetica").fontSize(10)
        .text(`${fi.barSize} ${bendShort} | ${fi.lengthFt.toFixed(2)} ft cut | ${fi.qty} bars`, contentLeft, y);
      y += 14;
      if (fi.bendDescription) {
        doc.fillColor(BRAND.gray).font("Helvetica-Oblique").fontSize(9)
          .text(`Placement: ${fi.bendDescription}`, contentLeft, y, { width: contentWidth });
        y += 14;
      }

      // Simple sketch box
      const boxX = contentLeft;
      const boxY = y + 2;
      const boxW = contentWidth * 0.7;
      const boxH = 80;
      doc.rect(boxX, boxY, boxW, boxH).lineWidth(0.5).stroke(BRAND.border);

      const cx = boxX + boxW / 2;
      const cy = boxY + boxH / 2;
      doc.lineWidth(2).strokeColor(BRAND.dark);

      if (/stirrup|tie|ring/i.test(fi.bendDescription || "")) {
        const w = boxW * 0.5, h = boxH * 0.55;
        doc.roundedRect(cx - w / 2, cy - h / 2, w, h, 5).stroke();
      } else if (/l-?hook|90/i.test(fi.bendDescription || "")) {
        doc.moveTo(cx - 80, cy + 15).lineTo(cx + 30, cy + 15).lineTo(cx + 30, cy - 25).stroke();
      } else if (/180|u-?bar|hairpin/i.test(fi.bendDescription || "")) {
        doc.moveTo(cx - 30, cy - 25).lineTo(cx - 30, cy + 10).stroke();
        doc.moveTo(cx + 30, cy - 25).lineTo(cx + 30, cy + 10).stroke();
        doc.arc(cx, cy + 10, 30, 0, Math.PI).stroke();
      } else {
        // Straight
        doc.moveTo(cx - boxW * 0.35, cy).lineTo(cx + boxW * 0.35, cy).stroke();
        doc.lineWidth(1).moveTo(cx - boxW * 0.35, cy - 6).lineTo(cx - boxW * 0.35, cy + 6).stroke();
        doc.moveTo(cx + boxW * 0.35, cy - 6).lineTo(cx + boxW * 0.35, cy + 6).stroke();
      }

      // Side info panel
      const sideX = boxX + boxW + 14;
      doc.fillColor(BRAND.dark).font("Helvetica-Bold").fontSize(9)
        .text("WEIGHT", sideX, boxY + 6);
      doc.fillColor(BRAND.mid).font("Helvetica").fontSize(9)
        .text(`Total: ${fi.weightLbs.toFixed(1)} lbs`, sideX, boxY + 22)
        .text(`Sticks: ${fi.stockBarsNeeded}`, sideX, boxY + 36);

      y = boxY + boxH + 14;
      doc.lineWidth(0.3).strokeColor(BRAND.border);
      doc.moveTo(contentLeft, y).lineTo(contentLeft + contentWidth, y).stroke();
      y += 8;
    }
  }

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
  return outPath;
}

// ── Email the branded bid PDF to customer + office ──────────────────────────
export async function emailBidPdf(params: {
  pdfPath: string;
  projectName: string;
  customerName: string;
  customerEmail?: string;
  estimateNumber: string;
}): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("[BidPdf] No email transport configured — skipping bid email.");
    return false;
  }
  const recipients: string[] = [];
  if (params.customerEmail) recipients.push(params.customerEmail);
  recipients.push(OFFICE_EMAIL);

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER || "noreply@rebarconcreteproducts.com",
      to: recipients.join(", "),
      subject: `Preliminary Estimate #${params.estimateNumber} — ${params.projectName}`,
      text: [
        `Hi ${params.customerName},`,
        ``,
        `Please find attached your preliminary estimate for ${params.projectName}.`,
        `This is for bidding purposes only and includes a +/-5% contingency.`,
        `Final quantities will be determined by a full engineering takeoff upon contract award.`,
        ``,
        `Questions? Call 469-631-7730 Mon–Fri 6am–3pm.`,
        ``,
        `Rebar Concrete Products`,
        `2112 N Custer Rd, McKinney, TX 75071`,
      ].join("\n"),
      attachments: [
        {
          filename: `Estimate_${params.estimateNumber}_${params.projectName.replace(/\s+/g, "_")}.pdf`,
          path: params.pdfPath,
          contentType: "application/pdf",
        },
      ],
    });
    console.log(`[BidPdf] Bid PDF emailed to ${recipients.join(", ")}`);
    return true;
  } catch (err) {
    console.error("[BidPdf] Email failed:", err);
    return false;
  }
}
