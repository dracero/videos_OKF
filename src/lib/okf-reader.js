import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { marked } from 'marked';

const OKF_DIR = path.resolve('./src/content/okf');

// Helper to convert OKF relative markdown links to Astro web routes
function rewriteLinks(html) {
  if (!html) return '';
  return html
    .replace(/href="\.\.\/channels\/([^.]+)\.md"/g, 'href="/channels/$1"')
    .replace(/href="\.\.\/videos\/([^.]+)\.md"/g, 'href="/videos/$1"')
    .replace(/href="\.\/channels\/([^.]+)\.md"/g, 'href="/channels/$1"')
    .replace(/href="\.\/videos\/([^.]+)\.md"/g, 'href="/videos/$1"');
}

export async function getRootIndex() {
  try {
    const filePath = path.join(OKF_DIR, 'index.md');
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(fileContent);
    const html = rewriteLinks(await marked(content));
    return { ...data, bodyHtml: html };
  } catch (e) {
    return null;
  }
}

export async function getLastSync() {
  try {
    const filePath = path.join(OKF_DIR, 'last_sync.json');
    const fileContent = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (e) {
    return null;
  }
}

export async function getChannels() {
  try {
    const dirPath = path.join(OKF_DIR, 'channels');
    const files = await fs.readdir(dirPath);
    const channels = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dirPath, file);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const { data, content } = matter(fileContent);
      const id = file.replace('.md', '');
      channels.push({
        id,
        ...data,
        body: content
      });
    }

    // Sort by title
    return channels.sort((a, b) => a.title.localeCompare(b.title));
  } catch (e) {
    return [];
  }
}

export async function getChannelById(id) {
  try {
    const filePath = path.join(OKF_DIR, 'channels', `${id}.md`);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(fileContent);
    const html = rewriteLinks(await marked(content));
    return {
      id,
      ...data,
      bodyHtml: html
    };
  } catch (e) {
    return null;
  }
}

export async function getVideos() {
  try {
    const dirPath = path.join(OKF_DIR, 'videos');
    const files = await fs.readdir(dirPath);
    const videos = [];

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(dirPath, file);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const { data, content } = matter(fileContent);
      const id = file.replace('.md', '');
      videos.push({
        id,
        ...data,
        body: content
      });
    }

    // Sort by publish date descending
    return videos.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
  } catch (e) {
    return [];
  }
}

export async function getVideoById(id) {
  try {
    const filePath = path.join(OKF_DIR, 'videos', `${id}.md`);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const { data, content } = matter(fileContent);
    
    // Remove the iframe block from description rendering if we already render it natively
    // We'll keep the full bodyHtml, but rewrite links
    const html = rewriteLinks(await marked(content));

    return {
      id,
      ...data,
      bodyHtml: html
    };
  } catch (e) {
    return null;
  }
}
