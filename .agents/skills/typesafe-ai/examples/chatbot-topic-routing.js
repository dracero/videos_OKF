/**
 * Example: Chatbot Topic Routing & Chunk Filtering with TypeSafe AI (Jev)
 *
 * Demonstrates how to replace LLM reasoning in the LangGraph agent
 * for:
 * 1. Intent / Topic Routing (pre-search optimization)
 * 2. Retrieved Chunk Relevance & Sufficiency Selection (selectorNode replacement)
 */

import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const client = new TypeSafeClient(apiKey ? { apiKey } : {});

/**
 * 1. Pre-Search Topic Routing
 * Routes user query into specific search filters or sub-corpora.
 */
export async function routeChatbotQuery(userQuery) {
  const response = await client.systemOne({
    state: { query: userQuery },
    questions: {
      topic_domain: choice("Determina el dominio temático de la consulta:", {
        physics: "Física, cinemática, ondas, efecto Doppler, centro instantáneo de rotación (CIR), velocidad y aceleración",
        rag_and_agents: "RAG, agentes autónomos, LangGraph, CrewAI, bases de datos vectoriales, Neo4j, embeddings",
        nlp_transformers: "NLP, transformers, Hugging Face pipelines, sentiment analysis, modelos de texto",
        education_moodle: "Aulas virtuales de cátedra, configuración de Moodle, organización de recursos"
      }),
      query_type: choice("Tipo de intención detrás de la consulta:", {
        conceptual: "Pregunta teórica o explicativa ('¿Qué es...', '¿Cómo funciona...')",
        implementation: "Búsqueda de código, tutorial paso a paso, configuración de scripts",
        navigational: "Búsqueda de un video o recurso específico ('en qué video se habla de...')"
      })
    }
  });

  return {
    domain: response.answers.topic_domain.choice,
    domainConfidence: response.answers.topic_domain.confidence,
    intent: response.answers.query_type.choice
  };
}

/**
 * 2. Fast Chunk Selection & Sufficiency Check (Selector Node)
 * Evaluates retrieved transcript segments without calling a heavy LLM.
 */
export async function selectRelevantChunks(userQuery, retrievedChunks) {
  if (!retrievedChunks || retrievedChunks.length === 0) {
    return { selectedChunks: [], isSufficient: false };
  }

  // Parallel evaluation with TypeSafe Jev (70-200ms per batch)
  const evaluations = await Promise.all(
    retrievedChunks.map(async (chunk) => {
      const excerpt = chunk.segment?.text || chunk.description || chunk.title;
      const res = await client.systemOne({
        state: {
          query: userQuery,
          video_title: chunk.concept?.title || chunk.title || "",
          text_snippet: excerpt
        },
        questions: {
          is_relevant: noul("El fragmento aporta información directamente útil para responder la consulta del usuario.")
        }
      });

      const relevanceProb = res.answers.is_relevant.noul;
      return {
        chunk,
        isRelevant: relevanceProb >= 0.60,
        relevanceScore: relevanceProb
      };
    })
  );

  const selectedChunks = evaluations
    .filter(e => e.isRelevant)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .map(e => e.chunk);

  // Calibrate sufficiency: we have at least 2 relevant chunks or a very high score chunk
  const isSufficient = selectedChunks.length >= 2 || (
    selectedChunks.length === 1 && evaluations[0].relevanceScore > 0.85
  );

  return {
    selectedChunks,
    isSufficient,
    evaluatedCount: retrievedChunks.length
  };
}
