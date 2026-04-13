const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.giacomelli.com.br/imoveis/residencial/-27.6299776,-48.4704256';
const OUTPUT_FILE = 'giacomelli_properties_complete.json';

async function extractAllProperties() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('🔍 Starting property extraction...');
  console.log(`📍 URL: ${BASE_URL}\n`);

  try {
    // Navigate to the page
    console.log('📥 Loading page...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Get initial count
    let initialInfo = await page.evaluate(() => {
      const text = document.body.textContent;
      const match = text.match(/Mostrando\s*(\d+)\s*de\s*(\d+)/);
      return {
        loaded: match ? parseInt(match[1]) : 0,
        total: match ? parseInt(match[2]) : 0
      };
    });

    console.log(`✓ Page loaded. Currently showing: ${initialInfo.loaded}/${initialInfo.total} properties\n`);

    // Click "Load more" button repeatedly until all properties are loaded
    let allLoaded = false;
    let clickCount = 0;
    const maxAttempts = 100;

    while (!allLoaded && clickCount < maxAttempts) {
      // Check current count
      const currentInfo = await page.evaluate(() => {
        const text = document.body.textContent;
        const match = text.match(/Mostrando\s*(\d+)\s*de\s*(\d+)/);
        return {
          loaded: match ? parseInt(match[1]) : 0,
          total: match ? parseInt(match[2]) : 0
        };
      });

      console.log(`[${clickCount + 1}/${maxAttempts}] Loaded: ${currentInfo.loaded}/${currentInfo.total} properties`);

      if (currentInfo.loaded >= currentInfo.total) {
        console.log('\n✓ All properties loaded!\n');
        allLoaded = true;
        break;
      }

      // Try to click the "Load more" button
      const buttonClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        const loadMoreBtn = Array.from(buttons).find(btn =>
          btn.textContent.includes('Carregar mais')
        );

        if (loadMoreBtn && !loadMoreBtn.disabled) {
          loadMoreBtn.click();
          return true;
        }
        return false;
      });

      if (!buttonClicked) {
        console.log('ℹ️  Load more button not found or disabled. Attempting to load remaining properties...');
        allLoaded = true;
        break;
      }

      clickCount++;

      // Wait for new content to load
      await page.waitForTimeout(2000);
    }

    // Extract all property data
    console.log('📊 Extracting property data...\n');

    const properties = await page.evaluate(() => {
      const propertyList = [];
      const processedUrls = new Set();

      // Find all property links
      const propertyLinks = document.querySelectorAll('a[href*="/imovel/"]');

      propertyLinks.forEach((link, index) => {
        const href = link.getAttribute('href');

        if (href && !processedUrls.has(href)) {
          processedUrls.add(href);

          // Find parent container with full property details
          let container = link.closest('div');
          let depth = 0;

          while (container && depth < 25) {
            const text = container.textContent;
            if (text.includes('Aluguel') || text.includes('quarto')) {
              break;
            }
            container = container.parentElement;
            depth++;
          }

          if (container) {
            const fullText = container.textContent;

            // Extract all property information
            const property = {
              url: href,
              property_type: (fullText.match(/APARTAMENTO|CASA|KITNET|STUDIO|COBERTURA/i) || [])[0] || 'Unknown',
              code: (fullText.match(/COD\.?\s*(\d+)/) || [])[1] || 'N/A',
              status: (fullText.match(/SEMIMOBILIADO|MOBILIADO|SEM MOBILIAR|PRONTO/i) || [])[0] || 'N/A',
              rental_price_brl: (fullText.match(/Aluguel\s*R\$\s*([\d.,]+)/) || [])[1] || 'N/A',
              total_value_brl: (fullText.match(/Valor total\s*R\$\s*([\d.,]+)/) || [])[1] || 'N/A',
              area_sqm: (fullText.match(/(\d+(?:,\d+)?)\s*m²/) || [])[1] || 'N/A',
              bedrooms: (fullText.match(/(\d+)\s*quarto/i) || [])[1] || '0',
              suites: (fullText.match(/(\d+)\s*su[íi]te/i) || [])[1] || '0',
              bathrooms: (fullText.match(/(\d+)\s*banheiro/i) || [])[1] || '0',
              parking_spaces: (fullText.match(/(\d+)\s*vaga/i) || [])[1] || '0',

              // Extract location information
              location: (() => {
                const locationMatch = fullText.match(/(?:Florianópolis|São José|Palhoça|Brusque|Camboriú|Bombinhas|Itajaí|Navegantes)[^|,\n]*/);
                return locationMatch ? locationMatch[0].trim() : 'N/A';
              })(),

              // Extract district if available
              district: (() => {
                const cityMatch = fullText.match(/(?:Florianópolis|São José|Palhoça|Brusque|Camboriú|Bombinhas|Itajaí|Navegantes)\s*-\s*([^|,\n]+)/);
                return cityMatch ? cityMatch[1].trim() : 'N/A';
              })(),

              // Extract building name if available
              building_name: (() => {
                const buildingMatch = fullText.match(/\|\s*([A-Z][^|]*)\s*\|/);
                return buildingMatch ? buildingMatch[1].trim() : 'N/A';
              })()
            };

            propertyList.push(property);
          }
        }
      });

      return propertyList;
    });

    console.log(`✓ Extracted ${properties.length} unique properties\n`);

    // Prepare output data
    const outputData = {
      metadata: {
        source: BASE_URL,
        extraction_date: new Date().toISOString(),
        extraction_timestamp: Date.now(),
        total_properties_on_site: initialInfo.total,
        properties_extracted: properties.length,
        script_version: '1.0',
        browser: 'Playwright (Chromium)',
        notes: 'Complete extraction of all available properties from Giacomelli residential search'
      },
      properties: properties.map((prop, idx) => ({
        id: idx + 1,
        ...prop
      }))
    };

    // Save to file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(outputData, null, 2));
    console.log(`✅ Data saved to: ${OUTPUT_FILE}`);
    console.log(`📦 Total properties: ${properties.length}`);
    console.log(`💾 File size: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(2)} KB\n`);

    // Print summary statistics
    const stats = {
      total_properties: properties.length,
      by_type: {},
      by_location: {},
      price_range: {
        min: 'N/A',
        max: 'N/A',
        average: 'N/A'
      }
    };

    properties.forEach(prop => {
      // Count by type
      stats.by_type[prop.property_type] = (stats.by_type[prop.property_type] || 0) + 1;

      // Count by location
      stats.by_location[prop.location] = (stats.by_location[prop.location] || 0) + 1;
    });

    // Extract numeric prices
    const prices = properties
      .map(p => {
        const match = p.rental_price_brl.match(/\d+/);
        return match ? parseInt(match[0]) : 0;
      })
      .filter(p => p > 0)
      .sort((a, b) => a - b);

    if (prices.length > 0) {
      stats.price_range.min = `R$ ${prices[0].toLocaleString('pt-BR')}`;
      stats.price_range.max = `R$ ${prices[prices.length - 1].toLocaleString('pt-BR')}`;
      stats.price_range.average = `R$ ${(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2).replace('.', ',')}`;
    }

    console.log('📈 Summary Statistics:');
    console.log(`   Properties by type: ${JSON.stringify(stats.by_type)}`);
    console.log(`   Properties by location: ${JSON.stringify(stats.by_location)}`);
    console.log(`   Price range: ${stats.price_range.min} - ${stats.price_range.max}`);
    console.log(`   Average rental price: ${stats.price_range.average}\n`);

  } catch (error) {
    console.error('❌ Error during extraction:', error);
  } finally {
    await browser.close();
    console.log('🔒 Browser closed. Extraction complete!');
  }
}

// Run the extraction
extractAllProperties().catch(console.error);
