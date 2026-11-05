import express from "express";
import { fileURLToPath } from "node:url";
import privateLessonUploads from "./privateLessonUploads.js";

export const uploadsDirectory = fileURLToPath(new URL("../uploads/", import.meta.url));

export default [privateLessonUploads, express.static(uploadsDirectory)];
