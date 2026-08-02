import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { generateCatalogEmbeddings } from './semantic-search.js';

dotenv.config();

const CHANNELS_LIST = [
  'UCmyMY4FLYPYoO1IZhZPqc3w', // Diego Racero @diegoracero6447
  'UCx1KkYmHhghhGFgA7VP2aWQ', // Diego Racero @diegoracero
  'UCDs8wbm1jczac3UNYIAVxZg'  // Diego Racero @diegoracero1263
];

const OKF_DIR = path.resolve('./src/content/okf');
const LAST_SYNC_FILE = path.join(OKF_DIR, 'last_sync.json');

// Helper to check if sync is needed (cooldown of 1 hour by default)
export async function isSyncNeeded(cooldownMs = 60 * 60 * 1000) {
  try {
    const stats = await fs.stat(LAST_SYNC_FILE);
    if (!stats.isFile()) return true;

    const data = JSON.parse(await fs.readFile(LAST_SYNC_FILE, 'utf-8'));
    const lastSyncTime = new Date(data.timestamp).getTime();
    const now = Date.now();

    return (now - lastSyncTime) > cooldownMs;
  } catch (e) {
    return true; // If file does not exist, sync is needed
  }
}

// Main sync logic
export async function syncCatalog({ force = false } = {}) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY is not defined in the environment variables (.env).');
  }

  // Ensure directories exist
  await fs.mkdir(path.join(OKF_DIR, 'channels'), { recursive: true });
  await fs.mkdir(path.join(OKF_DIR, 'videos'), { recursive: true });

  if (!force && !(await isSyncNeeded())) {
    console.log('Catalog is fresh. Sync skipped.');
    return { skipped: true, message: 'Catalog is fresh. Sync skipped.' };
  }

  console.log('Starting YouTube Catalog Sync for Diego Racero...');

  // 1. Fetch channel info
  const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&id=${CHANNELS_LIST.join(',')}&key=${apiKey}`;
  const channelsRes = await fetch(channelsUrl);
  if (!channelsRes.ok) {
    throw new Error(`Failed to fetch channels: ${channelsRes.statusText}`);
  }
  const channelsData = await channelsRes.json();
  if (!channelsData.items || channelsData.items.length === 0) {
    throw new Error('No channels found.');
  }

  const channelsInfo = {};
  
  // Write channel concepts
  for (const item of channelsData.items) {
    const channelId = item.id;
    const snippet = item.snippet || {};
    const stats = item.statistics || {};
    const content = item.contentDetails || {};

    const uploadsPlaylistId = content.relatedPlaylists?.uploads;
    
    channelsInfo[channelId] = {
      id: channelId,
      title: snippet.title,
      customUrl: snippet.customUrl,
      uploadsPlaylistId,
      videoCount: parseInt(stats.videoCount || '0', 10),
      viewCount: parseInt(stats.viewCount || '0', 10),
      subscriberCount: parseInt(stats.subscriberCount || '0', 10),
      thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url
    };

    const frontmatter = `---
type: YouTube Channel
title: "${snippet.title.replace(/"/g, '\\"')}"
description: "${(snippet.description || 'Diego Racero YouTube Channel').split('\n')[0].replace(/"/g, '\\"')}"
resource: "https://www.youtube.com/channel/${channelId}"
tags: [youtube, channel, education]
generated: { by: "process:sync-youtube", at: "${new Date().toISOString()}" }
verified: machine-confirmed
status: current
custom_url: "${snippet.customUrl || ''}"
video_count: ${stats.videoCount || 0}
view_count: ${stats.viewCount || 0}
subscriber_count: ${stats.subscriberCount || 0}
thumbnail: "${channelsInfo[channelId].thumbnail || ''}"
sources:
  - id: youtube-api
    resource: "https://developers.google.com/youtube/v3"
    title: "YouTube Data API v3"
    last_modified: "${new Date().toISOString().split('T')[0]}"
---

# ${snippet.title}

${snippet.description || 'No description provided.'}

## Estadísticas
- **Videos:** ${stats.videoCount || 0}
- **Vistas:** ${stats.viewCount || 0}
- **Suscriptores:** ${stats.subscriberCount || 0}

[Ver en YouTube](https://www.youtube.com/${snippet.customUrl || `channel/${channelId}`})
`;

    await fs.writeFile(path.join(OKF_DIR, 'channels', `${channelId}.md`), frontmatter, 'utf-8');
  }

  // 2. Fetch all videos for each channel
  let totalVideosSynced = 0;
  for (const channelId of Object.keys(channelsInfo)) {
    const channel = channelsInfo[channelId];
    if (!channel.uploadsPlaylistId) continue;

    console.log(`Fetching videos for channel ${channel.title} (${channel.customUrl || channelId})...`);
    
    let nextToken = '';
    const videoIds = [];

    // Get all items in the uploads playlist
    do {
      const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${channel.uploadsPlaylistId}&maxResults=50&pageToken=${nextToken}&key=${apiKey}`;
      const playlistRes = await fetch(playlistUrl);
      if (!playlistRes.ok) {
        console.error(`Error fetching playlist items for channel ${channelId}: ${playlistRes.statusText}`);
        break;
      }
      const playlistData = await playlistRes.json();
      if (playlistData.items) {
        for (const item of playlistData.items) {
          if (item.contentDetails?.videoId) {
            videoIds.push(item.contentDetails.videoId);
          }
        }
      }
      nextToken = playlistData.nextPageToken || '';
    } while (nextToken);

    console.log(`Found ${videoIds.length} videos in channel. Fetching full details...`);

    // Fetch video details in batches of 50
    for (let i = 0; i < videoIds.length; i += 50) {
      const batchIds = videoIds.slice(i, i + 50);
      const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${batchIds.join(',')}&key=${apiKey}`;
      const videosRes = await fetch(videosUrl);
      if (!videosRes.ok) {
        console.error(`Error fetching video details batch: ${videosRes.statusText}`);
        continue;
      }
      const videosData = await videosRes.json();
      if (videosData.items) {
        for (const video of videosData.items) {
          const videoId = video.id;
          const snippet = video.snippet || {};
          const stats = video.statistics || {};
          const content = video.contentDetails || {};

          const title = snippet.title || 'Untitled Video';
          const description = snippet.description || '';
          const publishedAt = snippet.publishedAt || '';
          
          const tags = snippet.tags || [];
          const viewCount = stats.viewCount || 0;
          const likeCount = stats.likeCount || 0;
          const commentCount = stats.commentCount || 0;
          const duration = content.duration || 'PT0S';
          const thumbnail = snippet.thumbnails?.maxres?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url;

          // Helper to convert ISO 8601 duration (e.g. PT1H2M10S) to readable text
          const parseDuration = (isoStr) => {
            const matches = isoStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
            if (!matches) return '00:00';
            const hrs = parseInt(matches[1] || '0', 10);
            const mins = parseInt(matches[2] || '0', 10);
            const secs = parseInt(matches[3] || '0', 10);
            
            const parts = [];
            if (hrs > 0) parts.push(hrs.toString().padStart(2, '0'));
            parts.push(mins.toString().padStart(2, '0'));
            parts.push(secs.toString().padStart(2, '0'));
            return parts.join(':');
          };

          const formattedDuration = parseDuration(duration);

          // Build OKF Frontmatter
          const videoFrontmatter = `---
type: YouTube Video
title: "${title.replace(/"/g, '\\"').replace(/\n/g, ' ')}"
description: "${description.split('\n')[0].substring(0, 150).replace(/"/g, '\\"')}"
resource: "https://www.youtube.com/watch?v=${videoId}"
tags: [${tags.slice(0, 10).map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]
generated: { by: "process:sync-youtube", at: "${new Date().toISOString()}" }
verified: machine-confirmed
status: current
channel_id: "${channelId}"
published_at: "${publishedAt}"
view_count: ${viewCount}
like_count: ${likeCount}
comment_count: ${commentCount}
duration: "${formattedDuration}"
thumbnail: "${thumbnail || ''}"
sources:
  - id: youtube-api
    resource: "https://developers.google.com/youtube/v3"
    title: "YouTube Data API v3"
    last_modified: "${new Date().toISOString().split('T')[0]}"
  - id: channel-concept
    resource: "src/content/okf/channels/${channelId}.md"
    title: "Channel: ${channel.title}"
---

# ${title}

<div class="video-embed-container">
  <iframe 
    src="https://www.youtube.com/embed/${videoId}" 
    title="${title.replace(/"/g, '&quot;')}"
    frameborder="0" 
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
    allowfullscreen>
  </iframe>
</div>

## Detalles
- **Canal:** [${channel.title}](../channels/${channelId}.md)
- **Publicado el:** ${new Date(publishedAt).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })}
- **Duración:** ${formattedDuration}
- **Vistas:** ${parseInt(viewCount).toLocaleString('es-ES')} | **Likes:** ${parseInt(likeCount).toLocaleString('es-ES')}

## Descripción
${description || 'Sin descripción.'}
`;

          await fs.writeFile(path.join(OKF_DIR, 'videos', `${videoId}.md`), videoFrontmatter, 'utf-8');
          totalVideosSynced++;
        }
      }
    }
  }

  // 3. Write Root index.md Concept
  const rootIndexFrontmatter = `---
type: Root Index
title: "Diego Racero YouTube Catalog"
description: "Catálogo completo de canales y videos de Diego Racero en YouTube, estructurado bajo el formato OKF."
generated: { by: "process:sync-youtube", at: "${new Date().toISOString()}" }
verified: machine-confirmed
status: current
total_channels: ${Object.keys(channelsInfo).length}
total_videos: ${totalVideosSynced}
sources:
  - id: youtube-api
    resource: "https://developers.google.com/youtube/v3"
    title: "YouTube Data API v3"
    last_modified: "${new Date().toISOString().split('T')[0]}"
---

# Catálogo de YouTube de Diego Racero (dracero@fi.uba.ar)

Bienvenido al catálogo de contenido educativo y tecnológico de **Diego Racero** en YouTube, estructurado bajo el estándar abierto **Open Knowledge Format (OKF)**.

## Canales Incluidos
${Object.values(channelsInfo).map(c => `- [${c.title}](./channels/${c.id}.md) (@${c.customUrl?.replace('@', '') || c.id}) - ${c.videoCount} videos`).join('\n')}

## Última Actualización
Sincronizado exitosamente desde la API de YouTube el ${new Date().toLocaleString('es-ES', { timeZone: 'America/Argentina/Buenos_Aires' })}.
`;

  await fs.writeFile(path.join(OKF_DIR, 'index.md'), rootIndexFrontmatter, 'utf-8');

  // 4. Save last sync status
  await fs.writeFile(LAST_SYNC_FILE, JSON.stringify({ timestamp: new Date().toISOString() }, null, 2), 'utf-8');

  // 5. Generate embeddings for search
  try {
    await generateCatalogEmbeddings();
  } catch (err) {
    console.error('Failed to generate semantic embeddings during sync:', err);
  }

  console.log(`Sync complete. Synced ${Object.keys(channelsInfo).length} channels and ${totalVideosSynced} videos.`);
  return {
    success: true,
    channelsCount: Object.keys(channelsInfo).length,
    videosCount: totalVideosSynced,
    timestamp: new Date().toISOString()
  };
}
