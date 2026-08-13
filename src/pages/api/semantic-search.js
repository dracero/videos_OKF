import { semanticSearch, semanticSearchChunks, unifiedSemanticSearch } from '../../lib/semantic-search';
import { getChannels, getVideos } from '../../lib/okf-reader';

export const prerender = false;

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';
    const mode = url.searchParams.get('mode') || 'unified';

    if (!query || query.trim() === '') {
      return new Response(JSON.stringify({ success: true, results: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    let results = [];

    if (mode === 'unified') {
      // New default: searches both catalog AND transcripts, returns a fused ranked list
      const unifiedResults = await unifiedSemanticSearch(query);

      // Enrich catalog results with full OKF metadata using Map indexed lookups (AGENTS.md §2.1 - O(R+V))
      const channels = await getChannels();
      const videos = await getVideos();

      const channelsMap = new Map(channels.map(c => [c.id, c]));
      const videosMap = new Map(videos.map(v => [v.id, v]));

      results = unifiedResults.map(match => {
        if (match.type === 'segment') {
          // Transcript segment — already has full concept info from chunk data
          return match;
        } else if (match.type === 'video') {
          const video = videosMap.get(match.id);
          if (!video) return null;
          const channel = channelsMap.get(video.channel_id);

          return {
            type: 'video',
            similarity: match.similarity,
            source: match.source,
            concept: {
              id: video.id,
              title: video.title,
              description: video.description,
              published_at: video.published_at,
              view_count: video.view_count,
              duration: video.duration,
              thumbnail: video.thumbnail,
              channel_id: video.channel_id,
              channel_title: channel?.title || 'Video',
              tags: video.tags,
              verified: video.verified
            }
          };
        } else if (match.type === 'channel') {
          const channel = channelsMap.get(match.id);
          if (!channel) return null;

          return {
            type: 'channel',
            similarity: match.similarity,
            source: match.source,
            concept: {
              id: channel.id,
              title: channel.title,
              description: channel.description,
              custom_url: channel.custom_url,
              video_count: channel.video_count,
              subscriber_count: channel.subscriber_count,
              thumbnail: channel.thumbnail,
              verified: channel.verified
            }
          };
        }
        return null;
      }).filter(Boolean);

    } else if (mode === 'content') {
      // Legacy: transcript-only search
      results = await semanticSearchChunks(query);
    } else {
      // Legacy: catalog-only search (mode === 'concept')
      const searchResults = await semanticSearch(query);

      const channels = await getChannels();
      const videos = await getVideos();

      const channelsMap = new Map(channels.map(c => [c.id, c]));
      const videosMap = new Map(videos.map(v => [v.id, v]));

      results = searchResults.map(match => {
        if (match.type === 'video') {
          const video = videosMap.get(match.id);
          if (!video) return null;
          const channel = channelsMap.get(video.channel_id);

          return {
            type: 'video',
            similarity: match.similarity,
            concept: {
              id: video.id,
              title: video.title,
              description: video.description,
              published_at: video.published_at,
              view_count: video.view_count,
              duration: video.duration,
              thumbnail: video.thumbnail,
              channel_id: video.channel_id,
              channel_title: channel?.title || 'Video',
              tags: video.tags,
              verified: video.verified
            }
          };
        } else if (match.type === 'channel') {
          const channel = channelsMap.get(match.id);
          if (!channel) return null;

          return {
            type: 'channel',
            similarity: match.similarity,
            concept: {
              id: channel.id,
              title: channel.title,
              description: channel.description,
              custom_url: channel.custom_url,
              video_count: channel.video_count,
              subscriber_count: channel.subscriber_count,
              thumbnail: channel.thumbnail,
              verified: channel.verified
            }
          };
        }
        return null;
      }).filter(Boolean);
    }

    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error in semantic search API:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}
