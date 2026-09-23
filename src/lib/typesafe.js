import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import dotenv from 'dotenv';

dotenv.config();

let clientInstance = null;

/**
 * Singleton factory for TypeSafeClient (AGENTS.md §1.4)
 * @returns {TypeSafeClient | null}
 */
export function getTypeSafeClient() {
  if (!clientInstance) {
    const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
      console.warn('[TypeSafe] JEV_API_KEY or TYPESAFE_API_KEY is not defined in environment.');
      return null;
    }
    clientInstance = new TypeSafeClient({ apiKey });
  }
  return clientInstance;
}

/**
 * Comprehensive taxonomy for Diego Racero's YouTube Catalog
 */
export const CATALOG_CATEGORIES = {
  home_automation_iot: "Home Assistant, domótica, IoT, cámaras ONVIF, sensores, automatización del hogar, ESP32, MQTT, hardware y dispositivos inteligentes",
  rag_and_agents: "Sistemas RAG, agentes inteligentes, CrewAI, AutoGen, LangGraph, bases de datos vectoriales, Neo4j, embeddings, MCP, reasoning",
  nlp_transformers: "Modelos de lenguaje, Hugging Face pipelines, sentiment analysis, finetuning, procesamiento de lenguaje natural, NLU, LLMs",
  computer_vision: "Visión por computadora, modelos de imágenes, dermatoscopía, radiografías, detección visual, Roboflow, YOLO, OpenCV",
  physics_and_math: "Física universitaria, cinemática, ondas mecánicas, dinámica de cuerpo rígido, efecto Doppler, CIR, velocidad y aceleración",
  education_moodle: "Aulas virtuales de cátedra, configuración de Moodle, organización de recursos educativos, evaluaciones, FIUBA",
  software_web_dev: "Desarrollo web, Astro, hosting, APIs, Git, Docker, herramientas de software y programación",
  general_institutional: "Reuniones de cátedra, presentaciones, bienvenidas, avisos o pruebas generales"
};

/**
 * 1. Video Classification for Catalog Sync
 * Categorizes video into technical domain, code presence, and target difficulty.
 *
 * @param {Object} params
 * @param {string} params.title
 * @param {string} params.description
 * @param {string} [params.transcriptSummary]
 * @returns {Promise<Object>}
 */
export async function classifyVideoMetadata({ title, description, transcriptSummary }) {
  const client = getTypeSafeClient();
  if (!client) {
    return {
      category: 'general_institutional',
      categoryConfidence: 0.0,
      hasCode: false,
      difficultyScore: 1.0
    };
  }

  try {
    const response = await client.systemOne({
      state: {
        title: title || 'Untitled Video',
        description: description?.substring(0, 300) || '',
        transcript: transcriptSummary?.substring(0, 1000) || ''
      },
      questions: {
        category: choice("Clasifica el video en una de las áreas temáticas del canal de Diego Racero:", CATALOG_CATEGORIES),
        has_code_demo: noul("El video muestra código fuente, terminal, Jupyter/Colab o implementación en vivo"),
        difficulty: score("Nivel de complejidad y prerrequisitos del contenido del video", [
          "Introductorio / Divulgación",
          "Intermedio con código o fundamentos técnicos",
          "Avanzado / Arquitectura técnica profunda"
        ])
      }
    });

    const answers = response.answers;
    return {
      category: answers.category.choice,
      categoryConfidence: answers.category.confidence,
      hasCode: answers.has_code_demo.noul > 0.5,
      difficultyScore: answers.difficulty.score
    };
  } catch (err) {
    console.error('[TypeSafe] Error in classifyVideoMetadata:', err.message);
    return {
      category: 'general_institutional',
      categoryConfidence: 0.0,
      hasCode: false,
      difficultyScore: 1.0
    };
  }
}

/**
 * 2. Topic & Intent Routing for Chatbot (Pre-Search)
 * Rapidly classifies the user query into domain and intent (<100ms).
 *
 * @param {string} userQuery
 * @returns {Promise<Object>}
 */
export async function routeUserQuery(userQuery) {
  const client = getTypeSafeClient();
  if (!client) {
    return {
      domain: 'all',
      domainConfidence: 0.0,
      intent: 'conceptual'
    };
  }

  try {
    const response = await client.systemOne({
      state: { query: userQuery },
      questions: {
        domain: choice("Determina el dominio temático de la consulta:", {
          home_automation_iot: "Home Assistant, domótica, IoT, cámaras ONVIF, sensores, automatización del hogar, ESP32, MQTT",
          rag_and_agents: "RAG, agentes autónomos, LangGraph, CrewAI, bases de datos vectoriales, Neo4j, embeddings, MCP",
          nlp_transformers: "NLP, transformers, Hugging Face pipelines, sentiment analysis, modelos de texto",
          computer_vision: "Visión artificial, reconocimiento de imágenes, detección de objetos, Roboflow, YOLO",
          physics: "Física, cinemática, ondas, efecto Doppler, centro instantáneo de rotación (CIR), velocidad y aceleración",
          education_moodle: "Aulas virtuales de cátedra, configuración de Moodle, organización de recursos de asignaturas",
          software_web_dev: "Desarrollo web, Astro, hosting, programación de aplicaciones, Git",
          general: "Preguntas generales, de saludo o que no corresponden a un tema técnico específico"
        }),
        intent: choice("Tipo de intención del usuario:", {
          conceptual: "Pregunta teórica, explicativa o conceptual ('¿Qué es...', '¿Cómo funciona...')",
          implementation: "Búsqueda de código, configuración técnica, scripts paso a paso",
          navigational: "Búsqueda o localización de un video ('en qué video se explica...')"
        })
      }
    });

    return {
      domain: response.answers.domain.choice,
      domainConfidence: response.answers.domain.confidence,
      intent: response.answers.intent.choice
    };
  } catch (err) {
    console.error('[TypeSafe] Error in routeUserQuery:', err.message);
    return {
      domain: 'general',
      domainConfidence: 0.0,
      intent: 'conceptual'
    };
  }
}

/**
 * 3. Fast Chunk Relevance Evaluator (Selector Node)
 * Evaluates whether retrieved segments are directly useful using noul assertions.
 *
 * @param {string} userQuery
 * @param {Array} chunks
 * @returns {Promise<{ selectedChunks: Array, isSufficient: boolean }>}
 */
export async function evaluateChunksWithJev(userQuery, chunks) {
  const client = getTypeSafeClient();
  if (!client || !chunks || chunks.length === 0) {
    return {
      selectedChunks: chunks || [],
      isSufficient: (chunks && chunks.length > 0)
    };
  }

  try {
    // Parallel evaluation of candidate chunks (typical latency: 100-200ms total)
    const evaluations = await Promise.all(
      chunks.slice(0, 16).map(async (chunk) => {
        const textExcerpt = chunk.segment?.text || chunk.description || chunk.title || '';
        const videoTitle = chunk.concept?.title || chunk.title || '';

        const res = await client.systemOne({
          state: {
            user_query: userQuery,
            video_title: videoTitle,
            spoken_text: textExcerpt
          },
          questions: {
            is_relevant: noul("El fragmento de texto aporta información directamente útil para responder la consulta del usuario")
          }
        });

        const prob = res.answers.is_relevant.noul;
        return {
          chunk,
          isRelevant: prob >= 0.60,
          relevanceScore: prob
        };
      })
    );

    const selected = evaluations
      .filter(e => e.isRelevant)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .map(e => e.chunk);

    // Context is sufficient if we found at least 2 relevant segments, or 1 segment with very high confidence
    const isSufficient = selected.length >= 2 || (
      selected.length === 1 && evaluations[0].relevanceScore >= 0.85
    );

    return {
      selectedChunks: selected,
      isSufficient
    };
  } catch (err) {
    console.error('[TypeSafe] Error in evaluateChunksWithJev:', err.message);
    // Graceful fallback: return top chunks
    return {
      selectedChunks: chunks.slice(0, 5),
      isSufficient: chunks.length > 0
    };
  }
}

/**
 * 4. Synthesizer with TypeSafe Jev (Responder Node)
 * Completely eliminates heavy LLMs like Gemini.
 * Uses Jev to rank the primary answer and evaluate completeness, then formats
 * a rich, exact, markdown response with video timestamp links.
 *
 * @param {Object} params
 * @param {string} params.query
 * @param {Array} params.selectedChunks
 * @param {string} [params.topicDomain]
 * @param {string} [params.queryIntent]
 * @returns {Promise<string>}
 */
export async function synthesizeAnswerWithJev({ query, selectedChunks, topicDomain = 'general', queryIntent = 'conceptual' }) {
  if (!selectedChunks || selectedChunks.length === 0) {
    return "Lo siento, no encontré información relevante en el catálogo de videos de Diego Racero para responder a tu pregunta. Intenta reformular tu consulta.";
  }

  const client = getTypeSafeClient();
  let primaryIndex = 0;

  if (client && selectedChunks.length > 1) {
    try {
      // Build options dictionary for Jev choice
      const criteria = {};
      selectedChunks.slice(0, 5).forEach((c, idx) => {
        const text = c.segment?.text || c.title || '';
        criteria[`chunk_${idx}`] = text.substring(0, 150);
      });

      const decision = await client.systemOne({
        state: {
          user_question: query,
          domain: topicDomain,
          intent: queryIntent
        },
        questions: {
          best_match: choice("¿Cuál de estos fragmentos responde con mayor precisión la consulta del usuario?", criteria),
          quality: score("¿Qué tan bien cubre el tema la información disponible?", [
            "Mención breve o secundaria",
            "Explicación sustancial con detalles",
            "Explicación directa y completa"
          ])
        }
      });

      const bestChoice = decision.answers.best_match.choice;
      const parsedIdx = parseInt(bestChoice.replace('chunk_', ''), 10);
      if (!isNaN(parsedIdx) && parsedIdx < selectedChunks.length) {
        primaryIndex = parsedIdx;
      }
    } catch (e) {
      console.warn('[TypeSafe] Synthesis ranking skipped, using top chunk:', e.message);
    }
  }

  const primary = selectedChunks[primaryIndex];
  const otherChunks = selectedChunks.filter((_, idx) => idx !== primaryIndex);

  // Format clean, beautiful markdown response
  const lines = [];

  if (primary.type === 'segment') {
    lines.push(`Basado en el contenido de **Diego Racero** en el video *"${primary.concept.title}"*, en el **minuto ${primary.segment.formattedStart}**:`);
    lines.push(`> "${primary.segment.text}"`);
    lines.push(`👉 [⏱ Ir directamente al minuto ${primary.segment.formattedStart} en el video](/videos/${primary.concept.id}?t=${primary.segment.start})\n`);
  } else {
    lines.push(`En el video *"${primary.title}"* de **Diego Racero**:`);
    if (primary.description) {
      lines.push(`> "${primary.description}"`);
    }
    lines.push(`👉 [⏱ Ver video completo](/videos/${primary.id})\n`);
  }

  if (otherChunks.length > 0) {
    lines.push(`### 📌 Otros momentos relevantes en los videos:`);
    otherChunks.forEach((c) => {
      if (c.type === 'segment') {
        lines.push(`* **${c.concept.title}** (minuto ${c.segment.formattedStart}): "${c.segment.text.substring(0, 180)}..." [⏱ Ir al minuto ${c.segment.formattedStart}](/videos/${c.concept.id}?t=${c.segment.start})`);
      } else {
        lines.push(`* **${c.title}** [Ver video](/videos/${c.id})`);
      }
    });
  }

  return lines.join('\n');
}

