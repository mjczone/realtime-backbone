// Prints where the dev stack and the samples are, honoring the port overrides.
const port = (name, fallback) => process.env[name] || fallback;
const rows = [
  ['Test page (demo)', port('RTB_DEMO_PORT', 8080)],
  ['Mastra chat', port('RTB_SAMPLE_PORT', 3001)],
  ['Microsoft Agent Framework chat', port('RTB_MAF_SAMPLE_PORT', 3002)],
  ['Pydantic AI chat', port('RTB_PY_SAMPLE_PORT', 3003)],
  ['LangGraph chat', port('RTB_LANGGRAPH_SAMPLE_PORT', 3004)],
  ['Mastra + .NET + AG-UI app', port('RTB_MDN_API_PORT', 3010)],
];
for (const [name, p] of rows) console.log(`${name.padEnd(32)} http://localhost:${p}`);
console.log(`${'Backtest worker'.padEnd(32)} pnpm samples:signals`);
