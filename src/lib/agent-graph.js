import { Annotation, StateGraph } from "@langchain/langgraph";
import { unifiedSemanticSearch } from './semantic-search.js';
import { 
  routeUserQuery, 
  evaluateChunksWithJev, 
  synthesizeAnswerWithJev 
} from './typesafe.js';
import { getVideosByCategory } from './indexer.js';
import { expandGraphNeighbors } from './neo4j.js';
import dotenv from 'dotenv';

dotenv.config();

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
  topicDomain: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => "general"
  }),
  queryIntent: Annotation({
    reducer: (left, right) => right ?? left,
    default: () => "conceptual"
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

// 2. Node: Router (TypeSafe Jev: Topic & Intent Routing in <100ms)
async function routerNode(state) {
  console.log(`[RouterNode] Analyzing user query: "${state.query}" with TypeSafe Jev...`);
  
  try {
    const routing = await routeUserQuery(state.query);
    console.log(`[RouterNode] Detected Domain: "${routing.domain}" (${(routing.domainConfidence * 100).toFixed(0)}% conf) | Intent: "${routing.intent}"`);

    return {
      topicDomain: routing.domain,
      queryIntent: routing.intent,
      searchQuery: state.query
    };
  } catch (err) {
    console.warn('[RouterNode] TypeSafe routing failed, falling back to general:', err.message);
    return {
      topicDomain: 'general',
      queryIntent: 'conceptual',
      searchQuery: state.query
    };
  }
}

// 3. Node: Searcher (Retrieves items using local semantic search & Neo4j GraphRAG, augmented with Multi-Hop Graph Traversal)
async function searcherNode(state) {
  const query = state.searchQuery || state.query;
  const attempts = state.attempts || 0;
  console.log(`[SearcherNode] Attempt ${attempts + 1}: Searching for "${query}" [Domain: ${state.topicDomain}]...`);
  
  try {
    const results = await unifiedSemanticSearch(query, 8);

    // Collect seed video IDs from initial high-precision vector matches
    const seedVideoIds = [...new Set(results.map(r => r.concept?.id || r.id).filter(Boolean))].slice(0, 3);

    // Augment seed candidates with pre-indexed videos if a specific domain is detected
    if (state.topicDomain && state.topicDomain !== 'general') {
      try {
        const categoryVideos = await getVideosByCategory(state.topicDomain);
        if (categoryVideos.length > 0) {
          console.log(`[SearcherNode] Including ${categoryVideos.length} pre-indexed videos for domain "${state.topicDomain}" as seeds`);
          for (const cv of categoryVideos.slice(0, 3)) {
            if (!seedVideoIds.includes(cv.videoId)) {
              seedVideoIds.push(cv.videoId);
            }
          }
        }
      } catch (idxErr) {
        console.warn('[SearcherNode] Index lookup skipped:', idxErr.message);
      }
    }

    // Multi-Hop Graph Traversal: Explore semantically connected neighbor nodes in Neo4j
    if (seedVideoIds.length > 0) {
      try {
        console.log(`[SearcherNode] Navigating graph from seeds: [${seedVideoIds.join(', ')}]...`);
        const neighborNodes = await expandGraphNeighbors(seedVideoIds, { limit: 6 });
        if (neighborNodes.length > 0) {
          console.log(`[SearcherNode] Graph Traversal discovered ${neighborNodes.length} connected neighbor segments/concepts.`);
          const existingKeys = new Set(results.map(r => `${r.concept?.id || r.id}_${r.segment?.start || 0}`));
          for (const neighbor of neighborNodes) {
            const key = `${neighbor.concept?.id || neighbor.id}_${neighbor.segment?.start || 0}`;
            if (!existingKeys.has(key)) {
              results.push(neighbor);
              existingKeys.add(key);
            }
          }
        }
      } catch (graphErr) {
        console.warn('[SearcherNode] Graph traversal skipped:', graphErr.message);
      }
    }

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

// 4. Node: Selector (TypeSafe Jev: Fast probabilistic chunk selection & sufficiency check)
async function selectorNode(state) {
  console.log(`[SelectorNode] Evaluating ${state.retrievedChunks.length} retrieved segments with TypeSafe Jev...`);
  
  if (!state.retrievedChunks || state.retrievedChunks.length === 0) {
    return { selectedChunks: [] };
  }

  try {
    const { selectedChunks, isSufficient } = await evaluateChunksWithJev(state.query, state.retrievedChunks);
    console.log(`[SelectorNode] TypeSafe selected ${selectedChunks.length} relevant chunks (Sufficient: ${isSufficient})`);

    let nextSearchQuery = state.searchQuery || '';
    if (!isSufficient && state.attempts < 2) {
      console.log('[SelectorNode] Context insufficient. Retrying with expanded query...');
      if (state.topicDomain === 'home_automation_iot') {
        nextSearchQuery = `${state.query} home assistant domotica camara iot`;
      } else if (state.topicDomain === 'physics') {
        nextSearchQuery = `${state.query} cinemática física`;
      } else if (state.topicDomain === 'rag_and_agents') {
        nextSearchQuery = `${state.query} agentes rag embeddings`;
      } else if (state.topicDomain === 'nlp_transformers') {
        nextSearchQuery = `${state.query} transformers nlp huggingface`;
      } else {
        nextSearchQuery = `${state.query} tutorial`;
      }
    }

    return {
      selectedChunks,
      searchQuery: nextSearchQuery
    };
  } catch (err) {
    console.warn('[SelectorNode] TypeSafe chunk evaluation error, using top retrieved chunks:', err.message);
    return {
      selectedChunks: state.retrievedChunks.slice(0, 4),
      searchQuery: state.searchQuery || ''
    };
  }
}

// 5. Node: Responder (TypeSafe Jev: Structured synthesis with direct video timestamp links)
async function responderNode(state) {
  console.log(`[ResponderNode] Synthesizing final response with ${state.selectedChunks.length} chunks via TypeSafe Jev...`);
  
  try {
    const answer = await synthesizeAnswerWithJev({
      query: state.query,
      selectedChunks: state.selectedChunks,
      topicDomain: state.topicDomain,
      queryIntent: state.queryIntent
    });

    return {
      response: answer
    };
  } catch (err) {
    console.error('[ResponderNode] Error in synthesizeAnswerWithJev:', err);
    return {
      response: "Lo siento, ocurrió un error al estructurar la respuesta. Por favor intenta reformular tu consulta."
    };
  }
}

// 6. Router edge condition
function shouldContinue(state) {
  const attempts = state.attempts || 0;
  
  if (state.selectedChunks && state.selectedChunks.length > 0) {
    console.log(`[Router] Found ${state.selectedChunks.length} relevant chunks. Routing to responderNode.`);
    return 'responderNode';
  }
  
  if (attempts < 2) {
    console.log(`[Router] No relevant chunks found. Attempt ${attempts} < 2. Retrying search with optimized query.`);
    return 'searcherNode';
  }
  
  console.log('[Router] Max attempts reached. Routing to responderNode.');
  return 'responderNode';
}

// 7. Build and Compile the 100% Jev-Driven Graph
const workflow = new StateGraph(ChatState)
  .addNode("routerNode", routerNode)
  .addNode("searcherNode", searcherNode)
  .addNode("selectorNode", selectorNode)
  .addNode("responderNode", responderNode)
  
  .addEdge("__start__", "routerNode")
  .addEdge("routerNode", "searcherNode")
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
    topicDomain: "general",
    queryIntent: "conceptual",
    retrievedChunks: [],
    selectedChunks: [],
    attempts: 0,
    response: ""
  };
  
  return await graph.invoke(initialState);
}
