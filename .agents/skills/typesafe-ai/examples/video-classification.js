/**
 * Example: Automated Video Classification using TypeSafe AI (Jev)
 *
 * Use this module during YouTube catalog synchronization (e.g., in sync.js)
 * to assign structured taxonomies, tags, and difficulty ratings to videos.
 */

import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;
const client = new TypeSafeClient(apiKey ? { apiKey } : {});

/**
 * Classifies a video based on its title, description, and transcript snippet.
 * 
 * @param {Object} video
 * @param {string} video.title
 * @param {string} video.description
 * @param {string} video.transcriptSummary
 * @returns {Promise<Object>}
 */
export async function classifyVideo({ title, description, transcriptSummary }) {
  try {
    const response = await client.systemOne({
      state: {
        title,
        description: description?.substring(0, 400) || "",
        transcript_snippet: transcriptSummary?.substring(0, 1000) || ""
      },
      questions: {
        // Main domain category
        primary_topic: choice("Clasifica el video en una de las categorías temáticas principales:", {
          rag_and_agents: "Sistemas RAG, agentes inteligentes, CrewAI, AutoGen, LangGraph, bases de datos vectoriales, embeddings",
          nlp_and_llm: "Modelos de lenguaje, Hugging Face pipelines, sentiment analysis, finetuning, prompts",
          computer_vision: "Modelos de visión, detección de imágenes, dermatoscopía, radiografías",
          physics_and_math: "Física universitaria, cinemática, ondas mecánicas, dinámica de cuerpo rígido, Doppler",
          education_moodle: "Gestión de plataformas educativas, configuración de Moodle, organización de aulas"
        }),

        // Practical content detection
        has_code_demonstration: noul("El video muestra código fuente, ejecución en Google Colab, terminal o programación en vivo"),

        // Difficulty rubric
        target_level: score("Nivel de complejidad y prerrequisitos del contenido del video", [
          "Introductorio / Divulgativo (apto para principiantes)",
          "Intermedio (requiere conocimientos de Python o física básica)",
          "Avanzado (arquitecturas complejas, investigación, modelos matemáticos formales)"
        ])
      }
    });

    const answers = response.answers;

    return {
      category: answers.primary_topic.choice,
      categoryConfidence: answers.primary_topic.confidence,
      hasCode: answers.has_code_demonstration.noul > 0.5,
      targetLevelScore: answers.target_level.score,
      rawProbabilities: answers.primary_topic.probabilities
    };
  } catch (error) {
    console.error("[TypeSafe] Classification error:", error);
    // Fallback default
    return {
      category: "general_tech",
      categoryConfidence: 0.0,
      hasCode: false,
      targetLevelScore: 1.0,
      rawProbabilities: {}
    };
  }
}
