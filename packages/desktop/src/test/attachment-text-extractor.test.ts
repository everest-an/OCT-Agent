import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import JSZip from 'jszip';
import { extractAttachmentText } from '../../electron/attachment-text-extractor';

describe('attachment-text-extractor', () => {
  it('extracts table text from xlsx', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-xlsx-'));
    const filePath = path.join(tempDir, 'sample.xlsx');

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name', 'Role'],
      ['Alice', 'Engineer'],
      ['Bob', 'Designer'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'People');
    XLSX.writeFile(wb, filePath);

    const text = await extractAttachmentText(filePath);
    expect(text).toContain('# Sheet: People');
    expect(text).toContain('Name | Role');
    expect(text).toContain('Alice | Engineer');
  });

  it('extracts slide text from pptx', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-pptx-'));
    const filePath = path.join(tempDir, 'sample.pptx');

    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Hello Slide</a:t></a:r></a:p><a:p><a:r><a:t>Quarterly Plan</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(filePath, buffer);

    const text = await extractAttachmentText(filePath);
    expect(text).toContain('# Slide 1');
    expect(text).toContain('Hello Slide');
    expect(text).toContain('Quarterly Plan');
  });

  it('returns null for unsupported extension', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oct-txt-'));
    const filePath = path.join(tempDir, 'sample.txt');
    fs.writeFileSync(filePath, 'plain text', 'utf8');

    const text = await extractAttachmentText(filePath);
    expect(text).toBeNull();
  });
});
