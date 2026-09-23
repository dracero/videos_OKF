/**
 * Batch Indexer Script: Classifies all videos in the catalog using TypeSafe Jev
 * and persists the results to src/content/okf/classification_index.json.
 *
 * Usage: node scripts/build-index.js [--force]
 */

import { buildClassificationIndex } from '../src/lib/indexer.js';

const isForce = process.argv.includes('--force');

console.log("==================================================");
console.log("  🚀 TypeSafe AI Video Classification Indexer    ");
console.log("==================================================");
console.log(`Mode: ${isForce ? 'FORCE (re-classify all videos)' : 'INCREMENTAL (only unclassified videos)'}`);

const start = Date.now();

buildClassificationIndex({
  force: isForce,
  concurrency: 4,
  onProgress: (done, total, videoId, category) => {
    console.log(`[${done}/${total}] Classified ${videoId} -> ${category}`);
  }
})
  .then(res => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log("==================================================");
    console.log(`✅ Indexing completed in ${elapsed}s!`);
    console.log(`Total videos in catalog: ${res.total}`);
    console.log(`Newly classified in this run: ${res.processed}`);
    console.log("==================================================");
    process.exit(0);
  })
  .catch(err => {
    console.error("❌ Indexing failed:", err);
    process.exit(1);
  });
