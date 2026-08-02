import { test, expect } from '@playwright/test';

test.describe('YouTube OKF Catalog E2E Tests', () => {
  test('should load the home page and show channels/videos', async ({ page }) => {
    // Navigate to local dev server
    await page.goto('http://localhost:4321/');

    // Check main title
    const mainTitle = page.locator('.hero-title');
    await expect(mainTitle).toBeVisible();
    await expect(mainTitle).toContainText('Diego Racero');

    // Check stats are rendered
    const statCards = page.locator('.stat-card');
    await expect(statCards).toHaveCount(3);

    // Verify channel list has cards
    const channelCards = page.locator('.channel-card');
    const channelCount = await channelCards.count();
    expect(channelCount).toBeGreaterThan(0);

    // Verify search input is present
    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeVisible();

    // Verify "Actualizar Catálogo" button exists
    const syncButton = page.locator('#sync-button');
    await expect(syncButton).toBeVisible();
  });

  test('should filter videos when searching', async ({ page }) => {
    await page.goto('http://localhost:4321/');

    const searchInput = page.locator('#search-input');
    
    // Type a term we know exists (all channels contain the name of the channel)
    await searchInput.fill('Diego');

    // Get count of visible video cards
    const visibleCards = page.locator('.video-card-wrapper:visible');
    const count = await visibleCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should navigate to channel details and video play page', async ({ page }) => {
    await page.goto('http://localhost:4321/');

    // Click first channel card
    const firstChannel = page.locator('.channel-card').first();
    await firstChannel.click();

    // Verify channel detail view loaded
    await expect(page).toHaveURL(/\/channels\//);
    const channelTitle = page.locator('.channel-title');
    await expect(channelTitle).toBeVisible();

    // Check OKF concept sidebar exists
    const okfSidebar = page.locator('.okf-metadata-card');
    await expect(okfSidebar).toBeVisible();

    // Click first video in channel
    const firstVideo = page.locator('.video-card').first();
    await firstVideo.click();

    // Verify video details page is loaded
    await expect(page).toHaveURL(/\/videos\//);
    
    // Check that YouTube embed iframe exists
    const videoEmbed = page.locator('.video-embed-container iframe');
    await expect(videoEmbed).toBeVisible();
  });
});
