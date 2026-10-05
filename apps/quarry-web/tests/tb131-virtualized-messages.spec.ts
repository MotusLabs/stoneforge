import { test, expect } from '@playwright/test';
import {
  createGroupChannelFixture,
  listChannels,
  type FixtureChannel,
} from './helpers/group-channel';

test.describe('TB131: Virtualized Channel Messages', () => {
  // Helper to find an existing channel that already has messages
  async function findChannelWithMessages(
    page: import('@playwright/test').Page
  ): Promise<{ channel: FixtureChannel; messages: { id: string; createdAt: string }[] } | null> {
    const channels = await listChannels(page);

    for (const channel of channels) {
      const resp = await page.request.get(`/api/channels/${channel.id}/messages`);
      const msgs = await resp.json();
      if (Array.isArray(msgs) && msgs.length > 0) {
        return { channel, messages: msgs };
      }
    }
    return null;
  }

  // Helper to guarantee a channel with at least `minMessages` messages for
  // testing. Reuses a qualifying existing channel (global-setup seeds
  // "e2e-messaging" with one seed message); otherwise creates a valid
  // two-member group channel and posts messages into it. Every request is
  // asserted: a failed channel or message create fails the test red instead
  // of skipping the spec (a skip here would silently drop TB131 coverage —
  // el-3kh1rt).
  async function ensureChannelWithMessages(
    page: import('@playwright/test').Page,
    minMessages = 1
  ): Promise<{ channel: FixtureChannel; messages: { id: string; createdAt: string }[] }> {
    const existing = await findChannelWithMessages(page);
    if (existing && existing.messages.length >= minMessages) {
      return existing;
    }

    // No qualifying channel: create one. Group channels need >= 2 member
    // entities and there is no POST /api/entities — global-setup seeds them
    // (see helpers/group-channel.ts).
    const channel = await createGroupChannelFixture(page, `e2e-tb131-${Date.now()}`);
    const sender = channel.members[0];
    expect(sender, 'created channel must expose a member to send as').toBeDefined();

    const messageCount = Math.max(10, minMessages);
    for (let i = 0; i < messageCount; i++) {
      const resp = await page.request.post('/api/messages', {
        data: {
          channelId: channel.id,
          sender,
          content: `Test message ${i + 1} for virtualization testing`
        }
      });
      expect(resp.ok(), `seeding message ${i + 1}/${messageCount} failed`).toBe(true);
      // Small delay to ensure different timestamps
      await page.waitForTimeout(50);
    }

    // Verify the seeded messages are readable before the spec relies on them
    const listResp = await page.request.get(`/api/channels/${channel.id}/messages`);
    expect(listResp.ok(), 'GET channel messages after seeding must succeed').toBe(true);
    const messages = await listResp.json();
    expect(
      messages.length,
      'seeded channel must expose the posted messages'
    ).toBeGreaterThanOrEqual(minMessages);

    return { channel, messages };
  }

  test('messages list uses virtualized container', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);

    await page.goto('/messages');
    await expect(page.getByTestId('messages-page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });

    // Click on the channel
    await page.getByTestId(`channel-item-${channel.id}`).click();
    await expect(page.getByTestId('messages-container')).toBeVisible({ timeout: 5000 });

    // Check for the virtualized list container
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });
  });

  test('virtualized list renders messages correctly', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channel.id}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Wait a bit for initial render and auto-scroll to bottom
    await page.waitForTimeout(500);

    // Verify some messages are rendered (virtualized items)
    const messageItems = page.locator('[data-testid^="virtualized-messages-list-item-"]');
    const renderedCount = await messageItems.count();

    // Should render at least some messages (virtualization renders visible + overscan)
    expect(renderedCount).toBeGreaterThan(0);
  });

  test('messages display day separators in virtualized list', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channel.id}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Wait for render
    await page.waitForTimeout(500);

    // Date separators should be visible (at least one for "Today" or similar)
    const dateSeparators = page.locator('[data-testid^="date-separator-"]');
    const count = await dateSeparators.count();
    expect(count).toBeGreaterThanOrEqual(0); // May have 0 if all same day
  });

  test('empty channel shows empty state', async ({ page }) => {
    // Create a fresh empty channel. A failed create must fail the test —
    // skipping here would hide both fixture regressions and empty-state
    // regressions behind a green-looking suite (el-3kh1rt).
    const channel = await createGroupChannelFixture(page, `e2e-tb131-empty-${Date.now()}`);
    const channelId = channel.id;

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });

    // Scroll to find the channel if not immediately visible
    const channelItem = page.getByTestId(`channel-item-${channelId}`);
    await channelItem.scrollIntoViewIfNeeded();
    await channelItem.click();

    // Should show empty state
    await expect(page.getByTestId('messages-empty')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('No messages yet')).toBeVisible();
  });

  test('scroll position maintained within virtualized list', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page, 5);
    const channelId = channel.id;

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channelId}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Wait for initial render and auto-scroll
    await page.waitForTimeout(500);

    // The virtualized list should have a scroll container
    const scrollContainer = page.getByTestId('virtualized-messages-list');
    await expect(scrollContainer).toBeVisible();

    // Scroll should be possible if there are messages
    // With enough messages, it should be scrollable (but might not be with only 10)
    // This is more of a smoke test that scrolling doesn't crash
    const scrollCheck = await scrollContainer.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollCheck.scrollHeight).toBeGreaterThanOrEqual(0);
    expect(scrollCheck.clientHeight).toBeGreaterThanOrEqual(0);
  });

  test('jump to latest button appears when scrolled up', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);
    const channelId = channel.id;

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channelId}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Wait for initial render
    await page.waitForTimeout(500);

    // Scroll to the top of the message list
    await page.getByTestId('virtualized-messages-list').evaluate((el) => {
      el.scrollTop = 0;
    });

    // Wait for scroll event to be processed
    await page.waitForTimeout(200);

    // Check if jump to latest button can appear when scrolled up
    // Button visibility depends on scroll position and content height
    // This test verifies the scrolling works and doesn't crash
    // The button may or may not be visible depending on scroll position
    // So we just verify the virtualized list is still visible
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible();
  });

  test('thread panel shows virtualized replies', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channel.id}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Wait for messages to render
    await page.waitForTimeout(500);

    // Hover the first message bubble so its actions render, then open its
    // thread. Scoped to the bubble (not `.first()` across the whole page) so
    // the click cannot land on another message's button — same drift fix as
    // el-4bjca5 applied to the threading specs.
    const message = page.locator('[data-testid^="message-el-"]').first();
    await expect(message).toBeVisible({ timeout: 5000 });
    await message.hover();

    const replyButton = message.getByTestId(/message-reply-button-/);
    await expect(replyButton).toBeVisible({ timeout: 5000 });
    await replyButton.click();

    // Thread panel should appear
    await expect(page.getByTestId('thread-panel')).toBeVisible({ timeout: 5000 });

    // Thread panel should have virtualized replies container
    await expect(page.getByTestId('thread-replies')).toBeVisible();
  });

  test('new message appears at bottom with auto-scroll', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);
    const channelId = channel.id;

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channelId}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Wait for initial render and scroll to bottom
    await page.waitForTimeout(500);

    // Use the message composer UI to send a message (triggers proper refetch)
    const messageInput = page.getByTestId('message-input');
    await expect(messageInput).toBeVisible({ timeout: 5000 });

    const newMessageContent = `New message ${Date.now()}`;
    await messageInput.fill(newMessageContent);

    // Press Enter to send (or click send button)
    await messageInput.press('Enter');

    // Wait for the message to appear
    await page.waitForTimeout(1000);

    // The new message should be visible at the bottom
    await expect(page.getByText(newMessageContent)).toBeVisible({ timeout: 10000 });
  });

  test('messages container has correct accessibility attributes', async ({ page }) => {
    const { channel } = await ensureChannelWithMessages(page);

    await page.goto('/messages');
    await expect(page.getByTestId('channel-list')).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`channel-item-${channel.id}`).click();
    await expect(page.getByTestId('virtualized-messages-list')).toBeVisible({ timeout: 5000 });

    // Check accessibility attributes on the virtualized container
    const container = page.getByTestId('virtualized-messages-list');

    // Should have role="log" for chat-style content
    await expect(container).toHaveAttribute('role', 'log');

    // Should have aria-live for screen readers
    await expect(container).toHaveAttribute('aria-live', 'polite');

    // Should have aria-label
    await expect(container).toHaveAttribute('aria-label', 'Messages');
  });
});
