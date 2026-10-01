// Opt-in, read-only live check; no full page or credentials are printed/persisted.
const { createService } = require('../web-source.cjs');
const Web = require('../web-reference.js');
const Engine = require('../reference-engine.js');
const references = [
  'BloombergNews p. (2025, May 8). The AI boom is draining water from the areas that need it most. https://www.bloomberg.com/graphics/2025-ai-impacts-data-centers-water-data/',
  'Bhat, D. (2025, August 4). Big Tech is building AI in the desert. The water may not last. Rest of World. https://restofworld.org/2025/gulf-ai-water-crisis/',
  'Culligan Quench. (2026). Average water usage per person in offices. https://quench.culligan.com/blog/average-water-usage-per-person-in-offices/',
];
const inspect = createService();
(async () => {
  for (const reference of references) {
    const url = Web.parse(reference).url;
    try {
      const page = await inspect(url, AbortSignal.timeout(15000));
      const result = Web.compare(reference, { ...page, formattedTitle: Engine.sentenceCase(page.title) });
      console.log(JSON.stringify({ url, status: result.statusText, changes: result.changes, suggested: result.suggested, reason: result.reason }));
    } catch (error) { console.log(JSON.stringify({ url, error: error.message })); process.exitCode = 1; }
  }
})();
