import dotenv from 'dotenv';
import { seedNeo4jFromOKF, getDriver, closeDriver } from '../src/lib/neo4j.js';

dotenv.config();

async function main() {
  console.log('=== Iniciando Sincronización del Grafo Neo4j & Aristas k-NN ===\n');
  const t0 = Date.now();

  try {
    await seedNeo4jFromOKF();

    const driver = getDriver();
    const session = driver.session();

    const vRes = await session.run('MATCH (v:Video) RETURN count(v) AS cnt');
    const sRes = await session.run('MATCH (s:Segment) RETURN count(s) AS cnt');
    const tRes = await session.run('MATCH (t:Topic) RETURN count(t) AS cnt');
    const simRes = await session.run('MATCH ()-[r:SIMILAR_TO]->() RETURN count(r) AS cnt');
    const seriesRes = await session.run('MATCH ()-[r:SERIES_PART]->() RETURN count(r) AS cnt');
    const topicRelRes = await session.run('MATCH ()-[r:BELONGS_TO_TOPIC]->() RETURN count(r) AS cnt');

    console.log('\n=== Estadísticas del Grafo en Neo4j ===');
    console.log(`• Nodos Video: ${vRes.records[0].get('cnt')}`);
    console.log(`• Nodos Segment: ${sRes.records[0].get('cnt')}`);
    console.log(`• Nodos Topic: ${tRes.records[0].get('cnt')}`);
    console.log(`• Aristas :SIMILAR_TO (k-NN): ${simRes.records[0].get('cnt')}`);
    console.log(`• Aristas :SERIES_PART: ${seriesRes.records[0].get('cnt')}`);
    console.log(`• Aristas :BELONGS_TO_TOPIC: ${topicRelRes.records[0].get('cnt')}`);
    console.log(`\nGrafo sincronizado en ${(Date.now() - t0) / 1000}s`);

    await session.close();
  } catch (error) {
    console.error('Error during graph synchronization:', error);
  } finally {
    await closeDriver();
  }
}

main();
