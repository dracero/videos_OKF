/**
 * Verification script for TypeSafe AI integration.
 * Usage: node .agents/skills/typesafe-ai/scripts/test-typesafe-client.js
 */

import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;

console.log("=== TypeSafe AI Setup Check ===");

if (!apiKey) {
  console.warn("⚠️  JEV_API_KEY or TYPESAFE_API_KEY is not defined in .env");
  console.log("ℹ️  To use TypeSafe AI:");
  console.log("   1. Log in to https://console.typesafe.ai/home");
  console.log("   2. Generate an API Key under Settings / API Keys");
  console.log("   3. Add `JEV_API_KEY=...` to your .env file");
  console.log("   4. Install the SDK: npm install @typesafe-ai/sdk");
  process.exit(0);
}

console.log("✅ API Key detected (length: " + apiKey.length + ")");

async function runCheck() {
  try {
    const { TypeSafeClient, choice, noul } = await import('@typesafe-ai/sdk');
    const client = new TypeSafeClient({ apiKey });

    console.log("Testing connection with a sample System One request...");
    const start = Date.now();
    const res = await client.systemOne({
      state: "Cómo implementar un sistema RAG con LangGraph y bases vectoriales",
      questions: {
        domain: choice("Clasifica el tema técnico", {
          ai: "Inteligencia artificial y RAG",
          physics: "Física y cinemática",
          other: "Otros temas"
        }),
        is_relevant: noul("Es una consulta sobre ingeniería de IA")
      }
    });

    const elapsed = Date.now() - start;
    console.log(`✅ Success in ${elapsed}ms!`);
    console.log("Model:", res.model);
    console.log("Answers:", JSON.stringify(res.answers, null, 2));
    console.log("Usage:", res.usage);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn("⚠️  @typesafe-ai/sdk is not installed yet. Run: npm install @typesafe-ai/sdk");
    } else {
      console.error("❌ Error communicating with TypeSafe API:", err.message);
      if (err.status) console.error("HTTP Status:", err.status);
      if (err.body) console.error("Response Body:", err.body);
    }
  }
}

runCheck();
