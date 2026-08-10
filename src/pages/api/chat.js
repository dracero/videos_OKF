import { runAgentGraph } from '../../lib/agent-graph.js';

export const prerender = false;

export async function POST({ request }) {
  try {
    const { message } = await request.json();

    if (!message || message.trim() === '') {
      return new Response(JSON.stringify({ success: false, error: 'Message query cannot be empty.' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    console.log(`[API Chat] Executing multi-agent LangGraph workflow for query: "${message}"`);
    const result = await runAgentGraph(message);

    return new Response(JSON.stringify({
      success: true,
      response: result.response,
      selectedChunks: result.selectedChunks || []
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });

  } catch (error) {
    console.error('Error in RAG Agent API:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}
