import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import http from "http";

type StepState = "pending" | "running" | "done" | "error";

interface RunStep {
  id: string;
  state: StepState;
}

interface Run {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  steps: RunStep[];
}

interface WorkflowDef {
  id: string;
  label: string;
  description: string;
}

const MFC_BASE_URL = process.env.MFC_URL || "http://localhost:3000";

// Fallback-Workflows, falls MFC nicht erreichbar ist
const fallbackWorkflows: WorkflowDef[] = [
  {
    id: "dev-start",
    label: "Dev-Start (MFC)",
    description: "Startet die Dev-Umgebung für Meventa Flight Control.",
  },
  {
    id: "hueter-dev-session",
    label: "Hüter-Dev-Session",
    description:
      "Geführte Session, um an Hüter / Meventa zu entwickeln (Planung + 1 Fokus-Aufgabe).",
  },
];

// In-Memory-Store für Runs (v0.1, nicht persistent)
const runs: Record<string, Run> = {};

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());

// -------- Helper: HTTP-Request an MFC --------

function httpRequestToMfc<T = any>(method: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const base = new URL(MFC_BASE_URL);
    const url = new URL(path, base);

    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
    };

    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        if (!raw) {
          // @ts-ignore
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (e) {
          reject(
            new Error(
              `Failed to parse JSON from MFC ${method} ${path}: ${String(e)}`
            )
          );
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.end();
  });
}

// -------- Routes --------

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    message: "Hüter–MFC-Bridge v0.2 läuft (Workflows via MFC)",
    mfcBaseUrl: MFC_BASE_URL,
  });
});

// 1) Workflows auflisten – jetzt über die echte MFC
// GET /workflows
app.get("/workflows", async (_req, res) => {
  try {
    const mfcData = await httpRequestToMfc<{ workflows: any[] }>(
      "GET",
      "/api/workflows"
    );

    if (!mfcData || !Array.isArray(mfcData.workflows)) {
      throw new Error("Unerwartete Antwortstruktur von MFC /api/workflows");
    }

    const mapped: WorkflowDef[] = mfcData.workflows.map((w: any) => ({
      id: String(w.id),
      label: String(w.label || w.id),
      description: String(w.description || ""),
    }));

    return res.json(mapped);
  } catch (e: any) {
    console.error(
      "Fehler beim Laden der Workflows von der MFC, nutze Fallback:",
      e?.message || e
    );
    // Fallback auf statische Liste
    return res.json(fallbackWorkflows);
  }
});

// 2) Workflow starten – v0.1 noch intern in der Bridge
// POST /workflows/:id/start
app.post("/workflows/:id/start", (req, res) => {
  const { id } = req.params;

  // In v0.2 akzeptieren wir jede id, idealerweise aber eine aus der Liste.
  const now = new Date().toISOString();
  const runId = `run-${now.replace(/[:.]/g, "-")}-${id}`;

  const steps: RunStep[] = [
    { id: `${id}-step-1`, state: "running" },
    { id: `${id}-step-2`, state: "pending" },
  ];

  const run: Run = {
    runId,
    workflowId: id,
    status: "running",
    startedAt: now,
    finishedAt: null,
    steps,
  };

  runs[runId] = run;

  return res.status(202).json(run);
});

// 3) Run-Status abfragen
// GET /runs/:runId
app.get("/runs/:runId", (req, res) => {
  const { runId } = req.params;
  const run = runs[runId];

  if (!run) {
    return res.status(404).json({ error: "Run not found", runId });
  }

  return res.json(run);
});

// optional: alle Runs zum Debuggen
app.get("/runs", (_req, res) => {
  res.json(Object.values(runs));
});

app.listen(port, () => {
  console.log(`Hüter–MFC-Bridge listening on http://localhost:${port}`);
  console.log(`MFC Base URL: ${MFC_BASE_URL}`);
});
