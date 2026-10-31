// Small, real format fixtures without adding document-generation dependencies.
export function makePdf(text) {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 11 Tf 40 750 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeDocx(paragraphs) {
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const files = {
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${escape(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  };
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [filename, value] of Object.entries(files)) {
    const name = Buffer.from(filename),
      data = Buffer.from(value),
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(3, 8);
  end.writeUInt16LE(3, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

import AdmZip from "adm-zip";
import CFB from "cfb";
export function makePptx(slides) {
  const zip = new AdmZip();
  const escape = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  zip.addFile(
    "ppt/presentation.xml",
    Buffer.from(
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="r${i}"/>`).join("")}</p:sldIdLst></p:presentation>`,
    ),
  );
  zip.addFile(
    "ppt/_rels/presentation.xml.rels",
    Buffer.from(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="r${i}" Target="slides/slide${20 - i}.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/>`).join("")}</Relationships>`,
    ),
  );
  slides.forEach((text, i) =>
    zip.addFile(
      `ppt/slides/slide${20 - i}.xml`,
      Buffer.from(
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${text
          .split("\n")
          .map(
            (t) =>
              `<a:p>${t
                .split(" ")
                .map(
                  (word, j) =>
                    `<a:r><a:t>${escape((j ? " " : "") + word)}</a:t></a:r>`,
                )
                .join("")}</a:p>`,
          )
          .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      ),
    ),
  );
  return zip.toBuffer();
}
export function makePpt(texts) {
  const record = (type, body, version = 0) => {
    const h = Buffer.alloc(8);
    h.writeUInt16LE(version, 0);
    h.writeUInt16LE(type, 2);
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const doc = record(
    1000,
    record(
      4080,
      Buffer.concat(texts.map((t) => record(4000, Buffer.from(t, "utf16le")))),
      15,
    ),
    15,
  );
  const edit = Buffer.alloc(16);
  edit.writeUInt32LE(doc.length + 24, 12);
  const directory = Buffer.alloc(8);
  directory.writeUInt32LE((1 << 20) | 1, 0);
  const current = Buffer.alloc(12);
  current.writeUInt32LE(doc.length, 8);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "Current User", record(4086, current));
  CFB.utils.cfb_add(
    cfb,
    "PowerPoint Document",
    Buffer.concat([doc, record(4085, edit), record(6002, directory)]),
  );
  return CFB.write(cfb, { type: "buffer" });
}
