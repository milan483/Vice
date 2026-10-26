import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react-swc';
import fs from 'node:fs';

export default defineConfig({
  plugins: [react(), {
    name: 'player-fixture-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/fixture.mp4')) {
          const file = process.env.PLAYER_FIXTURE || '/tmp/vice-player-test.mp4';
          const size = fs.statSync(file).size;
          const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Number(range[2]) : size - 1;
          res.writeHead(range ? 206 : 200, {
            'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            ...(range ? {'Content-Range': `bytes ${start}-${end}/${size}`} : {}),
          });
          fs.createReadStream(file, {start, end}).pipe(res);
          return;
        }
        if (req.url?.startsWith('/api/')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ok: true, views: 1, keys: [[1, 3, 'W'], [4, 6, 'Space']],
            highlight: {id: String(Date.now()), time: 5, label: 'Highlight', color: '#ffe000'}}));
          return;
        }
        next();
      });
    },
  }],
  server: {host: '127.0.0.1', port: 5175, strictPort: true},
});
