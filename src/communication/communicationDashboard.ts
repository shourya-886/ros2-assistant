import * as vscode from 'vscode';
import { processManager } from '../core/processManager';
import { rosEnvironment } from '../core/rosEnvironment';

type GraphSnapshot = {
    nodes: string[];
    topics: Array<{ name: string; type: string; publishers: string[]; subscribers: string[] }>;
    services: Array<{ name: string; type: string }>;
    actions: Array<{ name: string; type: string }>;
    errors: string[];
};

function runRos(command: string, timeout = 12000): Promise<string> {
    return new Promise((resolve, reject) => {
        const script = `${rosEnvironment.setupCommand} && ${command}`;
        processManager.exec(`bash -lc ${JSON.stringify(script)}`, {
            env: process.env, timeout, maxBuffer: 2 * 1024 * 1024
        }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error((stderr || error.message || 'ROS command failed').trim()));
            } else {
                resolve(stdout);
            }
        });
    });
}

function lines(output: string): string[] {
    return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function parseTyped(output: string): Array<{ name: string; type: string }> {
    return lines(output).map(line => {
        const match = line.match(/^(\S+)\s+\[(.+)\]$/);
        return match ? { name: match[1], type: match[2] } : { name: line, type: 'unknown' };
    });
}

export class CommunicationDashboard {
    private static panel: vscode.WebviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private refreshing = false;
    private disposed = false;
    private readonly outputLimit = 80;

    static createOrShow(extensionUri: vscode.Uri): void {
        if (CommunicationDashboard.panel) {
            CommunicationDashboard.panel.reveal(vscode.ViewColumn.Active);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'ros2CommunicationDashboard',
            'ROS 2 Communication',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        CommunicationDashboard.panel = panel;
        new CommunicationDashboard(panel, extensionUri);
    }

    private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        panel.webview.html = this.html();
        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(async message => {
            if (message?.command === 'refresh') {
                await this.refresh();
            } else if (message?.command === 'open') {
                const commands: Record<string, string> = {
                    topic: 'ros2-assistant.publishTopic',
                    service: 'ros2-assistant.inspectService',
                    action: 'ros2-assistant.inspectAction'
                };
                const command = commands[message.kind];
                if (command) {
                    if (message.kind === 'topic') {
                        await vscode.commands.executeCommand(command);
                    } else {
                        await vscode.commands.executeCommand(command, {
                            label: String(message.name || ''),
                            viewType: message.kind === 'service' ? 'services' : 'actions'
                        });
                    }
                }
            }
        }, null, this.disposables);
        void this.refresh();
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
            const nodeInfo = await Promise.all(nodes.slice(0, 30).map(async node => ({
                node,
                info: await safe(`Node ${node}`, () => runRos(`ros2 node info ${JSON.stringify(node)}`, 8000), '')
            })));
            const publishers = new Map<string, string[]>();
            const subscribers = new Map<string, string[]>();
            const nodeServices = new Map<string, string[]>();
            for (const entry of nodeInfo) {
                let section = '';
                for (const raw of lines(entry.info)) {
                    const line = raw.trim();
                    if (/^Publishers:/.test(line)) { section = 'pub'; continue; }
                    if (/^Subscribers:/.test(line)) { section = 'sub'; continue; }
                    if (/^Service Servers:/.test(line)) { section = 'srv'; continue; }
                    if (/^(Service Clients|Action Servers|Action Clients):/.test(line)) { section = ''; continue; }
                    const match = line.match(/^([^:]+):/);
                    if (!match) { continue; }
                    const name = match[1].trim();
                    const target = section === 'pub' ? publishers : section === 'sub' ? subscribers : undefined;
                    if (target) {
                        const values = target.get(name) ?? [];
                        values.push(entry.node);
                        target.set(name, values);
                    } else if (section === 'srv') {
                        const values = nodeServices.get(name) ?? [];
                        values.push(entry.node);
                        nodeServices.set(name, values);
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
                services: services.map(service => ({ ...service, type: service.type })),
                actions,
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
        const nonce = [...Array(32)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62))).join('');
        this.panel.webview.options = { enableScripts: true };
        this.panel.webview.html = this.panel.webview.html;
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
.node{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-blue);stroke-width:1.5}.topic{fill:var(--vscode-editorWidget-background);stroke:var(--vscode-charts-green);stroke-width:1.5}.edge{stroke:var(--vscode-descriptionForeground);stroke-width:1.2;fill:none;opacity:.8}.label{fill:var(--vscode-foreground);font:12px var(--vscode-font-family)}
[hidden]{display:none!important}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}
</style></head>
<body>
<header><h1>ROS 2 Communication Dashboard</h1><span class="muted" id="updated">Not refreshed</span><button class="primary" id="refresh">Refresh graph</button></header>
<nav><button class="tab active" data-tab="overview">Overview</button><button class="tab" data-tab="topics">Topics</button><button class="tab" data-tab="services">Services</button><button class="tab" data-tab="actions">Actions</button><button class="tab" data-tab="nodes">Nodes</button></nav>
<section id="overview" class="view"><div class="summary" id="counts"></div><div class="section card"><h2>Node ↔ Topic graph</h2><p class="muted">Edges are inferred from publisher/subscriber sections in ros2 node info. Only the first 30 nodes are queried for edge detail.</p><div class="graph" id="graph">Refresh to discover the ROS graph.</div></div><div class="section grid"><div class="card"><h2>Services</h2><div id="overview-services"></div></div><div class="card"><h2>Actions</h2><div id="overview-actions"></div></div></div></section>
<section id="topics" class="view" hidden><div class="card"><h2>Topics</h2><div id="topic-list"></div></div></section>
<section id="services" class="view" hidden><div class="card"><h2>Services</h2><div id="service-list"></div></div></section>
<section id="actions" class="view" hidden><div class="card"><h2>Actions</h2><div id="action-list"></div></div></section>
<section id="nodes" class="view" hidden><div class="card"><h2>Nodes</h2><div id="node-list"></div></div></section>
<div class="section muted" id="errors"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let graph=null;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const renderList=(id,items,kind)=>{document.getElementById(id).innerHTML=items.length?items.map(x=>'<div class="item"><strong>'+esc(x.name||x)+'</strong> <span class="pill">'+esc(x.type||'')+'</span>'+(kind==='topic'?'<div class="muted">Publishers: '+esc((x.publishers||[]).join(', ')||'—')+' · Subscribers: '+esc((x.subscribers||[]).join(', ')||'—')+'</div>':'')+'</div>').join(''):'<div class="item muted">No entries discovered.</div>';};
function drawGraph(g){
 const nodes=g.nodes.slice(0,12),topics=g.topics.filter(t=>t.publishers.length||t.subscribers.length).slice(0,12);
 const width=900,row=42,leftX=15,topicX=390,rightX=765,top=20,height=Math.max(170,Math.max(nodes.length,topics.length)*row+30);
 let svg='<svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="ROS node topic graph">';
 const nodeY=new Map(nodes.map((n,i)=>[n,top+i*row+15])),topicY=new Map(topics.map((t,i)=>[t.name,top+i*row+15]));
 topics.forEach(t=>{const y=topicY.get(t.name);t.publishers.forEach(n=>{if(nodeY.has(n))svg+='<path class="edge" d="M 205 '+nodeY.get(n)+' C 280 '+nodeY.get(n)+', 310 '+y+', 390 '+y+'"/>';});t.subscribers.forEach(n=>{if(nodeY.has(n))svg+='<path class="edge" d="M 510 '+y+' C 600 '+y+', 650 '+nodeY.get(n)+', 695 '+nodeY.get(n)+'"/>';});});
 nodes.forEach(n=>{const y=nodeY.get(n);svg+='<rect class="node" x="'+leftX+'" y="'+(y-13)+'" width="190" height="26" rx="5"/><text class="label" x="'+(leftX+8)+'" y="'+(y+4)+'">'+esc(n.slice(0,28))+'</text>';});
 topics.forEach(t=>{const y=topicY.get(t.name);svg+='<rect class="topic" x="'+topicX+'" y="'+(y-13)+'" width="190" height="26" rx="5"/><text class="label" x="'+(topicX+8)+'" y="'+(y+4)+'">'+esc(t.name.slice(0,28))+'</text>';});
 svg+='<text class="label" x="15" y="12">Publishers</text><text class="label" x="390" y="12">Topics</text><text class="label" x="695" y="12">Subscribers</text></svg>';
 document.getElementById('graph').innerHTML=svg||'No graph edges found.';
}
function render(g,updated){
 graph=g;document.getElementById('updated').textContent='Updated '+updated;
 document.getElementById('counts').innerHTML=[['Nodes',g.nodes.length],['Topics',g.topics.length],['Services',g.services.length],['Actions',g.actions.length]].map(([n,c])=>'<div class="card"><div class="muted">'+n+'</div><div class="count">'+c+'</div></div>').join('');
 renderList('topic-list',g.topics,'topic');renderList('service-list',g.services,'service');renderList('action-list',g.actions,'action');renderList('node-list',g.nodes.map(name=>({name,type:'node'})),'node');
 renderList('overview-services',g.services.slice(0,8),'service');renderList('overview-actions',g.actions.slice(0,8),'action');drawGraph(g);
 document.getElementById('errors').innerHTML=g.errors.length?'<div class="error">'+g.errors.map(esc).join('\n')+'</div>':'';
}
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.view').forEach(x=>x.hidden=x.id!==b.dataset.tab);}));
document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({command:'refresh'}));
window.addEventListener('message',e=>{if(e.data.command==='loading'){document.getElementById('refresh').disabled=e.data.loading;document.getElementById('refresh').textContent=e.data.loading?'Refreshing…':'Refresh graph';}else if(e.data.command==='graph'){render(e.data.graph,e.data.refreshedAt);}});
</script></body></html>`;
    }

    private dispose(): void {
        this.disposed = true;
        CommunicationDashboard.panel = undefined;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
