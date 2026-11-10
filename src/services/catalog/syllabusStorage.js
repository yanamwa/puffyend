import path from "node:path";
import { fileURLToPath } from "node:url";

export const syllabusDirectory = fileURLToPath(
  new URL("../../private/syllabi/", import.meta.url),
);

export function syllabusFilePath(name) {
  if (!/^[a-f0-9]{36}\.pdf$/.test(name))
    throw Object.assign(new Error("Invalid file reference."), {
      statusCode: 404,
    });
  return path.join(syllabusDirectory, name);
}
