import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Folder } from "lucide-react";

import { Button } from "../../src/components/ui/button";
import { CodeBlock } from "../../src/components/ui/code-block";
import { ConfirmPhrase } from "../../src/components/ui/confirm-phrase";
import { EmptyState } from "../../src/components/ui/empty-state";
import { Modal } from "../../src/components/ui/modal";
import { NavBadge } from "../../src/components/ui/nav-badge";
import { Notice } from "../../src/components/ui/notice";
import { SecretInput } from "../../src/components/ui/secret-input";
import { Stat } from "../../src/components/ui/stat";
import { StatusBanner } from "../../src/components/ui/status-banner";
import { Stepper } from "../../src/components/ui/stepper";
import { Tabs } from "../../src/components/ui/tabs";
import { Toggle } from "../../src/components/ui/toggle";

describe("v2 Button", () => {
  it("renders subtle variant and xs size classes", () => {
    const { container } = render(<Button size="xs" variant="subtle">推荐</Button>);
    expect(container.querySelector(".button--subtle")).toBeTruthy();
    expect(container.querySelector(".button--xs")).toBeTruthy();
  });

  it("shows a spinner and disables while loading", () => {
    const { container } = render(<Button loading>开始</Button>);
    expect(container.querySelector(".button__spinner")).toBeTruthy();
    expect((screen.getByRole("button", { name: "开始" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("v2 Toggle", () => {
  it("toggles checked state via switch role", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle aria-label="暂停" checked={false} label="暂停" onChange={onChange} />);
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await user.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("v2 Stepper", () => {
  it("marks completed and active steps", () => {
    render(<Stepper current={1} steps={["路径", "凭证", "域名"]} />);
    const labels = screen.getAllByText(/路径|凭证|域名/);
    expect(labels.length).toBe(3);
    // step 0 done → 勾图标节点
    const node0 = labels[0]!.previousElementSibling as HTMLElement;
    expect(node0.className).toContain("stepper__node--done");
    // step 1 active
    const node1 = labels[1]!.previousElementSibling as HTMLElement;
    expect(node1.className).toContain("stepper__node--active");
  });
});

describe("v2 EmptyState", () => {
  it("renders title, description and action", () => {
    render(
      <EmptyState
        action={<Button size="compact">添加</Button>}
        description="添加一个目录后，Agent 才能读写文件。"
        icon={<Folder size={20} />}
        title="还没有工作区"
      />,
    );
    expect(screen.getByText("还没有工作区")).toBeTruthy();
    expect(screen.getByText(/添加一个目录后/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "添加" })).toBeTruthy();
  });
});

describe("v2 SecretInput", () => {
  it("is password by default and reveals on toggle", async () => {
    const user = userEvent.setup();
    render(<SecretInput placeholder="粘贴 Token" />);
    const input = screen.getByPlaceholderText("粘贴 Token") as HTMLInputElement;
    expect(input.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "显示密钥" }));
    expect(input.type).toBe("text");
  });
});

describe("v2 ConfirmPhrase", () => {
  it("locks the confirm button until the phrase matches", async () => {
    const user = userEvent.setup();
    const onConfirmed = vi.fn();
    render(<ConfirmPhrase onConfirmed={onConfirmed} phrase="I understand full access" />);
    const confirm = screen.getByRole("button", { name: /继续/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByPlaceholderText("输入 I understand full access"), "I understand full access");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(confirm);
    expect(onConfirmed).toHaveBeenCalled();
  });
});

describe("v2 StatusBanner", () => {
  it("renders ok state with success styling", () => {
    const { container } = render(<StatusBanner status="ok" title="配置完成" description="公网连接已就绪。" />);
    expect(screen.getByText("配置完成")).toBeTruthy();
    expect(container.querySelector(".status-banner--ok")).toBeTruthy();
  });
});

describe("v2 CodeBlock", () => {
  it("renders code and filename header", () => {
    render(<CodeBlock code="const a = 1;" filename="demo.ts" />);
    expect(screen.getByText("const a = 1;")).toBeTruthy();
    expect(screen.getByText("demo.ts")).toBeTruthy();
  });
});

describe("v2 NavBadge", () => {
  it("renders badge content", () => {
    render(<NavBadge>新</NavBadge>);
    expect(screen.getByText("新").className).toContain("nav-badge");
  });
});

describe("v2 Stat", () => {
  it("renders metric-card structure with icon and value", () => {
    render(<Stat icon={<Folder size={18} />} label="Core 状态" value="运行中" />);
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("Core 状态")).toBeTruthy();
  });
});

describe("v2 Tabs", () => {
  it("renders tablist with aria-selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Tabs
        items={[
          { label: "ChatGPT", value: "chatgpt" },
          { label: "Claude", value: "claude" },
        ]}
        onChange={onChange}
        value="chatgpt"
      />,
    );
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "ChatGPT" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "Claude" }));
    expect(onChange).toHaveBeenCalledWith("claude");
  });
});

describe("v2 Modal", () => {
  it("renders title and content when open", () => {
    render(
      <Modal open onClose={() => {}} title="移除确认">
        确定要移除吗？
      </Modal>,
    );
    expect(screen.getByRole("alertdialog", { name: "移除确认" })).toBeTruthy();
    expect(screen.getByText(/确定要移除吗/)).toBeTruthy();
  });

  it("does not render when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="移除确认">
        内容
      </Modal>,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("v2 Notice 四态", () => {
  it("danger tone applies danger styling", () => {
    const { container } = render(<Notice tone="danger">错误</Notice>);
    expect(container.querySelector(".notice--danger")).toBeTruthy();
  });

  it("success tone applies success styling", () => {
    const { container } = render(<Notice tone="success">成功</Notice>);
    expect(container.querySelector(".notice--success")).toBeTruthy();
  });
});
