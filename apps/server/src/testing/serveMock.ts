// Starts the mock provider on a fixed port so a real browser can be pointed at it:
//   pnpm --filter @ezclaw/server mock
import { startMockProvider } from "./mockProvider.js";

const mock = await startMockProvider(Number(process.env.MOCK_PORT ?? 9911));
console.log(`Mock provider siap di ${mock.url}/v1 (key apa saja diterima)`);
console.log("Model: echo, think, tags, markdown, reject-top_p, slow, midfail, unauthorized, json-only");
process.on("SIGINT", () => void mock.close().then(() => process.exit(0)));
