/** Entry point: serve one tenant variant of the legacy servicing tool. */
import { createApp } from './server.js';

const tenant = process.env.TENANT ?? 'base';
const port = Number(process.env.PORT ?? 4000);

createApp(tenant).listen(port, () => {
  console.log(`[target-app] tenant="${tenant}" listening on http://localhost:${port}`);
  console.log(`[target-app] try:  http://localhost:${port}/  (member 10001 = happy path)`);
});
