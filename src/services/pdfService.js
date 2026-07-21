import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";

export async function extractTextFromPdf(
  filePath
) {
  let parser = null;

  try {
    console.log("PDF extraction started.");

    const pdfBuffer =
      await fs.readFile(filePath);

    parser = new PDFParse({
      data: pdfBuffer,
    });

    const result =
      await parser.getText();

    const text = String(
      result?.text || ""
    ).trim();

    console.log(
      "Extracted PDF text length:",
      text.length
    );

    if (text) {
      console.log(
        "PDF text preview:",
        text.slice(0, 300)
      );
    }

    return text;
  } catch (error) {
    console.error(
      "PDF extraction failed:",
      error
    );

    return "";
  } finally {
    if (parser) {
      await parser
        .destroy()
        .catch(() => {});
    }
  }
}