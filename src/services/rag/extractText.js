import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { extractPptx, extractLegacyPpt } from './powerPointText.js';

export async function extractText(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  let sections;
  if (extension === '.pptx') {
    sections = await extractPptx(file.path);
  } else if (extension === '.ppt') {
    sections = await extractLegacyPpt(file.path);
  } else if (extension === '.pdf') {
    const parser = new PDFParse({ data: await fs.readFile(file.path) });
    try {
      const result = await parser.getText();
      sections = result.pages.map(page => ({ text: page.text, page: page.num }));
    } finally { await parser.destroy(); }
  } else if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: file.path });
    sections = result.value.split(/\n\s*\n/).map((text, paragraph) => ({ text, paragraph }));
  } else if (extension === '.txt') {
    sections = [{ text: await fs.readFile(file.path, 'utf8') }];
  } else {
    throw Object.assign(new Error('Only PDF, PPT, PPTX, DOCX, and TXT files are supported.'), { statusCode: 400 });
  }
  let text = '';
  const positions = [];
  for (const section of sections) {
    const value = section.text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    if (!value) continue;
    if (text) text += '\n\n';
    const start = text.length;
    text += value;
    const { text: ignored, ...position } = section;
    positions.push({ start, end: text.length, ...position });
  }
  if (!text.trim()) throw Object.assign(new Error('No searchable text found. Scanned PDFs and image-only slides require OCR before RAG indexing.'), { statusCode: 422 });
  return { text, positions };
}
