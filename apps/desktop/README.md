# ToolSpan Desktop Renderer

Production startup always uses the Tauri adapter. For local visual QA without Tauri IPC, start Vite and opt into synthetic data explicitly:

```text
http://127.0.0.1:1420/?demo=1
http://127.0.0.1:1420/?demo=1&firstRun=1
```

The demo adapter uses reserved synthetic paths and never activates automatically in development or production.
