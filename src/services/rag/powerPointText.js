import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Worker } from 'node:worker_threads';

const xmlParser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const orderedParser = new XMLParser({ preserveOrder: true, trimValues: false, removeNSPrefix: true, parseTagValue: false });
const array = value => value ? (Array.isArray(value) ? value : [value]) : [];
const invalid = message => Object.assign(new Error(message), { statusCode: 422 });

function slideText(nodes) {
  let output = '';
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 't') output += value.map(item => item['#text'] || '').join('');
      else if (key === 'br') output += '\n';
      else if (Array.isArray(value)) output += slideText(value) + (key === 'p' ? '\n' : '');
    }
  }
  return output;
}

export async function extractPptx(filePath) {
  const zip = new AdmZip(await fs.readFile(filePath));
  if (zip.getEntries().length > 5000) throw invalid('PowerPoint contains too many archive entries.');
  let expandedBytes = 0;
  const readXml = name => {
    const entry = zip.getEntry(name);
    if (!entry || entry.header.size > 5 * 1024 * 1024) throw invalid('PowerPoint is corrupt or a slide XML exceeds the extraction limit.');
    expandedBytes += entry.header.size;
    if (expandedBytes > 50 * 1024 * 1024) throw invalid('Expanded PowerPoint text exceeds the extraction limit.');
    const text = entry.getData().toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw invalid('PowerPoint contains invalid XML.');
    return text;
  };
  const presentation = xmlParser.parse(readXml('ppt/presentation.xml'));
  const relationships = xmlParser.parse(readXml('ppt/_rels/presentation.xml.rels'));
  const targets = new Map(array(relationships.Relationships?.Relationship)
    .filter(r => r['@_TargetMode'] !== 'External').map(r => [r['@_Id'], r['@_Target']]));
  const slideIds = array(presentation['p:presentation']?.['p:sldIdLst']?.['p:sldId']);
  if (!slideIds.length || slideIds.length > 1000) throw invalid('PowerPoint has no slides or exceeds 1,000 slides.');
  return slideIds.map((slide, index) => {
    const target = targets.get(slide['@_r:id']);
    if (!target) throw invalid('PowerPoint contains a missing slide relationship.');
    const slidePath = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('ppt', target));
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(slidePath)) throw invalid('PowerPoint contains an invalid slide path.');
    return { text: slideText(orderedParser.parse(readXml(slidePath))).trim(), slide: index + 1 };
  });
}

export async function extractLegacyPpt(filePath) {
  const bytes = await fs.readFile(filePath);
  if (bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw invalid('Invalid legacy PPT file. Save it as PPTX and upload again.');
  // Isolate older binary parsing so malformed files cannot block the HTTP loop.
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./legacyPptWorker.js', import.meta.url), {
      workerData: { filePath }, resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: [],
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(invalid('PPT extraction timed out. Save it as PPTX and upload again.')); }, 20000);
    worker.once('message', result => {
      clearTimeout(timer); void worker.terminate();
      if (result.error) reject(invalid('Could not read this legacy PPT. Save it as PPTX and upload again.'));
      else resolve(result.sections);
    });
    worker.once('error', () => { clearTimeout(timer); reject(invalid('Could not read this PPT file.')); });
    worker.once('exit', code => { clearTimeout(timer); reject(invalid('PPT extraction stopped before completing.')); });
  });
}
