import { syncCatalog } from '../../lib/sync';

export const prerender = false;

export async function POST() {
  try {
    const result = await syncCatalog({ force: true });
    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error syncing YouTube catalog:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}
