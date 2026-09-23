---
name: typesafe-ai
description: >-
  Use this skill when integrating TypeSafe AI (Jev / System One models) for structured decision-making, fast classification, topic routing, scoring, or guardrails without using heavy conversational LLMs.
---

# TypeSafe AI (System One / Jev) Integration Guide

TypeSafe AI provides **System One** decision models (notably **Jev**) optimized for sub-second, structured, and probabilistic evaluations. Unlike traditional generative LLMs (Gemini, Claude, GPT) that generate unstructured tokens, Jev evaluates an input state against declared typed questions and returns calibrated, structured results.

Use TypeSafe AI to replace generative LLMs for:
1. **Catalog & Video Classification**: Categorizing videos into subject topics, difficulty tiers, and content flags.
2. **Chatbot Topic Routing & Intent Selection**: Directing user queries to specialized sub-indexes, knowledge domains, or retrieval strategies.
3. **Context Relevance & Gatekeeping**: Scoring whether retrieved chunks are relevant and sufficient before invoking expensive generative models (the **Cascade Pattern**).

---

## 1. Quick Start

### Installation

```bash
npm install @typesafe-ai/sdk
```

### Environment Variable

Configure in `.env`:
```env
JEV_API_KEY=apikey_...
# o alternativamente:
# TYPESAFE_API_KEY=ts_live_...
```

Instanciar el cliente:
```javascript
import { TypeSafeClient } from "@typesafe-ai/sdk";

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const client = new TypeSafeClient(apiKey ? { apiKey } : {});
```

---

## 2. Core Primitives

Jev opera con tres tipos de preguntas fundamentales:

| Primitiva | Sintaxis SDK | Salida | Caso de uso típico |
|---|---|---|---|
| **`choice`** | `choice(instructions, criteria)` | Etiqueta ganadora (`choice`), probabilidades y `confidence` | Clasificación de tema, enrutamiento de intención |
| **`noul`** | `noul(instructions, criteria?)` | Probabilidad booleana de 0.0 a 1.0 (`noul`) | Filtro de relevancia de fragmentos (`is_relevant`), suficiencia |
| **`score`** | `score(instructions, criteria)` | Valor numérico en espectro ordenado (`score`) y `confidence` | Nivel de dificultad (principiante a avanzado), nivel de detalle |

Para referencia exhaustiva de parámetros y esquemas, ver [API Reference](./references/api-reference.md).

---

## 3. Patrones de Implementación en `videos_OKF`

### A. Clasificación de Videos en el Catálogo (`sync.js`)

En lugar de llamar a un LLM generativo para cada video o depender de etiquetas manuales de YouTube:

1. Se envía el título, descripción y resumen de transcripción como `state`.
2. Pregunta `choice` para el área temática principal.
3. Pregunta `noul` para verificar si incluye demostración de código en vivo.
4. Pregunta `score` para estimar el nivel de dificultad.

Ver módulo de ejemplo: [video-classification.js](./examples/video-classification.js).

```javascript
import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const client = new TypeSafeClient(apiKey ? { apiKey } : {});

export async function classifyVideoContent({ title, description, transcriptSummary }) {
  const response = await client.systemOne({
    state: {
      title,
      description,
      summary: transcriptSummary
    },
    questions: {
      topic: choice("Clasifica el video en una de las áreas temáticas principales del canal de Diego Racero:", {
        rag_agents: "Sistemas RAG, agentes inteligentes, LangGraph, AutoGen, CrewAI, embeddings, vector databases",
        nlp_transformers: "Modelos de lenguaje, Hugging Face, pipelines de NLP, análisis de sentimiento",
        computer_vision: "Visión por computadora, modelos de imágenes, dermatoscopía, clasificación de rayos X",
        physics_simulation: "Física universitaria, mecánica clásica, efecto Doppler, cinemática, ondas",
        academic_teaching: "Uso de Moodle, gestión de cátedras, diseño instruccional, administración educativa"
      }),
      has_code_walkthrough: noul("El video muestra código fuente, implementación técnica o terminal en vivo"),
      difficulty: score("Nivel de complejidad técnica requerido para comprender el contenido", [
        "Introductorio / Divulgación sin prerrequisitos",
        "Intermedio con conceptos básicos de programación o matemáticas",
        "Avanzado / Especialización técnica profunda"
      ])
    }
  });

  return {
    topic: response.answers.topic.choice,
    topicConfidence: response.answers.topic.confidence,
    hasCode: response.answers.has_code_walkthrough.noul > 0.5,
    difficultyScore: response.answers.difficulty.score
  };
}
```

---

### B. Chatbot: Topic Routing & Filtrado de Chunks (`agent-graph.js`)

En el grafo RAG del chatbot, se aplica el **Cascade Pattern**:
- **System 1 (Jev / TypeSafe)**: Routing de tema y selección de relevancia de fragmentos (~100ms, $0.042/M tokens).
- **System 2 (Gemini / Generative LLM)**: Únicamente redacción y síntesis final con citas de tiempo.

Ver módulo de ejemplo: [chatbot-topic-routing.js](./examples/chatbot-topic-routing.js).

```javascript
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const client = new TypeSafeClient(apiKey ? { apiKey } : {});

// 1. Topic Routing (Pre-búsqueda)
export async function routeUserQuery(userQuery) {
  const result = await client.systemOne({
    state: { query: userQuery },
    questions: {
      domain: choice("¿A qué dominio de conocimiento pertenece la consulta del usuario?", {
        physics: "Física, cinemática, ondas, efecto Doppler, cuerpo rígido",
        ai_engineering: "Inteligencia artificial, RAG, embeddings, agentes, LangChain, Transformers",
        education_moodle: "Moodle, aulas virtuales, administración de cátedra"
      }),
      needs_code_example: noul("El usuario solicita explícitamente código o implementación práctica")
    }
  });

  return {
    domain: result.answers.domain.choice,
    confidence: result.answers.domain.confidence
  };
}

// 2. Selección de Fragmentos (Reemplazo de selectorNode de Gemini)
export async function evaluateRetrievedChunks(userQuery, chunks) {
  const evaluations = await Promise.all(
    chunks.map(async (chunk) => {
      const evalRes = await client.systemOne({
        state: {
          query: userQuery,
          videoTitle: chunk.concept?.title || chunk.title,
          excerpt: chunk.segment?.text || chunk.description || ""
        },
        questions: {
          is_relevant: noul("El fragmento contiene información útil y directa para responder a la consulta del usuario")
        }
      });
      return {
        chunk,
        isRelevant: evalRes.answers.is_relevant.noul > 0.65,
        relevanceScore: evalRes.answers.is_relevant.noul
      };
    })
  );

  const selected = evaluations.filter(e => e.isRelevant).map(e => e.chunk);

  return {
    selectedChunks: selected,
    isSufficient: selected.length >= 2
  };
}
```

---

## 4. Ventajas clave frente a LLMs Generativos

1. **Latencia Sub-segundo**: ~100ms – 250ms frente a 2000ms – 4000ms de LLMs generativos.
2. **Cero Alucinaciones de Estructura**: Respuestas acotadas estrictamente a los tipos declarados.
3. **Probabilidades Calibradas**: Cada respuesta incluye un índice estadístico de confianza (`confidence`).
4. **Reducción de Costo**: $0.042 por millón de tokens de entrada (tokens de salida gratuitos).
5. **Inmunidad a Prompt Injection**: Dado que Jev no genera texto libre ni ejecuta comandos, no es vulnerable a desviaciones por inyección en consultas de usuario.

---

## 5. Referencias & Scripts

- [TypeSafe API Reference](./references/api-reference.md)
- [Video Classification Example](./examples/video-classification.js)
- [Chatbot Topic Routing Example](./examples/chatbot-topic-routing.js)
- [Client Test Script](./scripts/test-typesafe-client.js)
