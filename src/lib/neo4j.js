import neo4j from 'neo4j-driver';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import matter from 'gray-matter';

dotenv.config();

const OKF_DIR = path.resolve('./src/content/okf');
const EMBEDDINGS_FILE = path.join(OKF_DIR, 'embeddings.json');
const EMBEDDINGS_CHUNKS_FILE = path.join(OKF_DIR, 'embeddings_chunks.json');
const CLASSIFICATION_FILE = path.join(OKF_DIR, 'classification_index.json');

export const TOPIC_NAMES = {
  home_automation_iot: 'Home Assistant & Domótica',
  rag_and_agents: 'Agentes Autónomos de IA & LangChain',
  nlp_transformers: 'NLP & Modelos de Lenguaje',
  physics: 'Física Universitaria & Cinemática',
  physics_and_math: 'Física Universitaria & Cinemática',
  education_moodle: 'Docencia Universitaria & Moodle',
  software_web_dev: 'Desarrollo de Software & Web',
  computer_vision: 'Visión Artificial & Pose',
  general_institutional: 'General & Institucional'
};

// Singleton driver instance to avoid race conditions (AGENTS.md §1.4)
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
    await session.run(`CREATE CONSTRAINT topic_id_unique IF NOT EXISTS FOR (t:Topic) REQUIRE t.id IS UNIQUE`);

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

// 2. Seed Graph from OKF Catalog, Classification, and Embeddings
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

    // Load Precomputed Classification Index for Topic Mapping
    let classificationIndex = {};
    try {
      const rawIndex = await fs.readFile(CLASSIFICATION_FILE, 'utf-8');
      classificationIndex = JSON.parse(rawIndex);
    } catch (e) {
      console.warn('[Neo4j] Classification index not found or unreadable:', e.message);
    }

    // Load Videos
    const videosDir = path.join(OKF_DIR, 'videos');
    try {
      const videoFiles = await fs.readdir(videosDir);
      console.log(`[Neo4j] Synchronizing ${videoFiles.length} video nodes...`);

      for (const file of videoFiles) {
        if (!file.endsWith('.md')) continue;
        const id = file.replace('.md', '');
        const mdContent = await fs.readFile(path.join(videosDir, file), 'utf-8');
        const { data } = matter(mdContent);

        // Determine category and topic name
        const classData = classificationIndex[id] || {};
        const categoryId = classData.category || data.category || 'general_institutional';
        const topicName = TOPIC_NAMES[categoryId] || 'General & Institucional';

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
               v.category = $categoryId,
               v.fullTranscript = $fullTranscript
           WITH v
           OPTIONAL MATCH (c:Channel {id: $channelId})
           FOREACH (_ IN CASE WHEN c IS NOT NULL THEN [1] ELSE [] END | MERGE (c)-[:PUBLISHED]->(v))
           WITH v
           MERGE (t:Topic {id: $categoryId})
           ON CREATE SET t.name = $topicName
           ON MATCH SET t.name = $topicName
           MERGE (v)-[:BELONGS_TO_TOPIC]->(t)`,
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
            categoryId,
            topicName,
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

      // Link Series Parts (videos sharing title series prefixes)
      console.log('[Neo4j] Linking series parts...');
      await session.run(`
        MATCH (v1:Video), (v2:Video)
        WHERE v1.id < v2.id
          AND (
            (toLower(v1.title) STARTS WITH 'ha_video' AND toLower(v2.title) STARTS WITH 'ha_video') OR
            (toLower(v1.title) STARTS WITH 'yolo-pose' AND toLower(v2.title) STARTS WITH 'yolo-pose') OR
            (toLower(v1.title) STARTS WITH 'a2a_' AND toLower(v2.title) STARTS WITH 'a2a_') OR
            (toLower(v1.title) STARTS WITH 'tfi_video' AND toLower(v2.title) STARTS WITH 'tfi_video') OR
            (toLower(v1.title) STARTS WITH 'vibe_coding' AND toLower(v2.title) STARTS WITH 'vibe_coding') OR
            (toLower(v1.title) STARTS WITH 'jira' AND toLower(v2.title) STARTS WITH 'jira') OR
            (toLower(v1.title) STARTS WITH 'mcp' AND toLower(v2.title) STARTS WITH 'mcp')
          )
        MERGE (v1)-[:SERIES_PART]->(v2)
      `);

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
        const checkRes = await session.run(
          `MATCH (v:Video {id: $videoId})-[:HAS_SEGMENT]->(s:Segment) RETURN count(s) AS count`,
          { videoId }
        );
        const existingCount = checkRes.records[0] ? checkRes.records[0].get('count').toNumber() : 0;

        if (existingCount >= videoChunks.length) {
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

    // Build Semantic Similarity k-NN Edges
    await buildSemanticSimilarityEdges(0.72, 4);

  } catch (error) {
    console.error('[Neo4j] Error during graph seeding:', error);
  } finally {
    await session.close();
  }
}

// 3. Build Semantic Similarity k-NN Edges between Videos
export async function buildSemanticSimilarityEdges(threshold = 0.72, topK = 4) {
  const driver = getDriver();
  const session = driver.session();
  try {
    const rawData = await fs.readFile(EMBEDDINGS_FILE, 'utf-8');
    const catalog = JSON.parse(rawData);
    const videos = catalog.filter(item => item.type === 'video' && Array.isArray(item.vector));
    console.log(`[Neo4j] Building k-NN semantic similarity edges for ${videos.length} videos (threshold: ${threshold}, topK: ${topK})...`);

    const edges = [];
    for (let i = 0; i < videos.length; i++) {
      const v1 = videos[i];
      const neighbors = [];
      for (let j = 0; j < videos.length; j++) {
        if (i === j) continue;
        const v2 = videos[j];
        let dot = 0;
        for (let d = 0; d < v1.vector.length; d++) {
          dot += v1.vector[d] * v2.vector[d];
        }
        if (dot >= threshold) {
          neighbors.push({ targetId: v2.id, score: dot });
        }
      }
      neighbors.sort((a, b) => b.score - a.score);
      for (const n of neighbors.slice(0, topK)) {
        edges.push({ sourceId: v1.id, targetId: n.targetId, score: n.score });
      }
    }

    console.log(`[Neo4j] Storing ${edges.length} :SIMILAR_TO edges in Neo4j...`);
    const chunkSize = 250;
    for (let c = 0; c < edges.length; c += chunkSize) {
      const batch = edges.slice(c, c + chunkSize);
      await session.run(`
        UNWIND $batch AS edge
        MATCH (v1:Video {id: edge.sourceId}), (v2:Video {id: edge.targetId})
        MERGE (v1)-[r:SIMILAR_TO]->(v2)
        SET r.score = edge.score
      `, { batch });
    }
    console.log('[Neo4j] :SIMILAR_TO edges established successfully.');
    return edges.length;
  } catch (error) {
    console.error('[Neo4j] Failed to build semantic similarity edges:', error);
    return 0;
  } finally {
    await session.close();
  }
}

// 4. Pure Vector Similarity Search over Segments
export async function graphRAGSearch(queryVector, limit = 12) {
  const driver = getDriver();
  const session = driver.session();

  try {
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

// 5. Multi-Hop Graph Traversal: Expand Seed Videos into Connected Neighbor Nodes
export async function expandGraphNeighbors(seedVideoIds, options = { limit: 6 }) {
  if (!seedVideoIds || seedVideoIds.length === 0) return [];
  const driver = getDriver();
  const session = driver.session();

  try {
    const limit = options.limit || 6;
    const cypher = `
      MATCH (seed:Video)
      WHERE seed.id IN $seedVideoIds

      // 1. Series part relationships (:SERIES_PART)
      OPTIONAL MATCH (seed)-[:SERIES_PART]-(seriesNeighbor:Video)
      WHERE NOT seriesNeighbor.id IN $seedVideoIds

      // 2. Semantic similarity relationships (:SIMILAR_TO)
      OPTIONAL MATCH (seed)-[s:SIMILAR_TO]-(simNeighbor:Video)
      WHERE NOT simNeighbor.id IN $seedVideoIds AND s.score >= 0.70

      // 3. Topic cluster relationships (:BELONGS_TO_TOPIC)
      OPTIONAL MATCH (seed)-[:BELONGS_TO_TOPIC]->(t:Topic)<-[:BELONGS_TO_TOPIC]-(topicNeighbor:Video)
      WHERE NOT topicNeighbor.id IN $seedVideoIds

      // 4. Same Channel for test channels
      OPTIONAL MATCH (seed)<-[:PUBLISHED]-(c:Channel)-[:PUBLISHED]->(chanNeighbor:Video)
      WHERE NOT chanNeighbor.id IN $seedVideoIds AND (c.id = 'UCbSbKX3V4J28e4iJtulgEQA' OR c.title CONTAINS 'Test')

      WITH seed,
           collect(DISTINCT { video: seriesNeighbor, score: 0.95, rel: 'series_part' }) AS seriesList,
           collect(DISTINCT { video: simNeighbor, score: coalesce(s.score, 0.82), rel: 'semantic_similarity' }) AS simList,
           collect(DISTINCT { video: topicNeighbor, score: 0.75, rel: 'topic_cluster' }) AS topicList,
           collect(DISTINCT { video: chanNeighbor, score: 0.70, rel: 'channel' }) AS chanList

      UNWIND (seriesList + simList + topicList + chanList) AS item
      WITH item.video AS neighbor, max(item.score) AS score, item.rel AS rel
      WHERE neighbor IS NOT NULL

      // Fetch the top 2 transcript segments of each neighbor video
      OPTIONAL MATCH (neighbor)-[:HAS_SEGMENT]->(seg:Segment)
      WITH neighbor, score, rel, seg
      ORDER BY seg.start ASC

      WITH neighbor, score, rel, collect(seg)[0..2] AS segments
      RETURN neighbor.id AS id, neighbor.title AS title, neighbor.duration AS duration,
             neighbor.thumbnail AS thumbnail, score, rel, segments
      ORDER BY score DESC
      LIMIT $limit
    `;

    const result = await session.run(cypher, {
      seedVideoIds,
      limit: neo4j.int(limit)
    });

    const discoveredItems = [];
    for (const record of result.records) {
      const id = record.get('id');
      const title = record.get('title');
      const duration = record.get('duration') || '00:00';
      const thumbnail = record.get('thumbnail') || '';
      const score = record.get('score');
      const rel = record.get('rel');
      const segments = record.get('segments') || [];

      if (segments.length > 0) {
        for (const seg of segments) {
          if (!seg || !seg.properties) continue;
          const s = seg.properties;
          discoveredItems.push({
            similarity: score,
            type: 'segment',
            source: `neo4j-traversal (${rel})`,
            concept: {
              id,
              title,
              thumbnail,
              duration
            },
            segment: {
              text: s.text,
              start: typeof s.start === 'object' && s.start.toNumber ? s.start.toNumber() : Number(s.start || 0),
              end: typeof s.end === 'object' && s.end.toNumber ? s.end.toNumber() : Number(s.end || 0),
              formattedStart: formatTime(s.start)
            }
          });
        }
      } else {
        discoveredItems.push({
          similarity: score,
          type: 'concept',
          source: `neo4j-traversal (${rel})`,
          concept: {
            id,
            title,
            thumbnail,
            duration
          }
        });
      }
    }

    return discoveredItems;
  } catch (error) {
    console.error('[Neo4j] Graph traversal failed:', error);
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
