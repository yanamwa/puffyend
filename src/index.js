import "./environment.js";
import express from "express";
import {
  apiCors,
  mountApiAvailability,
  failStartup,
} from "./middleware/apiAvailability.js";

// Listen before importing database clients, validators, or application routes.
// Startup failures must remain observable through the health endpoint.
const app = express();
app.disable("x-powered-by");
const availability = {
  ready: false,
  failed: false,
  stage: "loading_application",
};
const origins = ["https://puffybrain.fun", "https://www.puffybrain.fun"];
try {
  if (process.env.FRONTEND_URL)
    origins.push(new URL(process.env.FRONTEND_URL).origin);
} catch {
  // Application configuration validation reports an invalid FRONTEND_URL.
}
if (process.env.NODE_ENV !== "production") {
  for (const host of ["localhost", "127.0.0.1"])
    for (const port of ["", ":3000", ":3001", ":3002", ":3003", ":5173"])
      origins.push(`http://${host}${port}`);
}
app.use(apiCors(origins));
mountApiAvailability(app, availability);

const server = app.listen(process.env.PORT || 5000, "0.0.0.0", () => {
  console.log(
    `PuffyBrain HTTP server listening on port ${server.address().port}`,
  );
  void import("./application.js")
    .then(({ startApplication }) => startApplication(app, availability))
    .catch((error) => failStartup(availability, error));
});
server.on("error", (error) => {
  console.error("HTTP SERVER FAILED TO LISTEN:", error.code || "listen error");
  process.exit(1);
});
