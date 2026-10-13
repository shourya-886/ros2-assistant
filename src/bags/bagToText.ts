import * as vscode from 'vscode';
import { type ChildProcess } from 'child_process';
import { readdirSync } from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { formatProcessError, processManager } from '../core/processManager';
import { rosEnvironment } from '../core/rosEnvironment';
import { secureWebviewHtml } from '../core/webview';

export type BagFolderStatus = 'ready' | 'missing-db3' | 'missing-yaml';

/** Checks for the required bag files at the selected folder root. */
export function inspectBagFolder(folderPath: string): BagFolderStatus {
    const files = readdirSync(folderPath, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name.toLowerCase());
    if (!files.some(file => file.endsWith('.db3'))) {
        return 'missing-db3';
    }
    if (!files.some(file => file.endsWith('.yaml'))) {
        return 'missing-yaml';
    }
    return 'ready';
}

const bagReaderScript = [
    'import os',
    'import sys',
    'import yaml',
    'import rosbag2_py',
    'from rclpy.serialization import deserialize_message',
    'from rosidl_runtime_py.utilities import get_message',
    'from rosidl_runtime_py.convert import message_to_yaml',
    "reader = rosbag2_py.SequentialReader()",
    "reader.open(rosbag2_py.StorageOptions(uri=os.environ['ROS_BAG_FOLDER'], storage_id='sqlite3'), rosbag2_py.ConverterOptions(input_serialization_format='', output_serialization_format=''))",
    'types = {topic.name: topic.type for topic in reader.get_all_topics_and_types()}',
    "with open(os.path.join(os.environ['ROS_BAG_FOLDER'], 'metadata.yaml'), encoding='utf-8') as metadata_file:",
    "    total_messages = int(yaml.safe_load(metadata_file)['rosbag2_bagfile_information']['message_count'])",
    'converted_messages = 0',
    'last_percent = -1',
    'while reader.has_next():',
    '    topic, serialized, timestamp = reader.read_next()',
    '    message = deserialize_message(serialized, get_message(types[topic]))',
    "    print('---\\ntopic: ' + topic + '\\ntimestamp_ns: ' + str(timestamp) + '\\n' + message_to_yaml(message), flush=True)",
    '    converted_messages += 1',
    '    percent = min(99, int(converted_messages * 100 / total_messages)) if total_messages else 0',
    '    if percent != last_percent:',
    "        print('__BAG_PROGRESS__' + str(percent), file=sys.stderr, flush=True)",
    '        last_percent = percent'
].join('\n');

/** Reads a selected ROS 2 bag and streams decoded message YAML to a webview. */
export class BagToTextPanel implements vscode.Disposable {
    private readonly panel: vscode.WebviewPanel;
    private child: ChildProcess | undefined;
    private disposed = false;
    private finished = false;
    private started = false;
    private readonly stdoutDecoder = new StringDecoder('utf8');
    private readonly stderrDecoder = new StringDecoder('utf8');
    private stderr = '';
    private stderrPending = '';
    private convertedText = '';

    static create(folderPath: string): BagToTextPanel {
        const panel = vscode.window.createWebviewPanel(
            'ros2BagToText',
            `Bag to text: ${path.basename(folderPath)}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
        );
        return new BagToTextPanel(panel, folderPath);
    }

    private constructor(panel: vscode.WebviewPanel, folderPath: string) {
        this.panel = panel;
        this.panel.webview.html = secureWebviewHtml(panel.webview, this.html());
        panel.onDidDispose(() => this.dispose());
        panel.webview.onDidReceiveMessage(message => {
            if (message?.command === 'ready' && !this.started) {
                this.started = true;
                this.start(path.resolve(folderPath));
            }
        });
    }

    private html(): string {
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bag to text</title>
<style>
body{padding:18px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
h1{font-size:20px;margin:0 0 8px}.status{color:var(--vscode-descriptionForeground);margin:0 0 14px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:calc(100vh - 100px);overflow:auto;padding:12px;background:var(--vscode-textCodeBlock-background);font:var(--vscode-editor-font-size) var(--vscode-editor-font-family,monospace)}#progress-screen{position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--vscode-editor-background);padding:24px;box-sizing:border-box}#progress-screen[hidden],#output[hidden]{display:none}progress{width:min(440px,80vw);height:22px}#progress-label{font-size:20px;font-weight:600;margin-top:12px}
</style></head><body><h1>Bag to text</h1><p id="status" class="status">Starting bag reader…</p><section id="progress-screen" aria-live="polite"><h2>Converting bag…</h2><progress id="progress-bar" max="100" value="0"></progress><div id="progress-label">0%</div><p>Keep this panel open while conversion finishes.</p></section><pre id="output" hidden></pre>
<script>
const vscode=acquireVsCodeApi();const output=document.getElementById('output');const status=document.getElementById('status');const screen=document.getElementById('progress-screen');const bar=document.getElementById('progress-bar');const label=document.getElementById('progress-label');
window.addEventListener('message',event=>{const message=event.data;if(message.command==='status'){status.textContent=message.text;}else if(message.command==='progress'){const percent=Math.max(0,Math.min(99,message.percent));bar.value=percent;label.textContent=percent+'%';status.textContent='Converting bag messages… '+percent+'%';}else if(message.command==='complete'){bar.value=100;label.textContent='100%';status.textContent=message.status;output.textContent=message.text;output.hidden=false;requestAnimationFrame(()=>{screen.hidden=true;output.scrollTop=output.scrollHeight;});}else if(message.command==='failed'){screen.hidden=true;status.textContent=message.text;output.textContent=message.text;output.hidden=false;}});
vscode.postMessage({command:'ready'});
</script></body></html>`;
    }

    private start(folderPath: string): void {
        this.post({ command: 'status', text: 'Reading and converting bag messages…' });
        const env = {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            ROS_BAG_FOLDER: folderPath,
            ROS_BAG_READER_SCRIPT: Buffer.from(bagReaderScript, 'utf8').toString('base64')
        };
        const command = `${rosEnvironment.setupCommand} && exec python3 -c "$(printf %s \"$ROS_BAG_READER_SCRIPT\" | base64 -d)"`;
        const child = processManager.spawn('bash', ['-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.child = child;
        child.stdout?.on('data', chunk => { this.convertedText += this.stdoutDecoder.write(chunk); });
        child.stderr?.on('data', chunk => this.consumeStderr(this.stderrDecoder.write(chunk)));
        child.once('error', error => this.finish(`Could not start bag conversion: ${error.message}`, false));
        child.once('close', code => {
            const finalOutput = this.stdoutDecoder.end();
            this.consumeStderr(this.stderrDecoder.end(), true);
            this.convertedText += finalOutput;
            if (code === 0) {
                this.finish(this.convertedText ? 'Conversion complete.' : 'The bag contains no messages.', true);
            } else {
                const error = formatProcessError('ROS 2 bag to text', new Error(`Process exited with code ${code ?? 'unknown'}`), this.stderr);
                this.finish(error, false);
            }
        });
    }

    private consumeStderr(text: string, flush = false): void {
        const lines = (this.stderrPending + text).split(/\r?\n/);
        this.stderrPending = flush ? '' : (lines.pop() ?? '');
        if (flush && this.stderrPending) {
            lines.push(this.stderrPending);
        }
        for (const line of lines) {
            if (line.startsWith('__BAG_PROGRESS__')) {
                const percent = Number(line.slice('__BAG_PROGRESS__'.length));
                if (Number.isFinite(percent)) {
                    this.post({ command: 'progress', percent: Math.max(0, Math.min(99, percent)) });
                }
            } else if (line) {
                this.stderr = (this.stderr + line + '\n').slice(-16000);
            }
        }
    }

    private finish(text: string, success: boolean): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        if (this.child) {
            this.child = undefined;
        }
        this.post(success
            ? { command: 'complete', text: this.convertedText, status: text }
            : { command: 'failed', text: `Conversion failed: ${text}` });
    }

    private post(message: object): void {
        if (!this.disposed) {
            void this.panel.webview.postMessage(message);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.child) {
            processManager.terminate(this.child, 'SIGINT', 1000);
            this.child = undefined;
        }
        this.panel.dispose();
    }
}

export function missingBagFolderMessage(status: BagFolderStatus): string | undefined {
    if (status === 'missing-db3') {
        return 'This folder does not have the .db3 file. Please add it to the folder and re-run the command';
    }
    if (status === 'missing-yaml') {
        return 'This folder does not have the .yaml file. Please add it to the folder and re-run the command';
    }
    return undefined;
}
