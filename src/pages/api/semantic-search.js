import { semanticSearch } from '../../lib/semantic-search';
import { getChannels, getVideos } from '../../lib/okf-reader';

export const prerender = false;

export async function GET({ request }) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q') || '';

    if (!query || query.trim() === '') {
      return new Response(JSON.stringify({ success: true, results: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }

    // Run semantic ranking using HuggingFace model
    const searchResults = await semanticSearch(query);

    // Read full details of OKF concepts
    const channels = await getChannels();
    const videos = await getVideos();

    // Map vector match scores to full objects
    const results = searchResults.map(match => {
      if (match.type === 'video') {
        const video = videos.find(v => v.id === match.id);
        if (!video) return null;
        
        // Find matching channel to get channel title
        const channel = channels.find(c => c.id === video.channel_id);

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
        const channel = channels.find(c => c.id === match.id);
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
