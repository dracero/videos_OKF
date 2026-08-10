import { syncCatalog } from '../../lib/sync';

export const prerender = false;

export async function POST() {
  const isVercel = !!(process.env.VERCEL || import.meta.env?.VERCEL);
  if (isVercel) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'La sincronización no está soportada en el entorno de solo lectura de Vercel. Por favor, sincroniza localmente y vuelve a hacer el despliegue.' 
    }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

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
