import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import PPT from "ppt-to-text";

try {
  const presentation = PPT.readBuffer(fs.readFileSync(workerData.filePath));
  const sections = PPT.utils.to_text(presentation).map((text, index) => ({
    text: String(text || ""),
    section: index + 1,
    format: "legacy-ppt",
  }));
  parentPort.postMessage({ sections });
} catch {
  parentPort.postMessage({ error: true });
}
