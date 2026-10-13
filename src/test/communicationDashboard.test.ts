import * as assert from 'assert';
import { buildTemplate, parseTyped, validName, validType } from '../communication/communicationDashboard';

suite('ROS 2 communication dashboard helpers', () => {
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
