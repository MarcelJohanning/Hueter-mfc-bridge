// src/server.ts
//
// Hüter-MFC-Bridge v0.3 – stabil
// - nimmt Tasks vom Meventa Flight Control entgegen
// - ruft Lio (OpenAI) auf, um aus somatischer Sprache
//   eine strukturierte Hüter-Task zu erzeugen
// - leitet die strukturierte Task an den Hüter-Core weiter
//
// Start: npm run dev

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------------------------------
// Typen
// -----------------------------------------------------

interface IncomingTask {
  id: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  author: string;
  rawText: string;
}

export type RecommendedNextStep =
  | "SEND_TO_HUETER"
  | "ASK_HUMAN_FOR_INFO"
  | "NEEDS_DESIGN_DECISION"
  | "JUST_INFORMATION"
  | "UNKNOWN";

export interface StructuredHueterTask {
  originalTaskId: string;
  goal: string;
  contextSummary: string;
  knowledgeRequirements: string[];
  subtasks: string[];
  constraints: string[];
  successCriteria: string[];
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  recommendedNextStep: RecommendedNextStep;
  notesForHueter: string;
  notesForHuman?: string;
}

// -----------------------------------------------------
// OpenAI-Client (Lio)
// -----------------------------------------------------

const openaiApiKey = process.env.OPENAI_API_KEY;

if (!openaiApiKey) {
  console.warn(
    "[BRIDGE] WARNUNG: Keine OPENAI_API_KEY in .env gefunden. " +
      "LLM-Funktionalität ist deaktiviert."
  );
}

const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// Helper: Text aus Responses-API ziehen (kompatibel mit neuem Format)
function extractTextFromResponse(completion: any): string | null {
  try {
    const firstOutput = completion.output?.[0];
    if (!firstOutput) return null;

    const firstContent = firstOutput.content?.[0];
    if (!firstContent) return null;

    // Fall 1: content[0].text ist direkt ein String
    if (typeof firstContent.text === "string") {
      return firstContent.text;
    }

    // Fall 2: neues Responses-Format – output_text mit text.value
    if (
      firstContent.type === "output_text" &&
      firstContent.text &&
      typeof firstContent.text.value === "string"
    ) {
      return firstContent.text.value;
    }

    return null;
  } catch (err) {
    console.error("[BRIDGE] Fehler beim Extrahieren des Textes:", err);
    return null;
  }
}

// Entfernt ```json / ``` Codefences usw.
function cleanJsonText(raw: string): string {
  let text = raw.trim();

  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
    const lastTicks = text.lastIndexOf("```");
    if (lastTicks !== -1) {
      text = text.slice(0, lastTicks);
    }
  }

  return text.trim();
}

async function interpretTaskWithLio(
  task: IncomingTask
): Promise<StructuredHueterTask | null> {
  if (!openai) {
    console.warn(
      "[BRIDGE] OpenAI-Client nicht initialisiert – gebe null zurück."
    );
    return null;
  }

  const systemPrompt = `
Du bist Lio, die zentrale Orchestrierungsinstanz von Meventa.

Du erhältst Aufgaben in sehr natürlicher, somatischer Sprache von einem Menschen (Marcel oder anderen).
Deine Aufgabe ist es, diese in eine strukturierte "Hüter-Task" zu übersetzen, die der Hüter-Core verstehen kann.

Ziele:
- Klarer Zweck (goal)
- Kompakter Kontext (contextSummary)
- Welche Wissensbausteine sind nötig? (knowledgeRequirements)
- Welche sinnvollen Subtasks gibt es? (subtasks)
- Welche Einschränkungen gelten? (constraints)
- Wann ist die Aufgabe "fertig"? (successCriteria)
- Wie wichtig/dringend ist die Aufgabe? (priority)
- Was sollte der Hüter als nächstes tun? (recommendedNextStep)
- Notizen für Hüter (notesForHueter)
- Optional: Notizen für Mensch, falls später Rückfragen entstehen (notesForHuman)

WICHTIG:
- Antworte IMMER als gültiges JSON-Objekt, OHNE zusätzliche Erklärtexte.
- Nutze NUR die folgenden Felder im Root-Objekt:
  originalTaskId, goal, contextSummary, knowledgeRequirements,
  subtasks, constraints, successCriteria, priority,
  recommendedNextStep, notesForHueter, notesForHuman.
- Gib KEINE Markdown-Codeblöcke aus, KEINE \`\`\`. Nur reines JSON.
`;

  const userPrompt = `
Somatische Original-Aufgabe:

"${task.rawText}"

Metadaten:
- Task-ID: ${task.id}
- Autor: ${task.author}
- Zeitpunkt: ${new Date(task.createdAt).toISOString()}

Bitte erzeuge eine strukturierte Hüter-Task im beschriebenen JSON-Format.
`;

  const completion = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const rawText = extractTextFromResponse(completion);
  if (!rawText) {
    console.error(
      "[BRIDGE] Konnte keinen Text aus dem Responses-Output extrahieren:",
      JSON.stringify(completion, null, 2)
    );
    return null;
  }

  const cleaned = cleanJsonText(rawText);

  try {
    const parsed = JSON.parse(cleaned) as StructuredHueterTask;

    if (!parsed.originalTaskId) {
      parsed.originalTaskId = task.id;
    }

    return parsed;
  } catch (err) {
    console.error("[BRIDGE] Fehler beim Parsen des JSON-Outputs:", err);
    console.error("[BRIDGE] Output war:", cleaned);
    return null;
  }
}

// -----------------------------------------------------
// Weitergabe an Hüter-Core
// -----------------------------------------------------

const HUETER_CORE_URL =
  process.env.HUETER_CORE_URL || "http://localhost:3000";

async function forwardStructuredTaskToHueter(
  structured: StructuredHueterTask
): Promise<void> {
  const url = `${HUETER_CORE_URL}/api/structured-tasks`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(structured),
    });

    if (!res.ok) {
      console.error(
        `[BRIDGE] Hüter-Core Antwort nicht OK (${res.status}) beim Senden der structuredTask für ${structured.originalTaskId}`
      );
      return;
    }

    console.log(
      "[BRIDGE] Strukturierte Task erfolgreich an Hüter-Core gesendet:",
      structured.originalTaskId
    );
  } catch (err) {
    console.error(
      "[BRIDGE] Fehler beim Senden der structuredTask an Hüter-Core:",
      err
    );
  }
}

// -----------------------------------------------------
// Routen
// -----------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hueter-mfc-bridge", time: Date.now() });
});

// Entrypoint für neue Tasks aus dem MFC
app.post("/tasks/from-mfc", async (req, res) => {
  const { task } = req.body || {};

  if (!task) {
    return res.status(400).json({ error: "Feld 'task' fehlt im Body." });
  }

  const t = task as IncomingTask;

  console.log("-------------------------------------------------");
  console.log("[BRIDGE] Neue Task aus MFC empfangen:");
  console.log("ID:      ", t.id);
  console.log("Author:  ", t.author);
  console.log("State:   ", t.state);
  console.log("Text:    ", t.rawText);
  console.log("-------------------------------------------------");

  let structured: StructuredHueterTask | null = null;

  try {
    structured = await interpretTaskWithLio(t);
  } catch (err) {
    console.error("[BRIDGE] Fehler bei interpretTaskWithLio:", err);
  }

  if (!structured) {
    console.warn(
      "[BRIDGE] Konnte keine strukturierte Hüter-Task erzeugen."
    );
    return res.json({
      ok: true,
      received: true,
      structuredTask: null,
    });
  }

  console.log("[BRIDGE] Strukturierte Hüter-Task erzeugt:");
  console.log(JSON.stringify(structured, null, 2));
  console.log("-------------------------------------------------");

  forwardStructuredTaskToHueter(structured).catch((err) => {
    console.error(
      "[BRIDGE] Unbehandelter Fehler beim Forward an Hüter-Core:",
      err
    );
  });

  return res.json({
    ok: true,
    received: true,
    structuredTask: structured,
  });
});

// -----------------------------------------------------
// Serverstart
// -----------------------------------------------------

const PORT = process.env.BRIDGE_PORT || 3101;

app.listen(PORT, () => {
  console.log(`[BRIDGE] Hüter-MFC-Bridge läuft auf http://localhost:${PORT}`);
  console.log(`[BRIDGE] Hüter-Core URL: ${HUETER_CORE_URL}`);
  if (!openaiApiKey) {
    console.log(
      "[BRIDGE] HINWEIS: OPENAI_API_KEY fehlt – Lio/LLM ist inaktiv."
    );
  }
});
