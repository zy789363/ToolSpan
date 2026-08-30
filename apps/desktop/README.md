# ToolSpan Desktop 渲染器

生产启动始终使用 Tauri adapter。若要在没有 Tauri IPC 的情况下进行本地视觉 QA，请启动 Vite，并显式选择 synthetic data：

```text
http://127.0.0.1:1420/?demo=1
http://127.0.0.1:1420/?demo=1&firstRun=1
```

demo adapter 使用保留的 synthetic paths，在 development 或 production 中都不会自动启用。
