import { createApp, initializeControlPlane } from './app.js';

initializeControlPlane();
const app = createApp();

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[control-plane] listening on :${port}`);
});
