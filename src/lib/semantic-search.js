import fs from 'fs/promises';
import path from 'path';
import { pipeline, env } from '@xenova/transformers';
import matter from 'gray-matter';
import { graphRAGSearch } from './neo4j.js';

// Set cache directory to /tmp for Vercel / Serverless write permission compatibility
env.cacheDir = '/tmp/transformers-cache';

const OKF_DIR = path.resolve('./src/content/okf');
const EMBEDDINGS_FILE = path.join(OKF_DIR, 'embeddings.json');
const EMBEDDINGS_CHUNKS_FILE = path.join(OKF_DIR, 'embeddings_chunks.json');

let extractorPromise = null;

// Initialize the feature extraction pipeline singleton (Promise-based to prevent race condition AGENTS.md §1.4)
function getExtractor() {
  if (!extractorPromise) {
    console.log('Loading Xenova/all-MiniLM-L6-v2 local model...');
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2').then((model) => {
      console.log('Local model loaded successfully.');
      return model;
    });
  }
  return extractorPromise;
}

// Helper: Centralized NFD text normalization for search (AGENTS.md §1.7)
export function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
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
      // Include transcript_summary if available to enrich sparse metadata
      const transcriptSummary = data.transcript_summary || '';

      const searchText = `YouTube Video Title: ${data.title}. Description: ${cleanDesc}. Tags: ${tagsStr}. Resumen del contenido hablado: ${transcriptSummary}. Type: YouTube Video.`;

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

  // Generate transcript chunk embeddings as well
  try {
    await generateTranscriptEmbeddings();
  } catch (err) {
    console.error('Failed to generate transcript chunk embeddings during catalog generation:', err);
  }
}

// Generate chunk embeddings for transcripts (RAG)
export async function generateTranscriptEmbeddings() {
  console.log('Generating chunk embeddings for transcripts...');
  const chunksEmbeddings = [];
  const transcriptsDir = path.join(OKF_DIR, 'transcripts');
  const videosDir = path.join(OKF_DIR, 'videos');
  const channelsDir = path.join(OKF_DIR, 'channels');

  try {
    // Load all channel names to associate them with the chunks
    const channelFiles = await fs.readdir(channelsDir);
    const channelsInfo = {};
    for (const file of channelFiles) {
      if (!file.endsWith('.md')) continue;
      const id = file.replace('.md', '');
      try {
        const content = await fs.readFile(path.join(channelsDir, file), 'utf-8');
        const { data } = matter(content);
        channelsInfo[id] = data.title;
      } catch (err) {
        console.warn(`Failed to read channel title for ${id}:`, err);
      }
    }

    const transcriptFiles = await fs.readdir(transcriptsDir);
    for (const file of transcriptFiles) {
      if (!file.endsWith('.json')) continue;
      const videoId = file.replace('.json', '');

      // Load video metadata
      let videoMetadata = null;
      try {
        const mdContent = await fs.readFile(path.join(videosDir, `${videoId}.md`), 'utf-8');
        const { data } = matter(mdContent);
        videoMetadata = data;
      } catch (err) {
        // Skip transcript indexing if video markdown doesn't exist
        continue;
      }

      // Load transcript segments
      const dataStr = await fs.readFile(path.join(transcriptsDir, file), 'utf-8');
      const segments = JSON.parse(dataStr);
      if (!segments || segments.length === 0) continue;

      console.log(`Processing transcript chunks for video: ${videoMetadata.title}...`);

      let currentText = '';
      let currentStart = null;
      let currentDuration = 0;
      let wordCount = 0;

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const cleanText = seg.text.trim();
        if (!cleanText) continue;

        if (currentStart === null) {
          currentStart = seg.offset; // in ms
        }

        currentText += (currentText ? ' ' : '') + cleanText;
        currentDuration = (seg.offset + seg.duration) - currentStart;
        wordCount += cleanText.split(/\s+/).length;

        // Chunk condition: ~150 words or end of array
        if (wordCount >= 150 || i === segments.length - 1) {
          // Enrich chunk text with OKF context (video title + transcript summary + channel)
          const channelTitle = channelsInfo[videoMetadata.channel_id] || 'Diego Racero';
          const summary = (videoMetadata.transcript_summary || videoMetadata.description || '').substring(0, 150);
          const enrichedText = `Video: "${videoMetadata.title}". Canal: "${channelTitle}". Resumen: "${summary}". Contenido: ${currentText}`;
          const vector = await getEmbedding(enrichedText);

          chunksEmbeddings.push({
            videoId,
            videoTitle: videoMetadata.title,
            channelId: videoMetadata.channel_id,
            channelTitle: channelsInfo[videoMetadata.channel_id] || 'Diego Racero',
            thumbnail: videoMetadata.thumbnail || '',
            duration: videoMetadata.duration || '00:00',
            text: currentText,
            start: Math.round(currentStart / 1000), // convert to seconds
            end: Math.round((currentStart + currentDuration) / 1000), // convert to seconds
            vector
          });

          // Reset
          currentText = '';
          currentStart = null;
          currentDuration = 0;
          wordCount = 0;
        }
      }
    }

    // Save chunks to file
    await fs.writeFile(EMBEDDINGS_CHUNKS_FILE, JSON.stringify(chunksEmbeddings, null, 2), 'utf-8');
    console.log(`Successfully generated and saved ${chunksEmbeddings.length} transcript chunk embeddings to ${EMBEDDINGS_CHUNKS_FILE}.`);
  } catch (err) {
    console.error('Error generating transcript embeddings:', err);
  }
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

// Perform semantic search over transcripts (with Hybrid keyword boost)
export async function semanticSearchChunks(queryText, limit = 12) {
  if (!queryText || queryText.trim() === '') return [];

  // 1. Get query vector
  const queryVector = await getEmbedding(queryText);

  // 2. Load transcript vectors
  let chunksEmbeddings = [];
  try {
    const data = await fs.readFile(EMBEDDINGS_CHUNKS_FILE, 'utf-8');
    chunksEmbeddings = JSON.parse(data);
  } catch (e) {
    // If not generated, build them
    await generateTranscriptEmbeddings();
    try {
      const data = await fs.readFile(EMBEDDINGS_CHUNKS_FILE, 'utf-8');
      chunksEmbeddings = JSON.parse(data);
    } catch (err) {
      console.error('Failed to load chunks embeddings:', err);
      return [];
    }
  }

  // Normalize query for keyword matching
  const cleanQuery = normalizeText(queryText);
  const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 2);

  // 3. Compute similarities and apply keyword boost
  const results = chunksEmbeddings.map(item => {
    const baseSimilarity = cosineSimilarity(queryVector, item.vector);
    
    // Calculate keyword match boost
    let boost = 0;
    if (queryWords.length > 0) {
      const cleanText = normalizeText(item.text);
      
      // Exact match gives highest boost
      if (cleanText.includes(cleanQuery)) {
        boost += 0.35;
      } else {
        // Proportional match for individual words
        let matchCount = 0;
        for (const word of queryWords) {
          if (cleanText.includes(word)) {
            matchCount++;
          }
        }
        boost += (matchCount / queryWords.length) * 0.2;
      }
    }

    const similarity = baseSimilarity + boost;

    return {
      similarity,
      type: 'segment',
      concept: {
        id: item.videoId,
        title: item.videoTitle,
        channel_id: item.channelId,
        channel_title: item.channelTitle,
        thumbnail: item.thumbnail,
        duration: item.duration
      },
      segment: {
        text: item.text,
        start: item.start,
        end: item.end,
        formattedStart: formatTime(item.start)
      }
    };
  });

  // Sort by similarity descending
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// Unified Fusion Search: combines catalog + transcript results (with Neo4j GraphRAG optimization)
export async function unifiedSemanticSearch(queryText, limit = 15) {
  if (!queryText || queryText.trim() === '') return [];

  // 1. Get query vector once
  const queryVector = await getEmbedding(queryText);

  // Attempt Neo4j GraphRAG Vector Search O(log N) first if local Neo4j instance is reachable
  try {
    const graphResults = await graphRAGSearch(queryVector, limit);
    if (graphResults && graphResults.length > 0) {
      console.log(`[UnifiedSearch] GraphRAG (Neo4j) returned ${graphResults.length} high-precision nodes.`);
      return graphResults;
    }
  } catch (err) {
    console.warn('[UnifiedSearch] Neo4j GraphRAG unavailable, falling back to local JSON index:', err.message);
  }

  // Normalize query for keyword matching
  const cleanQuery = normalizeText(queryText);
  const queryWords = cleanQuery.split(/\s+/).filter(w => w.length > 2);

  // 2. Load both embedding indexes (Fallback)
  let catalogEmbeddings = [];
  let chunksEmbeddings = [];

  try {
    const data = await fs.readFile(EMBEDDINGS_FILE, 'utf-8');
    catalogEmbeddings = JSON.parse(data);
  } catch (e) {
    console.warn('Catalog embeddings not found, skipping catalog search.');
  }

  try {
    const data = await fs.readFile(EMBEDDINGS_CHUNKS_FILE, 'utf-8');
    chunksEmbeddings = JSON.parse(data);
  } catch (e) {
    console.warn('Transcript chunk embeddings not found, skipping transcript search.');
  }

  const allResults = [];

  // 3. Score catalog concepts
  for (const item of catalogEmbeddings) {
    const baseSimilarity = cosineSimilarity(queryVector, item.vector);

    // Apply keyword boost to catalog titles
    let boost = 0;
    if (queryWords.length > 0) {
      const cleanTitle = normalizeText(item.title);
      if (cleanTitle.includes(cleanQuery)) {
        boost += 0.3;
      } else {
        let matchCount = 0;
        for (const word of queryWords) {
          if (cleanTitle.includes(word)) matchCount++;
        }
        boost += (matchCount / queryWords.length) * 0.15;
      }
    }

    allResults.push({
      similarity: baseSimilarity + boost,
      type: item.type, // 'video' or 'channel'
      id: item.id,
      title: item.title,
      source: 'catalog'
    });
  }

  // 4. Score transcript chunks
  for (const item of chunksEmbeddings) {
    const baseSimilarity = cosineSimilarity(queryVector, item.vector);

    let boost = 0;
    if (queryWords.length > 0) {
      const cleanText = normalizeText(item.text);
      if (cleanText.includes(cleanQuery)) {
        boost += 0.35;
      } else {
        let matchCount = 0;
        for (const word of queryWords) {
          if (cleanText.includes(word)) matchCount++;
        }
        boost += (matchCount / queryWords.length) * 0.2;
      }
    }

    allResults.push({
      similarity: baseSimilarity + boost,
      type: 'segment',
      source: 'transcript',
      concept: {
        id: item.videoId,
        title: item.videoTitle,
        channel_id: item.channelId,
        channel_title: item.channelTitle,
        thumbnail: item.thumbnail,
        duration: item.duration
      },
      segment: {
        text: item.text,
        start: item.start,
        end: item.end,
        formattedStart: formatTime(item.start)
      }
    });
  }

  // 5. Sort by similarity descending
  allResults.sort((a, b) => b.similarity - a.similarity);

  // 6. Deduplicate: for catalog results, if the same video also appears as a segment higher up, skip the catalog entry
  const seen = new Map();
  const deduplicated = [];

  for (const result of allResults) {
    // For catalog videos, use the video id as the key
    if (result.source === 'catalog' && result.type === 'video') {
      const key = `catalog-${result.id}`;
      if (seen.has(key)) continue;
      seen.set(key, 1);
    }
    // For transcript segments, allow multiple segments from the same video
    // but limit to max 3 segments per video
    if (result.source === 'transcript') {
      const segKey = `seg-${result.concept.id}`;
      const count = (seen.get(segKey) || 0);
      if (count >= 3) continue;
      seen.set(segKey, count + 1);
    }

    deduplicated.push(result);
    if (deduplicated.length >= limit) break;
  }

  return deduplicated;
}

// Helper to format seconds to MM:SS or HH:MM:SS
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (hrs > 0) {
    parts.push(hrs.toString());
    parts.push(mins.toString().padStart(2, '0'));
  } else {
    parts.push(mins.toString().padStart(2, '0'));
  }
  parts.push(secs.toString().padStart(2, '0'));
  return parts.join(':');
}
