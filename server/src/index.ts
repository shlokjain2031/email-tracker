import express from "express";
import { initDb } from "./db/sqlite.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { trackRouter } from "./routes/track.js";

const app = express();
const port = Number(process.env.PORT ?? 8080);

app.set("trust proxy", true);
initDb();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(dashboardRouter);
app.use(trackRouter);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Tracker server listening on :${port}`);
});
