import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getTypeSafeClient, CATALOG_CATEGORIES } from './typesafe.js';
import { choice, noul, score } from '@typesafe-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const OKF_DIR = path.resolve('./src/content/okf');
const INDEX_FILE = path.join(OKF_DIR, 'classification_index.json');

// In-memory cache of the classification index (AGENTS.md §2.2)
let cachedIndex = null;
let cachedIndexAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Loads the precomputed classification index into a Map for O(1) lookup.
 * @returns {Promise<Map<string, Object>>}
 */
export async function getClassificationIndex() {
  if (cachedIndex && (Date.now() - cachedIndexAt < CACHE_TTL)) {
    return cachedIndex;
  }

  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf-8');
    const data = JSON.parse(raw);
    cachedIndex = new Map(Object.entries(data));
    cachedIndexAt = Date.now();
    return cachedIndex;
  } catch (err) {
    cachedIndex = new Map();
    cachedIndexAt = Date.now();
    return cachedIndex;
  }
}

/**
 * Retrieves all videos belonging to a specific category from the index.
 * @param {string} category
 * @returns {Promise<Array<Object>>}
 */
export async function getVideosByCategory(category) {
  const index = await getClassificationIndex();
  const matched = [];
  for (const [videoId, data] of index.entries()) {
    if (data.category === category) {
      matched.push({ videoId, ...data });
    }
  }
  return matched;
}

/**
 * Classifies a single video using TypeSafe Jev with rich transcript context.
 */
async function classifyVideoWithJev(client, videoId, frontmatterData, transcriptText) {
  const title = frontmatterData.title || 'Untitled';
  const description = frontmatterData.description || '';
  
  // Use up to 1200 characters of clean transcript text
  const cleanTranscript = (transcriptText || frontmatterData.transcript_summary || '').substring(0, 1200);

  const response = await client.systemOne({
    state: {
      title,
      description: description.substring(0, 300),
      spoken_content: cleanTranscript
    },
    questions: {
      category: choice("Clasifica el video en una de las áreas temáticas del canal de Diego Racero:", CATALOG_CATEGORIES),
      has_code_demo: noul("El video muestra código fuente, terminal, scripts, configuración o implementación técnica en vivo"),
      difficulty: score("Nivel de complejidad técnica del video", [
        "Introductorio / Divulgación / Básico",
        "Intermedio (requiere conocimientos previos de programación o física)",
        "Avanzado (arquitecturas complejas, demostraciones técnicas profundas)"
      ])
    }
  });

  const answers = response.answers;
  return {
    category: answers.category.choice,
    categoryConfidence: answers.category.confidence,
    hasCode: answers.has_code_demo.noul > 0.5,
    difficultyScore: answers.difficulty.score,
    title,
    classifiedAt: new Date().toISOString()
  };
}

/**
 * Batch classification indexer:
 * 1. Reads all videos from src/content/okf/videos/
 * 2. Checks existing classification_index.json to avoid re-classifying
 * 3. Calls TypeSafe Jev in small concurrent batches
 * 4. Updates classification_index.json and video markdown frontmatter
 *
 * @param {Object} options
 * @param {boolean} [options.force=false]
 * @param {number} [options.concurrency=5]
 * @param {Function} [options.onProgress]
 */
export async function buildClassificationIndex({ force = false, concurrency = 4, onProgress } = {}) {
  const client = getTypeSafeClient();
  if (!client) {
    throw new Error('TypeSafe API client could not be initialized. Check JEV_API_KEY in .env');
  }

  const videosDir = path.join(OKF_DIR, 'videos');
  const transcriptsDir = path.join(OKF_DIR, 'transcripts');

  // Load existing index if any
  let currentIndex = {};
  if (!force) {
    try {
      const raw = await fs.readFile(INDEX_FILE, 'utf-8');
      currentIndex = JSON.parse(raw);
    } catch {
      currentIndex = {};
    }
  }

  const videoFiles = (await fs.readdir(videosDir)).filter(f => f.endsWith('.md'));
  console.log(`[Indexer] Found ${videoFiles.length} total videos in catalog.`);

  const toProcess = [];
  for (const file of videoFiles) {
    const videoId = file.replace('.md', '');
    if (!force && currentIndex[videoId] && currentIndex[videoId].category) {
      continue; // Already indexed
    }
    toProcess.push({ file, videoId });
  }

  console.log(`[Indexer] ${toProcess.length} videos need classification with TypeSafe Jev.`);
  if (toProcess.length === 0) {
    console.log('[Indexer] All videos are already indexed.');
    return {
      total: videoFiles.length,
      processed: 0,
      index: currentIndex
    };
  }

  let processedCount = 0;

  // Process in batches
  for (let i = 0; i < toProcess.length; i += concurrency) {
    const batch = toProcess.slice(i, i + concurrency);
    
    await Promise.all(batch.map(async ({ file, videoId }) => {
      try {
        const filePath = path.join(videosDir, file);
        const mdRaw = await fs.readFile(filePath, 'utf-8');
        const parsed = matter(mdRaw);

        // Load transcript
        let transcriptText = '';
        try {
          const tRaw = await fs.readFile(path.join(transcriptsDir, `${videoId}.json`), 'utf-8');
          const tJson = JSON.parse(tRaw);
          if (Array.isArray(tJson) && tJson.length > 0) {
            transcriptText = tJson.map(s => s.text.trim()).filter(Boolean).join(' ');
          }
        } catch {
          // No transcript
        }

        const result = await classifyVideoWithJev(client, videoId, parsed.data, transcriptText);
        currentIndex[videoId] = result;

        // Update markdown frontmatter once
        parsed.data.category = result.category;
        parsed.data.category_confidence = result.categoryConfidence;
        parsed.data.has_code_demo = result.hasCode;
        parsed.data.difficulty_score = result.difficultyScore;
        const currentTags = Array.isArray(parsed.data.tags) ? parsed.data.tags : [];
        parsed.data.tags = [...new Set([result.category, ...currentTags])];

        const updatedMd = matter.stringify(parsed.content, parsed.data);
        await fs.writeFile(filePath, updatedMd, 'utf-8');

        processedCount++;
        if (onProgress) {
          onProgress(processedCount, toProcess.length, videoId, result.category);
        }
      } catch (err) {
        console.error(`[Indexer] Failed to classify video ${videoId}:`, err.message);
      }
    }));

    // Periodically persist index to disk
    await fs.writeFile(INDEX_FILE, JSON.stringify(currentIndex, null, 2), 'utf-8');
    console.log(`[Indexer] Progress: ${processedCount}/${toProcess.length} classified.`);
  }

  // Final persist & cache update
  await fs.writeFile(INDEX_FILE, JSON.stringify(currentIndex, null, 2), 'utf-8');
  cachedIndex = new Map(Object.entries(currentIndex));
  cachedIndexAt = Date.now();

  console.log(`[Indexer] Index saved to ${INDEX_FILE} (${Object.keys(currentIndex).length} videos indexed).`);

  return {
    total: videoFiles.length,
    processed: processedCount,
    index: currentIndex
  };
}
