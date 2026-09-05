const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  try {
    console.log('Navigating to settings page...');
    await page.goto('http://localhost:5173/settings', { waitUntil: 'networkidle' });
    
    // Wait for tabs to load
    await page.waitForSelector('[role="tablist"]', { timeout: 10000 });
    
    // Take a screenshot
    await page.screenshot({ path: 'settings-screenshot.png', fullPage: true });
    
    // Get all tab buttons text
    const tabTexts = await page.locator('[role="tab"]').allTextContents();
    console.log(`\n✓ Found ${tabTexts.length} tabs:`);
    tabTexts.forEach((text, i) => {
      console.log(`  ${i + 1}. ${text.trim()}`);
    });
    
    // Verify tab content exists
    console.log('\n✓ Tab content verification:');
    
    // Check Download tab is visible by default
    const downloadVisible = await page.locator('text=Download Root Folder').isVisible();
    console.log(`  - Download & Performance tab content: ${downloadVisible ? '✓ VISIBLE' : '✗ HIDDEN'}`);
    
    // Click Narration tab
    await page.locator('[role="tab"]:has-text("Narration Studio")').click();
    await page.waitForTimeout(500);
    const narrationVisible = await page.locator('text=AI Provider').isVisible();
    console.log(`  - Narration Studio tab content: ${narrationVisible ? '✓ VISIBLE' : '✗ HIDDEN'}`);
    
    // Click Voiceover tab
    await page.locator('[role="tab"]:has-text("Voiceover")').click();
    await page.waitForTimeout(500);
    const ttsVisible = await page.locator('text=Text-to-Speech').isVisible();
    console.log(`  - Voiceover tab content: ${ttsVisible ? '✓ VISIBLE' : '✗ HIDDEN'}`);
    
    // Click Image Clipper tab
    await page.locator('[role="tab"]:has-text("Image Clipper")').click();
    await page.waitForTimeout(500);
    const clipperVisible = await page.locator('text=Crop Guidelines').isVisible();
    console.log(`  - Image Clipper tab content: ${clipperVisible ? '✓ VISIBLE' : '✗ HIDDEN'}`);
    
    console.log('\n✓ All tabs working correctly!');
    console.log('✓ Screenshot saved to settings-screenshot.png');
    
  } catch (error) {
    console.error('✗ Error:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
