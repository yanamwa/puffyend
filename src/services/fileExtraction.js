import fs from "node:fs/promises";
import mammoth from "mammoth";

import { extractTextFromPdf } from "./pdfService.js";

async function extractTextFromTxt(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");

    return text.trim();
  } catch (error) {
    console.error("TXT extraction failed:", error);

    return "";
  }
}

async function extractTextFromDocx(filePath) {
  try {
    const result = await mammoth.extractRawText({
      path: filePath,
    });

    return String(result?.value || "").trim();
  } catch (error) {
    console.error("DOCX extraction failed:", error);

    return "";
  }
}

export async function extractTextFromUploadedFile(filePath, extension) {
  const normalizedExtension = String(extension || "")
    .replace(/^\./, "")
    .toLowerCase();

  switch (normalizedExtension) {
    case "txt":
      return extractTextFromTxt(filePath);

    case "docx":
      return extractTextFromDocx(filePath);

    case "pdf":
      return extractTextFromPdf(filePath);

    default:
      return "";
  }
}
