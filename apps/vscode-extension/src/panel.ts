import * as vscode from "vscode";

export interface PanelBridge {
  startOfflineDemo(): Promise<void>;
  cancelRun(): Promise<void>;
  getStatus(): { runId?: string; state?: string; events: string[] };
}

/**
 * Minimal webview panel shell: header, timeline, start/cancel controls.
 * Model text is treated as untrusted plain text (no script execution from model).
 */
export class Kur3Panel {
  public static current: Kur3Panel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private events: string[] = [];
  private runId?: string;
  private state?: string;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly bridge: PanelBridge,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      if (Kur3Panel.current === this) Kur3Panel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "start") {
        await this.bridge.startOfflineDemo();
        this.refresh();
      } else if (msg?.type === "cancel") {
        await this.bridge.cancelRun();
        this.refresh();
      } else if (msg?.type === "refresh") {
        this.refresh();
      }
    });
  }

  static show(
    context: vscode.ExtensionContext,
    bridge: PanelBridge,
  ): Kur3Panel {
    if (Kur3Panel.current) {
      Kur3Panel.current.panel.reveal();
      return Kur3Panel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "kur3.panel",
      "KUR3 Harness",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new Kur3Panel(panel, bridge);
    Kur3Panel.current = instance;
    context.subscriptions.push(panel);
    return instance;
  }

  updateFromStatus(status: {
    runId?: string;
    state?: string;
    events: string[];
  }): void {
    this.runId = status.runId;
    this.state = status.state;
    this.events = status.events;
    this.refresh();
  }

  private refresh(): void {
    const status = this.bridge.getStatus();
    this.runId = status.runId ?? this.runId;
    this.state = status.state ?? this.state;
    this.events = status.events.length ? status.events : this.events;
    void this.panel.webview.postMessage({
      type: "status",
      runId: this.runId ?? "",
      state: this.state ?? "idle",
      events: this.events,
    });
  }

  private html(): string {
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>KUR3 Harness</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }
    header { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    button { cursor: pointer; }
    .meta { opacity: 0.85; font-size: 12px; }
    #timeline { list-style: none; padding: 0; margin: 0; max-height: 60vh; overflow: auto; }
    #timeline li { padding: 6px 0; border-bottom: 1px solid var(--vscode-widget-border, #444); white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <strong>KUR3 Harness</strong>
    <span class="meta" id="meta">state: idle</span>
    <button id="start">Start offline demo</button>
    <button id="cancel">Cancel</button>
    <button id="refresh">Refresh</button>
  </header>
  <p class="meta">Offline FakeProvider via stdio bridge. Reconnect uses subscribe_events (no duplicate start).</p>
  <ul id="timeline"></ul>
  <script>
    const vscode = acquireVsCodeApi();
    const meta = document.getElementById('meta');
    const timeline = document.getElementById('timeline');
    document.getElementById('start').onclick = () => vscode.postMessage({ type: 'start' });
    document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
    document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type !== 'status') return;
      meta.textContent = 'run: ' + (msg.runId || '(none)') + ' | state: ' + msg.state;
      timeline.innerHTML = '';
      for (const line of msg.events || []) {
        const li = document.createElement('li');
        li.textContent = line;
        timeline.appendChild(li);
      }
    });
  </script>
</body>
</html>`;
  }
}
