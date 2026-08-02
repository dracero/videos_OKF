import fs from 'fs/promises';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import matter from 'gray-matter';

const OKF_DIR = path.resolve('./src/content/okf');
const EMBEDDINGS_FILE = path.join(OKF_DIR, 'embeddings.json');

let extractor = null;

// Initialize the feature extraction pipeline singleton
async function getExtractor() {
  if (!extractor) {
    console.log('Loading Xenova/all-MiniLM-L6-v2 local model...');
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('Local model loaded successfully.');
  }
  return extractor;
}

// Generate embedding for a single text string
export async function getEmbedding(text) {
  const extract = await getExtractor();
  // We use pooling: 'mean' and normalize: true to get a normalized 1D vector (dim: 384)
  const output = await extract(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// Compute dot product of two normalized vectors (which is cosine similarity)
export function cosineSimilarity(a, b) {
  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }
  return dotProduct;
}

// Generate embeddings for all OKF concepts currently on disk
export async function generateCatalogEmbeddings() {
  console.log('Generating semantic embeddings for the OKF catalog...');
  const embeddings = [];

  const channelsDir = path.join(OKF_DIR, 'channels');
  const videosDir = path.join(OKF_DIR, 'videos');

  // 1. Process Channels
  try {
    const channelFiles = await fs.readdir(channelsDir);
    for (const file of channelFiles) {
      if (!file.endsWith('.md')) continue;
      const id = file.replace('.md', '');
      const content = await fs.readFile(path.join(channelsDir, file), 'utf-8');
      const { data, content: body } = matter(content);

      // Construct a descriptive search text emphasizing type and titles
      const searchText = `YouTube Channel Title: ${data.title}. Description: ${data.description || ''}. Handle: ${data.custom_url || ''}. Type: YouTube Channel. OKF status: ${data.status}. OKF verified: ${data.verified}.`;
      
      console.log(`Embedding channel: ${data.title}...`);
      const vector = await getEmbedding(searchText);

      embeddings.push({
        id,
        type: 'channel',
        title: data.title,
        vector
      });
    }
  } catch (e) {
    console.error('Error reading channels for embeddings:', e);
  }

  // 2. Process Videos
  try {
    const videoFiles = await fs.readdir(videosDir);
    for (const file of videoFiles) {
      if (!file.endsWith('.md')) continue;
      const id = file.replace('.md', '');
      const content = await fs.readFile(path.join(videosDir, file), 'utf-8');
      const { data, content: body } = matter(content);

      const tagsStr = Array.isArray(data.tags) ? data.tags.join(', ') : '';
      // We extract first 300 characters of description to represent semantic meaning concisely
      const cleanDesc = (body || '').replace(/<[^>]*>/g, '').substring(0, 300).trim();

      const searchText = `YouTube Video Title: ${data.title}. Description: ${cleanDesc}. Tags: ${tagsStr}. Type: YouTube Video. OKF status: ${data.status}. OKF verified: ${data.verified}.`;

      console.log(`Embedding video: ${data.title}...`);
      const vector = await getEmbedding(searchText);

      embeddings.push({
        id,
        type: 'video',
        title: data.title,
        vector
      });
    }
  } catch (e) {
    console.error('Error reading videos for embeddings:', e);
  }

  // Save all embeddings to disk
  await fs.writeFile(EMBEDDINGS_FILE, JSON.stringify(embeddings, null, 2), 'utf-8');
  console.log(`Successfully generated and saved ${embeddings.length} embeddings to ${EMBEDDINGS_FILE}.`);
}

// Perform semantic search
export async function semanticSearch(queryText, limit = 12) {
  if (!queryText || queryText.trim() === '') return [];

  // 1. Get query vector
  const queryVector = await getEmbedding(queryText);

  // 2. Load catalog vectors
  let catalogEmbeddings = [];
  try {
    const data = await fs.readFile(EMBEDDINGS_FILE, 'utf-8');
    catalogEmbeddings = JSON.parse(data);
  } catch (e) {
    // If embedding file doesn't exist, generate them first!
    await generateCatalogEmbeddings();
    const data = await fs.readFile(EMBEDDINGS_FILE, 'utf-8');
    catalogEmbeddings = JSON.parse(data);
  }

  // 3. Compute similarities
  const results = catalogEmbeddings.map(item => {
    const similarity = cosineSimilarity(queryVector, item.vector);
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      similarity // Since vectors are normalized, dot product is cosine similarity [-1, 1]
    };
  });

  // Sort by similarity descending
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
