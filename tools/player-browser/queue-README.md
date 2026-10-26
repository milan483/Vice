# Playback provider queue browser checks

This harness mounts the real StoreProvider, PlaybackProvider, Home and Clips
screens. It supplies in-memory API responses and explicitly drives library
updates, including the daemon's old-slug deletion during rename. The player
uses the shared real H.264 fixture served by the existing player Vite server.

With that server running on port 5175, run:

```sh
node tools/player-browser/queue-check.mjs
```

Override `QUEUE_TEST_URL`, `PLAYWRIGHT_MODULE`, or `PLAYER_BROWSER` when needed.
Results are saved to `/tmp/vice-player-browser/queue-results.json`.
The suite covers originating Home rows, filtered Clips, playlists, context-menu
Open, additions, deletions, current/later rename, and delayed highlight fetches, including successful H mutations racing old GET
responses or GET failures.
