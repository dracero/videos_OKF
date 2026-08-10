import { runAgentGraph } from '../src/lib/agent-graph.js';

async function test() {
  const query = 'cómo configurar una cámara en home assistant';
  console.log(`=== Iniciando Prueba de Agentes LangGraph ===`);
  console.log(`Pregunta: "${query}"\n`);
  
  try {
    const start = Date.now();
    const result = await runAgentGraph(query);
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    
    console.log(`\n=== Respuesta de los Agentes (${duration}s) ===\n`);
    console.log(result.response);
    console.log(`\n=== Segmentos Utilizados (${result.selectedChunks.length}) ===\n`);
    result.selectedChunks.forEach((c, idx) => {
      console.log(`[${idx + 1}] Video: "${c.concept.title}" | Minuto: ${c.segment.formattedStart} | Snippet: "${c.segment.text.substring(0, 100)}..."`);
    });
  } catch (error) {
    console.error('Error durante la ejecución de los agentes:', error);
  }
}

test();
