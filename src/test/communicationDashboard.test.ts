import * as assert from 'assert';
import { readFileSync } from 'fs';
import { Script } from 'vm';
import { JSDOM } from 'jsdom';
import * as path from 'path';
import { buildTemplate, parseTyped, validName, validType } from '../communication/communicationDashboard';

suite('ROS 2 communication dashboard helpers', () => {
    test('dashboard webview script parses as JavaScript', () => {
        const script = readFileSync(path.resolve(__dirname, '../../media/dashboard.js'), 'utf8');
        assert.doesNotThrow(() => new Script(script, { filename: 'media/dashboard.js' }));
    });

    test('dashboard script starts, posts ready, and renders a graph', () => {
        const script = readFileSync(path.resolve(__dirname, '../../media/dashboard.js'), 'utf8');
        const source = readFileSync(path.resolve(__dirname, '../../src/communication/communicationDashboard.ts'), 'utf8');
        const htmlMatch = source.match(/const html = `([\s\S]*?)`;\s*return secureWebviewHtml/);
        assert.ok(htmlMatch, 'dashboard HTML template should be present');
        const html = htmlMatch[1].replace('${scriptUri}', 'dashboard.js').replace('nonce="__NONCE__"', 'nonce="test-nonce"');
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const posted: Array<{ command: string }> = [];
        const errors: unknown[] = [];
        Object.assign(dom.window, { acquireVsCodeApi: () => ({ postMessage: (message: { command: string }) => posted.push(message) }) });
        dom.window.addEventListener('error', event => errors.push((event as ErrorEvent).error));

        dom.window.eval(script);
        assert.deepStrictEqual(posted.map(message => message.command), ['ready']);
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
            command: 'graph',
            refreshedAt: 'now',
            graph: { nodes: ['/talker'], topics: [], services: [], actions: [], errors: [] }
        } }));

        assert.strictEqual(dom.window.document.querySelector('.count')?.textContent, '1');
        assert.deepStrictEqual(errors, []);
        dom.window.close();
    });

    test('parses typed ROS graph entries', () => {
        assert.deepStrictEqual(parseTyped([
            '/chatter [std_msgs/msg/String]',
            '/add_two_ints [example_interfaces/srv/AddTwoInts]'
        ].join('\n')), [
            { name: '/chatter', type: 'std_msgs/msg/String' },
            { name: '/add_two_ints', type: 'example_interfaces/srv/AddTwoInts' }
        ]);
    });

    test('validates absolute ROS names and interface types', () => {
        assert.strictEqual(validName('/robot/cmd_vel'), true);
        assert.strictEqual(validName('robot/cmd_vel'), false);
        assert.strictEqual(validName('/robot; touch /tmp/x'), false);
        assert.strictEqual(validType('std_msgs/msg/String', 'msg'), true);
        assert.strictEqual(validType('std_msgs/srv/String', 'msg'), false);
        assert.strictEqual(validType('example_interfaces/srv/AddTwoInts', 'srv'), true);
        assert.strictEqual(validType('nav2_msgs/action/NavigateToPose', 'action'), true);
    });

    test('builds message and service request templates without response fields', () => {
        const service = [
            'int64 a',
            'int64 b',
            '---',
            'int64 sum'
        ].join('\n');
        assert.strictEqual(buildTemplate(service, true), '{\n  a: 0,\n  b: 0\n}');
    });

    test('builds action goal template only from the first section', () => {
        const action = [
            'int32 order',
            '---',
            'int32[] sequence',
            '---',
            'int32 total'
        ].join('\n');
        assert.strictEqual(buildTemplate(action, true), '{\n  order: 0\n}');
    });

    test('uses sensible defaults for strings, booleans, floats and arrays', () => {
        const definition = [
            'string data',
            'bool enabled',
            'float64 value',
            'int32[] samples'
        ].join('\n');
        assert.strictEqual(buildTemplate(definition), '{\n  data: \'\',\n  enabled: false,\n  value: 0.0,\n  samples: []\n}');
    });
});
