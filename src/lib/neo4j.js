import neo4j from 'neo4j-driver';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import matter from 'gray-matter';

dotenv.config();

const OKF_DIR = path.resolve('./src/content/okf');
const EMBEDDINGS_CHUNKS_FILE = path.join(OKF_DIR, 'embeddings_chunks.json');

// Singleton driver instance with Promise to avoid race conditions (AGENTS.md §1.4)
let driverInstance = null;

export function getDriver() {
  if (!driverInstance) {
    const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER || 'neo4j';
    const password = process.env.NEO4J_PASSWORD || 'password';

    console.log(`[Neo4j] Connecting to local graph instance at ${uri}...`);
    driverInstance = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }
  return driverInstance;
}

export async function closeDriver() {
  if (driverInstance) {
    await driverInstance.close();
    driverInstance = null;
  }
}

// 1. Initialize Graph Schema and Vector Index
export async function initNeo4jSchema() {
  const driver = getDriver();
  const session = driver.session();
  try {
    console.log('[Neo4j] Ensuring schema constraints and vector indexes...');

    // Uniqueness Constraints
    await session.run(`CREATE CONSTRAINT channel_id_unique IF NOT EXISTS FOR (c:Channel) REQUIRE c.id IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT video_id_unique IF NOT EXISTS FOR (v:Video) REQUIRE v.id IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT segment_id_unique IF NOT EXISTS FOR (s:Segment) REQUIRE s.id IS UNIQUE`);

    // Vector Index for 384-dimensional Embeddings (all-MiniLM-L6-v2)
    await session.run(`
      CREATE VECTOR INDEX transcript_vector_index IF NOT EXISTS
      FOR (s:Segment) ON (s.vector)
      OPTIONS {
        indexConfig: {
          \`vector.similarity_function\`: 'cosine',
          \`vector.dimensions\`: 384
        }
      }
    `);

    console.log('[Neo4j] Schema and Vector Index initialized successfully.');
  } catch (error) {
    console.error('[Neo4j] Failed to initialize schema:', error);
  } finally {
    await session.close();
  }
}

// 2. Seed Graph from OKF Catalog and Embeddings
export async function seedNeo4jFromOKF() {
  await initNeo4jSchema();
  const driver = getDriver();
  const session = driver.session();

  try {
    console.log('[Neo4j] Seeding Graph from local OKF catalog files...');

    // Load Root Index Concept
    try {
      const rootContent = await fs.readFile(path.join(OKF_DIR, 'index.md'), 'utf-8');
      const { data } = matter(rootContent);
      await session.run(
        `MERGE (r:RootIndex {id: 'okf-root'})
         SET r.title = $title,
             r.description = $description,
             r.totalChannels = toInteger($totalChannels),
             r.totalVideos = toInteger($totalVideos)`,
        {
          title: data.title || 'Diego Racero Catalog',
          description: data.description || '',
          totalChannels: data.total_channels || 0,
          totalVideos: data.total_videos || 0
        }
      );
    } catch (e) {
      // Root index skipped if missing
    }

    // Load Channels
    const channelsDir = path.join(OKF_DIR, 'channels');
    try {
      const channelFiles = await fs.readdir(channelsDir);
      for (const file of channelFiles) {
        if (!file.endsWith('.md')) continue;
        const id = file.replace('.md', '');
        const content = await fs.readFile(path.join(channelsDir, file), 'utf-8');
        const { data } = matter(content);

        await session.run(
          `MERGE (c:Channel {id: $id})
           SET c.title = $title,
               c.customUrl = $customUrl,
               c.videoCount = toInteger($videoCount),
               c.subscriberCount = toInteger($subscriberCount),
               c.thumbnail = $thumbnail
           WITH c
           MATCH (r:RootIndex {id: 'okf-root'})
           MERGE (r)-[:CONTAINS_CHANNEL]->(c)`,
          {
            id,
            title: data.title || '',
            customUrl: data.custom_url || '',
            videoCount: data.video_count || 0,
            subscriberCount: data.subscriber_count || 0,
            thumbnail: data.thumbnail || ''
          }
        );
      }
    } catch (e) {
      console.warn('[Neo4j] Channels directory skipped or unreadable:', e.message);
    }

    // Load Videos
    const videosDir = path.join(OKF_DIR, 'videos');
    try {
      const videoFiles = await fs.readdir(videosDir);
      for (const file of videoFiles) {
        if (!file.endsWith('.md')) continue;
        const id = file.replace('.md', '');
        const mdContent = await fs.readFile(path.join(videosDir, file), 'utf-8');
        const { data } = matter(mdContent);

        // Load full transcript text if available
        let fullTranscript = '';
        try {
          const transcriptJson = await fs.readFile(path.join(OKF_DIR, 'transcripts', `${id}.json`), 'utf-8');
          const parsed = JSON.parse(transcriptJson);
          if (Array.isArray(parsed)) {
            fullTranscript = parsed.map(s => s.text.trim()).filter(Boolean).join(' ');
          }
        } catch (e) {
          // No transcript json available
        }

        await session.run(
          `MERGE (v:Video {id: $id})
           SET v.title = $title,
               v.description = $description,
               v.publishedAt = $publishedAt,
               v.duration = $duration,
               v.viewCount = toInteger($viewCount),
               v.likeCount = toInteger($likeCount),
               v.thumbnail = $thumbnail,
               v.fullTranscript = $fullTranscript
           WITH v
           MATCH (c:Channel {id: $channelId})
           MERGE (c)-[:PUBLISHED]->(v)`,
          {
            id,
            title: data.title || '',
            description: data.description || '',
            publishedAt: data.published_at || '',
            duration: data.duration || '00:00',
            viewCount: data.view_count || 0,
            likeCount: data.like_count || 0,
            thumbnail: data.thumbnail || '',
            channelId: data.channel_id || '',
            fullTranscript
          }
        );

        // Connect Tags to Video
        if (Array.isArray(data.tags)) {
          for (const tag of data.tags) {
            if (!tag || !tag.trim()) continue;
            await session.run(
              `MATCH (v:Video {id: $videoId})
               MERGE (t:Tag {name: $tagName})
               MERGE (v)-[:TAGGED_WITH]->(t)`,
              { videoId: id, tagName: tag.trim() }
            );
          }
        }
      }
    } catch (e) {
      console.warn('[Neo4j] Videos directory skipped or unreadable:', e.message);
    }

    // Load Transcript Chunks with Vectors
    try {
      const chunksData = await fs.readFile(EMBEDDINGS_CHUNKS_FILE, 'utf-8');
      const chunks = JSON.parse(chunksData);
      console.log(`[Neo4j] Indexing ${chunks.length} transcript segments into graph...`);

      // Group chunks by videoId to establish sequential NEXT relationships
      const chunksByVideo = new Map();
      chunks.forEach((chunk, index) => {
        if (!chunksByVideo.has(chunk.videoId)) {
          chunksByVideo.set(chunk.videoId, []);
        }
        chunksByVideo.get(chunk.videoId).push({ ...chunk, globalIndex: index });
      });

      for (const [videoId, videoChunks] of chunksByVideo.entries()) {
        // Incremental Check: Skip if video segments already exist in Neo4j graph
        const checkRes = await session.run(
          `MATCH (v:Video {id: $videoId})-[:HAS_SEGMENT]->(s:Segment) RETURN count(s) AS count`,
          { videoId }
        );
        const existingCount = checkRes.records[0] ? checkRes.records[0].get('count').toNumber() : 0;

        if (existingCount >= videoChunks.length) {
          // Video segments are already indexed in Neo4j!
          continue;
        }

        let prevSegmentId = null;

        for (let i = 0; i < videoChunks.length; i++) {
          const chunk = videoChunks[i];
          const segmentId = `${videoId}_seg_${i}`;

          await session.run(
            `MERGE (s:Segment {id: $segmentId})
             SET s.text = $text,
                 s.start = toInteger($start),
                 s.end = toInteger($end),
                 s.vector = $vector
             WITH s
             MATCH (v:Video {id: $videoId})
             MERGE (v)-[:HAS_SEGMENT]->(s)`,
            {
              segmentId,
              text: chunk.text,
              start: chunk.start,
              end: chunk.end,
              vector: chunk.vector,
              videoId
            }
          );

          // Connect sequential segments (:Segment)-[:NEXT]->(:Segment)
          if (prevSegmentId) {
            await session.run(
              `MATCH (prev:Segment {id: $prevSegmentId})
               MATCH (curr:Segment {id: $segmentId})
               MERGE (prev)-[:NEXT]->(curr)`,
              { prevSegmentId, segmentId }
            );
          }
          prevSegmentId = segmentId;
        }
      }

      console.log('[Neo4j] Graph seeding completed successfully!');
    } catch (e) {
      console.warn('[Neo4j] Embeddings chunks file not found or unreadable:', e.message);
    }

  } catch (error) {
    console.error('[Neo4j] Error during graph seeding:', error);
  } finally {
    await session.close();
  }
}

// 3. Pure Vector Similarity Search + Graph Traversal
export async function graphRAGSearch(queryVector, limit = 12) {
  const driver = getDriver();
  const session = driver.session();

  try {
    // Pure Semantic Vector Search over transcript segments, followed by Graph Traversal
    const cypher = `
      CALL db.index.vector.queryNodes('transcript_vector_index', $limit, $queryVector)
      YIELD node AS seg, score
      MATCH (v:Video)-[:HAS_SEGMENT]->(seg)
      OPTIONAL MATCH (c:Channel)-[:PUBLISHED]->(v)
      OPTIONAL MATCH (prev:Segment)-[:NEXT]->(seg)
      OPTIONAL MATCH (seg)-[:NEXT]->(next:Segment)
      RETURN seg, v, c, prev, next, score
      ORDER BY score DESC
    `;

    const result = await session.run(cypher, { queryVector, limit: neo4j.int(limit) });

    return result.records.map(record => {
      const seg = record.get('seg').properties;
      const v = record.get('v') ? record.get('v').properties : {};
      const c = record.get('c') ? record.get('c').properties : {};
      const prev = record.get('prev') ? record.get('prev').properties : null;
      const next = record.get('next') ? record.get('next').properties : null;
      const score = record.get('score');

      return {
        similarity: score,
        type: 'segment',
        source: 'neo4j-graph',
        concept: {
          id: v.id || '',
          title: v.title || '',
          channel_id: c.id || '',
          channel_title: c.title || 'Diego Racero',
          thumbnail: v.thumbnail || '',
          duration: v.duration || '00:00'
        },
        segment: {
          text: seg.text,
          start: typeof seg.start === 'object' && seg.start.toNumber ? seg.start.toNumber() : Number(seg.start || 0),
          end: typeof seg.end === 'object' && seg.end.toNumber ? seg.end.toNumber() : Number(seg.end || 0),
          formattedStart: formatTime(seg.start)
        },
        context: {
          prevText: prev ? prev.text : null,
          nextText: next ? next.text : null
        }
      };
    });

  } catch (error) {
    console.error('[Neo4j] GraphRAG search failed:', error);
    return [];
  } finally {
    await session.close();
  }
}

function formatTime(secondsVal) {
  const seconds = typeof secondsVal === 'object' && secondsVal.toNumber ? secondsVal.toNumber() : Number(secondsVal || 0);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
