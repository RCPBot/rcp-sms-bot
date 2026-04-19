/**
 * Link Resolver
 * Detects URLs in SMS message text and converts them into image URLs
 * that OpenAI Vision can read directly.
 *
 * Supported sources:
 *  - Direct image URLs (.jpg, .jpeg, .png, .gif, .webp)
 *  - Direct PDF URLs → fetched, each page rendered to a base64 data URL
 *  - Google Drive share links → converted to direct download
 *  - Dropbox share links → converted to direct download
 *  - WeTransfer, OneDrive, Box — fetched as binary and converted
 */

import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, execSync } from "child_process";

// Log pdftoppm path on startup so Railway logs confirm it's installed
try {
  const which = execSync("which pdftoppm 2>/dev/null || echo NOT_FOUND").toString().trim();
  console.log(`[LinkResolver] pdftoppm path: ${which}`);
} catch {
  console.warn("[LinkResolver] pdftoppm not found on PATH");
}

// ── URL extraction ────────────────────────────────────────────────────────────
const URL_REGEX = /https?:\/\/[^\s<>"]+/gi;

export function extractUrls(text: string): string[] {
  return (text.match(URL_REGEX) || []).map(u => u.replace(/[.,;)]+$/, ""));
}

// ── Unwrap security-scanner redirect URLs (Proofpoint, Safelinks, etc.) ──────
export function unwrapSecurityUrl(url: string): string {
  // Proofpoint URLDefense v2: u= param contains encoded URL
  // e.g. https://urldefense.proofpoint.com/v2/url?u=https-3A__www.dropbox.com_...
  if (url.includes("urldefense.proofpoint.com")) {
    const match = url.match(/[?&]u=([^&]+)/);
    if (match) {
      try {
        // Proofpoint encoding: - → %, _ → /, then URI decode
        const decoded = decodeURIComponent(match[1].replace(/-([0-9A-F]{2})/gi, '%$1').replace(/_/g, '/'));
        console.log(`[LinkResolver] Unwrapped Proofpoint URL → ${decoded}`);
        return decoded;
      } catch { /* fall through */ }
    }
  }
  // Microsoft SafeLinks
  if (url.includes("safelinks.protection.outlook.com")) {
    const match = url.match(/[?&]url=([^&]+)/);
    if (match) {
      try {
        const decoded = decodeURIComponent(match[1]);
        console.log(`[LinkResolver] Unwrapped SafeLinks URL → ${decoded}`);
        return decoded;
      } catch { /* fall through */ }
    }
  }
  return url;
}

// ── Normalize known share links to direct download URLs ──────────────────────
export function normalizeUrl(url: string): string {
  // First unwrap any security scanner wrappers
  url = unwrapSecurityUrl(url);

  // Google Drive: /file/d/FILE_ID/view → /uc?export=download&id=FILE_ID
  const gdrive = url.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (gdrive) return `https://drive.google.com/uc?export=download&id=${gdrive[1]}`;

  // Google Drive open?id= format
  const gdriveOpen = url.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (gdriveOpen) return `https://drive.google.com/uc?export=download&id=${gdriveOpen[1]}`;

  // Dropbox: force direct download
  if (url.includes("dropbox.com")) {
    // Remove dl param and re-add as dl=1, also handle ?st= and ?rlkey= params
    const u = new URL(url);
    u.searchParams.set("dl", "1");
    return u.toString();
  }

  // OneDrive share link → direct download
  if (url.includes("1drv.ms") || url.includes("onedrive.live.com")) {
    const encoded = Buffer.from(url).toString("base64").replace(/=$/, "");
    return `https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`;
  }

  return url;
}

// ── Follow redirects and get final URL + content type ────────────────────────
async function getFinalUrlAndType(url: string): Promise<{ finalUrl: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const req = protocol.get(url, { headers: { "User-Agent": "RCPBot/1.0" } }, (res) => {
      const contentType = (res.headers["content-type"] || "").toLowerCase();
      const location = res.headers["location"];
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) && location) {
        resolve(getFinalUrlAndType(location));
      } else {
        resolve({ finalUrl: url, contentType });
      }
      res.destroy();
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ── Fetch binary and convert to base64 data URL ──────────────────────────────
async function fetchAsBase64DataUrl(url: string, mimeType: string): Promise<string> {
  const resp = await globalThis.fetch(url, {
    headers: { "User-Agent": "RCPBot/1.0" },
    redirect: "follow",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// ── PDF → PNG images via pdftoppm ───────────────────────────────────────
async function pdfToDataUrls(url: string): Promise<string[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcp-pdf-"));
  const pdfPath = path.join(tmpDir, "plan.pdf");

  try {
    // Fetch PDF to disk
    const resp = await globalThis.fetch(url, {
      headers: { "User-Agent": "RCPBot/1.0" },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching PDF`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(pdfPath, buf);
    console.log(`[LinkResolver] PDF downloaded: ${buf.length} bytes → ${pdfPath}`);

    // Convert PDF pages to PNGs using pdftoppm (150 dpi — good balance of quality vs size)
    const outPrefix = path.join(tmpDir, "page");
    await new Promise<void>((resolve, reject) => {
      execFile("pdftoppm", ["-png", "-r", "150", pdfPath, outPrefix], (err) => {
        if (err) reject(err); else resolve();
      });
    });

    // Read all generated page PNGs and convert to base64 data URLs
    const pngFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith(".png"))
      .sort()
      .map(f => path.join(tmpDir, f));

    console.log(`[LinkResolver] PDF converted to ${pngFiles.length} page(s)`);

    const dataUrls = pngFiles.map(f => {
      const data = fs.readFileSync(f);
      return `data:image/png;base64,${data.toString("base64")}`;
    });

    return dataUrls;
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Main resolver ─────────────────────────────────────────────────────────────
export interface ResolvedMedia {
  imageUrls: string[];   // ready-to-use URLs/data-URLs for OpenAI Vision
  resolvedCount: number; // how many links were successfully resolved
  failedCount: number;
}

export async function resolveLinksFromText(text: string): Promise<ResolvedMedia> {
  const rawUrls = extractUrls(text);
  if (rawUrls.length === 0) return { imageUrls: [], resolvedCount: 0, failedCount: 0 };

  const imageUrls: string[] = [];
  let resolvedCount = 0;
  let failedCount = 0;

  for (const raw of rawUrls) {
    try {
      const normalized = normalizeUrl(raw);
      const lower = normalized.toLowerCase();

      // Direct image URL by extension
      if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/.test(lower)) {
        imageUrls.push(normalized);
        resolvedCount++;
        continue;
      }

      // Direct PDF by extension
      if (/\.pdf(\?.*)?$/.test(lower)) {
        const pages = await pdfToDataUrls(normalized);
        imageUrls.push(...pages);
        resolvedCount++;
        continue;
      }

      // Unknown — follow redirects to detect content type
      const { finalUrl, contentType } = await getFinalUrlAndType(normalized);

      if (contentType.includes("image/")) {
        imageUrls.push(finalUrl);
        resolvedCount++;
      } else if (contentType.includes("pdf")) {
        const pages = await pdfToDataUrls(finalUrl);
        imageUrls.push(...pages);
        resolvedCount++;
      } else if (contentType.includes("octet-stream") || contentType === "") {
        // Binary blob — try treating as PDF base64
        try {
          const pages = await pdfToDataUrls(finalUrl);
          imageUrls.push(...pages);
          resolvedCount++;
        } catch {
          console.warn(`[LinkResolver] Could not decode binary from ${raw}`);
          failedCount++;
        }
      } else {
        console.warn(`[LinkResolver] Unsupported content type "${contentType}" for ${raw}`);
        failedCount++;
      }
    } catch (err: any) {
      console.warn(`[LinkResolver] Failed to resolve ${raw}: ${err?.message}`);
      failedCount++;
    }
  }

  return { imageUrls, resolvedCount, failedCount };
}
