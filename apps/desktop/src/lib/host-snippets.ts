/** Agent Host 接入配置片段（连接页 Host tabs 使用） */

export type HostId = "chatgpt" | "claude" | "codex";

export const HOST_META: Record<HostId, { label: string; file: string }> = {
  chatgpt: { label: "ChatGPT", file: "chatgpt.json" },
  claude: { label: "Claude", file: "claude_desktop_config.json" },
  codex: { label: "Codex", file: "~/.codex/config.toml" },
};

export function hostSnippet(host: HostId, mcpUrl: string): string {
  switch (host) {
    case "chatgpt":
      return `{
  "mcpServers": {
    "toolspan": {
      "url": "${mcpUrl}",
      "oauth": true
    }
  }
}`;
    case "claude":
      return `{
  "mcpServers": {
    "toolspan": {
      "url": "${mcpUrl}"
    }
  }
}`;
    case "codex":
      return `[mcp_servers.toolspan]
url = "${mcpUrl}"`;
  }
}
