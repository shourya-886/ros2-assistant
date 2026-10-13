import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { processManager } from '../core/processManager';
import { rosEnvironment } from '../core/rosEnvironment';

export type RosInterfaceKind = 'msg' | 'srv' | 'action';

const INTERFACE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*\/(msg|srv|action)\/[A-Za-z][A-Za-z0-9_]*$/;

/** Parses and validates interface names discovered from AMENT package prefixes. */
export function parseInterfaceTypes(output: string): string[] {
    return [...new Set(output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => INTERFACE_TYPE_PATTERN.test(line)))]
        .sort((a, b) => a.localeCompare(b));
}

/** Displays installed ROS 2 message, service, and action definitions in an editor-tab webview. */
export class InterfaceExplorerPanel {
    private static currentPanel: InterfaceExplorerPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private selectionVersion = 0;

    public static createOrShow(extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (InterfaceExplorerPanel.currentPanel) {
            InterfaceExplorerPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ros2InterfaceExplorer',
            'Interface Explorer',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        InterfaceExplorerPanel.currentPanel = new InterfaceExplorerPanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml();
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'ready' || message.command === 'refresh') {
                this.fetchInterfaces();
            } else if (message.command === 'selectInterface') {
                this.loadDefinition(String(message.interfaceType ?? ''));
            }
        }, null, this.disposables);
    }

    private post(message: object): void {
        void this.panel.webview.postMessage(message);
    }

    private fetchInterfaces(): void {
        // Invalidate any definition request started before this refresh.
        this.selectionVersion++;
        const discoveryScript = [
            'import os',
            'from pathlib import Path',
            'interfaces = set()',
            "for prefix in os.environ.get('AMENT_PREFIX_PATH', '').split(os.pathsep):",
            "    share = Path(prefix) / 'share'",
            '    if not share.is_dir():',
            '        continue',
            "    for package_dir in share.iterdir():",
            '        if not package_dir.is_dir():',
            '            continue',
            "        for kind in ('msg', 'srv', 'action'):",
            '            definition_dir = package_dir / kind',
            '            if definition_dir.is_dir():',
            '                for definition in definition_dir.iterdir():',
            "                    if definition.is_file() and definition.suffix == '.' + kind:",
            '                        interfaces.add(f"{package_dir.name}/{kind}/{definition.stem}")',
            'for interface_type in sorted(interfaces):',
            '    print(interface_type)'
        ].join('\n');
        const encodedScript = Buffer.from(discoveryScript, 'utf8').toString('base64');
        const script = `${rosEnvironment.setupCommand} && exec python3 -c "$(printf %s "${encodedScript}" | base64 -d)"`;

        processManager.execFile('bash', ['-c', script], { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                this.post({
                    command: 'interfaces',
                    types: [],
                    error: (stderr || error.message).trim() || error.message
                });
                return;
            }

            const types = parseInterfaceTypes(stdout);
            this.post({
                command: 'interfaces',
                types,
                error: types.length === 0
                    ? 'No ROS 2 message, service, or action definitions were found. Check that the required ROS 2 packages are installed and sourced.'
                    : undefined
            });
        });
    }

    private loadDefinition(interfaceType: string): void {
        const requestVersion = ++this.selectionVersion;
        if (!INTERFACE_TYPE_PATTERN.test(interfaceType)) {
            this.post({
                command: 'definition',
                interfaceType: '',
                definition: '',
                loading: false,
                error: 'Select a valid ROS 2 interface.'
            });
            return;
        }

        this.post({ command: 'definition', interfaceType, definition: '', loading: true });

        const readerScript = [
            'import os, sys',
            'from pathlib import Path',
            "parts = os.environ['ROS_INTERFACE_TYPE'].split('/')",
            "if len(parts) != 3 or parts[1] not in ('msg', 'srv', 'action'):",
            "    raise ValueError('Invalid ROS 2 interface type.')",
            'package, kind, name = parts',
            "for prefix in os.environ.get('AMENT_PREFIX_PATH', '').split(os.pathsep):",
            "    definition = Path(prefix) / 'share' / package / kind / (name + '.' + kind)",
            '    if definition.is_file():',
            "        sys.stdout.write(definition.read_text(encoding='utf-8'))",
            '        sys.exit(0)',
            "print('Interface definition not found in AMENT_PREFIX_PATH: ' + os.environ['ROS_INTERFACE_TYPE'], file=sys.stderr)",
            'sys.exit(1)'
        ].join('\n');
        const encodedScript = Buffer.from(readerScript, 'utf8').toString('base64');
        const script = `${rosEnvironment.setupCommand} && exec python3 -c "$(printf %s "$ROS_INTERFACE_READER_B64" | base64 -d)"`;
        const env = {
            ...process.env,
            ROS_INTERFACE_TYPE: interfaceType,
            ROS_INTERFACE_READER_B64: encodedScript
        };

        processManager.execFile('bash', ['-c', script], { env }, (error, stdout, stderr) => {
            if (requestVersion !== this.selectionVersion) {
                return;
            }
            if (error || !stdout.trim()) {
                this.post({
                    command: 'definition',
                    interfaceType,
                    definition: '',
                    loading: false,
                    error: (stderr || error?.message || 'Unable to read this interface definition.').trim()
                });
                return;
            }
            this.post({
                command: 'definition',
                interfaceType,
                definition: stdout.replace(/\r\n/g, '\n'),
                loading: false
            });
        });
    }

    private getHtml(): string {
        const nonce = randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>ROS 2 Interface Explorer</title>
<style>
    body { padding: 22px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
    .description, .muted { color: var(--vscode-descriptionForeground); }
    .toolbar { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; margin: 22px 0 18px; }
    .field { display: flex; flex: 1; min-width: 260px; flex-direction: column; gap: 7px; }
    label { font-size: 12px; font-weight: 600; }
    select { width: 100%; box-sizing: border-box; padding: 9px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); font: inherit; }
    button { padding: 8px 13px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-border, transparent); cursor: pointer; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    #status { min-height: 20px; margin: 12px 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #definitionPanel { margin-top: 18px; }
    #definitionTitle { margin: 0 0 9px; font-size: 13px; font-weight: 600; }
    pre { box-sizing: border-box; min-height: 220px; max-height: calc(100vh - 250px); overflow: auto; margin: 0; padding: 16px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); color: var(--vscode-editor-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); line-height: 1.55; white-space: pre; tab-size: 4; }
    .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>ROS 2 Interface Explorer</h1>
<div class="description">Browse installed message, service, and action definitions from your sourced ROS 2 environment.</div>
<div class="toolbar">
    <div class="field">
        <label for="interfaceSelect">ROS 2 interface</label>
        <select id="interfaceSelect" disabled>
            <option value="">Loading interfaces...</option>
        </select>
    </div>
    <button id="refreshButton" type="button">Refresh</button>
</div>
<div id="status" role="status" aria-live="polite">Discovering installed interfaces...</div>
<section id="definitionPanel" aria-live="polite">
    <div id="definitionTitle" class="muted">Select an interface to view its definition.</div>
    <pre id="definition" class="empty">No interface selected.</pre>
</section>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const interfaceSelect = document.getElementById('interfaceSelect');
    const refreshButton = document.getElementById('refreshButton');
    const status = document.getElementById('status');
    const definitionTitle = document.getElementById('definitionTitle');
    const definition = document.getElementById('definition');

    refreshButton.addEventListener('click', () => {
        interfaceSelect.disabled = true;
        status.textContent = 'Refreshing installed interfaces...';
        vscode.postMessage({ command: 'refresh' });
    });

    interfaceSelect.addEventListener('change', () => {
        const interfaceType = interfaceSelect.value;
        definition.textContent = interfaceType ? 'Loading definition...' : 'No interface selected.';
        definition.classList.toggle('empty', !interfaceType);
        definitionTitle.textContent = interfaceType || 'Select an interface to view its definition.';
        status.textContent = interfaceType ? 'Loading interface definition...' : 'Select an interface.';
        vscode.postMessage({ command: 'selectInterface', interfaceType });
    });

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.command === 'interfaces') {
            const previous = interfaceSelect.value;
            interfaceSelect.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = message.error ? 'No interfaces available' : 'Choose an interface...';
            interfaceSelect.appendChild(placeholder);
            for (const type of message.types || []) {
                const option = document.createElement('option');
                option.value = type;
                option.textContent = type;
                interfaceSelect.appendChild(option);
            }
            interfaceSelect.disabled = (message.types || []).length === 0;
            status.textContent = message.error || ((message.types || []).length + ' interface(s) found.');
            if (previous && (message.types || []).includes(previous)) {
                interfaceSelect.value = previous;
                vscode.postMessage({ command: 'selectInterface', interfaceType: previous });
            } else {
                definitionTitle.textContent = 'Select an interface to view its definition.';
                definition.textContent = 'No interface selected.';
                definition.classList.add('empty');
            }
        } else if (message.command === 'definition') {
            if (message.loading) {
                status.textContent = 'Loading interface definition...';
                return;
            }
            definitionTitle.textContent = message.interfaceType || 'Interface definition';
            if (message.error) {
                definition.textContent = message.error;
                definition.classList.add('empty');
                status.textContent = 'Could not load interface definition.';
            } else {
                definition.textContent = message.definition;
                definition.classList.remove('empty');
                status.textContent = 'Definition loaded.';
            }
        }
    });

    vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }

    private dispose(): void {
        if (InterfaceExplorerPanel.currentPanel === this) {
            InterfaceExplorerPanel.currentPanel = undefined;
        }
        this.selectionVersion++;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
