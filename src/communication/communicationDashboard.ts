import * as vscode from 'vscode';
import { type ChildProcess } from 'child_process';
import { formatProcessError, processManager } from '../core/processManager';
import { rosEnvironment } from '../core/rosEnvironment';
import { secureWebviewHtml } from '../core/webview';

type GraphSnapshot = {
    nodes: string[];
    topics: Array<{ name: string; type: string; publishers: string[]; subscribers: string[] }>;
    services: Array<{ name: string; type: string; servers: string[]; clients: string[] }>;
    actions: Array<{ name: string; type: string; servers: string[]; clients: string[] }>;
    errors: string[];
};

interface DashboardMessage {
    command?: string;
    [key: string]: unknown;
}

function lines(output: string): string[] {
    return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

export function parseTyped(output: string): Array<{ name: string; type: string }> {
    return lines(output).map(line => {
        const match = line.match(/^(\S+)\s+\[(.+)\]$/);
        return match ? { name: match[1], type: match[2] } : { name: line, type: 'unknown' };
    });
}


export function validName(value: string): boolean {
    return /^\/[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/.test(value);
}
export function validType(value: string, kind: 'msg' | 'srv' | 'action'): boolean {
    const parts = value.split('/');
    return parts.length === 3 && /^[A-Za-z][A-Za-z0-9_]*$/.test(parts[0]) && parts[1] === kind && /^[A-Za-z][A-Za-z0-9_]*$/.test(parts[2]);
}
export function buildTemplate(definition: string, action = false): string {
    const fields: string[] = [];
    for (const raw of definition.split(/\r?\n/)) {
        if (action && raw.trim() === '---') {
            break;
        }
        const line = raw.split('#')[0].trim();
        if (!line || /^\S+\s+\S+\s*=/.test(line) || /^\s/.test(raw)) {
            continue;
        }
        const parts = line.split(/\s+/);
        if (parts.length < 2) {
            continue;
        }
        const type = parts[0];
        const value = type.endsWith(']') ? '[]' : /^w?string/.test(type) ? "''" : type === 'bool' ? 'false' : /^float(32|64)$/.test(type) ? '0.0' : /^(u?int(8|16|32|64)|byte|char)$/.test(type) ? '0' : '{}';
        fields.push('  ' + parts[1] + ': ' + value);
    }
    return fields.length ? '{\n' + fields.join(',\n') + '\n}' : '{}';
}
function runRos(command: string, env: NodeJS.ProcessEnv = process.env, timeout = 12000): Promise<string> {
    return new Promise((resolve, reject) => {
        processManager.execFile('bash', ['-c', rosEnvironment.setupCommand + ' && ' + command], {
            env, timeout, maxBuffer: 2 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(formatProcessError(command, error, stderr, stdout)));
            } else {
                resolve(stdout);
            }
        });
    });
}

export class CommunicationDashboard {
    private static panel: vscode.WebviewPanel | undefined;
    private static current: CommunicationDashboard | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private refreshing = false;
    private disposed = false;
    private readonly activeProcesses = new Map<string, ChildProcess>();

    static stopActiveProcesses(): void {
        CommunicationDashboard.current?.stopAllProcesses();
    }

    private stopAllProcesses(): void {
        for (const key of [...this.activeProcesses.keys()]) { this.stopProcess(key); }
    }

    static createOrShow(extensionUri: vscode.Uri): void {
        if (CommunicationDashboard.panel) {
            CommunicationDashboard.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'ros2CommunicationDashboard',
            'ROS 2 Communication',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] }
        );
        CommunicationDashboard.panel = panel;
        CommunicationDashboard.current = new CommunicationDashboard(panel, extensionUri);
    }

    private constructor(private readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {
        panel.webview.html = this.html();
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(async (message: DashboardMessage) => {
            try {
            if (message?.command === 'ready') {
                // Wait until the webview has installed its message listener before sending graph data.
                await this.refresh();
            } else if (message?.command === 'refresh') {
                await this.refresh();
            } else if (message?.command === 'loadTemplate') {
                await this.loadTemplate(String(message.kind || ''), String(message.type || ''));
            } else if (message?.command === 'publish') {
                this.publish(message);
            } else if (message?.command === 'stopPublish') {
                this.stopProcess('publisher');
            } else if (message?.command === 'startEcho') {
                this.startEcho(String(message.topic || ''));
            } else if (message?.command === 'stopEcho') {
                this.stopProcess('echo');
            } else if (message?.command === 'callService') {
                this.callService(message);
            } else if (message?.command === 'sendGoal') {
                this.sendGoal(message);
            } else if (message?.command === 'cancelGoal') {
                this.stopProcess('action');
            } else if (message?.command === 'openEcho') {
                await vscode.commands.executeCommand('ros2-assistant.inspectItem', { label: String(message.topic || ''), viewType: 'topics' });
            } else if (message?.command === 'open') {
                const commands: Record<string, string> = {
                    topic: 'ros2-assistant.publishTopic',
                    service: 'ros2-assistant.inspectService',
                    action: 'ros2-assistant.inspectAction'
                };
                const kind = String(message.kind || '');
                const command = commands[kind];
                if (command) {
                    if (kind === 'topic') {
                        await vscode.commands.executeCommand(command);
                    } else {
                        await vscode.commands.executeCommand(command, {
                            label: String(message.name || ''),
                            viewType: kind === 'service' ? 'services' : 'actions'
                        });
                    }
                }
            }
            } catch (error) {
                this.panel.webview.postMessage({ command: 'operationError', operation: message?.command, error: error instanceof Error ? error.message : String(error) });
            }
        }, null, this.disposables);
    }


    private async loadTemplate(kind: string, type: string): Promise<void> {
        if (kind !== 'srv' && kind !== 'action' && kind !== 'msg') {
            throw new Error('Unsupported interface kind.');
        }
        if (!validType(type, kind)) {
            throw new Error('Invalid ROS interface type.');
        }
        const env = { ...process.env, ROS_INTERFACE_TYPE: type };
        const script = 'IFS=/ read -r pkg kind name <<< "$ROS_INTERFACE_TYPE"; IFS=: read -ra prefixes <<< "$AMENT_PREFIX_PATH"; for p in "${prefixes[@]}"; do f="$p/share/$pkg/$kind/$name.$kind"; if [ -f "$f" ]; then cat "$f"; exit 0; fi; done; echo "Definition not found for $ROS_INTERFACE_TYPE" >&2; exit 1';
        const definition = await runRos(script, env, 10000);
        this.panel.webview.postMessage({ command: kind === 'srv' ? 'serviceTemplate' : kind === 'msg' ? 'topicTemplate' : 'actionTemplate', template: buildTemplate(definition, kind !== 'msg') });
    }

    private startEcho(topic: string): void {
        if (this.activeProcesses.has('echo')) {
            throw new Error('A topic subscription is already running.');
        }
        if (!validName(topic)) {
            throw new Error('Select a valid topic.');
        }
        const env = { ...process.env, ROS_TOPIC_NAME: topic };
        const script = rosEnvironment.setupCommand + ' && exec ros2 topic echo "$ROS_TOPIC_NAME"';
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.trackProcess('echo', child, 'echoStatus');
        this.panel.webview.postMessage({ command: 'echoStatus', running: true, text: 'Subscribing to ' + topic + '...' });
    }

    private publish(message: DashboardMessage): void {
        if (this.activeProcesses.has('publisher')) {
            throw new Error('A publisher is already running.');
        }
        const topic = String(message.topic || '').trim();
        const type = String(message.type || '').trim();
        const yaml = String(message.yaml || '');
        const rate = Number(message.rate), count = Number(message.count);
        if (!validName(topic)) {
            throw new Error('Enter a valid absolute ROS topic name.');
        }
        if (!validType(type, 'msg')) {
            throw new Error('Select a valid ROS message type.');
        }
        if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) {
            throw new Error('Publish rate must be between 0 and 1000 Hz.');
        }
        if (!Number.isInteger(count) || count < 1 || count > 100000) {
            throw new Error('Message count must be between 1 and 100000.');
        }
        if (!yaml.trim()) {
            throw new Error('Message YAML cannot be empty.');
        }
        const py = [
            'import os,time,yaml,rclpy',
            'from contextlib import suppress',
            'from rosidl_runtime_py.utilities import get_message',
            'from rosidl_runtime_py.set_message import set_message_fields',
            "topic=os.environ['ROS_TOPIC_NAME']; type_name=os.environ['ROS_MESSAGE_TYPE']",
            "rate=float(os.environ['ROS_PUBLISH_RATE']); count=int(os.environ['ROS_PUBLISH_COUNT'])",
            "payload=yaml.safe_load(os.environ['ROS_MESSAGE_YAML']) or {}",
            "if not isinstance(payload,dict): raise ValueError('Message YAML must be a mapping/object.')",
            "rclpy.init(); node=rclpy.create_node('ros2_assistant_dashboard_publisher')",
            'try:',
            ' msg_type=get_message(type_name); pub=node.create_publisher(msg_type,topic,10)',
            ' for i in range(count):',
            '  msg=msg_type(); set_message_fields(msg,payload); pub.publish(msg)',
            "  node.get_logger().info('Published %d/%d to %s' % (i+1,count,topic))",
            '  rclpy.spin_once(node,timeout_sec=0.0)',
            '  if i+1<count: time.sleep(1.0/rate)',
            'finally:',
            ' node.destroy_node(); rclpy.try_shutdown()'
        ].join('\n');
        const env = { ...process.env, PYTHONUNBUFFERED: '1', ROS_TOPIC_NAME: topic, ROS_MESSAGE_TYPE: type, ROS_PUBLISH_RATE: String(rate), ROS_PUBLISH_COUNT: String(count), ROS_MESSAGE_YAML: yaml, ROS_DASHBOARD_SCRIPT: Buffer.from(py, 'utf8').toString('base64') };
        const script = rosEnvironment.setupCommand + ' && exec python3 -c "$(printf %s "$ROS_DASHBOARD_SCRIPT" | base64 -d)"';
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.trackProcess('publisher', child, 'publishStatus');
        this.panel.webview.postMessage({ command: 'publishStatus', running: true, text: 'Publishing to ' + topic + ' at ' + rate + ' Hz...' });
    }

    private callService(message: DashboardMessage): void {
        if (this.activeProcesses.has('service')) {
            throw new Error('A service call is already running.');
        }
        const name = String(message.name || '').trim(), type = String(message.type || '').trim();
        const request = String(message.request || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (!validName(name)) {
            throw new Error('Select a valid service name.');
        }
        if (!validType(type, 'srv')) {
            throw new Error('Select a valid service type.');
        }
        if (!request) {
            throw new Error('Service request cannot be empty.');
        }
        const env = { ...process.env, ROS_SERVICE_NAME: name, ROS_SERVICE_TYPE: type, ROS_SERVICE_REQUEST: request };
        const script = rosEnvironment.setupCommand + ' && exec ros2 service call "$ROS_SERVICE_NAME" "$ROS_SERVICE_TYPE" "$ROS_SERVICE_REQUEST"';
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.trackProcess('service', child, 'serviceStatus', 30000);
        this.panel.webview.postMessage({ command: 'serviceStatus', running: true, text: 'Calling ' + name + '...' });
    }

    private sendGoal(message: DashboardMessage): void {
        if (this.activeProcesses.has('action')) {
            throw new Error('An action goal is already running.');
        }
        const name = String(message.name || '').trim(), type = String(message.type || '').trim();
        const goal = String(message.goal || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (!validName(name)) {
            throw new Error('Select a valid action name.');
        }
        if (!validType(type, 'action')) {
            throw new Error('Select a valid action type.');
        }
        if (!goal) {
            throw new Error('Action goal cannot be empty.');
        }
        const env = { ...process.env, ROS_ACTION_NAME: name, ROS_ACTION_TYPE: type, ROS_ACTION_GOAL: goal };
        const script = rosEnvironment.setupCommand + ' && exec ros2 action send_goal --feedback "$ROS_ACTION_NAME" "$ROS_ACTION_TYPE" "$ROS_ACTION_GOAL"';
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.trackProcess('action', child, 'actionStatus');
        this.panel.webview.postMessage({ command: 'actionStatus', running: true, text: 'Sending goal to ' + name + '...' });
    }

    private trackProcess(key: string, child: ChildProcess, status: string, timeoutMs = 0): void {
        this.activeProcesses.set(key, child);
        let output = '', finished = false;
        const timeout = timeoutMs ? setTimeout(() => {
            processManager.terminate(child, 'SIGTERM', 2000);
            finish('Timed out after ' + timeoutMs / 1000 + ' seconds.', false);
        }, timeoutMs) : undefined;
        const finish = (text: string, success: boolean) => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            if (this.activeProcesses.get(key) === child) {
                this.activeProcesses.delete(key);
            }
            this.panel.webview.postMessage({ command: status, running: false, text, success });
        };
        const append = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-14000);
            this.panel.webview.postMessage({ command: status.replace('Status', 'Output'), text: chunk.toString() });
        };
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        child.once('error', error => finish('Failed to start: ' + error.message, false));
        child.once('close', code => finish(output.trim() || (code === 0 ? 'Completed successfully.' : 'Process exited with code ' + code + '.'), code === 0));
    }

    private stopProcess(key: string): void {
        const child = this.activeProcesses.get(key);
        if (!child) {
            return;
        }
        processManager.terminate(child, 'SIGINT', 2000);
        const status = key === 'publisher' ? 'publishStatus' : key === 'echo' ? 'echoStatus' : key === 'service' ? 'serviceStatus' : 'actionStatus';
        this.panel.webview.postMessage({ command: status, running: true, text: 'Stopping...' });
    }

    private async refresh(): Promise<void> {
        if (this.refreshing || this.disposed) {
            return;
        }
        this.refreshing = true;
        this.panel.webview.postMessage({ command: 'loading', loading: true });
        const errors: string[] = [];
        const safe = async <T>(label: string, task: () => Promise<T>, fallback: T): Promise<T> => {
            try { return await task(); }
            catch (error) {
                errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
                return fallback;
            }
        };
        try {
            const [nodeOutput, topicOutput, serviceOutput, actionOutput] = await Promise.all([
                safe('Nodes', () => runRos('ros2 node list'), ''),
                safe('Topics', () => runRos('ros2 topic list -t'), ''),
                safe('Services', () => runRos('ros2 service list -t'), ''),
                safe('Actions', () => runRos('ros2 action list -t'), '')
            ]);
            const nodes = lines(nodeOutput).slice(0, 60);
            const typedTopics = parseTyped(topicOutput).slice(0, 100);
            const services = parseTyped(serviceOutput).slice(0, 100);
            const actions = parseTyped(actionOutput).slice(0, 100);

            // Node information provides the graph edges. Bound concurrency and node count to
            // avoid spawning an unbounded number of ROS CLI processes on large graphs.
            const nodeInfo: Array<{ node: string; info: string }> = [];
            const nodesToInspect = nodes.slice(0, 30);
            for (let index = 0; index < nodesToInspect.length; index += 5) {
                const batch = await Promise.all(nodesToInspect.slice(index, index + 5).map(async node => ({
                    node,
                    info: await safe('Node ' + node, () => runRos('ros2 node info \"$ROS_NODE_NAME\"', { ...process.env, ROS_NODE_NAME: node }, 8000), '')
                })));
                nodeInfo.push(...batch);
            }
            const publishers = new Map<string, string[]>();
            const subscribers = new Map<string, string[]>();
            const serviceServers = new Map<string, string[]>();
            const serviceClients = new Map<string, string[]>();
            const actionServers = new Map<string, string[]>();
            const actionClients = new Map<string, string[]>();
            for (const entry of nodeInfo) {
                let section = '';
                for (const raw of lines(entry.info)) {
                    const line = raw.trim();
                    if (/^Publishers:/.test(line)) { section = 'pub'; continue; }
                    if (/^Subscribers:/.test(line)) { section = 'sub'; continue; }
                    if (/^Service Servers:/.test(line)) { section = 'serviceServer'; continue; }
                    if (/^Service Clients:/.test(line)) { section = 'serviceClient'; continue; }
                    if (/^Action Servers:/.test(line)) { section = 'actionServer'; continue; }
                    if (/^Action Clients:/.test(line)) { section = 'actionClient'; continue; }
                    const match = line.match(/^([^:]+):/);
                    if (!match) { continue; }
                    const name = match[1].trim();
                    const target = section === 'pub' ? publishers : section === 'sub' ? subscribers :
                        section === 'serviceServer' ? serviceServers : section === 'serviceClient' ? serviceClients :
                        section === 'actionServer' ? actionServers : section === 'actionClient' ? actionClients : undefined;
                    if (target) {
                        const values = target.get(name) ?? [];
                        values.push(entry.node);
                        target.set(name, values);
                    }
                }
            }
            const snapshot: GraphSnapshot = {
                nodes,
                topics: typedTopics.map(topic => ({
                    ...topic,
                    publishers: publishers.get(topic.name) ?? [],
                    subscribers: subscribers.get(topic.name) ?? []
                })),
                services: services.map(service => ({ ...service, servers: serviceServers.get(service.name) ?? [], clients: serviceClients.get(service.name) ?? [] })),
                actions: actions.map(action => ({ ...action, servers: actionServers.get(action.name) ?? [], clients: actionClients.get(action.name) ?? [] })),
                errors
            };
            this.panel.webview.postMessage({ command: 'graph', graph: snapshot, refreshedAt: new Date().toLocaleTimeString() });
        } finally {
            this.refreshing = false;
            if (!this.disposed) {
                this.panel.webview.postMessage({ command: 'loading', loading: false });
            }
        }
    }

    private html(): string {
        const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js'));
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ROS 2 Communication</title>
<style>
:root{color-scheme:dark light}body{padding:18px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);background:var(--vscode-editor-background)}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:20px;margin:0 auto 0 0}.muted{color:var(--vscode-descriptionForeground);font-size:12px}
button,.tab{border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:7px 11px;border-radius:4px;cursor:pointer}
button.primary,.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
nav{display:flex;gap:7px;margin:18px 0;flex-wrap:wrap}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;background:var(--vscode-sideBar-background)}.count{font-size:25px;font-weight:600}.section{margin-top:14px}.section h2{font-size:15px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.item{padding:9px;border-bottom:1px solid var(--vscode-panel-border);font-family:var(--vscode-editor-font-family);font-size:12px;overflow-wrap:anywhere}.item:last-child{border:0}
.pill{font-size:11px;padding:2px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
.graph{overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;min-height:180px}.graph svg{min-width:760px;width:100%;height:auto}
.node{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-blue);stroke-width:1.5}.topic{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-green);stroke-width:1.5}.service{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-orange);stroke-width:1.5}.action{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-purple);stroke-width:1.5}.edge{stroke:var(--vscode-descriptionForeground);stroke-width:1.2;fill:none;opacity:.8}.label{fill:var(--vscode-foreground);font:12px var(--vscode-font-family)}
.output{max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word}.output#service-debug{max-height:420px}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}[hidden]{display:none!important}
</style></head>
<body>
<header><h1>ROS 2 Communication Dashboard</h1><span class="muted" id="updated">Not refreshed</span><button class="primary" id="refresh">Refresh graph</button></header>
<nav><button class="tab active" data-tab="overview">Overview</button><button class="tab" data-tab="topics">Topics</button><button class="tab" data-tab="services">Services</button><button class="tab" data-tab="actions">Actions</button><button class="tab" data-tab="nodes">Nodes</button></nav>
<section id="overview" class="view"><div class="summary" id="counts"></div><div class="section card"><h2>Node ↔ Topic graph</h2><p class="muted">Edges are inferred from publisher/subscriber sections in ros2 node info. Only the first 30 nodes are queried for edge detail.</p><div class="graph" id="graph">Refresh to discover the ROS graph.</div></div><div class="section grid"><div class="card"><h2>Services</h2><div id="overview-services"></div></div><div class="card"><h2>Actions</h2><div id="overview-actions"></div></div></div></section>
<section id="topics" class="view" hidden>
<div class="grid">
<div class="card"><h2>Topic Echo</h2><label>Topic<select id="echo-topic"><option value="">Select topic…</option></select></label><div class="actions"><button id="echo-start" class="primary">Subscribe</button><button id="echo-stop" disabled>Stop</button></div><pre id="echo-output" class="output">Subscription idle.</pre></div>
<div class="card"><h2>Publish to Topic</h2>
<label>Existing topic<select id="pub-topic"><option value="">Select topic…</option></select></label>
<label>Or new topic name<input id="pub-new-topic" placeholder="/my_topic"></label>
<label>Message type<input id="pub-type" placeholder="std_msgs/msg/String"></label>
<label>Publish rate (Hz)<input id="pub-rate" type="number" min="0.1" max="1000" step="0.1" value="1"></label>
<label>Number of messages<input id="pub-count" type="number" min="1" max="100000" step="1" value="1"></label>
<label>Message YAML<textarea id="pub-yaml" spellcheck="false">{}</textarea></label>
<div class="actions"><button id="pub-start" class="primary">Publish</button><button id="pub-stop" disabled>Stop</button></div>
<pre id="pub-output" class="output">Publisher idle.</pre>
</div></div><div class="card section"><h2>Topic inventory</h2><div id="topic-list"></div></div></section>
<!-- Services tab: discovery, request execution, and graph relationships. -->
<section id="services" class="view" hidden><div class="grid"><div class="card"><h2>Call Service</h2>
<label>Service<select id="service-select"><option value="">Select service…</option></select></label><p class="muted" id="service-type">Type: —</p>
<label>Request YAML<textarea id="service-request" spellcheck="false">{}</textarea></label>
<div class="actions"><button id="service-call" class="primary">Call Service</button></div><pre id="service-output" class="output">Ready.</pre>
</div><div class="card"><h2>Service graph</h2><div id="service-list"></div></div></div>
</section>
<section id="actions" class="view" hidden><div class="grid"><div class="card"><h2>Send Action Goal</h2>
<label>Action<select id="action-select"><option value="">Select action…</option></select></label><p class="muted" id="action-type">Type: —</p>
<label>Goal YAML<textarea id="action-goal" spellcheck="false">{}</textarea></label>
<div class="actions"><button id="action-send" class="primary">Send Goal</button><button id="action-cancel" disabled>Cancel Goal</button></div><pre id="action-output" class="output">Ready.</pre>
</div><div class="card"><h2>Action graph</h2><div id="action-list"></div></div></div></section>
<section id="nodes" class="view" hidden><div class="card"><h2>Nodes</h2><div id="node-list"></div></div></section>
<div class="section muted" id="errors"></div>
<script nonce="__NONCE__" src="${scriptUri}"></script></body></html>`;
        return secureWebviewHtml(this.panel.webview, html);
    }

    private dispose(): void {
        this.disposed = true;
        if (CommunicationDashboard.current === this) { CommunicationDashboard.current = undefined; CommunicationDashboard.panel = undefined; }
        for (const key of [...this.activeProcesses.keys()]) {
            const child = this.activeProcesses.get(key);
            if (child) {
                processManager.terminate(child, 'SIGINT', 1000);
            }
        }
        this.activeProcesses.clear();
        CommunicationDashboard.panel = undefined;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}