import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import JSZip from 'jszip';

interface ExtractOptions {
  maxChars?: number;
  maxSheets?: number;
  maxRowsPerSheet?: number;
  maxSlides?: number;
}

const DEFAULT_OPTIONS: Required<ExtractOptions> = {
  maxChars: 8000,
  maxSheets: 3,
  maxRowsPerSheet: 120,
  maxSlides: 20,
};

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n... (truncated)`;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractXlsxText(filePath: string, options: Required<ExtractOptions>): string {
  const wb = XLSX.readFile(filePath, { cellDates: true, cellText: true, dense: false });
  const sheetNames = wb.SheetNames.slice(0, options.maxSheets);
  const chunks: string[] = [];

  for (const sheetName of sheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      blankrows: false,
    }) as unknown[][];

    chunks.push(`# Sheet: ${sheetName}`);
    for (const row of rows.slice(0, options.maxRowsPerSheet)) {
      const values = row
        .map((cell) => String(cell ?? '').trim())
        .filter((cell) => cell.length > 0);
      if (values.length === 0) continue;
      chunks.push(values.join(' | '));
    }
    chunks.push('');
  }

  return clampText(chunks.join('\n').trim(), options.maxChars);
}

async function extractPptxText(filePath: string, options: Required<ExtractOptions>): Promise<string> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const slideEntries = Object.keys(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort((a, b) => {
      const ai = Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0);
      const bi = Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0);
      return ai - bi;
    })
    .slice(0, options.maxSlides);

  const chunks: string[] = [];
  for (const entry of slideEntries) {
    const xml = await zip.files[entry].async('text');
    const slideNo = Number(entry.match(/slide(\d+)\.xml/i)?.[1] || 0);
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXmlEntities(match[1]).trim())
      .filter(Boolean);

    if (texts.length === 0) continue;
    chunks.push(`# Slide ${slideNo}`);
    chunks.push(...texts);
    chunks.push('');
  }

  return clampText(chunks.join('\n').trim(), options.maxChars);
}

export async function extractAttachmentText(filePath: string, opts: ExtractOptions = {}): Promise<string | null> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const ext = path.extname(filePath).toLowerCase();

  if (!fs.existsSync(filePath)) return null;

  try {
    if (ext === '.xlsx' || ext === '.xls') {
      const text = extractXlsxText(filePath, options);
      return text || null;
    }

    if (ext === '.pptx') {
      const text = await extractPptxText(filePath, options);
      return text || null;
    }

    return null;
  } catch {
    return null;
  }
}
