import { Annotation, StateGraph } from "@langchain/langgraph";
import { GoogleGenAI } from '@google/genai';
import { unifiedSemanticSearch } from './semantic-search.js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize the Gemini client
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey });

// 1. Define the Graph State Schema
const ChatState = Annotation.Root({
  query: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => ""
  }),
  searchQuery: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => ""
  }),
  retrievedChunks: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => []
  }),
  selectedChunks: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => []
  }),
  attempts: Annotation({
    reducer: (left, right) => (right !== undefined ? right : left),
    default: () => 0
  }),
  response: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => ""
  })
});

// 2. Node: Searcher (Retrieves items locally using semantic search)
async function searcherNode(state) {
  const query = state.searchQuery || state.query;
  const attempts = state.attempts || 0;
  console.log(`[SearcherNode] Attempt ${attempts + 1}: Searching locally for "${query}"...`);
  
  try {
    const results = await unifiedSemanticSearch(query, 12);
    return {
      retrievedChunks: results,
      attempts: attempts + 1
    };
  } catch (err) {
    console.error('[SearcherNode] Semantic search failed:', err);
    return {
      retrievedChunks: [],
      attempts: attempts + 1
    };
  }
}

// 3. Node: Selector (Filters relevant chunks and decides if query expansion is needed)
async function selectorNode(state) {
  console.log(`[SelectorNode] Evaluating ${state.retrievedChunks.length} retrieved segments...`);
  
  if (!state.retrievedChunks || state.retrievedChunks.length === 0) {
    return { selectedChunks: [] };
  }

  // Format retrieved chunks for the LLM evaluation
  const contextList = state.retrievedChunks.map((c, index) => {
    if (c.type === 'segment') {
      return `[ID: ${index}] Video: "${c.concept.title}" | Canal: "${c.concept.channel_title}" | Minuto: ${c.segment.formattedStart} | Contenido: "${c.segment.text}"`;
    } else {
      return `[ID: ${index}] Video/Canal: "${c.title}" | Tipo: ${c.type}`;
    }
  }).join('\n\n');

  const prompt = `Actúas como un Agente Seleccionador de Información Crítico para un sistema RAG.
Tu tarea es analizar la pregunta del usuario y la lista de fragmentos de información (contexto) recuperados del catálogo. Deberás decidir qué fragmentos son útiles y directamente relevantes para responder a la pregunta.

Pregunta del usuario: "${state.query}"

Fragmentos recuperados:
${contextList}

INSTRUCCIONES:
1. Analiza cada fragmento por su ID y determina si contiene información relevante para responder la pregunta de forma verídica y sin alucinaciones.
2. Devuelve tu respuesta exclusivamente en formato JSON estructurado, respetando el siguiente esquema:
{
  "relevant_ids": [lista de números representando los IDs de los fragmentos que son realmente relevantes],
  "is_sufficient": true/false (true si consideras que con los fragmentos seleccionados es suficiente para responder de forma exacta y completa a la pregunta, false si falta información clave)
}
No devuelvas ningún texto antes ni después del JSON.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const result = JSON.parse(response.text.trim());
    console.log(`[SelectorNode] Selection result:`, result);

    const selected = (result.relevant_ids || [])
      .map(id => state.retrievedChunks[id])
      .filter(Boolean);

    // If information is insufficient and we are under the attempt threshold, rewrite search query
    let nextSearchQuery = state.searchQuery || '';
    if (!result.is_sufficient && state.attempts < 2) {
      console.log('[SelectorNode] Context insufficient. Requesting query optimization...');
      const optPrompt = `Pregunta original: "${state.query}"
Los fragmentos de información anteriores no fueron suficientes para responder.
Genera una única frase corta y directa de búsqueda alternativa (Query Expansion) en español que se enfoque mejor en los conceptos clave para realizar una nueva búsqueda vectorial local. Devuelve únicamente la frase de búsqueda sin comillas ni texto adicional.`;
      
      const optRes = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: optPrompt
      });
      nextSearchQuery = optRes.text.trim();
      console.log(`[SelectorNode] Optimized search query to: "${nextSearchQuery}"`);
    }

    return {
      selectedChunks: selected,
      searchQuery: nextSearchQuery
    };
  } catch (err) {
    console.error('[SelectorNode] Error calling Gemini or parsing JSON:', err);
    // Fallback: use all retrieved chunks
    return {
      selectedChunks: state.retrievedChunks
    };
  }
}

// 4. Node: Responder (Synthesizes the final answer using selected context and generates citations)
async function responderNode(state) {
  console.log(`[ResponderNode] Synthesizing final response with ${state.selectedChunks.length} chunks...`);
  
  if (!state.selectedChunks || state.selectedChunks.length === 0) {
    return {
      response: "Lo siento, no encontré información relevante en el catálogo de videos de Diego Racero para responder a tu pregunta. Intenta reformular tu consulta."
    };
  }

  const contextList = state.selectedChunks.map((c, index) => {
    if (c.type === 'segment') {
      return `Fuente ${index + 1}: Video: "${c.concept.title}" (ID de video: ${c.concept.id}) | Canal: "${c.concept.channel_title}" | Tiempo de inicio: ${c.segment.start} segundos (minuto ${c.segment.formattedStart}) | Texto hablado: "${c.segment.text}"`;
    } else {
      return `Fuente ${index + 1}: Video/Canal: "${c.title}" (ID: ${c.id}) | Tipo: ${c.type}`;
    }
  }).join('\n\n');

  const prompt = `Actúas como un Asistente Experto en el contenido de Diego Racero. Tu tarea es responder a la pregunta del usuario utilizando únicamente el contexto proporcionado basado en la transcripción de sus videos de YouTube.

Pregunta del usuario: "${state.query}"

Contexto relevante disponible:
${contextList}

REGLAS CRÍTICAS PARA LA RESPUESTA:
1. Responde de manera exacta, directa y concisa en español.
2. Basa tu respuesta estrictamente en el contexto proveído. Si la información no está implícita en el contexto, indícalo de forma directa pero amable.
3. Inyecta citas temporales hipervinculadas al final de la frase que contiene la afirmación correspondiente usando el formato de Markdown exacto: \`[⏱ Ir al minuto MM:SS](/videos/[videoId]?t=[segundos])\`.
   * Ejemplo: Si la información proviene del Video ID: "fu6Mw97RVSc", minuto "02:15" (segundo 135), deberás colocar el enlace exacto: \`[⏱ Ir al minuto 02:15](/videos/fu6Mw97RVSc?t=135)\`.
4. Usa formato Markdown limpio (negritas, listas ordenadas o viñetas) para que la lectura sea amigable.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    return {
      response: response.text.trim()
    };
  } catch (err) {
    console.error('[ResponderNode] Error calling Gemini:', err);
    return {
      response: "Ocurrió un error al generar la respuesta sintética usando la IA de Gemini. Por favor, intenta de nuevo."
    };
  }
}

// 5. Router edge condition
function shouldContinue(state) {
  const attempts = state.attempts || 0;
  
  if (state.selectedChunks && state.selectedChunks.length > 0) {
    console.log('[Router] Found relevant chunks. Routing to responderNode.');
    return 'responderNode';
  }
  
  if (attempts < 2) {
    console.log(`[Router] No relevant chunks found. Attempt ${attempts} < 2. Retrying search with optimized query.`);
    return 'searcherNode';
  }
  
  console.log('[Router] Max attempts reached. Routing to responderNode.');
  return 'responderNode';
}

// 6. Build and Compile the Graph
const workflow = new StateGraph(ChatState)
  .addNode("searcherNode", searcherNode)
  .addNode("selectorNode", selectorNode)
  .addNode("responderNode", responderNode)
  
  .addEdge("__start__", "searcherNode")
  .addEdge("searcherNode", "selectorNode")
  
  .addConditionalEdges(
    "selectorNode",
    shouldContinue,
    {
      searcherNode: "searcherNode",
      responderNode: "responderNode"
    }
  )
  .addEdge("responderNode", "__end__");

export const graph = workflow.compile();

export async function runAgentGraph(queryText) {
  const initialState = {
    query: queryText,
    searchQuery: "",
    retrievedChunks: [],
    selectedChunks: [],
    attempts: 0,
    response: ""
  };
  
  return await graph.invoke(initialState);
}
