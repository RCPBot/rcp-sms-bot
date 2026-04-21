/**
 * Fabrication Cut Sheet PDF Generator + Email
 * Generates a PDF cut sheet from FabItem[] and emails it to the owner.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as nodemailer from "nodemailer";
import type { FabItem } from "@shared/schema";

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
      subject: `Your Rebar Cut Sheet — ${params.projectName}`,
      text: [
        `Hi ${params.customerName},`,
        ``,
        `Thanks for sending us your plans. Please find your fabrication cut sheet attached.`,
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
        <p>Thanks for sending us your plans. Please find your <strong>fabrication cut sheet</strong> attached for ${params.projectName}.</p>
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
      ],
    });
    console.log(`[CutSheet] Cut sheet emailed to customer ${params.customerEmail}${params.ownerEmail ? ` (cc ${params.ownerEmail})` : ""}`);
    return true;
  } catch (err) {
    console.error("[CutSheet] Customer email failed:", err);
    return false;
  }
}
