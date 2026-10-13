import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/** Adds a nonce-based Content Security Policy to a webview document. */
export function secureWebviewHtml(webview: vscode.Webview, html: string): string {
    const nonce = randomBytes(16).toString('base64');
    webview.options = { ...webview.options, enableScripts: true };
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    return html
        .replace('</head>', policy + '</head>')
        .replace(/<script>/g, `<script nonce="${nonce}">`)
        .replace(/nonce="__NONCE__"/g, `nonce="${nonce}"`);
}
