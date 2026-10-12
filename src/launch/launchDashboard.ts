import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { LaunchManager } from './launchManager';
import type { LaunchFileInfo, LaunchOutput } from './launchManager';
import { discoverLaunchFiles } from './launchManager';

export class LaunchManagerDashboard implements vscode.Disposable {
    private static currentPanel: LaunchManagerDashboard | undefined;
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private workspaceRoots: string[];
    private selectedWorkspace = '';
    private discoveredFiles: LaunchFileInfo[] = [];
    private readonly outputListener = (output: LaunchOutput) => {
        this.post({ command: 'launchOutput', output });
    };
    private readonly startedListener = () => this.postSessions();
    private readonly statusListener = () => this.postSessions();

    static createOrShow(
        manager: LaunchManager,
        workspaceRoots: string[]
    ): void {
        if (LaunchManagerDashboard.currentPanel) {
            LaunchManagerDashboard.currentPanel.workspaceRoots = workspaceRoots;
            LaunchManagerDashboard.currentPanel.panel.reveal(vscode.ViewColumn.Active);
            LaunchManagerDashboard.currentPanel.refreshDiscovery();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'ros2LaunchManager',
            'ROS 2 Launch Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
        );
        LaunchManagerDashboard.currentPanel = new LaunchManagerDashboard(panel, manager, workspaceRoots);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly manager: LaunchManager,
        workspaceRoots: string[]
    ) {
        this.panel = panel;
        this.workspaceRoots = workspaceRoots;
        this.selectedWorkspace = workspaceRoots[0] ?? '';
        const nonce = randomBytes(16).toString('base64');
        this.panel.webview.html = this.getHtml(nonce);
        this.manager.on('output', this.outputListener);
        this.manager.on('started', this.startedListener);
        this.manager.on('status', this.statusListener);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'ready') {
                this.post({ command: 'workspaces', roots: this.workspaceRoots, selected: this.selectedWorkspace });
                this.refreshDiscovery();
                this.postSessions();
            } else if (message.command === 'selectWorkspace') {
                const requested = String(message.workspace ?? '');
                if (this.workspaceRoots.includes(requested)) {
                    this.selectedWorkspace = requested;
                    this.refreshDiscovery();
                }
            } else if (message.command === 'refreshDiscovery') {
                this.refreshDiscovery();
            } else if (message.command === 'inspectArguments') {
                void this.inspectArguments(message.filePath);
            } else if (message.command === 'startLaunch') {
                this.startLaunch(message.filePath, message.arguments ?? {}, String(message.extraArguments ?? ''));
            } else if (message.command === 'stopLaunch') {
                const id = Number(message.id);
                if (!Number.isInteger(id) || !this.manager.stopLaunch(id)) {
                    this.post({ command: 'error', message: 'That launch process is no longer running.' });
                }
            } else if (message.command === 'refreshNodes') {
                void this.refreshNodes();
            }
        }, null, this.disposables);
    }

    private post(message: object): void {
        void this.panel.webview.postMessage(message);
    }

    private refreshDiscovery(): void {
        if (!this.selectedWorkspace || !this.workspaceRoots.includes(this.selectedWorkspace)) {
            this.discoveredFiles = [];
            this.post({ command: 'discovery', files: [], issues: [], error: 'Open a ROS 2 workspace folder in VS Code.' });
            return;
        }
        const result = discoverLaunchFiles(this.selectedWorkspace);
        this.discoveredFiles = result.launchFiles;
        this.post({
            command: 'discovery',
            files: result.launchFiles,
            issues: result.issues,
            packagesScanned: result.packagesScanned,
            scanLimitReached: result.scanLimitReached
        });
    }

    private async inspectArguments(filePath: unknown): Promise<void> {
        const selected = this.discoveredFiles.find(file => file.filePath === path.resolve(String(filePath ?? '')));
        if (!selected) {
            return;
        }
        try {
            const argumentsList = await this.manager.inspectLaunchArguments(selected);
            this.post({ command: 'launchArguments', filePath: selected.filePath, arguments: argumentsList });
        } catch (error) {
            this.post({
                command: 'launchArguments',
                filePath: selected.filePath,
                arguments: selected.arguments,
                warning: error instanceof Error ? error.message : String(error)
            });
        }
    }

    private startLaunch(filePath: unknown, rawArguments: unknown, extraText: string): void {
        const selected = this.discoveredFiles.find(file => file.filePath === path.resolve(String(filePath ?? '')));
        if (!selected) {
            this.post({ command: 'error', message: 'Select a launch file from the discovered workspace list.' });
            return;
        }
        if (!rawArguments || typeof rawArguments !== 'object' || Array.isArray(rawArguments)) {
            this.post({ command: 'error', message: 'Launch arguments are invalid.' });
            return;
        }
        const argumentsMap: Record<string, string> = {};
        for (const [key, value] of Object.entries(rawArguments as Record<string, unknown>)) {
            if (typeof value !== 'string') {
                this.post({ command: 'error', message: 'Launch argument values must be strings.' });
                return;
            }
            argumentsMap[key] = value;
        }
        const extraArguments = extraText.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        try {
            const session = this.manager.startLaunch(selected, argumentsMap, extraArguments);
            this.post({ command: 'launchStarted', session });
            this.postSessions();
        } catch (error) {
            this.post({ command: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    }

    private postSessions(): void {
        this.post({ command: 'sessions', sessions: this.manager.getSessions() });
    }

    private async refreshNodes(): Promise<void> {
        this.post({ command: 'nodesLoading' });
        try {
            const nodes = await this.manager.getNodes();
            this.post({ command: 'nodes', nodes, refreshedAt: Date.now() });
        } catch (error) {
            this.post({ command: 'nodesError', message: error instanceof Error ? error.message : String(error) });
        }
    }

    private getHtml(nonce: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>ROS 2 Launch Manager</title>
<style>
:root { color-scheme: light dark; }
body { padding: 18px 22px 28px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
h1 { font-size: 20px; margin: 0 0 6px; }
h2 { font-size: 14px; margin: 0 0 12px; }
.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
.layout { display: grid; grid-template-columns: minmax(250px, 0.9fr) minmax(360px, 1.5fr); gap: 16px; margin-top: 18px; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 14px; min-width: 0; }
.toolbar, .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.toolbar { margin: 12px 0; }
select, input, textarea { box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 7px 8px; border-radius: 3px; font: inherit; }
select { width: 100%; }
input[type=text] { width: 100%; }
textarea { width: 100%; min-height: 65px; resize: vertical; font-family: var(--vscode-editor-font-family); }
button { border: 0; border-radius: 3px; padding: 7px 11px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.danger { background: var(--vscode-errorForeground); color: #fff; }
button:disabled { opacity: .45; cursor: default; }
.list { display: flex; flex-direction: column; gap: 5px; max-height: 420px; overflow: auto; }
.file { text-align: left; width: 100%; background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; padding: 9px; }
.file:hover, .file.selected { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
.file strong, .file small { display: block; }
.file small { color: var(--vscode-descriptionForeground); margin-top: 4px; overflow-wrap: anywhere; }
.field { margin: 10px 0; }
.field label { display: block; margin-bottom: 5px; font-size: 12px; }
.field small { display: block; color: var(--vscode-descriptionForeground); margin-top: 3px; }
.empty { color: var(--vscode-descriptionForeground); padding: 12px 4px; font-size: 12px; }
.session { border-top: 1px solid var(--vscode-panel-border); padding: 10px 0; }
.session-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.status { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.status.running { color: var(--vscode-testing-iconPassed); }
pre { margin: 0; padding: 10px; min-height: 160px; max-height: 330px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-terminal-background, var(--vscode-textCodeBlock-background)); font: 12px var(--vscode-editor-font-family, monospace); }
.output-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
.node-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.node { font: 11px var(--vscode-editor-font-family, monospace); padding: 4px 7px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 3px; }
#notice { margin: 10px 0; color: var(--vscode-errorForeground); font-size: 12px; }
@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<h1>ROS 2 Launch Manager</h1>
<div class="muted">Discover launch files, configure arguments, and manage running ROS 2 launch processes.</div>
<div class="toolbar">
<label for="workspace">Workspace</label>
<select id="workspace"></select>
<button id="refresh" class="secondary">Refresh files</button>
</div>
<div id="notice" role="alert"></div>
<div class="layout">
<section class="card">
<h2>Launch files <span id="file-count" class="muted"></span></h2>
<div id="file-list" class="list"><div class="empty">Discovering launch files...</div></div>
<div id="discovery-info" class="muted"></div>
</section>
<section class="card">
<h2 id="selected-title">Launch configuration</h2>
<div id="selected-path" class="muted">Select a launch file to configure it.</div>
<div id="arguments"></div>
<div class="field">
<label for="extra-args">Additional arguments (one name:=value per line)</label>
<textarea id="extra-args" placeholder="use_sim_time:=true"></textarea>
<small>Use this for arguments that could not be detected automatically or are not declared statically.</small>
</div>
<div class="row">
<button id="start" disabled>Start launch</button>
<button id="clear-args" class="secondary">Reset arguments</button>
</div>
</section>
</div>
<div class="layout">
<section class="card">
<h2>Launch processes <span id="session-count" class="muted"></span></h2>
<div id="sessions"><div class="empty">No launch sessions yet.</div></div>
</section>
<section class="card">
<h2>Live terminal output</h2>
<div class="output-toolbar">
<select id="output-session" aria-label="Select launch output"><option value="">No sessions</option></select>
<label class="muted"><input id="auto-scroll" type="checkbox" checked> Auto-scroll</label>
<button id="clear-output" class="secondary">Clear</button>
</div>
<pre id="output">Select a launch session to view its output.</pre>
</section>
</div>
<section class="card" style="margin-top:16px">
<div class="row" style="justify-content:space-between">
<h2>ROS 2 nodes</h2>
<button id="refresh-nodes" class="secondary">Refresh nodes</button>
</div>
<div class="muted">These are nodes currently visible in the ROS graph. ROS 2 does not expose a reliable universal mapping from a node to the launch process that started it, so this list is workspace-wide and association is approximate.</div>
<div id="nodes" class="node-list"><span class="empty">Refresh to query ros2 node list.</span></div>
</section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const workspaceSelect = document.getElementById('workspace');
const fileList = document.getElementById('file-list');
const fileCount = document.getElementById('file-count');
const discoveryInfo = document.getElementById('discovery-info');
const selectedTitle = document.getElementById('selected-title');
const selectedPath = document.getElementById('selected-path');
const argumentContainer = document.getElementById('arguments');
const extraArgs = document.getElementById('extra-args');
const startButton = document.getElementById('start');
const sessionsContainer = document.getElementById('sessions');
const sessionCount = document.getElementById('session-count');
const outputSelect = document.getElementById('output-session');
const output = document.getElementById('output');
const autoScroll = document.getElementById('auto-scroll');
const nodesContainer = document.getElementById('nodes');
const notice = document.getElementById('notice');
let files = [];
let selectedFile = null;
let sessions = [];
let outputBySession = {};
let selectedOutputId = '';
let argumentDefaults = {};

function showNotice(message) { notice.textContent = message || ''; }
function send(command, data) { vscode.postMessage(Object.assign({ command }, data || {})); }
function renderFiles() {
    fileList.replaceChildren();
    fileCount.textContent = '(' + files.length + ')';
    if (!files.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No launch files found in package launch/ directories.';
        fileList.appendChild(empty);
        return;
    }
    files.forEach(file => {
        const button = document.createElement('button');
        button.className = 'file' + (selectedFile && selectedFile.filePath === file.filePath ? ' selected' : '');
        const title = document.createElement('strong');
        title.textContent = file.packageName + ' / ' + file.fileName;
        const detail = document.createElement('small');
        detail.textContent = file.relativePath;
        button.append(title, detail);
        button.addEventListener('click', () => selectFile(file));
        fileList.appendChild(button);
    });
}
function selectFile(file, inspectedArguments) {
    selectedFile = file;
    argumentDefaults = {};
    selectedTitle.textContent = file.packageName + ' / ' + file.fileName;
    selectedPath.textContent = file.relativePath;
    argumentContainer.replaceChildren();
    const launchArguments = inspectedArguments || file.arguments;
    if (!launchArguments.length) {
        const hint = document.createElement('div');
        hint.className = 'empty';
        hint.textContent = 'No static launch arguments detected. Use the additional arguments field below if required.';
        argumentContainer.appendChild(hint);
    }
    launchArguments.forEach(argument => {
        const wrapper = document.createElement('div');
        wrapper.className = 'field';
        const label = document.createElement('label');
        label.textContent = argument.name;
        label.htmlFor = 'arg-' + argument.name;
        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'arg-' + argument.name;
        input.value = argument.defaultValue || '';
        input.dataset.argument = argument.name;
        input.placeholder = 'Enter value';
        wrapper.append(label, input);
        if (argument.description) {
            const description = document.createElement('small');
            description.textContent = argument.description;
            wrapper.appendChild(description);
        }
        argumentDefaults[argument.name] = argument.defaultValue || '';
        argumentContainer.appendChild(wrapper);
    });
    startButton.disabled = false;
    renderFiles();
    if (!inspectedArguments) send('inspectArguments', { filePath: file.filePath });
}
function collectArguments() {
    const values = {};
    argumentContainer.querySelectorAll('input[data-argument]').forEach(input => {
        values[input.dataset.argument] = input.value;
    });
    return values;
}
function renderSessions() {
    sessionsContainer.replaceChildren();
    sessionCount.textContent = '(' + sessions.length + ')';
    if (!sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No launch sessions yet.';
        sessionsContainer.appendChild(empty);
    }
    sessions.forEach(session => {
        const wrapper = document.createElement('div');
        wrapper.className = 'session';
        const head = document.createElement('div');
        head.className = 'session-head';
        const title = document.createElement('strong');
        title.textContent = '#' + session.id + ' ' + session.packageName + ' / ' + session.launchFile;
        const status = document.createElement('span');
        status.className = 'status ' + session.status;
        status.textContent = session.status;
        head.append(title, status);
        const detail = document.createElement('div');
        detail.className = 'muted';
        detail.textContent = 'PID ' + (session.pid || 'starting') + ' · ' + new Date(session.startedAt).toLocaleTimeString();
        const controls = document.createElement('div');
        controls.className = 'row';
        const view = document.createElement('button');
        view.className = 'secondary';
        view.textContent = 'View output';
        view.addEventListener('click', () => {
            selectedOutputId = String(session.id);
            renderOutputSelector();
            renderOutput();
        });
        controls.appendChild(view);
        if (session.status === 'running') {
            const stop = document.createElement('button');
            stop.className = 'danger';
            stop.textContent = 'Stop';
            stop.addEventListener('click', () => send('stopLaunch', { id: session.id }));
            controls.appendChild(stop);
        }
        wrapper.append(head, detail, controls);
        sessionsContainer.appendChild(wrapper);
    });
    renderOutputSelector();
}
function renderOutputSelector() {
    const previous = selectedOutputId;
    outputSelect.replaceChildren();
    sessions.forEach(session => {
        const option = document.createElement('option');
        option.value = String(session.id);
        option.textContent = '#' + session.id + ' ' + session.packageName + ' / ' + session.launchFile;
        outputSelect.appendChild(option);
    });
    if (sessions.some(session => String(session.id) === previous)) {
        selectedOutputId = previous;
    } else {
        selectedOutputId = sessions.length ? String(sessions[0].id) : '';
    }
    outputSelect.value = selectedOutputId;
    if (!selectedOutputId) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No sessions';
        outputSelect.appendChild(option);
    }
    renderOutput();
}
function renderOutput() {
    output.textContent = outputBySession[selectedOutputId] || 'No output received for this launch session.';
    if (autoScroll.checked) output.scrollTop = output.scrollHeight;
}
function appendOutput(event) {
    const id = String(event.launchId);
    outputBySession[id] = (outputBySession[id] || '') + event.data;
    if (outputBySession[id].length > 500000) {
        outputBySession[id] = outputBySession[id].slice(-500000);
    }
    if (id === selectedOutputId) renderOutput();
}
function renderNodes(nodes) {
    nodesContainer.replaceChildren();
    if (!nodes.length) {
        const empty = document.createElement('span');
        empty.className = 'empty';
        empty.textContent = 'No active nodes found.';
        nodesContainer.appendChild(empty);
        return;
    }
    nodes.forEach(name => {
        const chip = document.createElement('span');
        chip.className = 'node';
        chip.textContent = name;
        nodesContainer.appendChild(chip);
    });
}
document.getElementById('refresh').addEventListener('click', () => send('refreshDiscovery'));
workspaceSelect.addEventListener('change', () => send('selectWorkspace', { workspace: workspaceSelect.value }));
startButton.addEventListener('click', () => {
    if (!selectedFile) return;
    showNotice('');
    send('startLaunch', {
        filePath: selectedFile.filePath,
        arguments: collectArguments(),
        extraArguments: extraArgs.value
    });
});
document.getElementById('clear-args').addEventListener('click', () => {
    if (!selectedFile) return;
    argumentContainer.querySelectorAll('input[data-argument]').forEach(input => {
        input.value = argumentDefaults[input.dataset.argument] || '';
    });
    extraArgs.value = '';
});
document.getElementById('refresh-nodes').addEventListener('click', () => send('refreshNodes'));
document.getElementById('clear-output').addEventListener('click', () => {
    if (selectedOutputId) outputBySession[selectedOutputId] = '';
    renderOutput();
});
outputSelect.addEventListener('change', () => {
    selectedOutputId = outputSelect.value;
    renderOutput();
});
window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'workspaces') {
        workspaceSelect.replaceChildren();
        message.roots.forEach(root => {
            const option = document.createElement('option');
            option.value = root;
            option.textContent = root;
            workspaceSelect.appendChild(option);
        });
        workspaceSelect.value = message.selected || '';
    } else if (message.command === 'discovery') {
        files = message.files || [];
        if (selectedFile && !files.some(file => file.filePath === selectedFile.filePath)) {
            selectedFile = null;
            selectedTitle.textContent = 'Launch configuration';
            selectedPath.textContent = 'Select a launch file to configure it.';
            argumentContainer.replaceChildren();
            startButton.disabled = true;
        }
        renderFiles();
        discoveryInfo.textContent = (message.packagesScanned || 0) + ' packages scanned' +
            ((message.issues || []).length ? ' · ' + message.issues.length + ' discovery warnings' : '');
        showNotice(message.error || '');
    } else if (message.command === 'launchArguments') {
        if (selectedFile && selectedFile.filePath === message.filePath) {
            selectFile(selectedFile, message.arguments || []);
            if (message.warning) showNotice('Argument inspection fell back to static parsing: ' + message.warning);
        }
    } else if (message.command === 'sessions') {
        sessions = message.sessions || [];
        renderSessions();
    } else if (message.command === 'launchOutput') {
        appendOutput(message.output);
    } else if (message.command === 'error') {
        showNotice(message.message);
    } else if (message.command === 'nodesLoading') {
        nodesContainer.textContent = 'Querying ROS graph...';
    } else if (message.command === 'nodes') {
        renderNodes(message.nodes || []);
    } else if (message.command === 'nodesError') {
        nodesContainer.textContent = 'Could not query nodes: ' + message.message;
    }
});
send('ready');
</script>
</body>
</html>`;
    }

    dispose(): void {
        this.manager.removeListener('output', this.outputListener);
        this.manager.removeListener('started', this.startedListener);
        this.manager.removeListener('status', this.statusListener);
        LaunchManagerDashboard.currentPanel = undefined;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
